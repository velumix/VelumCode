//! Claude Code's SDK host protocol over the child process's private stdio.
//! Velum sends the turn as a stream-json user message and answers Claude's
//! permission prompts and questions from chat. Claude Code keeps its own
//! sign-in, session storage and tools; this client never handles credentials.
use crate::{
    events::AgentEvent,
    interactions::{self, Broker},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
    process::ChildStdin,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

/// Host control requests must be confirmed within this window.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(60);
/// One stream-json line, including base64 image blocks.
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
/// Raw image size accepted as an inline content block (base64 stays < 5 MB).
const MAX_IMAGE_BYTES: u64 = 3_750_000;
const MAX_IMAGES: usize = 8;
const MAX_DETAILS_CHARS: usize = 100_000;
const INITIALIZE: &str = "velum_initialize";

/// An image sent to Claude as a content block instead of a path to read.
#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub media_type: &'static str,
    pub data: String,
}

pub struct Client {
    writer: Option<mpsc::SyncSender<Vec<u8>>>,
    errors: mpsc::Receiver<String>,
    controls: mpsc::Receiver<interactions::Command>,
    pub broker: Arc<Broker>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub denied: bool,
    completed: bool,
    pending: HashMap<String, Instant>,
    requests: HashMap<String, Value>,
    /// Tool calls the user declined with guidance: Claude continues with
    /// that guidance, so the turn is not reported as blocked.
    steered: HashSet<String>,
    stream: crate::provider_events::Stream,
}

struct Reply {
    payload: Value,
    label: String,
    denied: bool,
    steered: Option<String>,
}

fn key(request_id: &str) -> String {
    format!("claude:{request_id}")
}

fn choice(
    id: &str,
    label: &str,
    scope: &str,
    decision: &str,
    accepts_feedback: bool,
    rule: Option<Value>,
) -> interactions::Choice {
    interactions::Choice {
        id: id.into(),
        label: label.into(),
        scope: scope.into(),
        decision: decision.into(),
        accepts_feedback,
        rule,
    }
}

fn bounded(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut kept: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        kept.push_str("\n…[truncated]");
    }
    kept
}

fn user_message(prompt: &str, images: &[Image]) -> Value {
    let mut content: Vec<Value> = images
        .iter()
        .map(|image| {
            json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}})
        })
        .collect();
    content.push(json!({"type":"text","text":prompt}));
    json!({"type":"user","message":{"role":"user","content":content},"parent_tool_use_id":null,"session_id":""})
}

/// A one-click broader grant Claude suggested with this permission prompt.
/// Mode switches that remove all prompts are never offered from a card.
fn suggestion_choice(index: usize, suggestion: &Value) -> Option<interactions::Choice> {
    let scope = match suggestion["destination"].as_str().unwrap_or("session") {
        "session" => "session",
        "localSettings" => "localPersistent",
        "projectSettings" => "projectPersistent",
        "userSettings" => "userPersistent",
        _ => return None,
    };
    let (label, rule) = match suggestion["type"].as_str()? {
        "setMode" => (
            match suggestion["mode"].as_str()? {
                "acceptEdits" => "Allow all file edits".to_owned(),
                "plan" => "Switch to plan mode".to_owned(),
                "default" => "Ask before each action".to_owned(),
                _ => return None,
            },
            None,
        ),
        "addRules" if suggestion["behavior"] == "allow" => {
            let rules: Vec<String> = suggestion["rules"]
                .as_array()?
                .iter()
                .take(4)
                .filter_map(|rule| {
                    let tool = rule["toolName"].as_str().filter(|t| !t.is_empty())?;
                    Some(
                        match rule["ruleContent"].as_str().filter(|c| !c.is_empty()) {
                            Some(content) => format!("{tool}({content})"),
                            None => tool.to_owned(),
                        },
                    )
                })
                .collect();
            if rules.is_empty() {
                return None;
            }
            (
                format!("Always allow {}", rules.join(", ")),
                Some(suggestion.clone()),
            )
        }
        "addDirectories" => {
            let directories: Vec<&str> = suggestion["directories"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .take(3)
                .collect();
            if directories.is_empty() {
                return None;
            }
            (
                format!("Allow access to {}", directories.join(", ")),
                Some(suggestion.clone()),
            )
        }
        _ => return None,
    };
    let label = match scope {
        "session" => format!("{label} for this session"),
        "localPersistent" => format!("{label} in this project"),
        "projectPersistent" => format!("{label} for everyone on this project"),
        _ => format!("{label} in all projects"),
    };
    Some(choice(
        &format!("suggestion{index}"),
        &label,
        scope,
        "approved",
        false,
        rule,
    ))
}

/// A reviewable description of the requested action. The first line is a
/// JSON summary the approval card reads; the rest is the full proposal.
fn approval_details(tool: &str, request: &Value) -> String {
    let input = &request["input"];
    let string = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let path = ["file_path", "notebook_path", "path"]
        .iter()
        .find_map(|key| input[*key].as_str())
        .unwrap_or_default();
    let mut summary = json!({});
    if let Some(command) = input["command"].as_str() {
        summary["command"] = json!(command);
    }
    if !path.is_empty() {
        summary["path"] = json!(path);
    }
    let description = [
        &input["description"],
        &request["title"],
        &request["description"],
    ]
    .into_iter()
    .map(string)
    .find(|text| !text.is_empty());
    if let Some(description) = description {
        summary["description"] = json!(description);
    }
    if let Some(reason) = request["decision_reason"]
        .as_str()
        .filter(|r| !r.is_empty())
    {
        summary["reason"] = json!(reason);
    }
    let body = match tool {
        "Bash" | "PowerShell" => format!("$ {}", string(&input["command"])),
        "Edit" => {
            let mut lines = vec![format!(
                "Edit {path}{}",
                if input["replace_all"] == true {
                    " (every occurrence)"
                } else {
                    ""
                }
            )];
            lines.extend(
                string(&input["old_string"])
                    .lines()
                    .map(|l| format!("- {l}")),
            );
            lines.extend(
                string(&input["new_string"])
                    .lines()
                    .map(|l| format!("+ {l}")),
            );
            lines.join("\n")
        }
        "Write" => {
            let content = string(&input["content"]);
            format!(
                "Write {path} ({} lines)\n\n{content}",
                content.lines().count()
            )
        }
        "WebFetch" => format!(
            "Fetch {}\n\n{}",
            string(&input["url"]),
            string(&input["prompt"])
        ),
        "ExitPlanMode" => string(&input["plan"]),
        _ => serde_json::to_string_pretty(input).unwrap_or_default(),
    };
    let mut details = summary.to_string();
    if let Some(path) = request["blocked_path"].as_str().filter(|p| !p.is_empty()) {
        details.push_str(&format!("\n\nOutside the allowed folders: {path}"));
    }
    details.push_str("\n\n");
    details.push_str(&body);
    bounded(&details, MAX_DETAILS_CHARS)
}

impl Client {
    pub fn new(
        input: ChildStdin,
        broker: Arc<Broker>,
        controls: mpsc::Receiver<interactions::Command>,
        prompt: &str,
        images: &[Image],
    ) -> Result<Self, String> {
        let (writer, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
        let (error_tx, errors) = mpsc::channel();
        std::thread::spawn(move || {
            let mut input = input;
            for bytes in receiver {
                if let Err(error) = input.write_all(&bytes).and_then(|_| input.flush()) {
                    let _ = error_tx.send(format!("Claude Code's control input closed: {error}"));
                    break;
                }
            }
        });
        let mut client = Self::with_writer(writer, errors, broker, controls);
        client.start(prompt, images)?;
        Ok(client)
    }

    fn with_writer(
        writer: mpsc::SyncSender<Vec<u8>>,
        errors: mpsc::Receiver<String>,
        broker: Arc<Broker>,
        controls: mpsc::Receiver<interactions::Command>,
    ) -> Self {
        Self {
            writer: Some(writer),
            errors,
            controls,
            broker,
            session_id: None,
            run_id: None,
            denied: false,
            completed: false,
            pending: HashMap::new(),
            requests: HashMap::new(),
            steered: HashSet::new(),
            stream: crate::provider_events::Stream::new(crate::providers::Provider::Claude),
        }
    }

    fn start(&mut self, prompt: &str, images: &[Image]) -> Result<(), String> {
        self.write(&json!({"type":"control_request","request_id":INITIALIZE,"request":{"subtype":"initialize","hooks":null}}))?;
        self.pending.insert(INITIALIZE.into(), Instant::now());
        self.write(&user_message(prompt, images))
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(
                "This message is too large for Claude Code. Remove an attachment and retry.".into(),
            );
        }
        bytes.push(b'\n');
        self.writer
            .as_ref()
            .ok_or("Claude Code's connection has closed.")?
            .try_send(bytes)
            .map_err(|_| "Claude Code's control input is unavailable or backpressured.".into())
    }

    fn reply(&self, request_id: &str, payload: Value) -> Result<(), String> {
        self.write(&json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":payload}}))
    }

    fn reject(&self, request_id: &str, error: &str) -> Result<(), String> {
        self.write(&json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error}}))
    }

    pub fn settling(&self) -> bool {
        self.completed && !self.broker.waiting() && self.pending.is_empty()
    }

    pub fn poll(&mut self) -> Result<(), String> {
        if let Ok(error) = self.errors.try_recv() {
            // Claude may exit right after its result; that is not a failure.
            if !self.completed {
                return Err(error);
            }
        }
        if self
            .pending
            .values()
            .any(|since| since.elapsed() > CONTROL_TIMEOUT)
        {
            return Err("Claude Code did not confirm Velum's control connection within 60 seconds. Update Claude Code with `claude update`, then retry.".into());
        }
        while let Ok(command) = self.controls.try_recv() {
            let reply = Self::decision(&command)?;
            let request_id = command.binding["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let mut sent = false;
            let broker = self.broker.clone();
            broker.dispatch(&command, || {
                self.reply(&request_id, reply.payload.clone())?;
                sent = true;
                Ok(())
            })?;
            if sent {
                self.denied |= reply.denied;
                self.steered.extend(reply.steered);
                self.requests.remove(&command.decision.id);
                broker.settle(
                    &command.decision.id,
                    "resolved",
                    Some(format!("Sent to Claude: {}.", reply.label)),
                );
            }
        }
        if self.settling() {
            self.writer.take();
        }
        Ok(())
    }

    fn decision(command: &interactions::Command) -> Result<Reply, String> {
        let decision = &command.decision;
        let binding = &command.binding;
        if binding["kind"] == "question" {
            if decision.cancel {
                return Ok(Reply {
                    payload: json!({"behavior":"deny","message":"The user chose not to answer. Continue without these answers, or ask in chat."}),
                    label: "declined to answer".into(),
                    denied: false,
                    steered: None,
                });
            }
            let mut answers = serde_json::Map::new();
            for answer in &decision.answers {
                let question = binding["questions"][&answer.question_id]
                    .as_str()
                    .ok_or("That question is no longer available.")?;
                let value = answer
                    .text
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| answer.selected.join(", "));
                answers.insert(question.into(), json!(value));
            }
            let mut input = binding["input"].clone();
            input["answers"] = Value::Object(answers);
            return Ok(Reply {
                payload: json!({"behavior":"allow","updatedInput":input}),
                label: "answered".into(),
                denied: false,
                steered: None,
            });
        }
        let id = decision
            .choice_id
            .as_deref()
            .ok_or("Choose one of the offered permission decisions.")?;
        let mut payload = binding["responses"]
            .get(id)
            .cloned()
            .ok_or("That Claude decision is no longer available.")?;
        let guidance = decision
            .feedback
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let mut steered = None;
        if payload["behavior"] == "deny" && payload["interrupt"] != true {
            if let Some(guidance) = guidance {
                payload["message"] = json!(format!(
                    "The user declined this action and said: {guidance}"
                ));
                steered = binding["toolUseId"].as_str().map(str::to_owned);
            }
        }
        Ok(Reply {
            denied: payload["behavior"] == "deny" && steered.is_none(),
            label: binding["labels"][id].as_str().unwrap_or(id).to_owned(),
            payload,
            steered,
        })
    }

    pub fn observe_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, String> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Ok(vec![]);
        };
        match value["type"].as_str().unwrap_or_default() {
            "control_request" => self.request(&value),
            "control_response" => {
                self.response(&value["response"])?;
                Ok(vec![])
            }
            "control_cancel_request" => {
                if let Some(id) = value["request_id"].as_str() {
                    let key = key(id);
                    if self.requests.remove(&key).is_some() {
                        self.broker.settle(
                            &key,
                            "expired",
                            Some("Claude Code withdrew this request.".into()),
                        );
                    }
                }
                Ok(vec![])
            }
            kind => {
                let result = kind == "result";
                let denials: Vec<String> = value["permission_denials"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|denial| {
                        denial["tool_use_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned()
                    })
                    .collect();
                let mut events = self.stream.fold_value(value);
                if self.stream.session_id.is_some() {
                    self.session_id.clone_from(&self.stream.session_id);
                }
                if result {
                    self.completed = true;
                    // Declining with guidance redirects Claude; it is not a block.
                    if !denials.is_empty() && denials.iter().all(|id| self.steered.contains(id)) {
                        for event in &mut events {
                            if let AgentEvent::TurnEnd { status, .. } = event {
                                if status == "blocked" {
                                    *status = "completed".into();
                                }
                            }
                        }
                    }
                }
                Ok(events)
            }
        }
    }

    fn response(&mut self, response: &Value) -> Result<(), String> {
        let Some(id) = response["request_id"].as_str() else {
            return Ok(());
        };
        if self.pending.remove(id).is_none() {
            return Ok(());
        }
        if response["subtype"] == "error" {
            return Err(format!(
                "Claude Code rejected Velum's control connection: {}. Update Claude Code with `claude update`, then retry.",
                bounded(response["error"].as_str().unwrap_or("unknown error"), 400)
            ));
        }
        Ok(())
    }

    fn request(&mut self, value: &Value) -> Result<Vec<AgentEvent>, String> {
        let Some(request_id) = value["request_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200)
        else {
            return Err("Claude Code sent an invalid control request identity.".into());
        };
        let request = &value["request"];
        let subtype = request["subtype"].as_str().unwrap_or_default();
        if subtype != "can_use_tool" {
            // Velum registers no hooks or in-process MCP servers.
            self.reject(
                request_id,
                &format!("Velum does not support the `{subtype}` control request."),
            )?;
            return Ok(vec![]);
        }
        if self.completed {
            self.reject(request_id, "This Velum turn has ended.")?;
            return Err(
                "Claude Code requested permission after the turn ended. No permission was granted."
                    .into(),
            );
        }
        let tool = request["tool_name"].as_str().unwrap_or_default();
        if tool.is_empty() || !request["input"].is_object() {
            self.reject(request_id, "The permission request named no tool input.")?;
            return Ok(vec![]);
        }
        let key = key(request_id);
        let subagent = request["agent_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty());
        let mut binding = json!({"requestId":request_id,"toolUseId":request["tool_use_id"],"input":request["input"]});
        let presented = if tool == "AskUserQuestion" {
            self.question(&key, request, &mut binding, subagent)
        } else {
            self.approval(&key, tool, request, &mut binding, subagent)
        };
        if let Err(error) = presented {
            // Keep the turn alive: Claude reads the denial and can continue.
            self.reply(
                request_id,
                json!({"behavior":"deny","message":format!("Velum could not show this request to the user: {error}")}),
            )?;
            return Ok(vec![AgentEvent::Notice {
                text: format!("Claude asked for something Velum could not display, so it was declined: {error}"),
            }]);
        }
        self.requests.insert(key, binding);
        Ok(vec![])
    }

    fn question(
        &self,
        key: &str,
        request: &Value,
        binding: &mut Value,
        subagent: bool,
    ) -> Result<(), String> {
        let mut questions = vec![];
        let mut texts = serde_json::Map::new();
        for (index, question) in request["input"]["questions"]
            .as_array()
            .ok_or("the question list is missing")?
            .iter()
            .enumerate()
            .take(16)
        {
            let id = format!("q{index}");
            let text = question["question"].as_str().unwrap_or_default();
            let options: Vec<interactions::QuestionOption> = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|option| interactions::QuestionOption {
                    label: option["label"].as_str().unwrap_or_default().into(),
                    description: option["description"].as_str().unwrap_or_default().into(),
                })
                .collect();
            let multiple = question["multiSelect"] == true;
            texts.insert(id.clone(), json!(text));
            questions.push(interactions::Question {
                id,
                header: question["header"].as_str().unwrap_or_default().into(),
                question: text.into(),
                min: 1,
                max: if multiple { options.len().max(1) } else { 1 },
                // Claude always lets the user answer in their own words.
                free_text: true,
                options,
                multiple,
                secret: false,
            });
        }
        if questions.is_empty() {
            return Err("the question list is empty".into());
        }
        binding["kind"] = json!("question");
        binding["questions"] = Value::Object(texts);
        self.broker.present(
            interactions::Request {
                id: key.into(),
                revision: 0,
                kind: "question".into(),
                title: if subagent {
                    "Subagent: Your answer is needed".into()
                } else {
                    "Your answer is needed".into()
                },
                tool: "AskUserQuestion".into(),
                details: String::new(),
                choices: vec![],
                questions,
                status: "pending".into(),
                message: None,
                source: None,
            },
            binding.clone(),
        )
    }

    fn approval(
        &self,
        key: &str,
        tool: &str,
        request: &Value,
        binding: &mut Value,
        subagent: bool,
    ) -> Result<(), String> {
        let input = request["input"].clone();
        let plan = tool == "ExitPlanMode";
        let mut choices = vec![choice(
            "allow",
            if plan { "Approve plan" } else { "Allow once" },
            "once",
            "approved",
            false,
            None,
        )];
        let mut responses = json!({"allow":{"behavior":"allow","updatedInput":input}});
        for (index, suggestion) in request["permission_suggestions"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .take(4)
        {
            if let Some(offered) = suggestion_choice(index, suggestion) {
                responses[&offered.id] = json!({"behavior":"allow","updatedInput":input,"updatedPermissions":[suggestion]});
                choices.push(offered);
            }
        }
        choices.push(choice(
            "deny",
            if plan { "Keep planning" } else { "Deny" },
            "once",
            "denied",
            true,
            None,
        ));
        let declined = if plan {
            "The user wants to keep planning before you start."
        } else {
            "The user denied this action."
        };
        responses["deny"] = json!({"behavior":"deny","message":declined});
        choices.push(choice(
            "stop",
            "Deny and stop",
            "once",
            "cancelled",
            false,
            None,
        ));
        responses["stop"] = json!({"behavior":"deny","message":"The user denied this action and stopped the turn.","interrupt":true});
        let labels: serde_json::Map<String, Value> = choices
            .iter()
            .map(|choice| (choice.id.clone(), json!(choice.label)))
            .collect();
        let title = match tool {
            "ExitPlanMode" => "Plan ready for review",
            "Bash" | "PowerShell" => "Command permission required",
            "Edit" | "Write" | "NotebookEdit" => "Review file changes",
            "WebFetch" | "WebSearch" => "Network permission required",
            _ => "Permission required",
        };
        binding["kind"] = json!("approval");
        binding["responses"] = responses;
        binding["labels"] = Value::Object(labels);
        self.broker.present(
            interactions::Request {
                id: key.into(),
                revision: 0,
                kind: "approval".into(),
                title: if subagent {
                    format!("Subagent: {title}")
                } else {
                    title.into()
                },
                tool: request["display_name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .unwrap_or(tool)
                    .into(),
                details: approval_details(tool, request),
                choices,
                questions: vec![],
                status: "pending".into(),
                message: None,
                source: None,
            },
            binding.clone(),
        )
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.broker.close("The Claude Code connection has ended.");
    }
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Images the desktop composer attached to this prompt. The composer saves
/// each image under the project's `.attachments` folder (or Velum's temporary
/// attachment folder) and names it in an `[Attached image: … (file:///…)]`
/// tag. Only those folders are read; other, oversized or unsupported files
/// stay path references the model can open with its own tools.
pub fn attachments(prompt: &str, workspace: &Path) -> (Vec<Image>, Vec<String>) {
    let roots: Vec<_> = [
        workspace.join(".attachments"),
        std::env::temp_dir().join("velum-code-attachments"),
    ]
    .iter()
    .filter_map(|root| std::fs::canonicalize(root).ok())
    .collect();
    let mut images = vec![];
    let mut skipped = vec![];
    let mut rest = prompt;
    while let Some(start) = rest.find("[Attached image: ") {
        rest = &rest[start..];
        let Some(end) = rest.find(']') else {
            break;
        };
        let tag = &rest[..end];
        rest = &rest[end..];
        let Some(path) = tag
            .split_once("(file:///")
            .map(|(_, path)| path.trim_end_matches(')'))
        else {
            continue;
        };
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());
        if images.len() >= MAX_IMAGES {
            skipped.push(format!("{name} (only {MAX_IMAGES} images per message)"));
            continue;
        }
        let media_type = match Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            _ => {
                skipped.push(format!("{name} (unsupported image type)"));
                continue;
            }
        };
        let Ok(file) = std::fs::canonicalize(path) else {
            skipped.push(format!("{name} (file not found)"));
            continue;
        };
        if !roots.iter().any(|root| file.starts_with(root)) {
            skipped.push(format!("{name} (outside Velum's attachment folders)"));
            continue;
        }
        match std::fs::metadata(&file) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_IMAGE_BYTES => {}
            Ok(meta) if meta.is_file() => {
                skipped.push(format!("{name} (larger than 3.75 MB)"));
                continue;
            }
            _ => {
                skipped.push(format!("{name} (not a readable file)"));
                continue;
            }
        }
        match std::fs::read(&file) {
            Ok(bytes) => images.push(Image {
                media_type,
                data: encode_base64(&bytes),
            }),
            Err(_) => skipped.push(format!("{name} (could not be read)")),
        }
    }
    (images, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> (Client, mpsc::Receiver<Vec<u8>>) {
        let (broker, controls) = Broker::new("generation".into());
        let (writer, output) = mpsc::sync_channel(16);
        let (_, errors) = mpsc::channel();
        (
            Client::with_writer(writer, errors, broker, controls),
            output,
        )
    }
    fn wire(output: &mpsc::Receiver<Vec<u8>>) -> Value {
        serde_json::from_slice(&output.try_recv().unwrap()).unwrap()
    }
    fn respond(client: &Client, extra: Value) -> Result<interactions::Snapshot, String> {
        let s = client.broker.snapshot();
        let r = s.requests.last().unwrap();
        let mut decision = json!({"generation":s.generation,"id":r.id,"revision":r.revision});
        for (k, v) in extra.as_object().unwrap() {
            decision[k] = v.clone();
        }
        client
            .broker
            .respond(serde_json::from_value(decision).unwrap(), "test")
    }
    // Shapes captured from Claude Code 2.1.302 with --permission-prompt-tool stdio.
    const WRITE: &str = r#"{"type":"control_request","request_id":"482be2c6-7954-4e63-9007-9ee72c224b07","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"C:\\work\\probe.txt","content":"Blue"},"description":"probe.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_019JsfAHZgJi83E2DHJYNaB7"}}"#;
    const QUESTION: &str = r#"{"type":"control_request","request_id":"649a4273-1400-4a86-a996-80cbcf544162","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"Choose red"},{"label":"Blue","description":"Choose blue"}],"multiSelect":false}]},"tool_use_id":"toolu_01LLSZHoCFkd5rjExSsLUuKH","requires_user_interaction":true}}"#;

    #[test]
    fn start_initializes_then_sends_text_and_image_blocks() {
        let (mut client, output) = peer();
        let image = Image {
            media_type: "image/png",
            data: "iVBORw0KGgo=".into(),
        };
        client.start("Describe this", &[image]).unwrap();
        assert_eq!(
            wire(&output),
            json!({"type":"control_request","request_id":INITIALIZE,"request":{"subtype":"initialize","hooks":null}})
        );
        let message = wire(&output);
        assert_eq!(message["type"], "user");
        assert_eq!(message["message"]["role"], "user");
        assert_eq!(message["message"]["content"][0]["type"], "image");
        assert_eq!(
            message["message"]["content"][0]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            message["message"]["content"][1],
            json!({"type":"text","text":"Describe this"})
        );
        // The turn cannot settle before Claude confirms the control connection.
        client.completed = true;
        assert!(!client.settling());
        client
            .observe_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"velum_initialize","response":{"commands":[]}}}"#)
            .unwrap();
        assert!(client.settling());
    }

    #[test]
    fn rejected_initialize_explains_the_update_path() {
        let (mut client, _output) = peer();
        client.pending.insert(INITIALIZE.into(), Instant::now());
        let error = client
            .observe_line(r#"{"type":"control_response","response":{"subtype":"error","request_id":"velum_initialize","error":"unknown subtype"}}"#)
            .unwrap_err();
        assert!(error.contains("claude update"), "{error}");
    }

    #[test]
    fn write_approval_offers_once_session_deny_and_stop() {
        let (mut client, output) = peer();
        assert!(client.observe_line(WRITE).unwrap().is_empty());
        let snapshot = client.broker.snapshot();
        let request = &snapshot.requests[0];
        assert_eq!(request.kind, "approval");
        assert_eq!(request.title, "Review file changes");
        assert!(request.details.starts_with('{'));
        let summary: Value = serde_json::from_str(request.details.lines().next().unwrap()).unwrap();
        assert_eq!(summary["path"], "C:\\work\\probe.txt");
        let ids: Vec<_> = request.choices.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["allow", "suggestion0", "deny", "stop"]);
        assert_eq!(
            request.choices[1].label,
            "Allow all file edits for this session"
        );
        assert_eq!(request.choices[1].scope, "session");
        assert!(client.broker.waiting());
        assert!(output.try_recv().is_err());

        respond(&client, json!({"choice_id":"suggestion0"})).unwrap();
        client.poll().unwrap();
        assert_eq!(
            wire(&output),
            json!({"type":"control_response","response":{"subtype":"success","request_id":"482be2c6-7954-4e63-9007-9ee72c224b07","response":{"behavior":"allow","updatedInput":{"file_path":"C:\\work\\probe.txt","content":"Blue"},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}})
        );
        assert!(!client.broker.waiting());
        assert_eq!(client.broker.snapshot().requests[0].status, "resolved");
        assert!(!client.denied);
    }

    #[test]
    fn denial_with_guidance_steers_without_blocking_the_turn() {
        let (mut client, output) = peer();
        client.observe_line(WRITE).unwrap();
        respond(
            &client,
            json!({"choice_id":"deny","feedback":"Use notes.txt instead"}),
        )
        .unwrap();
        client.poll().unwrap();
        let sent = wire(&output);
        assert_eq!(sent["response"]["response"]["behavior"], "deny");
        assert!(sent["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .contains("Use notes.txt instead"));
        assert!(!client.denied);
        let events = client
            .observe_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"Wrote notes.txt instead.","session_id":"b05ec622-63bf-4dc7-9ac8-5aa88b9093e7","permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_019JsfAHZgJi83E2DHJYNaB7","tool_input":{}}]}"#)
            .unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnEnd { status, .. } if status == "completed")));
    }

    #[test]
    fn plain_denial_and_stop_mark_the_turn_denied() {
        for (choice, interrupt) in [("deny", Value::Null), ("stop", json!(true))] {
            let (mut client, output) = peer();
            client.observe_line(WRITE).unwrap();
            respond(&client, json!({"choice_id":choice})).unwrap();
            client.poll().unwrap();
            let sent = wire(&output);
            assert_eq!(sent["response"]["response"]["behavior"], "deny");
            assert_eq!(sent["response"]["response"]["interrupt"], interrupt);
            assert!(client.denied);
        }
    }

    #[test]
    fn questions_answer_through_updated_input() {
        let (mut client, output) = peer();
        client.observe_line(QUESTION).unwrap();
        let snapshot = client.broker.snapshot();
        let request = &snapshot.requests[0];
        assert_eq!(request.kind, "question");
        assert_eq!(request.questions[0].options.len(), 2);
        assert!(request.questions[0].free_text);
        respond(
            &client,
            json!({"answers":[{"question_id":"q0","selected":["Blue"]}]}),
        )
        .unwrap();
        client.poll().unwrap();
        let sent = wire(&output);
        assert_eq!(
            sent["response"]["request_id"],
            "649a4273-1400-4a86-a996-80cbcf544162"
        );
        assert_eq!(sent["response"]["response"]["behavior"], "allow");
        assert_eq!(
            sent["response"]["response"]["updatedInput"]["answers"],
            json!({"Which color do you prefer?":"Blue"})
        );
        assert_eq!(
            sent["response"]["response"]["updatedInput"]["questions"][0]["header"],
            "Color"
        );
    }

    #[test]
    fn declining_a_question_is_not_a_permission_denial() {
        let (mut client, output) = peer();
        client.observe_line(QUESTION).unwrap();
        respond(&client, json!({"cancel":true})).unwrap();
        client.poll().unwrap();
        assert_eq!(wire(&output)["response"]["response"]["behavior"], "deny");
        assert!(!client.denied);
    }

    #[test]
    fn cancelled_requests_expire_and_unsupported_requests_are_rejected() {
        let (mut client, output) = peer();
        client.observe_line(WRITE).unwrap();
        client
            .observe_line(r#"{"type":"control_cancel_request","request_id":"482be2c6-7954-4e63-9007-9ee72c224b07"}"#)
            .unwrap();
        assert_eq!(client.broker.snapshot().requests[0].status, "expired");
        assert!(!client.broker.waiting());
        client
            .observe_line(r#"{"type":"control_request","request_id":"hook-1","request":{"subtype":"hook_callback","callback_id":"hook_0"}}"#)
            .unwrap();
        let sent = wire(&output);
        assert_eq!(sent["response"]["subtype"], "error");
        assert_eq!(sent["response"]["request_id"], "hook-1");
    }

    #[test]
    fn permission_after_completion_is_refused() {
        let (mut client, output) = peer();
        client.completed = true;
        assert!(client.observe_line(WRITE).is_err());
        assert_eq!(wire(&output)["response"]["subtype"], "error");
        assert!(client.broker.snapshot().requests.is_empty());
    }

    #[test]
    fn subagent_requests_are_labelled_and_bypass_modes_never_offered() {
        let (mut client, _output) = peer();
        let line = r#"{"type":"control_request","request_id":"sub-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test","description":"Run tests"},"agent_id":"agent-7","permission_suggestions":[{"type":"setMode","mode":"bypassPermissions","destination":"session"},{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test"}],"behavior":"allow","destination":"localSettings"}],"tool_use_id":"toolu_sub"}}"#;
        client.observe_line(line).unwrap();
        let snapshot = client.broker.snapshot();
        let request = &snapshot.requests[0];
        assert_eq!(request.title, "Subagent: Command permission required");
        let labels: Vec<_> = request.choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Allow once",
                "Always allow Bash(npm test) in this project",
                "Deny",
                "Deny and stop"
            ]
        );
        assert_eq!(request.choices[1].scope, "localPersistent");
        assert!(request.choices[1].rule.is_some());
        let summary: Value = serde_json::from_str(request.details.lines().next().unwrap()).unwrap();
        assert_eq!(summary["command"], "npm test");
        assert_eq!(summary["description"], "Run tests");
    }

    #[test]
    fn stream_events_fold_and_completion_settles_and_closes_input() {
        let (mut client, _output) = peer();
        let events = client
            .observe_line(r#"{"type":"system","subtype":"init","session_id":"8c85e3f8-d20b-49ad-89f0-2efc8b8506bc","model":"claude-haiku-5-5"}"#)
            .unwrap();
        assert!(matches!(&events[0], AgentEvent::Activity { .. }));
        assert_eq!(
            client.session_id.as_deref(),
            Some("8c85e3f8-d20b-49ad-89f0-2efc8b8506bc")
        );
        assert!(!client.settling());
        let events = client
            .observe_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"8c85e3f8-d20b-49ad-89f0-2efc8b8506bc","permission_denials":[]}"#)
            .unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnEnd { status, .. } if status == "completed")));
        assert!(client.settling());
        client.poll().unwrap();
        assert!(client.writer.is_none());
    }

    #[test]
    fn base64_round_trips_through_the_runner_decoder() {
        for sample in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            let encoded = encode_base64(sample);
            if sample.is_empty() {
                assert!(encoded.is_empty());
                continue;
            }
            assert_eq!(crate::runner::decode_base64(&encoded).unwrap(), sample);
        }
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn attachments_read_only_velum_folders_and_supported_images() {
        let workspace =
            std::env::temp_dir().join(format!("velum-claude-attach-{}", uuid::Uuid::new_v4()));
        let folder = workspace.join(".attachments");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("shot.png"), b"png-bytes").unwrap();
        std::fs::write(folder.join("notes.txt"), b"text").unwrap();
        std::fs::write(workspace.join("outside.png"), b"png-bytes").unwrap();
        let url = |path: std::path::PathBuf| {
            format!("file:///{}", path.display().to_string().replace('\\', "/"))
        };
        let prompt = format!(
            "[Attached image: .attachments/shot.png ({})]\n[Attached image: .attachments/notes.txt ({})]\n[Attached image: outside.png ({})]\n\nWhat is this?",
            url(folder.join("shot.png")),
            url(folder.join("notes.txt")),
            url(workspace.join("outside.png"))
        );
        let (images, skipped) = attachments(&prompt, &workspace);
        assert_eq!(
            images,
            vec![Image {
                media_type: "image/png",
                data: encode_base64(b"png-bytes")
            }]
        );
        assert_eq!(skipped.len(), 2);
        assert!(skipped[0].contains("unsupported"));
        assert!(skipped[1].contains("outside"));
        std::fs::remove_dir_all(workspace).unwrap();
    }
}
