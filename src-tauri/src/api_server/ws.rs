use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Query, State as AxumState},
    http::{HeaderMap, Response, StatusCode},
    response::IntoResponse,
};
use base64::engine::{general_purpose::STANDARD as BASE64, Engine as _};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::{
    sync::{mpsc, RwLock},
    task::JoinHandle,
};
use yawc::{
    frame::{Frame, OpCode},
    CompressionLevel, IncomingUpgrade, Options,
};

use crate::remote::ExecStreamChunk;

use super::auth::issue_ticket;
use super::guard::check_dangerous_command;
use super::{friendly_error_detail, push_log, push_log_with_response, ApiServerState, TicketPurpose, TICKET_TTL};

#[derive(Debug, Deserialize)]
pub(super) struct WsTokenQuery {
    #[serde(default)]
    token: Option<String>,
}

pub(super) async fn ws_handler(
    ws: IncomingUpgrade,
    headers: HeaderMap,
    Query(token_query): Query<WsTokenQuery>,
    AxumState(state): AxumState<ApiServerState>,
) -> Response<Body> {
    let header_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let provided = header_token.or(token_query.token).unwrap_or_default();
    let expected = state.api_key.read().await.clone();
    if provided != expected {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from("invalid api key"))
            .unwrap_or_else(|_| StatusCode::UNAUTHORIZED.into_response());
    }

    // 服务端默认开启 permessage-deflate 压缩。
    // 客户端在握手时通过 `Sec-WebSocket-Extensions: permessage-deflate` 协商；
    // 不支持的客户端会自动 fallback 到无压缩，互不影响。
    let options = Options::default().with_compression_level(CompressionLevel::best());
    let (response, fut) = match ws.upgrade(options) {
        Ok(v) => v,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("WebSocket 升级失败: {}", e)))
                .unwrap_or_else(|_| StatusCode::BAD_REQUEST.into_response());
        }
    };

    tokio::spawn(async move {
        match fut.await {
            Ok(ws) => handle_socket(ws, state).await,
            Err(_) => {}
        }
    });

    response.into_response()
}

async fn handle_socket(ws: yawc::HttpWebSocket, state: ApiServerState) {
    push_log(&state, "ws", "WebSocket 连接已建立", true, 0).await;

    let (tx, mut rx) = mpsc::channel::<Frame>(256);
    let (mut sink, mut stream) = ws.split();

    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(frame).await.is_err() {
                break;
            }
        }
        // yawc 的 sink 自带 close 语义；显式 close 通过 send 一个 close frame 实现。
        let _ = sink.send(Frame::close(yawc::close::CloseCode::Normal, b"")).await;
    });

    // 服务端心跳：每 30s 发一个 Ping 帧。客户端断网时下一次 send 失败 → writer 退出 → 整体清理。
    // yawc 自动处理 incoming Ping/Pong，所以这里只需主动发心跳。
    let heartbeat_tx = tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(30));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await; // skip first immediate tick
        loop {
            ticker.tick().await;
            if heartbeat_tx.send(Frame::ping(Bytes::new())).await.is_err() {
                break;
            }
        }
    });

    let jobs: Arc<RwLock<HashMap<String, JoinHandle<()>>>> = Arc::new(RwLock::new(HashMap::new()));

    while let Some(frame) = stream.next().await {
        match frame.opcode() {
            OpCode::Text => {
                let payload = frame.into_payload();
                let text = match std::str::from_utf8(&payload) {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = tx.send(ws_text_frame(&WsResponse::error("", "Text 帧不是合法 UTF-8"))).await;
                        continue;
                    }
                };
                let value: JsonValue = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = tx.send(ws_text_frame(&WsResponse::error("", &format!("非法 JSON: {}", e)))).await;
                        continue;
                    }
                };
                handle_request(value, tx.clone(), state.clone(), jobs.clone()).await;
            }
            OpCode::Binary => {
                let _ = tx.send(ws_text_frame(&WsResponse::error("", "暂不支持二进制请求帧，请用 JSON 文本"))).await;
            }
            // yawc 自动回 Pong；Ping/Pong 仍会传到这里供观测，无需处理。
            OpCode::Ping | OpCode::Pong => {}
            OpCode::Close => break,
            _ => {}
        }
    }

    {
        let mut jobs = jobs.write().await;
        for (_, h) in jobs.drain() { h.abort(); }
    }
    heartbeat.abort();
    drop(tx);
    let _ = writer.await;

    push_log(&state, "ws", "WebSocket 连接已关闭", true, 0).await;
}

async fn handle_request(
    value: JsonValue,
    tx: mpsc::Sender<Frame>,
    state: ApiServerState,
    jobs: Arc<RwLock<HashMap<String, JoinHandle<()>>>>,
) {
    let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let req_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();

    match req_type.as_str() {
        "ping" => {
            let _ = tx.send(ws_text_frame(&WsResponse { id, r#type: "pong".into(), payload: serde_json::json!({}) })).await;
            return;
        }
        "cancel" => {
            if let Some(handle) = jobs.write().await.remove(&id) {
                handle.abort();
                let _ = tx.send(ws_text_frame(&WsResponse { id, r#type: "cancelled".into(), payload: serde_json::json!({}) })).await;
            }
            return;
        }
        "issue-ticket" => {
            // 由 WS 签发短期一次性票据，HTTP upload/download 凭票放行。
            // 已经通过 WS 握手鉴权 → 此处不再校验 api_key。
            let purpose_str = value.get("purpose").and_then(|v| v.as_str()).unwrap_or("");
            let purpose = match TicketPurpose::parse(purpose_str) {
                Some(p) => p,
                None => {
                    let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "purpose 必须为 upload 或 download"))).await;
                    return;
                }
            };
            // sessionId 优先取请求中的；若 server 配了 allowed_session_id，
            // 自动绑定到允许的会话（防止越权）。
            let req_session = value.get("sessionId").and_then(|v| v.as_str()).map(String::from);
            let bound_session = match (&state.allowed_session_id, &req_session) {
                (Some(allowed), Some(req)) if allowed != req => {
                    let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "无权访问该会话，仅允许指定会话"))).await;
                    return;
                }
                (Some(allowed), _) => Some(allowed.clone()),
                (None, req) => req.clone(),
            };
            let bound_session_log = bound_session.clone().unwrap_or_else(|| "<any>".into());
            let ticket = issue_ticket(&state, bound_session, purpose).await;
            let _ = tx.send(ws_text_frame(&WsResponse {
                id,
                r#type: "ticket".into(),
                payload: serde_json::json!({
                    "ticket": ticket,
                    "purpose": purpose.as_str(),
                    "expiresIn": TICKET_TTL.as_secs(),
                }),
            })).await;
            push_log(&state, "ws/issue-ticket", &format!("{} → {}", purpose.as_str(), bound_session_log), true, 0).await;
            return;
        }
        _ => {}
    }

    let job_id = id.clone();
    let jobs_for_cleanup = jobs.clone();
    let tx_for_job = tx.clone();
    let state_for_job = state.clone();
    let value_for_job = value.clone();
    let req_type_for_job = req_type.clone();

    let handle = tokio::spawn(async move {
        match req_type_for_job.as_str() {
            "exec" => handle_ws_exec(value_for_job, job_id.clone(), tx_for_job, state_for_job).await,
            "list-sessions" => handle_ws_list_sessions(job_id.clone(), tx_for_job, state_for_job).await,
            "list-files" => handle_ws_list_files(value_for_job, job_id.clone(), tx_for_job, state_for_job).await,
            // 隧道管理
            "list-tunnels" | "create-tunnel" | "update-tunnel" | "delete-tunnel"
            | "start-tunnel" | "stop-tunnel" => {
                handle_ws_tunnel(req_type_for_job, value_for_job, job_id.clone(), tx_for_job, state_for_job).await
            }
            // 备份管理
            "backup-settings" | "update-backup-settings" | "backup-records"
            | "run-backup" | "delete-backup-record" => {
                handle_ws_backup(req_type_for_job, value_for_job, job_id.clone(), tx_for_job, state_for_job).await
            }
            other => { let _ = tx_for_job.send(ws_text_frame(&WsResponse::error(&job_id, &format!("未知请求类型: {}", other)))).await; }
        }
        jobs_for_cleanup.write().await.remove(&job_id);
    });

    if !id.is_empty() {
        jobs.write().await.insert(id, handle);
    }
}

async fn handle_ws_list_sessions(id: String, tx: mpsc::Sender<Frame>, state: ApiServerState) {
    let sessions = state.remote.list_connected_sessions().await;
    let count = sessions.len();
    let _ = tx.send(ws_text_frame(&WsResponse::result(&id, sessions))).await;
    push_log(&state, "ws/sessions", &format!("{} 项", count), true, 0).await;
}

async fn handle_ws_list_files(value: JsonValue, id: String, tx: mpsc::Sender<Frame>, state: ApiServerState) {
    let session_id = value.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let path = value.get("path").and_then(|v| v.as_str()).unwrap_or("/").to_string();
    if session_id.is_empty() {
        let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "缺少 sessionId"))).await;
        return;
    }
    if state.allowed_session_id.as_deref().map(|s| s != session_id.as_str()).unwrap_or(false) {
        let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "无权访问该会话，仅允许指定会话"))).await;
        return;
    }
    let start = std::time::Instant::now();
    match state.remote.api_list_files(&session_id, &path).await {
        Ok(entries) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(&state, "ws/files", &format!("{} ({} 项)", path, entries.len()), true, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::result(&id, entries))).await;
        }
        Err(e) => {
            let elapsed = start.elapsed().as_millis() as u64;
            push_log(&state, "ws/files", &friendly_error_detail(&format!("{} → {}", path, e), &state), false, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::error(&id, &e))).await;
        }
    }
}

async fn handle_ws_exec(value: JsonValue, id: String, tx: mpsc::Sender<Frame>, state: ApiServerState) {
    let session_id = value.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let command = value.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let timeout_ms = value.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(30_000);
    let binary = value.get("binary").and_then(|v| v.as_bool()).unwrap_or(false);

    if session_id.is_empty() || command.is_empty() {
        let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "缺少 sessionId 或 command"))).await;
        return;
    }
    if let Some(reason) = check_dangerous_command(&command) {
        let _ = tx.send(ws_text_frame(&WsResponse::error(&id, &format!("命令被拒绝: {}", reason)))).await;
        return;
    }
    if state.allowed_session_id.as_deref().map(|s| s != session_id.as_str()).unwrap_or(false) {
        let _ = tx.send(ws_text_frame(&WsResponse::error(&id, "无权访问该会话，仅允许指定会话"))).await;
        return;
    }

    let (chunk_tx, mut chunk_rx) = mpsc::channel::<ExecStreamChunk>(256);
    let id_for_pump = id.clone();
    let tx_for_pump = tx.clone();
    // 收集 stdout/stderr 用于日志 response 字段（最多 2000 字符）。
    // binary=true 时仍按 base64 压成短预览（避免日志里塞二进制）。
    let collected = Arc::new(RwLock::new(String::new()));
    let collected_for_pump = collected.clone();
    let pump = tokio::spawn(async move {
        while let Some(chunk) = chunk_rx.recv().await {
            let (frame_type_byte, frame_type_str, bytes) = match chunk {
                ExecStreamChunk::Stdout(b) => (0u8, "stdout", b),
                ExecStreamChunk::Stderr(b) => (1u8, "stderr", b),
            };

            // 累积日志预览（限制 2000 字符）
            {
                let preview = if binary {
                    BASE64.encode(&bytes)
                } else {
                    String::from_utf8_lossy(&bytes).into_owned()
                };
                let mut buf = collected_for_pump.write().await;
                if buf.len() < 2000 {
                    let remaining = 2000 - buf.len();
                    if preview.len() <= remaining {
                        buf.push_str(&preview);
                    } else {
                        buf.push_str(&preview[..remaining]);
                    }
                }
            }

            let send_result = if binary {
                // 二进制帧格式：[1 byte type=0/1][1 byte id_len][id ascii][payload]
                // 客户端看到 WebSocket Binary frame → 切帧头取 id/type → 直接拿 payload 二进制原文。
                // 比 base64-in-JSON-Text 省 33% 体积 + 双方 base64 编解码 CPU。
                let id_bytes = id_for_pump.as_bytes();
                if id_bytes.len() > 255 {
                    // id 不会这么长，但 defensive cap
                    let _ = tx_for_pump.send(ws_text_frame(&WsResponse::error(&id_for_pump, "id 过长，无法用 binary frame 编码"))).await;
                    continue;
                }
                let mut frame = Vec::with_capacity(2 + id_bytes.len() + bytes.len());
                frame.push(frame_type_byte);
                frame.push(id_bytes.len() as u8);
                frame.extend_from_slice(id_bytes);
                frame.extend_from_slice(&bytes);
                tx_for_pump.send(Frame::binary(Bytes::from(frame))).await
            } else {
                let data_str = String::from_utf8_lossy(&bytes).into_owned();
                let frame = WsResponse {
                    id: id_for_pump.clone(),
                    r#type: frame_type_str.into(),
                    payload: serde_json::json!({ "data": data_str, "binary": false }),
                };
                tx_for_pump.send(ws_text_frame(&frame)).await
            };
            if send_result.is_err() { break; }
        }
    });

    let started = std::time::Instant::now();
    let detail = if command.len() > 80 { format!("{}...", &command[..77]) } else { command.clone() };
    let result = state.remote.api_exec_stream(&session_id, command.clone(), timeout_ms, chunk_tx).await;
    let elapsed = started.elapsed().as_millis() as u64;
    let _ = pump.await;

    let response_text = {
        let buf = collected.read().await;
        if buf.is_empty() { None } else { Some(buf.clone()) }
    };

    match result {
        Ok(summary) => {
            push_log_with_response(&state, "ws/exec", &detail, !summary.timed_out && summary.exit_status.unwrap_or(1) == 0, elapsed, response_text).await;
            let _ = tx.send(ws_text_frame(&WsResponse { id, r#type: "done".into(), payload: serde_json::json!({ "exitCode": summary.exit_status.unwrap_or(1), "timedOut": summary.timed_out, "durationMs": summary.duration_ms, "binary": binary }) })).await;
        }
        Err(e) => {
            push_log(&state, "ws/exec", &friendly_error_detail(&format!("{} → {}", command, e), &state), false, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::error(&id, &e))).await;
        }
    }
}

async fn handle_ws_tunnel(action: String, value: JsonValue, id: String, tx: mpsc::Sender<Frame>, state: ApiServerState) {
    let start = std::time::Instant::now();
    let result: Result<JsonValue, String> = async {
        match action.as_str() {
            "list-tunnels" => {
                let store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let t = store.tunnels().map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(t).unwrap_or_default())
            }
            "create-tunnel" => {
                let input: crate::config::TunnelInput = serde_json::from_value(value.get("input").cloned().unwrap_or_default()).map_err(|e| format!("参数错误: {}", e))?;
                let mut store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.create_tunnel(input).map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(snap.data.tunnels).unwrap_or_default())
            }
            "update-tunnel" => {
                let tunnel_id = value.get("tunnelId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let input: crate::config::TunnelInput = serde_json::from_value(value.get("input").cloned().unwrap_or_default()).map_err(|e| format!("参数错误: {}", e))?;
                let mut store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.update_tunnel(&tunnel_id, input).map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(snap.data.tunnels).unwrap_or_default())
            }
            "delete-tunnel" => {
                let tunnel_id = value.get("tunnelId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.delete_tunnel(&tunnel_id).map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(snap.data.tunnels).unwrap_or_default())
            }
            "start-tunnel" => {
                let tunnel_id = value.get("tunnelId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let tunnel = {
                    let store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                    let tunnels = store.tunnels().map_err(|e| e.to_string())?;
                    tunnels.into_iter().find(|t| t.id == tunnel_id).ok_or_else(|| format!("隧道 {} 不存在", tunnel_id))?
                };
                let (bind_host, bind_port, forward_id) = state.remote.api_start_tunnel(&tunnel).await?;
                Ok(serde_json::json!({ "forwardId": forward_id, "bindHost": bind_host, "bindPort": bind_port }))
            }
            "stop-tunnel" => {
                let tunnel_id = value.get("tunnelId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                state.remote.api_stop_tunnel(&tunnel_id).await?;
                Ok(serde_json::json!({ "success": true }))
            }
            _ => Err(format!("未知隧道操作: {}", action)),
        }
    }.await;
    let elapsed = start.elapsed().as_millis() as u64;
    match result {
        Ok(data) => {
            push_log(&state, &format!("ws/{}", action), "OK", true, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::result(&id, data))).await;
        }
        Err(e) => {
            push_log(&state, &format!("ws/{}", action), &e, false, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::error(&id, &e))).await;
        }
    }
}

async fn handle_ws_backup(action: String, value: JsonValue, id: String, tx: mpsc::Sender<Frame>, state: ApiServerState) {
    let start = std::time::Instant::now();
    let result: Result<JsonValue, String> = async {
        match action.as_str() {
            "backup-settings" => {
                let store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.snapshot().map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(snap.data.settings.backup).unwrap_or_default())
            }
            "update-backup-settings" => {
                let backup: crate::config::BackupSettings = serde_json::from_value(value.get("settings").cloned().unwrap_or_default()).map_err(|e| format!("参数错误: {}", e))?;
                let mut store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.snapshot().map_err(|e| e.to_string())?;
                let mut settings = snap.data.settings.clone();
                settings.backup = backup.clone();
                store.settings_update(settings).map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(backup).unwrap_or_default())
            }
            "backup-records" => {
                let store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                let snap = store.snapshot().map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(snap.data.backup_records).unwrap_or_default())
            }
            "run-backup" => {
                let (settings, vault_path, file_name) = {
                    let store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                    store.ensure_unlocked().map_err(|e| e.to_string())?;
                    let snap = store.snapshot().map_err(|e| e.to_string())?;
                    (snap.data.settings.backup, store.vault_file_path(), crate::backup::backup_file_name())
                };
                let bytes = tokio::fs::read(&vault_path).await.map_err(|e| e.to_string())?;
                let package = crate::backup::build_backup_package(bytes).await.map_err(|e| e.to_string())?;
                let size = package.len() as u64;
                let has_local = settings.local_directory.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false);
                if !has_local && !settings.cloud.enabled {
                    return Err("请先配置本地备份目录或启用云端备份".to_string());
                }
                let mut outcomes = Vec::new();
                if has_local {
                    let dir = std::path::PathBuf::from(settings.local_directory.as_deref().unwrap().trim());
                    let target = dir.join(&file_name);
                    match async { tokio::fs::create_dir_all(&dir).await?; tokio::fs::write(&target, &package).await?; Ok::<(), std::io::Error>(()) }.await {
                        Ok(()) => outcomes.push(crate::config::BackupRecord::success(file_name.clone(), "local", target.to_string_lossy().to_string(), size)),
                        Err(e) => outcomes.push(crate::config::BackupRecord::failed(file_name.clone(), "local", target.to_string_lossy().to_string(), e.to_string())),
                    }
                }
                Ok(serde_json::to_value(outcomes).unwrap_or_default())
            }
            "delete-backup-record" => {
                let record_id = value.get("recordId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let delete_file = value.get("deleteFile").and_then(|v| v.as_bool()).unwrap_or(false);
                let (snap, delete_path) = {
                    let mut store = state.vault.lock().map_err(|_| "内部锁错误".to_string())?;
                    store.delete_backup_record(&record_id, delete_file).map_err(|e| e.to_string())?
                };
                if let Some(path) = delete_path { let _ = tokio::fs::remove_file(path).await; }
                Ok(serde_json::to_value(snap.data.backup_records).unwrap_or_default())
            }
            _ => Err(format!("未知备份操作: {}", action)),
        }
    }.await;
    let elapsed = start.elapsed().as_millis() as u64;
    match result {
        Ok(data) => {
            push_log(&state, &format!("ws/{}", action), "OK", true, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::result(&id, data))).await;
        }
        Err(e) => {
            push_log(&state, &format!("ws/{}", action), &e, false, elapsed).await;
            let _ = tx.send(ws_text_frame(&WsResponse::error(&id, &e))).await;
        }
    }
}

fn ws_text_frame<T: Serialize>(value: &T) -> Frame {
    Frame::text(Bytes::from(serde_json::to_string(value).unwrap_or_else(|_| "{\"type\":\"error\",\"error\":\"内部序列化失败\"}".into())))
}

#[derive(Serialize)]
struct WsResponse {
    #[serde(skip_serializing_if = "String::is_empty")]
    id: String,
    r#type: String,
    #[serde(flatten)]
    payload: JsonValue,
}

impl WsResponse {
    fn error(id: &str, msg: &str) -> Self {
        Self { id: id.into(), r#type: "error".into(), payload: serde_json::json!({ "error": msg }) }
    }
    fn result<T: Serialize>(id: &str, data: T) -> Self {
        Self { id: id.into(), r#type: "result".into(), payload: serde_json::json!({ "data": data }) }
    }
}
