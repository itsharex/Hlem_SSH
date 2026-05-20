use std::time::Instant;

use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use uuid::Uuid;

use super::{ApiError, ApiServerState, TicketEntry, TicketPurpose, TICKET_TTL};

pub(super) fn verify_auth(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
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

pub(super) fn verify_session_access(state: &ApiServerState, session_id: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
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

/// 生成一个不可预测的 ticket（拼接两个 v4 UUID，~244 bits 随机度）。
pub(super) fn generate_ticket() -> String {
    format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

/// 在 state 中插入一张新 ticket，返回字符串值。
pub(super) async fn issue_ticket(
    state: &ApiServerState,
    session_id: Option<String>,
    purpose: TicketPurpose,
) -> String {
    let ticket = generate_ticket();
    let entry = TicketEntry {
        session_id,
        purpose,
        expires_at: Instant::now() + TICKET_TTL,
    };
    state.tickets.write().await.insert(ticket.clone(), entry);
    ticket
}

/// 校验并消费 ticket（一次性使用：消费即移除）。
///
/// 返回 Err 时 ticket 已被移除——这意味着哪怕请求中途失败，
/// 同一张 ticket 也无法重放。
///
/// 校验顺序：
/// 1. ticket 非空且存在
/// 2. 未过期
/// 3. 用途与请求一致（防止 upload ticket 被用于 download）
/// 4. 若 ticket 绑定了 session_id，必须与请求的 session_id 一致
pub(super) async fn consume_ticket(
    state: &ApiServerState,
    ticket: &str,
    expected_purpose: TicketPurpose,
    expected_session: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if ticket.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "缺少 ticket（请先通过 WS 的 issue-ticket 请求获取）".into(),
            }),
        ));
    }
    let entry = state.tickets.write().await.remove(ticket);
    let entry = match entry {
        Some(e) => e,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(ApiError {
                    error: "ticket 无效或已使用".into(),
                }),
            ));
        }
    };
    if Instant::now() > entry.expires_at {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 已过期，请重新签发".into(),
            }),
        ));
    }
    if entry.purpose != expected_purpose {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!(
                    "ticket 用途不匹配：签发为 {}，请求为 {}",
                    entry.purpose.as_str(),
                    expected_purpose.as_str()
                ),
            }),
        ));
    }
    if let Some(bound) = &entry.session_id {
        if bound != expected_session {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: "ticket 绑定的会话与请求不一致".into(),
                }),
            ));
        }
    }
    Ok(())
}
