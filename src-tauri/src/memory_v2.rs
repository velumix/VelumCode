//! Memory v2, slice 1: a clean-break SQLite store with FTS5 candidate
//! retrieval and BM25 chunk ranking.
//!
//! v1 stays the default. When `VELUM_MEMORY_V2=1`, the v1 [`Store`] delegates
//! reads and writes here instead of the Markdown vault. v1 notes are synced in
//! once by id (never updated afterwards, never written back); deletes leave
//! tombstones so a re-sync cannot revive them. The slice-1a JSON file is
//! imported once on first open when the database is still empty.
use crate::memory::{Capture, Meta, Note, Request, Scope, Session, Settings, Status, Usage, View};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

const STORE_VERSION: u32 = 2;
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (project_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL, capture TEXT NOT NULL, budget_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL, scope TEXT NOT NULL, project_key TEXT NOT NULL, project_path TEXT NOT NULL, bot_id TEXT, status TEXT NOT NULL, pinned INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, use_count INTEGER NOT NULL, last_used INTEGER NOT NULL, boost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, title, tags, body);
";
const MAX_CHUNK_BYTES: usize = 600;
const MAX_EXCERPT_BYTES: usize = 1_200;
const MAX_CHUNKS: usize = 6;
const MAX_RECORDS: usize = 2_000;
const K1: f64 = 1.2;
const B: f64 = 0.75;

pub fn enabled() -> bool {
    std::env::var("VELUM_MEMORY_V2").is_ok_and(|v| v == "1")
}

/// Tokenize like v1 `terms()`, but keep counts for BM25. Keep the stopwords in
/// sync with `memory.rs`.
fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|s| {
            s.len() > 2
                && ![
                    "the", "and", "for", "with", "that", "this", "you", "can", "are", "our",
                    "from", "have", "what", "how", "please",
                ]
                .contains(&s.as_str())
        })
        .take(500)
        .collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub scope: Scope,
    pub project_key: String,
    pub project_path: String,
    pub bot_id: Option<String>,
    pub status: Status,
    pub pinned: bool,
    pub kind: String,
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub use_count: u64,
    pub last_used: u64,
    pub boost: f64,
}

fn revision(record: &Record) -> String {
    crate::memory::hash(&format!(
        "{}\n{}\n{}\n{}\n{:?}\n{:?}\n{}\n{}\n{}\n{}\n{}",
        record.id,
        record.title,
        record.body,
        record.tags.join(","),
        record.scope,
        record.status,
        record.pinned,
        record.kind,
        record.source,
        record.updated_at,
        record.boost
    ))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct File {
    version: u32,
    settings: HashMap<String, Settings>,
    records: Vec<Record>,
    tombstones: Vec<String>,
}

pub struct Store2 {
    root: PathBuf,
    lock: Mutex<()>,
    force: AtomicBool,
}

impl Store2 {
    pub fn at(v1root: &Path) -> Self {
        Self {
            root: v1root.join(".v2"),
            lock: Mutex::new(()),
            force: AtomicBool::new(false),
        }
    }

    pub(crate) fn forced(&self) -> bool {
        self.force.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn set_forced(&self, value: bool) {
        self.force.store(value, Ordering::Relaxed);
    }

    fn db_path(&self) -> PathBuf {
        self.root.join("store.db")
    }

    fn open(&self) -> Result<Connection, String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let mut conn = Connection::open(self.db_path()).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Self::migrate_json(&mut conn, &self.root)?;
        let version: i64 = conn
            .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        if version > STORE_VERSION as i64 {
            return Err("Memory v2 store was written by a newer app.".into());
        }
        Ok(conn)
    }

    /// One-time import of the slice-1a JSON store. Runs only when the JSON
    /// file exists and the database holds no records yet.
    fn migrate_json(conn: &mut Connection, root: &Path) -> Result<(), String> {
        let json = root.join("store.json");
        if !json.exists() {
            return Ok(());
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if count > 0 {
            return Ok(());
        }
        let raw = fs::read_to_string(&json).map_err(|e| e.to_string())?;
        let file: File =
            serde_json::from_str(&raw).map_err(|_| "Memory v2 JSON store is unreadable.")?;
        Self::persist_conn(conn, &file)?;
        let _ = fs::rename(&json, root.join("store.json.migrated"));
        Ok(())
    }

    fn load(&self) -> Result<File, String> {
        let conn = self.open()?;
        let mut records = vec![];
        let mut stmt = conn
            .prepare(
                "SELECT id, title, body, tags, scope, project_key, project_path, bot_id, status, pinned, kind, source, created_at, updated_at, use_count, last_used, boost FROM records",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get(3)?;
                Ok(Record {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get(2)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    scope: scope_from(row.get::<_, String>(4)?),
                    project_key: row.get(5)?,
                    project_path: row.get(6)?,
                    bot_id: row.get(7)?,
                    status: status_from(row.get::<_, String>(8)?),
                    pinned: row.get::<_, i64>(9)? != 0,
                    kind: row.get(10)?,
                    source: row.get(11)?,
                    created_at: row.get::<_, i64>(12)? as u64,
                    updated_at: row.get::<_, i64>(13)? as u64,
                    use_count: row.get::<_, i64>(14)? as u64,
                    last_used: row.get::<_, i64>(15)? as u64,
                    boost: row.get(16)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
        let mut settings = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT project_key, enabled, capture, budget_bytes FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Settings {
                        enabled: row.get::<_, i64>(1)? != 0,
                        capture: capture_from(row.get::<_, String>(2)?),
                        budget_bytes: row.get::<_, i64>(3)? as usize,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, value) = row.map_err(|e| e.to_string())?;
            settings.insert(key, value);
        }
        let mut tombstones = vec![];
        let mut stmt = conn
            .prepare("SELECT id FROM tombstones")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            tombstones.push(row.map_err(|e| e.to_string())?);
        }
        Ok(File {
            version: STORE_VERSION,
            settings,
            records,
            tombstones,
        })
    }

    fn save_file(&self, file: &File) -> Result<(), String> {
        let mut conn = self.open()?;
        Self::persist_conn(&mut conn, file)
    }

    fn persist_conn(conn: &mut Connection, file: &File) -> Result<(), String> {
        // Full rewrite per mutation inside one transaction: simple and correct
        // at this scale (at most 2000 small records on local storage).
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "DELETE FROM records; DELETE FROM records_fts; DELETE FROM settings; DELETE FROM tombstones;",
        )
        .map_err(|e| e.to_string())?;
        for record in &file.records {
            tx.execute(
                "INSERT INTO records (id, title, body, tags, scope, project_key, project_path, bot_id, status, pinned, kind, source, created_at, updated_at, use_count, last_used, boost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    record.id,
                    record.title,
                    record.body,
                    serde_json::to_string(&record.tags).unwrap_or_default(),
                    scope_to(&record.scope),
                    record.project_key,
                    record.project_path,
                    record.bot_id,
                    status_to(&record.status),
                    i64::from(record.pinned),
                    record.kind,
                    record.source,
                    record.created_at as i64,
                    record.updated_at as i64,
                    record.use_count as i64,
                    record.last_used as i64,
                    record.boost,
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO records_fts (id, title, tags, body) VALUES (?, ?, ?, ?)",
                params![record.id, record.title, record.tags.join(" "), record.body],
            )
            .map_err(|e| e.to_string())?;
        }
        for (key, settings) in &file.settings {
            tx.execute(
                "INSERT INTO settings (project_key, enabled, capture, budget_bytes) VALUES (?, ?, ?, ?)",
                params![
                    key,
                    i64::from(settings.enabled),
                    capture_to(&settings.capture),
                    settings.budget_bytes as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for id in &file.tombstones {
            tx.execute("INSERT INTO tombstones (id) VALUES (?)", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![STORE_VERSION as i64],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn settings_for(file: &File, key: &str) -> Settings {
        file.settings.get(key).cloned().unwrap_or_default()
    }

    fn scoped<'a>(file: &'a File, key: &str) -> Vec<&'a Record> {
        file.records
            .iter()
            .filter(|r| {
                r.scope == Scope::Shared || (r.scope == Scope::Project && r.project_key == key)
            })
            .collect()
    }

    /// One-way sync: adopt v1 notes this store has never seen. Existing v2
    /// records and tombstones are never touched, so v2 stays the truth once
    /// active and deletes cannot be revived by a re-sync.
    pub(crate) fn sync_from_v1(&self, workspace: &str, notes: &[Note]) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "Memory is busy.")?;
        let mut file = self.load()?;
        let key = crate::memory::project_key(workspace);
        let mut known: HashSet<String> = file
            .records
            .iter()
            .map(|r| r.id.clone())
            .chain(file.tombstones.iter().cloned())
            .collect();
        let mut changed = false;
        for note in notes {
            if known.contains(note.meta.id.as_str()) {
                continue;
            }
            known.insert(note.meta.id.clone());
            let now = crate::memory::now();
            file.records.push(Record {
                id: note.meta.id.clone(),
                title: note.meta.title.clone(),
                body: note.body.clone(),
                tags: note.meta.tags.clone(),
                scope: note.meta.scope,
                project_key: key.clone(),
                project_path: workspace.into(),
                bot_id: None,
                status: note.meta.status,
                pinned: note.meta.pinned,
                kind: if note.meta.tags.iter().any(|t| t == "lesson") {
                    "lesson".into()
                } else {
                    "fact".into()
                },
                source: format!("v1 import: {}", note.meta.source),
                created_at: note.meta.created_at,
                updated_at: note.meta.updated_at,
                use_count: 0,
                last_used: now,
                boost: 0.0,
            });
            changed = true;
        }
        if changed {
            file.version = STORE_VERSION;
            self.save_file(&file)?;
        }
        Ok(())
    }

    pub(crate) fn has_records(&self, workspace: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().map_err(|_| "Memory is busy.")?;
        let file = self.load()?;
        let key = crate::memory::project_key(workspace);
        Ok(Self::scoped(&file, &key)
            .iter()
            .any(|r| r.status == Status::Active))
    }

    fn view(file: &File, key: &str, query: &str) -> View {
        let mut notes: Vec<Note> = Self::scoped(file, key)
            .into_iter()
            .map(|r| {
                let rev = revision(r);
                Note::detached(
                    Meta {
                        id: r.id.clone(),
                        title: r.title.clone(),
                        tags: r.tags.clone(),
                        scope: r.scope,
                        status: r.status,
                        pinned: r.pinned,
                        created_at: r.created_at,
                        updated_at: r.updated_at,
                        source: r.source.clone(),
                    },
                    r.body.clone(),
                    rev,
                )
            })
            .collect();
        notes.sort_by(|a, b| {
            b.meta
                .updated_at
                .cmp(&a.meta.updated_at)
                .then(a.meta.id.cmp(&b.meta.id))
        });
        if !query.trim().is_empty() {
            let q = query.to_lowercase();
            notes.retain(|n| {
                format!("{} {} {}", n.meta.title, n.meta.tags.join(" "), n.body)
                    .to_lowercase()
                    .contains(&q)
            });
        }
        View {
            root: String::new(),
            settings: Self::settings_for(file, key),
            notes,
            warning: None,
        }
    }

    pub(crate) fn request(&self, workspace: &str, request: Request) -> Result<View, String> {
        let _guard = self.lock.lock().map_err(|_| "Memory is busy.")?;
        let key = crate::memory::project_key(workspace);
        let mut file = self.load()?;
        match request {
            Request::List { query } => return Ok(Self::view(&file, &key, &query)),
            Request::Configure { settings } => {
                crate::memory::validate_settings(&settings)?;
                file.settings.insert(key.clone(), settings);
            }
            Request::Save {
                id,
                revision: rev,
                title,
                body,
                tags,
                scope,
                status,
                pinned,
            } => {
                crate::memory::validate_text(&title, &body, &tags)?;
                if let Some(id) = &id {
                    crate::memory::validate_id(id)?;
                    let record = file
                        .records
                        .iter_mut()
                        .find(|r| &r.id == id)
                        .ok_or("This note no longer exists. Refresh the vault.")?;
                    if revision(record) != rev.unwrap_or_default() {
                        return Err(
                            "This note changed elsewhere. Refresh to load the latest copy before saving."
                                .into(),
                        );
                    }
                    record.title = title.trim().into();
                    record.body = body.trim().into();
                    record.tags = tags;
                    record.scope = scope;
                    record.status = status;
                    record.pinned = pinned;
                    record.project_key = key.clone();
                    record.project_path = workspace.into();
                    record.updated_at = crate::memory::now();
                    record.use_count += 1;
                } else {
                    if file.records.iter().any(|r| {
                        r.status != Status::Archived
                            && r.scope == scope
                            && crate::memory::normalized(&r.body)
                                == crate::memory::normalized(&body)
                    }) {
                        return Ok(Self::view(&file, &key, ""));
                    }
                    if file.records.len() >= MAX_RECORDS {
                        return Err(
                            "This vault has reached its note limit. Remove old notes before adding more."
                                .into(),
                        );
                    }
                    let slug: String = title
                        .to_lowercase()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                        .take(48)
                        .collect();
                    let now = crate::memory::now();
                    file.records.push(Record {
                        id: format!("{}--{}", slug.trim_matches('-'), uuid::Uuid::new_v4()),
                        title: title.trim().into(),
                        body: body.trim().into(),
                        tags,
                        scope,
                        project_key: key.clone(),
                        project_path: workspace.into(),
                        bot_id: None,
                        status,
                        pinned,
                        kind: "fact".into(),
                        source: "Saved by you".into(),
                        created_at: now,
                        updated_at: now,
                        use_count: 0,
                        last_used: now,
                        boost: 0.0,
                    });
                }
            }
            Request::SaveLesson { title, body } => {
                let tags = vec!["lesson".to_string(), "correction".to_string()];
                crate::memory::validate_text(&title, &body, &tags)?;
                if let Some(record) = file.records.iter_mut().find(|r| {
                    r.scope == Scope::Project
                        && r.project_key == key
                        && r.status != Status::Archived
                        && r.body.trim() == body.trim()
                }) {
                    if record.status == Status::Active && record.pinned {
                        return Ok(Self::view(&file, &key, ""));
                    }
                    for tag in ["lesson", "correction"] {
                        if record.tags.len() < 12 && !record.tags.iter().any(|t| t == tag) {
                            record.tags.push(tag.into());
                        }
                    }
                    record.title = title.trim().into();
                    record.status = Status::Active;
                    record.pinned = true;
                    record.kind = "lesson".into();
                    record.source = "Reviewed correction".into();
                    record.updated_at = crate::memory::now();
                    record.boost = 4.0;
                } else {
                    if file.records.len() >= MAX_RECORDS {
                        return Err(
                            "This vault has reached its note limit. Remove old notes before adding more."
                                .into(),
                        );
                    }
                    let slug: String = title
                        .to_lowercase()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                        .take(48)
                        .collect();
                    let now = crate::memory::now();
                    file.records.push(Record {
                        id: format!("{}--{}", slug.trim_matches('-'), uuid::Uuid::new_v4()),
                        title: title.trim().into(),
                        body: body.trim().into(),
                        tags,
                        scope: Scope::Project,
                        project_key: key.clone(),
                        project_path: workspace.into(),
                        bot_id: None,
                        status: Status::Active,
                        pinned: true,
                        kind: "lesson".into(),
                        source: "Reviewed correction".into(),
                        created_at: now,
                        updated_at: now,
                        use_count: 0,
                        last_used: now,
                        boost: 4.0,
                    });
                }
            }
            Request::Delete { id, revision: rev } => {
                crate::memory::validate_id(&id)?;
                let pos = file
                    .records
                    .iter()
                    .position(|r| r.id == id)
                    .ok_or("This note no longer exists.")?;
                if revision(&file.records[pos]) != rev {
                    return Err("This note changed elsewhere. Refresh before deleting it.".into());
                }
                file.records.remove(pos);
                if !file.tombstones.iter().any(|t| t == &id) {
                    file.tombstones.push(id);
                }
            }
        }
        file.version = STORE_VERSION;
        self.save_file(&file)?;
        let _ = self.export_obsidian(&file);
        Ok(Self::view(&file, &key, ""))
    }

    pub(crate) fn capture(
        &self,
        workspace: &str,
        text: &str,
        mode: Capture,
        provider: &str,
    ) -> Result<usize, String> {
        if mode == Capture::Manual {
            return Ok(0);
        }
        let key = crate::memory::project_key(workspace);
        let settings = Self::settings_for(&self.load()?, &key);
        if !settings.enabled || settings.capture == Capture::Manual {
            return Ok(0);
        }
        let proposals: Vec<Proposal> = serde_json::from_str(text)
            .map_err(|_| "The agent's memory suggestion was malformed; nothing was saved.")?;
        if proposals.len() > 2 {
            return Err("The agent suggested too many memories; nothing was saved.".into());
        }
        for note in &proposals {
            crate::memory::validate_text(&note.title, &note.body, &note.tags)?;
            if note.body.len() > 1_200 {
                return Err("The memory suggestion was too long; nothing was saved.".into());
            }
        }
        let mut added = 0;
        for note in proposals {
            let before = self.load()?.records.len();
            let collision = self.load()?.records.iter().any(|r| {
                crate::memory::normalized(&r.title) == crate::memory::normalized(&note.title)
                    && r.status == Status::Active
            });
            let status = if mode == Capture::Automatic
                && settings.capture == Capture::Automatic
                && !collision
            {
                Status::Active
            } else {
                Status::Pending
            };
            let saved_body = note.body.clone();
            self.request(
                workspace,
                Request::Save {
                    id: None,
                    revision: None,
                    title: note.title,
                    body: note.body,
                    tags: note.tags,
                    scope: Scope::Project,
                    status,
                    pinned: false,
                },
            )?;
            if self.load()?.records.len() > before {
                added += 1;
                let mut file = self.load()?;
                if let Some(record) = file.records.iter_mut().find(|r| {
                    r.scope == Scope::Project
                        && r.project_key == key
                        && crate::memory::normalized(&r.body)
                            == crate::memory::normalized(&saved_body)
                }) {
                    record.source = format!("{provider} conversation");
                }
                self.save_file(&file)?;
            }
        }
        Ok(added)
    }

    /// One-way Obsidian-readable export. Generated files are never read back.
    fn export_obsidian(&self, file: &File) -> Result<PathBuf, String> {
        let out = self.root.join("exports");
        let mut dirs: HashSet<PathBuf> = HashSet::new();
        for record in &file.records {
            let dir = match record.scope {
                Scope::Shared => out.join("shared"),
                Scope::Project => out.join("projects").join(&record.project_key),
            };
            dirs.insert(dir.clone());
        }
        for dir in &dirs {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        for record in &file.records {
            let safe: String = record
                .id
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect();
            let dir = match record.scope {
                Scope::Shared => out.join("shared"),
                Scope::Project => out.join("projects").join(&record.project_key),
            };
            let tags = record
                .tags
                .iter()
                .map(|t| format!("\"{}\"", t.replace('"', "'")))
                .collect::<Vec<_>>()
                .join(", ");
            let content = format!(
                "---\ntitle: \"{}\"\ntags: [{}]\nupdated: {}\nvelum_v2: {}\n---\n\n{}\n\n<!-- Generated by Velum memory v2; edits here are not read back. -->\n",
                record.title.replace('"', "'"),
                tags,
                record.updated_at,
                record.id,
                record.body.trim()
            );
            crate::memory::atomic_write(&dir.join(format!("{safe}.md")), &content)?;
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare(
        &self,
        workspace: &str,
        prompt: &str,
        session: &mut Session,
        budget: Option<usize>,
        learn: bool,
    ) -> Result<(String, Usage, Capture), String> {
        let _guard = self.lock.lock().map_err(|_| "Memory is busy.")?;
        let file = self.load()?;
        let key = crate::memory::project_key(workspace);
        let mut settings = Self::settings_for(&file, &key);
        if let Some(limit) = budget {
            settings.budget_bytes = settings.budget_bytes.min(limit);
        }
        if !learn {
            settings.capture = Capture::Manual;
        }
        if !settings.enabled {
            return Ok((prompt.into(), Usage::default(), Capture::Manual));
        }
        let previous = session.clone();
        session.turn += 1;
        let mut active: Vec<&Record> = Self::scoped(&file, &key)
            .into_iter()
            .filter(|r| r.status == Status::Active)
            .collect();
        let framing = crate::memory::CONTEXT_START.len()
            + crate::memory::CONTEXT_END.len()
            + "Current request:\n".len()
            + if settings.capture == Capture::Manual {
                0
            } else {
                crate::memory::LEARNING.len()
            };
        let excerpt_budget = settings.budget_bytes.saturating_sub(framing);
        let mut context = String::new();
        let withdrawn: Vec<_> = session
            .seen
            .keys()
            .filter(|id| !active.iter().any(|r| &r.id == *id))
            .cloned()
            .collect();
        for id in withdrawn {
            let line = format!("Withdraw earlier memory {id}; it is no longer active.\n");
            if context.len() + line.len() < excerpt_budget {
                context.push_str(&line);
                session.seen.remove(&id);
            }
        }
        if let Some(ids) = fts_candidates(&self.root, prompt) {
            active.retain(|r| r.pinned || ids.contains(&r.id));
        }
        let ranked = rank(&active, prompt);
        let mut titles = vec![];
        let mut chunks_used = 0;
        for hit in ranked {
            if chunks_used >= MAX_CHUNKS {
                break;
            }
            let record = hit.record;
            if session.seen.get(&record.id).is_some_and(|(rev, turn)| {
                rev == &revision(record) && session.turn.saturating_sub(*turn) < 8
            }) {
                continue;
            }
            let header = format!("\n[{}] {}\n", record.id, record.title);
            let room = excerpt_budget.saturating_sub(context.len() + header.len() + 1);
            if room < 40 {
                continue;
            }
            let excerpt = crate::memory::cut(&hit.text, room.min(MAX_EXCERPT_BYTES));
            if !titles.iter().any(|t| t == &record.title) {
                context.push_str(&header);
                titles.push(record.title.clone());
            }
            context.push_str(excerpt);
            context.push('\n');
            chunks_used += 1;
            session
                .seen
                .insert(record.id.clone(), (revision(record), session.turn));
        }
        let mut prefix = String::new();
        if !context.is_empty() {
            prefix = format!(
                "{}{}{}",
                crate::memory::CONTEXT_START,
                context,
                crate::memory::CONTEXT_END
            );
        }
        if settings.capture != Capture::Manual {
            prefix.push_str(crate::memory::LEARNING);
        }
        if !prefix.is_empty() {
            prefix.push_str("Current request:\n");
        }
        if prefix.len() > settings.budget_bytes {
            prefix.clear();
            titles.clear();
            *session = previous;
        }
        let usage = Usage {
            titles,
            bytes: prefix.len(),
            budget_bytes: settings.budget_bytes,
        };
        Ok((
            if prefix.is_empty() {
                prompt.into()
            } else {
                format!("{prefix}{prompt}")
            },
            usage,
            settings.capture,
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn push_chunk(chunks: &mut Vec<String>, text: &str) {
    if text.len() <= MAX_CHUNK_BYTES {
        chunks.push(text.to_string());
        return;
    }
    let mut rest = text;
    while rest.len() > MAX_CHUNK_BYTES {
        let mut cut = MAX_CHUNK_BYTES.min(rest.len());
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let (head, _) = rest.split_at(cut);
        let split = head.rfind(". ").map(|i| i + 1).unwrap_or(cut);
        let (emit, keep) = rest.split_at(split);
        chunks.push(emit.trim().to_string());
        rest = keep.trim_start();
    }
    if !rest.trim().is_empty() {
        chunks.push(rest.trim().to_string());
    }
}

fn scope_to(scope: &Scope) -> &'static str {
    match scope {
        Scope::Project => "project",
        Scope::Shared => "shared",
    }
}

fn scope_from(text: String) -> Scope {
    if text == "shared" {
        Scope::Shared
    } else {
        Scope::Project
    }
}

fn status_to(status: &Status) -> &'static str {
    match status {
        Status::Active => "active",
        Status::Pending => "pending",
        Status::Archived => "archived",
    }
}

fn status_from(text: String) -> Status {
    match text.as_str() {
        "pending" => Status::Pending,
        "archived" => Status::Archived,
        _ => Status::Active,
    }
}

fn capture_to(capture: &Capture) -> &'static str {
    match capture {
        Capture::Review => "review",
        Capture::Automatic => "automatic",
        Capture::Manual => "manual",
    }
}

fn capture_from(text: String) -> Capture {
    match text.as_str() {
        "automatic" => Capture::Automatic,
        "manual" => Capture::Manual,
        _ => Capture::Review,
    }
}

/// FTS5 candidate lookup. Returns `None` when there is nothing worth
/// filtering on (no indexable terms, no database yet, or any error), in which
/// case retrieval falls back to the full active set.
fn fts_candidates(root: &Path, prompt: &str) -> Option<HashSet<String>> {
    let terms = tokens(prompt);
    if terms.is_empty() {
        return None;
    }
    let db = root.join("store.db");
    if !db.exists() {
        return None;
    }
    let conn = Connection::open(db).ok()?;
    let query = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut stmt = conn
        .prepare("SELECT id FROM records_fts WHERE records_fts MATCH ? LIMIT 50")
        .ok()?;
    let rows = stmt
        .query_map([query], |row| row.get::<_, String>(0))
        .ok()?;
    let mut ids = HashSet::new();
    for id in rows.flatten() {
        ids.insert(id);
    }
    Some(ids)
}

/// Split a note body into retrieval chunks of at most [`MAX_CHUNK_BYTES`].
fn chunk_text(body: &str) -> Vec<String> {
    let mut chunks = vec![];
    let mut current = String::new();
    for paragraph in body.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if paragraph.len() > MAX_CHUNK_BYTES {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            push_chunk(&mut chunks, paragraph);
        } else if current.len() + paragraph.len() + 2 > MAX_CHUNK_BYTES {
            chunks.push(std::mem::take(&mut current));
            current.push_str(paragraph);
        } else {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(paragraph);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks.retain(|c| !c.is_empty());
    chunks
}

struct Hit<'a> {
    record: &'a Record,
    text: String,
    score: f64,
}

/// BM25 over chunks plus v1-compatible boosts (title/tag x6 weight, pin bonus)
/// and recency/usage/learned boosts. Returns at most two chunks per record:
/// the best chunk plus its best-scoring neighbor.
fn rank<'a>(active: &[&'a Record], prompt: &str) -> Vec<Hit<'a>> {
    let query: HashSet<String> = tokens(prompt).into_iter().collect();
    if query.is_empty() {
        // v1 parity: with no indexable terms, pinned notes still match.
        let mut hits: Vec<Hit<'a>> = active
            .iter()
            .filter(|r| r.pinned)
            .filter_map(|r| {
                chunk_text(&r.body).into_iter().next().map(|text| Hit {
                    record: r,
                    text,
                    score: 12.0 + r.boost,
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(MAX_CHUNKS);
        return hits;
    }
    type ChunkCounts = HashMap<String, u32>;
    let mut docs: Vec<(&'a Record, Vec<(String, ChunkCounts)>)> = vec![];
    for record in active {
        let mut chunks = vec![];
        for text in chunk_text(&record.body) {
            let mut counts = HashMap::new();
            for token in tokens(&text) {
                *counts.entry(token).or_insert(0) += 1;
            }
            chunks.push((text, counts));
        }
        if !chunks.is_empty() {
            docs.push((*record, chunks));
        }
    }
    let total: usize = docs.iter().map(|(_, c)| c.len()).sum();
    if total == 0 {
        return vec![];
    }
    let avg_len: f64 = docs
        .iter()
        .flat_map(|(_, c)| c.iter())
        .map(|(_, m)| m.values().sum::<u32>() as f64)
        .sum::<f64>()
        / total as f64;
    let mut df: HashMap<&str, usize> = HashMap::new();
    for (_, chunks) in &docs {
        let mut seen = HashSet::new();
        for (_, counts) in chunks {
            for term in counts.keys() {
                if seen.insert(term.as_str()) {
                    *df.entry(term.as_str()).or_insert(0) += 1;
                }
            }
        }
    }
    let now = crate::memory::now();
    let mut scored: Vec<(usize, usize, f64)> = vec![];
    for (doc, (record, chunks)) in docs.iter().enumerate() {
        let title_terms: HashSet<String> =
            tokens(&format!("{} {}", record.title, record.tags.join(" ")))
                .into_iter()
                .collect();
        let title_hits = query.intersection(&title_terms).count() as f64;
        let age_days = now.saturating_sub(record.updated_at) as f64 / 86_400.0;
        let recency = 2.0 * (1.0 - (age_days / 90.0).min(1.0));
        let usage = (1.0 + record.use_count as f64).ln().min(3.0);
        let record_bonus = title_hits * 6.0
            + if record.pinned { 12.0 } else { 0.0 }
            + recency
            + usage
            + record.boost;
        for (idx, (_, counts)) in chunks.iter().enumerate() {
            let len: f64 = counts.values().sum::<u32>() as f64;
            let mut bm25 = 0.0;
            for term in query.iter() {
                let tf = counts.get(term).copied().unwrap_or(0) as f64;
                if tf == 0.0 {
                    continue;
                }
                let df = df.get(term.as_str()).copied().unwrap_or(1) as f64;
                let idf = (1.0 + (total as f64 - df + 0.5) / (df + 0.5)).ln();
                bm25 +=
                    idf * (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * len / avg_len.max(1.0)));
            }
            let score = bm25 + record_bonus;
            if score > 0.0 && (bm25 > 0.0 || title_hits > 0.0 || record.pinned) {
                scored.push((doc, idx, score));
            }
        }
    }
    scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let mut taken_per_record: HashMap<usize, usize> = HashMap::new();
    let mut hits = vec![];
    for (doc, idx, score) in scored {
        let taken = taken_per_record.entry(doc).or_insert(0);
        if *taken >= 2 {
            continue;
        }
        *taken += 1;
        hits.push(Hit {
            record: docs[doc].0,
            text: docs[doc].1[idx].0.clone(),
            score,
        });
        if hits.len() >= MAX_CHUNKS {
            break;
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::Store;

    struct Vault {
        _dir: PathBuf,
        v1: Store,
    }

    impl Vault {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("velum-memory-v2-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&dir).unwrap();
            Self {
                _dir: dir.clone(),
                v1: Store::at(dir),
            }
        }

        fn v2(&self) -> &Store2 {
            &self.v1.v2
        }

        fn add(
            &self,
            project: &str,
            title: &str,
            body: &str,
            scope: Scope,
            status: Status,
            pinned: bool,
        ) {
            self.v2()
                .request(
                    project,
                    Request::Save {
                        id: None,
                        revision: None,
                        title: title.into(),
                        body: body.into(),
                        tags: vec![],
                        scope,
                        status,
                        pinned,
                    },
                )
                .unwrap();
        }
    }

    impl Drop for Vault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self._dir);
        }
    }

    #[test]
    fn bm25_prefers_the_note_matching_more_distinctive_terms() {
        let v = Vault::new();
        v.add(
            "alpha",
            "Alpha",
            "The deploy pipeline runs on shared infrastructure with standard retries.",
            Scope::Project,
            Status::Active,
            false,
        );
        v.add(
            "alpha",
            "Beta",
            "Quokka rollback procedure: quokka rollback requires region freeze first.",
            Scope::Project,
            Status::Active,
            false,
        );
        let (prompt, usage, _) = v
            .v2()
            .prepare(
                "alpha",
                "quokka rollback",
                &mut Session::default(),
                None,
                false,
            )
            .unwrap();
        assert_eq!(usage.titles, vec!["Beta".to_string()]);
        assert!(prompt.contains("region freeze"));
    }

    #[test]
    fn chunking_finds_the_right_paragraph_in_a_long_note() {
        let v = Vault::new();
        let filler: Vec<String> = (0..20)
            .map(|i| format!("Filler paragraph {i} about routine standup scheduling habits."))
            .collect();
        let body = format!(
            "{}\n\nQuokka voltage threshold is 4.2 for the north wing.\n\n{}",
            filler[..10].join("\n\n"),
            filler[10..].join("\n\n")
        );
        v.add(
            "alpha",
            "Lab notes",
            &body,
            Scope::Project,
            Status::Active,
            false,
        );
        assert!(chunk_text(&body).len() > 2);
        let (prompt, _, _) = v
            .v2()
            .prepare(
                "alpha",
                "quokka voltage",
                &mut Session::default(),
                None,
                false,
            )
            .unwrap();
        assert!(prompt.contains("4.2 for the north wing"));
    }

    #[test]
    fn save_list_delete_roundtrip_with_revisions_and_tombstones() {
        let v = Vault::new();
        v.add(
            "alpha",
            "Saved",
            "Keep this note.",
            Scope::Project,
            Status::Active,
            false,
        );
        let view = v
            .v2()
            .request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes.len(), 1);
        let note = &view.notes[0];
        let stale = v.v2().request(
            "alpha",
            Request::Save {
                id: Some(note.meta.id.clone()),
                revision: Some("wrong".into()),
                title: note.meta.title.clone(),
                body: "Edited body.".into(),
                tags: vec![],
                scope: Scope::Project,
                status: Status::Active,
                pinned: false,
            },
        );
        assert!(stale.is_err());
        v.v2()
            .request(
                "alpha",
                Request::Save {
                    id: Some(note.meta.id.clone()),
                    revision: Some(note.revision.clone()),
                    title: note.meta.title.clone(),
                    body: "Edited body.".into(),
                    tags: vec![],
                    scope: Scope::Project,
                    status: Status::Active,
                    pinned: false,
                },
            )
            .unwrap();
        let view = v
            .v2()
            .request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes[0].body, "Edited body.");
        v.v2()
            .request(
                "alpha",
                Request::Delete {
                    id: view.notes[0].meta.id.clone(),
                    revision: view.notes[0].revision.clone(),
                },
            )
            .unwrap();
        // A re-sync of the same v1 note cannot revive the delete.
        v.v2().sync_from_v1("alpha", &view.notes).unwrap();
        let view = v
            .v2()
            .request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert!(view.notes.is_empty());
    }

    #[test]
    fn sync_imports_v1_notes_once_and_export_writes_obsidian_files() {
        let v = Vault::new();
        v.v1.request(
            "alpha",
            Request::Save {
                id: None,
                revision: None,
                title: "Legacy".into(),
                body: "A v1 note body.".into(),
                tags: vec!["old".into()],
                scope: Scope::Shared,
                status: Status::Active,
                pinned: true,
            },
        )
        .unwrap();
        let v1notes =
            v.v1.request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap()
            .notes;
        assert_eq!(v1notes.len(), 1);
        v.v2().sync_from_v1("alpha", &v1notes).unwrap();
        v.v2().sync_from_v1("alpha", &v1notes).unwrap();
        let view = v
            .v2()
            .request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes.len(), 1);
        assert_eq!(view.notes[0].meta.title, "Legacy");
        let file = v.v2().load().unwrap();
        let out = v.v2().export_obsidian(&file).unwrap();
        let exported: Vec<_> = fs::read_dir(out.join("shared"))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(exported.len(), 1);
        let content = fs::read_to_string(exported[0].path()).unwrap();
        assert!(content.contains("A v1 note body."));
        assert!(content.contains("not read back"));
    }

    #[test]
    fn prepare_respects_budget_and_reuse_window() {
        let v = Vault::new();
        for i in 0..6 {
            v.add(
                "alpha",
                &format!("Pinned {i}"),
                &format!("Important fact number {i} about quokka care."),
                Scope::Project,
                Status::Active,
                true,
            );
        }
        v.v2()
            .request(
                "alpha",
                Request::Configure {
                    settings: Settings {
                        enabled: true,
                        capture: Capture::Manual,
                        budget_bytes: 1_000,
                    },
                },
            )
            .unwrap();
        let mut session = Session::default();
        let (prompt, usage, _) = v
            .v2()
            .prepare("alpha", "quokka", &mut session, None, false)
            .unwrap();
        assert!(usage.bytes <= 1_000);
        assert!(!usage.titles.is_empty());
        assert!(prompt.contains("quokka"));
        let (_, reuse, _) = v
            .v2()
            .prepare("alpha", "quokka", &mut session, None, false)
            .unwrap();
        assert!(reuse.titles.is_empty());
        assert_eq!(reuse.bytes, 0);
    }

    #[test]
    fn forced_v1_store_delegates_to_v2_without_touching_markdown() {
        let v = Vault::new();
        v.v1.v2.set_forced(true);
        v.v1.request(
            "alpha",
            Request::Save {
                id: None,
                revision: None,
                title: "V2 note".into(),
                body: "Stored in v2 only.".into(),
                tags: vec![],
                scope: Scope::Project,
                status: Status::Active,
                pinned: false,
            },
        )
        .unwrap();
        let markdown: Vec<_> = walk(&v._dir)
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "md"))
            .collect();
        // Only the generated export may exist; no v1 vault files.
        assert!(markdown
            .iter()
            .all(|p| p.components().any(|c| c.as_os_str() == "exports")));
        let view =
            v.v1.request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes.len(), 1);
        let (prompt, _, _) =
            v.v1.prepare("alpha", "v2 only", &mut Session::default())
                .unwrap();
        assert!(prompt.contains("Stored in v2 only."));
    }

    #[test]
    fn fts_candidates_narrow_to_matching_notes_but_keep_pinned() {
        let v = Vault::new();
        v.add(
            "alpha",
            "Alpha",
            "The deploy pipeline runs on shared infrastructure.",
            Scope::Project,
            Status::Active,
            false,
        );
        v.add(
            "alpha",
            "Beta",
            "Quokka rollback requires region freeze first.",
            Scope::Project,
            Status::Active,
            false,
        );
        v.add(
            "alpha",
            "Pinned",
            "Unrelated pinned note about standups.",
            Scope::Project,
            Status::Active,
            true,
        );
        let ids = fts_candidates(&v.v1.v2.root, "quokka").expect("fts candidates");
        assert_eq!(ids.len(), 1);
        assert!(ids.iter().any(|id| id.starts_with("beta--")));
        let (prompt, usage, _) = v
            .v2()
            .prepare("alpha", "quokka", &mut Session::default(), None, false)
            .unwrap();
        assert!(usage.titles.contains(&"Beta".to_string()));
        assert!(usage.titles.contains(&"Pinned".to_string()));
        assert!(!usage.titles.contains(&"Alpha".to_string()));
        assert!(prompt.contains("region freeze"));
    }

    #[test]
    fn json_store_migrates_to_sqlite_once() {
        let v = Vault::new();
        let dir = v.v1.v2.root.clone();
        fs::create_dir_all(&dir).unwrap();
        let json = serde_json::json!({
            "version": 1,
            "settings": {},
            "records": [{
                "id": "legacy--1",
                "title": "Legacy",
                "body": "Migrated body.",
                "tags": [],
                "scope": "shared",
                "project_key": "whatever",
                "project_path": "alpha",
                "bot_id": null,
                "status": "active",
                "pinned": false,
                "kind": "fact",
                "source": "v1 import",
                "created_at": 1,
                "updated_at": 2,
                "use_count": 0,
                "last_used": 2,
                "boost": 0.0
            }],
            "tombstones": []
        });
        fs::write(
            dir.join("store.json"),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
        let view = v
            .v2()
            .request(
                "alpha",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes.len(), 1);
        assert_eq!(view.notes[0].body, "Migrated body.");
        assert!(dir.join("store.db").exists());
        assert!(dir.join("store.json.migrated").exists());
        let view = v
            .v2()
            .request(
                "beta",
                Request::List {
                    query: String::new(),
                },
            )
            .unwrap();
        assert_eq!(view.notes.len(), 1);
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(top) = stack.pop() {
            let Ok(entries) = fs::read_dir(&top) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out
    }
}
