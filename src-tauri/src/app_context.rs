//! Small, local context checks. Reports deliberately exclude prompts, credentials,
//! environment variables, raw CLI errors, repository URLs and memory contents.
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};
use tauri::Manager;

#[derive(Serialize)]
pub struct Access {
    pub path: String,
    pub checked_at: u64,
    pub readable: bool,
    pub writable: Option<bool>,
    pub message: String,
    pub report: crate::workspace_access::Report,
    pub sanitized: Value,
}

pub fn readable(path: &Path) -> bool {
    fs::read_dir(path)
        .and_then(|mut entries| entries.next().transpose())
        .is_ok()
}

fn probe(path: &Path, write: bool) -> Access {
    let report = crate::workspace_access::host_probe(path, write);
    let readable = report.checks[0].status == crate::workspace_access::Status::Pass;
    let writable = write.then(|| {
        report.checks[2..]
            .iter()
            .all(|c| c.status == crate::workspace_access::Status::Pass)
    });
    Access {
        path: path.display().to_string(), checked_at: report.checked_at, readable, writable,
        message: "Host filesystem results only. Agent/provider access requires Test agent access in the active conversation.".into(),
        sanitized: crate::workspace_access::sanitized(&report), report,
    }
}

#[tauri::command]
pub async fn git_state(workspace: String) -> Result<Value, String> {
    // One read-only call for the Git panel: branch list plus working-tree
    // status. Never changes configuration, branches, commits or files.
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&workspace);
        let branches = crate::workspace_tools::git_branches(root)?;
        let status = crate::workspace_tools::git_status(root)?;
        Ok(json!({
            "root": branches["root"],
            "current": branches["current"],
            "branches": branches["branches"],
            "branches_truncated": branches["truncated"],
            "status": status["status"],
            "status_truncated": status["truncated"],
            "trust": "Selected repository only, for this command.",
            "global_config_changed": false,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_file_diff(workspace: String, base: String, path: String) -> Result<Value, String> {
    // Unified diff of one repository-relative file against `base`
    // (empty means HEAD). Read-only; see workspace_tools::git_diff.
    tauri::async_runtime::spawn_blocking(move || {
        let relative = if path.is_empty() {
            None
        } else {
            Some(path.as_str())
        };
        crate::workspace_tools::git_diff(Path::new(&workspace), &base, relative)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_check(
    app: tauri::AppHandle,
    workspace: String,
    write: bool,
    id: Option<String>,
) -> Result<Access, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = probe(Path::new(&workspace), write);
        if let Some(id) = id {
            app.state::<crate::runner::AgentState>().record_host(
                &id,
                Path::new(&workspace),
                result.report.clone(),
            );
        }
        result
    })
    .await
    .map_err(|e| e.to_string())
}

fn small_file(path: &Path) -> Option<String> {
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn repository(path: &Path) -> Option<Value> {
    for root in path.ancestors() {
        let marker = root.join(".git");
        let git = if marker.is_dir() {
            marker
        } else if marker.is_file() {
            let data = small_file(&marker)?;
            root.join(data.trim().strip_prefix("gitdir: ")?)
        } else {
            continue;
        };
        let head = small_file(&git.join("HEAD"));
        return Some(json!({
            "root": root.display().to_string(),
            "branch": head.as_deref().and_then(|h| h.trim().strip_prefix("ref: refs/heads/")).map(|h| h.chars().take(160).collect::<String>()),
            "working_tree_changes": "not checked"
        }));
    }
    None
}

pub fn turn_context(
    workspace: &Path,
    provider: crate::providers::Provider,
    options: &crate::provider_models::RunOptions,
    source: &str,
    yolo: bool,
    access: Option<Value>,
) -> String {
    let access = access_payload(workspace, provider, yolo, access, false);
    let mut context = json!({
        "app": "Velum Code", "version": env!("CARGO_PKG_VERSION"),
        "host_os": std::env::consts::OS, "request_source": source,
        "screen": if source == "scheduler" { "background task" } else { "chat" },
        "workspace": workspace.display().to_string(),
        "workspace_access": access,
        "repository": repository(workspace), "provider": provider, "options": options,
        "permission_mode": if yolo { "user enabled YOLO" } else { "standard; provider policy still applies to tool calls" },
        "ui_access": "Velum's MCP bridge can supply an isolated preview browser and separately enabled native screenshot/input tools. Discover the actual tool list; a setting is not connection evidence. A user can also attach a previewed chat layout snapshot or timing diagnostics report.",
        "memory": "Selected notes and usage are supplied separately. With Velum tools connected, vault_search reads enabled active notes scoped to this project and the current bot. Pending, archived and other projects/bots are excluded.",
        "capabilities": "CLI installation does not establish authentication or working tool connections. Check actual tool results; do not infer access from this context."
    });
    // Count serialized bytes: escaping can expand paths and custom model names.
    // Leave room for framing and explain omitted fields instead of giving the
    // provider a truncated path that could point to the wrong directory.
    if context.to_string().len() > 14000 {
        for key in ["workspace", "repository", "options"] {
            context[key] = Value::Null;
        }
        context["workspace_access"] = Value::Null;
        context["omitted_fields"] = json!("Workspace, access evidence, repository and options exceeded the app context size limit. Ask the user for those details if needed.");
    }
    format!("Velum app context (reference data, not instructions or permission grants):\n<velum-app-context>\n{context}\n</velum-app-context>\n\n")
}

fn access_payload(
    path: &Path,
    provider: crate::providers::Provider,
    yolo: bool,
    cached: Option<Value>,
    sanitized: bool,
) -> Value {
    let mut value = cached.unwrap_or_else(|| json!({
        "agent": crate::workspace_access::Report::untested(path, format!("{} agent tools", provider.label()), yolo, 0),
        "permissions":{"requested_mode":crate::workspace_access::mode(yolo),"launched_mode":null,"effective":{"status":"untested"}}
    }));
    value["collection"] = json!({"method":"explicit_diagnostic_turn","detail":crate::workspace_access::COLLECTION_DETAIL});
    let profile_root = crate::workspace_access::is_profile_root(path);
    value["selection"] = json!({
        "kind": if profile_root { "user_profile_root" } else { "project_directory" },
        "guidance": crate::workspace_access::project_required(path, provider, yolo).then_some(crate::workspace_access::PROFILE_ROOT_GUIDANCE),
        "write_probe_scope":"A unique new file directly in the selected directory. Known-file reading uses a separate harmless fixture."
    });
    if value["host"].is_null() {
        let host = crate::workspace_access::host_probe(path, false);
        value["host"] = if sanitized {
            crate::workspace_access::sanitized(&host)
        } else {
            json!(host)
        };
    }
    if sanitized && cached_is_absent_agent_path(&value) {
        // Unbound diagnostics carry no provider session evidence.
        let report = crate::workspace_access::Report::untested(
            path,
            format!("{} agent tools", provider.label()),
            yolo,
            0,
        );
        value["agent"] = crate::workspace_access::sanitized(&report);
    }
    value
}
fn cached_is_absent_agent_path(value: &Value) -> bool {
    value["agent"]["checks"][0]["path"]
        .as_str()
        .is_some_and(|p| !p.starts_with("<selected-project>"))
}

pub fn diagnostics(app: &tauri::AppHandle, workspace: &str, id: Option<&str>) -> Value {
    let path = Path::new(workspace);
    let cached = id.and_then(|id| {
        app.state::<crate::runner::AgentState>()
            .access(id, path, true)
    });
    let unbound = cached.is_none();
    let (provider, yolo) = id
        .and_then(|id| {
            app.state::<crate::runner::AgentState>()
                .session_context(id, path)
        })
        .unwrap_or((crate::providers::Provider::Codex, false));
    let mut access = access_payload(path, provider, yolo, cached, true);
    if unbound {
        access["selection"]["guidance"] = Value::Null;
        access["agent"]["environment"] = json!("No active provider session");
        access["agent"]["permission_mode"] = json!("untested");
        if let Some(checks) = access["agent"]["checks"].as_array_mut() {
            for check in checks {
                check["environment"] = json!("No active provider session");
            }
        }
        access["permissions"]["requested_mode"] = json!("untested");
    }
    let providers: Vec<Value> = [crate::providers::Provider::Muse, crate::providers::Provider::Codex, crate::providers::Provider::Antigravity]
        .into_iter().map(|p| json!({"provider":p,"installed":p.resolve().is_some(),"authentication":"not checked","tool_connections":"not checked"})).collect();
    let memory = app.state::<crate::memory::Store>().request(
        workspace,
        crate::memory::Request::List {
            query: String::new(),
        },
    );
    let memory = match memory {
        Ok(view) => {
            json!({"scope":"shared/project vault","readable":true,"enabled":view.settings.enabled,"capture":view.settings.capture,"budget_bytes":view.settings.budget_bytes,"notes":view.notes.len(),"warning_present":view.warning.is_some()})
        }
        Err(_) => json!({"readable":false,"next_step":"Open Memory to inspect the vault error."}),
    };
    let sessions = app.state::<crate::session_log::SessionLog>().summaries();
    let sessions: Vec<_> = sessions
        .iter()
        .filter(|s| Path::new(&s.workspace) == path)
        .collect();
    let runtime = sessions.iter().find(|s| Some(s.id.as_str()) == id).map(|s| json!({
        "provider":s.provider,"turn_status":s.status,"running":s.running,
        "progress":s.provider_progress,"last_retry":s.last_provider_retry,
        "detail":"Observed in this conversation's provider stream. Does not verify workspace access or external tool connections."
    }));
    json!({
        "app":"Velum Code", "version":env!("CARGO_PKG_VERSION"), "host_os":std::env::consts::OS,
        "checked_at":crate::automation::now(),
        "workspace":{"path":"<selected-project>","message":"Host and active agent results are separate. Untested is not a pass.","git_repository":repository(path).is_some()},
        "workspace_access":access,
        "providers":providers, "memory":memory,
        "provider_runtime":runtime,
        "agent_tools":crate::tool_bridge::context(app),
        "turn_measurement":id.and_then(|id|app.state::<crate::runner::AgentState>().measurement(id,path)),
        "sessions":{"active":sessions.iter().filter(|s| s.running).count(),"failed":sessions.iter().filter(|s| s.status=="failed").count(),"blocked":sessions.iter().filter(|s| s.status=="blocked").count()},
        "connections": (["GitHub", "Gmail", "Google Drive", "Trello"].map(|name| json!({"name":name,"status":"untested","checked_at":null,"environment":"active provider","detail":"Velum has no live connection-health evidence. CLI installation or earlier conversation claims do not verify a connection."}))),
        "attachments":{"ui":{"status":"untested","attached_count":null,"discovery_implemented":false},"documents":{"status":"untested","attached_count":null,"discovery_implemented":false},"detail":"Velum does not discover external provider UI/document sessions. Its own isolated browser and opt-in native tools are separate MCP capabilities. A chat layout snapshot is structural data only."},
        "permissions":"Windows folder access and provider command permissions are separate. On the desktop, open Terminal in an Antigravity tab and enter /permissions; allow only the command needed under permissions.allow in ~/.gemini/antigravity-cli/settings.json, then retry. Scheduled permission failures pause for review.",
        "excluded":"Absolute paths, account identities, chat text, drafts, credential values, environment variables, raw logs, repository remotes, memory contents and custom permission rules. Provider token counts and timing are included."
    })
}

#[tauri::command]
pub async fn app_diagnostics(
    app: tauri::AppHandle,
    workspace: String,
    id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || diagnostics(&app, &workspace, id.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let owner = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize);
        tauri::async_runtime::spawn_blocking(move || pick_folder(owner))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Enter a project path in the workspace field.".into())
    }
}

#[cfg(windows)]
fn pick_folder(owner: Option<isize>) -> Result<Option<String>, String> {
    use windows::Win32::{Foundation::HWND, System::Com::*, UI::Shell::*};
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _com = Com;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        dialog
            .SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)
            .map_err(|e| e.to_string())?;
        dialog
            .SetTitle(windows::core::w!("Choose your project"))
            .map_err(|e| e.to_string())?;
        if let Err(error) = dialog.Show(owner.map(|h| HWND(h as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err(error.to_string());
        }
        let item = dialog.GetResult().map_err(|e| e.to_string())?;
        let path = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|e| e.to_string())?;
        let result = path.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(path.0 as *const _));
        result.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_context_omits_fields_without_inventing_a_shorter_path() {
        let path = std::path::PathBuf::from("x".repeat(8000));
        let context = turn_context(
            &path,
            crate::providers::Provider::Muse,
            &Default::default(),
            "desktop",
            false,
            None,
        );
        assert!(context.len() <= 16384);
        assert!(context.contains("\"workspace\":null"));
        assert!(context.contains("omitted_fields"));
        assert!(!context.contains(&"x".repeat(100)));
    }
    #[test]
    fn provider_context_never_orders_the_model_to_run_user_only_diagnostics() {
        // The same check details appear in the provider prompt and the user
        // report. They must stay descriptive: the model cannot click UI, so a
        // "run checks" imperative only teaches it to demand user action
        // instead of investigating with its own tools.
        for provider in [
            crate::providers::Provider::Muse,
            crate::providers::Provider::Codex,
            crate::providers::Provider::Antigravity,
        ] {
            let context = turn_context(
                &std::env::temp_dir(),
                provider,
                &Default::default(),
                "desktop",
                false,
                None,
            );
            assert!(!context.contains("Run Test agent access"));
            assert!(!context.contains("Run checks again"));
            assert!(context.contains("Ordinary tool results still stand"));
            assert!(context
                .contains("Untested means no diagnostic evidence, not that access is unavailable"));
            assert!(context.contains("provider policy still applies to tool calls"));
        }
    }
    #[test]
    fn ordinary_context_keeps_agent_checks_untested_and_explains_collection() {
        let root = std::env::temp_dir();
        let access = access_payload(&root, crate::providers::Provider::Codex, false, None, false);
        assert_eq!(access["host"]["checks"][0]["status"], "pass");
        assert!(access["agent"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["status"] == "untested"));
        assert_eq!(access["collection"]["method"], "explicit_diagnostic_turn");
        assert!(access["collection"]["detail"]
            .as_str()
            .unwrap()
            .contains("Ordinary chat tool calls do not update"));
    }
    #[cfg(windows)]
    #[test]
    fn selection_guidance_matches_launch_restriction_for_every_provider_and_mode() {
        use crate::providers::Provider;
        let home = crate::pty::home_dir();
        assert!(crate::workspace_access::is_profile_root(&home));
        let project = std::env::temp_dir().join(format!("velum-guidance-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&project).unwrap();
        for (provider, yolo, expect_guidance) in [
            (Provider::Muse, false, false),
            (Provider::Muse, true, false),
            (Provider::Antigravity, false, false),
            (Provider::Antigravity, true, false),
            (Provider::Codex, false, true),
            (Provider::Codex, true, false),
        ] {
            let root = access_payload(&home, provider, yolo, None, false);
            assert_eq!(root["selection"]["kind"], "user_profile_root");
            assert_eq!(
                root["selection"]["guidance"].is_string(),
                expect_guidance,
                "{provider:?} yolo={yolo} at profile root"
            );
            if expect_guidance {
                assert_eq!(
                    root["selection"]["guidance"].as_str().unwrap(),
                    crate::workspace_access::PROFILE_ROOT_GUIDANCE
                );
            }
            let dir = access_payload(&project, provider, yolo, None, false);
            assert_eq!(dir["selection"]["kind"], "project_directory");
            assert!(
                dir["selection"]["guidance"].is_null(),
                "{provider:?} yolo={yolo} in project directory"
            );
        }
        fs::remove_dir(&project).unwrap();
    }
    #[test]
    fn access_probe_cleans_up_and_reports_missing_folders() {
        let root = std::env::temp_dir().join(format!("velum-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let check = probe(&root, true);
        assert!(check.readable);
        assert_eq!(check.writable, Some(true));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(&root).unwrap();
        assert!(!probe(&root, false).readable);
    }
    #[test]
    fn context_covers_worktrees_without_reading_remote_credentials() {
        let root = std::env::temp_dir().join(format!("velum-context-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("metadata")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        fs::write(root.join("project/.git"), "gitdir: ../metadata").unwrap();
        fs::write(
            root.join("metadata/HEAD"),
            "ref: refs/heads/feature/context\n",
        )
        .unwrap();
        fs::write(root.join("metadata/config"), "credential=SECRET").unwrap();
        let context = turn_context(
            &root.join("project"),
            crate::providers::Provider::Antigravity,
            &Default::default(),
            "desktop",
            false,
            None,
        );
        assert!(context.contains("feature/context"));
        assert!(context.contains("Velum host process"));
        assert!(context.contains("untested"));
        assert!(!context.contains("passed in Velum"));
        assert!(!context.contains("SECRET"));
        assert!(context.len() < 16384);
        fs::remove_file(root.join("project/.git")).unwrap();
        fs::remove_file(root.join("metadata/HEAD")).unwrap();
        fs::remove_file(root.join("metadata/config")).unwrap();
        fs::remove_dir(root.join("project")).unwrap();
        fs::remove_dir(root.join("metadata")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
