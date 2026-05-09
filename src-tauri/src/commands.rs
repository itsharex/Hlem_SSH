use std::{env, path::PathBuf, sync::Mutex};

use tauri::{AppHandle, Manager, State};

use crate::{
    backup::{
        backup_file_name, build_backup_package, download_cloud_backup,
        list_configured_backup_records, upload_cloud_backup,
    },
    config::{
        AppSettings, BackupRecord, ConfigSnapshot, GroupInput, KnownHostEntry, SessionConfig,
        SessionInput, SshProxyOptions, TunnelConfig, TunnelInput,
    },
    errors::{AppError, AppResult},
    remote::{
        ConnectionInfo, ExecResult, ForwardInfo, RemoteFileEntry, RemoteRuntime, ServerTelemetry,
        SftpInfo, TelemetryJobInfo, TerminalInfo, TransferInfo,
    },
    vault::{VaultStatus, VaultStore, VAULT_FILE_NAME},
};

const VAULT_PATH_ENV: &str = "HELM_VAULT_PATH";
const PROXY_KIND_DIRECT: &str = "direct";

pub struct AppState {
    vault: Mutex<VaultStore>,
    remote: RemoteRuntime,
}

impl AppState {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault: Mutex::new(VaultStore::new(vault_path)),
            remote: RemoteRuntime::default(),
        }
    }

    fn ensure_vault_unlocked(&self) -> AppResult<()> {
        let store = self.vault.lock().map_err(lock_poisoned)?;
        store.ensure_unlocked()
    }
}

pub fn resolve_vault_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if let Ok(path) = env::var(VAULT_PATH_ENV) {
        return Ok(PathBuf::from(path));
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::Io(error.to_string()))?;
    Ok(config_dir.join(VAULT_FILE_NAME))
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    with_store(&state, |store| Ok(store.status()))
}

#[tauri::command]
pub fn vault_create(
    state: State<'_, AppState>,
    master_password: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create(&master_password))
}

#[tauri::command]
pub fn vault_unlock(
    state: State<'_, AppState>,
    master_password: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.unlock(&master_password))
}

#[tauri::command]
pub async fn vault_lock(app: AppHandle, state: State<'_, AppState>) -> AppResult<VaultStatus> {
    state.remote.shutdown_all(&app).await;
    with_store(&state, |store| Ok(store.lock()))
}

#[tauri::command]
pub fn vault_change_master_password(
    state: State<'_, AppState>,
    current_password: String,
    new_password: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| {
        store.change_master_password(&current_password, &new_password)
    })
}

#[tauri::command]
pub fn config_snapshot(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.snapshot())
}

#[tauri::command]
pub fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.settings_update(settings))
}

#[tauri::command]
pub fn tunnel_create(state: State<'_, AppState>, input: TunnelInput) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_tunnel(input))
}

#[tauri::command]
pub fn tunnel_update(
    state: State<'_, AppState>,
    tunnel_id: String,
    input: TunnelInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_tunnel(&tunnel_id, input))
}

#[tauri::command]
pub fn tunnel_delete(state: State<'_, AppState>, tunnel_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_tunnel(&tunnel_id))
}

#[tauri::command]
pub fn tunnel_list(state: State<'_, AppState>) -> AppResult<Vec<TunnelConfig>> {
    with_store(&state, |store| store.tunnels())
}

#[tauri::command]
pub async fn vault_backup_export(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let vault_path = with_store(&state, |store| {
        store.ensure_unlocked()?;
        Ok(store.vault_file_path())
    })?;
    let bytes = tokio::fs::read(&vault_path)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, package).await?;
    Ok(())
}

#[tauri::command]
pub async fn vault_backup_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<ConfigSnapshot> {
    let path = PathBuf::from(path);
    with_store(&state, |store| store.validate_backup(&path))?;
    state.remote.shutdown_all(&app).await;
    with_store(&state, |store| store.backup_import(&path))
}

#[tauri::command]
pub async fn backup_run_now(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let (settings, vault_path, file_name) = with_store(&state, |store| {
        store.ensure_unlocked()?;
        Ok((
            store.snapshot()?.data.settings.backup,
            store.vault_file_path(),
            backup_file_name(),
        ))
    })?;
    let bytes = tokio::fs::read(&vault_path)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let size = package.len() as u64;
    let mut backup_outcomes = Vec::new();
    let has_local = settings
        .local_directory
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    if has_local && !settings.cloud.enabled {
        let directory = PathBuf::from(settings.local_directory.as_deref().unwrap().trim());
        let target = directory.join(&file_name);
        match async {
            tokio::fs::create_dir_all(&directory).await?;
            tokio::fs::write(&target, &package).await?;
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            Ok(()) => backup_outcomes.push(BackupRecord::success(
                file_name.clone(),
                "local",
                target.to_string_lossy().to_string(),
                size,
            )),
            Err(error) => backup_outcomes.push(BackupRecord::failed(
                file_name.clone(),
                "local",
                target.to_string_lossy().to_string(),
                error.to_string(),
            )),
        }
    }

    if settings.cloud.enabled {
        backup_outcomes
            .push(upload_cloud_backup(&settings.cloud, &file_name, package.clone()).await);
    }

    if backup_outcomes.is_empty() {
        return Err(AppError::InvalidInput(
            "请先配置本地备份目录或启用云端备份".to_string(),
        ));
    }

    let records = match list_configured_backup_records(&settings).await {
        Ok(mut records) => {
            for outcome in backup_outcomes {
                let already_listed = records.iter().any(|record| {
                    record.target_kind == outcome.target_kind
                        && record.target_path == outcome.target_path
                });
                if outcome.status != "success" || !already_listed {
                    records.push(outcome);
                }
            }
            records
        }
        Err(_) => backup_outcomes,
    };

    let (snapshot, delete_paths) =
        with_store(&state, |store| store.replace_backup_records(records))?;
    for path in delete_paths {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn backup_record_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    record_id: String,
) -> AppResult<ConfigSnapshot> {
    let (settings, record) = with_store(&state, |store| {
        let snapshot = store.snapshot()?;
        let record = snapshot
            .data
            .backup_records
            .iter()
            .find(|record| record.id == record_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("备份记录 {}", record_id)))?;
        Ok((snapshot.data.settings.backup, record))
    })?;
    if record.status != "success" {
        return Err(AppError::InvalidInput("失败的备份记录不能恢复".to_string()));
    }
    let bytes = if record.target_kind == "local" {
        tokio::fs::read(&record.target_path)
            .await
            .map_err(|error| AppError::Io(error.to_string()))?
    } else {
        download_cloud_backup(&settings.cloud, &record).await?
    };
    with_store(&state, |store| store.validate_backup_bytes(&bytes))?;
    state.remote.shutdown_all(&app).await;
    with_store(&state, |store| store.backup_import_bytes(&bytes))
}

#[tauri::command]
pub async fn backup_record_delete(
    state: State<'_, AppState>,
    record_id: String,
    delete_file: bool,
) -> AppResult<ConfigSnapshot> {
    let (snapshot, delete_path) = with_store(&state, |store| {
        store.delete_backup_record(&record_id, delete_file)
    })?;
    if let Some(path) = delete_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn backup_records_clear(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let (snapshot, _) = with_store(&state, |store| store.replace_backup_records(Vec::new()))?;
    Ok(snapshot)
}

#[tauri::command]
pub fn group_create(state: State<'_, AppState>, input: GroupInput) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_group(input))
}

#[tauri::command]
pub fn group_update(
    state: State<'_, AppState>,
    group_id: String,
    input: GroupInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_group(&group_id, input))
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, group_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_group(&group_id))
}

#[tauri::command]
pub fn session_create(
    state: State<'_, AppState>,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_session(input))
}

#[tauri::command]
pub fn session_update(
    state: State<'_, AppState>,
    session_id: String,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_session(&session_id, input))
}

#[tauri::command]
pub fn session_delete(state: State<'_, AppState>, session_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_session(&session_id))
}

#[tauri::command]
pub fn session_duplicate(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.duplicate_session(&session_id))
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConnectionInfo> {
    connect_session(&app, &state, &session_id).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.disconnect(&app, &connection_id).await
}

#[tauri::command]
pub fn ssh_trust_host_key(
    state: State<'_, AppState>,
    session_id: String,
    algorithm: String,
    fingerprint: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| {
        store.trust_host_key(&session_id, algorithm, fingerprint)
    })
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<TerminalInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .open_terminal(&app, &connection_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_write(&terminal_id, data).await
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_resize(&terminal_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_close(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_close(&app, &terminal_id).await
}

#[tauri::command]
pub async fn ssh_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<ExecResult> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .exec_on_connection(&connection.connection_id, command, timeout_ms)
        .await
}

#[tauri::command]
pub async fn ssh_exec_on_connection(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<ExecResult> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .exec_on_connection(&connection_id, command, timeout_ms)
        .await
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, connection_id: String) -> AppResult<SftpInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.open_sftp(&connection_id).await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<Vec<RemoteFileEntry>> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_list(&sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_search(
    state: State<'_, AppState>,
    sftp_id: String,
    base_path: String,
    query: String,
) -> AppResult<Option<String>> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_search_file(&sftp_id, base_path, query)
        .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_mkdir(&app, &sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_create_file(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_create_file(&app, &sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    recursive: bool,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_delete(&app, &sftp_id, path, recursive)
        .await
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_rename(&app, &sftp_id, from, to).await
}

#[tauri::command]
pub async fn sftp_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_copy(&app, &sftp_id, from, to).await
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<String> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_read_text(&sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    content: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_write_text(&app, &sftp_id, path, content)
        .await
}

#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    accelerated: Option<bool>,
    resume: Option<bool>,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .transfer_upload(
            &app,
            sftp_id,
            local_path,
            remote_path,
            overwrite,
            accelerated.unwrap_or(false),
            resume.unwrap_or(false),
        )
        .await
}

#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .transfer_download(&app, sftp_id, remote_path, local_path, overwrite)
        .await
}

#[tauri::command]
pub async fn transfer_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_cancel(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_pause(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_pause(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_resume(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_remove(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_retry(&app, &transfer_id).await
}

#[tauri::command]
pub async fn telemetry_start(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    interval_ms: u64,
) -> AppResult<TelemetryJobInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .telemetry_start(&app, connection_id, session_id, interval_ms)
        .await
}

#[tauri::command]
pub async fn telemetry_stop(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.telemetry_stop(&job_id).await
}

#[tauri::command]
pub async fn telemetry_snapshot(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ServerTelemetry> {
    ensure_vault_unlocked(&state)?;
    state.remote.telemetry_snapshot(&connection_id).await
}

#[tauri::command]
pub async fn forward_start_local(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bind_host: String,
    bind_port: u16,
    remote_host: String,
    remote_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_local(
            &app,
            session_id,
            connection.connection_id,
            bind_host,
            bind_port,
            remote_host,
            remote_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_start_remote(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_bind_host: String,
    remote_bind_port: u16,
    local_host: String,
    local_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_remote(
            &app,
            session_id,
            connection.connection_id,
            remote_bind_host,
            remote_bind_port,
            local_host,
            local_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_start_dynamic(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bind_host: String,
    bind_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_dynamic(
            &app,
            session_id,
            connection.connection_id,
            bind_host,
            bind_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    forward_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.forward_stop(&app, &forward_id).await
}

#[tauri::command]
pub async fn forward_list(state: State<'_, AppState>) -> AppResult<Vec<ForwardInfo>> {
    ensure_vault_unlocked(&state)?;
    Ok(state.remote.forward_list().await)
}

fn with_store<T>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&mut VaultStore) -> AppResult<T>,
) -> AppResult<T> {
    let mut store = state.vault.lock().map_err(lock_poisoned)?;
    action(&mut store)
}

fn ensure_vault_unlocked(state: &State<'_, AppState>) -> AppResult<()> {
    state.ensure_vault_unlocked()
}

fn lock_poisoned<T>(_: T) -> AppError {
    AppError::Crypto("工作区状态锁已损坏".to_string())
}

async fn connect_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<ConnectionInfo> {
    let (session, known_host) = session_bundle(state, session_id)?;
    state.remote.connect(app, session, known_host).await
}

fn session_bundle(
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<(SessionConfig, Option<KnownHostEntry>)> {
    with_store(state, |store| {
        let mut session = store.session(session_id)?;
        let known_host = store.known_host(&session.host, session.port)?;
        let settings = store.snapshot()?.data.settings;
        apply_global_proxy(&mut session, &settings);
        Ok((session, known_host))
    })
}

fn apply_global_proxy(session: &mut SessionConfig, settings: &AppSettings) {
    if let Some(proxy) = session.ssh.proxy.as_ref() {
        if proxy.kind == PROXY_KIND_DIRECT {
            session.ssh.proxy = None;
        }
        return;
    }
    if let Some(proxy) = settings.proxy.as_ref() {
        if !proxy.enabled {
            return;
        }
        session.ssh.proxy = Some(SshProxyOptions {
            kind: proxy.kind.clone(),
            host: proxy.host.clone(),
            port: proxy.port,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VaultData;

    #[test]
    fn app_state_starts_locked() {
        let state = AppState::new(PathBuf::from("memory-only.rpvault"));
        let store = state.vault.lock().unwrap();
        assert!(!store.status().exists);
        assert!(!store.status().unlocked);
        assert_eq!(VaultData::with_default_group().version, 1);
        assert!(VaultData::with_default_group().sessions.is_empty());
    }

    #[test]
    fn runtime_command_guard_requires_unlocked_vault() {
        let state = AppState::new(PathBuf::from("memory-only.rpvault"));
        assert!(matches!(
            state.ensure_vault_unlocked(),
            Err(AppError::VaultLocked)
        ));
    }
}
