//! Persistent, bounded task scheduling. No model call occurs until a job is due.
use crate::{bots, kanban, provider_models::RunOptions, providers::Provider, storage};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

pub fn now() -> u64 {
    Utc::now().timestamp().max(0) as u64
}
fn execution_limit_reached(
    now: u64,
    started: u64,
    waited: u64,
    waiting: bool,
    max_minutes: u32,
) -> bool {
    !waiting && now.saturating_sub(started).saturating_sub(waited) > u64::from(max_minutes) * 60
}
pub fn next_due(expression: &str, timezone: &str, after: u64) -> Result<u64, String> {
    if expression.len() > 100 || expression.split_whitespace().count() != 5 {
        return Err("Use five cron fields: minute hour day month weekday.".into());
    }
    let cron =
        croner::Cron::from_str(expression).map_err(|e| format!("Invalid cron schedule: {e}"))?;
    let zone: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| "Choose an IANA timezone, such as America/Los_Angeles or UTC.")?;
    let start = zone
        .timestamp_opt(after.min(i64::MAX as u64) as i64, 0)
        .single()
        .ok_or("Invalid schedule time.")?;
    cron.find_next_occurrence(&start, false)
        .map(|v| v.timestamp() as u64)
        .map_err(|e| format!("No upcoming run: {e}"))
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub bot_id: String,
    pub cron: String,
    pub timezone: String,
    pub automatic: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub workspace: String,
    pub card_id: String,
    pub title: String,
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub priority: String,
    pub assignment: Assignment,
    pub next_run: u64,
    pub paused: bool,
    pub status: String,
    pub last_error: String,
    pub failures: u32,
    pub chain: u32,
    pub handoff: String,
    pub day: u64,
    pub day_runs: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Run {
    #[serde(default)]
    pub workspace: String,
    pub id: String,
    pub job_id: String,
    pub session_id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub provider: Provider,
    pub options: RunOptions,
    pub task: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub status: String,
    pub output: String,
    pub detail: String,
    pub max_minutes: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub enabled: bool,
    pub jobs: Vec<Job>,
    pub runs: Vec<Run>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            enabled: true,
            jobs: vec![],
            runs: vec![],
        }
    }
}
#[derive(Serialize)]
pub struct View {
    #[serde(flatten)]
    pub snapshot: Snapshot,
    pub warning: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    List {},
    Configure { enabled: bool },
    Pause { id: String, paused: bool },
    Run { id: String },
    Stop { id: String },
    Preview { cron: String, timezone: String },
}
pub struct Store {
    path: PathBuf,
    state: Mutex<Snapshot>,
    warning: Mutex<Option<String>>,
    read_only: bool,
    stopped: AtomicBool,
}
fn shorten(text: &str, limit: usize) -> String {
    let mut n = text.len().min(limit);
    while !text.is_char_boundary(n) {
        n -= 1;
    }
    text[..n].into()
}
fn key(workspace: &str, card: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{workspace}\n{card}").as_bytes())
    )
}
pub(crate) fn canonical(workspace: &str) -> Result<String, String> {
    let p = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !p.is_dir() {
        return Err("Choose a workspace folder.".into());
    }
    let p = p.to_string_lossy().into_owned();
    Ok(if cfg!(windows) { p.to_lowercase() } else { p })
}
impl Store {
    fn load(path: PathBuf) -> Self {
        let result: Result<Snapshot, String> = (|| {
            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut bytes = vec![];
            file.take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("Schedule storage exceeds its limit.".into());
            }
            let s: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if s.jobs.len() > 500 || s.runs.len() > 100 {
                return Err("Schedule storage exceeds its limits.".into());
            }
            Ok(s)
        })();
        let mut read_only = false;
        let (mut state, warning) = match result {
            Ok(s) => (s, None),
            Err(_) if !path.exists() => (Snapshot::default(), None),
            Err(e) => {
                let backup = path.with_extension(format!("corrupt-{}.json", uuid::Uuid::new_v4()));
                let recovery = match fs::copy(&path, &backup) {
                    Ok(_) => format!("The original file was preserved at {}.", backup.display()),
                    Err(error) => {
                        read_only = true;
                        format!("Could not preserve the original file ({error}). Repair {} before changing schedules.",path.display())
                    }
                };
                (
                    Snapshot {
                        enabled: false,
                        ..Snapshot::default()
                    },
                    Some(format!(
                        "Schedules could not be loaded; automation is paused. {recovery} {e}"
                    )),
                )
            }
        };
        // Never replay a possibly partially completed task after a process crash.
        let mut recovered = false;
        for run in &mut state.runs {
            if run.status == "running" {
                recovered = true;
                run.status = "interrupted".into();
                run.finished_at = Some(now());
                run.detail =
                    "Velum stopped during this run. Check partial changes before running it again."
                        .into();
                if let Some(job) = state.jobs.iter_mut().find(|j| j.id == run.job_id) {
                    job.paused = true;
                    job.status = "interrupted".into();
                }
            }
        }
        if recovered {
            let _ = storage::write_json(&path, &state);
        }
        Self {
            path,
            state: Mutex::new(state),
            warning: Mutex::new(warning),
            read_only,
            stopped: AtomicBool::new(false),
        }
    }
    fn edit<T>(&self, f: impl FnOnce(&mut Snapshot) -> Result<T, String>) -> Result<T, String> {
        if self.read_only {
            return Err("Schedule storage needs repair before changes can be saved.".into());
        }
        let mut state = self.state.lock().unwrap();
        let mut next = state.clone();
        let result = f(&mut next)?;
        storage::write_json(&self.path, &next)?;
        *state = next;
        Ok(result)
    }
    pub fn view(&self) -> View {
        View {
            snapshot: self.state.lock().unwrap().clone(),
            warning: self.warning.lock().unwrap().clone(),
        }
    }
    pub fn managed(&self, id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .runs
            .iter()
            .any(|r| r.session_id == id && r.status == "running")
    }
    pub fn sync(&self, workspace: &str, board: &kanban::Board) -> Result<(), String> {
        let workspace = canonical(workspace)?;
        let desired = board
            .cards
            .iter()
            .filter_map(|c| c.assignment.as_ref().map(|a| (c, a)))
            .collect::<Vec<_>>();
        let unchanged = {
            let s = self.state.lock().unwrap();
            let existing = s
                .jobs
                .iter()
                .filter(|j| j.workspace == workspace)
                .collect::<Vec<_>>();
            existing.len() == desired.len()
                && desired.iter().all(|(c, a)| {
                    existing.iter().any(|j| {
                        j.card_id == c.id
                            && j.title == c.title
                            && j.blocked_by == kanban::blockers(board, c)
                            && j.due_date == c.due_date
                            && j.priority == c.priority
                            && j.assignment == **a
                            && (if c.column == "done" || c.column == "review" {
                                j.status == "complete"
                            } else {
                                j.status != "complete"
                            })
                    })
                })
        };
        if unchanged {
            return Ok(());
        }
        self.edit(|s| {
            s.jobs.retain(|j| {
                j.workspace != workspace || desired.iter().any(|(c, _)| c.id == j.card_id)
            });
            for (card, assignment) in desired {
                let id = key(&workspace, &card.id);
                let complete = card.column == "done" || card.column == "review";
                let blocked_by = kanban::blockers(board, card);
                if let Some(job) = s.jobs.iter_mut().find(|j| j.id == id) {
                    if job.assignment != *assignment || job.status == "complete" && !complete {
                        job.assignment = assignment.clone();
                        job.next_run = next_due(&assignment.cron, &assignment.timezone, now())?;
                        job.paused = false;
                        job.chain = 0;
                        job.handoff.clear();
                        job.failures = 0;
                        job.last_error.clear();
                        job.status = if assignment.automatic {
                            "scheduled"
                        } else {
                            "approval"
                        }
                        .into();
                    }
                    job.title = card.title.clone();
                    job.blocked_by = blocked_by;
                    job.due_date = card.due_date.clone();
                    job.priority = card.priority.clone();
                    if complete {
                        job.status = "complete".into();
                    } else if job.status != "running" && !job.blocked_by.is_empty() {
                        job.status = "waiting".into();
                    } else if job.status == "waiting" {
                        job.status = if assignment.automatic {
                            "scheduled"
                        } else {
                            "approval"
                        }
                        .into();
                    }
                } else {
                    if s.jobs.len() >= 500 {
                        return Err("Up to 500 scheduled tasks are supported.".into());
                    }
                    s.jobs.push(Job {
                        id,
                        workspace: workspace.clone(),
                        card_id: card.id.clone(),
                        title: card.title.clone(),
                        blocked_by: blocked_by.clone(),
                        due_date: card.due_date.clone(),
                        priority: card.priority.clone(),
                        assignment: assignment.clone(),
                        next_run: next_due(&assignment.cron, &assignment.timezone, now())?,
                        paused: false,
                        status: if complete {
                            "complete"
                        } else if !blocked_by.is_empty() {
                            "waiting"
                        } else if assignment.automatic {
                            "scheduled"
                        } else {
                            "approval"
                        }
                        .into(),
                        last_error: String::new(),
                        failures: 0,
                        chain: 0,
                        handoff: String::new(),
                        day: 0,
                        day_runs: 0,
                    });
                }
            }
            Ok(())
        })
    }
}
pub fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("automation-changed", ());
    crate::remote::changed(app);
}
pub fn sync(app: &tauri::AppHandle, workspace: &str, board: &kanban::Board) -> Result<(), String> {
    app.state::<Store>().sync(workspace, board)?;
    changed(app);
    Ok(())
}
pub fn setup(app: &tauri::AppHandle) {
    let root = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_config_dir().unwrap());
    app.manage(Store::load(root.join("automation.json")));
    let app = app.clone();
    std::thread::spawn(move || {
        while app.state::<crate::runner::AgentState>().startup_pending() {
            if app.state::<Store>().stopped.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Reconcile checkpoints once after restart, including a board write that
        // committed immediately before a crash interrupted its scheduler sync.
        let workspaces: std::collections::HashSet<_> = app
            .state::<Store>()
            .view()
            .snapshot
            .jobs
            .iter()
            .map(|j| j.workspace.clone())
            .collect();
        for workspace in workspaces {
            let result = app
                .state::<kanban::Store>()
                .request(&workspace, kanban::Request::Load {})
                .and_then(|board| sync(&app, &workspace, &board));
            if let Err(error) = result {
                let store = app.state::<Store>();
                let mut warning = store.warning.lock().unwrap();
                if warning.is_none() {
                    *warning = Some(format!("Could not reconcile a task board at startup: {error}. Open and refresh its board before resuming work."));
                }
                drop(warning);
                changed(&app);
            }
        }
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if app.state::<Store>().stopped.load(Ordering::Acquire) {
                break;
            }
            if let Err(e) = tick(&app) {
                let store = app.state::<Store>();
                let mut warning = store.warning.lock().unwrap();
                if warning.as_ref() != Some(&e) {
                    *warning = Some(e);
                    drop(warning);
                    changed(&app);
                }
            }
        }
    });
}
pub fn shutdown(app: &tauri::AppHandle) {
    app.state::<Store>().stopped.store(true, Ordering::Release);
}
fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<crate::runner::AgentState>().work_blocked() {
        return Ok(());
    }
    let snapshot = app.state::<Store>().view().snapshot;
    if let Some(run) = snapshot.runs.iter().find(|r| r.status == "running") {
        let (waiting, waited) = app
            .state::<crate::runner::AgentState>()
            .review_wait(&run.session_id);
        const WAITING: &str = "Waiting for your response. Open this run in Bots > Activity, or its session on a phone with control access.";
        if (waiting && run.detail.is_empty()) || (!waiting && run.detail == WAITING) {
            app.state::<Store>().edit(|snapshot| {
                if let Some(current) = snapshot.runs.iter_mut().find(|r| r.id == run.id) {
                    current.detail = if waiting {
                        WAITING.into()
                    } else {
                        String::new()
                    };
                }
                Ok(())
            })?;
            changed(app);
        }
        let current = (|| {
            let bot = app.state::<bots::Store>().get(&run.bot_id)?;
            if !bot.enabled {
                return Err("The bot was disabled.".to_owned());
            }
            let job = snapshot
                .jobs
                .iter()
                .find(|j| j.id == run.job_id)
                .ok_or("The task assignment was removed.")?;
            if job.assignment.bot_id != run.bot_id || job.paused {
                return Err("The task was reassigned or paused.".into());
            }
            let board = app
                .state::<kanban::Store>()
                .request(&job.workspace, kanban::Request::Load {})?;
            let card = board
                .cards
                .iter()
                .find(|c| c.id == job.card_id)
                .ok_or("The task was removed.")?;
            if card.assignment.as_ref() != Some(&job.assignment)
                || matches!(card.column.as_str(), "review" | "done")
            {
                return Err("The task assignment or status changed.".into());
            }
            if !kanban::blockers(&board, card).is_empty() {
                return Err("A prerequisite is no longer complete. Review the task dependencies before continuing.".into());
            }
            if execution_limit_reached(now(), run.started_at, waited, waiting, run.max_minutes) {
                return Err("The run reached its time limit.".into());
            }
            Ok::<(), String>(())
        })();
        if let Err(reason) = current {
            app.state::<Store>().edit(|s| {
                if let Some(j) = s.jobs.iter_mut().find(|j| j.id == run.job_id) {
                    j.last_error = reason.clone();
                }
                if let Some(r) = s.runs.iter_mut().find(|r| r.id == run.id) {
                    r.detail = reason;
                }
                Ok(())
            })?;
            // Do not stop processes while holding the scheduler or runner registry lock.
            app.state::<crate::runner::AgentState>()
                .stop_id(&run.session_id);
        }
        return Ok(());
    }
    if !snapshot.enabled {
        return Ok(());
    }
    let mut eligible: Vec<_> = snapshot
        .jobs
        .iter()
        .filter(|j| {
            !j.paused
                && j.blocked_by.is_empty()
                && j.assignment.automatic
                && j.status != "complete"
                && j.next_run <= now()
        })
        .collect();
    eligible.sort_by_key(|j| {
        (
            j.due_date.as_deref().unwrap_or("9999-12-31"),
            match j.priority.as_str() {
                "high" => 0,
                "low" => 2,
                _ => 1,
            },
            j.next_run,
        )
    });
    for job in eligible {
        if app
            .state::<crate::runner::AgentState>()
            .workspace_busy(&job.workspace)
        {
            continue;
        }
        if let Err(error) = start(app, &job.id, false) {
            app.state::<Store>().edit(|s| {
                if let Some(j) = s.jobs.iter_mut().find(|j| j.id == job.id) {
                    j.paused = true;
                    j.status = "blocked".into();
                    j.last_error = error.clone();
                }
                Ok(())
            })?;
            changed(app);
            break;
        }
        if app
            .state::<Store>()
            .view()
            .snapshot
            .runs
            .iter()
            .any(|r| r.status == "running")
        {
            break;
        }
    }
    Ok(())
}
fn start(app: &tauri::AppHandle, id: &str, manual: bool) -> Result<(), String> {
    if app.state::<crate::runner::AgentState>().work_blocked() {
        return Err("Velum is preparing an app update. Try again when it opens.".into());
    }
    let store = app.state::<Store>();
    let mut job = store
        .state
        .lock()
        .unwrap()
        .jobs
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or("Scheduled task no longer exists.")?;
    let board = app
        .state::<kanban::Store>()
        .request(&job.workspace, kanban::Request::Load {})?;
    let card = board
        .cards
        .iter()
        .find(|c| c.id == job.card_id)
        .ok_or("This task was removed. Refresh the board.")?;
    if card.assignment.as_ref() != Some(&job.assignment)
        || matches!(card.column.as_str(), "review" | "done")
    {
        store.sync(&job.workspace, &board)?;
        return Ok(());
    }
    let blocked_by = kanban::blockers(&board, card);
    if !blocked_by.is_empty() {
        store.sync(&job.workspace, &board)?;
        changed(app);
        return if manual {
            Err(format!(
                "Complete these prerequisites first: {}",
                blocked_by.join("; ")
            ))
        } else {
            Ok(())
        };
    }
    let profile = app.state::<bots::Store>().get(&job.assignment.bot_id)?;
    if !profile.enabled {
        return Err(format!(
            "{} is disabled. Enable the bot before running its tasks.",
            profile.name
        ));
    }
    if profile.options.model.is_empty() {
        return Err(format!(
            "Choose a model for {} before scheduling work.",
            profile.name
        ));
    }
    if app
        .state::<crate::runner::AgentState>()
        .workspace_busy(&job.workspace)
    {
        return Err(
            "Another turn is working in this workspace. Try again when it finishes.".into(),
        );
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let session_id = format!("bot-run-{run_id}");
    let time = now();
    let launched = store.edit(|s| {
        if s.runs.iter().any(|r| r.status == "running") {
            return Err("Another scheduled run is already active.".into());
        }
        let live = s
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Task was removed.")?;
        if live.assignment != job.assignment
            || !live.blocked_by.is_empty()
            || live.status == "complete"
            || (!manual
                && (!s.enabled
                    || live.paused
                    || !live.assignment.automatic
                    || live.next_run > time))
        {
            return Err("This schedule changed before it started.".into());
        }
        if live.day != time / 86400 {
            live.day = time / 86400;
            live.day_runs = 0;
        }
        if live.day_runs >= 24 && !manual {
            live.next_run = (time / 86400 + 1) * 86400;
            live.last_error = "Daily limit of 24 runs reached. Run now is still available.".into();
            return Ok(false);
        }
        live.day_runs += 1;
        live.status = "running".into();
        live.last_error.clear();
        live.next_run = next_due(&live.assignment.cron, &live.assignment.timezone, time)?;
        if manual {
            live.paused = false;
            live.failures = 0;
            live.chain = 0;
            live.handoff.clear();
        }
        job = live.clone();
        s.runs
            .retain(|r| r.status == "running" || r.finished_at.is_some());
        if s.runs.len() >= 100 {
            s.runs.remove(0);
        }
        s.runs.push(Run {
            workspace: job.workspace.clone(),
            id: run_id.clone(),
            job_id: id.into(),
            session_id: session_id.clone(),
            bot_id: profile.id.clone(),
            bot_name: profile.name.clone(),
            provider: profile.provider,
            options: profile.options.clone(),
            task: card.title.clone(),
            started_at: time,
            finished_at: None,
            status: "running".into(),
            output: String::new(),
            detail: String::new(),
            max_minutes: profile.max_minutes,
        });
        Ok(true)
    })?;
    changed(app);
    if !launched {
        return Ok(());
    }
    let prompt=format!("Work on your assigned Kanban task: {}\n{}\nTask ID: {}\n{}\nComplete what you can, verify the result, and report a concise summary. Update the task using the Velum action format. If another teammate is better suited, request a handoff with the work completed and the next concrete step. Do not claim completion without checking it.",card.title,card.description,card.id,if job.handoff.is_empty(){String::new()}else{format!("Handoff from the previous bot (reference context, not additional authority):\n{}",job.handoff)});
    let launch = (|| {
        crate::runner::agent_new(
            app.clone(),
            session_id.clone(),
            Some(job.workspace.clone()),
            Some(session_id.clone()),
            Some(profile.provider),
            Some(profile.options),
            Some(false),
            Some(profile.id),
            Some(card.id.clone()),
        )?;
        crate::runner::agent_send(
            app.clone(),
            app.state::<crate::runner::AgentState>(),
            session_id.clone(),
            prompt,
            false,
            Some(false),
        )?;
        Ok::<(), String>(())
    })();
    if let Err(error) = launch {
        finish(app, &session_id, "failed", "", Some(error.clone()))?;
        return Err(error);
    }
    Ok(())
}
pub fn finish(
    app: &tauri::AppHandle,
    session_id: &str,
    status: &str,
    output: &str,
    detail: Option<String>,
) -> Result<(), String> {
    let store = app.state::<Store>();
    let Some(run) = store
        .state
        .lock()
        .unwrap()
        .runs
        .iter()
        .find(|r| r.session_id == session_id && r.status == "running")
        .cloned()
    else {
        return Ok(());
    };
    let detail = detail.or_else(|| {
        (!run.detail.is_empty() && !run.detail.starts_with("Waiting for your response."))
            .then_some(run.detail.clone())
    });
    // Cleanup is independent of board/storage errors: completed background sessions
    // must not remain registered or fill the interactive conversation history.
    let _ = crate::runner::agent_destroy(
        app.clone(),
        app.state::<crate::runner::AgentState>(),
        session_id.into(),
    );
    let _ = crate::history::history_forget(
        app.state::<crate::history::HistoryState>(),
        session_id.into(),
    );
    store.edit(|s| {
        if let Some(r) = s.runs.iter_mut().find(|r| r.id == run.id) {
            r.status = status.into();
            r.output = shorten(output, 16000);
            r.detail = shorten(detail.as_deref().unwrap_or(""), 2000);
            r.finished_at = Some(now());
        }
        if let Some(j) = s
            .jobs
            .iter_mut()
            .find(|j| j.id == run.job_id && j.assignment.bot_id == run.bot_id)
        {
            if status == "completed" {
                j.failures = 0;
                if j.status == "running" {
                    j.status = if j.assignment.automatic {
                        "scheduled"
                    } else {
                        "approval"
                    }
                    .into();
                }
            } else {
                j.failures += 1;
                j.status = status.into();
                j.last_error = detail.clone().unwrap_or_else(|| {
                    if status == "cancelled" {
                        "Run stopped or reached its time limit.".into()
                    } else {
                        "The provider run failed. Open its result for details.".into()
                    }
                });
                if matches!(status, "cancelled" | "review" | "blocked") || j.failures >= 3 {
                    j.paused = true;
                }
            }
        }
        Ok(())
    })?;
    // A successful run without an explicit continuation request waits for review.
    if status == "completed" {
        let job = store
            .state
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|j| j.id == run.job_id)
            .cloned();
        if let Some(job) = job {
            let board = app
                .state::<kanban::Store>()
                .request(&job.workspace, kanban::Request::Load {})?;
            if let Some(card) = board.cards.iter().find(|c| {
                c.id == job.card_id
                    && c.assignment
                        .as_ref()
                        .is_some_and(|a| a.bot_id == run.bot_id)
            }) {
                if !kanban::blockers(&board, card).is_empty() {
                    // A short run can finish before the next scheduler tick notices
                    // a reopened prerequisite. Keep the card blocked in that case.
                    store.sync(&job.workspace, &board)?;
                    store.edit(|s| {
                        let detail = "A prerequisite changed during this run. Review its result and the task dependencies before continuing.";
                        if let Some(j) = s.jobs.iter_mut().find(|j| j.id == run.job_id) {
                            j.paused = true;
                            j.last_error = detail.into();
                        }
                        if let Some(r) = s.runs.iter_mut().find(|r| r.id == run.id) {
                            r.status = "review".into();
                            r.detail = detail.into();
                        }
                        Ok(())
                    })?;
                } else if card.column == "backlog" || card.column == "progress" {
                    // An action sets last_summary; no action means ask the user to review.
                    if card.last_run.as_deref() != Some(session_id) {
                        let updated = app.state::<kanban::Store>().request(
                            &job.workspace,
                            kanban::Request::Move {
                                revision: board.revision,
                                id: card.id.clone(),
                                column: "review".into(),
                                before: None,
                            },
                        )?;
                        store.sync(&job.workspace, &updated)?;
                    }
                }
            }
        }
    }
    changed(app);
    Ok(())
}
pub fn handoff(
    app: &tauri::AppHandle,
    workspace: &str,
    card_id: &str,
    summary: &str,
    chain: u32,
) -> Result<(), String> {
    let id = key(&canonical(workspace)?, card_id);
    app.state::<Store>().edit(|s| {
        let j = s
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Handoff schedule could not be found.")?;
        j.chain = chain;
        j.handoff = shorten(summary, 4000);
        j.next_run = now() + 5;
        Ok(())
    })?;
    changed(app);
    Ok(())
}
pub fn chain(app: &tauri::AppHandle, session_id: &str) -> u32 {
    let store = app.state::<Store>();
    let s = store.state.lock().unwrap();
    s.runs
        .iter()
        .find(|r| r.session_id == session_id && r.status == "running")
        .and_then(|r| s.jobs.iter().find(|j| j.id == r.job_id))
        .map(|j| j.chain)
        .unwrap_or(0)
}
pub fn request(app: &tauri::AppHandle, q: Request) -> Result<serde_json::Value, String> {
    let store = app.state::<Store>();
    match q {
        Request::List {} => return serde_json::to_value(store.view()).map_err(|e| e.to_string()),
        Request::Preview { cron, timezone } => {
            let mut time = now();
            let mut times = vec![];
            for _ in 0..3 {
                time = next_due(&cron, &timezone, time)?;
                times.push(time);
            }
            return Ok(serde_json::json!({"times":times}));
        }
        Request::Configure { enabled } => {
            store.edit(|s| {
                s.enabled = enabled;
                Ok(())
            })?;
        }
        Request::Pause { id, paused } => {
            store.edit(|s| {
                let j = s
                    .jobs
                    .iter_mut()
                    .find(|j| j.id == id)
                    .ok_or("Task no longer exists.")?;
                j.paused = paused;
                if !paused {
                    j.failures = 0;
                    j.last_error.clear();
                    j.next_run = next_due(&j.assignment.cron, &j.assignment.timezone, now())?;
                }
                Ok(())
            })?;
        }
        Request::Run { id } => start(app, &id, true)?,
        Request::Stop { id } => {
            let sessions = store.edit(|s| {
                if let Some(j) = s.jobs.iter_mut().find(|j| j.id == id) {
                    j.paused = true;
                }
                Ok(s.runs
                    .iter()
                    .filter(|r| r.job_id == id && r.status == "running")
                    .map(|r| r.session_id.clone())
                    .collect::<Vec<_>>())
            })?;
            for id in sessions {
                app.state::<crate::runner::AgentState>().stop_id(&id);
            }
        }
    }
    changed(app);
    serde_json::to_value(store.view()).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn automation_request(
    app: tauri::AppHandle,
    request: Request,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || self::request(&app, request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_wait_does_not_consume_scheduled_execution_time() {
        assert!(!execution_limit_reached(100_000, 100, 0, true, 1));
        assert!(!execution_limit_reached(3_760, 100, 3_600, false, 1));
        assert!(execution_limit_reached(3_761, 100, 3_600, false, 1));
        assert!(!execution_limit_reached(50, 100, 3_600, false, 1));
    }
    fn temp() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("velum-schedule-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn card() -> kanban::Card {
        kanban::Card {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Review a change".into(),
            description: String::new(),
            column: "backlog".into(),
            priority: "normal".into(),
            assignment: Some(Assignment {
                bot_id: uuid::Uuid::new_v4().to_string(),
                cron: "*/15 * * * *".into(),
                timezone: "UTC".into(),
                automatic: true,
            }),
            last_summary: String::new(),
            last_run: None,
            ..Default::default()
        }
    }
    #[test]
    fn cron_respects_timezones_dst_and_strict_five_fields() {
        let timestamp =
            |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp() as u64;
        assert_eq!(
            next_due(
                "0 9 * * *",
                "America/Los_Angeles",
                timestamp("2026-03-07T18:00:00Z")
            )
            .unwrap(),
            timestamp("2026-03-08T16:00:00Z")
        );
        assert_eq!(
            next_due(
                "0 9 * * *",
                "America/Los_Angeles",
                timestamp("2026-10-31T17:00:00Z")
            )
            .unwrap(),
            timestamp("2026-11-01T17:00:00Z")
        );
        assert_eq!(
            next_due("*/15 * * * *", "UTC", timestamp("2026-09-27T01:00:00Z")).unwrap(),
            timestamp("2026-09-27T01:15:00Z")
        );
        for cron in ["* * * * * *", "99 * * * *", "@every 2m"] {
            assert!(next_due(cron, "UTC", now()).is_err());
        }
        assert!(next_due("* * * * *", "unknown", now()).is_err());
    }
    #[test]
    fn assignment_creates_one_job_preserves_pause_and_finishes_with_the_board() {
        let root = temp();
        let store = Store::load(root.join("automation.json"));
        let workspace = root.display().to_string();
        let mut board = kanban::Board {
            trash: vec![],
            revision: 1,
            cards: vec![card()],
        };
        store.sync(&workspace, &board).unwrap();
        let original = fs::read(&store.path).unwrap();
        store.sync(&workspace, &board).unwrap();
        assert_eq!(fs::read(&store.path).unwrap(), original);
        assert_eq!(store.view().snapshot.jobs.len(), 1);
        store
            .edit(|s| {
                s.jobs[0].paused = true;
                Ok(())
            })
            .unwrap();
        board.cards[0].title = "Renamed task".into();
        store.sync(&workspace, &board).unwrap();
        assert!(store.view().snapshot.jobs[0].paused);
        board.cards[0].column = "review".into();
        store.sync(&workspace, &board).unwrap();
        assert_eq!(store.view().snapshot.jobs[0].status, "complete");
        board.cards[0].column = "progress".into();
        board.cards[0].assignment.as_mut().unwrap().automatic = false;
        store.sync(&workspace, &board).unwrap();
        let s = store.view().snapshot;
        assert!(!s.jobs[0].paused);
        assert_eq!(s.jobs[0].status, "approval");
        board.cards[0].assignment = None;
        store.sync(&workspace, &board).unwrap();
        assert!(store.view().snapshot.jobs.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_recovery_pauses_without_replaying_and_corruption_is_preserved() {
        let root = temp();
        let file = root.join("automation.json");
        let store = Store::load(file.clone());
        store
            .sync(
                &root.display().to_string(),
                &kanban::Board {
                    trash: vec![],
                    revision: 0,
                    cards: vec![card()],
                },
            )
            .unwrap();
        store
            .edit(|s| {
                let job = &mut s.jobs[0];
                job.status = "running".into();
                s.runs.push(Run {
                    workspace: job.workspace.clone(),
                    id: "run".into(),
                    job_id: job.id.clone(),
                    session_id: "bot-run-test".into(),
                    bot_id: job.assignment.bot_id.clone(),
                    bot_name: "Grokbot".into(),
                    provider: Provider::Muse,
                    options: RunOptions::default(),
                    task: job.title.clone(),
                    started_at: now(),
                    finished_at: None,
                    status: "running".into(),
                    output: String::new(),
                    detail: String::new(),
                    max_minutes: 20,
                });
                Ok(())
            })
            .unwrap();
        let recovered = Store::load(file.clone()).view().snapshot;
        assert!(recovered.jobs[0].paused);
        assert_eq!(recovered.runs[0].status, "interrupted");
        assert!(recovered.runs[0].finished_at.is_some());
        fs::write(&file, "broken original").unwrap();
        let corrupt = Store::load(file.clone());
        assert!(!corrupt.view().snapshot.enabled);
        assert!(corrupt.view().warning.unwrap().contains("preserved"));
        corrupt.edit(|_| Ok(())).unwrap();
        assert!(fs::read_dir(&root).unwrap().flatten().any(|f| f
            .file_name()
            .to_string_lossy()
            .contains("corrupt-")
            && fs::read_to_string(f.path()).unwrap() == "broken original"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_checkpoints_cannot_change_live_state() {
        let root = temp();
        let store = Store::load(root.join("automation.json"));
        fs::create_dir(&store.path).unwrap();
        assert!(store
            .edit(|s| {
                s.enabled = false;
                Ok(())
            })
            .is_err());
        assert!(store.view().snapshot.enabled);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn prerequisites_wait_until_done_and_never_clear_a_manual_pause() {
        let root = temp();
        let store = Store::load(root.join("automation.json"));
        let workspace = root.to_str().unwrap();
        let mut prerequisite = card();
        prerequisite.assignment = None;
        let mut dependent = card();
        dependent.dependencies.push(prerequisite.id.clone());
        dependent.due_date = Some("2027-01-01".into());
        dependent.priority = "high".into();
        let mut board = kanban::Board {
            cards: vec![prerequisite, dependent],
            ..Default::default()
        };
        store.sync(workspace, &board).unwrap();
        let job = store.view().snapshot.jobs.remove(0);
        assert_eq!(job.status, "waiting");
        assert_eq!(job.blocked_by.len(), 1);
        assert_eq!(job.priority, "high");
        assert_eq!(job.due_date.as_deref(), Some("2027-01-01"));
        board.cards[0].column = "review".into();
        store.sync(workspace, &board).unwrap();
        assert_eq!(
            store.view().snapshot.jobs[0].status,
            "waiting",
            "Review is not Done"
        );
        store
            .edit(|s| {
                s.jobs[0].paused = true;
                Ok(())
            })
            .unwrap();
        board.cards[0].column = "done".into();
        store.sync(workspace, &board).unwrap();
        let job = store.view().snapshot.jobs.remove(0);
        assert_eq!(job.status, "scheduled");
        assert!(job.blocked_by.is_empty());
        assert!(job.paused);
        board.cards[0].column = "backlog".into();
        store.sync(workspace, &board).unwrap();
        assert_eq!(store.view().snapshot.jobs[0].status, "waiting");
        board.cards.remove(0);
        store.sync(workspace, &board).unwrap();
        let job = store.view().snapshot.jobs.remove(0);
        assert!(job.blocked_by[0].contains("Deleted prerequisite"));
        assert!(job.paused);
        board.cards[0].dependencies.clear();
        board.cards[0].assignment.as_mut().unwrap().automatic = false;
        store.sync(workspace, &board).unwrap();
        assert_eq!(store.view().snapshot.jobs[0].status, "approval");
        fs::remove_dir_all(root).unwrap();
    }
}
