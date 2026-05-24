use std::ops::Bound;

use axum::{
    body::Body,
    extract::{Query, State as AxumState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Json, Response},
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::{ReaderStream, StreamReader};

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

/// raw PUT 上传 query。Content-Range 头可选，用于并发分块。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadRawQuery {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    remote_path: String,
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
        "uploadFlow": "ws issue-ticket(purpose=upload) → PUT /api/upload?ticket=...&sessionId=...&remotePath=... ；可选 Content-Range 实现并发分块",
        "downloadFlow": "ws issue-ticket(purpose=download) → GET /api/download?ticket=...&sessionId=...&path= (支持 Range)",
    })))
}

/// raw PUT 上传：流式直写 SFTP，零 temp 文件。
pub async fn upload_file_raw(
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<UploadRawQuery>,
    body: Body,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    if query.session_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 sessionId 查询参数".into() })));
    }
    if query.remote_path.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "缺少 remotePath 查询参数".into() })));
    }

    consume_ticket(&state, &query.ticket, TicketPurpose::Upload, &query.session_id).await?;
    verify_session_access(&state, &query.session_id)?;

    let start = std::time::Instant::now();

    let stream = body
        .into_data_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let mut reader = StreamReader::new(stream);

    let bytes_written = match state
        .remote
        .api_upload_stream(&query.session_id, &query.remote_path, &mut reader)
        .await
    {
        Ok(n) => n,
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", query.remote_path, e), &state),
                false,
                elapsed,
            )
            .await;
            return Err(map_remote_error(e, &state));
        }
    };

    let elapsed = start.elapsed().as_millis() as u64;
    push_log(
        &state,
        "upload",
        &format!("{} ({}B, raw)", query.remote_path, bytes_written),
        true,
        elapsed,
    )
    .await;

    Ok(Json(UploadResponse {
        success: true,
        remote_path: query.remote_path,
        size: bytes_written,
    }))
}

/// 下载：支持 Range 请求 → 206 Partial Content + Content-Range + Accept-Ranges。
pub async fn download_file(
    headers: HeaderMap,
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
    let total_size = metadata.len();

    let range = parse_range_header(headers.get(header::RANGE), total_size);
    let (status, start_offset, end_offset) = match range {
        ParsedRange::Full => (StatusCode::OK, 0u64, total_size.saturating_sub(1)),
        ParsedRange::Satisfiable { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
        ParsedRange::Unsatisfiable => {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                Json(ApiError { error: format!("Range 越界：文件大小 {} 字节", total_size) }),
            ));
        }
        ParsedRange::Invalid => (StatusCode::OK, 0u64, total_size.saturating_sub(1)),
    };
    let send_len = if total_size == 0 { 0 } else { end_offset - start_offset + 1 };

    // 大段范围（≥ 32MB）走并行多 File handle，撬开 russh-sftp 单 File 串行 read 的瓶颈。
    // 与 UI 拖拽下载共用同一套阈值 / 并发度 / 缓冲常量。
    let body = if send_len >= crate::remote::PARALLEL_DOWNLOAD_THRESHOLD
        && crate::remote::PARALLEL_DOWNLOAD_PARTS >= 2
    {
        match state
            .remote
            .parallel_download_stream(
                &query.session_id,
                query.path.clone(),
                start_offset,
                send_len,
                crate::remote::PARALLEL_DOWNLOAD_PARTS,
                crate::remote::TRANSFER_BUFFER_BYTES,
            )
            .await
        {
            Ok(stream) => Body::from_stream(stream),
            Err(e) => {
                let elapsed = start.elapsed().as_millis() as u64;
                push_log(
                    &state,
                    "download",
                    &friendly_error_detail(
                        &format!("{} → 并行下载初始化失败: {}", query.path, e),
                        &state,
                    ),
                    false,
                    elapsed,
                )
                .await;
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("并行下载初始化失败: {}", e),
                    }),
                ));
            }
        }
    } else {
        let mut remote_file = match sftp.open(query.path.clone()).await {
            Ok(f) => f,
            Err(e) => {
                let elapsed = start.elapsed().as_millis() as u64;
                push_log(&state, "download", &friendly_error_detail(&format!("{} → {}", query.path, e), &state), false, elapsed).await;
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("打开远程文件失败: {}", e) })));
            }
        };

        if start_offset > 0 {
            if let Err(e) = remote_file.seek(std::io::SeekFrom::Start(start_offset)).await {
                let elapsed = start.elapsed().as_millis() as u64;
                push_log(&state, "download", &friendly_error_detail(&format!("{} → seek {}: {}", query.path, start_offset, e), &state), false, elapsed).await;
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("seek 远程文件失败: {}", e) })));
            }
        }

        let limited = remote_file.take(send_len);
        let stream = ReaderStream::with_capacity(limited, 1024 * 1024);
        Body::from_stream(stream)
    };

    let elapsed = start.elapsed().as_millis() as u64;
    let parallel_used = send_len >= crate::remote::PARALLEL_DOWNLOAD_THRESHOLD
        && crate::remote::PARALLEL_DOWNLOAD_PARTS >= 2;
    let log_detail = if status == StatusCode::PARTIAL_CONTENT {
        format!(
            "{} ({}B, range {}-{}/{}{})",
            query.path,
            send_len,
            start_offset,
            end_offset,
            total_size,
            if parallel_used { ", 并行" } else { "" }
        )
    } else if parallel_used {
        format!("{} ({}B, 并行流式)", query.path, send_len)
    } else {
        format!("{} ({}B, 流式)", query.path, send_len)
    };
    push_log(&state, "download", &log_detail, true, elapsed).await;

    let file_name = query.path.rsplit('/').next().unwrap_or("file");
    let safe_name: String = file_name.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').collect();
    let disposition = format!("attachment; filename=\"{}\"", safe_name);

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, send_len);
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start_offset, end_offset, total_size),
        );
    }
    let mut response = builder.body(body).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("构建响应失败: {}", e) }))
    })?;
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

// ─── Range / Content-Range parsing ────────────────────────────────────────────

enum ParsedRange {
    Full,
    Satisfiable { start: u64, end: u64 },
    Unsatisfiable,
    Invalid,
}

fn parse_range_header(header_value: Option<&HeaderValue>, total: u64) -> ParsedRange {
    let Some(raw) = header_value.and_then(|v| v.to_str().ok()) else {
        return ParsedRange::Full;
    };
    let raw = raw.trim();
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return ParsedRange::Invalid;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let (start_s, end_s) = match first.split_once('-') {
        Some(parts) => parts,
        None => return ParsedRange::Invalid,
    };

    if total == 0 {
        return ParsedRange::Unsatisfiable;
    }

    let (start, end) = if start_s.is_empty() {
        let suffix: u64 = match end_s.parse() {
            Ok(v) if v > 0 => v,
            _ => return ParsedRange::Invalid,
        };
        let len = suffix.min(total);
        let start = total - len;
        let end = total - 1;
        (Bound::Included(start), Bound::Included(end))
    } else {
        let start: u64 = match start_s.parse() {
            Ok(v) => v,
            Err(_) => return ParsedRange::Invalid,
        };
        let end: u64 = if end_s.is_empty() {
            total - 1
        } else {
            match end_s.parse::<u64>() {
                Ok(v) => v.min(total - 1),
                Err(_) => return ParsedRange::Invalid,
            }
        };
        (Bound::Included(start), Bound::Included(end))
    };

    let (Bound::Included(start), Bound::Included(end)) = (start, end) else {
        return ParsedRange::Invalid;
    };
    if start >= total || end < start {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Satisfiable { start, end }
}
