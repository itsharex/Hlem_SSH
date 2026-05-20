use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Multipart, Query, State as AxumState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Json, Response},
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use super::auth::{consume_ticket, verify_auth, verify_session_access};
use super::{friendly_error_detail, map_remote_error, push_log, ApiError, ApiServerState, TicketPurpose};

// ─── Public types (re-exported from mod.rs) ────────────────────────────────────

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
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
}

// ─── Private types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadResponse {
    success: bool,
    remote_path: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadQuery {
    /// WS 签发的一次性票据。放在 query 中是为了能在解析 multipart 之前先校验，
    /// 避免持票无效时仍然把整个大文件读入临时文件造成的 DoS。
    #[serde(default)]
    ticket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadQuery {
    session_id: String,
    path: String,
    #[serde(default)]
    ticket: String,
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

/// HTTP 鉴权验证端点。仅用于 api_key 探活——客户端可在打开 WS 之前测试 key 是否有效。
/// 真正的业务鉴权全部走 WS（长连接）+ ticket（HTTP upload/download）。
pub async fn auth_check(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);
    Ok(Json(serde_json::json!({
        "authenticated": true,
        "ws": "/api/ws",
        "uploadFlow": "ws issue-ticket(purpose=upload) → POST /api/upload?ticket=...",
        "downloadFlow": "ws issue-ticket(purpose=download) → GET /api/download?ticket=...&sessionId=...&path=...",
    })))
}

pub async fn upload_file(
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    // 票据必须先解析 sessionId 才能与 ticket 绑定校验，但 ticket 本身的"存在 + 未过期 + 用途"
    // 这部分可以提前校验，且即便如此也仍然有 DoS 防护：multipart 还没读，正常流程下这里就已拦截。
    // 由于 consume_ticket 是一次性的，我们把票据完整校验放到 sessionId 解析之后做。

    let mut session_id: Option<String> = None;
    let mut remote_path: Option<String> = None;
    let mut temp_file_path: Option<PathBuf> = None;
    let mut total_size: u64 = 0;

    async fn cleanup_temp(path: &Option<PathBuf>) {
        if let Some(p) = path.as_ref() { let _ = tokio::fs::remove_file(p).await; }
    }

    // 第一遍只接收非文件字段，用于先做完整票据校验。
    // 但 multipart 是单向流，所以我们采用：sessionId/remotePath 必须排在 file 字段之前。
    // 解析时在拿到 file 之前如果已经有 sessionId，先 consume_ticket，再继续读取 file。
    let mut ticket_consumed = false;

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        (StatusCode::BAD_REQUEST, Json(ApiError { error: format!("解析 multipart 失败: {}", e) }))
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "sessionId" => { session_id = field.text().await.ok(); }
            "remotePath" => { remote_path = field.text().await.ok(); }
            "file" => {
                // 在开始消耗大文件前必须确保票据有效。
                if !ticket_consumed {
                    let sid = match session_id.as_deref() {
                        Some(s) if !s.is_empty() => s,
                        _ => {
                            return Err((StatusCode::BAD_REQUEST, Json(ApiError {
                                error: "multipart 字段顺序错误：file 之前必须先发送 sessionId".into(),
                            })));
                        }
                    };
                    consume_ticket(&state, &query.ticket, TicketPurpose::Upload, sid).await?;
                    ticket_consumed = true;
                }

                let temp = std::env::temp_dir().join(format!("helm_upload_{}", uuid::Uuid::new_v4()));
                let mut file = match tokio::fs::File::create(&temp).await {
                    Ok(f) => f,
                    Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("创建临时文件失败: {}", e) }))),
                };
                temp_file_path = Some(temp);
                loop {
                    match field.chunk().await {
                        Ok(Some(chunk)) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                cleanup_temp(&temp_file_path).await;
                                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("写入临时文件失败: {}", e) })));
                            }
                            total_size = total_size.saturating_add(chunk.len() as u64);
                        }
                        Ok(None) => break,
                        Err(e) => { cleanup_temp(&temp_file_path).await; return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: format!("读取上传分片失败: {}", e) }))); }
                    }
                }
                if let Err(e) = file.flush().await { cleanup_temp(&temp_file_path).await; return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("刷写临时文件失败: {}", e) }))); }
            }
            _ => {}
        }
    }

    // 走到这里若仍未消费 ticket，说明根本没有 file 字段。返回错误前不消费票据，
    // 让客户端可以修正请求后用同一张 ticket 重试（毕竟它从未被验证过）。
    if !ticket_consumed {
        cleanup_temp(&temp_file_path).await;
        return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 file 字段".into() })));
    }

    let session_id = match session_id {
        Some(v) => v,
        None => { cleanup_temp(&temp_file_path).await; return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 sessionId 字段".into() }))); }
    };
    let remote_path = match remote_path {
        Some(v) => v,
        None => { cleanup_temp(&temp_file_path).await; return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 remotePath 字段".into() }))); }
    };
    let temp_file = match temp_file_path.clone() {
        Some(v) => v,
        None => return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 file 字段".into() }))),
    };

    let size = total_size;
    if let Err(forbidden) = verify_session_access(&state, &session_id) { cleanup_temp(&temp_file_path).await; return Err(forbidden); }

    let sftp_id = match state.remote.find_sftp_id_for_session(&session_id).await {
        Ok(v) => v,
        Err(e) => { cleanup_temp(&temp_file_path).await; return Err(map_remote_error(e, &state)); }
    };

    let start = std::time::Instant::now();
    let transfer_result = state.remote.transfer_upload(&state.app, sftp_id, temp_file.to_string_lossy().to_string(), remote_path.clone(), true, false, false).await;
    let elapsed_start = start.elapsed().as_millis() as u64;

    let transfer_info = match transfer_result {
        Ok(info) => info,
        Err(e) => {
            cleanup_temp(&temp_file_path).await;
            push_log(&state, "upload", &friendly_error_detail(&format!("{} → {}", remote_path, e), &state), false, elapsed_start).await;
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e.to_string() })));
        }
    };

    let final_info = state.remote.wait_transfer(&transfer_info.transfer_id).await;
    let elapsed = start.elapsed().as_millis() as u64;
    cleanup_temp(&temp_file_path).await;

    match final_info {
        Ok(info) if matches!(info.status, crate::remote::TaskStatus::Completed) => {
            push_log(&state, "upload", &format!("{} ({}B)", remote_path, size), true, elapsed).await;
            Ok(Json(UploadResponse { success: true, remote_path, size }))
        }
        Ok(info) => {
            let err_msg = info.error.unwrap_or_else(|| "传输失败".to_string());
            push_log(&state, "upload", &friendly_error_detail(&format!("{} → {}", remote_path, err_msg), &state), false, elapsed).await;
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: err_msg })))
        }
        Err(e) => {
            push_log(&state, "upload", &friendly_error_detail(&format!("{} → {}", remote_path, e), &state), false, elapsed).await;
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e.to_string() })))
        }
    }
}

pub async fn download_file(
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    consume_ticket(&state, &query.ticket, TicketPurpose::Download, &query.session_id).await?;
    verify_session_access(&state, &query.session_id)?;
    let start = std::time::Instant::now();

    let sftp = match state.remote.find_sftp_for_session(&query.session_id).await {
        Ok(sftp) => sftp,
        Err(e) => return Err(map_remote_error(e, &state)),
    };

    let metadata = match sftp.metadata(query.path.clone()).await {
        Ok(m) => m,
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(&state, "download", &friendly_error_detail(&format!("{} → {}", query.path, e), &state), false, elapsed).await;
            return Err((StatusCode::NOT_FOUND, Json(ApiError { error: format!("无法读取远程文件: {}", e) })));
        }
    };
    let size = metadata.len();

    let remote_file = match sftp.open(query.path.clone()).await {
        Ok(f) => f,
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(&state, "download", &friendly_error_detail(&format!("{} → {}", query.path, e), &state), false, elapsed).await;
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("打开远程文件失败: {}", e) })));
        }
    };

    let stream = ReaderStream::with_capacity(remote_file, 1024 * 1024);
    let body = Body::from_stream(stream);
    let elapsed = start.elapsed().as_millis() as u64;
    push_log(&state, "download", &format!("{} ({}B, 流式)", query.path, size), true, elapsed).await;

    let file_name = query.path.rsplit('/').next().unwrap_or("file");
    let safe_name: String = file_name.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').collect();
    let disposition = format!("attachment; filename=\"{}\"", safe_name);

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size)
        .body(body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("构建响应失败: {}", e) })))?;
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}
