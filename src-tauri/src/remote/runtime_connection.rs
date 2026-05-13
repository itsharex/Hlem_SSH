use super::*;

impl RemoteRuntime {
    pub async fn connect(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
    ) -> AppResult<ConnectionInfo> {
        let session_lock = self.connection_lock(&session.id).await;
        let _session_guard = session_lock.lock().await;
        if let Some(existing) = self.find_connection_by_session(&session.id).await {
            return Ok(existing.info);
        }

        let connection_id = Uuid::new_v4().to_string();
        // Register the friendly session name so any future "not found" diagnostics log it
        // instead of the raw UUID. The same label is also reused for the session id so
        // per-session error paths (connection_lock, find_connection_by_session, etc.) produce
        // useful output too.
        crate::errors::register_resource_label(&connection_id, &session.name);
        crate::errors::register_resource_label(&session.id, &session.name);
        let remote_forwards = Arc::new(RwLock::new(HashMap::new()));
        let verification = HostKeyVerification {
            session_id: session.id.clone(),
            host: session.host.clone(),
            port: session.port,
            algorithm: String::new(),
            fingerprint: String::new(),
            expected_fingerprint: trusted
                .as_ref()
                .map(|entry| entry.fingerprint.clone())
                .or_else(|| session.ssh.host_key_fingerprint.clone()),
        };
        let trusted = trusted.or_else(|| {
            session
                .ssh
                .host_key_fingerprint
                .as_ref()
                .map(|fingerprint| KnownHostEntry {
                    host: session.host.clone(),
                    port: session.port,
                    algorithm: String::new(),
                    fingerprint: fingerprint.clone(),
                    trusted_at: String::new(),
                })
        });
        let observed = Arc::new(StdMutex::new(None));
        let client = RemoteClient {
            verification: verification.clone(),
            trusted,
            observed: observed.clone(),
            remote_forwards: remote_forwards.clone(),
        };
        events::emit(
            app,
            events::SSH_STATUS,
            ConnectionInfo {
                connection_id: connection_id.clone(),
                session_id: session.id.clone(),
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                status: RuntimeStatus::Connecting,
                connected_at: now(),
            },
        );

        let mut config = client::Config::default();
        // Do NOT set inactivity_timeout here. The previous value (connect_timeout_ms, ~10s)
        // was shorter than keepalive_interval (30s), causing russh to garbage-collect idle
        // connections before a keepalive could be sent. Setting it to None lets the
        // keepalive mechanism alone decide connection liveness.
        config.inactivity_timeout = None;
        config.keepalive_interval = Some(Duration::from_secs(
            session.ssh.keepalive_interval_sec.max(1) as u64,
        ));
        config.keepalive_max = 3;
        config.nodelay = true;
        config.window_size = 16 * 1024 * 1024; // 16 MB - larger window for better throughput
        config.maximum_packet_size = 65535; // max SSH packet size for fewer round trips
        config.channel_buffer_size = 256; // larger channel buffer to reduce backpressure
        let connect_timeout = Duration::from_millis(session.ssh.connect_timeout_ms.max(1_000));
        let server_host = session.host.clone();
        let server_port = session.port;
        let proxy = session.ssh.proxy.clone();
        let config = Arc::new(config);
        let observed_for_connect = observed.clone();
        let mut handle = match timeout(connect_timeout, async move {
            let socket = connect_tcp_for_ssh(&server_host, server_port, proxy.as_ref()).await?;
            if config.as_ref().nodelay {
                if let Err(error) = socket.set_nodelay(true) {
                    return Err(AppError::Remote(error.to_string()));
                }
            }
            client::connect_stream(config, socket, client)
                .await
                .map_err(|error| map_connect_error(error, &observed_for_connect))
        })
        .await
        {
            Ok(Ok(handle)) => handle,
            Ok(Err(error)) => {
                if let AppError::HostKeyUntrusted(payload) | AppError::HostKeyChanged(payload) =
                    &error
                {
                    events::emit(app, events::HOST_KEY_VERIFY, payload.clone());
                }
                return Err(error);
            }
            Err(_) => return Err(AppError::Remote("SSH 连接超时".to_string())),
        };

        authenticate(&mut handle, &session).await?;
        let handle = Arc::new(Mutex::new(handle));
        let info = ConnectionInfo {
            connection_id: connection_id.clone(),
            session_id: session.id.clone(),
            host: session.host,
            port: session.port,
            username: session.username,
            status: RuntimeStatus::Connected,
            connected_at: now(),
        };
        self.connections.write().await.insert(
            connection_id,
            ConnectionRecord {
                info: info.clone(),
                handle,
                remote_forwards,
            },
        );
        events::emit(app, events::SSH_STATUS, info.clone());
        Ok(info)
    }

    pub async fn disconnect(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        self.shutdown_connection(app, connection_id).await
    }

    pub async fn shutdown_connection(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        let record = self
            .connections
            .write()
            .await
            .remove(connection_id)
            .ok_or_else(|| AppError::missing_connection(connection_id))?;

        self.close_children_for_connection(app, &record).await;
        let disconnect_result = record
            .handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "HelM disconnect", "zh-CN")
            .await
            .map_err(remote_error);

        let mut info = record.info;
        info.status = RuntimeStatus::Disconnected;
        events::emit(app, events::SSH_STATUS, info);
        crate::errors::forget_resource_label(connection_id);
        disconnect_result
    }

    pub async fn shutdown_all(&self, app: &AppHandle) {
        let connection_ids: Vec<String> = self.connections.read().await.keys().cloned().collect();
        for connection_id in connection_ids {
            let _ = self.shutdown_connection(app, &connection_id).await;
        }
        self.close_all_orphans(app).await;
    }

    #[cfg(test)]
    pub async fn ensure_no_stale_handles(&self) -> bool {
        self.connections.read().await.is_empty()
            && self.terminals.read().await.is_empty()
            && self.sftp_sessions.read().await.is_empty()
            && self.transfers.read().await.is_empty()
            && self.telemetry_jobs.read().await.is_empty()
            && self.forwards.read().await.is_empty()
    }
}
