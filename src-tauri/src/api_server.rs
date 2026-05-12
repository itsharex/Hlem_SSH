use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, RwLock},
};
use tower_http::cors::CorsLayer;

use crate::remote::RemoteRuntime;

/// Maximum upload body size: 512 MB
const MAX_UPLOAD_BODY: usize = 512 * 1024 * 1024;

#[derive(Clone)]
pub struct ApiServerState {
    pub api_key: Arc<RwLock<String>>,
    pub remote: RemoteRuntime,
    pub allowed_session_id: Option<String>,
    pub allowed_session_name: Option<String>,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
    pub log_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiLogEntry {
    pub timestamp: String,
    pub action: String,
    pub detail: String,
    pub success: bool,
    pub duration_ms: u64,
}

const MAX_LOG_ENTRIES: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerInfo {
    pub running: bool,
    pub port: u16,
    pub api_key: String,
}

/// Shared handle to control the running API server.
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

pub async fn start_server(
    remote: RemoteRuntime,
    port: u16,
    api_key: String,
    allowed_session_id: Option<String>,
    allowed_session_name: Option<String>,
    log_file: PathBuf,
) -> Result<ApiServerHandle, String> {
    // Load existing logs from file
    let existing_logs = load_logs_from_file(&log_file);
    let logs = Arc::new(RwLock::new(existing_logs));
    let state = ApiServerState {
        api_key: Arc::new(RwLock::new(api_key.clone())),
        remote,
        allowed_session_id: allowed_session_id.clone(),
        allowed_session_name: allowed_session_name.clone(),
        logs: logs.clone(),
        log_file: log_file.clone(),
    };

    let app = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/exec", post(exec_command))
        .route("/api/upload", post(upload_file))
        .route("/api/files", get(list_files))
        .route("/api/download", get(download_file))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("无法绑定端口 {}: {}", port, e))?;

    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("获取端口失败: {}", e))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow_and_update() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
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

// ─── Auth helper ───────────────────────────────────────────────────────────────

fn verify_auth(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    if token != expected {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "无效的 API Key".to_string(),
            }),
        ));
    }
    Ok(())
}

fn verify_session_access(state: &ApiServerState, session_id: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    if let Some(allowed) = &state.allowed_session_id {
        if allowed != session_id {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: format!("无权访问会话 {}，仅允许访问指定会话", session_id),
                }),
            ));
        }
    }
    Ok(())
}

async fn push_log(state: &ApiServerState, action: &str, detail: &str, success: bool, duration_ms: u64) {
    let entry = ApiLogEntry {
        timestamp: Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        success,
        duration_ms,
    };
    let mut logs = state.logs.write().await;
    logs.push(entry);
    if logs.len() > MAX_LOG_ENTRIES {
        let remove_count = logs.len() - MAX_LOG_ENTRIES;
        logs.drain(0..remove_count);
    }
    // Persist asynchronously (best-effort)
    if let Ok(json) = serde_json::to_string(&*logs) {
        let path = state.log_file.clone();
        tokio::spawn(async move {
            let _ = tokio::fs::write(path, json).await;
        });
    }
}

fn load_logs_from_file(path: &PathBuf) -> Vec<ApiLogEntry> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Convert a remote operation error string into an appropriate HTTP status + message.
/// If the error indicates the session is not connected, return 503 with a user-friendly hint.
fn map_remote_error(e: String, state: &ApiServerState) -> (StatusCode, Json<ApiError>) {
    if e.contains("未连接") {
        let display_name = state
            .allowed_session_name
            .as_deref()
            .unwrap_or("目标会话");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!("「{}」未连接。请在 HelM 主窗口中手动连接该会话后重试。", display_name),
            }),
        )
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e }),
        )
    }
}

/// Replace session UUID in a log detail string with the friendly session name.
fn friendly_error_detail(detail: &str, state: &ApiServerState) -> String {
    if let (Some(sid), Some(name)) = (&state.allowed_session_id, &state.allowed_session_name) {
        detail.replace(sid.as_str(), name.as_str())
    } else {
        detail.to_string()
    }
}

// ─── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ApiError {
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionItem {
    pub session_id: String,
    pub name: String,
    pub host: String,
    pub connected: bool,
    pub sftp_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecResponse {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    success: bool,
    remote_path: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
}

// ─── Request types ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecRequest {
    session_id: String,
    command: String,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}

fn default_timeout() -> u64 {
    30_000
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListFilesQuery {
    session_id: String,
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadQuery {
    session_id: String,
    path: String,
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

async fn list_sessions(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<SessionItem>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let sessions = state.remote.list_connected_sessions().await;
    Ok(Json(sessions))
}

async fn exec_command(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<ExecRequest>,
) -> Result<Json<ExecResponse>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    if let Some(reason) = check_dangerous_command(&body.command) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("命令被拒绝: {}", reason),
            }),
        ));
    }

    verify_session_access(&state, &body.session_id)?;

    let start = std::time::Instant::now();
    let result = state
        .remote
        .api_exec(&body.session_id, &body.command, body.timeout_ms)
        .await;
    let elapsed = start.elapsed().as_millis() as u64;

    match result {
        Ok(ref r) => {
            let detail = if body.command.len() > 80 { format!("{}...", &body.command[..77]) } else { body.command.clone() };
            push_log(&state, "exec", &detail, r.exit_status.unwrap_or(0) == 0, elapsed).await;
        }
        Err(ref e) => {
            let detail = friendly_error_detail(&format!("{} → {}", body.command, e), &state);
            push_log(&state, "exec", &detail, false, elapsed).await;
        }
    }

    let result = result.map_err(|e| map_remote_error(e.to_string(), &state))?;

    Ok(Json(ExecResponse {
        exit_code: result.exit_status.unwrap_or(0) as i32,
        stdout: result.stdout,
        stderr: result.stderr,
    }))
}

async fn upload_file(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let mut session_id: Option<String> = None;
    let mut remote_path: Option<String> = None;
    let mut file_data: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "sessionId" => {
                session_id = field.text().await.ok();
            }
            "remotePath" => {
                remote_path = field.text().await.ok();
            }
            "file" => {
                file_data = field.bytes().await.ok().map(|b| b.to_vec());
            }
            _ => {}
        }
    }

    let session_id = session_id.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "缺少 sessionId 字段".to_string(),
            }),
        )
    })?;
    let remote_path = remote_path.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "缺少 remotePath 字段".to_string(),
            }),
        )
    })?;
    let data = file_data.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "缺少 file 字段".to_string(),
            }),
        )
    })?;

    let size = data.len() as u64;
    verify_session_access(&state, &session_id)?;
    let start = std::time::Instant::now();
    let upload_result = state
        .remote
        .api_upload(&session_id, &remote_path, data)
        .await;
    let elapsed = start.elapsed().as_millis() as u64;

    match &upload_result {
        Ok(()) => push_log(&state, "upload", &format!("{} ({}B)", remote_path, size), true, elapsed).await,
        Err(e) => push_log(&state, "upload", &friendly_error_detail(&format!("{} → {}", remote_path, e), &state), false, elapsed).await,
    }

    upload_result.map_err(|e| map_remote_error(e, &state))?;

    Ok(Json(UploadResponse {
        success: true,
        remote_path,
        size,
    }))
}

async fn list_files(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let path = query.path.unwrap_or_else(|| "/".to_string());
    verify_session_access(&state, &query.session_id)?;
    let start = std::time::Instant::now();
    let entries = state
        .remote
        .api_list_files(&query.session_id, &path)
        .await;
    let elapsed = start.elapsed().as_millis() as u64;

    match &entries {
        Ok(list) => push_log(&state, "files", &format!("{} ({} 项)", path, list.len()), true, elapsed).await,
        Err(e) => push_log(&state, "files", &friendly_error_detail(&format!("{} → {}", path, e), &state), false, elapsed).await,
    }

    let entries = entries.map_err(|e: String| map_remote_error(e, &state))?;

    Ok(Json(entries))
}

async fn download_file(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    verify_session_access(&state, &query.session_id)?;
    let start = std::time::Instant::now();
    let data = state
        .remote
        .api_download(&query.session_id, &query.path)
        .await;
    let elapsed = start.elapsed().as_millis() as u64;

    match &data {
        Ok(bytes) => push_log(&state, "download", &format!("{} ({}B)", query.path, bytes.len()), true, elapsed).await,
        Err(e) => push_log(&state, "download", &friendly_error_detail(&format!("{} → {}", query.path, e), &state), false, elapsed).await,
    }

    let data = data.map_err(|e| map_remote_error(e, &state))?;

    let file_name = query
        .path
        .rsplit('/')
        .next()
        .unwrap_or("file")
        .to_string();

    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        "content-disposition",
        format!("attachment; filename=\"{}\"", file_name)
            .parse()
            .unwrap(),
    );

    Ok((StatusCode::OK, headers, data))
}


// ─── Dangerous command filter ──────────────────────────────────────────────────

/// Check if a command matches known dangerous patterns.
/// Returns Some(reason) if blocked, None if safe.
fn check_dangerous_command(command: &str) -> Option<&'static str> {
    let normalized = command.trim().to_lowercase();
    let parts: Vec<&str> = normalized.split_whitespace().collect();

    // rm -rf / or rm -rf /*
    if parts.first() == Some(&"rm") {
        let args = &parts[1..];
        let has_rf = args.iter().any(|a| {
            a.contains('r') && a.contains('f') && a.starts_with('-')
        });
        if has_rf {
            for arg in args {
                if !arg.starts_with('-') {
                    let path = arg.trim_matches('"').trim_matches('\'');
                    if path == "/" || path == "/*" || path == "/." || path == "/.."
                        || path.starts_with("/ ") || path == "$home" || path == "~"
                        || normalized.contains("--no-preserve-root")
                    {
                        return Some("禁止递归删除根目录或用户家目录");
                    }
                }
            }
        }
    }

    // Fork bomb patterns
    if normalized.contains(":(){ :|:& };:") || normalized.contains(":(){") {
        return Some("禁止 Fork 炸弹");
    }

    // mkfs on system disks
    if normalized.starts_with("mkfs") && (normalized.contains("/dev/sd") || normalized.contains("/dev/nvme") || normalized.contains("/dev/vd")) {
        return Some("禁止格式化磁盘");
    }

    // dd writing to block devices
    if parts.first() == Some(&"dd") && normalized.contains("of=/dev/") {
        return Some("禁止 dd 写入块设备");
    }

    // Redirect to block device
    if normalized.contains("> /dev/sd") || normalized.contains("> /dev/nvme") || normalized.contains("> /dev/vd") {
        return Some("禁止写入块设备");
    }

    // chmod/chown -R on root
    if (normalized.starts_with("chmod") || normalized.starts_with("chown"))
        && normalized.contains("-r")
        && (normalized.ends_with(" /") || normalized.contains(" / "))
    {
        return Some("禁止递归修改根目录权限");
    }

    // Piping remote scripts to shell
    if (normalized.contains("curl ") || normalized.contains("wget "))
        && (normalized.contains("| sh") || normalized.contains("| bash")
            || normalized.contains("|sh") || normalized.contains("|bash")
            || normalized.contains("| /bin/sh") || normalized.contains("| /bin/bash"))
    {
        return Some("禁止远程下载并直接执行脚本");
    }

    // shutdown / reboot / halt / poweroff
    if matches!(parts.first(), Some(&"shutdown") | Some(&"reboot") | Some(&"halt") | Some(&"poweroff") | Some(&"init")) {
        return Some("禁止关机/重启命令");
    }

    None
}
