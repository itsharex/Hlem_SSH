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

use super::auth::{verify_auth, verify_session_access};
use super::{friendly_error_detail, map_remote_error, push_log, ApiError, ApiServerState};

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
pub(super) struct DownloadQuery {
    session_id: String,
    path: String,
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

/// HTTP 鉴权验证端点。
pub async fn auth_check(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);
    Ok(Json(serde_json::json!({ "authenticated": true, "ws": "/api/ws" })))
}

pub async fn upload_file(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

    let mut session_id: Option<String> = None;
    let mut remote_path: Option<String> = None;
    let mut temp_file_path: Option<PathBuf> = None;
    let mut total_size: u64 = 0;

    async fn cleanup_temp(path: &Option<PathBuf>) {
        if let Some(p) = path.as_ref() { let _ = tokio::fs::remove_file(p).await; }
    }

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        (StatusCode::BAD_REQUEST, Json(ApiError { error: format!("解析 multipart 失败: {}", e) }))
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "sessionId" => { session_id = field.text().await.ok(); }
            "remotePath" => { remote_path = field.text().await.ok(); }
            "file" => {
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
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(&headers, &key)?;
    drop(key);

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
