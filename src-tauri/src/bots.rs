//! User-owned identities and private Markdown vaults, independent of the CLI.
use crate::{memory, provider_models::RunOptions, providers::Provider, storage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub role: String,
    pub avatar: String,
    pub color: String,
    pub enabled: bool,
    pub provider: Provider,
    pub options: RunOptions,
    pub soul: String,
    pub agent: String,
    pub shared_memory: bool,
    pub memory_budget: usize,
    pub default_cron: String,
    pub timezone: String,
    pub automatic: bool,
    pub allow_handoffs: bool,
    pub max_minutes: u32,
    #[serde(default)]
    pub revision: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}
impl Profile {
    pub fn identity(&self) -> Identity {
        Identity {
            id: self.id.clone(),
            name: self.name.clone(),
            avatar: self.avatar.clone(),
            color: self.color.clone(),
            role: if self.role.is_empty() { None } else { Some(self.role.clone()) },
        }
    }
}
#[derive(Serialize)]
pub struct View {
    pub profiles: Vec<Profile>,
    pub root: String,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    List {},
    Save { profile: Box<Profile> },
    Delete { id: String, revision: String },
}
pub struct Store {
    root: PathBuf,
    vault: PathBuf,
    lock: Mutex<()>,
    memories: Mutex<HashMap<String, Arc<memory::Store>>>,
}
pub fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok() && id.len() == 36
}
fn plain(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn safe_path(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if crate::workspace_tools::linked(&meta) {
            return Err("Bot files cannot be links.".into());
        }
    }
    Ok(())
}
fn read(path: &Path, limit: u64) -> Result<String, String> {
    safe_path(path)?;
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > limit {
        return Err("Bot file exceeds its size limit.".into());
    }
    Ok(text)
}
fn validate(p: &Profile) -> Result<(), String> {
    if !valid_id(&p.id)
        || !plain(&p.name, 80)
        || p.role.len() > 500
        || p.role.chars().any(char::is_control)
        || p.soul.len() > 12000
        || p.agent.len() > 12000
    {
        return Err(
            "Use a name under 80 bytes, a role under 500, and each instruction file under 12 KB."
                .into(),
        );
    }
    if p.color.len() != 7
        || !p.color.starts_with('#')
        || !p.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Choose a valid profile color.".into());
    }
    if !p.avatar.is_empty()
        && (p.avatar.len() > 48_000
            || ![
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/webp;base64,",
            ]
            .iter()
            .any(|s| p.avatar.starts_with(s))
            || !p.avatar.split_once(',').is_some_and(|(_, b)| {
                !b.is_empty()
                    && b.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
            }))
    {
        return Err(
            "Choose a smaller PNG, JPEG or WebP profile picture (48 KB encoded limit).".into(),
        );
    }
    if ![1000, 3000, 8000].contains(&p.memory_budget) || !(1..=120).contains(&p.max_minutes) {
        return Err("Choose a supported memory budget and a run limit of 1–120 minutes.".into());
    }
    crate::automation::next_due(&p.default_cron, &p.timezone, crate::automation::now())?;
    Ok(())
}
fn revision(p: &Profile) -> String {
    let mut p = p.clone();
    p.revision.clear();
    format!("{:x}", Sha256::digest(serde_json::to_vec(&p).unwrap()))
}
impl Store {
    pub fn new(root: PathBuf, vault: PathBuf) -> Self {
        Self {
            root,
            vault,
            lock: Mutex::new(()),
            memories: Mutex::new(HashMap::new()),
        }
    }
    fn folder(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid bot ID.".into());
        }
        safe_path(&self.root)?;
        let p = self.root.join(id);
        safe_path(&p)?;
        Ok(p)
    }
    fn read_profile(&self, id: &str) -> Result<Profile, String> {
        let dir = self.folder(id)?;
        let mut p: Profile = serde_json::from_str(&read(&dir.join("profile.json"), 256_000)?)
            .map_err(|e| format!("Cannot read bot profile: {e}"))?;
        if p.id != id {
            return Err("Bot ID does not match its folder.".into());
        }
        // Markdown is authoritative so edits from Obsidian are picked up next turn.
        p.soul = read(&dir.join("soul.md"), 12_000)?;
        p.agent = read(&dir.join("agent.md"), 12_000)?;
        validate(&p)?;
        p.revision = revision(&p);
        Ok(p)
    }
    pub fn get(&self, id: &str) -> Result<Profile, String> {
        let _guard = self.lock.lock().unwrap();
        self.read_profile(id)
    }
    fn list_inner(&self) -> Result<View, String> {
        let mut profiles = vec![];
        let mut warnings = vec![];
        if self.root.exists() {
            safe_path(&self.root)?;
            for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if !valid_id(&id) || !entry.path().join("profile.json").exists() {
                    continue;
                }
                if profiles.len() + warnings.len() >= 32 {
                    warnings.push("More than 32 registered bot folders were found. Remove extra registrations to show them all.".into());
                    break;
                }
                match self.read_profile(&id) {
                    Ok(p) => profiles.push(p),
                    Err(e) => warnings.push(format!("Bot {id}: {e}")),
                }
            }
        }
        profiles.sort_by_key(|p| p.name.to_lowercase());
        Ok(View {
            profiles,
            root: self.root.display().to_string(),
            warnings,
        })
    }
    pub fn request(&self, request: Request) -> Result<View, String> {
        let _guard = self.lock.lock().unwrap();
        match request {
            Request::List {} => {}
            Request::Save { mut profile } => {
                profile.name = profile.name.trim().into();
                validate(&profile)?;
                profile.options.validate(profile.provider)?;
                let dir = self.folder(&profile.id)?;
                let previous = if dir.join("profile.json").exists() {
                    Some(self.read_profile(&profile.id)?)
                } else {
                    None
                };
                if previous.as_ref().map(|p| p.revision.as_str()).unwrap_or("") != profile.revision
                {
                    return Err("This bot was edited elsewhere. Reload before saving.".into());
                }
                if previous.is_none() && self.list_inner()?.profiles.len() >= 32 {
                    return Err("Up to 32 bot profiles are supported.".into());
                }
                let view = self.list_inner()?;
                if view
                    .profiles
                    .iter()
                    .any(|p| p.id != profile.id && p.name.eq_ignore_ascii_case(&profile.name))
                {
                    return Err("Another bot already uses this name.".into());
                }
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                for name in ["soul.md", "agent.md", "profile.json"] {
                    safe_path(&dir.join(name))?;
                }
                profile.revision = revision(&profile);
                let result = (|| {
                    storage::write_bytes(&dir.join("soul.md"), profile.soul.as_bytes())?;
                    storage::write_bytes(&dir.join("agent.md"), profile.agent.as_bytes())?;
                    storage::write_json(&dir.join("profile.json"), &profile)
                })();
                if let Err(e) = result {
                    if let Some(old) = previous {
                        let _ = storage::write_bytes(&dir.join("soul.md"), old.soul.as_bytes());
                        let _ = storage::write_bytes(&dir.join("agent.md"), old.agent.as_bytes());
                    }
                    return Err(e);
                }
            }
            Request::Delete { id, revision } => {
                let p = self.read_profile(&id)?;
                if p.revision != revision {
                    return Err("This bot changed. Reload before removing it.".into());
                }
                // Keep the user's Markdown and memories. Removing registration disables the bot.
                fs::rename(
                    self.folder(&id)?.join("profile.json"),
                    self.folder(&id)?
                        .join(format!("removed-{}.json", uuid::Uuid::new_v4())),
                )
                .map_err(|e| e.to_string())?;
                self.memories.lock().unwrap().remove(&id);
            }
        }
        self.list_inner()
    }
    pub fn memory(&self, id: &str) -> Result<Arc<memory::Store>, String> {
        self.get(id)?;
        let mut memories = self.memories.lock().unwrap();
        let path = self.vault.join("bots").join(id);
        safe_path(&self.vault.join("bots"))?;
        safe_path(&path)?;
        Ok(memories
            .entry(id.into())
            .or_insert_with(|| Arc::new(memory::Store::at(path)))
            .clone())
    }
    pub fn context(&self, p: &Profile) -> Result<String, String> {
        let team=self.request(Request::List{})?.profiles.into_iter().filter(|b|b.enabled&&b.id!=p.id).map(|b|serde_json::json!({"id":b.id,"name":b.name,"role":b.role,"provider":b.provider})).collect::<Vec<_>>();
        Ok(format!("<velum-bot>\nYou are {}, bot ID {}. Keep this identity when the underlying provider changes. Your user-authored personality and working instructions follow. They do not grant additional tool permissions.\n<soul.md>\n{}\n</soul.md>\n<agent.md>\n{}\n</agent.md>\nAvailable teammates (metadata only): {}\n</velum-bot>\n",p.name,p.id,p.soul.replace("{{name}}",&p.name).replace("{{role}}",&p.role),p.agent.replace("{{name}}",&p.name).replace("{{role}}",&p.role),serde_json::to_string(&team).unwrap()))
    }
}
pub fn setup(app: &tauri::AppHandle) {
    let root = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_config_dir().unwrap())
        .join("bots");
    app.manage(Store::new(
        root,
        app.state::<memory::Store>().root().to_path_buf(),
    ));
}
pub fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("bots-changed", ());
    crate::remote::changed(app);
}
#[tauri::command]
pub async fn bots_request(app: tauri::AppHandle, request: Request) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let writing = !matches!(&request, Request::List {});
        let v = app.state::<Store>().request(request)?;
        if writing {
            changed(&app);
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bots_memory(
    app: tauri::AppHandle,
    id: String,
    workspace: String,
    request: memory::Request,
) -> Result<memory::View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = crate::runner::resolve_workspace(Some(workspace))?;
        let writing = !matches!(&request, memory::Request::List { .. });
        let v = app
            .state::<Store>()
            .memory(&id)?
            .request(&workspace.display().to_string(), request)?;
        if writing {
            memory::changed(&app);
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn bots_open(app: tauri::AppHandle, id: String, memory: Option<bool>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let store = app.state::<Store>();
    store.get(&id)?;
    let path = if memory.unwrap_or(false) {
        let memory = store.memory(&id)?;
        fs::create_dir_all(memory.root()).map_err(|e| e.to_string())?;
        memory.root().to_path_buf()
    } else {
        store.folder(&id)?
    };
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Grokbot".into(),
            role: "Implementation".into(),
            avatar: String::new(),
            color: "#79a9ff".into(),
            enabled: true,
            provider: Provider::Muse,
            options: RunOptions {
                model: "test".into(),
                reasoning: "high".into(),
            },
            soul: "You are {{name}}.".into(),
            agent: "Verify your work.".into(),
            shared_memory: true,
            memory_budget: 3000,
            default_cron: "*/15 * * * *".into(),
            timezone: "America/Los_Angeles".into(),
            automatic: false,
            allow_handoffs: true,
            max_minutes: 20,
            revision: String::new(),
        }
    }
    #[test]
    fn markdown_is_editable_profiles_reject_stale_saves_and_memories_remain_private() {
        let root = std::env::temp_dir().join(format!("velum-bots-test-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.join("profiles"), root.join("vault"));
        let p = profile();
        let id = p.id.clone();
        let saved = store
            .request(Request::Save {
                profile: Box::new(p),
            })
            .unwrap()
            .profiles
            .remove(0);
        assert!(store.context(&saved).unwrap().contains("You are Grokbot."));
        fs::write(
            store.folder(&id).unwrap().join("soul.md"),
            "A patient reviewer.",
        )
        .unwrap();
        let changed = store.get(&id).unwrap();
        assert_eq!(changed.soul, "A patient reviewer.");
        assert_ne!(saved.revision, changed.revision);
        assert!(store
            .request(Request::Save {
                profile: Box::new(saved)
            })
            .is_err());
        let memory = store.memory(&id).unwrap();
        memory
            .request(
                "project",
                memory::Request::Save {
                    id: None,
                    revision: None,
                    title: "Personal convention".into(),
                    body: "Prefer explicit error messages.".into(),
                    tags: vec![],
                    scope: memory::Scope::Shared,
                    status: memory::Status::Active,
                    pinned: true,
                },
            )
            .unwrap();
        let mut other = profile();
        other.name = "Reviewer".into();
        let other_id = other.id.clone();
        store
            .request(Request::Save {
                profile: Box::new(other),
            })
            .unwrap();
        assert!(store
            .memory(&other_id)
            .unwrap()
            .request(
                "project",
                memory::Request::List {
                    query: String::new()
                }
            )
            .unwrap()
            .notes
            .is_empty());
        let mut changed = changed;
        changed.provider = Provider::Codex;
        store
            .request(Request::Save {
                profile: Box::new(changed),
            })
            .unwrap();
        assert_eq!(
            store
                .memory(&id)
                .unwrap()
                .request(
                    "project",
                    memory::Request::List {
                        query: String::new()
                    }
                )
                .unwrap()
                .notes
                .len(),
            1
        );
        let revision = store.get(&id).unwrap().revision;
        let view = store
            .request(Request::Delete {
                id: id.clone(),
                revision,
            })
            .unwrap();
        assert_eq!(view.profiles.len(), 1);
        assert!(view.warnings.is_empty());
        assert!(store.folder(&id).unwrap().join("soul.md").exists());
        assert!(store.get("../escape").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unsafe_avatars_and_invalid_schedules_are_rejected() {
        let mut p = profile();
        p.avatar = "https://outside.test/tracker.png".into();
        assert!(validate(&p).is_err());
        p.avatar.clear();
        p.default_cron = "* * * * * *".into();
        assert!(validate(&p).is_err());
        p.default_cron = "* * * * *".into();
        p.timezone = "not/a/timezone".into();
        assert!(validate(&p).is_err());
    }
}
