use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Query, State as AxumState},
    http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    sync::{watch, RwLock},
};
use tokio_util::io::ReaderStream;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::config::{BackupRecord, BackupSettings, TunnelConfig, TunnelInput};
use crate::backup::{backup_file_name, build_backup_package};
use crate::remote::RemoteRuntime;
use crate::vault::VaultStore;

use tauri::AppHandle;

/// Maximum upload body size: 512 MB
const MAX_UPLOAD_BODY: usize = 512 * 1024 * 1024;

#[derive(Clone)]
pub struct ApiServerState {
    pub api_key: Arc<RwLock<String>>,
    pub app: AppHandle,
    pub remote: RemoteRuntime,
    pub vault: Arc<Mutex<VaultStore>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
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
    app: AppHandle,
    remote: RemoteRuntime,
    vault: Arc<Mutex<VaultStore>>,
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
        app,
        remote,
        vault,
        allowed_session_id: allowed_session_id.clone(),
        allowed_session_name: allowed_session_name.clone(),
        logs: logs.clone(),
        log_file: log_file.clone(),
    };

    // Restrict CORS to localhost origins only. The API server binds to 127.0.0.1
    // so external network origins can't reach it, but a malicious page open in
    // the user's browser could still issue cross-origin requests. The predicate
    // accepts http(s)://localhost(:port) and http(s)://127.0.0.1(:port) only.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            let Ok(origin_str) = origin.to_str() else {
                return false;
            };
            // Strip scheme then check the host part — accept only localhost / 127.0.0.1
            // (port is optional). Anything else is denied.
            let stripped = origin_str
                .strip_prefix("http://")
                .or_else(|| origin_str.strip_prefix("https://"));
            let Some(host_with_port) = stripped else {
                return false;
            };
            let host = host_with_port
                .split('/')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("");
            matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/exec", post(exec_command))
        .route("/api/upload", post(upload_file))
        .route("/api/files", get(list_files))
        .route("/api/download", get(download_file))
        .route("/api/tunnels", get(list_tunnels))
        .route("/api/tunnels/create", post(create_tunnel))
        .route("/api/tunnels/update", post(update_tunnel))
        .route("/api/tunnels/delete", post(delete_tunnel))
        .route("/api/tunnels/start", post(start_tunnel))
        .route("/api/tunnels/stop", post(stop_tunnel))
        .route("/api/backup/settings", get(get_backup_settings).post(update_backup_settings))
        .route("/api/backup/records", get(list_backup_records))
        .route("/api/backup/run", post(run_backup))
        .route("/api/backup/delete", post(delete_backup_record))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY))
        .layer(cors)
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
    push_log_with_response(state, action, detail, success, duration_ms, None).await;
}

async fn push_log_with_response(state: &ApiServerState, action: &str, detail: &str, success: bool, duration_ms: u64, response: Option<String>) {
    let entry = ApiLogEntry {
        timestamp: Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        success,
        duration_ms,
        response,
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

/// Truncate stdout/stderr for log storage (max 2000 chars combined).
fn truncate_response(stdout: &str, stderr: &str) -> String {
    const MAX_LEN: usize = 2000;
    let mut result = String::new();
    if !stdout.is_empty() {
        let stdout_trimmed = stdout.trim();
        if stdout_trimmed.len() > MAX_LEN {
            result.push_str(&stdout_trimmed[..MAX_LEN]);
            result.push_str("...(truncated)");
        } else {
            result.push_str(stdout_trimmed);
        }
    }
    if !stderr.is_empty() {
        let stderr_trimmed = stderr.trim();
        if !result.is_empty() {
            result.push_str("\n[stderr] ");
        } else {
            result.push_str("[stderr] ");
        }
        let remaining = MAX_LEN.saturating_sub(result.len());
        if stderr_trimmed.len() > remaining {
            result.push_str(&stderr_trimmed[..remaining]);
            result.push_str("...(truncated)");
        } else {
            result.push_str(stderr_trimmed);
        }
    }
    result
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
    timed_out: bool,
    duration_ms: u64,
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
            let response = truncate_response(&r.stdout, &r.stderr);
            push_log_with_response(&state, "exec", &detail, !r.timed_out && r.exit_status.unwrap_or(1) == 0, elapsed, Some(response)).await;
        }
        Err(ref e) => {
            let detail = friendly_error_detail(&format!("{} → {}", body.command, e), &state);
            push_log(&state, "exec", &detail, false, elapsed).await;
        }
    }

    let result = result.map_err(|e| map_remote_error(e.to_string(), &state))?;

    Ok(Json(ExecResponse {
        exit_code: result.exit_status.unwrap_or(1) as i32,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms as u64,
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

    // Stream the multipart body straight to a temp file. Previously the whole
    // upload was buffered to memory via field.bytes(), which scaled with file
    // size up to MAX_UPLOAD_BODY (512 MiB). Now memory stays bounded regardless
    // of file size — only the per-chunk Bytes briefly live in RAM.
    let mut session_id: Option<String> = None;
    let mut remote_path: Option<String> = None;
    let mut temp_file_path: Option<PathBuf> = None;
    let mut total_size: u64 = 0;

    // Helper that wipes the temp file on any error path so we don't leak partial uploads.
    async fn cleanup_temp(path: &Option<PathBuf>) {
        if let Some(p) = path.as_ref() {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("解析 multipart 失败: {}", e),
            }),
        )
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "sessionId" => {
                session_id = field.text().await.ok();
            }
            "remotePath" => {
                remote_path = field.text().await.ok();
            }
            "file" => {
                let temp_dir = std::env::temp_dir();
                let temp = temp_dir.join(format!("helm_upload_{}", uuid::Uuid::new_v4()));
                let mut file = match tokio::fs::File::create(&temp).await {
                    Ok(f) => f,
                    Err(e) => {
                        return Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ApiError {
                                error: format!("创建临时文件失败: {}", e),
                            }),
                        ));
                    }
                };
                temp_file_path = Some(temp);

                // Drain the field one chunk at a time; bail (and clean up) on any IO error.
                loop {
                    match field.chunk().await {
                        Ok(Some(chunk)) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                cleanup_temp(&temp_file_path).await;
                                return Err((
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    Json(ApiError {
                                        error: format!("写入临时文件失败: {}", e),
                                    }),
                                ));
                            }
                            total_size = total_size.saturating_add(chunk.len() as u64);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            cleanup_temp(&temp_file_path).await;
                            return Err((
                                StatusCode::BAD_REQUEST,
                                Json(ApiError {
                                    error: format!("读取上传分片失败: {}", e),
                                }),
                            ));
                        }
                    }
                }
                if let Err(e) = file.flush().await {
                    cleanup_temp(&temp_file_path).await;
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("刷写临时文件失败: {}", e),
                        }),
                    ));
                }
            }
            _ => {}
        }
    }

    let session_id = match session_id {
        Some(v) => v,
        None => {
            cleanup_temp(&temp_file_path).await;
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "缺少 sessionId 字段".to_string(),
                }),
            ));
        }
    };
    let remote_path = match remote_path {
        Some(v) => v,
        None => {
            cleanup_temp(&temp_file_path).await;
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "缺少 remotePath 字段".to_string(),
                }),
            ));
        }
    };
    let temp_file = match temp_file_path.clone() {
        Some(v) => v,
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "缺少 file 字段".to_string(),
                }),
            ));
        }
    };

    let size = total_size;
    if let Err(forbidden) = verify_session_access(&state, &session_id) {
        cleanup_temp(&temp_file_path).await;
        return Err(forbidden);
    }

    // Get sftp_id for this session
    let sftp_id = match state.remote.find_sftp_id_for_session(&session_id).await {
        Ok(v) => v,
        Err(e) => {
            cleanup_temp(&temp_file_path).await;
            return Err(map_remote_error(e, &state));
        }
    };

    let start = std::time::Instant::now();
    let transfer_result = state
        .remote
        .transfer_upload(
            &state.app,
            sftp_id,
            temp_file.to_string_lossy().to_string(),
            remote_path.clone(),
            true,  // overwrite
            false, // accelerated
            false, // resume
        )
        .await;
    let elapsed_start = start.elapsed().as_millis() as u64;

    let transfer_info = match transfer_result {
        Ok(info) => info,
        Err(e) => {
            cleanup_temp(&temp_file_path).await;
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", remote_path, e), &state),
                false,
                elapsed_start,
            )
            .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: e.to_string(),
                }),
            ));
        }
    };

    // Wait for transfer to complete
    let final_info = state
        .remote
        .wait_transfer(&transfer_info.transfer_id)
        .await;
    let elapsed = start.elapsed().as_millis() as u64;

    // Clean up temp file regardless of outcome
    cleanup_temp(&temp_file_path).await;

    match final_info {
        Ok(info) if matches!(info.status, crate::remote::TaskStatus::Completed) => {
            push_log(
                &state,
                "upload",
                &format!("{} ({}B)", remote_path, size),
                true,
                elapsed,
            )
            .await;
            Ok(Json(UploadResponse {
                success: true,
                remote_path,
                size,
            }))
        }
        Ok(info) => {
            let err_msg = info.error.unwrap_or_else(|| "传输失败".to_string());
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", remote_path, err_msg), &state),
                false,
                elapsed,
            )
            .await;
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: err_msg }),
            ))
        }
        Err(e) => {
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", remote_path, e), &state),
                false,
                elapsed,
            )
            .await;
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: e.to_string(),
                }),
            ))
        }
    }
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
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    verify_session_access(&state, &query.session_id)?;

    let start = std::time::Instant::now();

    // Stream directly from the remote SFTP file into the HTTP body. No temp
    // file, no intermediate buffer — bytes flow straight from SFTP read calls
    // into the response. This keeps memory bounded even for multi-GB files.
    let sftp = match state.remote.find_sftp_for_session(&query.session_id).await {
        Ok(sftp) => sftp,
        Err(e) => return Err(map_remote_error(e, &state)),
    };

    let metadata = match sftp.metadata(query.path.clone()).await {
        Ok(m) => m,
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(
                &state,
                "download",
                &friendly_error_detail(&format!("{} → {}", query.path, e), &state),
                false,
                elapsed,
            )
            .await;
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: format!("无法读取远程文件: {}", e),
                }),
            ));
        }
    };
    let size = metadata.len();

    let remote_file = match sftp.open(query.path.clone()).await {
        Ok(f) => f,
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(
                &state,
                "download",
                &friendly_error_detail(&format!("{} → {}", query.path, e), &state),
                false,
                elapsed,
            )
            .await;
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("打开远程文件失败: {}", e),
                }),
            ));
        }
    };

    // Use 1 MiB chunks: this is large enough to amortize per-chunk overhead but
    // small enough to keep watermark / TCP buffers happy on slow clients.
    let stream = ReaderStream::with_capacity(remote_file, 1024 * 1024);
    let body = Body::from_stream(stream);

    let elapsed = start.elapsed().as_millis() as u64;
    push_log(
        &state,
        "download",
        &format!("{} ({}B, 流式)", query.path, size),
        true,
        elapsed,
    )
    .await;

    let file_name = query.path.rsplit('/').next().unwrap_or("file");
    // file_name may contain non-ASCII; quote safely. Browsers accept "filename=" with
    // arbitrary bytes inside the quoted-string but reject unescaped CR/LF/quotes. The
    // SFTP path itself comes from the authenticated client so injection risk is low,
    // but still strip control chars defensively.
    let safe_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .collect();
    let disposition = format!("attachment; filename=\"{}\"", safe_name);

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size)
        .body(body)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("构建响应失败: {}", e),
                }),
            )
        })?;
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}


// ─── Dangerous command filter ──────────────────────────────────────────────────

/// Check if a command matches known dangerous patterns. The check operates on
/// the lower-cased full command string and looks for patterns that survive
/// common evasion attempts:
///   - shell wrappers: `bash -c "rm -rf /"` / `sh -lc "..."` / etc.
///   - command substitution: `$(rm -rf /)` / backticks
///   - command chaining: `foo; rm -rf /` / `foo && rm -rf /`
///   - find with -delete or -exec rm
///   - dd / mkfs / wipefs / shred targeting block devices
///   - chmod/chown -R on system directories
///   - curl|sh / wget|sh remote-script execution
///   - shutdown / reboot / halt / poweroff / init
///   - redirection that overwrites critical system files
///
/// Returns `Some(reason)` if blocked, `None` if safe. The check is best-effort —
/// a determined caller can always evade substring matching (base64 decode + eval,
/// envvar indirection, ...) so this should be treated as a guardrail against
/// accidents and obvious abuse, not a security boundary. The Bearer-token auth
/// + 127.0.0.1 bind are the actual security boundary.
fn check_dangerous_command(command: &str) -> Option<&'static str> {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    // Squeeze whitespace so patterns like "rm  -rf  /" still match "rm -rf /".
    let squeezed = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let parts: Vec<&str> = normalized.split_whitespace().collect();

    // 1. Fork bomb (substring; tolerate optional whitespace between tokens).
    if squeezed.contains(":(){ :|:& };:")
        || squeezed.contains(":(){:|:&};:")
        || normalized.contains(":(){")
    {
        return Some("禁止 Fork 炸弹");
    }

    // 2. Recursive rm on root / system / home — catches direct, wrapped (bash -c),
    // command-substituted, and chained variants by scanning the whole string.
    let rm_rf_aliases = ["rm -rf", "rm -fr", "rm -r -f", "rm -f -r"];
    let has_rm_rf = rm_rf_aliases.iter().any(|p| squeezed.contains(p));
    if has_rm_rf {
        if normalized.contains("--no-preserve-root") {
            return Some("禁止跳过根目录保护删除");
        }
        let dangerous_targets = [
            " /", " /*", " /.", " /..", " ~", " ~/", " $home", " ${home}", " /home",
            " /root", " /usr", " /etc", " /var", " /boot", " /sys", " /proc", " /lib",
            " /lib64", " /opt", " /sbin", " /bin",
        ];
        for prefix in rm_rf_aliases {
            for target in dangerous_targets {
                let needle = format!("{prefix}{target}");
                if squeezed.contains(&needle) {
                    return Some("禁止递归删除根/系统目录或用户家目录");
                }
            }
        }
    }

    // 3. find -delete / find -exec rm — whether find is at the start or wrapped
    // inside a shell -c, the substring will appear in the normalized text.
    let mentions_find = parts.iter().any(|p| *p == "find") || squeezed.contains(" find ");
    if mentions_find {
        if squeezed.contains(" -delete") || squeezed.ends_with(" -delete") {
            return Some("禁止 find -delete");
        }
        if squeezed.contains("-exec rm") || squeezed.contains("-execdir rm") {
            return Some("禁止 find -exec rm");
        }
    }

    // 4. Disk format / wipe / shred on block devices.
    if squeezed.contains("mkfs.") || squeezed.starts_with("mkfs ") || squeezed.contains(" mkfs ") {
        if normalized.contains("/dev/sd")
            || normalized.contains("/dev/nvme")
            || normalized.contains("/dev/vd")
            || normalized.contains("/dev/hd")
            || normalized.contains("/dev/mmc")
        {
            return Some("禁止格式化磁盘");
        }
    }
    if squeezed.contains("wipefs ") || squeezed.starts_with("wipefs") {
        return Some("禁止 wipefs");
    }
    if squeezed.contains("shred ")
        && (normalized.contains("/dev/sd")
            || normalized.contains("/dev/nvme")
            || normalized.contains("/dev/vd")
            || normalized.contains("/dev/hd"))
    {
        return Some("禁止 shred 块设备");
    }

    // 5. dd writing to a block device.
    let mentions_dd = parts.first().copied() == Some("dd")
        || squeezed.contains(" dd ")
        || squeezed.contains(";dd ")
        || squeezed.contains("&& dd ");
    if mentions_dd
        && (normalized.contains("of=/dev/sd")
            || normalized.contains("of=/dev/nvme")
            || normalized.contains("of=/dev/vd")
            || normalized.contains("of=/dev/hd"))
    {
        return Some("禁止 dd 写入块设备");
    }

    // 6. Redirect to a block device.
    if normalized.contains("> /dev/sd")
        || normalized.contains(">/dev/sd")
        || normalized.contains("> /dev/nvme")
        || normalized.contains(">/dev/nvme")
        || normalized.contains("> /dev/vd")
        || normalized.contains(">/dev/vd")
        || normalized.contains("> /dev/hd")
        || normalized.contains(">/dev/hd")
    {
        return Some("禁止写入块设备");
    }

    // 7. chmod / chown -R targeting system directories.
    let touches_perm = squeezed.contains("chmod ") || squeezed.contains("chown ");
    let recursive_flag = squeezed.contains(" -r ")
        || squeezed.contains(" -rf ")
        || squeezed.contains(" -fr ")
        || squeezed.contains(" -r\t")
        || squeezed.ends_with(" -r");
    if touches_perm && recursive_flag {
        let system_dirs = [
            " /", " /*", " /etc", " /usr", " /var", " /bin", " /sbin", " /lib",
            " /lib64", " /boot", " /home", " /root", " ~",
        ];
        if system_dirs.iter().any(|d| {
            squeezed.contains(&format!("{d} "))
                || squeezed.ends_with(d)
                || squeezed.contains(&format!("{d};"))
        }) {
            return Some("禁止递归修改系统目录权限");
        }
        // Also catch trailing " /" without a following space (end of string).
        if squeezed.ends_with(" /") {
            return Some("禁止递归修改系统目录权限");
        }
    }

    // 8. curl/wget piped to shell — covers the classic pwn vector. We still
    // allow `curl url > file` patterns; only piped execution is blocked.
    let uses_downloader = squeezed.contains("curl ")
        || squeezed.contains("curl\t")
        || squeezed.contains("wget ")
        || squeezed.contains("wget\t");
    let pipes_to_shell = squeezed.contains("| sh")
        || squeezed.contains("|sh")
        || squeezed.contains("| bash")
        || squeezed.contains("|bash")
        || squeezed.contains("| zsh")
        || squeezed.contains("|zsh")
        || squeezed.contains("| /bin/sh")
        || squeezed.contains("|/bin/sh")
        || squeezed.contains("| /bin/bash")
        || squeezed.contains("|/bin/bash");
    if uses_downloader && pipes_to_shell {
        return Some("禁止远程下载并直接执行脚本");
    }

    // 9. Power-state change commands. Catch both "first token" and "wrapped".
    let powerstate_tokens = ["shutdown", "reboot", "halt", "poweroff"];
    if powerstate_tokens.contains(&parts.first().copied().unwrap_or("")) {
        return Some("禁止关机/重启命令");
    }
    for tok in powerstate_tokens {
        if squeezed.contains(&format!(" {tok} "))
            || squeezed.contains(&format!(";{tok} "))
            || squeezed.contains(&format!("&& {tok} "))
            || squeezed.contains(&format!(" {tok};"))
            || squeezed.ends_with(&format!(" {tok}"))
            || squeezed.contains(&format!("\"{tok} "))
            || squeezed.contains(&format!("'{tok} "))
        {
            return Some("禁止关机/重启命令");
        }
    }
    // init 0 / init 6 — catch both bare and wrapped.
    if squeezed.contains("init 0")
        || squeezed.contains("init 6")
        || parts.first().copied() == Some("init")
            && matches!(parts.get(1).copied(), Some("0") | Some("6"))
    {
        return Some("禁止关机/重启命令");
    }

    // 10. Truncating critical system files via redirection.
    let critical_files = [
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
        "/etc/fstab",
        "/etc/hosts",
        "/etc/ssh/sshd_config",
        "/boot/grub/grub.cfg",
    ];
    for cf in critical_files {
        // Match `> /etc/passwd` and `>/etc/passwd`. Distinguish from `>>` (append).
        let single_space = format!("> {cf}");
        let single_nospace = format!(">{cf}");
        let append_space = format!(">> {cf}");
        let append_nospace = format!(">>{cf}");
        // Truncate-only matches: contains the redirect-without-double-arrow pattern.
        let has_truncate = (normalized.contains(&single_space) && !normalized.contains(&append_space))
            || (normalized.contains(&single_nospace) && !normalized.contains(&append_nospace));
        if has_truncate {
            return Some("禁止覆盖关键系统文件");
        }
    }

    None
}

// ─── Tunnel types ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelUpdateRequest {
    tunnel_id: String,
    #[serde(flatten)]
    input: TunnelInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelIdRequest {
    tunnel_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStartResponse {
    success: bool,
    forward_id: String,
    bind_host: String,
    bind_port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStopResponse {
    success: bool,
}

// ─── Tunnel handlers ───────────────────────────────────────────────────────────

async fn list_tunnels(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<TunnelConfig>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let tunnels = {
        let store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.tunnels().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?
    };
    Ok(Json(tunnels))
}

async fn create_tunnel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(input): Json<TunnelInput>,
) -> Result<Json<Vec<TunnelConfig>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();
    let result = {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.create_tunnel(input.clone())
    };
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => push_log(&state, "tunnel", &format!("创建隧道「{}」", input.name), true, elapsed).await,
        Err(e) => push_log(&state, "tunnel", &format!("创建隧道失败: {}", e), false, elapsed).await,
    }

    let snapshot = result.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(ApiError { error: e.to_string() }),
    ))?;
    Ok(Json(snapshot.data.tunnels))
}

async fn update_tunnel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<TunnelUpdateRequest>,
) -> Result<Json<Vec<TunnelConfig>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();
    let result = {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.update_tunnel(&body.tunnel_id, body.input.clone())
    };
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => push_log(&state, "tunnel", &format!("更新隧道「{}」", body.input.name), true, elapsed).await,
        Err(e) => push_log(&state, "tunnel", &format!("更新隧道失败: {}", e), false, elapsed).await,
    }

    let snapshot = result.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(ApiError { error: e.to_string() }),
    ))?;
    Ok(Json(snapshot.data.tunnels))
}

async fn delete_tunnel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<TunnelIdRequest>,
) -> Result<Json<Vec<TunnelConfig>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();
    let result = {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.delete_tunnel(&body.tunnel_id)
    };
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => push_log(&state, "tunnel", &format!("删除隧道 {}", body.tunnel_id), true, elapsed).await,
        Err(e) => push_log(&state, "tunnel", &format!("删除隧道失败: {}", e), false, elapsed).await,
    }

    let snapshot = result.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(ApiError { error: e.to_string() }),
    ))?;
    Ok(Json(snapshot.data.tunnels))
}

async fn start_tunnel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<TunnelIdRequest>,
) -> Result<Json<TunnelStartResponse>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    // Look up tunnel config from vault
    let tunnel = {
        let store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        let tunnels = store.tunnels().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        tunnels.into_iter().find(|t| t.id == body.tunnel_id).ok_or_else(|| (
            StatusCode::NOT_FOUND,
            Json(ApiError { error: format!("隧道 {} 不存在", body.tunnel_id) }),
        ))?
    };

    verify_session_access(&state, &tunnel.session_id)?;

    let start = std::time::Instant::now();
    let result = state.remote.api_start_tunnel(&tunnel).await;
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(info) => push_log(&state, "tunnel", &format!("启动「{}」{}:{}", tunnel.name, info.0, info.1), true, elapsed).await,
        Err(e) => push_log(&state, "tunnel", &friendly_error_detail(&format!("启动「{}」失败: {}", tunnel.name, e), &state), false, elapsed).await,
    }

    let (bind_host, bind_port, forward_id) = result.map_err(|e| map_remote_error(e, &state))?;

    Ok(Json(TunnelStartResponse {
        success: true,
        forward_id,
        bind_host,
        bind_port,
    }))
}

async fn stop_tunnel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<TunnelIdRequest>,
) -> Result<Json<TunnelStopResponse>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    // The tunnel_id here is actually the forward_id (running instance ID)
    let start = std::time::Instant::now();
    let result = state.remote.api_stop_tunnel(&body.tunnel_id).await;
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(()) => push_log(&state, "tunnel", &format!("停止隧道 {}", body.tunnel_id), true, elapsed).await,
        Err(e) => push_log(&state, "tunnel", &format!("停止隧道失败: {}", e), false, elapsed).await,
    }

    result.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e }),
    ))?;

    Ok(Json(TunnelStopResponse { success: true }))
}

// ─── Backup handlers ───────────────────────────────────────────────────────────

async fn get_backup_settings(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<BackupSettings>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let settings = {
        let store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        let snapshot = store.snapshot().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        snapshot.data.settings.backup
    };
    Ok(Json(settings))
}

async fn update_backup_settings(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(backup): Json<BackupSettings>,
) -> Result<Json<BackupSettings>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();
    let result = {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        let snapshot = store.snapshot().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        let mut settings = snapshot.data.settings.clone();
        settings.backup = backup.clone();
        store.settings_update(settings)
    };
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => push_log(&state, "backup", "更新备份配置", true, elapsed).await,
        Err(e) => push_log(&state, "backup", &format!("更新备份配置失败: {}", e), false, elapsed).await,
    }

    result.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() }),
    ))?;
    Ok(Json(backup))
}

async fn list_backup_records(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<BackupRecord>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let records = {
        let store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        let snapshot = store.snapshot().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        snapshot.data.backup_records
    };
    Ok(Json(records))
}

async fn run_backup(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<BackupRecord>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();

    let (settings, vault_path, file_name) = {
        let store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.ensure_unlocked().map_err(|e| (
            StatusCode::FORBIDDEN,
            Json(ApiError { error: e.to_string() }),
        ))?;
        let snapshot = store.snapshot().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        (snapshot.data.settings.backup, store.vault_file_path(), backup_file_name())
    };

    let bytes = tokio::fs::read(&vault_path).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: format!("读取 vault 文件失败: {}", e) }),
    ))?;

    let package = build_backup_package(bytes).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() }),
    ))?;

    let size = package.len() as u64;
    let has_local = settings.local_directory.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);

    if !has_local && !settings.cloud.enabled {
        let elapsed = start.elapsed().as_millis() as u64;
        push_log(&state, "backup", "备份失败: 未配置备份目录", false, elapsed).await;
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: "请先配置本地备份目录或启用云端备份".to_string() }),
        ));
    }

    let mut outcomes = Vec::new();
    if has_local {
        let directory = PathBuf::from(settings.local_directory.as_deref().unwrap().trim());
        let target = directory.join(&file_name);
        match async {
            tokio::fs::create_dir_all(&directory).await?;
            tokio::fs::write(&target, &package).await?;
            Ok::<(), std::io::Error>(())
        }.await {
            Ok(()) => outcomes.push(BackupRecord::success(
                file_name.clone(), "local", target.to_string_lossy().to_string(), size,
            )),
            Err(e) => outcomes.push(BackupRecord::failed(
                file_name.clone(), "local", target.to_string_lossy().to_string(), e.to_string(),
            )),
        }
    }

    let elapsed = start.elapsed().as_millis() as u64;
    let success = outcomes.iter().any(|r| r.status == "success");
    push_log(&state, "backup", &format!("立即备份 ({})", file_name), success, elapsed).await;

    // Save records to vault
    {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        let snapshot = store.snapshot().map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() }),
        ))?;
        let mut records = snapshot.data.backup_records.clone();
        for outcome in &outcomes {
            let already = records.iter().any(|r| r.target_kind == outcome.target_kind && r.target_path == outcome.target_path);
            if outcome.status != "success" || !already {
                records.push(outcome.clone());
            }
        }
        let _ = store.replace_backup_records(records);
    }

    Ok(Json(outcomes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupDeleteRequest {
    record_id: String,
    #[serde(default)]
    delete_file: bool,
}

async fn delete_backup_record(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<BackupDeleteRequest>,
) -> Result<Json<Vec<BackupRecord>>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let start = std::time::Instant::now();
    let result = {
        let mut store = state.vault.lock().map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: "内部锁错误".to_string() }),
        ))?;
        store.delete_backup_record(&body.record_id, body.delete_file)
    };
    let elapsed = start.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => push_log(&state, "backup", &format!("删除备份记录 {}", body.record_id), true, elapsed).await,
        Err(e) => push_log(&state, "backup", &format!("删除备份记录失败: {}", e), false, elapsed).await,
    }

    let (snapshot, delete_path) = result.map_err(|e| (
        StatusCode::BAD_REQUEST,
        Json(ApiError { error: e.to_string() }),
    ))?;

    if let Some(path) = delete_path {
        let _ = tokio::fs::remove_file(path).await;
    }

    Ok(Json(snapshot.data.backup_records))
}
