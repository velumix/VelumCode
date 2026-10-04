//! Tray lifetime and notification policy live outside the WebView, so hidden
//! windows and throttled JavaScript never interrupt a turn or its notification.
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

#[cfg(windows)]
#[path = "windows_notifications.rs"]
mod notifications;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub notifications_enabled: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            notifications_enabled: true,
        }
    }
}

pub struct DesktopState {
    preferences: Mutex<Preferences>,
    preferences_path: PathBuf,
    last_error: Mutex<Option<String>>,
    navigation: Mutex<Option<String>>,
    notification_delivery: Mutex<()>,
    pub quitting: AtomicBool,
    #[cfg(windows)]
    activator_cookie: Mutex<Option<u32>>,
}

#[derive(serde::Serialize, Clone)]
pub struct DesktopStatus {
    notifications_enabled: bool,
    last_error: Option<String>,
}

fn status(state: &DesktopState) -> DesktopStatus {
    DesktopStatus {
        notifications_enabled: state
            .preferences
            .lock()
            .map(|p| p.notifications_enabled)
            .unwrap_or(false),
        last_error: state.last_error.lock().ok().and_then(|e| e.clone()),
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Useful for isolated native integration runs; normal installations use
    // the standard per-user application configuration directory.
    let config_dir = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()?);
    let preferences_path = config_dir.join("desktop.json");
    let preferences: Preferences = std::fs::read(&preferences_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let enabled = preferences.notifications_enabled;
    app.manage(DesktopState {
        preferences: Mutex::new(preferences),
        preferences_path,
        last_error: Mutex::new(None),
        navigation: Mutex::new(None),
        notification_delivery: Mutex::new(()),
        quitting: AtomicBool::new(false),
        #[cfg(windows)]
        activator_cookie: Mutex::new(None),
    });
    let open = MenuItem::with_id(app, "open", "Open Velum Code", true, None::<&str>)?;
    let notify = CheckMenuItem::with_id(
        app,
        "notifications",
        "Background notifications",
        true,
        enabled,
        None::<&str>,
    )?;
    let test = MenuItem::with_id(
        app,
        "test-notification",
        "Send test notification",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Velum Code", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &notify, &test, &separator, &quit])?;
    app.manage(notify);
    TrayIconBuilder::with_id("muse")
        .icon(
            app.default_window_icon()
                .ok_or("Application icon is missing")?
                .clone(),
        )
        .tooltip("Velum Code — running in the background")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle(), None);
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app, None),
            "quit" => quit_app(app),
            "notifications" => {
                let enabled = !status(&app.state::<DesktopState>()).notifications_enabled;
                if let Err(error) = set_notifications(app, enabled) {
                    if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
                        let _ = item.set_checked(!enabled);
                    }
                    report_error(app, error);
                }
            }
            "test-notification" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(error) = send_test(&app) {
                        report_error(&app, error);
                        show(&app, None);
                    }
                });
            }
            _ => {}
        })
        .build(app)?;
    #[cfg(windows)]
    match notifications::register_activator(app.handle()) {
        Ok(cookie) => *app.state::<DesktopState>().activator_cookie.lock().unwrap() = Some(cookie),
        Err(error) => report_error(
            app.handle(),
            format!("Windows notification activation is unavailable: {error}"),
        ),
    }
    Ok(())
}

pub fn close_to_tray(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main"
            && !window
                .state::<DesktopState>()
                .quitting
                .load(Ordering::SeqCst)
            && window.app_handle().tray_by_id("muse").is_some()
            && window.hide().is_ok()
        {
            api.prevent_close();
        }
    }
}

pub fn show(app: &AppHandle, tab_id: Option<String>) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if state.quitting.load(Ordering::SeqCst) {
            return;
        }
        if let Some(id) = tab_id {
            *state.navigation.lock().unwrap() = Some(id);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("desktop-navigation", ());
    }
}

pub fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    state.quitting.store(true, Ordering::SeqCst);
    #[cfg(windows)]
    {
        let _delivery = state.notification_delivery.lock().ok();
        // Notifications describe in-memory conversations. Explicit Quit ends
        // those conversations, so don't leave stale actions in Notification Center.
        let _ = notifications::clear();
        if let Some(cookie) = state
            .activator_cookie
            .lock()
            .ok()
            .and_then(|mut c| c.take())
        {
            notifications::unregister_activator(cookie);
        }
    }
}

fn report_error(app: &AppHandle, error: String) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut current) = state.last_error.lock() {
            *current = Some(error);
        }
        let _ = app.emit("desktop-status", status(&state));
    }
}

fn set_notifications(app: &AppHandle, enabled: bool) -> Result<DesktopStatus, String> {
    let state = app.state::<DesktopState>();
    let mut prefs = state
        .preferences
        .lock()
        .map_err(|_| "Desktop settings are unavailable")?;
    let next = Preferences {
        notifications_enabled: enabled,
    };
    if let Some(parent) = state.preferences_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not save notification settings: {e}"))?;
    }
    std::fs::write(
        &state.preferences_path,
        serde_json::to_vec(&next).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Could not save notification settings: {e}"))?;
    *prefs = next;
    drop(prefs);
    if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
        let _ = item.set_checked(enabled);
    }
    *state.last_error.lock().unwrap() = None;
    let result = status(&state);
    let _ = app.emit("desktop-status", &result);
    Ok(result)
}

pub(crate) fn should_notify(
    enabled: bool,
    quitting: bool,
    foreground: bool,
    outcome: &str,
) -> bool {
    enabled
        && !quitting
        && !foreground
        && matches!(
            outcome,
            "completed" | "failed" | "blocked" | "awaiting_review"
        )
}

pub fn notify_turn(app: &AppHandle, tab_id: &str, outcome: &str) {
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    let foreground = app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
    });
    if !should_notify(
        status(&state).notifications_enabled,
        state.quitting.load(Ordering::SeqCst),
        foreground,
        outcome,
    ) {
        return;
    }
    let title = if outcome == "completed" {
        "Your response is ready"
    } else {
        "Velum Code needs your attention"
    };
    let body = if outcome == "completed" {
        "Open Velum Code to continue your conversation."
    } else if outcome == "awaiting_review" {
        "An agent is waiting for your response. Open its conversation, or Bots > Activity for a scheduled run."
    } else {
        "A task couldn't finish. Open the conversation to review the error."
    };
    // Keep prompts, output and directory paths off the lock screen.
    if let Err(error) = send_native(app, title, body, Some(tab_id)) {
        report_error(app, error);
    }
}

fn send_native(
    app: &AppHandle,
    title: &str,
    body: &str,
    tab_id: Option<&str>,
) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let _delivery = state
        .notification_delivery
        .lock()
        .map_err(|_| "Notification delivery is unavailable")?;
    // Serialize with shutdown so a finishing reader cannot leave a stale
    // notification behind after Quit clears Notification Center.
    if state.quitting.load(Ordering::SeqCst) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        notifications::send(app, title, body, tab_id).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, tab_id);
        Err("Native notifications are currently supported on Windows.".into())
    }
}

fn send_test(app: &AppHandle) -> Result<(), String> {
    if !status(&app.state::<DesktopState>()).notifications_enabled {
        return Err("Turn on background notifications before sending a test.".into());
    }
    send_native(
        app,
        "Velum Code is ready in the background",
        "You'll hear from Velum Code when a background task finishes. Click to open Velum Code.",
        None,
    )?;
    let state = app.state::<DesktopState>();
    *state.last_error.lock().unwrap() = None;
    let _ = app.emit("desktop-status", status(&state));
    Ok(())
}

#[tauri::command]
pub fn desktop_status(state: State<DesktopState>) -> DesktopStatus {
    status(&state)
}
#[tauri::command]
pub fn desktop_set_notifications(app: AppHandle, enabled: bool) -> Result<DesktopStatus, String> {
    set_notifications(&app, enabled)
}
#[tauri::command]
pub async fn desktop_test_notification(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || send_test(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn desktop_take_navigation(state: State<DesktopState>) -> Option<String> {
    state.navigation.lock().ok().and_then(|mut n| n.take())
}
#[tauri::command]
pub fn desktop_show(app: AppHandle) {
    show(&app, None);
}
#[tauri::command]
pub fn desktop_quit(app: AppHandle) {
    quit_app(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notifications_only_report_background_completions_and_failures() {
        for outcome in ["completed", "failed"] {
            assert!(should_notify(true, false, false, outcome));
            assert!(!should_notify(false, false, false, outcome));
            assert!(!should_notify(true, true, false, outcome));
            assert!(!should_notify(true, false, true, outcome));
        }
        for outcome in ["cancelled", "running", "unknown"] {
            assert!(!should_notify(true, false, false, outcome));
        }
    }
    #[test]
    fn notification_preference_defaults_on_and_round_trips() {
        assert!(
            serde_json::from_str::<Preferences>("{}")
                .unwrap()
                .notifications_enabled
        );
        let encoded = serde_json::to_string(&Preferences {
            notifications_enabled: false,
        })
        .unwrap();
        assert!(
            !serde_json::from_str::<Preferences>(&encoded)
                .unwrap()
                .notifications_enabled
        );
    }
}
