use super::*;
use crate::api_server::{FileEntry, SessionItem};
use std::sync::Arc;

impl RemoteRuntime {
    /// List all currently connected sessions with their SFTP availability.
    pub async fn list_connected_sessions(&self) -> Vec<SessionItem> {
        let connections = self.connections.read().await;
        let sftp_sessions = self.sftp_sessions.read().await;

        connections
            .values()
            .filter(|record| record.info.status == RuntimeStatus::Connected)
            .map(|record| {
                let has_sftp = sftp_sessions
                    .values()
                    .any(|sftp| sftp.info.connection_id == record.info.connection_id);
                SessionItem {
                    session_id: record.info.session_id.clone(),
                    name: record
                        .info
                        .username
                        .clone()
                        + "@"
                        + &record.info.host,
                    host: format!("{}:{}", record.info.host, record.info.port),
                    connected: true,
                    sftp_available: has_sftp,
                }
            })
            .collect()
    }

    /// Execute a command on a connected session (by session_id).
    pub async fn api_exec(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: u64,
    ) -> Result<ExecResult, String> {
        let connection_id = self.find_connection_for_session(session_id).await?;
        self.exec_on_connection(&connection_id, command.to_string(), Some(timeout_ms))
            .await
            .map_err(|e| e.to_string())
    }

    /// Upload file content to a remote path via SFTP.
    pub async fn api_upload(
        &self,
        session_id: &str,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        // Ensure parent directory exists
        let parent = remote_path
            .rsplit_once('/')
            .map(|(p, _)| p)
            .unwrap_or("/");
        if !parent.is_empty() && parent != "/" {
            let _ = sftp.create_dir(parent.to_string()).await;
        }
        // Write file
        let mut file = sftp
            .open_with_flags(
                remote_path.to_string(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("打开远程文件失败: {}", e))?;
        file.write_all(&data)
            .await
            .map_err(|e| format!("写入远程文件失败: {}", e))?;
        file.flush()
            .await
            .map_err(|e| format!("刷新远程文件失败: {}", e))?;
        Ok(())
    }

    /// List files in a remote directory.
    pub async fn api_list_files(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        let entries = sftp
            .read_dir(path.to_string())
            .await
            .map_err(|e| format!("列出目录失败: {}", e))?;

        Ok(entries
            .into_iter()
            .filter(|e| {
                let name = e.file_name();
                name != "." && name != ".."
            })
            .map(|entry| {
                let name = entry.file_name();
                let file_type = entry.file_type();
                let size = entry.metadata().len();
                let ft = if file_type.is_dir() {
                    "directory"
                } else if file_type.is_symlink() {
                    "symlink"
                } else {
                    "file"
                };
                let entry_path = if path == "/" {
                    format!("/{}", name)
                } else {
                    format!("{}/{}", path.trim_end_matches('/'), name)
                };
                FileEntry {
                    name,
                    path: entry_path,
                    file_type: ft.to_string(),
                    size,
                }
            })
            .collect())
    }

    /// Download a file from remote.
    pub async fn api_download(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Vec<u8>, String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        let mut file = sftp
            .open(remote_path.to_string())
            .await
            .map_err(|e| format!("打开远程文件失败: {}", e))?;
        let metadata = sftp
            .metadata(remote_path.to_string())
            .await
            .map_err(|e| format!("获取文件信息失败: {}", e))?;
        let size = metadata.len() as usize;
        let mut buf = Vec::with_capacity(size);
        let mut tmp = vec![0u8; 1024 * 1024];
        loop {
            let n = file
                .read(&mut tmp)
                .await
                .map_err(|e| format!("读取远程文件失败: {}", e))?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        Ok(buf)
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    async fn find_connection_for_session(&self, session_id: &str) -> Result<String, String> {
        let connections = self.connections.read().await;
        connections
            .values()
            .find(|record| {
                record.info.session_id == session_id
                    && record.info.status == RuntimeStatus::Connected
            })
            .map(|record| record.info.connection_id.clone())
            .ok_or_else(|| format!("会话 {} 未连接", session_id))
    }

    async fn find_sftp_for_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpSession>, String> {
        let connection_id = self.find_connection_for_session(session_id).await?;
        let sftp_sessions = self.sftp_sessions.read().await;
        let record = sftp_sessions
            .values()
            .find(|record| record.info.connection_id == connection_id)
            .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?;
        Ok(record.next_transfer_session().await)
    }

    /// Start a tunnel (port forward) based on a TunnelConfig. Returns (bind_host, bind_port, forward_id).
    pub async fn api_start_tunnel(
        &self,
        tunnel: &crate::config::TunnelConfig,
    ) -> Result<(String, u16, String), String> {
        let connection_id = self.find_connection_for_session(&tunnel.session_id).await?;
        let connection = self.connection(&connection_id).await.map_err(|e| e.to_string())?;

        match tunnel.forward_type.as_str() {
            "local" => {
                let listener = TcpListener::bind((tunnel.bind_host.as_str(), tunnel.bind_port))
                    .await
                    .map_err(|e| format!("绑定端口失败: {}", e))?;
                let actual_port = listener.local_addr().map_err(|e| format!("获取端口失败: {}", e))?.port();
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Local,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: actual_port,
                    target_host: tunnel.target_host.clone(),
                    target_port: tunnel.target_port,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                let handle = connection.handle.clone();
                let remote_host = tunnel.target_host.clone();
                let remote_port = tunnel.target_port;
                let task = tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let handle = handle.clone();
                                let host = remote_host.clone();
                                tokio::spawn(async move {
                                    let _ = pipe_local_to_ssh(stream, handle, host, remote_port).await;
                                });
                            }
                            Err(_) => break,
                        }
                    }
                });
                self.forwards.write().await.insert(
                    forward_id.clone(),
                    ForwardRecord { info, handle: Some(task) },
                );
                Ok((tunnel.bind_host.clone(), actual_port, forward_id))
            }
            "dynamic" => {
                let listener = TcpListener::bind((tunnel.bind_host.as_str(), tunnel.bind_port))
                    .await
                    .map_err(|e| format!("绑定端口失败: {}", e))?;
                let actual_port = listener.local_addr().map_err(|e| format!("获取端口失败: {}", e))?.port();
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Dynamic,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: actual_port,
                    target_host: "SOCKS5".to_string(),
                    target_port: 0,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                let handle = connection.handle.clone();
                let task = tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let handle = handle.clone();
                                tokio::spawn(async move {
                                    let _ = handle_socks5(stream, handle).await;
                                });
                            }
                            Err(_) => break,
                        }
                    }
                });
                self.forwards.write().await.insert(
                    forward_id.clone(),
                    ForwardRecord { info, handle: Some(task) },
                );
                Ok((tunnel.bind_host.clone(), actual_port, forward_id))
            }
            "remote" => {
                let target = RemoteForwardTarget {
                    local_host: tunnel.target_host.clone(),
                    local_port: tunnel.target_port,
                };
                connection.remote_forwards.write().await.insert(
                    forward_key(&tunnel.bind_host, tunnel.bind_port),
                    target,
                );
                let assigned_port = {
                    let handle = connection.handle.lock().await;
                    handle
                        .tcpip_forward(tunnel.bind_host.clone(), tunnel.bind_port as u32)
                        .await
                        .map_err(|e| format!("远程转发失败: {}", e))? as u16
                };
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Remote,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: assigned_port,
                    target_host: "local".to_string(),
                    target_port: tunnel.target_port,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                self.forwards.write().await.insert(
                    forward_id.clone(),
                    ForwardRecord { info, handle: None },
                );
                Ok((tunnel.bind_host.clone(), assigned_port, forward_id))
            }
            other => Err(format!("不支持的隧道类型: {}", other)),
        }
    }

    /// Stop a running tunnel by forward_id.
    pub async fn api_stop_tunnel(&self, forward_id: &str) -> Result<(), String> {
        let mut record = self
            .forwards
            .write()
            .await
            .remove(forward_id)
            .ok_or_else(|| format!("转发 {} 不存在或已停止", forward_id))?;
        if let Some(handle) = record.handle.take() {
            handle.abort();
        }
        if matches!(record.info.forward_type, ForwardType::Remote) {
            if let Some(connection) = self
                .find_connection_by_session(&record.info.session_id)
                .await
            {
                let handle = connection.handle.lock().await;
                let _ = handle
                    .cancel_tcpip_forward(record.info.bind_host.clone(), record.info.bind_port as u32)
                    .await;
                connection
                    .remote_forwards
                    .write()
                    .await
                    .remove(&forward_key(&record.info.bind_host, record.info.bind_port));
            }
        }
        record.info.status = TaskStatus::Canceled;
        Ok(())
    }
}
