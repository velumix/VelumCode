//! Instruction packs (skills). A skill is Markdown guidance the user chooses
//! for a conversation; the runner prepends enabled, selected skills to the
//! turn prompt for every provider. Skills never execute code and grant no
//! tool permissions. Repository skills mirror the plugin install flow:
//! review the exact bytes from a pinned GitHub commit, then install them.
use crate::plugin_github::Origin;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;

pub const MAX_SKILL_FILE: usize = 32 * 1024;
const MAX_SKILLS: usize = 64;
pub const MAX_PER_CHAT: usize = 8;
const CONTEXT_BUDGET: usize = 24_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub entry: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Installed {
    pub manifest: Manifest,
    pub digest: String,
    pub enabled: bool,
    #[serde(default)]
    pub origin: Option<Origin>,
}

#[derive(Clone, Serialize)]
pub struct Preview {
    pub manifest: Manifest,
    pub digest: String,
    pub bytes: usize,
    pub origin: Origin,
    /// The full SKILL.md text shown for review; these exact bytes install.
    pub body: String,
}

#[derive(Clone, Deserialize)]
pub struct LocalDraft {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub body: String,
}

pub struct SkillState {
    root: PathBuf,
    installed: Mutex<HashMap<String, Installed>>,
    previews: Mutex<HashMap<String, Preview>>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    (3..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && !id.contains("..")
        && !id.ends_with('.')
        && ![
            "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
            "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
        ]
        .contains(&id.split('.').next().unwrap_or(""))
}

fn valid_tag(tag: &str) -> bool {
    (1..=24).contains(&tag.len())
        && tag
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !tag.starts_with('-')
        && !tag.ends_with('-')
}

pub(crate) fn validate(m: &Manifest) -> Result<(), String> {
    if m.api_version != 1 {
        return Err("This skill needs a different format version. Supported API: 1.".into());
    }
    if !valid_id(&m.id) || m.entry != "SKILL.md" {
        return Err("Use a valid skill ID and a SKILL.md entry.".into());
    }
    for (value, limit) in [
        (&m.name, 80),
        (&m.version, 40),
        (&m.description, 500),
        (&m.author, 120),
    ] {
        if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err("Skill details are empty, too long, or contain control characters.".into());
        }
    }
    if m.tags.len() > 8
        || m.tags.iter().any(|t| !valid_tag(t))
        || m.tags.iter().collect::<HashSet<_>>().len() != m.tags.len()
    {
        return Err("Use up to 8 unique lowercase tags.".into());
    }
    Ok(())
}

/// Keep valid, unique IDs in selection order, capped per conversation.
/// Unknown IDs stay so the context builder can report them as skipped.
pub fn sanitize_selection(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| valid_id(id) && seen.insert(id.clone()))
        .take(MAX_PER_CHAT)
        .collect()
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

/// Split a leading `---` frontmatter block of simple `key: value` lines.
/// This intentionally supports only the flat subset used by SKILL.md files;
/// `velum-skill.json` remains the precise metadata path.
fn frontmatter(text: &str) -> (HashMap<String, String>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
    else {
        return (HashMap::new(), text);
    };
    let mut fields = HashMap::new();
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        offset += line.len();
        if trimmed == "---" || trimmed == "..." {
            return (fields, &rest[offset..]);
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            if !value.is_empty() && !matches!(value, ">" | "|" | ">-" | "|-") {
                fields.insert(key.trim().to_lowercase(), value.to_string());
            }
        }
    }
    (HashMap::new(), text)
}

fn strip_frontmatter(text: &str) -> &str {
    frontmatter(text).1.trim_start_matches(['\r', '\n'])
}

/// Build metadata for a repository that ships only SKILL.md. The ID comes
/// from the repository so two forks cannot collide under one publisher.
fn derive_manifest(origin: &Origin, skill_md: &str) -> Result<Manifest, String> {
    let (fields, _) = frontmatter(skill_md);
    let (owner, repo) = origin
        .repository
        .split_once('/')
        .ok_or("Invalid skill repository.")?;
    let name = fields
        .get("name")
        .cloned()
        .unwrap_or_else(|| repo.replace(['-', '_'], " "));
    let id = format!("{owner}.{}", slug(&name));
    if !valid_id(&id) {
        return Err(
            "This repository's SKILL.md name cannot form a skill ID. Add a velum-skill.json with a valid id."
                .into(),
        );
    }
    let manifest = Manifest {
        api_version: 1,
        id,
        name: name.chars().take(80).collect(),
        version: origin.commit.chars().take(7).collect(),
        description: fields
            .get("description")
            .cloned()
            .unwrap_or_else(|| format!("Skill from {}.", origin.repository))
            .chars()
            .take(500)
            .collect(),
        author: owner.to_string(),
        entry: "SKILL.md".into(),
        tags: Vec::new(),
    };
    validate(&manifest)?;
    Ok(manifest)
}

fn read_bounded(path: &Path, limit: usize) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Expected a regular file.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err(format!("File exceeds the {limit} byte limit."));
    }
    String::from_utf8(bytes).map_err(|_| "Only UTF-8 text files are supported.".into())
}

fn digest(manifest: &Manifest, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(manifest).unwrap());
    hash.update(text.as_bytes());
    format!("{:x}", hash.finalize())
}

fn package(repository: &str, commit: Option<&str>) -> Result<Preview, String> {
    let (origin, manifest_json, skill_md) = crate::skill_github::package(repository, commit)?;
    if skill_md.trim().is_empty() {
        return Err("SKILL.md is empty.".into());
    }
    let manifest = match manifest_json {
        Some(text) => {
            let manifest: Manifest = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid velum-skill.json: {e}"))?;
            validate(&manifest)?;
            manifest
        }
        None => derive_manifest(&origin, &skill_md)?,
    };
    let digest = digest(&manifest, &skill_md);
    Ok(Preview {
        bytes: skill_md.len(),
        manifest,
        digest,
        origin,
        body: skill_md,
    })
}

pub struct SkillContext {
    pub block: String,
    pub skipped: Vec<String>,
}

impl SkillState {
    fn store(&self, skill: Installed, text: &str) -> Result<Installed, String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        // Content-addressed body ensures the reviewed manifest and text stay paired.
        crate::storage::write_bytes(
            &self.root.join(format!("{}.md", skill.digest)),
            text.as_bytes(),
        )?;
        crate::storage::write_json(
            &self.root.join(format!("{}.json", skill.manifest.id)),
            &skill,
        )?;
        let mut installed = self.installed.lock().unwrap();
        let old = installed.insert(skill.manifest.id.clone(), skill.clone());
        if let Some(old) = old.filter(|old| old.digest != skill.digest) {
            let _ = fs::remove_file(self.root.join(format!("{}.md", old.digest)));
        }
        Ok(skill)
    }

    fn install(&self, repository: &str, reviewed_digest: &str) -> Result<(), String> {
        let preview = self
            .previews
            .lock()
            .unwrap()
            .get(reviewed_digest)
            .cloned()
            .ok_or("Review this skill again before installing.")?;
        if preview.origin.repository != crate::plugin_github::repository(repository)? {
            return Err("Repository changed after review. Review it again.".into());
        }
        let (enabled, len, known) = {
            let installed = self.installed.lock().unwrap();
            let old = installed.get(&preview.manifest.id);
            if let Some(old) = old {
                match &old.origin {
                    Some(origin) if origin.repository != preview.origin.repository => {
                        return Err("Another repository already uses this skill ID. Remove the existing skill before switching publishers.".into());
                    }
                    None => {
                        return Err("A local skill already uses this ID. Remove or rename it before installing this repository skill.".into());
                    }
                    _ => {}
                }
            }
            (
                old.map(|s| s.enabled).unwrap_or(true),
                installed.len(),
                old.is_some(),
            )
        };
        if len >= MAX_SKILLS && !known {
            return Err("The 64 skill limit has been reached.".into());
        }
        let digest = preview.digest.clone();
        self.store(
            Installed {
                manifest: preview.manifest,
                digest: preview.digest,
                enabled,
                origin: Some(preview.origin),
            },
            &preview.body,
        )?;
        self.previews.lock().unwrap().remove(&digest);
        Ok(())
    }

    fn save_local(&self, draft: LocalDraft) -> Result<Installed, String> {
        let body = draft.body.trim();
        if body.is_empty() {
            return Err("Write the skill instructions before saving.".into());
        }
        if draft.body.len() > MAX_SKILL_FILE {
            return Err("Skills are limited to 32 KB of instructions.".into());
        }
        let id = match &draft.id {
            Some(id) if valid_id(id) => id.clone(),
            Some(_) => return Err("Use a valid skill ID.".into()),
            None => {
                let id = format!("local.{}", slug(&draft.name));
                if !valid_id(&id) {
                    return Err("Give the skill a name with letters or numbers.".into());
                }
                id
            }
        };
        let (enabled, version, len, known) = {
            let installed = self.installed.lock().unwrap();
            match installed.get(&id) {
                Some(old) if old.origin.is_some() => {
                    return Err("Repository skills are updated from GitHub, not edited locally. Remove it first to keep a local copy under this ID.".into());
                }
                Some(old) => (
                    old.enabled,
                    old.manifest.version.clone(),
                    installed.len(),
                    true,
                ),
                None => (true, "local".into(), installed.len(), false),
            }
        };
        if len >= MAX_SKILLS && !known {
            return Err("The 64 skill limit has been reached.".into());
        }
        let manifest = Manifest {
            api_version: 1,
            id,
            name: draft.name.trim().into(),
            version,
            description: draft.description.trim().into(),
            author: "You".into(),
            entry: "SKILL.md".into(),
            tags: draft.tags,
        };
        validate(&manifest)?;
        let digest = digest(&manifest, &draft.body);
        self.store(
            Installed {
                manifest,
                digest,
                enabled,
                origin: None,
            },
            &draft.body,
        )
    }

    fn load(root: PathBuf) -> Self {
        let mut installed = HashMap::new();
        if let Ok(files) = fs::read_dir(&root) {
            for file in files.flatten().take(MAX_SKILLS * 4) {
                if file.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = read_bounded(&file.path(), 32 * 1024) else {
                    continue;
                };
                let Ok(mut skill) = serde_json::from_str::<Installed>(&text) else {
                    continue;
                };
                if validate(&skill.manifest).is_ok()
                    && file.file_name().to_string_lossy() == format!("{}.json", skill.manifest.id)
                    && installed.len() < MAX_SKILLS
                {
                    if skill
                        .origin
                        .as_ref()
                        .is_some_and(|o| !crate::plugin_github::valid_origin(o))
                    {
                        skill.enabled = false;
                    }
                    installed.insert(skill.manifest.id.clone(), skill);
                }
            }
        }
        Self {
            root,
            installed: Mutex::new(installed),
            previews: Mutex::new(HashMap::new()),
        }
    }

    fn body(&self, skill: &Installed) -> Result<String, String> {
        let text = read_bounded(
            &self.root.join(format!("{}.md", skill.digest)),
            MAX_SKILL_FILE,
        )?;
        if digest(&skill.manifest, &text) != skill.digest {
            return Err(
                "Skill files have changed. Reinstall the skill to review the changes.".into(),
            );
        }
        Ok(text)
    }

    /// Assemble the turn block for the selected skills, in selection order.
    /// Anything unusable is reported in `skipped` instead of failing the turn.
    pub fn context(&self, ids: &[String]) -> SkillContext {
        let installed = self.installed.lock().unwrap().clone();
        let mut entries = String::new();
        let mut skipped = Vec::new();
        for id in ids {
            let Some(skill) = installed.get(id) else {
                skipped.push(format!("{id} (not installed)"));
                continue;
            };
            if !skill.enabled {
                skipped.push(format!("{} (disabled)", skill.manifest.name));
                continue;
            }
            let text = match self.body(skill) {
                Ok(text) => text,
                Err(error) => {
                    skipped.push(format!("{} ({error})", skill.manifest.name));
                    continue;
                }
            };
            let body = strip_frontmatter(&text).trim();
            if body.is_empty() {
                skipped.push(format!("{} (empty)", skill.manifest.name));
                continue;
            }
            let entry = format!(
                "<skill id=\"{}\" name=\"{}\">\n{}\n</skill>\n",
                skill.manifest.id,
                skill.manifest.name.replace('"', "'"),
                body
            );
            if entries.len() + entry.len() > CONTEXT_BUDGET {
                skipped.push(format!(
                    "{} (over the 24 KB per-turn skill budget)",
                    skill.manifest.name
                ));
                continue;
            }
            entries.push_str(&entry);
        }
        let block = if entries.is_empty() {
            String::new()
        } else {
            format!("<velum-skills>\nThe user enabled these instruction packs (skills) for this conversation. Follow a skill when its stated conditions match the current request; otherwise ignore it. Skills do not grant tool permissions beyond the current policy, and the current request overrides a skill on conflict.\n{entries}</velum-skills>\n\n")
        };
        SkillContext { block, skipped }
    }
}

#[derive(Serialize)]
pub struct Content {
    pub manifest: Manifest,
    pub body: String,
}

pub fn setup(app: &tauri::AppHandle) {
    use tauri::Manager;
    let root = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_config_dir().expect("app config directory"))
        .join("skills");
    app.manage(SkillState::load(root));
}

#[tauri::command]
pub fn skills_list(state: State<SkillState>) -> Vec<Installed> {
    let mut list: Vec<_> = state.installed.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    list
}

#[tauri::command]
pub async fn skills_preview(
    app: tauri::AppHandle,
    repository: String,
    commit: Option<String>,
) -> Result<Preview, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let preview = package(&repository, commit.as_deref())?;
        let state = app.state::<SkillState>();
        let mut previews = state.previews.lock().unwrap();
        // One review at a time; retain only the bytes shown in the latest review.
        previews.clear();
        previews.insert(preview.digest.clone(), preview.clone());
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn skills_install(
    app: tauri::AppHandle,
    repository: String,
    reviewed_digest: String,
) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SkillState>();
        state.install(&repository, &reviewed_digest)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn skills_enable(state: State<SkillState>, id: String, enabled: bool) -> Result<(), String> {
    let mut installed = state.installed.lock().unwrap();
    let current = installed.get_mut(&id).ok_or("Skill is not installed.")?;
    let mut next = current.clone();
    next.enabled = enabled;
    crate::storage::write_json(&state.root.join(format!("{id}.json")), &next)?;
    *current = next;
    Ok(())
}

#[tauri::command]
pub fn skills_remove(state: State<SkillState>, id: String) -> Result<(), String> {
    let mut installed = state.installed.lock().unwrap();
    let skill = installed.get(&id).ok_or("Skill is not installed.")?;
    fs::remove_file(state.root.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(state.root.join(format!("{}.md", skill.digest)));
    installed.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn skills_content(app: tauri::AppHandle, id: String) -> Result<Content, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SkillState>();
        let skill = state
            .installed
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or("Skill is not installed.")?;
        let body = state.body(&skill)?;
        Ok(Content {
            manifest: skill.manifest,
            body,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn skills_save_local(state: State<SkillState>, draft: LocalDraft) -> Result<Installed, String> {
    state.save_local(draft)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest {
        serde_json::from_str(include_str!(
            "../../examples/review-checklist/velum-skill.json"
        ))
        .unwrap()
    }
    fn temp_state() -> (SkillState, PathBuf) {
        let root = std::env::temp_dir().join(format!("velum-skill-{}", uuid::Uuid::new_v4()));
        (SkillState::load(root.clone()), root)
    }
    #[test]
    fn frontmatter_reads_flat_fields_and_splits_the_body() {
        let text = "---\nname: \"Review checklist\"\ndescription: 'Check a change.'\n---\n# Body\nDo it.\n";
        let (fields, body) = frontmatter(text);
        assert_eq!(body, "# Body\nDo it.\n");
        assert_eq!(fields["name"], "Review checklist");
        assert_eq!(fields["description"], "Check a change.");
        assert_eq!(strip_frontmatter(text), "# Body\nDo it.\n");
        let plain = "# No frontmatter\n";
        assert!(frontmatter(plain).0.is_empty());
        assert_eq!(strip_frontmatter(plain), plain);
        let crlf = "---\r\nname: x\r\n---\r\nbody";
        assert_eq!(frontmatter(crlf).0["name"], "x");
        assert_eq!(strip_frontmatter(crlf), "body");
    }
    #[test]
    fn bare_skill_md_repositories_derive_stable_metadata() {
        let origin = Origin {
            repository: "someone/neat-skill".into(),
            commit: "a".repeat(40),
        };
        let m = derive_manifest(
            &origin,
            "---\nname: Neat Skill\ndescription: Does neat things.\n---\nBody",
        )
        .unwrap();
        assert_eq!(m.id, "someone.neat-skill");
        assert_eq!(m.author, "someone");
        assert_eq!(m.version, "aaaaaaa");
        let unnamed = derive_manifest(&origin, "Just instructions.").unwrap();
        assert_eq!(unnamed.id, "someone.neat-skill");
        assert!(unnamed.description.contains("someone/neat-skill"));
    }
    #[test]
    fn validation_rejects_bad_tags_entries_and_versions() {
        let mut m = manifest();
        validate(&m).unwrap();
        m.tags.push("Bad Tag".into());
        assert!(validate(&m).is_err());
        m.tags = vec!["dup".into(), "dup".into()];
        assert!(validate(&m).is_err());
        m.tags.clear();
        m.entry = "index.md".into();
        assert!(validate(&m).is_err());
        m.entry = "SKILL.md".into();
        m.api_version = 2;
        assert!(validate(&m).is_err());
        for id in ["../escape", "a/b", "con", "a..b", "C:foo"] {
            assert!(!valid_id(id));
        }
    }
    #[test]
    fn selection_keeps_order_dedupes_and_caps() {
        let ids: Vec<String> = (0..12).map(|i| format!("local.skill-{i}")).collect();
        let mut input = ids.clone();
        input.insert(1, ids[0].clone());
        input.push("../bad".into());
        let out = sanitize_selection(input);
        assert_eq!(out.len(), MAX_PER_CHAT);
        assert_eq!(out[0], "local.skill-0");
        assert_eq!(out[1], "local.skill-1");
    }
    #[test]
    fn installs_reviewed_bytes_without_switching_repositories() {
        let (state, root) = temp_state();
        let m = manifest();
        let text = include_str!("../../examples/review-checklist/SKILL.md");
        let mut preview = Preview {
            manifest: m.clone(),
            digest: digest(&m, text),
            bytes: text.len(),
            origin: Origin {
                repository: "velumix/example-skill".into(),
                commit: "a".repeat(40),
            },
            body: text.into(),
        };
        assert!(state
            .install("velumix/example-skill", "unreviewed")
            .is_err());
        state
            .previews
            .lock()
            .unwrap()
            .insert(preview.digest.clone(), preview.clone());
        assert!(state.install("other/repo", &preview.digest).is_err());
        state
            .install("velumix/example-skill", &preview.digest)
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join(format!("{}.md", preview.digest))).unwrap(),
            text
        );
        state
            .installed
            .lock()
            .unwrap()
            .get_mut(&m.id)
            .unwrap()
            .enabled = false;
        preview.origin.commit = "b".repeat(40);
        state
            .previews
            .lock()
            .unwrap()
            .insert(preview.digest.clone(), preview.clone());
        state
            .install("velumix/example-skill", &preview.digest)
            .unwrap();
        assert!(!SkillState::load(root.clone()).installed.lock().unwrap()[&m.id].enabled);
        preview.origin.repository = "other/repo".into();
        state
            .previews
            .lock()
            .unwrap()
            .insert(preview.digest.clone(), preview.clone());
        assert!(state
            .install("other/repo", &preview.digest)
            .unwrap_err()
            .contains("Another repository"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn local_skills_round_trip_and_repository_skills_stay_read_only() {
        let (state, root) = temp_state();
        let saved = state
            .save_local(LocalDraft {
                id: None,
                name: "My checks".into(),
                description: "Checks I like.".into(),
                tags: vec!["checks".into()],
                body: "Always run the tests.".into(),
            })
            .unwrap();
        assert_eq!(saved.manifest.id, "local.my-checks");
        let updated = state
            .save_local(LocalDraft {
                id: Some(saved.manifest.id.clone()),
                name: "My checks".into(),
                description: "Checks I like.".into(),
                tags: vec![],
                body: "Always run tests and lints.".into(),
            })
            .unwrap();
        assert_eq!(state.body(&updated).unwrap(), "Always run tests and lints.");
        let m = manifest();
        state
            .store(
                Installed {
                    manifest: m.clone(),
                    digest: digest(&m, "repo body"),
                    enabled: true,
                    origin: Some(Origin {
                        repository: "velumix/example-skill".into(),
                        commit: "a".repeat(40),
                    }),
                },
                "repo body",
            )
            .unwrap();
        assert!(state
            .save_local(LocalDraft {
                id: Some(m.id.clone()),
                name: "Hijack".into(),
                description: "No.".into(),
                tags: vec![],
                body: "No.".into(),
            })
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn context_applies_budget_and_reports_skips() {
        let (state, root) = temp_state();
        let big = "x".repeat(20_000);
        let first = state
            .save_local(LocalDraft {
                id: None,
                name: "First".into(),
                description: "First skill.".into(),
                tags: vec![],
                body: big.clone(),
            })
            .unwrap();
        let second = state
            .save_local(LocalDraft {
                id: None,
                name: "Second".into(),
                description: "Second skill.".into(),
                tags: vec![],
                body: big,
            })
            .unwrap();
        let third = state
            .save_local(LocalDraft {
                id: None,
                name: "Third".into(),
                description: "Third skill.".into(),
                tags: vec![],
                body: "Small.".into(),
            })
            .unwrap();
        state
            .installed
            .lock()
            .unwrap()
            .get_mut(&third.manifest.id)
            .unwrap()
            .enabled = false;
        let context = state.context(&[
            first.manifest.id.clone(),
            second.manifest.id.clone(),
            third.manifest.id.clone(),
            "local.missing".into(),
        ]);
        assert!(context.block.contains("<velum-skills>"));
        assert!(context.block.contains("local.first"));
        assert_eq!(context.skipped.len(), 3);
        assert!(context.skipped[0].contains("budget"));
        assert!(context.skipped[1].contains("disabled"));
        assert!(context.skipped[2].contains("not installed"));
        assert!(state.context(&[]).block.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn digest_binds_manifest_and_body() {
        let m = manifest();
        let before = digest(&m, "body");
        assert_ne!(before, digest(&m, "body changed"));
        let mut changed = m.clone();
        changed.tags.push("extra".into());
        assert_ne!(before, digest(&changed, "body"));
    }
}
