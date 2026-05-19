use std::path::PathBuf;

use tauri::{AppHandle, State};

use super::{with_store, AppError, AppResult, AppState};
use crate::backup::{
    backup_file_name, build_backup_package, download_cloud_backup,
    list_configured_backup_records, upload_cloud_backup,
};
use crate::config::{BackupRecord, ConfigSnapshot};

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
        .map_err(|e| AppError::Io(e.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let size = package.len() as u64;
    let mut backup_outcomes = Vec::new();
    let has_local = settings
        .local_directory
        .as_deref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    if has_local {
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
            Err(e) => backup_outcomes.push(BackupRecord::failed(
                file_name.clone(),
                "local",
                target.to_string_lossy().to_string(),
                e.to_string(),
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
                let already_listed = records.iter().any(|r| {
                    r.target_kind == outcome.target_kind && r.target_path == outcome.target_path
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
            .find(|r| r.id == record_id)
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
            .map_err(|e| AppError::Io(e.to_string()))?
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
    let (snapshot, delete_path) =
        with_store(&state, |store| store.delete_backup_record(&record_id, delete_file))?;
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
