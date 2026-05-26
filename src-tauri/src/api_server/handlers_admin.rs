//! Tunnel 与 Backup 的 REST 端点。
//!
//! 这些命令本质上都是 vault CRUD（list / create / update / delete / start / stop /
//! get / put settings / run），不需要流式传输，REST 比 WS 更直白。

use axum::{
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;

use super::auth::verify_auth;
use super::{push_log, ApiError, ApiServerState};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async fn require_auth(state: &ApiServerState, headers: &HeaderMap) -> Result<(), (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(headers, &key)
}

fn map_err_500(e: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() }),
    )
}

fn lock_poisoned() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: "内部锁错误".into() }),
    )
}

// ─── Tunnels ───────────────────────────────────────────────────────────────────

/// `GET /api/tunnels` — 列出全部隧道配置。
pub async fn rest_tunnels_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let tunnels = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.tunnels().map_err(map_err_500)?
    };
    let count = tunnels.len();
    push_log(&state, "rest/tunnels.list", &format!("{} 项", count), true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(tunnels).unwrap_or_default()))
}

/// `POST /api/tunnels` body: TunnelInput → 创建后返回隧道数组。
pub async fn rest_tunnels_create(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(input): Json<crate::config::TunnelInput>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.create_tunnel(input).map_err(map_err_500)?
    };
    push_log(&state, "rest/tunnels.create", "OK", true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(snapshot.data.tunnels).unwrap_or_default()))
}

/// `PATCH /api/tunnels/:tunnelId` body: TunnelInput → 更新后返回隧道数组。
pub async fn rest_tunnels_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
    Json(input): Json<crate::config::TunnelInput>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.update_tunnel(&tunnel_id, input).map_err(map_err_500)?
    };
    push_log(&state, "rest/tunnels.update", &tunnel_id, true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(snapshot.data.tunnels).unwrap_or_default()))
}

/// `DELETE /api/tunnels/:tunnelId` → 删除后返回隧道数组。
pub async fn rest_tunnels_delete(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.delete_tunnel(&tunnel_id).map_err(map_err_500)?
    };
    push_log(&state, "rest/tunnels.delete", &tunnel_id, true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(snapshot.data.tunnels).unwrap_or_default()))
}

/// `POST /api/tunnels/:tunnelId/start` → `{forwardId, bindHost, bindPort}`。
pub async fn rest_tunnels_start(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let tunnel = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnels = store.tunnels().map_err(map_err_500)?;
        tunnels
            .into_iter()
            .find(|t| t.id == tunnel_id)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ApiError { error: format!("隧道 {} 不存在", tunnel_id) }),
                )
            })?
    };
    let (bind_host, bind_port, forward_id) = state
        .remote
        .api_start_tunnel(&tunnel)
        .await
        .map_err(map_err_500)?;
    push_log(&state, "rest/tunnels.start", &tunnel_id, true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::json!({
        "forwardId": forward_id,
        "bindHost": bind_host,
        "bindPort": bind_port,
    })))
}

/// `POST /api/tunnels/:tunnelId/stop` → `{success:true}`。
pub async fn rest_tunnels_stop(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    state
        .remote
        .api_stop_tunnel(&tunnel_id)
        .await
        .map_err(map_err_500)?;
    push_log(&state, "rest/tunnels.stop", &tunnel_id, true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ─── Backup ────────────────────────────────────────────────────────────────────

/// `GET /api/backup/settings` → 备份设置。
pub async fn rest_backup_settings_get(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let store = state.vault.lock().map_err(|_| lock_poisoned())?;
    let snap = store.snapshot().map_err(map_err_500)?;
    Ok(Json(serde_json::to_value(snap.data.settings.backup).unwrap_or_default()))
}

/// `PUT /api/backup/settings` body: BackupSettings → 写入后返回备份设置。
pub async fn rest_backup_settings_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(backup): Json<crate::config::BackupSettings>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let snap = store.snapshot().map_err(map_err_500)?;
        let mut settings = snap.data.settings.clone();
        settings.backup = backup.clone();
        store.settings_update(settings).map_err(map_err_500)?;
    }
    push_log(&state, "rest/backup.settings.update", "OK", true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(backup).unwrap_or_default()))
}

/// `GET /api/backup/records` → 备份记录数组。
pub async fn rest_backup_records_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let store = state.vault.lock().map_err(|_| lock_poisoned())?;
    let snap = store.snapshot().map_err(map_err_500)?;
    Ok(Json(serde_json::to_value(snap.data.backup_records).unwrap_or_default()))
}

/// `POST /api/backup/run` → 立即执行一次备份并返回本次结果数组。
///
/// 写入到本地目录与配置的云端目标。要求至少配置一种。
pub async fn rest_backup_run(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();

    let (settings, vault_path, file_name) = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.ensure_unlocked().map_err(map_err_500)?;
        let snap = store.snapshot().map_err(map_err_500)?;
        (
            snap.data.settings.backup,
            store.vault_file_path(),
            crate::backup::backup_file_name(),
        )
    };
    let bytes = tokio::fs::read(&vault_path).await.map_err(map_err_500)?;
    let package = crate::backup::build_backup_package(bytes).await.map_err(map_err_500)?;
    let size = package.len() as u64;
    let has_local = settings
        .local_directory
        .as_deref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !has_local && !settings.cloud.enabled {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "请先配置本地备份目录或启用云端备份".into(),
            }),
        ));
    }
    let mut outcomes = Vec::new();
    if has_local {
        let dir = std::path::PathBuf::from(settings.local_directory.as_deref().unwrap().trim());
        let target = dir.join(&file_name);
        let write_result = async {
            tokio::fs::create_dir_all(&dir).await?;
            tokio::fs::write(&target, &package).await?;
            Ok::<(), std::io::Error>(())
        }
        .await;
        match write_result {
            Ok(()) => outcomes.push(crate::config::BackupRecord::success(
                file_name.clone(),
                "local",
                target.to_string_lossy().to_string(),
                size,
            )),
            Err(e) => outcomes.push(crate::config::BackupRecord::failed(
                file_name.clone(),
                "local",
                target.to_string_lossy().to_string(),
                e.to_string(),
            )),
        }
    }
    push_log(&state, "rest/backup.run", "OK", true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(outcomes).unwrap_or_default()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeleteRecordQuery {
    #[serde(default)]
    delete_file: bool,
}

/// `DELETE /api/backup/records/:recordId?deleteFile=true` → 删除后返回剩余记录数组。
pub async fn rest_backup_record_delete(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(record_id): Path<String>,
    Query(query): Query<DeleteRecordQuery>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let (snap, delete_path) = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store
            .delete_backup_record(&record_id, query.delete_file)
            .map_err(map_err_500)?
    };
    if let Some(path) = delete_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    push_log(&state, "rest/backup.record.delete", &record_id, true, start.elapsed().as_millis() as u64).await;
    Ok(Json(serde_json::to_value(snap.data.backup_records).unwrap_or_default()))
}
