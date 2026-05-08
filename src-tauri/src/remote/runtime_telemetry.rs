use super::*;

impl RemoteRuntime {
    pub async fn telemetry_snapshot(&self, connection_id: &str) -> AppResult<ServerTelemetry> {
        let connection = self.connection(connection_id).await?;
        let fallback_ip = connection.info.host;
        let mut snapshot = empty_telemetry(&fallback_ip, 0);
        let base = self
            .telemetry_sample(
                connection_id,
                TELEMETRY_BASE_COMMAND,
                TELEMETRY_FAST_TIMEOUT_MS,
                &fallback_ip,
            )
            .await?;
        let mut last_network = None;
        merge_telemetry(&mut snapshot, base, true, &mut last_network);

        for (command, timeout_ms) in [
            (TELEMETRY_PROCESS_COMMAND, TELEMETRY_FAST_TIMEOUT_MS),
            (TELEMETRY_DISK_COMMAND, TELEMETRY_FAST_TIMEOUT_MS),
            (TELEMETRY_IP_COMMAND, TELEMETRY_SLOW_TIMEOUT_MS),
        ] {
            if let Ok(sample) = self
                .telemetry_sample(connection_id, command, timeout_ms, &fallback_ip)
                .await
            {
                merge_telemetry(&mut snapshot, sample, false, &mut last_network);
            }
        }

        Ok(snapshot)
    }

    pub(super) async fn telemetry_sample(
        &self,
        connection_id: &str,
        command: &str,
        timeout_ms: u64,
        fallback_ip: &str,
    ) -> AppResult<ParsedTelemetry> {
        let started = Instant::now();
        let result = self
            .exec_on_connection(connection_id, command.to_string(), Some(timeout_ms))
            .await?;
        let output = result.stdout;
        let snapshot = parse_linux_telemetry(&output, fallback_ip, started.elapsed().as_millis());
        let network_bytes = parse_network_bytes(&output);
        Ok(ParsedTelemetry {
            output,
            snapshot,
            network_bytes,
        })
    }

    pub async fn telemetry_start(
        &self,
        app: &AppHandle,
        connection_id: String,
        session_id: String,
        interval_ms: u64,
    ) -> AppResult<TelemetryJobInfo> {
        self.telemetry_stop_by_session(&session_id).await;
        let info = TelemetryJobInfo {
            job_id: Uuid::new_v4().to_string(),
            session_id,
            interval_ms: interval_ms.max(1_000),
            status: TaskStatus::Running,
            started_at: now(),
        };
        let runtime = self.clone();
        let app_handle = app.clone();
        let job_info = info.clone();
        let fallback_ip = self
            .connection(&connection_id)
            .await
            .map(|record| record.info.host)
            .unwrap_or_default();
        let handle = tokio::spawn(async move {
            let mut snapshot = empty_telemetry(&fallback_ip, 0);
            let mut last_network: Option<(NetworkBytes, Instant)> = None;
            let mut base_interval =
                tokio::time::interval(Duration::from_millis(job_info.interval_ms));
            let mut process_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 3).max(TELEMETRY_PROCESS_MIN_INTERVAL_MS),
            ));
            let mut disk_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 12).max(TELEMETRY_DISK_MIN_INTERVAL_MS),
            ));
            let mut ip_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 120).max(TELEMETRY_IP_MIN_INTERVAL_MS),
            ));
            base_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            process_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            disk_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            ip_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                let result = tokio::select! {
                    _ = base_interval.tick() => {
                        runtime.telemetry_sample(
                            &connection_id,
                            TELEMETRY_BASE_COMMAND,
                            TELEMETRY_FAST_TIMEOUT_MS,
                            &fallback_ip,
                        ).await.map(|sample| (sample, true))
                    }
                    _ = process_interval.tick() => {
                        runtime.telemetry_sample(
                            &connection_id,
                            TELEMETRY_PROCESS_COMMAND,
                            TELEMETRY_FAST_TIMEOUT_MS,
                            &fallback_ip,
                        ).await.map(|sample| (sample, false))
                    }
                    _ = disk_interval.tick() => {
                        runtime.telemetry_sample(
                            &connection_id,
                            TELEMETRY_DISK_COMMAND,
                            TELEMETRY_FAST_TIMEOUT_MS,
                            &fallback_ip,
                        ).await.map(|sample| (sample, false))
                    }
                    _ = ip_interval.tick() => {
                        runtime.telemetry_sample(
                            &connection_id,
                            TELEMETRY_IP_COMMAND,
                            TELEMETRY_SLOW_TIMEOUT_MS,
                            &fallback_ip,
                        ).await.map(|sample| (sample, false))
                    }
                };

                match result {
                    Ok((sample, update_latency)) => {
                        merge_telemetry(&mut snapshot, sample, update_latency, &mut last_network);
                        emit_telemetry_snapshot(&app_handle, &job_info, snapshot.clone());
                    }
                    Err(error) => emit_telemetry_error(&app_handle, &job_info, error.to_string()),
                }
            }
        });
        self.telemetry_jobs.write().await.insert(
            info.job_id.clone(),
            TelemetryJobRecord {
                info: info.clone(),
                handle,
            },
        );
        Ok(info)
    }

    pub async fn telemetry_stop(&self, job_id: &str) -> AppResult<()> {
        let record = self
            .telemetry_jobs
            .write()
            .await
            .remove(job_id)
            .ok_or_else(|| AppError::missing_telemetry_job(job_id))?;
        record.handle.abort();
        Ok(())
    }
    pub(super) async fn telemetry_stop_by_session(&self, session_id: &str) {
        let job_ids: Vec<String> = self
            .telemetry_jobs
            .read()
            .await
            .iter()
            .filter_map(|(id, record)| (record.info.session_id == session_id).then(|| id.clone()))
            .collect();
        let mut jobs = self.telemetry_jobs.write().await;
        for id in job_ids {
            if let Some(record) = jobs.remove(&id) {
                record.handle.abort();
            }
        }
    }
    pub(super) async fn cancel_telemetry_for_session(
        &self,
        app: &AppHandle,
        session_id: &str,
        reason: &str,
    ) {
        let job_ids: Vec<String> = self
            .telemetry_jobs
            .read()
            .await
            .iter()
            .filter_map(|(id, record)| (record.info.session_id == session_id).then(|| id.clone()))
            .collect();
        let mut jobs = self.telemetry_jobs.write().await;
        for id in job_ids {
            if let Some(record) = jobs.remove(&id) {
                cancel_telemetry_record(app, record, reason);
            }
        }
    }
}
