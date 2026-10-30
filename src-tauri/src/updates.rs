//! Signed GitHub releases are checked and downloaded outside the WebView.
//! Startup installs before workspace recovery. Later installs require an idle restart.
#[cfg(windows)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct Preferences {
    automatic: bool,
    install_error: Option<String>,
    attempted_from: Option<String>,
    attempted_version: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic: true,
            install_error: None,
            attempted_from: None,
            attempted_version: None,
        }
    }
}

impl Preferences {
    fn recover_install(&mut self, current: &str) {
        if self
            .attempted_from
            .as_deref()
            .is_some_and(|from| from != current)
        {
            self.attempted_from = None;
            self.attempted_version = None;
            self.install_error = None;
        } else if let Some(version) = &self.attempted_version {
            self.install_error.get_or_insert_with(|| format!(
                "The previous attempt to install Velum Code {version} did not finish. You can retry in Settings > Updates."
            ));
        }
    }

    #[cfg(any(windows, test))]
    fn may_install_at_startup(&self, current: &str, target: &str) -> bool {
        self.automatic
            && !(self.attempted_from.as_deref() == Some(current)
                && self.attempted_version.as_deref() == Some(target))
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, PartialEq, Debug)]
enum StartupStage {
    Waiting,
    Installing,
    Finished,
    Skipped,
}

#[cfg(any(windows, test))]
impl StartupStage {
    fn skip(&mut self) -> Result<(), String> {
        match self {
            Self::Installing => {
                Err("The installer has started. Velum will reopen when it finishes.".into())
            }
            Self::Waiting => {
                *self = Self::Skipped;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn begin_install(&mut self) -> bool {
        if *self != Self::Waiting {
            return false;
        }
        *self = Self::Installing;
        true
    }
}

#[derive(serde::Serialize)]
pub struct StartupResult {
    restarting: bool,
    status: Status,
}

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, serde::Serialize)]
pub struct Status {
    revision: u64,
    supported: bool,
    automatic: bool,
    current_version: String,
    phase: Phase,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    checked_at: Option<String>,
    error: Option<String>,
}

#[cfg(windows)]
struct Pending {
    update: tauri_plugin_updater::Update,
    bytes: Option<Vec<u8>>,
}

pub struct UpdateState {
    path: PathBuf,
    preferences: Mutex<Preferences>,
    status: Mutex<Status>,
    // This lock serializes checks, downloads and installation. Settings can
    // still change while network operations are in flight.
    #[cfg(windows)]
    pending: tokio::sync::Mutex<Option<Pending>>,
    #[cfg(windows)]
    cleaned_up: Arc<AtomicBool>,
    #[cfg(windows)]
    startup: Mutex<StartupStage>,
    #[cfg(windows)]
    startup_running: tokio::sync::Mutex<()>,
    #[cfg(windows)]
    startup_skipped: tokio::sync::Notify,
}

fn save_preferences(
    state: &UpdateState,
    change: impl FnOnce(&mut Preferences),
) -> Result<(), String> {
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "Update settings unavailable.")?;
    let mut next = preferences.clone();
    change(&mut next);
    crate::storage::write_json(&state.path, &next)?;
    *preferences = next;
    Ok(())
}

fn publish(app: &AppHandle, change: impl FnOnce(&mut Status)) -> Status {
    let state = app.state::<UpdateState>();
    let mut current = state.status.lock().unwrap();
    change(&mut current);
    current.revision += 1;
    let status = current.clone();
    // Emit under the lock so a late progress event cannot replace Ready.
    let _ = app.emit("app-update-status", &status);
    status
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let directory = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()?);
    let path = directory.join("updates.json");
    let mut preferences: Preferences = std::fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() <= 4096)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let current_version = app.package_info().version.to_string();
    preferences.recover_install(&current_version);
    if path.exists() {
        let _ = crate::storage::write_json(&path, &preferences);
    }
    let supported = cfg!(windows)
        && !cfg!(debug_assertions)
        && matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Nsis)
        )
        && std::env::var_os("VELUM_ISOLATED_TEST").is_none();
    let startup_pending = supported && preferences.automatic;
    app.state::<crate::runner::AgentState>()
        .set_startup_pending(startup_pending);
    app.manage(UpdateState {
        path,
        preferences: Mutex::new(preferences.clone()),
        status: Mutex::new(Status {
            revision: 0,
            supported,
            automatic: preferences.automatic,
            current_version,
            phase: if preferences.install_error.is_some() {
                Phase::Error
            } else {
                Phase::Idle
            },
            version: None,
            downloaded: 0,
            total: None,
            checked_at: None,
            error: preferences.install_error,
        }),
        #[cfg(windows)]
        pending: tokio::sync::Mutex::new(None),
        #[cfg(windows)]
        cleaned_up: Arc::new(AtomicBool::new(false)),
        #[cfg(windows)]
        startup: Mutex::new(if startup_pending {
            StartupStage::Waiting
        } else {
            StartupStage::Finished
        }),
        #[cfg(windows)]
        startup_running: tokio::sync::Mutex::new(()),
        #[cfg(windows)]
        startup_skipped: tokio::sync::Notify::new(),
    });
    #[cfg(windows)]
    if supported {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Give startup a moment to settle before checking for updates in background
            tokio::time::sleep(Duration::from_secs(15)).await;
            loop {
                if app.state::<UpdateState>().status.lock().unwrap().automatic
                    && !app.state::<crate::runner::AgentState>().startup_pending()
                {
                    let _ = check(&app, Duration::from_secs(30), false).await;
                }
                tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            }
        });
    }
    Ok(())
}

fn require_supported(state: &UpdateState) -> Result<(), String> {
    if state.status.lock().unwrap().supported {
        Ok(())
    } else {
        Err("App updates are available in the installed Windows release.".into())
    }
}

#[tauri::command]
pub fn updates_status(state: State<UpdateState>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn updates_set_automatic(app: AppHandle, automatic: bool) -> Result<Status, String> {
    let state = app.state::<UpdateState>();
    require_supported(&state)?;
    // Keep persistence and the emitted preference in the same order even if
    // two IPC clients change it concurrently. All nested locks use prefs first.
    let mut preferences = state
        .preferences
        .lock()
        .map_err(|_| "Update settings unavailable.")?;
    let mut next = preferences.clone();
    next.automatic = automatic;
    crate::storage::write_json(&state.path, &next)?;
    *preferences = next;
    let result = publish(&app, |s| s.automatic = automatic);
    drop(preferences);
    #[cfg(windows)]
    if automatic {
        tauri::async_runtime::spawn(async move {
            let _ = check(&app, Duration::from_secs(30), false).await;
        });
    }
    Ok(result)
}

#[cfg(windows)]
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let cleanup = app.clone();
    let cleaned_up = Arc::clone(&app.state::<UpdateState>().cleaned_up);
    app.updater_builder()
        .timeout(Duration::from_secs(5 * 60))
        .header("Cache-Control", "no-cache")
        .map_err(|error| error.to_string())?
        .on_before_exit(move || {
            crate::shutdown(&cleanup);
            cleaned_up.store(true, Ordering::SeqCst);
        })
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
async fn check(app: &AppHandle, deadline: Duration, startup: bool) -> Result<Status, String> {
    let state = app.state::<UpdateState>();
    require_supported(&state)?;
    let mut pending = state
        .pending
        .try_lock()
        .map_err(|_| "An update operation is already in progress.")?;
    if pending
        .as_ref()
        .is_some_and(|update| update.bytes.is_some())
    {
        return Ok(state.status.lock().unwrap().clone());
    }
    publish(app, |s| {
        s.phase = Phase::Checking;
        s.error = None;
    });
    let result = async {
        let updater = updater(app)?;
        let update = tokio::time::timeout(deadline, updater.check())
            .await
            .map_err(|_| format!("GitHub did not respond within {} seconds. Try again later.", deadline.as_secs()))?
            .map_err(|error| match error {
                tauri_plugin_updater::Error::ReleaseNotFound =>
                    "The GitHub update feed is not available yet. Try again after a signed release is published.".into(),
                _ => format!("Could not check GitHub for updates: {error}"),
            })?;
        publish(app, |s| s.checked_at = Some(chrono::Utc::now().to_rfc3339()));
        let Some(update) = update else {
            *pending = None;
            return Ok(publish(app, |s| {
                s.phase = Phase::Current;
                s.version = None;
                s.downloaded = 0;
                s.total = None;
            }));
        };
        // Accept installers from this release repository only. The plugin
        // additionally verifies the bundled public key before returning bytes.
        if !update.download_url.as_str().starts_with(
            "https://github.com/velumix/VelumCode/releases/download/",
        ) {
            return Err("The update points outside the Velum Code GitHub releases.".into());
        }
        publish(app, |s| {
            s.phase = Phase::Available;
            s.version = Some(update.version.clone());
            s.downloaded = 0;
            s.total = None;
        });
        *pending = Some(Pending { update, bytes: None });
        if startup {
            let preferences = state.preferences.lock().unwrap();
            let status = state.status.lock().unwrap();
            let target = &pending.as_ref().unwrap().update.version;
            if !preferences.may_install_at_startup(&status.current_version, target) {
                let error = preferences.install_error.clone();
                drop(status);
                drop(preferences);
                return Ok(publish(app, |s| s.error = error));
            }
        }
        if state.status.lock().unwrap().automatic {
            download(app, pending.as_mut().unwrap()).await
        } else {
            Ok(state.status.lock().unwrap().clone())
        }
    }.await;
    result.inspect_err(|error| {
        publish(app, |s| {
            s.phase = Phase::Error;
            s.error = Some(error.clone());
        });
    })
}

#[cfg(windows)]
async fn download(app: &AppHandle, pending: &mut Pending) -> Result<Status, String> {
    if pending.bytes.is_some() {
        return Ok(app.state::<UpdateState>().status.lock().unwrap().clone());
    }
    publish(app, |s| {
        s.phase = Phase::Downloading;
        s.error = None;
        s.downloaded = 0;
        s.total = None;
    });
    let mut downloaded = 0_u64;
    let mut last_progress = std::time::Instant::now();
    let result = pending
        .update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                // Avoid flooding the WebView on fast connections.
                if last_progress.elapsed() >= Duration::from_millis(250)
                    || Some(downloaded) == total
                {
                    publish(app, |s| {
                        s.downloaded = downloaded;
                        s.total = total;
                    });
                    last_progress = std::time::Instant::now();
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            let length = bytes.len() as u64;
            pending.bytes = Some(bytes);
            Ok(publish(app, |s| {
                s.phase = Phase::Ready;
                s.downloaded = length;
                s.total = Some(length);
            }))
        }
        Err(error) => {
            let message = format!("Could not download or verify the update: {error}");
            publish(app, |s| {
                s.phase = Phase::Error;
                s.error = Some(message.clone());
            });
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn updates_check(app: AppHandle) -> Result<Status, String> {
    #[cfg(windows)]
    return check(&app, Duration::from_secs(30), false).await;
    #[cfg(not(windows))]
    {
        require_supported(&app.state::<UpdateState>())?;
        unreachable!()
    }
}

#[tauri::command]
pub async fn updates_download(app: AppHandle) -> Result<Status, String> {
    let state = app.state::<UpdateState>();
    require_supported(&state)?;
    #[cfg(windows)]
    {
        let mut pending = state
            .pending
            .try_lock()
            .map_err(|_| "An update operation is already in progress.")?;
        download(&app, pending.as_mut().ok_or("Check for an update first.")?).await
    }
    #[cfg(not(windows))]
    unreachable!()
}

#[cfg(windows)]
async fn install(app: &AppHandle, startup: bool) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    require_supported(&state)?;
    {
        let pending = state
            .pending
            .try_lock()
            .map_err(|_| "An update operation is already in progress.")?;
        let pending = pending.as_ref().ok_or("Download an update first.")?;
        let bytes = pending
            .bytes
            .as_ref()
            .ok_or("The update has not finished downloading.")?;
        let agents = app.state::<crate::runner::AgentState>();
        agents.begin_update()?;
        if let Err(error) = crate::history::flush_before_update(app) {
            agents.cancel_update();
            return Err(format!(
                "Could not save conversations before restarting: {error}"
            ));
        }
        let current = app.package_info().version.to_string();
        let saved = save_preferences(&state, |p| {
            p.install_error = None;
            p.attempted_from = Some(current);
            p.attempted_version = Some(pending.update.version.clone());
        });
        if let Err(error) = saved {
            agents.cancel_update();
            return Err(format!(
                "Could not save update settings before restarting: {error}"
            ));
        }
        publish(app, |s| {
            s.phase = Phase::Installing;
            s.error = None;
        });
        // Let the opening animation paint its installation message before the
        // Windows updater exits the process. Reduced motion still reports it.
        if startup {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // NSIS installs at the current app location, preserves app data and
        // relaunches. The plugin's before-exit hook performs native cleanup.
        if let Err(error) = pending.update.install(bytes) {
            agents.cancel_update();
            let message = format!("Could not start the update installer: {error}");
            publish(app, |s| {
                s.phase = Phase::Ready;
                s.error = Some(message.clone());
            });
            if state.cleaned_up.load(Ordering::SeqCst) {
                // ShellExecute can fail after the plugin's cleanup hook. Open
                // a fresh instance of the current version to restore native
                // services and recovered tabs instead of keeping drained state.
                let _ = save_preferences(&state, |p| p.install_error = Some(message));
                app.restart();
            }
            return Err(message);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn updates_install(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    return install(&app, false).await;
    #[cfg(not(windows))]
    {
        require_supported(&app.state::<UpdateState>())?;
        unreachable!()
    }
}

/// The entry bundle calls this before loading React or recovering saved tabs.
/// Serializing the command makes a WebView reload harmless within this process.
#[tauri::command]
pub async fn updates_startup(app: AppHandle) -> StartupResult {
    let state = app.state::<UpdateState>();
    #[cfg(windows)]
    {
        let _running = state.startup_running.lock().await;
        let waiting = *state.startup.lock().unwrap() == StartupStage::Waiting;
        if waiting {
            let checked = tokio::select! {
                biased;
                _ = state.startup_skipped.notified() => None,
                result = check(&app, Duration::from_secs(8), true) => Some(result),
            };
            // The losing network future has dropped its pending lock before
            // cancellation reads it. It cannot install after the desktop opens.
            let result = match checked {
                Some(result) => result,
                None => {
                    let pending = state.pending.lock().await;
                    Ok(publish(&app, |s| {
                        s.phase = match pending.as_ref() {
                            Some(p) if p.bytes.is_some() => Phase::Ready,
                            Some(_) => Phase::Available,
                            None => Phase::Idle,
                        };
                        s.downloaded = 0;
                        s.total = None;
                        s.error = None;
                    }))
                }
            };
            if let Ok(status) = result {
                let eligible = status.phase == Phase::Ready
                    && status.version.as_deref().is_some_and(|target| {
                        state
                            .preferences
                            .lock()
                            .unwrap()
                            .may_install_at_startup(&status.current_version, target)
                    });
                let admitted = eligible && state.startup.lock().unwrap().begin_install();
                if admitted {
                    match install(&app, true).await {
                        Ok(()) => {
                            return StartupResult {
                                restarting: true,
                                status: state.status.lock().unwrap().clone(),
                            }
                        }
                        Err(error) => {
                            publish(&app, |s| s.error = Some(error));
                        }
                    }
                }
            }
        } else if *state.startup.lock().unwrap() == StartupStage::Installing {
            return StartupResult {
                restarting: true,
                status: state.status.lock().unwrap().clone(),
            };
        }
        *state.startup.lock().unwrap() = StartupStage::Finished;
    }
    app.state::<crate::runner::AgentState>()
        .set_startup_pending(false);
    let status = state.status.lock().unwrap().clone();
    StartupResult {
        restarting: false,
        status,
    }
}

#[tauri::command]
pub fn updates_skip_startup(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<UpdateState>();
        state.startup.lock().unwrap().skip()?;
        state.startup_skipped.notify_one();
        app.state::<crate::runner::AgentState>()
            .set_startup_pending(false);
    }
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_preferences_enable_startup_updates() {
        let p: Preferences = serde_json::from_str(r#"{"automatic":true}"#).unwrap();
        assert!(p.may_install_at_startup("0.6.8", "0.6.9"));
        let p: Preferences = serde_json::from_str(r#"{"automatic":false}"#).unwrap();
        assert!(!p.may_install_at_startup("0.6.8", "0.6.9"));
    }

    #[test]
    fn failed_install_is_not_repeated_on_launch_but_new_releases_are_allowed() {
        let mut p = Preferences {
            attempted_from: Some("0.6.8".into()),
            attempted_version: Some("0.6.9".into()),
            ..Preferences::default()
        };
        p.recover_install("0.6.8");
        assert!(p.install_error.is_some());
        assert!(!p.may_install_at_startup("0.6.8", "0.6.9"));
        assert!(p.may_install_at_startup("0.6.8", "0.6.10"));
        p.recover_install("0.6.9");
        assert!(p.install_error.is_none());
        assert!(p.attempted_version.is_none());
        assert!(p.attempted_from.is_none());
    }

    #[test]
    fn skipping_and_installing_are_mutually_exclusive() {
        let mut startup = StartupStage::Waiting;
        startup.skip().unwrap();
        assert!(!startup.begin_install());
        let mut startup = StartupStage::Waiting;
        assert!(startup.begin_install());
        assert!(startup.skip().is_err());
        assert!(!startup.begin_install());
        let mut startup = StartupStage::Finished;
        assert!(!startup.begin_install());
        startup.skip().unwrap();
        assert_eq!(startup, StartupStage::Finished);
    }

    #[tokio::test]
    async fn cancellation_drops_network_work_before_recovery_takes_its_lock() {
        let pending = tokio::sync::Mutex::new(());
        let skipped = tokio::sync::Notify::new();
        let started = tokio::sync::Notify::new();
        let network = async {
            let _pending = pending.lock().await;
            started.notify_one();
            std::future::pending::<()>().await;
        };
        let cancel = async {
            started.notified().await;
            skipped.notify_one();
        };
        let startup = async {
            let cancelled = tokio::select! {
                biased;
                _ = skipped.notified() => true,
                _ = network => false,
            };
            assert!(cancelled);
            assert!(
                pending.try_lock().is_ok(),
                "Cancelled work still holds the update lock"
            );
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(startup, cancel);
        })
        .await
        .unwrap();
    }

    #[test]
    fn an_opt_out_survives_install_recovery() {
        let mut p = Preferences {
            automatic: false,
            attempted_from: Some("0.6.7".into()),
            attempted_version: Some("0.6.8".into()),
            ..Preferences::default()
        };
        p.recover_install("0.6.8");
        assert!(!p.automatic);
        assert!(!p.may_install_at_startup("0.6.8", "0.6.9"));
    }
}
