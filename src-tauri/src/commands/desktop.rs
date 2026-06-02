use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::{resolve_vault_path, AppError, AppResult};
use crate::http_client::{http_client, send_with_retry};

const UPDATE_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExpandedEntry {
    pub local_path: String,
    pub relative_path: String,
}

/// Expand local paths: if a path is a directory, recursively list all files inside it
/// with their relative paths preserved. If a path is a file, return it as-is.
#[tauri::command]
pub async fn local_expand_paths(paths: Vec<String>) -> AppResult<Vec<LocalExpandedEntry>> {
    let mut results = Vec::new();
    for root in paths {
        let root_path = PathBuf::from(&root);
        let metadata = tokio::fs::metadata(&root_path)
            .await
            .map_err(|error| AppError::Io(format!("无法读取路径 {root}: {error}")))?;
        if metadata.is_file() {
            let file_name = root_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            results.push(LocalExpandedEntry {
                local_path: root.clone(),
                relative_path: file_name,
            });
        } else if metadata.is_dir() {
            let root_name = root_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let mut stack = vec![(root_path.clone(), root_name.clone())];
            while let Some((dir, prefix)) = stack.pop() {
                let mut entries = tokio::fs::read_dir(&dir).await.map_err(|error| {
                    AppError::Io(format!("无法读取目录 {}: {error}", dir.display()))
                })?;
                while let Some(entry) = entries
                    .next_entry()
                    .await
                    .map_err(|error| AppError::Io(format!("读取目录条目失败: {error}")))?
                {
                    let entry_path = entry.path();
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    let relative = format!("{}/{}", prefix, entry_name);
                    let ft = entry
                        .file_type()
                        .await
                        .map_err(|error| AppError::Io(format!("读取文件类型失败: {error}")))?;
                    if ft.is_file() {
                        results.push(LocalExpandedEntry {
                            local_path: entry_path.to_string_lossy().to_string(),
                            relative_path: relative,
                        });
                    } else if ft.is_dir() {
                        stack.push((entry_path, relative));
                    }
                }
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn fetch_text_url(url: String) -> AppResult<String> {
    let trimmed = validate_http_url(&url)?;
    let client = http_client(UPDATE_FETCH_TIMEOUT)?;
    let response = send_with_retry("读取远程内容", || {
        client
            .get(trimmed)
            .header(reqwest::header::USER_AGENT, "HelM-Updater")
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "读取远程内容失败：HTTP {}",
            response.status()
        )));
    }
    response
        .text()
        .await
        .map_err(|error| AppError::Remote(format!("解析远程内容失败：{error}")))
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    file_name: Option<String>,
    sha256: Option<String>,
) -> AppResult<String> {
    let trimmed = validate_http_url(&url)?;
    let client = http_client(UPDATE_DOWNLOAD_TIMEOUT)?;
    let response = send_with_retry("下载更新", || {
        client
            .get(trimmed)
            .header(reqwest::header::USER_AGENT, "HelM-Updater")
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "下载更新失败：HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Remote(format!("读取更新包失败：{error}")))?;
    if let Some(expected) = sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let actual = hex::encode(Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(AppError::Crypto("更新包 SHA256 校验失败".to_string()));
        }
    }
    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_cache_dir())
        .map_err(|error| AppError::Io(error.to_string()))?;
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    let name = file_name
        .as_deref()
        .map(sanitize_download_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "HelM-update.exe".to_string());
    let target = downloads.join(name);
    tokio::fs::write(&target, bytes)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn install_update(app: AppHandle, installer_path: String) -> AppResult<()> {
    let trimmed = installer_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("安装包路径为空".to_string()));
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(AppError::InvalidInput(format!(
            "安装包不存在：{}",
            path.display()
        )));
    }
    launch_update_installer(&app, &path)
}

#[tauri::command]
pub fn open_database_dir(app: AppHandle) -> AppResult<()> {
    let vault_path = resolve_vault_path(&app)?;
    let directory = vault_path
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or(vault_path);
    open_directory(&directory)
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> AppResult<()> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(format!("无法获取日志目录: {}", e)))?;
    if !directory.exists() {
        std::fs::create_dir_all(&directory)?;
    }
    open_directory(&directory)
}

#[tauri::command]
pub fn open_path_dir(path: String) -> AppResult<()> {
    let target = PathBuf::from(path.trim());
    let directory = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::InvalidInput("路径没有上级目录".to_string()))?
    };
    open_directory(&directory)
}

#[tauri::command]
pub fn open_external_url(url: String) -> AppResult<()> {
    let trimmed = validate_http_url(&url)?;
    open_url(trimmed)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn launch_update_installer(app: &AppHandle, installer: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        let current_pid = std::process::id();
        let process_name = env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_stem()
                    .map(|value| value.to_string_lossy().to_string())
            })
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "HelM".to_string())
            .replace('\'', "''");
        let installer_path = installer.display().to_string().replace('\'', "''");
        let script = format!(
            r#"
$installer = '{installer_path}'
$currentPid = {current_pid}
$processName = '{process_name}'
Start-Sleep -Milliseconds 800
Get-Process -Name $processName -ErrorAction SilentlyContinue |
  Where-Object {{ $_.Id -ne $PID }} |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $installer
"#
        );
        let encoded = general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-EncodedCommand",
                &encoded,
            ])
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        app.exit(0);
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Command::new(installer)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

fn validate_http_url(value: &str) -> AppResult<&str> {
    let trimmed = value.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(AppError::InvalidInput("链接地址无效".to_string()));
    }
    Ok(trimmed)
}

fn open_directory(path: &PathBuf) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

fn open_url(url: &str) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

pub fn friendly_os_name() -> String {
    #[cfg(target_os = "windows")]
    {
        return windows_version_name();
    }
    #[cfg(target_os = "macos")]
    {
        return command_output("sw_vers", &["-productVersion"])
            .map(|version| format!("macOS {version}"))
            .unwrap_or_else(|| "macOS".to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return linux_pretty_name().unwrap_or_else(|| "Linux".to_string());
    }
    #[allow(unreachable_code)]
    env::consts::OS.to_string()
}

#[cfg(target_os = "windows")]
fn windows_version_name() -> String {
    let version = command_output("cmd", &["/C", "ver"]).unwrap_or_default();
    let build = version
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .find(|part| part.matches('.').count() >= 2)
        .and_then(|part| part.split('.').nth(2))
        .and_then(|part| part.parse::<u32>().ok());
    match build {
        Some(value) if value >= 22_000 => "Windows 11".to_string(),
        Some(_) => "Windows 10".to_string(),
        None => "Windows".to_string(),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_pretty_name() -> Option<String> {
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    content.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|value| value.trim_matches('"').replace("\\\"", "\""))
    })
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn sanitize_download_name(value: &str) -> String {
    value
        .chars()
        .filter(|char| !matches!(char, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string()
}
