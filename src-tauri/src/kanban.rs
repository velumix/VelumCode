//! Workspace boards are loaded on demand and saved atomically after each edit.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::PathBuf, sync::Mutex};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub title: String,
    pub description: String,
    pub column: String,
    pub priority: String,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub assignment: Option<crate::automation::Assignment>,
    #[serde(default)]
    pub last_summary: String,
    #[serde(default)]
    pub last_run: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Board {
    pub revision: u64,
    pub cards: Vec<Card>,
    #[serde(default)]
    pub trash: Vec<DeletedCard>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeletedCard {
    pub card: Card,
    pub deleted_at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    #[serde(skip)]
    Replace {
        revision: u64,
        cards: Vec<Card>,
    },
    Load {},
    Save {
        revision: u64,
        card: Box<Card>,
    },
    Move {
        revision: u64,
        id: String,
        column: String,
        before: Option<String>,
    },
    Delete {
        revision: u64,
        id: String,
    },
    Restore {
        revision: u64,
        id: String,
    },
    Purge {
        revision: u64,
        id: String,
    },
}

pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
}
fn valid_column(column: &str) -> bool {
    matches!(column, "backlog" | "progress" | "review" | "done")
}
fn validate(card: &Card) -> Result<(), String> {
    if let Some(date) = &card.due_date {
        if date.len() != 10
            || !chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == *date)
        {
            return Err("Choose a valid due date (YYYY-MM-DD).".into());
        }
    }
    let mut dependencies = std::collections::HashSet::new();
    if card.dependencies.len() > 20
        || card
            .dependencies
            .iter()
            .any(|id| !crate::bots::valid_id(id) || id == &card.id || !dependencies.insert(id))
    {
        return Err(
            "Choose up to 20 different prerequisites. A task cannot depend on itself.".into(),
        );
    }
    if card.last_summary.len() > 4000 || card.last_run.as_ref().is_some_and(|id| id.len() > 150) {
        return Err("Task update exceeds its limit.".into());
    }
    if let Some(a) = &card.assignment {
        if !crate::bots::valid_id(&a.bot_id) {
            return Err("Choose a valid bot.".into());
        }
        crate::automation::next_due(&a.cron, &a.timezone, crate::automation::now())?;
    }
    if uuid::Uuid::parse_str(&card.id).is_err()
        || card.title.trim().is_empty()
        || card.title.chars().count() > 160
        || card.title.chars().any(char::is_control)
        || card.description.chars().count() > 8000
        || !valid_column(&card.column)
        || !matches!(card.priority.as_str(), "low" | "normal" | "high")
    {
        return Err("Use a title up to 160 characters, details up to 8,000, and a valid status and priority.".into());
    }
    Ok(())
}

pub fn blockers(board: &Board, card: &Card) -> Vec<String> {
    card.dependencies
        .iter()
        .filter_map(|id| match board.cards.iter().find(|c| &c.id == id) {
            Some(c) if c.column == "done" => None,
            Some(c) => Some(c.title.clone()),
            None => {
                Some("Deleted prerequisite — restore it from Trash or remove the dependency".into())
            }
        })
        .collect()
}

fn validate_graph(board: &Board) -> Result<(), String> {
    use std::collections::{HashMap, HashSet};
    let cards: HashMap<_, _> = board.cards.iter().map(|c| (c.id.as_str(), c)).collect();
    if cards.len() != board.cards.len() {
        return Err("Duplicate task ID.".into());
    }
    fn visit<'a>(
        id: &'a str,
        cards: &HashMap<&'a str, &'a Card>,
        visiting: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> bool {
        if done.contains(id) {
            return true;
        }
        if !visiting.insert(id) {
            return false;
        }
        if let Some(card) = cards.get(id) {
            for dependency in &card.dependencies {
                if !visit(dependency, cards, visiting, done) {
                    return false;
                }
            }
        }
        visiting.remove(id);
        done.insert(id);
        true
    }
    let mut done = HashSet::new();
    for id in cards.keys() {
        if !visit(id, &cards, &mut HashSet::new(), &mut done) {
            return Err("These prerequisites form a cycle. Remove a dependency so tasks can finish in order.".into());
        }
    }
    Ok(())
}
impl Store {
    fn path(&self, workspace: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(workspace)
            .canonicalize()
            .map_err(|e| format!("Cannot open this workspace: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a workspace folder first.".into());
        }
        let name = path.to_string_lossy().into_owned();
        #[cfg(windows)]
        let name = name.to_lowercase();
        Ok(self
            .root
            .join(format!("{:x}.json", Sha256::digest(name.as_bytes()))))
    }
    pub fn request(&self, workspace: &str, request: Request) -> Result<Board, String> {
        let _guard = self.lock.lock().unwrap();
        let path = self.path(workspace)?;
        let mut board = match fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = vec![];
                file.take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 4 * 1024 * 1024 {
                    return Err("This board exceeds the storage limit.".into());
                }
                serde_json::from_slice::<Board>(&bytes)
                    .map_err(|e| format!("Cannot read saved board: {e}"))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Board::default(),
            Err(e) => return Err(e.to_string()),
        };
        if board.cards.len() > 300 {
            return Err("Board exceeds the 300 card limit.".into());
        }
        for card in &board.cards {
            validate(card)?;
        }
        validate_graph(&board)?;
        if board.trash.len() > 50 {
            return Err("Task trash exceeds its limit.".into());
        }
        for deleted in &board.trash {
            validate(&deleted.card)?;
        }
        board
            .trash
            .retain(|entry| crate::automation::now().saturating_sub(entry.deleted_at) < 30 * 86400);
        let revision = match &request {
            Request::Load {} => return Ok(board),
            Request::Save { revision, .. }
            | Request::Replace { revision, .. }
            | Request::Move { revision, .. }
            | Request::Restore { revision, .. }
            | Request::Purge { revision, .. }
            | Request::Delete { revision, .. } => *revision,
        };
        if board.revision != revision {
            return Err("This board changed on another screen. Refresh the board before trying again. Your unsaved card is still here.".into());
        }
        match request {
            Request::Replace { cards, .. } => {
                if cards.len() > 300 {
                    return Err("This board is full (300 maximum).".into());
                }
                let mut ids = std::collections::HashSet::new();
                for card in &cards {
                    validate(card)?;
                    if !ids.insert(&card.id) {
                        return Err("Duplicate task ID.".into());
                    }
                }
                board.cards = cards;
            }
            Request::Save { mut card, .. } => {
                card.title = card.title.trim().into();
                validate(&card)?;
                let old = board.cards.iter().find(|c| c.id == card.id);
                if card.dependencies.iter().any(|id| {
                    !board.cards.iter().any(|c| &c.id == id)
                        && old.is_none_or(|c| !c.dependencies.contains(id))
                }) {
                    return Err("A prerequisite no longer exists. Refresh the board and choose another task.".into());
                }
                if let Some(old) = board.cards.iter_mut().find(|c| c.id == card.id) {
                    *old = *card;
                } else {
                    if board.cards.len() >= 300 {
                        return Err("This board is full. Remove a finished card before adding another (300 maximum).".into());
                    }
                    board.cards.push(*card);
                }
            }
            Request::Move {
                id, column, before, ..
            } => {
                if !valid_column(&column) {
                    return Err("Unknown column.".into());
                }
                let index = board
                    .cards
                    .iter()
                    .position(|c| c.id == id)
                    .ok_or("This card no longer exists.")?;
                if before.as_ref() == Some(&id) {
                    return Ok(board);
                }
                let mut card = board.cards.remove(index);
                card.column = column.clone();
                let index = match before {
                    Some(before) => board
                        .cards
                        .iter()
                        .position(|c| c.id == before && c.column == column)
                        .ok_or("The destination card changed. Refresh the board.")?,
                    None => board.cards.len(),
                };
                board.cards.insert(index, card);
            }
            Request::Delete { id, .. } => {
                let index = board
                    .cards
                    .iter()
                    .position(|c| c.id == id)
                    .ok_or("This card no longer exists.")?;
                let card = board.cards.remove(index);
                board.trash.retain(|entry| entry.card.id != id);
                board.trash.insert(
                    0,
                    DeletedCard {
                        card,
                        deleted_at: crate::automation::now(),
                    },
                );
                board.trash.truncate(50);
            }
            Request::Restore { id, .. } => {
                if board.cards.len() >= 300 {
                    return Err("This board is full (300 maximum).".into());
                }
                if board.cards.iter().any(|c| c.id == id) {
                    return Err("This task already exists on the board.".into());
                }
                let index = board
                    .trash
                    .iter()
                    .position(|entry| entry.card.id == id)
                    .ok_or("This task is no longer in Trash.")?;
                let mut card = board.trash.remove(index).card;
                // Restoring a task must never silently restart paid background work.
                if let Some(assignment) = &mut card.assignment {
                    assignment.automatic = false;
                }
                card.last_run = None;
                board.cards.push(card);
            }
            Request::Purge { id, .. } => {
                let index = board
                    .trash
                    .iter()
                    .position(|entry| entry.card.id == id)
                    .ok_or("This task is no longer in Trash.")?;
                board.trash.remove(index);
            }
            Request::Load {} => unreachable!(),
        }
        validate_graph(&board)?;
        if serde_json::to_vec(&board).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
            return Err("This board exceeds the storage limit. Shorten task details or empty older items from Trash.".into());
        }
        board.revision = board
            .revision
            .checked_add(1)
            .ok_or("Board revision limit reached.")?;
        crate::storage::write_json(&path, &board)?;
        Ok(board)
    }
}
pub fn setup(app: &tauri::AppHandle) {
    let root = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_config_dir().expect("app config directory"))
        .join("boards");
    app.manage(Store {
        root,
        lock: Mutex::new(()),
    });
}
#[tauri::command]
pub async fn kanban_request(
    app: tauri::AppHandle,
    workspace: String,
    request: Request,
) -> Result<Board, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Request::Save { card, .. } = &request {
            if let Some(a) = &card.assignment {
                app.state::<crate::bots::Store>().get(&a.bot_id)?;
            }
        }
        let is_mutation = !matches!(request, Request::Load {});
        let board = app.state::<Store>().request(&workspace, request)?;
        if is_mutation {
            use tauri::Emitter;
            let _ = app.emit("kanban-changed", &workspace);
        }
        crate::automation::sync(&app, &workspace, &board)
            .map_err(|e| format!("Board saved, but its schedule could not be updated: {e}"))?;
        Ok(board)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task(title: &str) -> Card {
        Card {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            column: "backlog".into(),
            priority: "normal".into(),
            ..Default::default()
        }
    }
    #[test]
    fn prerequisites_reject_cycles_and_missing_new_references_atomically() {
        let root = std::env::temp_dir().join(format!("velum-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Store {
            root: root.join("boards"),
            lock: Mutex::new(()),
        };
        let workspace = root.to_str().unwrap();
        let mut first = task("First");
        let mut second = task("Second");
        second.dependencies.push(first.id.clone());
        assert!(store
            .request(
                workspace,
                Request::Save {
                    revision: 0,
                    card: Box::new(second.clone())
                }
            )
            .is_err());
        store
            .request(
                workspace,
                Request::Save {
                    revision: 0,
                    card: Box::new(first.clone()),
                },
            )
            .unwrap();
        let board = store
            .request(
                workspace,
                Request::Save {
                    revision: 1,
                    card: Box::new(second.clone()),
                },
            )
            .unwrap();
        assert_eq!(blockers(&board, &second), vec!["First"]);
        first.dependencies.push(second.id.clone());
        assert!(store
            .request(
                workspace,
                Request::Save {
                    revision: 2,
                    card: Box::new(first.clone())
                }
            )
            .err()
            .unwrap()
            .contains("cycle"));
        assert_eq!(
            store.request(workspace, Request::Load {}).unwrap().revision,
            2
        );
        let board = store
            .request(
                workspace,
                Request::Move {
                    revision: 2,
                    id: first.id.clone(),
                    column: "done".into(),
                    before: None,
                },
            )
            .unwrap();
        assert!(blockers(&board, &second).is_empty());
        let board = store
            .request(
                workspace,
                Request::Delete {
                    revision: 3,
                    id: first.id.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            blockers(&board, &second).len(),
            1,
            "Deleted prerequisites remain blocking"
        );
        assert_eq!(board.trash[0].card.id, first.id);
        second.description = "Can still edit a task with a deleted prerequisite".into();
        store
            .request(
                workspace,
                Request::Save {
                    revision: 4,
                    card: Box::new(second.clone()),
                },
            )
            .unwrap();
        assert!(store
            .request(
                workspace,
                Request::Restore {
                    revision: 4,
                    id: first.id.clone()
                }
            )
            .is_err());
        let board = store
            .request(
                workspace,
                Request::Restore {
                    revision: 5,
                    id: first.id,
                },
            )
            .unwrap();
        assert!(blockers(&board, &second).is_empty());
        assert!(board.trash.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn trash_restores_details_without_restarting_work_and_expires() {
        let root = std::env::temp_dir().join(format!("velum-trash-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Store {
            root: root.join("boards"),
            lock: Mutex::new(()),
        };
        let workspace = root.to_str().unwrap();
        let mut card = task("Keep me");
        card.assignment = Some(crate::automation::Assignment {
            bot_id: uuid::Uuid::new_v4().to_string(),
            cron: "*/15 * * * *".into(),
            timezone: "UTC".into(),
            automatic: true,
        });
        card.due_date = Some("2028-02-29".into());
        card.last_summary = "Verified changes".into();
        card.last_run = Some("old-run".into());
        store
            .request(
                workspace,
                Request::Save {
                    revision: 0,
                    card: Box::new(card.clone()),
                },
            )
            .unwrap();
        store
            .request(
                workspace,
                Request::Delete {
                    revision: 1,
                    id: card.id.clone(),
                },
            )
            .unwrap();
        let restored = store
            .request(
                workspace,
                Request::Restore {
                    revision: 2,
                    id: card.id.clone(),
                },
            )
            .unwrap();
        let restored = &restored.cards[0];
        assert!(!restored.assignment.as_ref().unwrap().automatic);
        assert!(restored.last_run.is_none());
        assert_eq!(restored.last_summary, card.last_summary);
        assert_eq!(restored.due_date, card.due_date);
        let mut board = store
            .request(
                workspace,
                Request::Delete {
                    revision: 3,
                    id: card.id.clone(),
                },
            )
            .unwrap();
        board.trash[0].deleted_at = crate::automation::now() - 30 * 86400;
        crate::storage::write_json(&store.path(workspace).unwrap(), &board).unwrap();
        assert!(store
            .request(workspace, Request::Load {})
            .unwrap()
            .trash
            .is_empty());
        assert!(store
            .request(
                workspace,
                Request::Restore {
                    revision: 4,
                    id: card.id
                }
            )
            .is_err());
        // Only the newest 50 cards are recoverable; purging retains revision protection.
        let mut board = Board {
            revision: 4,
            ..Default::default()
        };
        for i in 0..50 {
            board.trash.push(DeletedCard {
                card: task(&format!("Old {i}")),
                deleted_at: crate::automation::now(),
            });
        }
        let newest = task("Newest");
        board.cards.push(newest.clone());
        crate::storage::write_json(&store.path(workspace).unwrap(), &board).unwrap();
        let board = store
            .request(
                workspace,
                Request::Delete {
                    revision: 4,
                    id: newest.id.clone(),
                },
            )
            .unwrap();
        assert_eq!(board.trash.len(), 50);
        assert_eq!(board.trash[0].card.id, newest.id);
        assert!(store
            .request(
                workspace,
                Request::Purge {
                    revision: 4,
                    id: newest.id.clone()
                }
            )
            .is_err());
        assert_eq!(
            store
                .request(
                    workspace,
                    Request::Purge {
                        revision: 5,
                        id: newest.id
                    }
                )
                .unwrap()
                .trash
                .len(),
            49
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn planning_accepts_legacy_boards_and_rejects_invalid_dates_and_dependencies() {
        let card = task("Legacy");
        let mut value = serde_json::to_value(&card).unwrap();
        value.as_object_mut().unwrap().remove("due_date");
        value.as_object_mut().unwrap().remove("dependencies");
        let board: Board =
            serde_json::from_value(serde_json::json!({"revision":1,"cards":[value]})).unwrap();
        assert!(board.trash.is_empty());
        assert!(board.cards[0].dependencies.is_empty());
        for date in ["2026-02-29", "2026-13-01", "2026-9-01", "tomorrow"] {
            let mut invalid = card.clone();
            invalid.due_date = Some(date.into());
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = card.clone();
        invalid.dependencies = vec![card.id.clone()];
        assert!(validate(&invalid).is_err());
        invalid.dependencies = vec![uuid::Uuid::new_v4().to_string(); 2];
        assert!(validate(&invalid).is_err());
        invalid.dependencies = (0..21).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn boards_persist_reorder_and_reject_stale_writes() {
        let root = std::env::temp_dir().join(format!("velum-board-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("one")).unwrap();
        fs::create_dir(root.join("two")).unwrap();
        let store = Store {
            root: root.join("saved"),
            lock: Mutex::new(()),
        };
        let workspace = root.join("one").to_string_lossy().into_owned();
        let card = Card {
            id: uuid::Uuid::new_v4().to_string(),
            title: "First".into(),
            description: "Details".into(),
            column: "backlog".into(),
            priority: "high".into(),
            assignment: None,
            last_summary: String::new(),
            last_run: None,
            ..Default::default()
        };
        let board = store
            .request(
                &workspace,
                Request::Save {
                    revision: 0,
                    card: Box::new(card.clone()),
                },
            )
            .unwrap();
        assert_eq!(board.revision, 1);
        assert!(store
            .request(
                &workspace,
                Request::Delete {
                    revision: 0,
                    id: card.id.clone()
                }
            )
            .is_err());
        let mut other = card.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.title = "Second".into();
        store
            .request(
                &workspace,
                Request::Save {
                    revision: 1,
                    card: Box::new(other.clone()),
                },
            )
            .unwrap();
        let board = store
            .request(
                &workspace,
                Request::Move {
                    revision: 2,
                    id: other.id.clone(),
                    column: "backlog".into(),
                    before: Some(card.id.clone()),
                },
            )
            .unwrap();
        assert_eq!(board.cards[0].id, other.id);
        assert!(store
            .request(
                &workspace,
                Request::Move {
                    revision: 3,
                    id: card.id.clone(),
                    column: "bad".into(),
                    before: None
                }
            )
            .is_err());
        assert_eq!(
            store
                .request(&workspace, Request::Load {})
                .unwrap()
                .revision,
            3
        );
        assert!(store
            .request(root.join("two").to_str().unwrap(), Request::Load {})
            .unwrap()
            .cards
            .is_empty());
        let reopened = Store {
            root: root.join("saved"),
            lock: Mutex::new(()),
        };
        assert_eq!(
            reopened
                .request(&workspace, Request::Load {})
                .unwrap()
                .cards
                .len(),
            2
        );
        store
            .request(
                &workspace,
                Request::Delete {
                    revision: 3,
                    id: card.id,
                },
            )
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn card_and_request_limits() {
        let mut card = Card {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Task".into(),
            description: String::new(),
            column: "review".into(),
            priority: "normal".into(),
            assignment: None,
            last_summary: String::new(),
            last_run: None,
            ..Default::default()
        };
        validate(&card).unwrap();
        card.title = " ".into();
        assert!(validate(&card).is_err());
        card.title = "Task".into();
        card.description = "x".repeat(8001);
        assert!(validate(&card).is_err());
        assert!(
            serde_json::from_str::<Request>(r#"{"action":"load","workspace":"elsewhere"}"#)
                .is_err()
        );
    }
}
