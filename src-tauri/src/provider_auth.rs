//! A dedicated, cancellable CLI login. Credentials stay with Antigravity's
//! keyring; raw terminal output and pasted codes never enter app events/logs.
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State};

#[derive(Default)]
struct TerminalReplies(String);
impl vt100::Callbacks for TerminalReplies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if i1.is_none() && c == 'n' && params.first() == Some(&&[6][..]) {
            let (row, col) = screen.cursor_position();
            self.0.push_str(&format!("\x1b[{};{}R", row + 1, col + 1));
        } else if i1.is_none() && c == 'c' {
            self.0.push_str("\x1b[?1;2c");
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    phase: &'static str,
    url: Option<String>,
    message: &'static str,
}
struct Session {
    id: String,
    snapshot: Mutex<Snapshot>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    _master: Mutex<Box<dyn MasterPty + Send>>,
}
impl Session {
    fn active(&self) -> bool {
        matches!(
            self.snapshot.lock().unwrap().phase,
            "starting" | "code" | "verifying"
        )
    }
    fn finish(&self, phase: &'static str, message: &'static str) {
        {
            let mut state = self.snapshot.lock().unwrap();
            if !matches!(state.phase, "starting" | "code" | "verifying") {
                return;
            }
            *state = Snapshot {
                phase,
                url: None,
                message,
            };
        }
        self.stop();
    }
    fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            if child.try_wait().ok().flatten().is_none() {
                #[cfg(windows)]
                if let Some(pid) = child.process_id() {
                    crate::runner::terminate_tree(pid);
                }
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
    fn write(&self, text: &str) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Sign-in input is unavailable.")?;
        writer
            .write_all(text.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|_| "The sign-in session ended. Start again.".into())
    }
    fn child_success(&self) -> Option<bool> {
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                Some(status.success())
            }
            _ => None,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    #[serde(default)]
    pub logged_in: bool,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub api_provider: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
    #[serde(default)]
    pub subscription_type: Option<String>,
}
#[derive(Default)]
pub struct AuthState(Mutex<Option<Arc<Session>>>);
impl AuthState {
    pub fn shutdown(&self) {
        if let Some(session) = self.0.lock().unwrap().take() {
            session.finish("cancelled", "Sign-in cancelled.");
        }
    }
    fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "This sign-in session has ended. Start again.".into())
    }
}

fn authorization_url(screen: &str) -> Option<String> {
    let start = screen.find("https://accounts.google.com/")?;
    // The TUI can wrap its URL. Stop at its separator or explanatory text.
    let url: String = screen[start..]
        .lines()
        .map(str::trim)
        .take_while(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_graphic()))
        .collect();
    let parsed = tauri::Url::parse(&url).ok()?;
    (parsed.scheme() == "https"
        && parsed.host_str() == Some("accounts.google.com")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query_pairs().any(|(key, _)| key == "state")
        && parsed.query_pairs().any(|(key, _)| key == "code_challenge"))
    .then_some(url)
}
fn login_error(screen: &str) -> bool {
    let text = screen.to_ascii_lowercase();
    [
        "got an error:",
        "token exchange failed",
        "authentication failed",
        "invalid_grant",
        "failed to sign in",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}
fn valid_code(code: &str) -> bool {
    (10..=4096).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b))
}

// `agy models` requires a valid account and never starts an agent turn. Checking
// its exit status avoids guessing success from a disappearing code prompt.
fn verified(path: &std::path::Path, session: &Session) -> bool {
    let mut cmd = Command::new(path);
    cmd.arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let start = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return status.success();
        }
        if !session.active() || start.elapsed() > Duration::from_secs(8) {
            #[cfg(windows)]
            crate::runner::terminate_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub fn antigravity_login_start(
    app: tauri::AppHandle,
    state: State<AuthState>,
    id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid sign-in session.")?;
    let path = crate::providers::Provider::Antigravity
        .resolve()
        .ok_or("Install the Antigravity CLI first.")?;
    let workspace = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Could not open app data.")?
        .join("sign-in");
    std::fs::create_dir_all(&workspace).map_err(|_| "Could not prepare sign-in.")?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 60,
            cols: 160,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "Could not start sign-in terminal.")?;
    let log_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut cmd = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
    {
        let mut cmd = portable_pty::CommandBuilder::new("powershell");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "& $env:VELUM_AUTH_CLI --log-file $env:VELUM_AUTH_LOG; exit $LASTEXITCODE",
        ]);
        cmd.env("VELUM_AUTH_CLI", &path);
        cmd.env("VELUM_AUTH_LOG", log_path);
        cmd
    } else {
        let mut cmd = crate::pty::build_command(&path);
        cmd.args(["--log-file", log_path]);
        cmd
    };
    cmd.cwd(&workspace);
    // Use the CLI's documented manual-code flow, with browser opening controlled
    // by the dialog. This does not alter the user's global environment.
    cmd.env("SSH_CONNECTION", "127.0.0.1 1 127.0.0.1 22");
    let writer = pair
        .master
        .take_writer()
        .map_err(|_| "Could not attach sign-in input.")?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| "Could not read sign-in progress.")?;
    let mut guard = state.0.lock().unwrap();
    if let Some(previous) = guard.take() {
        previous.finish("cancelled", "Sign-in restarted.");
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|_| "Could not launch Antigravity sign-in.")?;
    let session = Arc::new(Session {
        id,
        snapshot: Mutex::new(Snapshot {
            phase: "starting",
            url: None,
            message: "Preparing Google sign-in…",
        }),
        writer: Mutex::new(writer),
        child: Mutex::new(Some(child)),
        _master: Mutex::new(pair.master),
    });
    *guard = Some(session.clone());
    drop(guard);
    let reading = session.clone();
    std::thread::spawn(move || {
        let mut parser = vt100::Parser::new_with_callbacks(60, 160, 0, TerminalReplies::default());
        let mut buf = [0; 8192];
        let mut selected = false;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || !reading.active() {
                break;
            }
            parser.process(&buf[..n]);
            let replies = std::mem::take(&mut parser.callbacks_mut().0);
            if !replies.is_empty() && reading.write(&replies).is_err() {
                break;
            }
            let screen = parser.screen().contents();
            if login_error(&screen) {
                reading.finish("error", "Google could not accept that sign-in. Start again for a fresh code, and check your connection if it keeps failing.");
                break;
            }
            if !selected
                && screen.contains("Select login method:")
                && screen.contains("> 1. Google OAuth")
            {
                selected = true;
                if reading.write("\r").is_err() {
                    break;
                }
            }
            if screen.contains("authorization code") {
                if let Some(url) = authorization_url(&screen) {
                    let mut state = reading.snapshot.lock().unwrap();
                    if state.phase == "starting" {
                        *state = Snapshot {
                            phase: "code",
                            url: Some(url),
                            message: "Sign in with Google, then paste the code from your browser.",
                        };
                    }
                }
            }
        }
        reading.finish(
            "error",
            "The sign-in process closed. Start again to get a fresh code.",
        );
    });
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut checking_since = None;
        // Also recognizes an account already saved in the CLI's keyring.
        if verified(&path, &session) {
            session.finish("complete", "Antigravity is connected.");
            return;
        }
        loop {
            if !session.active() {
                break;
            }
            let phase = session.snapshot.lock().unwrap().phase;
            if phase == "verifying" {
                let since = checking_since.get_or_insert_with(Instant::now);
                if verified(&path, &session) {
                    session.finish("complete", "Antigravity is connected.");
                    break;
                }
                if since.elapsed() > Duration::from_secs(60) {
                    session.finish("error", "We could not verify the account. Check your connection and start again with a fresh code.");
                    break;
                }
            }
            if phase == "starting" && started.elapsed() > Duration::from_secs(30) {
                session.finish("error", "Antigravity needs its first-launch setup. Open its Terminal view, finish the theme and workspace prompts, then try Sign in again.");
                break;
            }
            if started.elapsed() > Duration::from_secs(600) {
                session.finish(
                    "error",
                    "This sign-in expired. Start again to get a fresh code.",
                );
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
    Ok(())
}
#[tauri::command]
pub fn antigravity_login_status(state: State<AuthState>, id: String) -> Result<Snapshot, String> {
    Ok(state.session(&id)?.snapshot.lock().unwrap().clone())
}
#[tauri::command]
pub fn antigravity_login_submit(
    state: State<AuthState>,
    id: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if !valid_code(code) {
        return Err(
            "Paste only the authorization code shown by Google, without a URL or extra text."
                .into(),
        );
    }
    let session = state.session(&id)?;
    {
        let mut state = session.snapshot.lock().unwrap();
        if state.phase != "code" {
            return Err(
                "This sign-in is not waiting for a code. Start again if it expired.".into(),
            );
        }
        state.phase = "verifying";
        state.url = None;
        state.message = "Checking your sign-in…";
    }
    // Bracketed paste makes the TUI treat this as one paste, followed by Enter.
    if let Err(error) = session.write(&format!("\x1b[200~{code}\x1b[201~\r")) {
        session.finish("error", "The sign-in session ended. Start again.");
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn antigravity_login_cancel(state: State<AuthState>, id: String) {
    let mut guard = state.0.lock().unwrap();
    if guard.as_ref().is_some_and(|s| s.id == id) {
        if let Some(session) = guard.take() {
            session.finish("cancelled", "Sign-in cancelled.");
        }
    }
}

fn hidden_command(path: &std::path::Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn wait_for_output(
    mut child: std::process::Child,
    timeout: Duration,
) -> Option<std::process::Output> {
    let start = Instant::now();
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return child.wait_with_output().ok();
        }
        if start.elapsed() > timeout {
            #[cfg(windows)]
            crate::runner::terminate_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_claude_auth_status(path: &std::path::Path) -> Result<ClaudeAuthStatus, String> {
    let mut cmd = hidden_command(path);
    cmd.args(["auth", "status"]);
    let child = cmd
        .spawn()
        .map_err(|_| "Could not run Claude CLI to check sign-in status.".to_string())?;
    let output = wait_for_output(child, Duration::from_secs(6))
        .ok_or_else(|| "Timed out checking Claude sign-in status.".to_string())?;
    if let Ok(status) = serde_json::from_slice::<ClaudeAuthStatus>(&output.stdout) {
        return Ok(status);
    }
    Ok(ClaudeAuthStatus {
        logged_in: output.status.success(),
        ..ClaudeAuthStatus::default()
    })
}

pub(crate) fn claude_is_authenticated(path: &std::path::Path) -> bool {
    read_claude_auth_status(path).is_ok_and(|s| s.logged_in)
}

fn claude_authorization_url(screen: &str) -> Option<String> {
    let start = screen
        .find("https://claude.com/cai/oauth/authorize")
        .or_else(|| screen.find("https://platform.claude.com/oauth/authorize"))?;
    // Stop at blank lines or instructions after the wrapped authorize URL.
    let url: String = screen[start..]
        .lines()
        .map(str::trim)
        .take_while(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_graphic()))
        .collect();
    let parsed = tauri::Url::parse(&url).ok()?;
    let valid_host = matches!(
        (parsed.host_str(), parsed.path()),
        (Some("claude.com"), p) if p.starts_with("/cai/oauth/authorize")
    ) || matches!(
        (parsed.host_str(), parsed.path()),
        (Some("platform.claude.com"), p) if p.starts_with("/oauth/authorize")
    );
    (parsed.scheme() == "https"
        && valid_host
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query_pairs().any(|(key, _)| key == "state")
        && parsed.query_pairs().any(|(key, _)| key == "code_challenge"))
    .then_some(url)
}

fn claude_login_error(screen: &str) -> bool {
    let text = screen.to_ascii_lowercase();
    [
        "login failed:",
        "oauth error",
        "authentication failed",
        "invalid_grant",
        "request failed with status code",
        "failed to exchange",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn valid_claude_code(code: &str) -> bool {
    (10..=4096).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.~#=".contains(&b))
}

#[tauri::command]
pub async fn claude_auth_status() -> Result<ClaudeAuthStatus, String> {
    let path = crate::providers::Provider::Claude
        .resolve()
        .ok_or("Install the Claude CLI first.")?;
    tauri::async_runtime::spawn_blocking(move || read_claude_auth_status(&path))
        .await
        .map_err(|_| "Could not check Claude sign-in status.".to_string())?
}

#[tauri::command]
pub async fn claude_auth_logout() -> Result<ClaudeAuthStatus, String> {
    let path = crate::providers::Provider::Claude
        .resolve()
        .ok_or("Install the Claude CLI first.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = hidden_command(&path);
        cmd.args(["auth", "logout"]);
        let child = cmd
            .spawn()
            .map_err(|_| "Could not run Claude sign-out.".to_string())?;
        let output = wait_for_output(child, Duration::from_secs(6))
            .ok_or_else(|| "Timed out signing out of Claude.".to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if err.is_empty() {
                "Could not sign out of Claude.".to_string()
            } else {
                err
            });
        }
        crate::provider_models::invalidate(crate::providers::Provider::Claude);
        read_claude_auth_status(&path)
    })
    .await
    .map_err(|_| "Could not sign out of Claude.".to_string())?
}

#[tauri::command]
pub fn claude_login_start(
    app: tauri::AppHandle,
    state: State<AuthState>,
    id: String,
    mode: Option<String>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid sign-in session.")?;
    let flag = match mode.as_deref() {
        None | Some("claudeai") => "--claudeai",
        Some("console") => "--console",
        Some(_) => return Err("Unsupported Claude sign-in mode.".into()),
    };
    let path = crate::providers::Provider::Claude
        .resolve()
        .ok_or("Install the Claude CLI first.")?;
    let workspace = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Could not open app data.")?
        .join("sign-in");
    std::fs::create_dir_all(&workspace).map_err(|_| "Could not prepare sign-in.")?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 60,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "Could not start sign-in terminal.")?;
    let mut cmd =
        crate::pty::build_command_with_args(&path, &["auth".into(), "login".into(), flag.into()]);
    cmd.cwd(&workspace);
    // Keep browser launch inside the dialog instead of spawning an external window automatically.
    cmd.env("BROWSER", "velum-noop-browser");
    cmd.env("SSH_CONNECTION", "127.0.0.1 1 127.0.0.1 22");
    cmd.env("TERM", "xterm-256color");
    let writer = pair
        .master
        .take_writer()
        .map_err(|_| "Could not attach sign-in input.")?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| "Could not read sign-in progress.")?;
    let mut guard = state.0.lock().unwrap();
    if let Some(previous) = guard.take() {
        previous.finish("cancelled", "Sign-in restarted.");
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|_| "Could not launch Claude sign-in.")?;
    let session = Arc::new(Session {
        id,
        snapshot: Mutex::new(Snapshot {
            phase: "starting",
            url: None,
            message: "Preparing Claude sign-in…",
        }),
        writer: Mutex::new(writer),
        child: Mutex::new(Some(child)),
        _master: Mutex::new(pair.master),
    });
    *guard = Some(session.clone());
    drop(guard);
    let reading = session.clone();
    std::thread::spawn(move || {
        let mut parser = vt100::Parser::new_with_callbacks(60, 200, 0, TerminalReplies::default());
        let mut buf = [0; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || !reading.active() {
                break;
            }
            parser.process(&buf[..n]);
            let replies = std::mem::take(&mut parser.callbacks_mut().0);
            if !replies.is_empty() && reading.write(&replies).is_err() {
                break;
            }
            let screen = parser.screen().contents();
            if claude_login_error(&screen) {
                reading.finish(
                    "error",
                    "Claude could not accept that sign-in. Start again for a fresh code, and check your connection if it keeps failing.",
                );
                break;
            }
            if screen.contains("Paste code") {
                if let Some(url) = claude_authorization_url(&screen) {
                    let mut state = reading.snapshot.lock().unwrap();
                    if state.phase == "starting" {
                        *state = Snapshot {
                            phase: "code",
                            url: Some(url),
                            message:
                                "Sign in with Claude, then paste the code shown in your browser.",
                        };
                    }
                }
            }
        }
        if reading.active() {
            for _ in 0..20 {
                if let Some(ok) = reading.child_success() {
                    if ok {
                        crate::provider_models::invalidate(crate::providers::Provider::Claude);
                        reading.finish("complete", "Claude is connected.");
                    } else {
                        reading.finish(
                            "error",
                            "Claude could not complete sign-in. Start again to get a fresh code.",
                        );
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            reading.finish(
                "error",
                "The sign-in process closed. Start again to get a fresh code.",
            );
        }
    });
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut checking_since = None;
        loop {
            if !session.active() {
                break;
            }
            if let Some(ok) = session.child_success() {
                if ok {
                    crate::provider_models::invalidate(crate::providers::Provider::Claude);
                    session.finish("complete", "Claude is connected.");
                } else {
                    session.finish(
                        "error",
                        "Claude could not accept that sign-in. Start again for a fresh code.",
                    );
                }
                break;
            }
            let phase = session.snapshot.lock().unwrap().phase;
            if phase == "verifying" {
                let since = checking_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(60) {
                    session.finish(
                        "error",
                        "We could not verify the Claude sign-in. Check your connection and start again with a fresh code.",
                    );
                    break;
                }
            }
            if phase == "starting" && started.elapsed() > Duration::from_secs(30) {
                session.finish(
                    "error",
                    "Claude sign-in did not show an authorization URL in time. Start again or run `claude auth login` in the Terminal view.",
                );
                break;
            }
            if started.elapsed() > Duration::from_secs(600) {
                session.finish(
                    "error",
                    "This sign-in expired. Start again to get a fresh code.",
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn claude_login_status(state: State<AuthState>, id: String) -> Result<Snapshot, String> {
    Ok(state.session(&id)?.snapshot.lock().unwrap().clone())
}

#[tauri::command]
pub fn claude_login_submit(
    state: State<AuthState>,
    id: String,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if !valid_claude_code(code) {
        return Err(
            "Paste only the authentication code shown by Claude (including the `#state` suffix if shown), without a URL or extra text."
                .into(),
        );
    }
    let session = state.session(&id)?;
    {
        let mut state = session.snapshot.lock().unwrap();
        if state.phase != "code" {
            return Err(
                "This sign-in is not waiting for a code. Start again if it expired.".into(),
            );
        }
        state.phase = "verifying";
        state.url = None;
        state.message = "Checking your Claude sign-in…";
    }
    if let Err(error) = session.write(&format!("{code}\r")) {
        session.finish("error", "The sign-in session ended. Start again.");
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn claude_login_cancel(state: State<AuthState>, id: String) {
    antigravity_login_cancel(state, id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responds_to_split_console_cursor_queries() {
        let mut parser = vt100::Parser::new_with_callbacks(60, 160, 0, TerminalReplies::default());
        parser.process(b"\x1b[6");
        parser.process(b"n");
        assert_eq!(parser.callbacks().0, "\x1b[1;1R");
    }
    #[test]
    fn wrapped_oauth_url_excludes_terminal_instructions() {
        let text = "Open URL:\n https://accounts.google.com/o/oauth2/auth?state=abc&\n code_challenge=def\n ─────\n authorization code...";
        assert_eq!(
            authorization_url(text).unwrap(),
            "https://accounts.google.com/o/oauth2/auth?state=abc&code_challenge=def"
        );
        assert!(
            authorization_url("https://accounts.google.com/evil@other.example/?state=x").is_none()
        );
    }
    #[test]
    fn only_one_code_can_be_pasted() {
        assert!(valid_code("4/example-code_123"));
        for code in [
            "",
            "https://example.com",
            "code\r/logout",
            "code\x1b[2J",
            "code with spaces",
        ] {
            assert!(!valid_code(code));
        }
    }
    #[test]
    fn redraw_removes_old_prompt_and_keeps_error_detection() {
        let mut parser = vt100::Parser::new(60, 160, 0);
        parser.process(b"Select login method:\r\n> 1. Google OAuth");
        parser.process(b"\x1b[2J\x1b[HGot an error: token exchange failed: invalid_grant");
        let text = parser.screen().contents();
        assert!(login_error(&text));
        assert!(!text.contains("Select login method:"));
    }
    #[test]
    fn wrapped_claude_oauth_url_and_code_validate_cleanly() {
        let screen = "If the browser didn't open, visit:\n https://claude.com/cai/oauth/authorize?code=true&client_id=abc&\n code_challenge=xyz&state=st1\n\nPaste code here if prompted >";
        assert_eq!(
            claude_authorization_url(screen).unwrap(),
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=xyz&state=st1"
        );
        let console_screen = "https://platform.claude.com/oauth/authorize?code=true&code_challenge=c&state=s\nPaste code here if prompted >";
        assert_eq!(
            claude_authorization_url(console_screen).unwrap(),
            "https://platform.claude.com/oauth/authorize?code=true&code_challenge=c&state=s"
        );
        assert!(claude_authorization_url(
            "https://evil.example/cai/oauth/authorize?state=s&code_challenge=c"
        )
        .is_none());
        assert!(valid_claude_code("abc123_XYZ#state_part-99=="));
        assert!(!valid_claude_code(
            "https://platform.claude.com/oauth/code/callback?code=a"
        ));
        assert!(!valid_claude_code("code with space"));
        assert!(claude_login_error(
            "Login failed: Request failed with status code 400"
        ));
    }
}
