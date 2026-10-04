//! Bounded conversation snapshots, written by one background thread. No replay
//! serialization or disk writes happen on the token-stream path.
use crate::{events::AgentEvent, providers::Provider, session_log::SessionLog};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
pub struct Saved {
    #[serde(default)]
    pub queue: crate::message_queue::Snapshot,
    #[serde(default)]
    pub permission_mode: Option<bool>,
    #[serde(default)]
    pub bot_id: Option<String>,
    pub version: u32,
    pub workspace: String,
    pub provider: Provider,
    pub session_id: String,
    pub events: Vec<AgentEvent>,
    pub truncated: bool,
}
struct Binding {
    permission_mode: Option<bool>,
    bot_id: Option<String>,
    tab: String,
    workspace: String,
    provider: Provider,
    session_id: String,
    dirty: bool,
    truncated: bool,
}
pub struct HistoryState {
    root: PathBuf,
    bindings: Mutex<HashMap<String, Binding>>,
    io: Mutex<()>,
    forgotten: Mutex<HashSet<String>>,
    desktop: Mutex<Option<serde_json::Value>>,
    desktop_dirty: AtomicBool,
    stopped: AtomicBool,
}
fn valid_tab(tab: &str) -> bool {
    !tab.is_empty()
        && tab.len() <= 150
        && tab
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
impl HistoryState {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            bindings: Mutex::new(HashMap::new()),
            io: Mutex::new(()),
            forgotten: Mutex::new(HashSet::new()),
            desktop: Mutex::new(None),
            desktop_dirty: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }
    pub fn load(
        &self,
        tab: &str,
        workspace: &str,
        provider: Provider,
    ) -> Result<Option<Saved>, String> {
        if !valid_tab(tab) {
            return Err("Invalid conversation ID.".into());
        }
        let _io = self.io.lock().unwrap();
        let path = self.root.join(format!("{tab}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let mut bytes = vec![];
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Saved conversation exceeds the recovery limit.".into());
        }
        let mut saved: Saved = serde_json::from_slice(&bytes).map_err(|_| {
            "Saved conversation is damaged. Restart this conversation to start fresh.".to_string()
        })?;
        if saved.version != 1 {
            return Err("Saved conversation uses an unsupported history format.".into());
        }
        if saved.workspace != workspace || saved.provider != provider {
            return Ok(None);
        }
        if saved.session_id.len() > 200 || saved.session_id.chars().any(char::is_control) {
            return Err("Saved conversation has an invalid resume ID.".into());
        }
        if !saved.events.is_empty() && saved.session_id.is_empty() {
            saved.events.push(AgentEvent::Notice { text:"The provider did not return a resume ID before the interruption. Your transcript is restored; the next message starts a new provider conversation.".into() });
        }
        let running = saved
            .events
            .iter()
            .rev()
            .find_map(|e| match e {
                AgentEvent::TurnStart { .. } => Some(true),
                AgentEvent::TurnEnd { .. } => Some(false),
                _ => None,
            })
            .unwrap_or(false);
        if running {
            saved.events.push(AgentEvent::TurnEnd { status:"cancelled".into(),text:None,reason:Some("Velum Code closed during this response. It was not restarted automatically; check any partial changes before continuing.".into()) });
        }
        saved.queue = saved.queue.restore()?;
        saved
            .events
            .retain(|e| !matches!(e, AgentEvent::QueueState { .. }));
        if !saved.queue.items.is_empty() {
            saved.events.push(AgentEvent::QueueState {
                queue: saved.queue.clone(),
                running: false,
            });
        }
        Ok(Some(saved))
    }
    pub fn bind(
        &self,
        id: &str,
        tab: String,
        workspace: String,
        provider: Provider,
        session_id: String,
    ) {
        let forgotten = self.forgotten.lock().unwrap();
        if forgotten.contains(&tab) {
            return;
        }
        self.bindings.lock().unwrap().insert(
            id.into(),
            Binding {
                permission_mode: None,
                bot_id: None,
                tab,
                workspace,
                provider,
                session_id,
                dirty: true,
                truncated: false,
            },
        );
    }
    pub fn mark(&self, id: &str) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(id) {
            binding.dirty = true;
        }
    }
    pub fn mark_truncated(&self, id: &str) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(id) {
            binding.truncated = true;
            binding.dirty = true;
        }
    }
    pub fn resume_id(&self, id: &str, session_id: &str) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(id) {
            if binding.session_id != session_id {
                binding.session_id = session_id.into();
                binding.dirty = true;
            }
        }
    }
    pub fn permission_mode(&self, id: &str, yolo: bool) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(id) {
            binding.permission_mode = Some(yolo);
            binding.dirty = true;
        }
    }
    pub fn bind_bot(&self, id: &str, bot_id: Option<String>) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(id) {
            binding.bot_id = bot_id;
            binding.dirty = true;
        }
    }
    pub fn flush(&self, logs: &SessionLog) -> Result<(), String> {
        let _io = self.io.lock().unwrap();
        let pending: Vec<_> = self
            .bindings
            .lock()
            .unwrap()
            .iter_mut()
            .filter_map(|(id, b)| {
                if !b.dirty || !valid_tab(&b.tab) {
                    return None;
                }
                let replay = logs.replay(id, 0)?;
                b.dirty = false;
                Some((
                    id.clone(),
                    b.tab.clone(),
                    Saved {
                        queue: replay.session.queue.clone(),
                        permission_mode: b.permission_mode,
                        bot_id: b.bot_id.clone(),
                        version: 1,
                        workspace: b.workspace.clone(),
                        provider: b.provider,
                        session_id: b.session_id.clone(),
                        events: replay.events.into_iter().map(|e| e.event).collect(),
                        truncated: b.truncated || replay.truncated,
                    },
                ))
            })
            .collect();
        let mut failure = None;
        let desktop = if self.desktop_dirty.swap(false, Ordering::AcqRel) {
            self.desktop.lock().unwrap().clone()
        } else {
            None
        };
        if let Some(snapshot) = desktop {
            if let Err(error) =
                crate::storage::write_json(&self.root.join("desktop.json"), &snapshot)
            {
                self.desktop_dirty.store(true, Ordering::Release);
                failure = Some(error);
            }
        }
        for (id, tab, snapshot) in pending {
            if let Err(error) =
                crate::storage::write_json(&self.root.join(format!("{tab}.json")), &snapshot)
            {
                self.mark(&id);
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn unbind(&self, id: &str, logs: &SessionLog) -> Result<(), String> {
        self.flush(logs)?;
        self.bindings.lock().unwrap().remove(id);
        Ok(())
    }
}

pub fn setup(app: &tauri::AppHandle) {
    let root = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_config_dir().expect("app config directory"))
        .join("history");
    app.manage(HistoryState::new(root));
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_error = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let history = app.state::<HistoryState>();
            if history.stopped.load(Ordering::Acquire) {
                break;
            }
            let error = history.flush(&app.state::<SessionLog>()).err();
            if error != last_error {
                let _ = app.emit("history-status", &error);
                last_error = error;
            }
        }
    });
}

pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<HistoryState>();
    state.stopped.store(true, Ordering::Release);
    let _ = state.flush(&app.state::<SessionLog>());
}

pub fn flush_before_update(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<HistoryState>()
        .flush(&app.state::<SessionLog>())
}

#[tauri::command]
pub fn history_desktop_save(
    state: State<HistoryState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let tabs = snapshot
        .get("tabs")
        .and_then(serde_json::Value::as_array)
        .ok_or("Invalid desktop snapshot.")?;
    if tabs.len() > 32
        || serde_json::to_vec(&snapshot)
            .map_err(|e| e.to_string())?
            .len()
            > 4 * 1024 * 1024
    {
        return Err("Desktop drafts exceed the 4 MB recovery limit.".into());
    }
    *state.desktop.lock().unwrap() = Some(snapshot);
    state.desktop_dirty.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn history_draft_save(
    state: State<HistoryState>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    if !valid_tab(&tab_id) || text.chars().count() > 64000 {
        return Err("Invalid or oversized conversation draft.".into());
    }
    let mut snapshot = state.desktop.lock().unwrap();
    let Some(snapshot) = snapshot.as_mut() else {
        return Ok(());
    };
    if !snapshot
        .get("tabs")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|tabs| tabs.iter().any(|tab| tab["id"].as_str() == Some(&tab_id)))
    {
        return Ok(());
    }
    let drafts = snapshot
        .get_mut("drafts")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("Invalid saved draft collection.")?;
    let size: usize = drafts
        .iter()
        .filter(|(key, _)| *key != &tab_id)
        .map(|(_, value)| value.as_str().map_or(0, str::len))
        .sum();
    if size + text.len() > 3 * 1024 * 1024 {
        return Err(
            "Drafts exceed the 3 MB total recovery budget. Shorten or close another draft.".into(),
        );
    }
    drafts.insert(tab_id, serde_json::Value::String(text));
    state.desktop_dirty.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub async fn history_desktop_load(
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HistoryState>();
        let _io = state.io.lock().unwrap();
        // A WebView can reload before the background checkpoint reaches disk.
        // Its current native snapshot owns newer tabs/drafts and must not be
        // replaced by that older checkpoint.
        let mut desktop = state.desktop.lock().unwrap();
        if let Some(snapshot) = desktop.as_ref() {
            return Ok(Some(snapshot.clone()));
        }
        let path = state.root.join("desktop.json");
        if !path.exists() {
            return Ok(None);
        }
        let mut bytes = vec![];
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Desktop checkpoint exceeds its recovery limit.".into());
        }
        let snapshot: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Could not read desktop checkpoint: {e}"))?;
        *desktop = Some(snapshot.clone());
        Ok(Some(snapshot))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn history_forget(state: State<HistoryState>, tab_id: String) -> Result<(), String> {
    if !valid_tab(&tab_id) {
        return Err("Invalid conversation ID.".into());
    }
    let _io = state.io.lock().unwrap();
    let mut forgotten = state.forgotten.lock().unwrap();
    forgotten.insert(tab_id.clone());
    state
        .bindings
        .lock()
        .unwrap()
        .retain(|_, b| b.tab != tab_id);
    match fs::remove_file(state.root.join(format!("{tab_id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_survives_trimmed_replay_and_restores_paused_without_execution() {
        let root =
            std::env::temp_dir().join(format!("velum-queue-history-{}", uuid::Uuid::new_v4()));
        let store = HistoryState::new(root.clone());
        let logs = SessionLog::default();
        logs.register("native", "project".into());
        store.bind(
            "native",
            "tab-queue".into(),
            "project".into(),
            Provider::Muse,
            uuid::Uuid::new_v4().to_string(),
        );
        let mut queue = crate::message_queue::Snapshot::default();
        queue.push("Pending work".into(), false, true).unwrap();
        logs.record(
            "native",
            &AgentEvent::QueueState {
                queue: queue.clone(),
                running: false,
            },
        );
        for _ in 0..8100 {
            logs.record(
                "native",
                &AgentEvent::Activity {
                    text: "Work detail".into(),
                },
            );
        }
        assert!(logs.replay("native", 0).unwrap().truncated);
        store.flush(&logs).unwrap();
        let saved = store
            .load("tab-queue", "project", Provider::Muse)
            .unwrap()
            .unwrap();
        assert_eq!(saved.queue.items, queue.items);
        assert!(saved.queue.paused);
        assert!(
            matches!(saved.events.last(),Some(AgentEvent::QueueState{queue,running:false}) if queue.paused)
        );
        fs::remove_file(root.join("tab-queue.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn restores_resume_id_and_marks_interrupted_turns_without_rerunning() {
        let root =
            std::env::temp_dir().join(format!("velum-history-test-{}", uuid::Uuid::new_v4()));
        let store = HistoryState::new(root.clone());
        let logs = SessionLog::default();
        logs.register("native", "project".into());
        store.bind(
            "native",
            "tab-one".into(),
            "project".into(),
            Provider::Codex,
            String::new(),
        );
        logs.record(
            "native",
            &AgentEvent::TurnStart {
                prompt: "keep this".into(),
                remote: false,
                queued: false,
            },
        );
        logs.record(
            "native",
            &AgentEvent::AssistantDelta {
                text: "partial answer".into(),
            },
        );
        store.resume_id("native", "thread-123");
        store.mark_truncated("native");
        store.flush(&logs).unwrap();
        let restored = HistoryState::new(root.clone())
            .load("tab-one", "project", Provider::Codex)
            .unwrap()
            .unwrap();
        assert_eq!(restored.session_id, "thread-123");
        assert!(restored.truncated);
        assert_eq!(restored.events.len(), 3);
        assert!(
            matches!(restored.events.last(),Some(AgentEvent::TurnEnd{status,..}) if status=="cancelled")
        );
        assert!(store
            .load("tab-one", "other", Provider::Codex)
            .unwrap()
            .is_none());
        assert!(store.load("../escape", "project", Provider::Codex).is_err());
        fs::write(root.join("tab-one.json"), "broken").unwrap();
        assert!(store.load("tab-one", "project", Provider::Codex).is_err());
        fs::remove_file(root.join("tab-one.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
