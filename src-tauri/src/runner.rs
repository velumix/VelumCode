//! One provider process per turn, bound to its tab and workspace.
//! Provider streams share one event vocabulary for desktop, phone and notifications.
//! Resume IDs come from the selected CLI; stderr is drained concurrently.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::child_process::{self, SharedChild};
use crate::events::AgentEvent;
use crate::provider_events::Stream;
use crate::provider_models::RunOptions;
use crate::providers::{self, Provider};
use crate::pty::home_dir;

/// Last stderr lines retained for failure diagnosis.
const STDERR_TAIL_LINES: usize = 30;

pub struct AgentSession {
    measurement_clock: Mutex<Option<std::time::Instant>>,
    measurement: Mutex<Option<Arc<Mutex<crate::tool_bridge::Measurement>>>>,
    tool_scope: Mutex<Option<std::sync::Weak<crate::tool_bridge::Scope>>>,
    interactions: Mutex<Option<Arc<crate::interactions::Broker>>>,
    registration: u64,
    access: Mutex<AccessState>,
    bot_id: Option<String>,
    bot_identity: Mutex<Option<crate::bots::Identity>>,
    task_id: Option<String>,
    shared_memory: Mutex<crate::memory::Session>,
    tab_id: String,
    session_id: Mutex<String>,
    provider: Provider,
    options: Mutex<RunOptions>,
    memory: Mutex<crate::memory::Session>,
    workspace: std::path::PathBuf,
    child: Mutex<Option<Arc<SharedChild>>>,
    running: Mutex<bool>,
    queue: Mutex<crate::message_queue::Snapshot>,
    prompt: Mutex<Option<std::path::PathBuf>>,
}

struct AccessState {
    fresh_session_pending: bool,
    requested: bool,
    applied: Option<bool>,
    revision: u64,
    host: Option<crate::workspace_access::Report>,
    agent: crate::workspace_access::Report,
    restrictions: serde_json::Value,
}

/// If staging or launching fails, publish untested evidence and cleanup results
/// instead of leaving the diagnostics panel stuck on a running probe.
struct PendingProbe {
    probe: Option<crate::workspace_access::Probe>,
    session: Arc<AgentSession>,
}
impl Drop for PendingProbe {
    fn drop(&mut self) {
        if let Some(probe) = self.probe.as_mut() {
            self.session.access.lock().unwrap().agent = probe.finish();
        }
    }
}
impl AccessState {
    fn new(workspace: &std::path::Path, provider: Provider, applied: Option<bool>) -> Self {
        Self {
            fresh_session_pending: false,
            requested: false,
            applied,
            revision: 0,
            host: None,
            agent: crate::workspace_access::Report::untested(
                workspace,
                format!("{} agent tools", provider.label()),
                false,
                0,
            ),
            restrictions: serde_json::json!({"status":"untested","detail":"No effective provider metadata observed in this process."}),
        }
    }
    fn change(&mut self, yolo: bool, has_resume: bool) -> bool {
        let reset = self.requested != yolo
            || self.applied.is_some_and(|mode| mode != yolo)
            || (has_resume && self.applied.is_none() && !self.fresh_session_pending);
        if reset {
            self.revision += 1;
            self.agent.invalidate(self.revision, yolo);
            self.host = None;
            self.restrictions = serde_json::json!({"status":"untested","detail":"Permission mode changed; a new provider session is required."});
            self.applied = None;
            self.fresh_session_pending = true;
        }
        self.requested = yolo;
        reset
    }
    fn value(&self, sanitized: bool) -> serde_json::Value {
        let report = |r: &crate::workspace_access::Report| {
            if sanitized {
                crate::workspace_access::sanitized(r)
            } else {
                serde_json::to_value(r).unwrap()
            }
        };
        serde_json::json!({"host":self.host.as_ref().map(report),"agent":report(&self.agent),
            "permissions":{"requested_mode":crate::workspace_access::mode(self.requested),"launched_mode":self.applied.map(crate::workspace_access::mode),"revision":self.revision,"effective":self.restrictions,
            "session_transition":"Mode changes start a fresh provider conversation. The visible transcript remains; previous provider context is not replayed."}})
    }
    fn observe_session(&mut self, previous: &str, current: &str) -> bool {
        if previous.is_empty() || previous == current {
            return false;
        }
        self.revision += 1;
        self.agent.invalidate(self.revision, self.requested);
        self.host = None;
        self.restrictions = serde_json::json!({"status":"untested","detail":"Provider session changed; earlier access evidence was invalidated."});
        true
    }
}

#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, Arc<AgentSession>>>,
    terminal_leases: Arc<Mutex<HashMap<String, (String, std::path::PathBuf)>>>,
    next_registration: AtomicU64,
    updating: AtomicBool,
    startup_pending: AtomicBool,
}

pub struct TerminalContinuation {
    pub provider: Provider,
    pub options: RunOptions,
    pub workspace: std::path::PathBuf,
    pub session_id: String,
    pub lease: TerminalLease,
}
pub struct TerminalLease {
    pub tab_id: String,
    key: String,
    leases: Arc<Mutex<HashMap<String, (String, std::path::PathBuf)>>>,
}
impl Drop for TerminalLease {
    fn drop(&mut self) {
        if let Ok(mut leases) = self.leases.lock() {
            leases.remove(&self.key);
        }
    }
}

impl AgentSession {
    fn stop(&self) {
        if let Some(broker) = self.interactions.lock().ok().and_then(|b| b.clone()) {
            broker.close("This turn was stopped. Its requests can no longer be answered.");
        }
        if let Some(scope) = self
            .tool_scope
            .lock()
            .ok()
            .and_then(|s| s.as_ref().and_then(std::sync::Weak::upgrade))
        {
            scope.revoked.store(true, Ordering::Relaxed);
        }
        let child = self.child.lock().ok().and_then(|mut child| child.take());
        let prompt = self.prompt.lock().ok().and_then(|mut file| file.take());
        if let Some(child) = child {
            child.stop();
        }
        // App exit may end reader threads before their guards can drop.
        if let Some(file) = prompt {
            drop(StagedPrompt(file));
        }
    }
}

impl AgentState {
    pub fn reserve_terminal(
        &self,
        app: &AppHandle,
        tab: &str,
    ) -> Result<TerminalContinuation, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Agent state unavailable.")?;
        if self.work_blocked() {
            return Err("Velum is not ready to start a terminal.".into());
        }
        let session = sessions
            .values()
            .filter(|s| s.tab_id == tab)
            .max_by_key(|s| s.registration)
            .ok_or("Open the saved chat before continuing in terminal.")?;
        if !matches!(session.provider, Provider::Muse | Provider::Antigravity) {
            return Err("Terminal continuation is unavailable for this provider.".into());
        }
        if *session.running.lock().unwrap() || session.child.lock().unwrap().is_some() {
            return Err(
                "Stop the headless turn and wait for it to finish before continuing in terminal."
                    .into(),
            );
        }
        if !session.queue.lock().unwrap().items.is_empty() {
            return Err("Finish or clear queued messages before continuing in terminal.".into());
        }
        if sessions.iter().any(|(id, other)| {
            *other.running.lock().unwrap()
                && other.workspace == session.workspace
                && app.state::<crate::automation::Store>().managed(id)
        }) {
            return Err(
                "Wait for scheduled work in this project before opening a continued terminal."
                    .into(),
            );
        }
        let session_id = session.session_id.lock().unwrap().clone();
        uuid::Uuid::parse_str(&session_id)
            .map_err(|_| "This conversation has no saved provider session yet.")?;
        let key = format!("{}:{session_id}", session.provider.command());
        let mut leases = self
            .terminal_leases
            .lock()
            .map_err(|_| "Terminal ownership unavailable.")?;
        if leases.contains_key(&key) || leases.values().any(|(owner, _)| owner == tab) {
            return Err("This conversation is already open in a terminal.".into());
        }
        leases.insert(key.clone(), (tab.into(), session.workspace.clone()));
        let options = session.options.lock().unwrap().clone();
        Ok(TerminalContinuation {
            provider: session.provider,
            options,
            workspace: session.workspace.clone(),
            session_id,
            lease: TerminalLease {
                tab_id: tab.into(),
                key,
                leases: self.terminal_leases.clone(),
            },
        })
    }

    fn terminal_owns(&self, session: &AgentSession) -> bool {
        let key = format!(
            "{}:{}",
            session.provider.command(),
            session.session_id.lock().unwrap()
        );
        self.terminal_leases
            .lock()
            .unwrap()
            .iter()
            .any(|(id, (tab, _))| id == &key || tab == &session.tab_id)
    }
    pub fn set_startup_pending(&self, pending: bool) {
        self.startup_pending.store(pending, Ordering::SeqCst);
    }

    pub fn startup_pending(&self) -> bool {
        self.startup_pending.load(Ordering::SeqCst)
    }

    pub fn work_blocked(&self) -> bool {
        self.startup_pending() || self.updating.load(Ordering::SeqCst)
    }

    /// Registration and update admission share the sessions lock. A queued,
    /// remote, or scheduled send cannot slip between the idle check and restart.
    pub fn begin_update(&self) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Agent state unavailable.")?;
        if !self.terminal_leases.lock().unwrap().is_empty() {
            return Err(
                "Close continued terminal conversations before restarting to update.".into(),
            );
        }
        for session in sessions.values() {
            let running = *session
                .running
                .lock()
                .map_err(|_| "Agent state unavailable.")?;
            let queue = session
                .queue
                .lock()
                .map_err(|_| "Message queue unavailable.")?;
            if running || (!queue.paused && !queue.items.is_empty()) {
                return Err("Finish or stop running conversations and pause pending queues before restarting to update.".into());
            }
        }
        self.updating.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn cancel_update(&self) {
        self.updating.store(false, Ordering::SeqCst);
    }

    pub fn measurement(&self, id: &str, workspace: &std::path::Path) -> Option<serde_json::Value> {
        let session = self.sessions.lock().ok()?.get(id)?.clone();
        if std::fs::canonicalize(&session.workspace).ok()?
            != std::fs::canonicalize(workspace).ok()?
        {
            return None;
        }
        let measurement = session.measurement.lock().ok()?.clone()?;
        let mut measurement = measurement.lock().ok()?.clone();
        if !measurement.finished {
            if let Some(clock) = session.measurement_clock.lock().ok()?.as_ref() {
                measurement.elapsed_ms = clock.elapsed().as_millis().min(u64::MAX as u128) as u64;
            }
        }
        let value = measurement.value();
        Some(value)
    }
    pub fn record_host(
        &self,
        id: &str,
        workspace: &std::path::Path,
        report: crate::workspace_access::Report,
    ) {
        if let Some(session) = self.sessions.lock().unwrap().get(id) {
            if session.workspace == workspace {
                session.access.lock().unwrap().host = Some(report);
            }
        }
    }
    pub fn access(
        &self,
        id: &str,
        workspace: &std::path::Path,
        sanitized: bool,
    ) -> Option<serde_json::Value> {
        let session = self.sessions.lock().ok()?.get(id)?.clone();
        if std::fs::canonicalize(&session.workspace).ok()?
            != std::fs::canonicalize(workspace).ok()?
        {
            return None;
        }
        let value = session.access.lock().ok()?.value(sanitized);
        Some(value)
    }
    /// Provider and requested permission mode for a session bound to this
    /// workspace. Diagnostics guidance must reflect the actual session, never
    /// a hardcoded provider or mode.
    pub fn session_context(
        &self,
        id: &str,
        workspace: &std::path::Path,
    ) -> Option<(Provider, bool)> {
        let session = self.sessions.lock().ok()?.get(id)?.clone();
        if std::fs::canonicalize(&session.workspace).ok()?
            != std::fs::canonicalize(workspace).ok()?
        {
            return None;
        }
        let requested = session.access.lock().ok()?.requested;
        Some((session.provider, requested))
    }
    pub fn stop_id(&self, id: &str) {
        let session = self.sessions.lock().ok().and_then(|s| s.get(id).cloned());
        if let Some(s) = session {
            s.stop();
        }
    }
    pub fn review_wait(&self, id: &str) -> (bool, u64) {
        let session = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(id).cloned());
        let broker = session.and_then(|session| {
            session
                .interactions
                .lock()
                .ok()
                .and_then(|value| value.clone())
        });
        broker
            .map(|broker| (broker.waiting(), broker.waited_seconds()))
            .unwrap_or_default()
    }
    pub fn workspace_busy(&self, workspace: &str) -> bool {
        let workspace = std::fs::canonicalize(workspace).ok();
        let busy = self.sessions.lock().unwrap().values().any(|s| {
            *s.running.lock().unwrap() && std::fs::canonicalize(&s.workspace).ok() == workspace
        });
        busy || self
            .terminal_leases
            .lock()
            .unwrap()
            .values()
            .any(|(_, path)| std::fs::canonicalize(path).ok() == workspace)
    }
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct NewInfo {
    pub live: Option<LiveInfo>,
    pub bot: Option<crate::bots::Identity>,
    pub id: String,
    pub session_id: String,
    pub workspace: String,
    pub workspace_notice: Option<String>,
    pub restored: Vec<AgentEvent>,
    pub truncated: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct LiveInfo {
    revision: u64,
    running: bool,
    yolo: bool,
    terminal: bool,
    queue: crate::message_queue::Snapshot,
}

#[derive(serde::Serialize, Clone)]
pub struct TurnInfo {
    pub id: String,
    pub turn_id: String,
    pub queued: bool,
}

fn emit(app: &AppHandle, id: &str, event: AgentEvent) {
    let seq = app
        .state::<crate::session_log::SessionLog>()
        .record(id, &event);
    app.state::<crate::history::HistoryState>().mark(id);
    crate::remote::changed(app);
    // Emit failures mean the window is gone; nothing left to report to.
    let _ = app.emit(
        "agent-event",
        serde_json::json!({ "id": id, "seq":seq, "event": event }),
    );
}

fn publish_interactions(app: &AppHandle, id: &str, broker: &crate::interactions::Broker) {
    let snapshot = broker.snapshot();
    app.state::<crate::session_log::SessionLog>()
        .interactions_changed(id, broker.waiting());
    let _ = app.emit(
        "agent-interactions",
        serde_json::json!({"id":id,"snapshot":snapshot}),
    );
    crate::remote::changed(app);
}

pub fn interactions_snapshot(
    app: &AppHandle,
    id: &str,
) -> Result<crate::interactions::Snapshot, String> {
    let state = app.state::<AgentState>();
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Agent state unavailable.")?
        .get(id)
        .cloned()
        .ok_or("Conversation is unavailable.")?;
    let broker = session
        .interactions
        .lock()
        .map_err(|_| "Approval state unavailable.")?
        .clone();
    Ok(broker.map(|b| b.snapshot()).unwrap_or_default())
}

pub fn respond_interaction(
    app: &AppHandle,
    id: &str,
    decision: crate::interactions::Decision,
    source: &str,
) -> Result<crate::interactions::Snapshot, String> {
    let state = app.state::<AgentState>();
    // Share the admission lock with Stop/replacement. The adapter checks the
    // turn generation again immediately before writing the provider command.
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Agent state unavailable.")?;
    let session = sessions.get(id).ok_or("Conversation is unavailable.")?;
    let broker = session
        .interactions
        .lock()
        .map_err(|_| "Approval state unavailable.")?
        .clone()
        .ok_or("This turn has no interactive requests.")?;
    let snapshot = broker.respond(decision, source)?;
    publish_interactions(app, id, &broker);
    Ok(snapshot)
}

#[tauri::command]
pub fn agent_interactions(
    app: AppHandle,
    id: String,
) -> Result<crate::interactions::Snapshot, String> {
    interactions_snapshot(&app, &id)
}

#[tauri::command]
pub fn agent_respond(
    app: AppHandle,
    id: String,
    decision: crate::interactions::Decision,
) -> Result<crate::interactions::Snapshot, String> {
    respond_interaction(&app, &id, decision, "desktop")
}

/// Filename-safe fragment derived from a tab id.
fn safe_fragment(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn prompt_file(id: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join(format!("velum-code-{}", safe_fragment(id)))
        .join("prompt.txt")
}

/// Each turn owns its staging file. Failed spawns and completed turns both
/// remove it, without racing a replacement turn or retaining prompt text.
struct StagedPrompt(std::path::PathBuf);
impl Drop for StagedPrompt {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

/// Resolve the workspace for a new agent session: an explicit directory
/// must exist, otherwise the tab falls back to the user's home directory
/// (the historical default).
pub(crate) fn resolve_workspace(workspace: Option<String>) -> Result<std::path::PathBuf, String> {
    match workspace
        .map(|w| w.trim().to_owned())
        .filter(|w| !w.is_empty())
    {
        None => Ok(home_dir()),
        Some(dir) => {
            let path = std::path::PathBuf::from(&dir);
            if !path.is_dir() {
                return Err(format!("workspace is not a directory: {dir}"));
            }
            let canonical = std::fs::canonicalize(&path)
                .map_err(|e| format!("Cannot resolve the selected project: {e}"))?;
            // Keep Windows paths usable in CLI prompts and PowerShell LiteralPath.
            #[cfg(windows)]
            let canonical = {
                let text = canonical.display().to_string();
                if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
                    std::path::PathBuf::from(format!(r"\\{unc}"))
                } else {
                    std::path::PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
                }
            };
            Ok(canonical)
        }
    }
}

#[tauri::command]
pub fn agent_validate_workspace(workspace: Option<String>) -> Result<String, String> {
    let path = resolve_workspace(workspace)?;
    if !crate::app_context::readable(&path) {
        return Err(
            "Velum cannot list this folder. Choose another project or check Windows folder access."
                .into(),
        );
    }
    Ok(path.display().to_string())
}

fn headless_permission_denied(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("permission")
        && (text.contains("auto-denied")
            || text.contains("soft-denied")
            || (text.contains("headless") && text.contains("cannot prompt")))
}

fn mark_permission_blocked(terminal: &mut Option<AgentEvent>, denied: bool) {
    if let Some(AgentEvent::TurnEnd { status, reason, .. }) = terminal {
        if denied && status != "cancelled" {
            *status = "blocked".into();
            *reason = Some("Antigravity blocked a tool because headless mode cannot ask for permission. On the desktop, choose Continue this conversation in terminal to answer native prompts. If needed, review /permissions or a scoped permissions.allow rule such as command(...) before retrying. Scheduled work is paused; partial output is not a completed task.".into());
        }
    }
}

/// Stop the current turn's process tree. Its supervisor observes the stop
/// even if a descendant has kept an output pipe open.
fn kill_session(state: &State<AgentState>, id: &str) {
    let session = state
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(id).cloned());
    if let Some(session) = session {
        session.stop();
    }
}

/// Kill a child and its whole process tree, then reap it. Tree kill matters
/// on Windows: `muse` usually resolves to a `.cmd` shim, so the direct child
/// is `cmd` with `powershell`/`muse-bin` grandchildren. Killing only `cmd`
/// orphans them; they keep stdout open, the reader never sees EOF, and the
/// turn never ends (bricking the tab until the orphan exits on its own).
#[cfg(windows)]
pub(crate) fn terminate_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // taskkill /T terminates descendants first. Hidden like the exec spawn
    // itself so stopping a turn never flashes a console.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Bound provider inactivity and allow a short drain after process exit or
/// a terminal event. These timers live only in the owning turn's supervisor.
pub const SILENCE_WARN_MS: u64 = 120_000;
pub const SILENCE_FAIL_MS: u64 = 600_000;
const OUTPUT_DRAIN_MS: u64 = 2_000;
const PROCESS_POLL_MS: u64 = 20;

#[derive(PartialEq, Eq, Debug)]
pub enum Silence {
    Active,
    Warn,
    Expired,
}

pub fn silence_state(silent_ms: u64) -> Silence {
    if silent_ms >= SILENCE_FAIL_MS {
        Silence::Expired
    } else if silent_ms >= SILENCE_WARN_MS {
        Silence::Warn
    } else {
        Silence::Active
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Supervision {
    Continue,
    Warn,
    Expired,
    Finish,
}
struct Supervisor {
    last_output: std::time::Instant,
    settling: Option<std::time::Instant>,
    warned: bool,
}
impl Supervisor {
    fn new(started: std::time::Instant) -> Self {
        Self {
            last_output: started,
            settling: None,
            warned: false,
        }
    }
    fn observe(
        &mut self,
        now: std::time::Instant,
        activity: bool,
        terminal: bool,
        child: child_process::Status,
        pipes_closed: bool,
    ) -> Supervision {
        if activity {
            self.last_output = now;
        }
        if child != child_process::Status::Running || terminal {
            let settling = *self.settling.get_or_insert(now);
            if (pipes_closed && child != child_process::Status::Running)
                || now.saturating_duration_since(settling).as_millis() >= OUTPUT_DRAIN_MS as u128
            {
                return Supervision::Finish;
            }
            return Supervision::Continue;
        }
        let silent_ms = now
            .saturating_duration_since(self.last_output)
            .as_millis()
            .min(u64::MAX as u128) as u64;
        match silence_state(silent_ms) {
            Silence::Expired => Supervision::Expired,
            Silence::Warn if !self.warned => {
                self.warned = true;
                Supervision::Warn
            }
            _ => Supervision::Continue,
        }
    }
}

fn resolve_terminal(
    provider: Provider,
    terminal: Option<AgentEvent>,
    exit: Option<Option<i32>>,
    supervisor_failure: Option<String>,
    terminal_cleanup: bool,
    stderr: Option<String>,
) -> AgentEvent {
    let completed =
        matches!(&terminal, Some(AgentEvent::TurnEnd { status, .. }) if status == "completed");
    // A completion already read from this turn survives our own cleanup.
    // A user stop and an independently reported nonzero exit retain their
    // normal meaning.
    if (exit.is_none() || exit == Some(Some(0)))
        && ((terminal_cleanup && terminal.is_some()) || (completed && supervisor_failure.is_some()))
    {
        return terminal.unwrap();
    }
    if let Some(reason) = supervisor_failure {
        return AgentEvent::TurnEnd {
            status: "failed".into(),
            text: None,
            reason: Some(reason),
        };
    }
    if exit == Some(Some(0)) {
        if let Some(terminal) = terminal {
            return terminal;
        }
        return AgentEvent::TurnEnd {
            status: "failed".into(),
            text: None,
            reason: Some(format!("{} ended without a completion event. Open Terminal to check its sign-in and setup.", provider.label())),
        };
    }
    let (status, reason) = match exit {
        Some(code) => {
            let structured = match terminal {
                Some(AgentEvent::TurnEnd {
                    reason: Some(reason),
                    ..
                }) if !reason.is_empty() => Some(reason),
                _ => None,
            };
            (
                "failed",
                Some(structured.or(stderr).unwrap_or_else(|| {
                    format!("{} exited unexpectedly (code {code:?})", provider.label())
                })),
            )
        }
        None => ("cancelled", None),
    };
    AgentEvent::TurnEnd {
        status: status.into(),
        text: None,
        reason,
    }
}

struct TurnContext {
    child: Arc<SharedChild>,
    control: Option<crate::provider_control::Client>,
    tools: Option<crate::tool_bridge::Registration>,
    measurement: Arc<Mutex<crate::tool_bridge::Measurement>>,
    probe: Option<crate::workspace_access::Probe>,
    memory_mode: crate::memory::Capture,
    action_context: Option<crate::bot_actions::Context>,
    started: std::time::Instant,
    started_at: i64,
    usage_session: String,
    usage_baseline: Option<crate::provider_usage::TurnUsage>,
    muse_offset: u64,
}
fn spawn_reader(
    app: AppHandle,
    id: String,
    session: Arc<AgentSession>,
    prompt: StagedPrompt,
    mut output: child_process::Output,
    context: TurnContext,
) {
    let TurnContext {
        child,
        mut control,
        tools,
        measurement,
        mut probe,
        memory_mode,
        action_context,
        started,
        started_at,
        usage_session,
        usage_baseline,
        muse_offset,
    } = context;
    // Both pipes are polled by the supervisor. Neither a blocked read nor a
    // stderr-thread join can prevent this turn from reaching its deadline.
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let probe_errors: Arc<Mutex<HashMap<&'static str, crate::workspace_access::OperationFailure>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let probe_id = probe.as_ref().map(|p| p.id.clone());
    let permission_denied = Arc::new(std::sync::atomic::AtomicBool::new(false));

    std::thread::spawn(move || {
        let state = app.state::<AgentState>();
        let mut fold = Stream::new(session.provider);
        let mut turn_usage = None;
        let stdout_usage = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let muse_run = Arc::new(Mutex::new(None::<String>));
        // Exec does not stream context counters on stdout. Watch only this
        // thread's numeric metadata, and join before publishing completion.
        let (usage_stop, usage_receiver) = std::sync::mpsc::channel::<u64>();
        let usage_handle =
            (matches!(session.provider, Provider::Codex | Provider::Muse) && control.is_none()).then(|| {
                let app = app.clone();
                let session = Arc::clone(&session);
                let id = id.clone();
                let stdout_usage = Arc::clone(&stdout_usage);
                let muse_run = Arc::clone(&muse_run);
                let measurement = Arc::clone(&measurement);
                std::thread::spawn(move || {
                    let mut last = None;
                    let mut last_turn = None;
                    let mut last_total = None;
                    let mut known_session = usage_session.clone();
                    let mut baseline = usage_baseline;
                    let mut path = None;
                    let mut muse_usage = crate::provider_usage::MuseUsage::new(muse_offset);
                    loop {
                        let completed_ms =
                            match usage_receiver.recv_timeout(std::time::Duration::from_secs(1)) {
                                Ok(elapsed) => Some(elapsed),
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                    Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64)
                                }
                            };
                        if session.provider == Provider::Muse {
                            if path.is_none() {
                                path = crate::provider_usage::muse_session_file(&usage_session);
                            }
                            let run = muse_run.lock().unwrap().clone();
                            if let Some((path, run)) = path.as_deref().zip(run.as_deref()) {
                                let usage = if completed_ms.is_some() {
                                    muse_usage.finish(path, &usage_session, run)
                                } else {
                                    muse_usage.poll(path, &usage_session, run)
                                };
                                if let Some(mut usage) = usage {
                                    usage.elapsed_ms = Some(completed_ms.unwrap_or_else(|| {
                                        started.elapsed().as_millis().min(u64::MAX as u128) as u64
                                    }));
                                    let sessions = app.state::<AgentState>();
                                    let sessions = sessions.sessions.lock().unwrap();
                                    if sessions.get(&id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                                        measurement.lock().unwrap().observe_usage(
                                            usage.clone(),
                                            "Muse retained session records; current session and root run only",
                                        );
                                        emit(
                                            &app,
                                            &id,
                                            AgentEvent::Usage {
                                                context: muse_usage.context_estimate(),
                                                turn: Some(usage.clone()),
                                            },
                                        );
                                    }
                                    last_turn = Some(usage);
                                }
                            }
                            if completed_ms.is_some() {
                                return (last_turn, last_total, baseline);
                            }
                            continue;
                        }
                        let resume = session.session_id.lock().unwrap().clone();
                        if known_session != resume {
                            known_session = resume;
                            path = None;
                            last = None;
                            last_turn = None;
                            last_total = None;
                            baseline = Some(crate::provider_usage::TurnUsage::zero());
                        }
                        if path.is_none() && !known_session.is_empty() {
                            path = crate::provider_usage::codex_session_file(&known_session);
                        }
                        let snapshot = path
                            .as_deref()
                            .and_then(|p| crate::provider_usage::codex_usage(p, started_at));
                        if let Some(snapshot) =
                            snapshot.filter(|s| last.as_ref() != Some(&s.context))
                        {
                            let elapsed_ms = completed_ms.unwrap_or_else(|| {
                                started.elapsed().as_millis().min(u64::MAX as u128) as u64
                            });
                            let turn = snapshot
                                .total
                                .as_ref()
                                .zip(baseline.as_ref())
                                .map(|(total, baseline)| total.since(baseline, elapsed_ms));
                            let state = app.state::<AgentState>();
                            let sessions = state.sessions.lock().unwrap();
                            if sessions.get(&id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                                {
                                    let mut measured = measurement.lock().unwrap();
                                    if !stdout_usage.load(Ordering::Relaxed) {
                                        if let Some(usage) = turn.clone() {
                                            measured.observe_usage(
                                                usage,
                                                "Codex retained session delta; launch baseline excludes earlier turns",
                                            );
                                        }
                                    }
                                }
                                emit(
                                    &app,
                                    &id,
                                    AgentEvent::Usage {
                                        context: Some(snapshot.context.clone()),
                                        turn: (!stdout_usage.load(Ordering::Relaxed))
                                            .then(|| turn.clone())
                                            .flatten(),
                                    },
                                );
                            }
                            last = Some(snapshot.context);
                            last_total = snapshot.total;
                            if turn.is_some() {
                                last_turn = turn;
                            }
                        }
                        if let Some(elapsed_ms) = completed_ms {
                            if let Some(turn) = last_turn.as_mut() {
                                turn.elapsed_ms = Some(elapsed_ms);
                                let state = app.state::<AgentState>();
                                let sessions = state.sessions.lock().unwrap();
                                if !stdout_usage.load(Ordering::Relaxed)
                                    && sessions.get(&id).is_some_and(|s| Arc::ptr_eq(s, &session))
                                {
                                    emit(
                                        &app,
                                        &id,
                                        AgentEvent::Usage {
                                            context: None,
                                            turn: Some(turn.clone()),
                                        },
                                    );
                                }
                            }
                            return (last_turn, last_total, baseline);
                        }
                    }
                })
            });
        let mut supervisor = Supervisor::new(started);
        let mut supervisor_failure = None;
        let mut terminal_cleanup = false;
        let mut exit = None;
        let mut terminal = None;
        let mut memory_filter = crate::memory::Filter::default();
        let mut final_proposal = None;
        let mut invalid_proposal = false;
        let mut bot_output = crate::bot_actions::Output::default();
        let mut final_action = None;
        let mut invalid_action = false;
        let mut answer = String::new();
        let mut action_error = None;
        let mut action_report = None;
        let mut interaction_revision = u64::MAX;
        let mut interaction_notified = std::collections::HashSet::new();
        'reader: loop {
            let batch = match output.poll() {
                Ok(batch) => batch,
                Err(error) => {
                    supervisor_failure = Some(format!(
                        "Could not read {} output: {error}. Check the Terminal view, then retry.",
                        session.provider.label()
                    ));
                    break;
                }
            };
            for line in batch.stderr {
                if let Some(id) = &probe_id {
                    for error in crate::workspace_access::error_evidence(id, &line) {
                        probe_errors.lock().unwrap().insert(error.operation, error);
                    }
                }
                if headless_permission_denied(&line) {
                    permission_denied.store(true, Ordering::Relaxed);
                }
                let mut tail = stderr_tail.lock().unwrap();
                tail.push(line.chars().take(4000).collect());
                let len = tail.len();
                if len > STDERR_TAIL_LINES {
                    tail.drain(..len - STDERR_TAIL_LINES);
                }
            }
            for line in batch.stdout {
                if let Some(probe) = probe.as_mut() {
                    probe.observe_line(session.provider, &line);
                }
                let events = if let Some(client) = control.as_mut() {
                    match client.observe_line(&line) {
                        Ok(events) => events,
                        Err(error) => {
                            if client.broker().snapshot().active {
                                supervisor_failure = Some(error);
                            }
                            break 'reader;
                        }
                    }
                } else {
                    fold.fold_line(&line)
                };
                if let Some(client) = control.as_ref() {
                    fold.session_id.clone_from(client.session_id());
                    fold.run_id.clone_from(client.run_id());
                    if let Some(effective) = client.effective() {
                        session.access.lock().unwrap().restrictions = effective.clone();
                    }
                }
                {
                    let mut measured = measurement.lock().unwrap();
                    let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    if !events.is_empty() && measured.first_event_ms.is_none() {
                        measured.first_event_ms = Some(elapsed);
                    }
                    if events.iter().any(
                        |e| matches!(e, AgentEvent::AssistantDelta { text } if !text.is_empty()),
                    ) && measured.first_output_ms.is_none()
                    {
                        measured.first_output_ms = Some(elapsed);
                    }
                    measured.elapsed_ms = elapsed;
                }
                if fold.run_id.is_some() {
                    *muse_run.lock().unwrap() = fold.run_id.clone();
                }
                if let Some(resume_id) = &fold.session_id {
                    let mut previous = session.session_id.lock().unwrap();
                    let mut access = session.access.lock().unwrap();
                    if access.observe_session(&previous, resume_id) {
                        if let Some(probe) = probe.as_mut() {
                            probe.report.revision = access.revision;
                            access.agent = probe.report.clone();
                        }
                    }
                    *previous = resume_id.clone();
                    drop(access);
                    drop(previous);
                    app.state::<crate::history::HistoryState>()
                        .resume_id(&id, resume_id);
                }
                for mut event in events {
                    if let AgentEvent::Usage {
                        turn: Some(usage), ..
                    } = &mut event
                    {
                        // Exec completion describes this turn, including resume.
                        // Session-log totals are only a fallback/live estimate.
                        usage.elapsed_ms =
                            Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
                        turn_usage = Some(usage.clone());
                        let mut measured = measurement.lock().unwrap();
                        stdout_usage.store(true, Ordering::Relaxed);
                        measured.observe_usage(
                            usage.clone(),
                            "provider stdout completion/step counters",
                        );
                    }
                    if matches!(&event, AgentEvent::ToolEnd { reason: Some(reason), .. } | AgentEvent::TurnEnd { reason: Some(reason), .. } if headless_permission_denied(reason))
                    {
                        permission_denied.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    if action_context.is_some() {
                        if let AgentEvent::AssistantDelta { text } = &mut event {
                            *text = bot_output.push(text);
                            if text.is_empty() {
                                continue;
                            }
                        }
                        if let AgentEvent::TurnEnd {
                            text: Some(text), ..
                        } = &mut event
                        {
                            let mut output = crate::bot_actions::Output::default();
                            let mut clean = output.push(text);
                            clean.push_str(&output.finish());
                            *text = clean;
                            final_action = output.action;
                            final_proposal = output.memory;
                            invalid_action |= output.invalid;
                        }
                    } else if memory_mode != crate::memory::Capture::Manual {
                        if let AgentEvent::AssistantDelta { text } = &mut event {
                            *text = memory_filter.push(text);
                            if text.is_empty() {
                                continue;
                            }
                        }
                        if let AgentEvent::TurnEnd {
                            text: Some(text), ..
                        } = &mut event
                        {
                            let (clean, proposal, invalid) = crate::memory::clean_final(text);
                            *text = clean;
                            final_proposal = proposal;
                            invalid_proposal |= invalid;
                        }
                    }
                    match &event {
                        AgentEvent::AssistantDelta { text } => {
                            if answer.len() < 16000 {
                                answer.extend(text.chars().take(16000 - answer.len()));
                            }
                        }
                        AgentEvent::TurnEnd {
                            text: Some(text), ..
                        } if !text.is_empty() => answer = text.chars().take(16000).collect(),
                        _ => {}
                    }
                    if matches!(event, AgentEvent::TurnEnd { .. }) {
                        terminal = Some(event);
                    } else if state.sessions.lock().ok().is_some_and(|sessions| {
                        sessions
                            .get(&id)
                            .is_some_and(|current| Arc::ptr_eq(current, &session))
                    }) {
                        emit(&app, &id, event);
                    }
                }
            }
            if let Some(client) = control.as_mut() {
                if client.broker().snapshot().active {
                    if let Err(error) = client.poll() {
                        supervisor_failure = Some(error);
                        break;
                    }
                }
                let snapshot = client.broker().snapshot();
                if snapshot.revision != interaction_revision {
                    let mut new_request = false;
                    for request in snapshot
                        .requests
                        .iter()
                        .filter(|request| request.status == "pending")
                    {
                        // Mark every pending request, not just the first new
                        // one: `any` would short-circuit and re-notify later.
                        new_request |=
                            interaction_notified.insert((request.id.clone(), request.revision));
                    }
                    if new_request {
                        crate::desktop::notify_turn(&app, &session.tab_id, "awaiting_review");
                    }
                    interaction_revision = snapshot.revision;
                    publish_interactions(&app, &id, client.broker());
                }
            }
            let waiting = control
                .as_ref()
                .is_some_and(|client| client.broker().waiting());
            if waiting {
                supervisor.warned = false;
            }
            let status = match child.status() {
                Ok(status) => status,
                Err(error) => {
                    supervisor_failure = Some(format!(
                        "Could not check {} process: {error}. Check the Terminal view, then retry.",
                        session.provider.label()
                    ));
                    break;
                }
            };
            if let child_process::Status::Exited(code) = status {
                exit = Some(code);
            }
            match supervisor.observe(
                std::time::Instant::now(),
                batch.activity || waiting,
                terminal.is_some() && control.as_ref().is_none_or(|client| client.settling()),
                status,
                output.closed(),
            ) {
                Supervision::Continue => {}
                Supervision::Warn => {
                    let sessions = state.sessions.lock().unwrap();
                    if sessions
                        .get(&id)
                        .is_some_and(|live| Arc::ptr_eq(live, &session))
                    {
                        emit(&app, &id, AgentEvent::Notice {
                            text: format!("No output from {} for 2 minutes — still waiting. You can stop the turn and retry, or check the Terminal view.", session.provider.label()),
                        });
                    }
                }
                Supervision::Expired => {
                    supervisor_failure = Some(format!("{} produced no output for 10 minutes, so the turn was stopped. Check the Terminal view for sign-in or setup issues, then retry.", session.provider.label()));
                    // This handle belongs to this turn, regardless of which
                    // conversation is currently registered under the tab id.
                    child.stop();
                    if let Some(tools) = tools.as_ref() {
                        tools.scope.revoked.store(true, Ordering::Relaxed);
                    }
                    // Drain buffered output before resolving status: a
                    // completion racing with the timeout must still win.
                    continue;
                }
                Supervision::Finish => {
                    terminal_cleanup =
                        status == child_process::Status::Running && terminal.is_some();
                    break;
                }
            }
            if !batch.activity {
                std::thread::sleep(std::time::Duration::from_millis(PROCESS_POLL_MS));
            }
        }
        // Closing this process's job also stops descendants after their
        // parent has exited. Completion never waits for inherited pipe EOF.
        child.stop();
        if let Some(client) = control.as_ref() {
            client
                .broker()
                .close("This turn has ended. Its requests can no longer be answered.");
            publish_interactions(&app, &id, client.broker());
        }
        let headless_denial = session.provider == Provider::Antigravity
            && permission_denied.load(std::sync::atomic::Ordering::Relaxed);
        let policy_tool_events = if headless_denial {
            fold.permission_denied()
        } else {
            vec![]
        };
        let probe_report = if let Some(mut probe) = probe {
            if let Ok(errors) = probe_errors.lock() {
                for error in errors.values() {
                    probe.record_failure(error);
                }
            }
            if headless_denial {
                probe.permission_denied();
            }
            Some(probe.finish())
        } else {
            None
        };
        let restrictions = if session.provider == Provider::Codex {
            let resume = session.session_id.lock().unwrap().clone();
            Some(crate::workspace_access::codex_restrictions(&resume))
        } else {
            None
        };
        let turn_elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let _ = usage_stop.send(turn_elapsed);
        if let Some(handle) = usage_handle {
            if let Ok((usage, total, baseline)) = handle.join() {
                if session.provider == Provider::Codex {
                    if let Some(reported) = turn_usage.as_ref() {
                        turn_usage = Some(crate::provider_usage::codex_completion(
                            reported,
                            total.as_ref(),
                            baseline.as_ref(),
                            turn_elapsed,
                        ));
                    } else {
                        turn_usage = usage;
                    }
                } else if turn_usage.is_none() {
                    turn_usage = usage;
                }
            }
        }
        if let Some(usage) = turn_usage.as_mut() {
            usage.elapsed_ms = Some(turn_elapsed);
        }
        {
            let mut measured = measurement.lock().unwrap();
            measured.elapsed_ms = turn_elapsed;
            measured.finished = true;
            measured.counters = turn_usage.clone();
            measured.counter_source = if turn_usage.is_none() { "not reported" } else {
                match session.provider {
                    Provider::Muse => "Muse retained session records; current session and root run only",
                    Provider::Codex => "Codex completion or retained session delta; launch baseline excludes earlier turns",
                    Provider::Antigravity => "Antigravity per-step provider accounting for this turn",
                }
            }.into();
        }
        drop(tools);
        let tail = stderr_tail
            .lock()
            .ok()
            .map(|tail| tail.join("\n"))
            .filter(|tail| !tail.trim().is_empty());
        terminal = Some(resolve_terminal(
            session.provider,
            terminal,
            exit,
            supervisor_failure,
            terminal_cleanup,
            tail,
        ));
        if session.provider == Provider::Antigravity {
            mark_permission_blocked(
                &mut terminal,
                permission_denied.load(std::sync::atomic::Ordering::Relaxed),
            );
        }
        if control.as_ref().is_some_and(|client| client.denied()) {
            if let Some(AgentEvent::TurnEnd { status, reason, .. }) = terminal.as_mut() {
                if status == "completed" {
                    *status = "blocked".into();
                    *reason = Some("A permission request was declined or cancelled. Review the partial work before continuing; queued and scheduled work is paused.".into());
                }
            }
        }
        drop(prompt);
        if let Ok(mut prompt) = session.prompt.lock() {
            prompt.take();
        }
        // Completion is visible only after the process is reaped and the
        // next turn can be accepted. Keep registration locked through the
        // terminal event so a competing phone/desktop send cannot overtake it.
        let sessions = state.sessions.lock().unwrap();
        let current = {
            sessions
                .get(&id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
        };
        if let Ok(mut active) = session.child.lock() {
            if active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &child))
            {
                active.take();
            }
        }
        *session.running.lock().unwrap() = false;
        {
            let mut access = session.access.lock().unwrap();
            if let Some(report) = probe_report {
                access.agent = report;
            }
            if let Some(restrictions) = restrictions {
                access.restrictions = restrictions;
            }
        }
        let mut outcome = None;
        if current {
            emit(
                &app,
                &id,
                AgentEvent::TurnMetrics {
                    measurement: measurement.lock().unwrap().clone(),
                },
            );
            emit(
                &app,
                &id,
                AgentEvent::Usage {
                    context: None,
                    turn: Some(turn_usage.unwrap_or(crate::provider_usage::TurnUsage {
                        elapsed_ms: Some(turn_elapsed),
                        ..Default::default()
                    })),
                },
            );
            let tail = if action_context.is_some() {
                bot_output.finish()
            } else {
                memory_filter.finish()
            };
            if !tail.is_empty() {
                answer.push_str(&tail);
                emit(&app, &id, AgentEvent::AssistantDelta { text: tail });
            }
            if !matches!(&terminal,Some(AgentEvent::TurnEnd{status,..}) if status=="completed") {
                // A failed CLI may never have accepted its input. Re-send
                // relevant context next time rather than trusting its history.
                *session.memory.lock().unwrap() = crate::memory::Session::default();
                *session.shared_memory.lock().unwrap() = crate::memory::Session::default();
            }
            if matches!(&terminal,Some(AgentEvent::TurnEnd{status,..}) if status=="completed") {
                if memory_filter.invalid || invalid_proposal || bot_output.invalid {
                    emit(
                        &app,
                        &id,
                        AgentEvent::Notice {
                            text: "An incomplete or oversized memory suggestion was skipped."
                                .into(),
                        },
                    );
                }
                let valid_memory =
                    !(memory_filter.invalid || invalid_proposal || bot_output.invalid);
                if let Some(proposal) = bot_output
                    .memory
                    .or(memory_filter.proposal)
                    .or(final_proposal)
                    .filter(|_| valid_memory)
                {
                    let private = session
                        .bot_id
                        .as_ref()
                        .map(|id| app.state::<crate::bots::Store>().memory(id))
                        .transpose();
                    let capture = private.and_then(|private| {
                        let global = app.state::<crate::memory::Store>();
                        private.as_deref().unwrap_or(&global).capture(
                            &session.workspace.display().to_string(),
                            &proposal,
                            memory_mode,
                            session.provider.label(),
                        )
                    });
                    match capture {
                        Ok(count) if count > 0 => {
                            crate::memory::changed(&app);
                            emit(&app,&id,AgentEvent::Notice{text:format!("{count} memory note(s) added to the vault. Open Memory to view them.")});
                        }
                        Err(error) => emit(
                            &app,
                            &id,
                            AgentEvent::Notice {
                                text: format!("Memory: {error}"),
                            },
                        ),
                        _ => {}
                    }
                }
                if let Some(context) = &action_context {
                    if invalid_action || bot_output.invalid {
                        let text="Incomplete or duplicate bot actions were skipped. The board was not changed.".to_owned();
                        action_error = Some(text.clone());
                        emit(&app, &id, AgentEvent::Notice { text });
                    } else if let Some(action) = bot_output.action.or(final_action) {
                        let result = crate::bot_actions::apply(
                            &app,
                            &session.workspace.display().to_string(),
                            &id,
                            context,
                            &action,
                        );
                        let text = match result {
                            Ok(text) => {
                                action_report = Some(text.clone());
                                text
                            }
                            Err(e) => {
                                let text = format!("Bot actions: {e}");
                                action_error = Some(text.clone());
                                text
                            }
                        };
                        emit(&app, &id, AgentEvent::Notice { text });
                    }
                }
            }
            for event in policy_tool_events {
                emit(&app, &id, event);
            }
            if let Some(event) = terminal {
                if matches!(&event, AgentEvent::TurnEnd { status, .. } if status != "completed") {
                    let mut queue = session.queue.lock().unwrap();
                    if !queue.items.is_empty() {
                        queue.pause(
                            "The previous response stopped or failed. Review it before resuming.",
                        );
                        emit(
                            &app,
                            &id,
                            AgentEvent::QueueState {
                                queue: queue.clone(),
                                running: false,
                            },
                        );
                    }
                }
                emit(&app, &id, event.clone());
                if let AgentEvent::TurnEnd { status, reason, .. } = event {
                    outcome = Some((status, reason));
                }
            }
        }
        drop(sessions);
        if let Some((status, reason)) = outcome {
            crate::desktop::notify_turn(&app, &session.tab_id, &status);
            if let Err(error) = crate::automation::finish(
                &app,
                &id,
                if action_error.is_some() {
                    "review"
                } else {
                    &status
                },
                &answer,
                action_error.or(action_report).or(reason),
            ) {
                emit(
                    &app,
                    &id,
                    AgentEvent::Notice {
                        text: format!("Could not finish the scheduled run: {error}"),
                    },
                );
            }
            if status == "completed" {
                start_next(&app, &id);
            }
        }
    });
}

/// Register a tab for headless turns, minting its stable muse session id
/// and binding its workspace directory. Replaces any session already
/// registered under `id`. A bad workspace leaves any existing session
/// untouched.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Preserve the named IPC arguments used by existing desktops.
pub fn agent_new(
    app: AppHandle,
    id: String,
    workspace: Option<String>,
    tab_id: Option<String>,
    provider: Option<Provider>,
    options: Option<RunOptions>,
    resume: Option<bool>,
    bot_id: Option<String>,
    task_id: Option<String>,
) -> Result<NewInfo, String> {
    let state = app.state::<AgentState>();
    let workspace = resolve_workspace(workspace)?;
    let provider = provider.unwrap_or_default();
    let bot = bot_id
        .as_ref()
        .map(|id| app.state::<crate::bots::Store>().get(id))
        .transpose()?;
    let options = options.unwrap_or_default();
    options.validate(provider)?;
    let tab_id = tab_id.unwrap_or_else(|| id.clone());
    // A WebView reload can leave its native reader alive. Reattach to that
    // owner, including its pending approvals, instead of launching a rival.
    if resume.unwrap_or(false) {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Agent state unavailable.")?;
        if let Some((live_id, live)) = sessions
            .iter()
            .filter(|(_, live)| {
                live.tab_id == tab_id
                    && live.workspace == workspace
                    && live.provider == provider
                    && live.bot_id == bot_id
                    && live.task_id == task_id
            })
            .max_by_key(|(_, live)| live.registration)
        {
            if let Some(replay) = app
                .state::<crate::session_log::SessionLog>()
                .replay(live_id, 0)
            {
                let session_id = live.session_id.lock().unwrap().clone();
                let yolo = live.access.lock().unwrap().requested;
                return Ok(NewInfo {
                    live: Some(LiveInfo {
                        revision: replay.session.revision,
                        running: replay.session.running,
                        yolo,
                        terminal: state.terminal_owns(live),
                        queue: replay.session.queue,
                    }),
                    bot: live.bot_identity.lock().unwrap().clone(),
                    id: live_id.clone(),
                    session_id,
                    workspace: workspace.display().to_string(),
                    workspace_notice: None,
                    restored: replay.events.into_iter().map(|entry| entry.event).collect(),
                    truncated: replay.truncated,
                });
            }
        }
    }
    let history = app.state::<crate::history::HistoryState>();
    let saved = if resume.unwrap_or(false) {
        history
            .load(&tab_id, &workspace.display().to_string(), provider)?
            .filter(|saved| saved.bot_id == bot_id)
    } else {
        None
    };
    let session_id = if let Some(saved) = &saved {
        saved.session_id.clone()
    } else {
        String::new()
    };
    let restored_mode = saved.as_ref().and_then(|s| s.permission_mode);
    let mut access = AccessState::new(&workspace, provider, restored_mode);
    // The provider mints new session IDs after the control handshake.
    access.fresh_session_pending = saved.is_none();
    let old = state
        .sessions
        .lock()
        .map_err(|_| "agent state is unavailable".to_string())?
        .insert(
            id.clone(),
            Arc::new(AgentSession {
                measurement_clock: Mutex::new(None),
                measurement: Mutex::new(None),
                tool_scope: Mutex::new(None),
                interactions: Mutex::new(None),
                registration: state.next_registration.fetch_add(1, Ordering::Relaxed),
                access: Mutex::new(access),
                bot_id: bot_id.clone(),
                bot_identity: Mutex::new(bot.as_ref().map(|p| p.identity())),
                task_id,
                shared_memory: Mutex::new(crate::memory::Session::default()),
                tab_id: tab_id.clone(),
                session_id: Mutex::new(session_id.clone()),
                provider,
                options: Mutex::new(options.clone()),
                memory: Mutex::new(crate::memory::Session::default()),
                workspace: workspace.clone(),
                child: Mutex::new(None),
                running: Mutex::new(false),
                queue: Mutex::new(saved.as_ref().map(|s| s.queue.clone()).unwrap_or_default()),
                prompt: Mutex::new(None),
            }),
        );
    if let Some(old) = old {
        old.stop();
    }
    app.state::<crate::session_log::SessionLog>()
        .register_provider(&id, workspace.display().to_string(), provider);
    app.state::<crate::session_log::SessionLog>()
        .configure(&id, options);
    let truncated = saved.as_ref().is_some_and(|saved| saved.truncated);
    let mut restored = saved.map(|saved| saved.events).unwrap_or_default();
    if session_id.is_empty() {
        restored.push(AgentEvent::UsageReset);
    }
    for event in &restored {
        app.state::<crate::session_log::SessionLog>()
            .record(&id, event);
    }
    history.bind(
        &id,
        tab_id,
        workspace.display().to_string(),
        provider,
        session_id.clone(),
    );
    history.bind_bot(&id, bot_id);
    if let Some(mode) = restored_mode {
        history.permission_mode(&id, mode);
    }
    if let Some(profile) = &bot {
        emit(
            &app,
            &id,
            AgentEvent::BotIdentity {
                bot: profile.identity(),
            },
        );
    }
    if truncated {
        history.mark_truncated(&id);
    }
    crate::remote::changed(&app);
    Ok(NewInfo {
        live: None,
        bot: bot.map(|p| p.identity()),
        id,
        session_id,
        workspace: workspace.display().to_string(),
        workspace_notice: crate::workspace_access::project_required(&workspace, provider, false)
            .then(|| crate::workspace_access::PROFILE_ROOT_GUIDANCE.into()),
        restored,
        truncated,
    })
}

fn configuration_target<'a>(
    sessions: &'a HashMap<String, Arc<AgentSession>>,
    id: &str,
    by_tab: bool,
) -> Option<(&'a String, &'a Arc<AgentSession>)> {
    // A WebView reload can leave an older native session behind. Desktop model
    // controls belong to the most recently registered owner of that tab. Phone
    // controls carry an exact native ID and must continue targeting that ID.
    sessions
        .iter()
        .filter(|(key, session)| {
            if by_tab {
                session.tab_id == id
            } else {
                key.as_str() == id
            }
        })
        .max_by_key(|(_, session)| session.registration)
}

pub fn configure_session(
    app: &AppHandle,
    state: &AgentState,
    id: &str,
    options: RunOptions,
    by_tab: bool,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Agent state unavailable.")?;
    let (id, session) = configuration_target(&sessions, id, by_tab)
        .ok_or("Conversation is still starting. Try again in a moment.")?;
    if state.terminal_owns(session) {
        return Err("Close the continued terminal conversation before changing models.".into());
    }
    if *session.running.lock().unwrap() {
        return Err("Wait for the current response or stop it before changing models.".into());
    }
    if !session.queue.lock().unwrap().items.is_empty() {
        return Err("Finish or clear queued messages before changing models.".into());
    }
    options.validate(session.provider)?;
    let model_changed = {
        let mut previous = session.options.lock().unwrap();
        let changed = previous.model != options.model;
        *previous = options.clone();
        changed
    };
    if model_changed {
        *session.measurement.lock().unwrap() = None;
        *session.measurement_clock.lock().unwrap() = None;
        emit(app, id, AgentEvent::UsageReset);
    }
    app.state::<crate::session_log::SessionLog>()
        .configure(id, options.clone());
    let _ = app.emit(
        "agent-options",
        serde_json::json!({"tab_id":session.tab_id,"options":options}),
    );
    crate::remote::changed(app);
    Ok(())
}
#[tauri::command]
pub fn agent_configure(
    app: AppHandle,
    state: State<AgentState>,
    tab_id: String,
    options: RunOptions,
) -> Result<(), String> {
    configure_session(&app, &state, &tab_id, options, true)
}

/// Run one prompt against the tab's provider and conversation.
/// When `yolo` is set, `--yolo` disables approval and sandboxing for the turn.
/// Pending messages are shared by desktop and phone and run in submission order.
#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<AgentState>,
    id: String,
    prompt: String,
    yolo: bool,
    remote: Option<bool>,
) -> Result<TurnInfo, String> {
    send_inner(app, state, id, prompt, yolo, remote, false, None)
}

#[tauri::command]
pub fn agent_check_access(
    app: AppHandle,
    state: State<AgentState>,
    id: String,
    yolo: bool,
) -> Result<TurnInfo, String> {
    send_inner(
        app,
        state,
        id,
        "Check workspace access (Velum diagnostics)".into(),
        yolo,
        None,
        true,
        None,
    )
}

fn change_permissions(app: &AppHandle, id: &str, session: &AgentSession, yolo: bool) -> bool {
    let mut resume = session.session_id.lock().unwrap();
    let mut access = session.access.lock().unwrap();
    let changed = access.change(yolo, !resume.is_empty());
    if changed {
        *resume = String::new();
        *session.memory.lock().unwrap() = Default::default();
        *session.shared_memory.lock().unwrap() = Default::default();
        app.state::<crate::history::HistoryState>()
            .resume_id(id, &resume);
        *session.measurement.lock().unwrap() = None;
        *session.measurement_clock.lock().unwrap() = None;
        emit(app, id, AgentEvent::UsageReset);
        emit(app, id, AgentEvent::Notice { text: format!("Permission mode is now {}. The next turn starts a fresh provider conversation; the visible transcript is retained, but previous provider context is not replayed. Workspace checks were invalidated. Run Test agent access to verify this mode.", crate::workspace_access::mode(yolo)) });
    }
    let _ = app.emit(
        "agent-permissions",
        serde_json::json!({"tab_id":session.tab_id,"yolo":yolo}),
    );
    changed
}

#[tauri::command]
pub fn agent_set_permissions(
    app: AppHandle,
    state: State<AgentState>,
    id: String,
    yolo: bool,
) -> Result<serde_json::Value, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Agent state unavailable.")?;
    let session = sessions.get(&id).ok_or("Conversation is still starting.")?;
    if state.terminal_owns(session) {
        return Err(
            "Close the continued terminal conversation before changing permissions.".into(),
        );
    }
    if *session.running.lock().unwrap() {
        return Err("Wait for the current turn or stop it before changing permissions.".into());
    }
    if !session.queue.lock().unwrap().items.is_empty() {
        return Err("Finish or clear queued messages before changing permissions.".into());
    }
    let changed = change_permissions(&app, &id, session, yolo);
    Ok(serde_json::json!({"yolo":yolo,"new_session":changed,"checks_invalidated":changed}))
}

#[allow(clippy::too_many_arguments)]
fn send_inner(
    app: AppHandle,
    state: State<AgentState>,
    id: String,
    prompt: String,
    yolo: bool,
    remote: Option<bool>,
    check_access: bool,
    queued_id: Option<String>,
) -> Result<TurnInfo, String> {
    crate::message_queue::validate_prompt(&prompt)?;
    // Serialize registration with stop/destroy and competing sends until
    // the new child is owned by this session.
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "agent state is unavailable".to_string())?;
    if state.updating.load(Ordering::SeqCst) {
        return Err("Velum is restarting to install an update. Try again after it reopens.".into());
    }
    if state.startup_pending() {
        return Err("Velum is checking for updates at startup. Try again when it opens.".into());
    }
    let session = sessions
        .get(&id)
        .ok_or_else(|| "agent session not found; reopen the tab".to_string())?;
    if state.terminal_owns(session) {
        return Err("This conversation is open in Terminal. Exit that terminal before sending another chat message.".into());
    }
    let running = *session
        .running
        .lock()
        .map_err(|_| "Agent state unavailable.")?;
    let (prompt, yolo, remote) = {
        let mut queue = session
            .queue
            .lock()
            .map_err(|_| "Message queue unavailable.")?;
        if let Some(message_id) = &queued_id {
            if running
                || queue.paused
                || queue
                    .items
                    .first()
                    .is_none_or(|item| &item.id != message_id)
            {
                return Err("The queued message is no longer ready to start.".into());
            }
            let item = &queue.items[0];
            (item.prompt.clone(), item.yolo, Some(item.remote))
        } else if running || queue.paused || !queue.items.is_empty() {
            if check_access || app.state::<crate::automation::Store>().managed(&id) {
                return Err("Wait for the current response and pending messages before starting this operation.".into());
            }
            let turn_id = queue.push(prompt, yolo, remote.unwrap_or(false))?;
            emit(
                &app,
                &id,
                AgentEvent::QueueState {
                    queue: queue.clone(),
                    running,
                },
            );
            return Ok(TurnInfo {
                id,
                turn_id,
                queued: true,
            });
        } else {
            (prompt, yolo, remote)
        }
    };
    let session = Arc::clone(session);
    let managed = app.state::<crate::automation::Store>().managed(&id);
    if managed
        && state
            .terminal_leases
            .lock()
            .unwrap()
            .values()
            .any(|(_, path)| {
                std::fs::canonicalize(path).ok() == std::fs::canonicalize(&session.workspace).ok()
            })
    {
        return Err(
            "Close the continued terminal in this project before starting scheduled work.".into(),
        );
    }
    if sessions.iter().any(|(other_id, other)| {
        other_id != &id
            && *other.running.lock().unwrap()
            && std::fs::canonicalize(&other.workspace).ok()
                == std::fs::canonicalize(&session.workspace).ok()
            && (managed || app.state::<crate::automation::Store>().managed(other_id))
    }) {
        return Err("Scheduled work and chat cannot run together in the same workspace. Wait for the current turn or stop it first.".into());
    }
    let bot = session
        .bot_id
        .as_ref()
        .map(|bot| app.state::<crate::bots::Store>().get(bot))
        .transpose()?;
    if bot.as_ref().is_some_and(|bot| !bot.enabled) {
        return Err("This bot is disabled. Enable it from Bots before starting work.".into());
    }
    let provider = session.provider;
    // Apply the requested mode even when workspace validation prevents launch.
    // A rejected Standard turn must not leave stale unrestricted diagnostics.
    change_permissions(&app, &id, &session, yolo);
    if !check_access
        && crate::workspace_access::project_required(&session.workspace, provider, yolo)
    {
        return Err(crate::workspace_access::PROFILE_ROOT_GUIDANCE.into());
    }
    let cli_path = provider.resolve().ok_or_else(|| provider.missing())?;
    let session_id = session.session_id.lock().unwrap().clone();
    let workspace = &session.workspace;
    let probe = if check_access {
        let mut access = session.access.lock().unwrap();
        access.host = Some(crate::workspace_access::host_probe(workspace, true));
        let mut probe = crate::workspace_access::Probe::prepare(
            workspace,
            format!("{} agent tools", provider.label()),
            yolo,
            access.revision,
        );
        probe.report.running = true;
        access.agent = probe.report.clone();
        Some(probe)
    } else {
        None
    };
    let mut pending = PendingProbe {
        probe,
        session: Arc::clone(&session),
    };
    // Prompt via file so quoting/newlines can never corrupt argv.
    let turn_id = uuid::Uuid::new_v4().to_string();
    let staged = StagedPrompt(prompt_file(&turn_id));
    let file = &staged.0;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("failed to stage prompt: {e}"))?;
    }
    let mut next_memory = session.memory.lock().unwrap().clone();
    let mut next_shared = session.shared_memory.lock().unwrap().clone();
    let memory_result = if let Some(probe) = &pending.probe {
        Ok((
            probe.prompt(provider),
            crate::memory::Usage::default(),
            crate::memory::Capture::Manual,
        ))
    } else if let Some(bot) = &bot {
        (|| {
            let global = app.state::<crate::memory::Store>();
            let shared_budget = if bot.shared_memory {
                bot.memory_budget / 3
            } else {
                0
            };
            let (shared, shared_usage, _) = global.prepare_limited(
                &workspace.display().to_string(),
                &prompt,
                &mut next_shared,
                Some(shared_budget),
                false,
            )?;
            let private = app.state::<crate::bots::Store>().memory(&bot.id)?;
            let (own, mut usage, mode) = private.prepare_limited(
                &workspace.display().to_string(),
                &prompt,
                &mut next_memory,
                Some(bot.memory_budget - shared_usage.bytes),
                true,
            )?;
            usage.bytes += shared_usage.bytes;
            usage.titles.extend(shared_usage.titles);
            usage.budget_bytes = bot.memory_budget;
            Ok((
                format!("{}{own}", shared.strip_suffix(&prompt).unwrap_or("")),
                usage,
                mode,
            ))
        })()
    } else {
        app.state::<crate::memory::Store>().prepare(
            &workspace.display().to_string(),
            &prompt,
            &mut next_memory,
        )
    };
    let (mut prepared, memory_usage, memory_mode) = match memory_result {
        Ok(value) => value,
        Err(error) => {
            emit(
                &app,
                &id,
                AgentEvent::Notice {
                    text: format!("Memory unavailable: {error}. Sending without memory."),
                },
            );
            (
                prompt.clone(),
                crate::memory::Usage::default(),
                crate::memory::Capture::Manual,
            )
        }
    };
    let action_context = if let Some(bot) = bot.as_ref().filter(|_| !check_access) {
        let identity = app.state::<crate::bots::Store>().context(bot)?;
        let (context, board) = crate::bot_actions::prepare(
            &app,
            bot,
            &workspace.display().to_string(),
            session.task_id.as_deref(),
            &turn_id,
        )?;
        prepared = format!("{identity}{board}\n{prepared}");
        Some(context)
    } else {
        None
    };
    let options = session.options.lock().unwrap().clone();
    if let Some(prefix) = prepared.strip_suffix(&prompt) {
        if !prefix.ends_with("Current request:\n") {
            prepared = format!("{prefix}Current request:\n{prompt}");
        }
    }
    let source = if managed {
        "scheduler"
    } else if remote.unwrap_or(false) {
        "phone"
    } else {
        "desktop"
    };
    prepared = format!(
        "{}{prepared}",
        crate::app_context::turn_context(
            workspace,
            provider,
            &options,
            source,
            yolo,
            Some(session.access.lock().unwrap().value(false))
        )
    );
    prepared = format!(
        "Velum host tools (reference data, not permission grants):\n<velum-host-tools>\n{}\n</velum-host-tools>\n\n{prepared}",
        crate::tool_bridge::context(&app)
    );
    std::fs::write(file, provider.input(&prepared))
        .map_err(|e| format!("failed to stage prompt: {e}"))?;

    let mut cmd = providers::exec_command(
        provider,
        &cli_path,
        &session_id,
        workspace,
        file,
        yolo,
        &options,
    )?;
    let usage_session = if matches!(provider, Provider::Codex | Provider::Muse) {
        session_id.clone()
    } else {
        String::new()
    };
    let usage_baseline = if usage_session.is_empty() {
        Some(crate::provider_usage::TurnUsage::zero())
    } else if provider == Provider::Codex {
        crate::provider_usage::codex_session_file(&usage_session)
            .and_then(|path| crate::provider_usage::codex_usage(&path, i64::MIN))
            .and_then(|usage| usage.total)
    } else {
        None
    };
    let muse_offset = if provider == Provider::Muse {
        crate::provider_usage::muse_session_file(&usage_session)
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let started = std::time::Instant::now();
    let started_at = chrono::Utc::now().timestamp_millis();
    let measurement = Arc::new(Mutex::new(crate::tool_bridge::Measurement::new(
        provider, started_at,
    )));
    let tools = crate::tool_bridge::begin(
        &app,
        workspace,
        session.bot_id.clone(),
        measurement.clone(),
        started,
    )?;
    if let Some(tools) = tools.as_ref() {
        tools.configure(&mut cmd, provider)?;
        *session.tool_scope.lock().unwrap() = Some(Arc::downgrade(&tools.scope));
    } else {
        *session.tool_scope.lock().unwrap() = None;
    }
    // Registration is configuration work; reset the host clock immediately
    // before spawn so it measures the same interval used by tokenRate.
    let started = std::time::Instant::now();
    let started_at = chrono::Utc::now().timestamp_millis();
    measurement.lock().unwrap().started_at_ms = started_at;
    if let Some(tools) = tools.as_ref() {
        tools.reset_clock(started);
    }
    *session.measurement_clock.lock().unwrap() = Some(started);
    *session.measurement.lock().unwrap() = Some(measurement.clone());
    let child = child_process::Child::spawn(&mut cmd).map_err(|e| {
        if let Some(probe) = pending.probe.as_mut() {
            session.access.lock().unwrap().agent = probe.finish();
        }
        format!("failed to launch `{}`: {e}", cli_path.display())
    })?;
    {
        let mut access = session.access.lock().unwrap();
        access.applied = Some(yolo);
        access.fresh_session_pending = false;
    }
    app.state::<crate::history::HistoryState>()
        .permission_mode(&id, yolo);

    let mut child = child;
    let control = if matches!(provider, Provider::Muse | Provider::Codex) {
        let input = child
            .stdin
            .take()
            .ok_or("Could not capture the provider's control input.")?;
        let (broker, controls) = crate::interactions::Broker::new(turn_id.clone());
        let client = if provider == Provider::Muse {
            let muse = crate::muse_msp::Client::new(
                input,
                broker.clone(),
                controls,
                session_id.clone(),
                workspace.display().to_string(),
                prepared,
                prompt.clone(),
                options.clone(),
                yolo,
            )?;
            crate::provider_control::Client::Muse(Box::new(muse))
        } else {
            let codex = crate::codex_control::Client::new(
                input,
                broker.clone(),
                controls,
                session_id.clone(),
                workspace.display().to_string(),
                prepared,
                options.clone(),
                yolo,
                usage_baseline.clone(),
            )?;
            crate::provider_control::Client::Codex(Box::new(codex))
        };
        *session.interactions.lock().unwrap() = Some(broker);

        Some(client)
    } else {
        *session.interactions.lock().unwrap() = None;
        None
    };
    *session.memory.lock().unwrap() = next_memory;
    *session.shared_memory.lock().unwrap() = next_shared;
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        "could not capture agent output".to_string()
    })?;
    let stderr = child.stderr.take();
    let output = child_process::Output::new(stdout, stderr)
        .map_err(|error| format!("Could not capture agent output: {error}"))?;
    let child = Arc::new(SharedChild::new(child));
    {
        *session
            .prompt
            .lock()
            .map_err(|_| "agent state is unavailable".to_string())? = Some(file.clone());
        *session
            .running
            .lock()
            .map_err(|_| "agent state is unavailable".to_string())? = true;
        // The child handle stays here so `agent_stop` can kill it; the
        // reader thread reaps it after EOF.
        *session
            .child
            .lock()
            .map_err(|_| "agent state is unavailable".to_string())? = Some(Arc::clone(&child));
    }
    if queued_id.is_some() {
        let mut queue = session.queue.lock().unwrap();
        queue.items.remove(0);
        emit(
            &app,
            &id,
            AgentEvent::QueueState {
                queue: queue.clone(),
                running: true,
            },
        );
    }
    if let Some(bot) = bot {
        let identity = bot.identity();
        let mut previous = session.bot_identity.lock().unwrap();
        if previous.as_ref() != Some(&identity) {
            *previous = Some(identity.clone());
            emit(&app, &id, AgentEvent::BotIdentity { bot: identity });
        }
    }
    emit(
        &app,
        &id,
        AgentEvent::TurnStart {
            prompt,
            remote: remote.unwrap_or(false),
            queued: queued_id.is_some(),
        },
    );
    // Publish admission before allowing another sender or Stop to interleave.
    drop(sessions);
    emit(
        &app,
        &id,
        AgentEvent::TurnMetrics {
            measurement: measurement.lock().unwrap().clone(),
        },
    );
    emit(
        &app,
        &id,
        AgentEvent::MemoryContext {
            titles: memory_usage.titles,
            bytes: memory_usage.bytes,
            budget_bytes: memory_usage.budget_bytes,
        },
    );
    spawn_reader(
        app,
        id.clone(),
        session,
        staged,
        output,
        TurnContext {
            child,
            control,
            tools,
            measurement,
            probe: pending.probe.take(),
            memory_mode,
            action_context,
            started,
            started_at,
            usage_session,
            usage_baseline,
            muse_offset,
        },
    );
    Ok(TurnInfo {
        id,
        turn_id,
        queued: false,
    })
}

fn start_next(app: &AppHandle, id: &str) {
    let state = app.state::<AgentState>();
    let next = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(id).and_then(|session| {
            if *session.running.lock().unwrap() {
                return None;
            }
            let queue = session.queue.lock().unwrap();
            (!queue.paused)
                .then(|| queue.items.first().cloned())
                .flatten()
        })
    };
    let Some(next) = next else {
        return;
    };
    if let Err(error) = send_inner(
        app.clone(),
        state,
        id.into(),
        next.prompt,
        next.yolo,
        Some(next.remote),
        false,
        Some(next.id.clone()),
    ) {
        let sessions = app.state::<AgentState>();
        let sessions = sessions.sessions.lock().unwrap();
        if let Some(session) = sessions.get(id) {
            let mut queue = session.queue.lock().unwrap();
            if !queue.paused && queue.items.first().is_some_and(|item| item.id == next.id) {
                queue.pause(&format!("Could not start the queued message: {error}"));
                emit(
                    app,
                    id,
                    AgentEvent::QueueState {
                        queue: queue.clone(),
                        running: false,
                    },
                );
            }
        }
    }
}

pub fn queue_request(
    app: &AppHandle,
    id: &str,
    request: crate::message_queue::Request,
) -> Result<crate::message_queue::Snapshot, String> {
    let state = app.state::<AgentState>();
    let snapshot = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Agent state unavailable.")?;
        let session = sessions.get(id).ok_or("Conversation is unavailable.")?;
        let mut queue = session
            .queue
            .lock()
            .map_err(|_| "Message queue unavailable.")?;
        if matches!(request, crate::message_queue::Request::Load {}) {
            return Ok(queue.clone());
        }
        queue.apply(request)?;
        let snapshot = queue.clone();
        emit(
            app,
            id,
            AgentEvent::QueueState {
                queue: snapshot.clone(),
                running: *session.running.lock().unwrap(),
            },
        );
        snapshot
    };
    start_next(app, id);
    Ok(snapshot)
}

#[tauri::command]
pub fn agent_queue(
    app: AppHandle,
    id: String,
    request: crate::message_queue::Request,
) -> Result<crate::message_queue::Snapshot, String> {
    queue_request(&app, &id, request)
}

/// Stop the tab's running turn, if any. Always succeeds.
#[tauri::command]
pub fn agent_stop(app: AppHandle, state: State<AgentState>, id: String) -> Result<(), String> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "Agent state unavailable.")?;
        if let Some(session) = sessions.get(&id) {
            let mut queue = session.queue.lock().unwrap();
            if !queue.items.is_empty() {
                queue.pause("Stopped. Pending messages will wait until you resume the queue.");
                emit(
                    &app,
                    &id,
                    AgentEvent::QueueState {
                        queue: queue.clone(),
                        running: *session.running.lock().unwrap(),
                    },
                );
            }
        }
    }
    kill_session(&state, &id);
    Ok(())
}

/// Drop the tab's agent session, stopping any running turn and removing
/// its staged prompt. The muse-side session log is left on disk.
#[tauri::command]
pub fn agent_destroy(app: AppHandle, state: State<AgentState>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(&id));
    if let Some(session) = session {
        session.stop();
    }
    if let Err(error) = app
        .state::<crate::history::HistoryState>()
        .unbind(&id, &app.state::<crate::session_log::SessionLog>())
    {
        let _ = app.emit("history-status", Some(error));
    }
    app.state::<crate::session_log::SessionLog>().remove(&id);
    crate::remote::changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{home_dir, resolve_workspace, safe_fragment};
    #[test]
    fn configuration_targets_latest_tab_owner_after_reload_and_preserves_exact_ids() {
        use super::*;
        let session = |tab: &str, registration| {
            let workspace = std::path::PathBuf::from("project");
            Arc::new(AgentSession {
                measurement_clock: Mutex::new(None),
                measurement: Mutex::new(None),
                tool_scope: Mutex::new(None),
                registration,
                interactions: Mutex::new(None),
                access: Mutex::new(AccessState::new(&workspace, Provider::Codex, Some(false))),
                bot_id: None,
                bot_identity: Mutex::new(None),
                task_id: None,
                shared_memory: Mutex::new(Default::default()),
                tab_id: tab.into(),
                session_id: Mutex::new(String::new()),
                provider: Provider::Codex,
                options: Mutex::new(RunOptions::default()),
                memory: Mutex::new(Default::default()),
                workspace,
                child: Mutex::new(None),
                running: Mutex::new(false),
                queue: Mutex::new(crate::message_queue::Snapshot::default()),
                prompt: Mutex::new(None),
            })
        };
        let sessions = HashMap::from([
            ("old-native-z".into(), session("desktop-tab", 1)),
            ("current-native-a".into(), session("desktop-tab", 2)),
            ("unrelated-native".into(), session("another-tab", 3)),
        ]);
        assert_eq!(
            configuration_target(&sessions, "desktop-tab", true)
                .unwrap()
                .0,
            "current-native-a"
        );
        assert_eq!(
            configuration_target(&sessions, "old-native-z", false)
                .unwrap()
                .0,
            "old-native-z"
        );
        assert!(configuration_target(&sessions, "missing", true).is_none());
    }

    #[test]
    fn session_context_reports_actual_provider_and_requested_mode() {
        use super::*;
        let workspace = std::env::temp_dir();
        let mut access = AccessState::new(&workspace, Provider::Muse, None);
        access.requested = true;
        let state = AgentState::default();
        state.sessions.lock().unwrap().insert(
            "native-1".into(),
            Arc::new(AgentSession {
                measurement_clock: Mutex::new(None),
                measurement: Mutex::new(None),
                tool_scope: Mutex::new(None),
                registration: 0,
                interactions: Mutex::new(None),
                access: Mutex::new(access),
                bot_id: None,
                bot_identity: Mutex::new(None),
                task_id: None,
                shared_memory: Mutex::new(Default::default()),
                tab_id: "tab".into(),
                session_id: Mutex::new(String::new()),
                provider: Provider::Muse,
                options: Mutex::new(RunOptions::default()),
                memory: Mutex::new(Default::default()),
                workspace: workspace.clone(),
                child: Mutex::new(None),
                running: Mutex::new(false),
                queue: Mutex::new(crate::message_queue::Snapshot::default()),
                prompt: Mutex::new(None),
            }),
        );
        assert_eq!(
            state.session_context("native-1", &workspace),
            Some((Provider::Muse, true))
        );
        assert_eq!(state.session_context("missing", &workspace), None);
        let other = std::env::temp_dir().join(format!("velum-context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&other).unwrap();
        assert_eq!(state.session_context("native-1", &other), None);
        std::fs::remove_dir(&other).unwrap();
    }

    #[test]
    fn startup_and_installation_each_block_agent_work() {
        let state = super::AgentState::default();
        assert!(!state.work_blocked());
        state.set_startup_pending(true);
        assert!(state.startup_pending());
        assert!(state.work_blocked());
        state.begin_update().unwrap();
        state.set_startup_pending(false);
        assert!(state.work_blocked());
        state.cancel_update();
        assert!(!state.work_blocked());
    }

    #[test]
    fn replacement_provider_thread_invalidates_evidence_without_changing_mode() {
        let mut access = super::AccessState::new(
            std::path::Path::new("project"),
            crate::providers::Provider::Codex,
            Some(false),
        );
        access.agent.checks[0].status = crate::workspace_access::Status::Pass;
        assert!(!access.observe_session("", "first"));
        assert!(!access.observe_session("first", "first"));
        assert!(access.observe_session("first", "replacement"));
        assert_eq!(access.revision, 1);
        assert_eq!(access.applied, Some(false));
        assert!(access
            .agent
            .checks
            .iter()
            .all(|c| c.status == crate::workspace_access::Status::Untested));
        assert_eq!(access.restrictions["status"], "untested");
    }
    #[test]
    fn permission_changes_invalidate_and_require_fresh_provider_session() {
        let mut access = super::AccessState::new(
            std::path::Path::new("project"),
            crate::providers::Provider::Codex,
            Some(false),
        );
        assert!(!access.change(false, true));
        assert!(access.change(true, true));
        assert_eq!(access.revision, 1);
        assert_eq!(access.applied, None);
        assert!(
            !access.change(true, true),
            "A pending fresh Muse ID must not reset twice"
        );
        assert!(access
            .agent
            .checks
            .iter()
            .all(|c| c.status == crate::workspace_access::Status::Untested));
        access.applied = Some(true);
        assert!(!access.change(true, true));
        assert!(access.change(false, true));
        assert_eq!(access.revision, 2);
        let mut restored = super::AccessState::new(
            std::path::Path::new("project"),
            crate::providers::Provider::Codex,
            None,
        );
        assert!(
            restored.change(false, true),
            "Legacy session with unknown mode must not silently resume"
        );
    }
    #[test]
    fn new_muse_id_does_not_report_a_permission_change_before_first_turn() {
        let mut fresh = super::AccessState::new(
            std::path::Path::new("project"),
            crate::providers::Provider::Muse,
            None,
        );
        fresh.fresh_session_pending = true;
        assert!(!fresh.change(false, true));
        assert_eq!(fresh.revision, 0);
        assert!(fresh.change(true, true));
    }
    fn build_exec_command(path: &std::path::Path, yolo: bool) -> std::process::Command {
        crate::providers::exec_command(
            crate::providers::Provider::Muse,
            path,
            "session",
            std::path::Path::new("."),
            std::path::Path::new("prompt.txt"),
            yolo,
            &crate::provider_models::RunOptions::default(),
        )
        .unwrap()
    }
    use std::path::Path;

    #[test]
    fn headless_denial_overrides_success_but_preserves_stop_and_partial_output() {
        use super::{headless_permission_denied, mark_permission_blocked};
        use crate::events::AgentEvent;
        assert!(headless_permission_denied("a tool required the command permission that headless mode cannot prompt for, so it was auto-denied"));
        assert!(!headless_permission_denied("Access denied (os error 5)"));
        assert!(!headless_permission_denied("Permission check passed"));
        let mut event = Some(AgentEvent::TurnEnd {
            status: "completed".into(),
            text: Some("Partial answer".into()),
            reason: None,
        });
        mark_permission_blocked(&mut event, true);
        assert!(
            matches!(&event, Some(AgentEvent::TurnEnd { status, text: Some(text), reason: Some(reason) }) if status == "blocked" && text == "Partial answer" && reason.contains("/permissions") && reason.contains("permissions.allow") && reason.contains("command(...)"))
        );
        let mut stopped = Some(AgentEvent::TurnEnd {
            status: "cancelled".into(),
            text: None,
            reason: None,
        });
        mark_permission_blocked(&mut stopped, true);
        assert!(
            matches!(stopped, Some(AgentEvent::TurnEnd { status, .. }) if status == "cancelled")
        );
    }

    #[test]
    fn tab_id_is_sanitized_for_filenames() {
        assert_eq!(safe_fragment("abc-123_X"), "abc-123_X");
        assert_eq!(safe_fragment("a/b\\c:d"), "a_b_c_d");
    }

    #[test]
    fn workspace_defaults_to_home() {
        assert_eq!(resolve_workspace(None).unwrap(), home_dir());
        assert_eq!(resolve_workspace(Some(String::new())).unwrap(), home_dir());
        assert_eq!(
            resolve_workspace(Some("   ".to_owned())).unwrap(),
            home_dir()
        );
    }

    #[test]
    fn workspace_accepts_existing_dirs_only() {
        let tmp = std::env::temp_dir();
        assert_eq!(
            std::fs::canonicalize(resolve_workspace(Some(tmp.display().to_string())).unwrap())
                .unwrap(),
            std::fs::canonicalize(&tmp).unwrap()
        );
        let missing = tmp.join(format!(
            "velum-code-no-such-workspace-{}",
            std::process::id()
        ));
        assert!(resolve_workspace(Some(missing.display().to_string())).is_err());
        let probe = tmp.join(format!("velum-code-ws-probe-{}", std::process::id()));
        std::fs::write(&probe, b"probe").unwrap();
        assert!(resolve_workspace(Some(probe.display().to_string())).is_err());
        let _ = std::fs::remove_file(&probe);
    }

    #[test]
    fn muse_launches_the_bidirectional_host() {
        let cmd = build_exec_command(Path::new("muse"), false);
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, [std::ffi::OsStr::new("serve")]);
    }

    fn has_yolo(cmd: &std::process::Command) -> bool {
        cmd.get_args().any(|a| a == "--disable-sandbox")
            && cmd.get_args().any(|a| a == "--trust-workspace")
    }

    #[test]
    fn muse_yolo_host_flags_survive_script_shims() {
        let plain = build_exec_command(Path::new("muse"), true);
        assert!(has_yolo(&plain));
        let plain = build_exec_command(Path::new("muse"), false);
        assert!(!has_yolo(&plain));
        // Script shims wrap in an interpreter; the flag must survive that too.
        let shim = build_exec_command(Path::new("muse.cmd"), true);
        assert!(has_yolo(&shim));
        let shim = build_exec_command(Path::new("muse.cmd"), false);
        assert!(!has_yolo(&shim));
    }

    #[test]
    fn silence_policy_warns_then_expires() {
        use super::*;
        assert_eq!(silence_state(0), Silence::Active);
        assert_eq!(silence_state(SILENCE_WARN_MS - 1), Silence::Active);
        assert_eq!(silence_state(SILENCE_WARN_MS), Silence::Warn);
        assert_eq!(silence_state(SILENCE_FAIL_MS - 1), Silence::Warn);
        assert_eq!(silence_state(SILENCE_FAIL_MS), Silence::Expired);
        assert_eq!(silence_state(u64::MAX), Silence::Expired);
        const { assert!(SILENCE_WARN_MS < SILENCE_FAIL_MS) };
    }

    #[test]
    fn human_review_keeps_the_watchdog_alive_but_still_allows_stop() {
        use super::*;
        let started = std::time::Instant::now();
        let reviewed = started + std::time::Duration::from_secs(3_600);
        let mut supervisor = Supervisor::new(started);
        assert_eq!(
            supervisor.observe(reviewed, true, false, child_process::Status::Running, false),
            Supervision::Continue
        );
        assert_eq!(
            supervisor.observe(
                reviewed + std::time::Duration::from_millis(SILENCE_FAIL_MS),
                false,
                false,
                child_process::Status::Running,
                false
            ),
            Supervision::Expired
        );
        assert_eq!(
            supervisor.observe(reviewed, true, false, child_process::Status::Stopped, true),
            Supervision::Finish
        );
    }

    #[test]
    fn supervisor_handles_exit_and_stop_without_waiting_for_inherited_pipe_eof() {
        use super::*;
        let started = std::time::Instant::now();
        for status in [
            child_process::Status::Exited(Some(0)),
            child_process::Status::Stopped,
        ] {
            let mut supervisor = Supervisor::new(started);
            assert_eq!(
                supervisor.observe(started, false, false, status, false),
                Supervision::Continue
            );
            assert_eq!(
                supervisor.observe(
                    started + std::time::Duration::from_millis(OUTPUT_DRAIN_MS),
                    false,
                    false,
                    status,
                    false
                ),
                Supervision::Finish
            );
        }
    }

    #[test]
    fn supervisor_checks_silence_even_after_pipe_eof_and_accepts_output_at_the_deadline() {
        use super::*;
        let started = std::time::Instant::now();
        let mut supervisor = Supervisor::new(started);
        let running = child_process::Status::Running;
        let warning = started + std::time::Duration::from_millis(SILENCE_WARN_MS);
        assert_eq!(
            supervisor.observe(warning, false, false, running, true),
            Supervision::Warn
        );
        assert_eq!(
            supervisor.observe(warning, false, false, running, true),
            Supervision::Continue
        );
        let deadline = started + std::time::Duration::from_millis(SILENCE_FAIL_MS);
        assert_eq!(
            supervisor.observe(deadline, true, false, running, false),
            Supervision::Continue
        );
        assert_eq!(
            supervisor.observe(
                deadline + std::time::Duration::from_millis(SILENCE_FAIL_MS),
                false,
                false,
                running,
                true
            ),
            Supervision::Expired
        );
    }

    #[test]
    fn terminal_event_bounds_cleanup_of_a_process_that_never_exits() {
        use super::*;
        let started = std::time::Instant::now();
        let mut supervisor = Supervisor::new(started);
        assert_eq!(
            supervisor.observe(started, true, true, child_process::Status::Running, false),
            Supervision::Continue
        );
        assert_eq!(
            supervisor.observe(
                started + std::time::Duration::from_millis(OUTPUT_DRAIN_MS),
                false,
                true,
                child_process::Status::Running,
                false
            ),
            Supervision::Finish
        );
    }

    #[test]
    fn a_completion_read_during_timeout_cleanup_keeps_its_status_and_answer() {
        use super::*;
        let completed = || {
            Some(AgentEvent::TurnEnd {
                status: "completed".into(),
                text: Some("Finished answer".into()),
                reason: None,
            })
        };
        for (timeout, cleanup) in [(Some("Timeout".to_owned()), false), (None, true)] {
            let terminal =
                resolve_terminal(Provider::Muse, completed(), None, timeout, cleanup, None);
            assert!(
                matches!(terminal, AgentEvent::TurnEnd { status, text: Some(text), reason: None } if status == "completed" && text == "Finished answer")
            );
        }
        let stopped = resolve_terminal(Provider::Muse, completed(), None, None, false, None);
        assert!(matches!(stopped, AgentEvent::TurnEnd { status, .. } if status == "cancelled"));
        let exited = resolve_terminal(
            Provider::Muse,
            completed(),
            Some(Some(1)),
            Some("Timeout".into()),
            false,
            None,
        );
        assert!(matches!(exited, AgentEvent::TurnEnd { status, .. } if status == "failed"));
    }

    #[test]
    fn a_silent_turn_fails_and_provider_failures_survive_terminal_cleanup() {
        use super::*;
        let terminal = resolve_terminal(
            Provider::Muse,
            None,
            None,
            Some("No output for 10 minutes".into()),
            false,
            None,
        );
        assert!(
            matches!(terminal, AgentEvent::TurnEnd { status, reason: Some(reason), .. } if status == "failed" && reason == "No output for 10 minutes")
        );
        let failed = Some(AgentEvent::TurnEnd {
            status: "failed".into(),
            text: None,
            reason: Some("Provider failure".into()),
        });
        let terminal = resolve_terminal(Provider::Muse, failed, None, None, true, None);
        assert!(
            matches!(terminal, AgentEvent::TurnEnd { status, reason: Some(reason), .. } if status == "failed" && reason == "Provider failure")
        );
    }

    /// Stopping a turn must terminate the whole shim chain (`cmd` ->
    /// grandchild), not just the direct child, or survivors hold stdout open
    /// and the turn never ends. Spawns a real `cmd /C ping` chain, kills it,
    /// and asserts our pings are gone while pre-existing ones survive.
    /// Flake note: concurrent `ping.exe` churn on the machine inside the
    /// ~3s test window could confuse the baseline; pings are rare enough
    /// that this is accepted (the poll window right after spawn is ~300ms).
    #[cfg(windows)]
    #[test]
    fn kill_tree_terminates_descendants() {
        use std::collections::HashSet;
        use std::process::{Command, Stdio};

        fn ping_pids() -> HashSet<u32> {
            let out = Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq ping.exe", "/FO", "CSV", "/NH"])
                .stdin(Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(Stdio::null())
                .output();
            let mut pids = HashSet::new();
            if let Ok(out) = out {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    // "ping.exe","1234","Console","1","8,192 K"
                    if let Some(pid) = line.split("\",\"").nth(1) {
                        if let Ok(pid) = pid.trim_matches('"').parse::<u32>() {
                            pids.insert(pid);
                        }
                    }
                }
            }
            pids
        }

        let before = ping_pids();
        let child = crate::child_process::Child::spawn(
            Command::new("cmd")
                .args(["/C", "ping -n 30 127.0.0.1 > NUL"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .expect("spawn shim chain");
        // Catch the grandchild the moment it appears (tight window keeps
        // foreign pings out of our set).
        let mut ours = HashSet::new();
        for _ in 0..30 {
            ours = ping_pids().difference(&before).copied().collect();
            if !ours.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(!ours.is_empty(), "grandchild ping never appeared");
        drop(child);
        std::thread::sleep(std::time::Duration::from_secs(2));
        let after = ping_pids();
        assert!(
            ours.iter().all(|p| !after.contains(p)),
            "grandchild survived tree kill: {after:?}"
        );
        assert!(
            before.iter().all(|p| after.contains(p)),
            "pre-existing ping reaped: {after:?}"
        );
    }
}
