//! Evidence for one workspace, provider session and permission revision. Host
//! observations never establish provider access. Only tool results count.
use crate::providers::Provider;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const OPERATIONS: [&str; 6] = [
    "directory_listing",
    "known_file_read",
    "file_creation",
    "file_editing",
    "read_back",
    "cleanup",
];

pub const COLLECTION_DETAIL: &str = "This snapshot records only Test agent access turns in this session. Ordinary chat tool calls do not update this snapshot. Untested means no diagnostic evidence, not that access is unavailable.";
pub const PROFILE_ROOT_GUIDANCE: &str = "Choose a project folder and Apply it before coding in Codex Standard mode. The Windows sandbox can deny listing and file creation at the user-profile root even when files below it are accessible. Test agent access can check this folder without changing permissions.";

/// Compare resolved paths, so casing, trailing separators, `..` and junctions
/// cannot disguise a profile-root selection. This does not inspect ACLs or grant access.
pub fn is_profile_root(workspace: &Path) -> bool {
    cfg!(windows)
        && fs::canonicalize(workspace).ok().is_some_and(|selected| {
            fs::canonicalize(crate::pty::home_dir())
                .ok()
                .is_some_and(|home| selected == home)
        })
}

pub fn project_required(workspace: &Path, provider: Provider, yolo: bool) -> bool {
    provider == Provider::Codex && !yolo && is_profile_root(workspace)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Fail,
    Blocked,
    Untested,
}

#[derive(Clone, Debug, Serialize)]
pub struct Check {
    pub operation: String,
    pub status: Status,
    pub path: String,
    pub checked_at: Option<u64>,
    pub environment: String,
    pub detail: String,
    pub error_code: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub checked_at: u64,
    pub environment: String,
    pub checks: Vec<Check>,
    pub running: bool,
    pub revision: u64,
    pub permission_mode: String,
    pub host_cleanup: Option<Check>,
}

pub fn mode(yolo: bool) -> &'static str {
    if yolo {
        "yolo"
    } else {
        "standard"
    }
}

impl Report {
    pub fn untested(path: &Path, environment: String, yolo: bool, revision: u64) -> Self {
        Self {
            checked_at: crate::automation::now(),
            environment: environment.clone(),
            running: false,
            revision,
            permission_mode: mode(yolo).into(),
            host_cleanup: None,
            checks: OPERATIONS
                .iter()
                .map(|op| Check {
                    operation: (*op).into(),
                    status: Status::Untested,
                    path: path.display().to_string(),
                    checked_at: None,
                    environment: environment.clone(),
                    detail: "No diagnostic operation evidence for this session and permission mode. Ordinary tool results still stand; only an explicit Test agent access turn records evidence in these checks.".into(),
                    error_code: None,
                    exit_code: None,
                })
                .collect(),
        }
    }
    fn record(
        &mut self,
        op: &str,
        status: Status,
        detail: &str,
        code: Option<String>,
        exit: Option<i64>,
    ) {
        if let Some(check) = self.checks.iter_mut().find(|c| c.operation == op) {
            check.status = status;
            check.checked_at = Some(crate::automation::now());
            check.detail = detail.into();
            check.error_code = code;
            check.exit_code = exit;
        }
    }
    pub fn invalidate(&mut self, revision: u64, yolo: bool) {
        self.revision = revision;
        self.permission_mode = mode(yolo).into();
        self.running = false;
        self.host_cleanup = None;
        for c in &mut self.checks {
            c.status = Status::Untested;
            c.checked_at = None;
            c.error_code = None;
            c.exit_code = None;
            c.detail =
                "Invalidated by a provider session or permission change. This evidence no longer applies; only an explicit Test agent access turn records new evidence.".into();
        }
    }
}

/// Error descriptions are allowlisted, never copied from command output (which
/// can contain credentials, private paths, command text or file contents).
pub fn failure(text: &str) -> Option<(Status, &'static str, &'static str)> {
    let lower = text.to_ascii_lowercase();
    if [
        "blocked by policy",
        "rejected",
        "auto-denied",
        "soft-denied",
        "approval required",
        "cannot prompt",
        "user denied permission",
        "permission check failed",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        Some((
            Status::Blocked,
            "Provider policy rejected the operation; execution was not confirmed.",
            "provider_policy",
        ))
    } else if [
        "access is denied",
        "access denied",
        "unauthorizedaccessexception",
        "permissiondenied",
        "permission denied",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        Some((
            Status::Fail,
            "The execution environment denied filesystem access.",
            "access_denied",
        ))
    } else if [
        "pathnotfound",
        "itemnotfoundexception",
        "cannot find path",
        "filenotfoundexception",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        Some((
            Status::Fail,
            "The probe path was not found in this execution environment.",
            "path_not_found",
        ))
    } else if lower.contains("categoryinfo")
        || lower.contains("fullyqualifiederrorid")
        || lower.contains("exception")
    {
        Some((
            Status::Fail,
            "PowerShell reported an error, regardless of its process exit code.",
            "powershell_error",
        ))
    } else {
        None
    }
}

pub fn powershell_error(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim_start().starts_with("+ CategoryInfo"))
        && text
            .lines()
            .any(|line| line.trim_start().starts_with("+ FullyQualifiedErrorId"))
}

pub struct OperationFailure {
    pub operation: &'static str,
    status: Status,
    detail: &'static str,
    code: &'static str,
}

pub fn error_evidence(id: &str, text: &str) -> Vec<OperationFailure> {
    if !text.contains(id) {
        return vec![];
    }
    let Some((status, detail, code)) = failure(text) else {
        return vec![];
    };
    let tagged: Vec<_> = OPERATIONS
        .into_iter()
        .filter(|op| text.contains(&format!("VELUM_ACCESS_{id}_{op}_BEGIN")))
        .collect();
    let operations = if tagged.is_empty() {
        OPERATIONS
            .into_iter()
            .filter(|op| {
                text.contains(&format!("VELUM_ACCESS_{id}_{op}_PASS"))
                    || (*op == "known_file_read" && text.contains("known.txt"))
            })
            .collect()
    } else {
        tagged
    };
    operations
        .into_iter()
        .map(|operation| OperationFailure {
            operation,
            status,
            detail,
            code,
        })
        .collect()
}

fn io_error(report: &mut Report, op: &str, error: std::io::Error) {
    report.record(
        op,
        Status::Fail,
        match error.kind() {
            std::io::ErrorKind::PermissionDenied => "Host filesystem access denied.",
            std::io::ErrorKind::NotFound => "Host probe path does not exist.",
            std::io::ErrorKind::AlreadyExists => {
                "Exclusive probe creation refused an existing path."
            }
            _ => "Host filesystem operation failed.",
        },
        Some(format!("{:?}/os={:?}", error.kind(), error.raw_os_error())),
        None,
    );
}

fn exclusive(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()
}

/// Own a fresh fixture directory and a unique target directly in the workspace.
/// A host-created subdirectory may have different sandbox ACLs from its parent;
/// putting the write target inside it would not test workspace-root creation.
/// Never recurse on cleanup or follow a replacement symlink.
pub struct Probe {
    pub report: Report,
    pub id: String,
    root: PathBuf,
    workspace: PathBuf,
    known: PathBuf,
    target: PathBuf,
    owned: bool,
    agy_last_probe: Option<(u64, Vec<usize>)>,
}
impl Probe {
    pub fn prepare(workspace: &Path, environment: String, yolo: bool, revision: u64) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let root = workspace.join(format!(".velum-access-{id}"));
        let known = root.join("known.txt");
        let target = workspace.join(format!(".velum-access-{id}.probe.txt"));
        let report = Report::untested(workspace, environment, yolo, revision);
        let mut probe = Self {
            report,
            id,
            root,
            workspace: workspace.into(),
            known,
            target,
            owned: false,
            agy_last_probe: None,
        };
        for c in &mut probe.report.checks {
            c.path = match c.operation.as_str() {
                "directory_listing" => &probe.workspace,
                "known_file_read" => &probe.known,
                _ => &probe.target,
            }
            .display()
            .to_string();
        }
        match fs::create_dir(&probe.root) {
            Ok(()) => {
                probe.owned = true;
                if exclusive(&probe.known, probe.marker("known_file_read").as_bytes()).is_err() {
                    probe.report.checks[1].detail =
                        "Host could not seed the known probe file; agent read remains untested."
                            .into();
                }
            }
            Err(_) => {
                for check in &mut probe.report.checks[1..] {
                    check.detail = "Host could not prepare an exclusive probe directory. Agent access is untested.".into();
                }
            }
        }
        probe
    }
    fn marker(&self, op: &str) -> String {
        format!("VELUM_ACCESS_{}_{op}_PASS", self.id)
    }
    fn quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    }
    pub fn prompt(&self, provider: Provider) -> String {
        let workspace = Self::quote(&self.workspace);
        let known = Self::quote(&self.known);
        let target = Self::quote(&self.target);
        let marker = self.marker("directory_listing");
        let cleanup = self.marker("cleanup");
        let relative = format!(".velum-access-{}.probe.txt", self.id);
        let verified_read = |path: &str, op: &str, newline: bool| {
            let marker = self.marker(op);
            let expected = if newline {
                format!("\"{marker}`n\"")
            } else {
                format!("'{marker}'")
            };
            format!("if ([System.IO.File]::ReadAllText({path}) -cne {expected}) {{ throw 'ProbeContentMismatch' }}; Write-Output '{marker}'")
        };
        let mut prompt = format!("Run this Velum workspace access check through your actual tools, under the CURRENT permission policy. Do not escalate, change permissions, inspect other files, load skills, or use external connections. Do not treat host preparation or your final answer as proof of access. Execute each operation separately. Do not combine writes, reads or cleanup in one shell command. Continue independent checks after failures. Report policy denials honestly. Do not manufacture marker output.\n1. Directory listing, PowerShell: Get-ChildItem -LiteralPath {workspace} -Force -ErrorAction Stop | Measure-Object | Out-Null; Write-Output '{marker}'\n");
        if !self.owned {
            prompt.push_str("The host could not reserve a fresh probe directory. Run ONLY directory listing; all other checks are untested.\n");
            return prompt;
        }
        if provider != Provider::Codex {
            // Providers without structured patch events use one filesystem
            // operation per shell call and emit evidence only after completion.
            let command = |op: &str, body: String| {
                format!("Write-Output 'VELUM_ACCESS_{}_{op}_BEGIN'; $ErrorActionPreference='Stop'; {body}", self.id)
            };
            let read = command(
                "known_file_read",
                verified_read(&known, "known_file_read", false),
            );
            let create = command("file_creation", format!("$f=[System.IO.File]::Open({target},[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write); try {{ $b=[System.Text.Encoding]::UTF8.GetBytes('{}'); $f.Write($b,0,$b.Length); $f.Flush() }} finally {{ $f.Dispose() }}; Write-Output '{}'", self.marker("file_creation"), self.marker("file_creation")));
            let edit = command("file_editing", format!("$f=[System.IO.File]::Open({target},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Write); try {{ $f.SetLength(0); $b=[System.Text.Encoding]::UTF8.GetBytes('{}'); $f.Write($b,0,$b.Length); $f.Flush() }} finally {{ $f.Dispose() }}; Write-Output '{}'", self.marker("read_back"), self.marker("file_editing")));
            let read_back = command("read_back", verified_read(&target, "read_back", false));
            let cleanup = command("cleanup", format!("Remove-Item -LiteralPath {target} -ErrorAction Stop; if (Test-Path -LiteralPath {target} -ErrorAction Stop) {{ throw 'ProbeStillExists' }}; Write-Output '{}'", self.marker("cleanup")));
            prompt.push_str(&format!("Execute these PowerShell commands in separate tool calls, exactly as supplied. Keep markers in actual tool output.\n2. Known-file read: {read}\n3. Exclusive creation: {create}\n4. Editing (only if creation succeeded): {edit}\n5. Read-back: {read_back}\n6. Cleanup (always attempt if creation succeeded): {cleanup}\nThe host removes its known.txt and the empty probe directory separately. Do not touch other paths. Do not request escalation.\n"));
            return prompt;
        }
        prompt.push_str(&format!("2. Known-file read, PowerShell: {}\n3. Use your native file-editing tool (Codex: apply_patch) to CREATE the new relative file {relative} directly in the selected workspace, containing exactly {} and one LF newline. Refuse creation if it exists. Do not move this probe into a subdirectory: that would test different access.\n4. In a SEPARATE file-editing call, EDIT only that newly created file: replace the creation marker with {} and one LF newline. If creation failed, leave editing, read-back and cleanup untested.\n5. Verify exact read-back in a SEPARATE PowerShell call: {}\n6. Always attempt cleanup if creation succeeded: use a separate file-editing call to DELETE only {relative}. Then a separate PowerShell call: if (Test-Path -LiteralPath {target} -ErrorAction Stop) {{ throw 'ProbeStillExists' }}; Write-Output '{cleanup}'\nThe host will clean its seeded known.txt and empty probe directory separately. Touch no existing user files. Do not delete any other paths. Finish with a brief factual summary.\n", verified_read(&known, "known_file_read", false), self.marker("file_creation"), self.marker("read_back"), verified_read(&target, "read_back", true)));
        prompt
    }
    pub fn observe_line(&mut self, provider: Provider, line: &str) {
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if provider == Provider::Codex && value["method"] == "item/completed" {
            let mut item = crate::codex_control::normalize_item(&value["params"]["item"]);
            if let Some(changes) = item["changes"].as_array_mut() {
                for change in changes {
                    if let Some(kind) = change["kind"]["type"].as_str().map(str::to_owned) {
                        change["kind"] = Value::String(kind);
                    }
                }
            }
            value = serde_json::json!({"type":"item.completed","item":item});
        }
        match provider {
            Provider::Codex if value["type"] == "item.completed" => {
                let item = &value["item"];
                if item["type"] == "command_execution" {
                    self.output(
                        item["aggregated_output"].as_str().unwrap_or(""),
                        item["command"].as_str().unwrap_or(""),
                        item["exit_code"].as_i64(),
                    );
                } else if item["type"] == "file_change" {
                    if let Some(changes) = item["changes"].as_array() {
                        for change in changes {
                            let path = PathBuf::from(change["path"].as_str().unwrap_or(""));
                            let absolute = if path.is_absolute() {
                                path
                            } else {
                                self.workspace.join(path)
                            };
                            if absolute != self.target {
                                continue;
                            }
                            let op = match change["kind"].as_str() {
                                Some("add") => "file_creation",
                                Some("update") => "file_editing",
                                Some("delete") => "cleanup",
                                _ => continue,
                            };
                            if item["status"] == "completed" {
                                if op != "cleanup" {
                                    self.report.record(op, Status::Pass, "Provider file-editing tool completed this change to the unique probe.", None, None);
                                } // Cleanup also requires an agent absence check.
                            } else {
                                let error = item["error"].to_string();
                                let (status, detail, code) = failure(&error).unwrap_or((
                                    Status::Fail,
                                    "Provider file-editing tool failed. Its event supplied no recognized filesystem or policy error; the cause is unclassified.",
                                    "tool_failure",
                                ));
                                self.report
                                    .record(op, status, detail, Some(code.into()), None);
                            }
                        }
                    }
                }
            }
            Provider::Muse
                if value["payload_type"] == "tool.result"
                    || (value["method"] == "item/completed"
                        && value["params"]["item"]["kind"] == "toolCall") =>
            {
                let text = if value["method"] == "item/completed" {
                    value["params"]["item"]["visibleOutput"]
                        .as_str()
                        .unwrap_or("")
                } else {
                    value["payload"]["text"].as_str().unwrap_or("")
                };
                // Muse's managed PowerShell tool wraps actual output in JSON.
                // An echoed command is never execution evidence.
                if let Ok(result) = serde_json::from_str::<Value>(text) {
                    if let Some(output) = result["output"].as_str() {
                        self.output(
                            output,
                            result["command"].as_str().unwrap_or(""),
                            result["exit_code"].as_i64(),
                        );
                    }
                } else {
                    self.output(text, "", None);
                }
            }
            Provider::Antigravity
                if value["event"] == "step_update"
                    && value["step_update"]["step_type"] == "tool" =>
            {
                let step = &value["step_update"];
                let info = &step["tool_info"];
                let command = info["parameters"]["CommandLine"].as_str();
                if let Some(index) = step["step_index"].as_u64() {
                    let newer = self
                        .agy_last_probe
                        .as_ref()
                        .is_none_or(|(last, _)| index > *last);
                    if newer
                        || (command.is_some()
                            && self
                                .agy_last_probe
                                .as_ref()
                                .is_some_and(|(last, _)| index == *last))
                    {
                        let operations = OPERATIONS
                            .iter()
                            .enumerate()
                            .filter_map(|(i, op)| {
                                let cmd = command.unwrap_or("");
                                (step["tool_name"] == "run_command"
                                    && (cmd
                                        .contains(&format!("VELUM_ACCESS_{}_{op}_BEGIN", self.id))
                                        || (["directory_listing", "cleanup"].contains(op)
                                            && cmd.contains(&self.marker(op)))))
                                .then_some(i)
                            })
                            .collect();
                        self.agy_last_probe = Some((index, operations));
                    }
                }
                if !matches!(step["state"].as_str(), Some("DONE" | "ERROR")) {
                    return;
                }
                let error = info["error"]["message"]
                    .as_str()
                    .or_else(|| info["error"].as_str());
                self.output(
                    error.unwrap_or_else(|| info["output"].as_str().unwrap_or("")),
                    info["parameters"]["CommandLine"].as_str().unwrap_or(""),
                    info["exit_code"].as_i64(),
                );
            }
            Provider::Antigravity
                if value["event"] == "result"
                    && value["result"]["denied_actions"]
                        .as_array()
                        .is_some_and(|actions| {
                            actions.iter().any(|a| a["action"] == "command")
                        }) =>
            {
                self.permission_denied();
            }
            _ => {} // Assistant text, echoed commands and process exit are not evidence.
        }
    }
    pub fn permission_denied(&mut self) {
        let Some((_, operations)) = self.agy_last_probe.take() else {
            return;
        };
        for index in operations {
            let check = &self.report.checks[index];
            if check.status == Status::Untested
                || check.error_code.as_deref() == Some("missing_evidence")
            {
                self.report.record(OPERATIONS[index], Status::Blocked,
                    "Antigravity rejected the pending command under its headless permission policy.",
                    Some("provider_policy".into()), None);
            }
        }
    }
    pub fn output(&mut self, output: &str, command: &str, exit: Option<i64>) {
        for op in OPERATIONS {
            let marker = self.marker(op);
            let passed = output.lines().any(|line| line.trim() == marker);
            let relevant = passed
                || output
                    .lines()
                    .any(|line| line.trim() == format!("VELUM_ACCESS_{}_{op}_BEGIN", self.id))
                || (["directory_listing", "cleanup"].contains(&op) && command.contains(&marker))
                || command.contains(&format!("VELUM_ACCESS_{}_{op}_BEGIN", self.id))
                || (op == "known_file_read"
                    && command.contains(&self.id)
                    && command.contains("known.txt"))
                || (op == "read_back"
                    && command.contains(&self.id)
                    && (command.contains("Get-Content") || command.contains("ReadAllText"))
                    && command.contains("probe.txt"));
            if !relevant {
                continue;
            }
            if let Some((status, detail, code)) = failure(output) {
                self.report
                    .record(op, status, detail, Some(code.into()), exit);
            } else if exit.is_some_and(|n| n != 0) {
                self.report.record(
                    op,
                    Status::Fail,
                    "Provider command failed.",
                    Some("command_exit".into()),
                    exit,
                );
            } else if passed {
                self.report.record(
                    op,
                    Status::Pass,
                    "Expected probe evidence observed in provider tool output.",
                    None,
                    exit,
                );
            } else {
                self.report.record(
                    op,
                    Status::Fail,
                    "Tool ran without the expected probe evidence.",
                    Some("missing_evidence".into()),
                    exit,
                );
            }
        }
    }
    #[cfg(test)]
    pub fn observe_error(&mut self, text: &str) {
        for evidence in error_evidence(&self.id, text) {
            self.record_failure(&evidence);
        }
    }
    pub fn record_failure(&mut self, evidence: &OperationFailure) {
        self.report.record(
            evidence.operation,
            evidence.status,
            evidence.detail,
            Some(evidence.code.into()),
            None,
        );
    }
    pub fn finish(&mut self) -> Report {
        self.report.running = false;
        self.report.checked_at = crate::automation::now();
        // A host absence check can contradict provider cleanup, never establish it.
        if self.report.checks[5].status == Status::Pass && self.target.exists() {
            self.report.record(
                "cleanup",
                Status::Fail,
                "Provider reported cleanup, but the host still sees the probe.",
                Some("probe_remaining".into()),
                None,
            );
        }
        self.cleanup();
        self.report.clone()
    }
    fn cleanup(&mut self) {
        if !self.owned {
            return;
        }
        let result = (|| -> std::io::Result<()> {
            let meta = fs::symlink_metadata(&self.root)?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(std::io::Error::other("probe directory replaced"));
            }
            // Only the unique workspace target and our reserved fixture; no recursion.
            for file in [&self.target, &self.known] {
                match fs::remove_file(file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            fs::remove_dir(&self.root)
        })();
        self.report.host_cleanup = Some(Check {
            operation: "probe_fixture_cleanup".into(), status: if result.is_ok() { Status::Pass } else { Status::Fail },
            path: self.root.display().to_string(), checked_at: Some(crate::automation::now()), environment: "Velum host process".into(),
            detail: if result.is_ok() { "Host removed the owned probe fixtures. This is not evidence of agent cleanup." } else { "Host cleanup failed. Inspect the reported probe directory; no recursive removal was attempted." }.into(),
            error_code: result.as_ref().err().map(|e| format!("{:?}/os={:?}", e.kind(), e.raw_os_error())), exit_code: None,
        });
        if result.is_ok() {
            self.owned = false;
        }
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub fn host_probe(path: &Path, write: bool) -> Report {
    let mut report = Report::untested(path, "Velum host process".into(), false, 0);
    match fs::read_dir(path).and_then(|entries| {
        for e in entries {
            e?;
        }
        Ok(())
    }) {
        Ok(()) => report.record(
            "directory_listing",
            Status::Pass,
            "Host enumerated the selected directory.",
            None,
            None,
        ),
        Err(e) => io_error(&mut report, "directory_listing", e),
    }
    if !write {
        return report;
    }
    let mut probe = Probe::prepare(path, "Velum host process".into(), false, 0);
    probe.report.checks[0] = report.checks[0].clone();
    if !probe.owned {
        return probe.finish();
    }
    let known = fs::read(&probe.known).and_then(|bytes| {
        if bytes == probe.marker("known_file_read").as_bytes() {
            Ok(())
        } else {
            Err(std::io::Error::other("mismatch"))
        }
    });
    match known {
        Ok(()) => probe.report.record(
            "known_file_read",
            Status::Pass,
            "Host read the known fixture and checked its contents.",
            None,
            None,
        ),
        Err(e) => io_error(&mut probe.report, "known_file_read", e),
    }
    let created = exclusive(&probe.target, b"probe-one");
    let owned_target = created.is_ok();
    match created {
        Ok(()) => probe.report.record(
            "file_creation",
            Status::Pass,
            "Host exclusively created the probe.",
            None,
            None,
        ),
        Err(e) => io_error(&mut probe.report, "file_creation", e),
    }
    if owned_target {
        let edit = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&probe.target)
            .and_then(|mut f| f.write_all(b"probe-two"));
        match edit {
            Ok(()) => probe.report.record(
                "file_editing",
                Status::Pass,
                "Host edited the owned probe.",
                None,
                None,
            ),
            Err(e) => io_error(&mut probe.report, "file_editing", e),
        }
        let read = fs::read(&probe.target).and_then(|s| {
            if s == b"probe-two" {
                Ok(())
            } else {
                Err(std::io::Error::other("mismatch"))
            }
        });
        match read {
            Ok(()) => probe.report.record(
                "read_back",
                Status::Pass,
                "Host verified the edited bytes.",
                None,
                None,
            ),
            Err(e) => io_error(&mut probe.report, "read_back", e),
        }
        match fs::remove_file(&probe.target) {
            Ok(()) => probe.report.record(
                "cleanup",
                Status::Pass,
                "Host removed the probe file.",
                None,
                None,
            ),
            Err(e) => io_error(&mut probe.report, "cleanup", e),
        }
    }
    probe.finish()
}

/// Export only the known schema. Replace paths structurally; no raw output,
/// identities, environment variables or provider configuration are exported.
pub fn sanitized(report: &Report) -> Value {
    fn path_alias(path: &str, suffix: &str) -> String {
        // The generated probe basename is safe to share and lets a user find a
        // failed cleanup without disclosing their username or project name.
        if let Some(name) = Path::new(path).file_name().and_then(|n| n.to_str()) {
            if name
                .strip_prefix(".velum-access-")
                .and_then(|n| n.strip_suffix(".probe.txt"))
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            {
                return format!("<selected-project>/{name}");
            }
        }
        let probe = Path::new(path)
            .ancestors()
            .filter_map(|p| p.file_name()?.to_str())
            .find(|name| {
                name.strip_prefix(".velum-access-")
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            })
            .unwrap_or("<unique-probe>");
        format!("<selected-project>/{probe}{suffix}")
    }
    let mut value = serde_json::to_value(report).unwrap_or(Value::Null);
    if let Some(checks) = value["checks"].as_array_mut() {
        for check in checks {
            let path = check["path"].as_str().unwrap_or("");
            check["path"] = json!(match check["operation"].as_str() {
                Some("directory_listing") => "<selected-project>".into(),
                Some("known_file_read") => path_alias(path, "/known.txt"),
                _ => path_alias(path, "/probe.txt"),
            });
        }
    }
    if value["host_cleanup"].is_object() {
        value["host_cleanup"]["path"] = json!(path_alias(
            value["host_cleanup"]["path"].as_str().unwrap_or(""),
            ""
        ));
    }
    value
}

/// Read only the active Codex thread's permission metadata, never export log
/// text. CLI flags are requests; managed policy may change effective settings.
pub fn codex_restrictions(session: &str) -> Value {
    if uuid::Uuid::parse_str(session).is_err() {
        return json!({"status":"untested","detail":"Provider has not returned a session ID."});
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::pty::home_dir().join(".codex"));
    let suffix = format!("-{session}.jsonl");
    fn find(root: &Path, suffix: &str, depth: usize, budget: &mut usize) -> Option<PathBuf> {
        for entry in fs::read_dir(root).ok()?.flatten() {
            if *budget == 0 {
                return None;
            }
            *budget -= 1;
            let kind = entry.file_type().ok()?;
            if kind.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
                return Some(entry.path());
            }
            if kind.is_dir() && depth > 0 {
                if let Some(p) = find(&entry.path(), suffix, depth - 1, budget) {
                    return Some(p);
                }
            }
        }
        None
    }
    let untested = json!({"status":"untested","detail":"Effective restrictions could not be read from active provider metadata; launch flags alone do not prove them."});
    let Some(path) = find(&home.join("sessions"), &suffix, 3, &mut 30000) else {
        return untested;
    };
    let Ok(file) = fs::File::open(path) else {
        return untested;
    };
    if file
        .metadata()
        .map(|m| m.len() > 32 * 1024 * 1024)
        .unwrap_or(true)
    {
        return untested;
    }

    use std::io::BufRead;
    let mut latest = None;
    for line in std::io::BufReader::new(file.take(32 * 1024 * 1024))
        .lines()
        .map_while(Result::ok)
    {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if v["type"] == "turn_context" {
                let p = &v["payload"];
                let sandbox = p["sandbox_policy"]["type"].as_str().filter(|s| {
                    [
                        "read-only",
                        "workspace-write",
                        "danger-full-access",
                        "external-sandbox",
                    ]
                    .contains(s)
                });
                let approval = p["approval_policy"]
                    .as_str()
                    .filter(|s| ["never", "on-request", "on-failure", "untrusted"].contains(s));
                latest = Some(
                    json!({"status":"pass","source":"active Codex turn_context metadata","checked_at":crate::automation::now(),"sandbox":sandbox,"approval_policy":approval,"network_access":p["sandbox_policy"]["network_access"].as_bool(),"file_system":p["permission_profile"]["file_system"]["type"].as_str().filter(|s| ["restricted","unrestricted"].contains(s)),"network":p["permission_profile"]["network"].as_str().filter(|s| ["restricted","enabled","disabled"].contains(s))}),
                );
            }
        }
    }
    latest.unwrap_or(untested)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!("velum access ' & {}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }
    fn agent(root: &Path) -> Probe {
        Probe::prepare(root, "Codex agent tools".into(), false, 1)
    }
    #[test]
    fn agy_stderr_only_denial_attributes_the_pending_probe_without_overwriting_evidence() {
        let root = workspace();
        for output in ["", "pass", "Access is denied. UnauthorizedAccessException"] {
            let mut probe = agent(&root);
            let marker = probe.marker("directory_listing");
            let output = if output == "pass" {
                marker.clone()
            } else {
                output.into()
            };
            let command = format!("Get-ChildItem .; Write-Output '{marker}'");
            probe.observe_line(Provider::Antigravity,&json!({"event":"step_update","step_update":{"step_index":8,"step_type":"tool","tool_name":"run_command","state":"DONE","tool_info":{"parameters":{"CommandLine":command},"output":output}}}).to_string());
            probe.permission_denied();
            let check = &probe.report.checks[0];
            if output.is_empty() {
                assert_eq!(check.status, Status::Blocked);
                assert_eq!(check.error_code.as_deref(), Some("provider_policy"));
            } else if output == marker {
                assert_eq!(check.status, Status::Pass);
            } else {
                assert_eq!(check.error_code.as_deref(), Some("access_denied"));
            }
            assert!(probe.report.checks[1..]
                .iter()
                .all(|c| c.status == Status::Untested));
            probe.finish();
        }
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn an_unrelated_later_command_denial_does_not_relabel_an_earlier_probe() {
        let root = workspace();
        let mut probe = agent(&root);
        let command = format!(
            "Get-ChildItem .; Write-Output '{}'",
            probe.marker("directory_listing")
        );
        for (index, command) in [(1, command), (2, "unrelated command".into())] {
            probe.observe_line(Provider::Antigravity,&json!({"event":"step_update","step_update":{"step_index":index,"step_type":"tool","tool_name":"run_command","state":"DONE","tool_info":{"parameters":{"CommandLine":command}}}}).to_string());
        }
        probe.permission_denied();
        assert_eq!(
            probe.report.checks[0].error_code.as_deref(),
            Some("missing_evidence")
        );
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn muse_managed_shell_json_is_unwrapped_without_trusting_echoed_commands() {
        let root = workspace();
        let mut probe = agent(&root);
        for op in OPERATIONS {
            let marker = probe.marker(op);
            let result = json!({"chunk_id":"exec-1-1","command":format!("Write-Output '{marker}'"),"output":format!("{marker}\r\n"),"exit_code":0,"terminal_status":"completed"});
            probe.observe_line(
                Provider::Muse,
                &json!({"payload_type":"tool.result","payload":{"text":result.to_string()}})
                    .to_string(),
            );
        }
        assert!(probe.report.checks.iter().all(|c| c.status == Status::Pass));
        let marker = probe.marker("directory_listing");
        let result = json!({"command":format!("Write-Output '{marker}'"),"output":"Access is denied. UnauthorizedAccessException","exit_code":0});
        probe.observe_line(
            Provider::Muse,
            &json!({"payload_type":"tool.result","payload":{"text":result.to_string()}})
                .to_string(),
        );
        assert_eq!(probe.report.checks[0].status, Status::Fail);
        assert_eq!(
            probe.report.checks[0].error_code.as_deref(),
            Some("access_denied")
        );
        assert_eq!(probe.report.checks[0].exit_code, Some(0));
        let result =
            json!({"command":format!("Write-Output '{marker}'"),"output":"","exit_code":0});
        probe.observe_line(
            Provider::Muse,
            &json!({"payload_type":"tool.result","payload":{"text":result.to_string()}})
                .to_string(),
        );
        assert_eq!(probe.report.checks[0].status, Status::Fail);
        assert_eq!(
            probe.report.checks[0].error_code.as_deref(),
            Some("missing_evidence")
        );
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn blocked_provider_operations_are_attributed_without_executing_dependents() {
        let root = workspace();
        let mut probe = agent(&root);
        let command = format!(
            "Get-ChildItem .; Write-Output '{}'",
            probe.marker("directory_listing")
        );
        probe.observe_line(Provider::Antigravity, &json!({"event":"step_update","step_update":{"step_type":"tool","state":"ERROR","tool_info":{"parameters":{"CommandLine":command},"error":{"message":"permission check failed: user denied permission to run command"}}}}).to_string());
        assert_eq!(probe.report.checks[0].status, Status::Blocked);
        assert_eq!(
            probe.report.checks[0].error_code.as_deref(),
            Some("provider_policy")
        );
        assert!(probe.report.checks[1..]
            .iter()
            .all(|c| c.status == Status::Untested));
        let result = json!({"command":format!("Write-Output 'VELUM_ACCESS_{}_file_creation_BEGIN'; create probe", probe.id),"output":"rejected: blocked by policy","exit_code":null});
        probe.observe_line(
            Provider::Muse,
            &json!({"payload_type":"tool.result","payload":{"text":result.to_string()}})
                .to_string(),
        );
        assert_eq!(probe.report.checks[2].status, Status::Blocked);
        assert!(probe.report.checks[3..]
            .iter()
            .all(|c| c.status == Status::Untested));
        let report = probe.finish();
        assert_eq!(report.host_cleanup.unwrap().status, Status::Pass);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn muse_edit_payload_does_not_count_as_read_back_evidence() {
        let root = workspace();
        let mut probe = agent(&root);
        let command = format!("Write-Output 'VELUM_ACCESS_{}_file_editing_BEGIN'; Set-Content probe.txt '{}'; Write-Output '{}'", probe.id, probe.marker("read_back"), probe.marker("file_editing"));
        let result = json!({"command":command,"output":probe.marker("file_editing"),"exit_code":0});
        probe.observe_line(
            Provider::Muse,
            &json!({"payload_type":"tool.result","payload":{"text":result.to_string()}})
                .to_string(),
        );
        assert_eq!(probe.report.checks[3].status, Status::Pass);
        assert_eq!(probe.report.checks[4].status, Status::Untested);
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn write_probe_tests_selected_directory_not_host_created_child() {
        let root = workspace();
        let mut probe = agent(&root);
        assert_eq!(probe.target.parent(), Some(root.as_path()));
        assert!(!probe.target.exists());
        assert!(probe.known.exists());
        assert_ne!(probe.target.parent(), probe.known.parent());
        let report = sanitized(&probe.report);
        assert_eq!(
            report["checks"][2]["path"],
            format!("<selected-project>/.velum-access-{}.probe.txt", probe.id)
        );
        probe.finish();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn profile_root_requires_a_project_only_for_standard_codex() {
        let home = crate::pty::home_dir();
        for path in [home.clone(), home.join("."), home.join(".codex/..")] {
            assert!(project_required(&path, Provider::Codex, false));
            assert!(!project_required(&path, Provider::Codex, true));
            assert!(!project_required(&path, Provider::Muse, false));
            assert!(!project_required(&path, Provider::Muse, true));
            assert!(!project_required(&path, Provider::Antigravity, false));
            assert!(!project_required(&path, Provider::Antigravity, true));
        }
        let root = workspace();
        for provider in [Provider::Muse, Provider::Codex, Provider::Antigravity] {
            assert!(!project_required(&root, provider, false));
            assert!(!project_required(&root, provider, true));
        }
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn filesystem_denial_and_policy_rejection_are_distinct() {
        assert_eq!(
            failure("rejected: blocked by policy").unwrap().0,
            Status::Blocked
        );
        let (status, _, code) =
            failure("New-Item : Access to the path is denied. UnauthorizedAccessException")
                .unwrap();
        assert_eq!(status, Status::Fail);
        assert_eq!(code, "access_denied");
    }
    #[test]
    fn host_pass_never_establishes_agent_pass() {
        let root = workspace();
        let host = host_probe(&root, true);
        assert!(host.checks.iter().all(|c| c.status == Status::Pass));
        let mut probe = agent(&root);
        let command = format!("Write-Output '{}'", probe.marker("directory_listing"));
        probe.output(
            "Access is denied. UnauthorizedAccessException",
            &command,
            Some(0),
        );
        assert_eq!(probe.report.checks[0].status, Status::Fail);
        assert!(probe.report.checks[1..]
            .iter()
            .all(|c| c.status == Status::Untested));
        assert_eq!(host.checks[0].status, Status::Pass);
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn powershell_errors_override_success_marker_and_exit_zero() {
        let root = workspace();
        let mut probe = agent(&root);
        let output = format!("CategoryInfo : PermissionDenied\nFullyQualifiedErrorId : UnauthorizedAccessException\n{}", probe.marker("directory_listing"));
        probe.output(&output, "", Some(0));
        assert_eq!(probe.report.checks[0].status, Status::Fail);
        assert_eq!(probe.report.checks[0].exit_code, Some(0));
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn real_powershell_nonterminating_error_exits_zero() {
        use std::os::windows::process::CommandExt;
        let root = workspace();
        let missing = root.join("missing");
        let output = std::process::Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-ChildItem -LiteralPath {}; Write-Output 'continued'",
                    Probe::quote(&missing)
                ),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(failure(&String::from_utf8_lossy(&output.stderr)).is_some());
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn blocked_writes_are_not_success_and_cleanup_is_separate() {
        let root = workspace();
        let mut probe = agent(&root);
        probe.observe_error(&format!(
            "{} rejected: blocked by policy; token=PRIVATE",
            probe.marker("file_creation")
        ));
        let report = probe.finish();
        assert_eq!(report.checks[2].status, Status::Blocked);
        assert_eq!(report.checks[3].status, Status::Untested);
        assert_eq!(report.checks[5].status, Status::Untested);
        assert_eq!(report.host_cleanup.unwrap().status, Status::Pass);
        assert!(!sanitized(&probe.report).to_string().contains("PRIVATE"));
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn claims_echoed_commands_and_wrong_nonce_do_not_pass() {
        let root = workspace();
        let mut probe = agent(&root);
        let marker = probe.marker("directory_listing");
        probe.observe_line(
            Provider::Codex,
            &json!({"type":"item.completed","item":{"type":"agent_message","text":marker}})
                .to_string(),
        );
        probe.observe_line(
            Provider::Codex,
            &json!({"type":"item.started","item":{"type":"command_execution","command":marker}})
                .to_string(),
        );
        assert_eq!(probe.report.checks[0].status, Status::Untested);
        probe.output("VELUM_ACCESS_other_directory_listing_PASS", "", Some(0));
        assert_eq!(probe.report.checks[0].status, Status::Untested);
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn probe_cleanup_on_abort_preserves_existing_files() {
        let root = workspace();
        let existing = root.join("user.txt");
        fs::write(&existing, "PRIVATE").unwrap();
        let target;
        {
            let probe = agent(&root);
            target = probe.target.clone();
            fs::write(&target, "probe").unwrap();
        }
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(&existing).unwrap(), "PRIVATE");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(existing).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn cleanup_failure_is_reported_without_recursive_deletion() {
        let root = workspace();
        let mut probe = agent(&root);
        let unexpected = probe.root.join("unowned.txt");
        fs::write(&unexpected, "user data").unwrap();
        let report = probe.finish();
        assert_eq!(report.host_cleanup.unwrap().status, Status::Fail);
        assert!(unexpected.exists());
        fs::remove_file(unexpected).unwrap();
        drop(probe);
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn failed_patch_without_error_does_not_invent_permission_or_policy_denial() {
        let root = workspace();
        let mut probe = agent(&root);
        let event = json!({"type":"item.completed","item":{"type":"file_change","changes":[{"path":probe.target,"kind":"add"}],"status":"failed"}});
        probe.observe_line(Provider::Codex, &event.to_string());
        assert_eq!(probe.report.checks[2].status, Status::Fail);
        assert_eq!(
            probe.report.checks[2].error_code.as_deref(),
            Some("tool_failure")
        );
        assert!(probe.report.checks[3..]
            .iter()
            .all(|c| c.status == Status::Untested));
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn successful_file_change_and_readback_are_distinct_evidence() {
        let root = workspace();
        let mut probe = agent(&root);
        let event = json!({"type":"item.completed","item":{"type":"file_change","changes":[{"path":probe.target,"kind":"add"}],"status":"completed"}});
        probe.observe_line(Provider::Codex, &event.to_string());
        assert_eq!(probe.report.checks[2].status, Status::Pass);
        assert_eq!(probe.report.checks[4].status, Status::Untested);
        let read = probe.marker("read_back");
        probe.output(&read, "", Some(0));
        assert_eq!(probe.report.checks[4].status, Status::Pass);
        probe.report.invalidate(2, true);
        assert!(probe
            .report
            .checks
            .iter()
            .all(|c| c.status == Status::Untested && c.checked_at.is_none()));
        assert!(probe
            .report
            .checks
            .iter()
            .all(|c| !c.detail.contains("Run checks again")
                && c.detail.contains("only an explicit Test agent access turn")));
        assert_eq!(probe.report.permission_mode, "yolo");
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn report_export_omits_paths_and_commands() {
        let root = workspace();
        let mut probe = agent(&root);
        probe.observe_error(&format!(
            "{} rejected token=SECRET",
            probe.marker("cleanup")
        ));
        let report = probe.finish();
        let text = sanitized(&report).to_string();
        assert!(!text.contains(&root.display().to_string()));
        assert!(text.contains(&format!(".velum-access-{}", probe.id)));
        assert!(!text.contains("SECRET"));
        assert!(text.contains("<selected-project>"));
        assert!(probe.prompt(Provider::Codex).contains("'' &"));
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn tagged_failure_does_not_mark_an_embedded_readback_marker_as_executed() {
        let root = workspace();
        let mut probe = agent(&root);
        probe.observe_error(&format!(
            "VELUM_ACCESS_{}_file_editing_BEGIN {} rejected: blocked by policy",
            probe.id,
            probe.marker("read_back")
        ));
        assert_eq!(probe.report.checks[3].status, Status::Blocked);
        assert_eq!(probe.report.checks[4].status, Status::Untested);
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn generated_readback_rejects_extra_bytes_even_when_marker_is_present() {
        use std::os::windows::process::CommandExt;
        let root = workspace();
        let mut probe = agent(&root);
        fs::write(
            &probe.target,
            format!("{}\nUNEXPECTED", probe.marker("read_back")),
        )
        .unwrap();
        let prompt = probe.prompt(Provider::Codex);
        let command = prompt
            .lines()
            .find(|l| l.starts_with("5."))
            .unwrap()
            .split_once(": ")
            .unwrap()
            .1;
        let result = std::process::Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-Command", command])
            .output()
            .unwrap();
        probe.output(
            &format!(
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            ),
            command,
            result.status.code().map(i64::from),
        );
        assert_eq!(probe.report.checks[4].status, Status::Fail);
        probe.finish();
        fs::remove_dir(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn generated_shell_operations_use_literal_paths_and_clean_their_probe() {
        use std::os::windows::process::CommandExt;
        for provider in [Provider::Muse, Provider::Antigravity] {
            let root = workspace();
            let mut probe = agent(&root);
            let prompt = probe.prompt(provider);
            for line in prompt
                .lines()
                .filter(|line| line.starts_with(|c: char| c.is_ascii_digit()))
            {
                let command = line.split_once(": ").unwrap().1;
                let result = std::process::Command::new("powershell.exe")
                    .creation_flags(0x08000000)
                    .args(["-NoProfile", "-Command", command])
                    .output()
                    .unwrap();
                let output = format!(
                    "{}{}",
                    String::from_utf8_lossy(&result.stdout),
                    String::from_utf8_lossy(&result.stderr)
                );
                let event = if provider == Provider::Muse {
                    json!({"payload_type":"tool.result","payload":{"text":output}})
                } else {
                    json!({"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_info":{"output":output,"exit_code":result.status.code()}}})
                };
                probe.observe_line(provider, &event.to_string());
            }
            assert!(
                probe.report.checks.iter().all(|c| c.status == Status::Pass),
                "{:?}",
                probe.report.checks
            );
            probe.finish();
            fs::remove_dir(root).unwrap();
        }
    }
}
