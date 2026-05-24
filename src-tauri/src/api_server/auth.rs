//! HMAC-签名的无状态一次性票据。
//!
//! 协议：
//!   ticket = base64url(payload_json) + "." + base64url(hmac_sha256(api_key, payload_json))
//!   payload_json = {"p":"upload"|"download","s":"<sessionId>"|null,"e":<unix_sec>,"n":"<nonce>"}
//!
//! 签发完全无状态：服务端不保存任何已签发但未消费的 ticket，
//! 客户端拿到 token 即可在 60s 内自由使用。
//!
//! 一次性 = 维护一个"已消费 nonce"集合，配合 60s TTL 自动过期。
//! 这个集合远比"已签发 ticket"集合小：只装真正用过的 nonce，
//! 而不是每次 issue 都 +1。
//!
//! api_key 重新生成 → 所有未过期 ticket 一并失效（HMAC 验签失败）。

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use base64::engine::{general_purpose::URL_SAFE_NO_PAD as BASE64URL, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::{ApiError, ApiServerState, TicketPurpose, TICKET_TTL};

type HmacSha256 = Hmac<Sha256>;

/// payload 的 JSON 表示，字段名缩短以减小 token 体积。
#[derive(Serialize, Deserialize)]
struct TicketPayload {
    /// purpose: "upload" | "download"
    p: String,
    /// 绑定的 sessionId（None = 任意）
    #[serde(skip_serializing_if = "Option::is_none")]
    s: Option<String>,
    /// expires_at as unix seconds
    e: u64,
    /// 16 字节随机 nonce 的 hex 表示，用作 jti 防重放
    n: String,
}

pub(super) fn verify_auth(
    headers: &HeaderMap,
    expected: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
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

pub(super) fn verify_session_access(
    state: &ApiServerState,
    session_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
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

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_nonce() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn hmac_sign(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC key length is always valid for SHA256");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// 签发一张 HMAC token。无服务端状态。
pub(super) async fn issue_ticket(
    state: &ApiServerState,
    session_id: Option<String>,
    purpose: TicketPurpose,
) -> String {
    let payload = TicketPayload {
        p: purpose.as_str().to_string(),
        s: session_id,
        e: now_unix() + TICKET_TTL.as_secs(),
        n: random_nonce(),
    };
    let payload_json = serde_json::to_string(&payload)
        .expect("TicketPayload always serializes to JSON");
    let api_key = state.api_key.read().await.clone();
    let sig = hmac_sign(api_key.as_bytes(), payload_json.as_bytes());
    format!(
        "{}.{}",
        BASE64URL.encode(payload_json.as_bytes()),
        BASE64URL.encode(sig)
    )
}

/// 校验并消费 ticket（一次性使用）。
///
/// 校验顺序：
/// 1. ticket 非空且格式正确（包含一个点分隔符）
/// 2. base64url 可解码
/// 3. HMAC 签名匹配（恒定时间比较，由 hmac crate 保证）
/// 4. payload 可反序列化
/// 5. 未过期
/// 6. 用途匹配
/// 7. 若绑定了 session，必须匹配
/// 8. nonce 未被消费过 → 加入已消费集合
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

    let (payload_b64, sig_b64) = ticket.split_once('.').ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 格式错误".into(),
            }),
        )
    })?;

    let payload_bytes = BASE64URL.decode(payload_b64).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 编码错误".into(),
            }),
        )
    })?;
    let sig_bytes = BASE64URL.decode(sig_b64).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 编码错误".into(),
            }),
        )
    })?;

    // HMAC verify (恒定时间)
    let api_key = state.api_key.read().await.clone();
    let mut mac = HmacSha256::new_from_slice(api_key.as_bytes())
        .expect("HMAC key length is always valid for SHA256");
    mac.update(&payload_bytes);
    if mac.verify_slice(&sig_bytes).is_err() {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 签名无效（可能已轮换 API Key）".into(),
            }),
        ));
    }

    let payload: TicketPayload = serde_json::from_slice(&payload_bytes).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 内容损坏".into(),
            }),
        )
    })?;

    if now_unix() > payload.e {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 已过期，请重新签发".into(),
            }),
        ));
    }

    let purpose = TicketPurpose::parse(&payload.p).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 用途字段非法".into(),
            }),
        )
    })?;
    if purpose != expected_purpose {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!(
                    "ticket 用途不匹配：签发为 {}，请求为 {}",
                    purpose.as_str(),
                    expected_purpose.as_str()
                ),
            }),
        ));
    }

    if let Some(bound) = &payload.s {
        if bound != expected_session {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: "ticket 绑定的会话与请求不一致".into(),
                }),
            ));
        }
    }

    // 一次性：原子地检查 + 插入 nonce。
    // 注意持有 write lock 期间完成 contains/insert 的临界区，避免并发请求双重消费。
    let expires_at = std::time::Instant::now()
        + std::time::Duration::from_secs(payload.e.saturating_sub(now_unix()));
    let mut consumed = state.consumed_nonces.write().await;
    if consumed.contains_key(&payload.n) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "ticket 已使用".into(),
            }),
        ));
    }
    consumed.insert(payload.n, expires_at);
    Ok(())
}
