mod backup;
mod commands;
mod config;
mod crypto;
mod errors;
mod events;
mod remote;
mod vault;

use commands::{
    backup_record_delete, backup_record_restore, backup_run_now, config_snapshot, forward_list,
    forward_start_dynamic, forward_start_local, forward_start_remote, forward_stop, group_create,
    group_delete, group_update, resolve_vault_path, session_create, session_delete,
    session_duplicate, session_update, settings_update, sftp_copy, sftp_create_file, sftp_delete,
    sftp_list, sftp_mkdir, sftp_open, sftp_read_text, sftp_rename, sftp_search, sftp_write_text,
    ssh_connect, ssh_disconnect, ssh_exec, ssh_exec_on_connection, ssh_trust_host_key,
    telemetry_snapshot, telemetry_start, telemetry_stop, terminal_close, terminal_open,
    terminal_resize, terminal_write, transfer_cancel, transfer_download, transfer_pause,
    transfer_remove, transfer_resume, transfer_retry, transfer_upload, tunnel_create,
    tunnel_delete, tunnel_list, tunnel_update, vault_backup_export, vault_backup_import,
    vault_change_master_password, vault_create, vault_lock, vault_status, vault_unlock, AppState,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(window) = app.get_webview_window("splash") {
        let _ = window.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let vault_path = resolve_vault_path(app.handle())?;
            app.manage(AppState::new(vault_path));
            configure_main_window(app);
            create_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            frontend_ready,
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_change_master_password,
            vault_backup_export,
            vault_backup_import,
            backup_run_now,
            backup_record_restore,
            backup_record_delete,
            config_snapshot,
            settings_update,
            group_create,
            group_update,
            group_delete,
            session_create,
            session_update,
            session_delete,
            session_duplicate,
            tunnel_create,
            tunnel_update,
            tunnel_delete,
            tunnel_list,
            ssh_connect,
            ssh_disconnect,
            ssh_trust_host_key,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            ssh_exec,
            ssh_exec_on_connection,
            sftp_open,
            sftp_list,
            sftp_search,
            sftp_mkdir,
            sftp_create_file,
            sftp_delete,
            sftp_rename,
            sftp_copy,
            sftp_read_text,
            sftp_write_text,
            transfer_upload,
            transfer_download,
            transfer_cancel,
            transfer_pause,
            transfer_resume,
            transfer_remove,
            transfer_retry,
            telemetry_start,
            telemetry_stop,
            telemetry_snapshot,
            forward_start_local,
            forward_start_remote,
            forward_start_dynamic,
            forward_stop,
            forward_list
        ])
        .run(tauri::generate_context!())
        .expect("failed to run HelM");
}

fn configure_main_window(app: &mut tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
        let close_window = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = close_window.hide();
            }
        });
    }
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray_show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray_hide", "隐藏到托盘", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "tray_lock", "锁定工作区", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray_settings", "全局设置", true, None::<&str>)?;
    let backup = MenuItem::with_id(app, "tray_backup", "数据备份", true, None::<&str>)?;
    let backup_now = MenuItem::with_id(app, "tray_backup_now", "立即备份", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "tray_exit", "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &lock,
            &settings,
            &backup,
            &backup_now,
            &separator,
            &exit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("HelM")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_hide" => hide_main_window(app),
            "tray_lock" => crate::events::emit(app, crate::events::TRAY_ACTION, "lock"),
            "tray_settings" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "settings");
            }
            "tray_backup" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "backup");
            }
            "tray_backup_now" => {
                show_main_window(app);
                crate::events::emit(app, crate::events::TRAY_ACTION, "backupNow");
            }
            "tray_exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        // Windows 下 set_focus 不一定能把窗口拉到前台，先置顶再取消以强制前置
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_always_on_top(true);
            let _ = window.set_always_on_top(false);
        }
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}
