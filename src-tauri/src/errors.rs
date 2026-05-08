use serde::Serialize;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyVerification {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum AppError {
    #[error("本机数据尚未初始化")]
    VaultNotFound,
    #[error("本机数据已存在")]
    VaultAlreadyExists,
    #[error("工作区已锁定")]
    VaultLocked,
    #[error("主密码错误或本机数据已损坏")]
    InvalidMasterPassword,
    #[error("配置项不存在: {0}")]
    NotFound(String),
    #[error("参数无效: {0}")]
    InvalidInput(String),
    #[error("主机密钥未信任")]
    HostKeyUntrusted(HostKeyVerification),
    #[error("主机密钥已变更")]
    HostKeyChanged(HostKeyVerification),
    #[error("传输需要覆盖确认: {0}")]
    TransferNeedsOverwrite(String),
    #[error("远程错误: {0}")]
    Remote(String),
    #[error("文件错误: {0}")]
    Io(String),
    #[error("加密错误: {0}")]
    Crypto(String),
    #[error("序列化错误: {0}")]
    Serde(String),
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serde(error.to_string())
    }
}

impl AppError {
    /// User-friendly NotFound for a runtime resource. The raw `id` (typically a UUID) is
    /// written to stderr so it stays available for debugging, while the toast in the UI
    /// only sees `friendly`.
    fn runtime_missing(kind: &str, id: &str, friendly: &str) -> Self {
        eprintln!("[helm] {} not found: {}", kind, id);
        AppError::NotFound(friendly.to_string())
    }

    pub fn missing_connection(id: &str) -> Self {
        Self::runtime_missing("connection", id, "连接已断开，请重新连接")
    }

    pub fn missing_terminal(id: &str) -> Self {
        Self::runtime_missing("terminal", id, "终端会话已失效，请重新连接")
    }

    pub fn missing_sftp(id: &str) -> Self {
        Self::runtime_missing("sftp", id, "SFTP 会话已失效，请重新连接")
    }

    pub fn missing_transfer(id: &str) -> Self {
        Self::runtime_missing("transfer", id, "传输任务已失效")
    }

    pub fn missing_telemetry_job(id: &str) -> Self {
        Self::runtime_missing("telemetry job", id, "监控任务已失效")
    }

    pub fn missing_forward(id: &str) -> Self {
        Self::runtime_missing("forward", id, "端口转发已失效")
    }
}
