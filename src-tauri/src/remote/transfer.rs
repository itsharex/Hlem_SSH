use super::*;

pub(super) async fn ensure_transfer_overwrite(
    sftp: &SftpSession,
    request: &TransferRequest,
) -> AppResult<()> {
    if request.overwrite {
        return Ok(());
    }
    let target_exists = match request.direction {
        TransferDirection::Upload => sftp
            .try_exists(request.remote_path.clone())
            .await
            .map_err(remote_error)?,
        TransferDirection::Download => Path::new(&request.local_path).exists(),
    };
    if target_exists {
        Err(AppError::TransferNeedsOverwrite(match request.direction {
            TransferDirection::Upload => request.remote_path.clone(),
            TransferDirection::Download => request.local_path.clone(),
        }))
    } else {
        Ok(())
    }
}

pub(super) async fn transfer_total_bytes(
    sftp: &SftpSession,
    request: &TransferRequest,
) -> AppResult<u64> {
    match request.direction {
        TransferDirection::Upload => Ok(tokio::fs::metadata(&request.local_path)
            .await
            .map_err(remote_error)?
            .len()),
        TransferDirection::Download => Ok(sftp
            .metadata(request.remote_path.clone())
            .await
            .map_err(remote_error)?
            .len()),
    }
}

pub(super) async fn run_transfer(
    runtime: &RemoteRuntime,
    app: &AppHandle,
    info: TransferInfo,
    request: TransferRequest,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> AppResult<()> {
    let sftp_record = runtime.sftp_record(&request.sftp_id).await?;
    let _permit = sftp_record
        .transfer_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(remote_error)?;
    let sftp = sftp_record.next_transfer_session().await;
    runtime.mark_transfer_running(app, &info.transfer_id).await;
    let mut bytes_done = 0u64;
    let buffer_size = if request.accelerated {
        TRANSFER_ACCELERATED_BUFFER_BYTES
    } else {
        TRANSFER_BUFFER_BYTES
    };
    let mut buffer = vec![0u8; buffer_size];
    let mut last_emit = Instant::now();
    let mut last_emit_bytes = 0u64;
    match request.direction {
        TransferDirection::Upload => {
            let mut local = File::open(&request.local_path)
                .await
                .map_err(remote_error)?;
            let local_size = tokio::fs::metadata(&request.local_path)
                .await
                .map_err(remote_error)?
                .len();
            let resume_from = if request.resume {
                sftp.metadata(request.remote_path.clone())
                    .await
                    .ok()
                    .map(|metadata| {
                        let remote_size = metadata.len();
                        if remote_size < local_size {
                            remote_size
                        } else {
                            0
                        }
                    })
                    .unwrap_or(0)
            } else {
                0
            };
            if request.overwrite && !request.resume {
                let _ = sftp.remove_file(request.remote_path.clone()).await;
            }
            if resume_from > 0 {
                local
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(remote_error)?;
                bytes_done = resume_from;
                emit_transfer_progress(runtime, app, &info.transfer_id, bytes_done, 0.0).await;
            }
            let remote_flags = if resume_from > 0 {
                OpenFlags::CREATE | OpenFlags::WRITE
            } else {
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
            };
            let mut remote = sftp
                .open_with_flags(request.remote_path.clone(), remote_flags)
                .await
                .map_err(remote_error)?;
            if resume_from > 0 {
                remote
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(remote_error)?;
                last_emit_bytes = bytes_done;
            }
            loop {
                if wait_while_paused(&paused, &cancel).await? {
                    last_emit = Instant::now();
                    last_emit_bytes = bytes_done;
                }
                let read = local.read(&mut buffer).await.map_err(remote_error)?;
                if read == 0 {
                    break;
                }
                if wait_while_paused(&paused, &cancel).await? {
                    last_emit = Instant::now();
                    last_emit_bytes = bytes_done;
                }
                remote
                    .write_all(&buffer[..read])
                    .await
                    .map_err(remote_error)?;
                bytes_done += read as u64;
                maybe_emit_transfer_progress(
                    runtime,
                    app,
                    &info.transfer_id,
                    bytes_done,
                    &mut last_emit,
                    &mut last_emit_bytes,
                )
                .await;
            }
            emit_transfer_progress(runtime, app, &info.transfer_id, bytes_done, 0.0).await;
            remote.flush().await.map_err(remote_error)?;
        }
        TransferDirection::Download => {
            let mut remote = sftp
                .open(request.remote_path.clone())
                .await
                .map_err(remote_error)?;
            let remote_size = sftp
                .metadata(request.remote_path.clone())
                .await
                .map_err(remote_error)?
                .len();
            if let Some(parent) = Path::new(&request.local_path).parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(remote_error)?;
            }
            let resume_from = if request.resume {
                tokio::fs::metadata(&request.local_path)
                    .await
                    .ok()
                    .map(|metadata| {
                        let local_size = metadata.len();
                        if local_size <= remote_size {
                            local_size
                        } else {
                            0
                        }
                    })
                    .unwrap_or(0)
            } else {
                0
            };
            let mut local = if resume_from > 0 {
                OpenOptions::new()
                    .create(true)
                    .write(true)
                    .open(&request.local_path)
                    .await
                    .map_err(remote_error)?
            } else {
                File::create(&request.local_path)
                    .await
                    .map_err(remote_error)?
            };
            if resume_from > 0 {
                remote
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(remote_error)?;
                local
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(remote_error)?;
                bytes_done = resume_from;
                last_emit_bytes = bytes_done;
                emit_transfer_progress(runtime, app, &info.transfer_id, bytes_done, 0.0).await;
            }
            loop {
                if wait_while_paused(&paused, &cancel).await? {
                    last_emit = Instant::now();
                    last_emit_bytes = bytes_done;
                }
                let read = remote.read(&mut buffer).await.map_err(remote_error)?;
                if read == 0 {
                    break;
                }
                if wait_while_paused(&paused, &cancel).await? {
                    last_emit = Instant::now();
                    last_emit_bytes = bytes_done;
                }
                local
                    .write_all(&buffer[..read])
                    .await
                    .map_err(remote_error)?;
                bytes_done += read as u64;
                maybe_emit_transfer_progress(
                    runtime,
                    app,
                    &info.transfer_id,
                    bytes_done,
                    &mut last_emit,
                    &mut last_emit_bytes,
                )
                .await;
            }
            emit_transfer_progress(runtime, app, &info.transfer_id, bytes_done, 0.0).await;
            local.flush().await.map_err(remote_error)?;
        }
    }
    runtime
        .mark_transfer_completed(app, &info.transfer_id)
        .await;
    Ok(())
}

pub(super) async fn wait_while_paused(paused: &AtomicBool, cancel: &AtomicBool) -> AppResult<bool> {
    if !paused.load(Ordering::Relaxed) {
        return Ok(false);
    }
    while paused.load(Ordering::Relaxed) {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Remote("传输已取消".to_string()));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Remote("传输已取消".to_string()));
    }
    Ok(true)
}

pub(super) async fn maybe_emit_transfer_progress(
    runtime: &RemoteRuntime,
    app: &AppHandle,
    transfer_id: &str,
    bytes_done: u64,
    last_emit: &mut Instant,
    last_emit_bytes: &mut u64,
) {
    let elapsed = last_emit.elapsed();
    let byte_delta = bytes_done.saturating_sub(*last_emit_bytes);
    if elapsed < TRANSFER_PROGRESS_MIN_INTERVAL && byte_delta < TRANSFER_PROGRESS_MIN_BYTES {
        return;
    }
    let speed_kbps = if elapsed.as_secs_f64() > 0.0 {
        bytes_per_second_to_kib(byte_delta, elapsed.as_secs_f64())
    } else {
        0.0
    };
    emit_transfer_progress(runtime, app, transfer_id, bytes_done, speed_kbps).await;
    *last_emit = Instant::now();
    *last_emit_bytes = bytes_done;
}

pub(super) async fn emit_transfer_progress(
    runtime: &RemoteRuntime,
    app: &AppHandle,
    transfer_id: &str,
    bytes_done: u64,
    speed_kbps: f64,
) {
    runtime
        .mark_transfer_progress(app, transfer_id, bytes_done, speed_kbps)
        .await;
}
