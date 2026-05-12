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
}
