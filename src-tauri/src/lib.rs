mod app_context;
mod automation;
mod bot_actions;
mod bots;
mod child_process;
mod desktop;
mod events;
mod history;
mod interactions;
mod kanban;
mod memory;
mod message_queue;
mod muse_msp;
mod codex_control;
mod provider_control;
mod muse_view;
mod plugin_catalog;
mod plugin_github;
mod plugins;
mod preferences;
mod provider_auth;
mod provider_events;
mod provider_models;
mod provider_progress;
mod provider_usage;
mod providers;
mod pty;
mod remote;
mod remote_auth;
mod runner;
mod session_log;
mod storage;
mod tailscale;
mod tool_bridge;
mod tool_control;
mod updates;
mod usb;
mod workspace_access;
mod workspace_tools;

use pty::PtyState;
use runner::AgentState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().any(|arg| arg == "--velum-tool-stdio") {
        if let Err(error) = tool_bridge::stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let mut context = tauri::generate_context!();
    // Explicit native QA instances have their own configuration, WebView and
    // single-instance identity. They never forward to the user's live app.
    if std::env::var_os("VELUM_ISOLATED_TEST").is_some() {
        if let Some(directory) = std::env::var_os("MUSE_CODE_CONFIG_DIR") {
            use sha2::Digest;
            let tag = format!(
                "{:x}",
                sha2::Sha256::digest(directory.to_string_lossy().as_bytes())
            );
            context.config_mut().identifier = format!("com.velumix.musecode.qa.{}", &tag[..20]);
            if let Some(window) = context.config_mut().app.windows.first_mut() {
                window.title = format!("Velum native QA {}", &tag[..8]);
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop::show(app, None)
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(provider_auth::AuthState::default())
        .manage(AgentState::default())
        .manage(session_log::SessionLog::default())
        .setup(|app| {
            updates::setup(app.handle())?;
            memory::setup(app.handle());
            bots::setup(app.handle());
            plugins::setup(app.handle());
            plugin_catalog::setup(app.handle());
            kanban::setup(app.handle());
            history::setup(app.handle());
            automation::setup(app.handle());
            desktop::setup(app)?;
            preferences::setup(app)?;
            tool_bridge::setup(app)?;
            remote::setup(app)?;
            Ok(())
        })
        .on_window_event(desktop::close_to_tray)
        .invoke_handler(tauri::generate_handler![
            preferences::preferences_load,
            preferences::preferences_save,
            tool_bridge::agent_tools_status,
            tool_bridge::agent_tools_configure,
            tool_bridge::agent_tools_disconnect,
            app_context::workspace_pick,
            app_context::workspace_check,
            app_context::git_state,
            app_context::git_file_diff,
            app_context::app_diagnostics,
            bots::bots_request,
            bots::bots_memory,
            bots::bots_open,
            automation::automation_request,
            memory::memory_request,
            kanban::kanban_request,
            memory::memory_open,
            plugins::plugins_list,
            plugin_catalog::plugins_catalog,
            plugins::plugins_preview,
            plugins::plugins_install,
            plugins::plugins_enable,
            plugins::plugins_remove,
            plugins::plugins_source,
            plugins::plugins_call,
            history::history_forget,
            history::history_desktop_save,
            history::history_draft_save,
            history::history_desktop_load,
            pty::pty_spawn,
            providers::provider_status,
            provider_models::provider_models,
            provider_models::provider_warmup,
            runner::agent_configure,
            runner::agent_set_permissions,
            runner::agent_check_access,
            provider_auth::antigravity_login_start,
            provider_auth::antigravity_login_status,
            provider_auth::antigravity_login_submit,
            provider_auth::antigravity_login_cancel,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_close_continuation,
            runner::agent_new,
            runner::agent_validate_workspace,
            runner::agent_send,
            runner::agent_queue,
            runner::agent_interactions,
            runner::agent_respond,
            runner::agent_stop,
            runner::agent_destroy,
            remote::remote_status,
            remote::remote_usb_devices,
            remote::remote_usb_connect,
            remote::remote_usb_disconnect,
            remote::remote_check_tailscale,
            remote::remote_enable,
            remote::remote_pair,
            remote::remote_approve,
            remote::remote_cancel_pairing,
            remote::remote_revoke,
            desktop::desktop_status,
            desktop::desktop_set_notifications,
            desktop::desktop_test_notification,
            desktop::desktop_take_navigation,
            desktop::desktop_show,
            desktop::desktop_quit,
            updates::updates_status,
            updates::updates_startup,
            updates::updates_skip_startup,
            updates::updates_set_automatic,
            updates::updates_check,
            updates::updates_download,
            updates::updates_install
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown(app);
            }
        });
}

// The Windows updater exits directly after launching NSIS. Its before-exit
// hook must perform the same cleanup as a normal Tauri exit.
fn shutdown(app: &tauri::AppHandle) {
    automation::shutdown(app);
    remote::shutdown(app);
    desktop::shutdown(app);
    app.state::<AgentState>().shutdown();
    history::shutdown(app);
    app.state::<PtyState>().shutdown();
    app.state::<provider_auth::AuthState>().shutdown();
}
