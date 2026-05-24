mod auth;
mod guard;
mod handlers_remote;
mod ws;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method, StatusCode},
    response::Json,
    routing::{any, get, put},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Notify, RwLock},
    time::Duration,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::events as app_events;
use crate::remote::RemoteRuntime;
use crate::vault::VaultStore;

use tauri::{AppHandle, Emitter};

pub use handlers_remote::{FileEntry, SessionItem};

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BODY: usize = 512 * 1024 * 1024;
const MAX_LOG_ENTRIES: usize = 100;
const LOG_FLUSH_DEBOUNCE: Duration = Duration::from_secs(1);
/// Ticket 有效期（秒）。客户端从 WS 拿到 ticket 后须在该窗口内发起 HTTP 请求。
pub(self) const TICKET_TTL: Duration = Duration::from_secs(60);
/// Ticket 清理任务运行间隔。
const TICKET_CLEANUP_INTERVAL: Duration = Duration::from_secs(30);

// ─── Public types ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub(self) enum TicketPurpose {
    Upload,
    Download,
}

impl TicketPurpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "upload" => Some(Self::Upload),
            "download" => Some(Self::Download),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct ApiServerState {
    pub api_key: Arc<RwLock<String>>,
    pub app: AppHandle,
    pub remote: RemoteRuntime,
    pub vault: Arc<Mutex<VaultStore>>,
    pub allowed_session_id: Option<String>,
    pub allowed_session_name: Option<String>,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
    #[allow(dead_code)]
    pub log_file: PathBuf,
    pub log_dirty: Arc<Notify>,
    /// 已消费的 ticket nonce → 过期时刻。用于一次性票据的防重放保护。
    /// HMAC 无状态票据本身不在服务端存储；只保留"已用过"的 nonce 即可。
    pub(self) consumed_nonces: Arc<RwLock<HashMap<String, Instant>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiLogEntry {
    pub timestamp: String,
    pub action: String,
    pub detail: String,
    pub success: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerInfo {
    pub running: bool,
    pub port: u16,
    pub api_key: String,
}

pub struct ApiServerHandle {
    shutdown_tx: watch::Sender<bool>,
    pub port: u16,
    pub api_key: String,
    pub allowed_session_id: Option<String>,
    pub allowed_session_name: Option<String>,
    pub log_file: PathBuf,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
}

impl ApiServerHandle {
    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[derive(Serialize)]
pub(self) struct ApiError {
    error: String,
}

// ─── Shared helpers (used by handler sub-modules) ──────────────────────────────

pub(self) async fn push_log(state: &ApiServerState, action: &str, detail: &str, success: bool, duration_ms: u64) {
    push_log_with_response(state, action, detail, success, duration_ms, None).await;
}

pub(self) async fn push_log_with_response(state: &ApiServerState, action: &str, detail: &str, success: bool, duration_ms: u64, response: Option<String>) {
    let entry = ApiLogEntry {
        timestamp: Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        success,
        duration_ms,
        response,
    };
    {
        let mut logs = state.logs.write().await;
        logs.push(entry.clone());
        if logs.len() > MAX_LOG_ENTRIES {
            let remove_count = logs.len() - MAX_LOG_ENTRIES;
            logs.drain(0..remove_count);
        }
    }
    let _ = state.app.emit(app_events::API_LOG, &entry);
    state.log_dirty.notify_one();
}

fn load_logs_from_file(path: &PathBuf) -> Vec<ApiLogEntry> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub(self) fn map_remote_error(e: String, state: &ApiServerState) -> (StatusCode, Json<ApiError>) {
    if e.contains("未连接") {
        let display_name = state.allowed_session_name.as_deref().unwrap_or("目标会话");
        (StatusCode::SERVICE_UNAVAILABLE, Json(ApiError { error: format!("「{}」未连接。请在 HelM 主窗口中手动连接该会话后重试。", display_name) }))
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e }))
    }
}

pub(self) fn friendly_error_detail(detail: &str, state: &ApiServerState) -> String {
    if let (Some(sid), Some(name)) = (&state.allowed_session_id, &state.allowed_session_name) {
        detail.replace(sid.as_str(), name.as_str())
    } else {
        detail.to_string()
    }
}

// ─── Server startup ────────────────────────────────────────────────────────────

pub async fn start_server(
    app: AppHandle,
    remote: RemoteRuntime,
    vault: Arc<Mutex<VaultStore>>,
    port: u16,
    api_key: String,
    allowed_session_id: Option<String>,
    allowed_session_name: Option<String>,
    log_file: PathBuf,
) -> Result<ApiServerHandle, String> {
    let existing_logs = load_logs_from_file(&log_file);
    let logs = Arc::new(RwLock::new(existing_logs));
    let log_dirty = Arc::new(Notify::new());
    let consumed_nonces = Arc::new(RwLock::new(HashMap::<String, Instant>::new()));
    let state = ApiServerState {
        api_key: Arc::new(RwLock::new(api_key.clone())),
        app: app.clone(),
        remote,
        vault,
        allowed_session_id: allowed_session_id.clone(),
        allowed_session_name: allowed_session_name.clone(),
        logs: logs.clone(),
        log_file: log_file.clone(),
        log_dirty: log_dirty.clone(),
        consumed_nonces: consumed_nonces.clone(),
    };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            let Ok(origin_str) = origin.to_str() else { return false; };
            let stripped = origin_str.strip_prefix("http://").or_else(|| origin_str.strip_prefix("https://"));
            let Some(host_with_port) = stripped else { return false; };
            let host = host_with_port.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
            matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app_router = Router::new()
        // HTTP 仅保留：鉴权验证 + 文件上传/下载（二进制流不适合 WS）+ WS 升级
        .route("/api/auth", get(handlers_remote::auth_check))
        // raw PUT：query 带 sessionId / remotePath / ticket，body 是文件原始字节，
        // 服务端流式直写 SFTP，无 temp 文件、无 multipart 解析。
        // 可选 Content-Range 头实现并发分块上传（每片自带 ticket + Range，互不阻塞）。
        .route("/api/upload", put(handlers_remote::upload_file_raw))
        .route("/api/download", get(handlers_remote::download_file))
        .route("/api/ws", any(ws::ws_handler))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY))
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("无法绑定端口 {}: {}", port, e))?;

    let actual_port = listener.local_addr().map_err(|e| format!("获取端口失败: {}", e))?.port();

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    // Background nonce cleaner: 周期性扫描过期的"已消费 nonce"并移除，避免内存泄漏。
    // 由于 ticket TTL 60s，最坏情况下集合大小 = TICKET_CLEANUP_INTERVAL 内的消费速率。
    {
        let nonces_for_cleaner = consumed_nonces.clone();
        let mut cleaner_shutdown = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(TICKET_CLEANUP_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let now = Instant::now();
                        let mut map = nonces_for_cleaner.write().await;
                        map.retain(|_, expires_at| *expires_at > now);
                    }
                    _ = cleaner_shutdown.changed() => {
                        if *cleaner_shutdown.borrow_and_update() { break; }
                    }
                }
            }
        });
    }

    // Background log flusher
    {
        let logs_for_flusher = logs.clone();
        let log_file_for_flusher = log_file.clone();
        let dirty = log_dirty.clone();
        let mut flusher_shutdown = shutdown_tx.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = dirty.notified() => {
                        tokio::time::sleep(LOG_FLUSH_DEBOUNCE).await;
                        let snapshot = logs_for_flusher.read().await.clone();
                        if let Ok(json) = serde_json::to_string(&snapshot) {
                            let _ = tokio::fs::write(&log_file_for_flusher, json).await;
                        }
                    }
                    _ = flusher_shutdown.changed() => {
                        if *flusher_shutdown.borrow_and_update() {
                            let snapshot = logs_for_flusher.read().await.clone();
                            if let Ok(json) = serde_json::to_string(&snapshot) {
                                let _ = tokio::fs::write(&log_file_for_flusher, json).await;
                            }
                            break;
                        }
                    }
                }
            }
        });
    }

    tokio::spawn(async move {
        axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow_and_update() {
                    if shutdown_rx.changed().await.is_err() { break; }
                }
            })
            .await
            .ok();
    });

    Ok(ApiServerHandle {
        shutdown_tx,
        port: actual_port,
        api_key,
        allowed_session_id,
        allowed_session_name,
        log_file,
        logs,
    })
}
