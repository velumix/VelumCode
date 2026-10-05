//! Codex app-server v2 over the child process's private stdio connection.
use crate::{
    events::AgentEvent,
    interactions::{self, Broker},
    provider_models::RunOptions,
    provider_usage::{ContextUsage, TurnUsage},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    process::ChildStdin,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

enum Pending {
    Initialize,
    Open,
    Turn,
}

pub struct Client {
    writer: Option<mpsc::SyncSender<Vec<u8>>>,
    errors: mpsc::Receiver<String>,
    controls: mpsc::Receiver<interactions::Command>,
    pub broker: Arc<Broker>,
    pending: HashMap<u64, (Pending, Instant)>,
    next_id: u64,
    resume: String,
    workspace: String,
    prompt: String,
    options: RunOptions,
    yolo: bool,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub denied: bool,
    pub effective: Option<Value>,
    completed: bool,
    owned_threads: HashSet<String>,
    requests: HashMap<String, Value>,
    submitted: HashMap<String, (Instant, String)>,
    items: HashMap<String, Value>,
    text: HashMap<String, String>,
    stream: crate::provider_events::Stream,
    baseline: Option<TurnUsage>,
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn request_key(id: &Value) -> String {
    format!("codex:{id}")
}
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}
fn choice(id: &str, label: &str, scope: &str, decision: &str) -> interactions::Choice {
    interactions::Choice {
        id: id.into(),
        label: label.into(),
        scope: scope.into(),
        decision: decision.into(),
        accepts_feedback: false,
        rule: None,
    }
}

impl Client {
    // Mirrors the Muse constructor's positional shape; grouping would hide the parity.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        input: ChildStdin,
        broker: Arc<Broker>,
        controls: mpsc::Receiver<interactions::Command>,
        resume: String,
        workspace: String,
        prompt: String,
        options: RunOptions,
        yolo: bool,
        baseline: Option<TurnUsage>,
    ) -> Result<Self, String> {
        let (writer, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
        let (error_tx, errors) = mpsc::channel();
        std::thread::spawn(move || {
            let mut input = input;
            for bytes in receiver {
                if let Err(error) = input.write_all(&bytes).and_then(|_| input.flush()) {
                    let _ = error_tx.send(format!("Codex's control input closed: {error}"));
                    break;
                }
            }
        });
        let baseline = if resume.is_empty() {
            Some(TurnUsage::zero())
        } else {
            baseline
        };
        let mut client = Self {
            writer: Some(writer),
            errors,
            controls,
            broker,
            pending: HashMap::new(),
            next_id: 0,
            resume,
            workspace,
            prompt,
            options,
            yolo,
            session_id: None,
            run_id: None,
            denied: false,
            effective: None,
            completed: false,
            owned_threads: HashSet::new(),
            requests: HashMap::new(),
            submitted: HashMap::new(),
            items: HashMap::new(),
            text: HashMap::new(),
            stream: crate::provider_events::Stream::new(crate::providers::Provider::Codex),
            baseline,
        };
        client.call("initialize", json!({"clientInfo":{"name":"velum_code","title":"Velum Code","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false,"requestAttestation":false}}), Pending::Initialize)?;
        Ok(client)
    }
    fn write(&self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Codex control request exceeds the transport limit.".into());
        }
        bytes.push(b'\n');
        self.writer
            .as_ref()
            .ok_or("Codex's connection has closed.")?
            .try_send(bytes)
            .map_err(|_| "Codex's control input is unavailable or backpressured.".into())
    }
    fn call(&mut self, method: &str, params: Value, pending: Pending) -> Result<(), String> {
        self.next_id += 1;
        self.write(json!({"id":self.next_id,"method":method,"params":params}))?;
        self.pending.insert(self.next_id, (pending, Instant::now()));
        Ok(())
    }
    pub fn settling(&self) -> bool {
        self.completed && !self.broker.waiting() && self.pending.is_empty()
    }
    pub fn poll(&mut self) -> Result<(), String> {
        if let Ok(error) = self.errors.try_recv() {
            return Err(error);
        }
        if self
            .pending
            .values()
            .any(|(_, since)| since.elapsed() > Duration::from_secs(60))
            || self
                .submitted
                .values()
                .any(|(since, _)| since.elapsed() > Duration::from_secs(60))
        {
            return Err("Codex did not confirm a control request within 60 seconds. The turn was stopped; review partial work before retrying.".into());
        }
        while let Ok(command) = self.controls.try_recv() {
            let decision = &command.decision;
            let binding = &command.binding;
            let result = if let Some(id) = &decision.choice_id {
                binding["responses"]
                    .get(id)
                    .cloned()
                    .ok_or("That Codex decision is no longer available.")?
            } else {
                let mut answers = serde_json::Map::new();
                if !decision.cancel {
                    for answer in &decision.answers {
                        let values = answer
                            .text
                            .as_ref()
                            .map(|text| vec![text.clone()])
                            .unwrap_or_else(|| answer.selected.clone());
                        answers.insert(answer.question_id.clone(), json!({"answers":values}));
                    }
                }
                json!({"answers":answers})
            };
            let label = decision.choice_id.clone().unwrap_or_else(|| {
                if decision.cancel {
                    "declined to answer"
                } else {
                    "answered"
                }
                .into()
            });
            let broker = self.broker.clone();
            broker.dispatch(&command, || {
                self.write(json!({"id":binding["rpcId"],"result":result}))?;
                self.denied |= matches!(label.as_str(), "decline" | "cancel" | "deny");
                self.submitted
                    .insert(decision.id.clone(), (Instant::now(), label));
                Ok(())
            })?;
        }
        if self.settling() {
            self.writer.take();
        }
        Ok(())
    }

    pub fn observe_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, String> {
        let value: Value = serde_json::from_str(line)
            .map_err(|_| "Codex returned invalid JSON on its control connection.")?;
        if let Some(method) = value["method"].as_str() {
            let params = &value["params"];
            if value.get("id").is_some() {
                self.request(&value["id"], method, params)?;
                return Ok(vec![]);
            }
            if method == "thread/started" {
                let thread = &params["thread"];
                if thread["parentThreadId"]
                    .as_str()
                    .is_some_and(|id| self.owned_threads.contains(id))
                {
                    self.owned_threads.insert(string(thread, "id"));
                }
            }
            // Subagent proposed file changes must be reviewable too. Their
            // assistant messages do not enter the parent answer stream.
            if matches!(method, "item/started" | "item/completed")
                && params["threadId"]
                    .as_str()
                    .is_some_and(|id| self.owned_threads.contains(id))
            {
                let id = string(&params["item"], "id");
                if self.items.len() >= 4096 && !self.items.contains_key(&id) {
                    return Err("Codex produced too many items in one turn.".into());
                }
                self.items.insert(id, params["item"].clone());
                if params["item"]["status"] == "declined" {
                    self.denied = true;
                }
            }
            if method == "serverRequest/resolved"
                && params["threadId"]
                    .as_str()
                    .is_some_and(|id| self.owned_threads.contains(id))
            {
                let key = request_key(&params["requestId"]);
                let submitted = self.submitted.remove(&key);
                let previous = self.requests.remove(&key);
                let message = if let Some((_, label)) = submitted {
                    format!("Codex cleared the request after response: {label}.")
                } else {
                    "Codex cleared this request before a response was confirmed.".into()
                };
                let source = self
                    .broker
                    .snapshot()
                    .requests
                    .into_iter()
                    .find(|r| r.id == key)
                    .and_then(|r| r.source)
                    .unwrap_or_else(|| "provider".into());
                self.broker.settle(&key, "resolved", Some(message.clone()));
                return Ok(previous
                    .map(|previous| {
                        vec![AgentEvent::Approval {
                            status: "resolved".into(),
                            tool: previous["method"].as_str().map(str::to_owned),
                            summary: format!("{message} Response from {source}."),
                        }]
                    })
                    .unwrap_or_default());
            }
            if params["threadId"].as_str() != self.session_id.as_deref()
                || self.session_id.is_none()
            {
                return Ok(vec![]);
            }
            if method == "turn/started" {
                let id = string(&params["turn"], "id");
                if self.run_id.is_none() {
                    self.run_id = Some(id);
                }
            }
            if let Some(turn) = params["turnId"].as_str() {
                if self.run_id.as_deref().is_some_and(|id| id != turn) {
                    return Ok(vec![]);
                }
            }
            return self.notification(method, params);
        }
        let Some(id) = value["id"].as_u64() else {
            return Ok(vec![]);
        };
        let Some((pending, _)) = self.pending.remove(&id) else {
            return Ok(vec![]);
        };
        if let Some(error) = value.get("error") {
            return Err(format!(
                "Codex control request failed: {}. Saved conversation history is retained.",
                string(error, "message")
            ));
        }
        let result = &value["result"];
        match pending {
            Pending::Initialize => {
                self.write(json!({"method":"initialized","params":{}}))?;
                let mut params = json!({"cwd":self.workspace,"approvalPolicy":if self.yolo {"never"} else {"on-request"},"approvalsReviewer":"user","sandbox":if self.yolo {"danger-full-access"} else {"workspace-write"}});
                if !self.options.model.is_empty() {
                    params["model"] = json!(self.options.model);
                }
                let method = if self.resume.is_empty() {
                    "thread/start"
                } else {
                    params["threadId"] = json!(self.resume);
                    params["excludeTurns"] = json!(true);
                    "thread/resume"
                };
                self.call(method, params, Pending::Open)?;
            }
            Pending::Open => {
                let id = string(&result["thread"], "id");
                if uuid::Uuid::parse_str(&id).is_err()
                    || (!self.resume.is_empty() && self.resume != id)
                {
                    return Err("Codex returned a different or invalid thread identity.".into());
                }
                if result["thread"]["status"]["type"] == "active" {
                    return Err("Codex restored active work. Stop it in its owning client before continuing here.".into());
                }
                if !self.yolo
                    && (result["approvalPolicy"] != "on-request"
                        || result["approvalsReviewer"] != "user"
                        || result["sandbox"]["type"] != "workspaceWrite")
                {
                    return Err("Codex did not apply the requested interactive permission policy. No turn was started.".into());
                }
                self.session_id = Some(id.clone());
                self.owned_threads.insert(id.clone());
                self.effective = Some(
                    json!({"status":"observed","source":"Codex app-server thread response","approval_policy":result["approvalPolicy"],"approvals_reviewer":result["approvalsReviewer"],"sandbox_policy":result["sandbox"],"cwd":result["cwd"]}),
                );
                let sandbox = if self.yolo {
                    json!({"type":"dangerFullAccess"})
                } else {
                    json!({"type":"workspaceWrite","writableRoots":[self.workspace],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true})
                };
                let mut params = json!({"threadId":id,"input":[{"type":"text","text":self.prompt,"text_elements":[]}],"cwd":self.workspace,"approvalPolicy":if self.yolo {"never"} else {"on-request"},"approvalsReviewer":"user","sandboxPolicy":sandbox});
                if !self.options.model.is_empty() {
                    params["model"] = json!(self.options.model);
                }
                if !self.options.reasoning.is_empty() {
                    params["effort"] = json!(self.options.reasoning);
                }
                self.call("turn/start", params, Pending::Turn)?;
                self.prompt.clear();
            }
            Pending::Turn => {
                let id = string(&result["turn"], "id");
                if id.is_empty() {
                    return Err("Codex did not return a turn identity.".into());
                }
                if self.run_id.as_deref().is_some_and(|current| current != id) {
                    return Err(
                        "Codex started a different turn than its event stream reported.".into(),
                    );
                }
                self.run_id = Some(id);
            }
        }
        Ok(vec![])
    }

    fn request(&mut self, rpc_id: &Value, method: &str, params: &Value) -> Result<(), String> {
        if !rpc_id.is_string() && !rpc_id.is_number() {
            return Err("Codex sent an invalid request identity.".into());
        }
        if !params["threadId"]
            .as_str()
            .is_some_and(|id| self.owned_threads.contains(id))
            || self.completed
            || self.run_id.is_none()
        {
            self.write(json!({"id":rpc_id,"error":{"code":-32600,"message":"The request does not belong to an active Velum turn."}}))?;
            return Err(
                "Codex requested input outside the active conversation. No permission was granted."
                    .into(),
            );
        }
        if params["threadId"].as_str() == self.session_id.as_deref()
            && params["turnId"]
                .as_str()
                .is_some_and(|id| Some(id) != self.run_id.as_deref())
        {
            return Err(
                "Codex sent a request from a different turn. No permission was granted.".into(),
            );
        }
        let key = request_key(rpc_id);
        let mut responses = json!({});
        let mut choices = vec![];
        let mut questions = vec![];
        let mut details = pretty(params);
        let title;
        let kind;
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                if method.contains("fileChange")
                    && !self
                        .items
                        .contains_key(params["itemId"].as_str().unwrap_or_default())
                {
                    return Err("Codex requested file approval without the proposed changes. No permission was granted.".into());
                }
                kind = "approval";
                title = if !params["networkApprovalContext"].is_null() {
                    "Network permission required"
                } else if method.contains("fileChange") {
                    "Review file changes"
                } else {
                    "Command permission required"
                };
                for (id, label, scope, decision) in [
                    ("accept", "Allow once", "once", "approved"),
                    (
                        "acceptForSession",
                        "Allow for this session",
                        "session",
                        "approved",
                    ),
                    ("decline", "Deny", "once", "denied"),
                    ("cancel", "Cancel this turn", "once", "cancelled"),
                ] {
                    // Newer hosts may narrow the fixed v2 decision set.
                    if params["availableDecisions"]
                        .as_array()
                        .is_some_and(|offered| !offered.contains(&json!(id)))
                    {
                        continue;
                    }
                    // grantRoot's session semantics are unstable; offer one action for files.
                    if method.contains("fileChange") && id == "acceptForSession" {
                        continue;
                    }
                    choices.push(choice(id, label, scope, decision));
                    responses[id] = json!({"decision":id});
                }
                if let Some(item) = self
                    .items
                    .get(params["itemId"].as_str().unwrap_or_default())
                {
                    details.push_str("\n\nProposed item:\n");
                    details.push_str(&pretty(item));
                }
            }
            "item/permissions/requestApproval" => {
                kind = "approval";
                title = "Additional permissions requested";
                let mut granted = serde_json::Map::new();
                for field in ["network", "fileSystem"] {
                    if let Some(value) = params["permissions"].get(field).filter(|v| !v.is_null()) {
                        granted.insert(field.into(), value.clone());
                    }
                }
                if granted.is_empty() {
                    return Err("Codex requested an unsupported permission profile. No permission was granted.".into());
                }
                choices = vec![
                    choice(
                        "allow",
                        "Allow requested access for this turn",
                        "turn",
                        "approved",
                    ),
                    choice("deny", "Deny", "once", "denied"),
                ];
                responses = json!({"allow":{"permissions":granted,"scope":"turn"},"deny":{"permissions":{},"scope":"turn"}});
            }
            "item/tool/requestUserInput" => {
                kind = "question";
                title = "Your answer is needed";
                details.clear();
                for question in params["questions"]
                    .as_array()
                    .ok_or("Codex sent an invalid question list.")?
                {
                    let options = question["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|o| interactions::QuestionOption {
                            label: string(o, "label"),
                            description: string(o, "description"),
                        })
                        .collect::<Vec<_>>();
                    questions.push(interactions::Question {
                        id: string(question, "id"),
                        header: string(question, "header"),
                        question: string(question, "question"),
                        free_text: options.is_empty() || question["isOther"] == true,
                        secret: question["isSecret"] == true,
                        options,
                        multiple: false,
                        min: 1,
                        max: 1,
                    });
                }
                if questions.is_empty() {
                    return Err("Codex sent an empty question request.".into());
                }
            }
            "mcpServer/elicitation/request" => {
                // Structured MCP schemas and browser URL flows require their own UI.
                kind = "approval";
                title = "MCP input requires another client";
                choices = vec![
                    choice("decline", "Decline request", "once", "denied"),
                    choice("cancel", "Cancel request", "once", "cancelled"),
                ];
                responses = json!({"decline":{"action":"decline","content":null},"cancel":{"action":"cancel","content":null}});
                details = format!("This MCP server requested a form or browser flow that Velum cannot display yet. Continue in a client that supports it, or decline here.\n\n{details}");
            }
            _ => {
                self.write(json!({"id":rpc_id,"error":{"code":-32601,"message":"Velum does not support this client request."}}))?;
                return Err(format!(
                    "Codex requested unsupported interaction {method}. No permission was granted."
                ));
            }
        }
        if kind == "approval" && choices.is_empty() {
            return Err("Codex offered no supported permission decisions.".into());
        }
        let binding = json!({"rpcId":rpc_id,"method":method,"params":params,"responses":responses});
        let title = if params["threadId"].as_str() == self.session_id.as_deref() {
            title.into()
        } else {
            format!("Subagent: {title}")
        };
        self.broker.present(
            interactions::Request {
                id: key.clone(),
                revision: 0,
                kind: kind.into(),
                title,
                tool: method.into(),
                details,
                choices,
                questions,
                status: "pending".into(),
                message: None,
                source: None,
            },
            binding.clone(),
        )?;
        self.requests.insert(key, binding);
        Ok(())
    }

    fn notification(&mut self, method: &str, params: &Value) -> Result<Vec<AgentEvent>, String> {
        match method {
            "turn/started" => Ok(vec![AgentEvent::Activity {
                text: "Thinking…".into(),
            }]),
            "turn/completed" => {
                if params["turn"]["id"].as_str() != self.run_id.as_deref() {
                    return Ok(vec![]);
                }
                self.completed = true;
                // Completion can clear an unanswered callback; never keep it actionable.
                for request in self.broker.snapshot().requests {
                    if matches!(request.status.as_str(), "pending" | "submitting") {
                        self.denied |= request.kind == "approval";
                        self.broker.settle(
                            &request.id,
                            "expired",
                            Some("Codex ended the turn before confirming this request.".into()),
                        );
                    }
                }
                self.submitted.clear();
                self.requests.clear();
                let status = match params["turn"]["status"].as_str() {
                    Some("completed") => "completed",
                    Some("interrupted") => "cancelled",
                    _ => "failed",
                };
                Ok(vec![AgentEvent::TurnEnd {
                    status: status.into(),
                    text: None,
                    reason: params["turn"]["error"]["message"]
                        .as_str()
                        .map(str::to_owned),
                }])
            }
            "error" => Ok(vec![AgentEvent::Notice {
                text: string(&params["error"], "message"),
            }]),
            "turn/plan/updated" => Ok(vec![AgentEvent::Todos {
                items: params["plan"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(100)
                    .map(|step| crate::events::TodoItem {
                        text: string(step, "step"),
                        status: match step["status"].as_str() {
                            Some("completed") => "completed",
                            Some("inProgress") => "in_progress",
                            _ => "pending",
                        }
                        .into(),
                    })
                    .collect(),
            }]),
            "thread/tokenUsage/updated" => {
                let value = &params["tokenUsage"];
                let total = crate::provider_usage::codex_turn(
                    &json!({"input_tokens":value["total"]["inputTokens"],"cached_input_tokens":value["total"]["cachedInputTokens"],"output_tokens":value["total"]["outputTokens"],"reasoning_output_tokens":value["total"]["reasoningOutputTokens"]}),
                );
                let context = value["last"]["totalTokens"]
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .map(|used_tokens| ContextUsage {
                        used_tokens,
                        window_tokens: value["modelContextWindow"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991),
                        measured_at: chrono::Utc::now().timestamp_millis(),
                        estimated: false,
                    });
                Ok(vec![AgentEvent::Usage {
                    context,
                    turn: total
                        .zip(self.baseline.as_ref())
                        .map(|(total, baseline)| total.since(baseline, 0)),
                }])
            }
            "item/agentMessage/delta" | "item/commandExecution/outputDelta" => {
                let id = string(params, "itemId");
                let delta = string(params, "delta");
                let text = self.text.entry(id.clone()).or_default();
                if text.len().saturating_add(delta.len()) > 1_000_000 {
                    return Err("Codex output exceeded the per-item display limit.".into());
                }
                text.push_str(&delta);
                if method.contains("agentMessage") {
                    Ok(self.stream.fold_line(&json!({"type":"item.updated","item":{"id":id,"type":"agent_message","text":text}}).to_string()))
                } else {
                    let item = self
                        .items
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| json!({"id":id,"type":"commandExecution"}));
                    let mut item = normalize_item(&item);
                    item["aggregated_output"] = json!(text);
                    Ok(self
                        .stream
                        .fold_line(&json!({"type":"item.updated","item":item}).to_string()))
                }
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let id = string(item, "id");
                let kind = string(item, "type");
                let completed = method == "item/completed";
                if self.items.len() >= 4096 && !self.items.contains_key(&id) {
                    return Err(
                        "Codex produced too many items in one turn. Continue in a new turn.".into(),
                    );
                }
                self.items.insert(id.clone(), item.clone());
                if matches!(kind.as_str(), "agentMessage" | "commandExecution") {
                    let content = if kind == "agentMessage" {
                        &item["text"]
                    } else {
                        &item["aggregatedOutput"]
                    };
                    if let Some(text) = content.as_str() {
                        self.text.insert(id, text.into());
                    }
                }
                if item["status"] == "declined" {
                    self.denied = true;
                }
                Ok(self.stream.fold_line(&json!({"type":if completed {"item.completed"} else {"item.started"},"item":normalize_item(item)}).to_string()))
            }
            _ => Ok(vec![]),
        }
    }
}

/// The existing transcript and diagnostics folds consume exec's item vocabulary.
pub fn normalize_item(item: &Value) -> Value {
    let mut result = item.clone();
    result["type"] = json!(match item["type"].as_str().unwrap_or_default() {
        "agentMessage" => "agent_message",
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "mcpToolCall" => "mcp_tool_call",
        "webSearch" => "web_search",
        other => other,
    });
    result["aggregated_output"] = item["aggregatedOutput"].clone();
    result["exit_code"] = item["exitCode"].clone();
    result
}
impl Drop for Client {
    fn drop(&mut self) {
        self.broker.close("The Codex connection has ended.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const THREAD: &str = "11111111-1111-4111-8111-111111111111";
    const TURN: &str = "turn-a";
    fn peer() -> (Client, mpsc::Receiver<Vec<u8>>) {
        let (broker, controls) = Broker::new("generation".into());
        let (writer, output) = mpsc::sync_channel(16);
        let (_, errors) = mpsc::channel();
        (
            Client {
                writer: Some(writer),
                errors,
                controls,
                broker,
                pending: HashMap::new(),
                next_id: 0,
                resume: String::new(),
                workspace: String::new(),
                prompt: String::new(),
                options: RunOptions::default(),
                yolo: false,
                session_id: Some(THREAD.into()),
                run_id: Some(TURN.into()),
                denied: false,
                effective: None,
                completed: false,
                owned_threads: HashSet::from([THREAD.into()]),
                requests: HashMap::new(),
                submitted: HashMap::new(),
                items: HashMap::new(),
                text: HashMap::new(),
                stream: crate::provider_events::Stream::new(crate::providers::Provider::Codex),
                baseline: Some(TurnUsage::zero()),
            },
            output,
        )
    }
    fn params() -> Value {
        json!({"threadId":THREAD,"turnId":TURN,"itemId":"command","command":"echo QA","cwd":"C:\\QA"})
    }
    fn wire(output: &mpsc::Receiver<Vec<u8>>) -> Value {
        serde_json::from_slice(&output.try_recv().unwrap()).unwrap()
    }
    fn respond(
        client: &Client,
        choice: Option<&str>,
        extra: Value,
    ) -> Result<interactions::Snapshot, String> {
        let s = client.broker.snapshot();
        let r = s.requests.last().unwrap();
        let mut decision =
            json!({"generation":s.generation,"id":r.id,"revision":r.revision,"choice_id":choice});
        for (k, v) in extra.as_object().unwrap() {
            decision[k] = v.clone();
        }
        client
            .broker
            .respond(serde_json::from_value(decision).unwrap(), "test")
    }
    #[test]
    fn command_decisions_preserve_numeric_and_string_rpc_ids_until_resolution() {
        for id in [json!(17), json!("callback")] {
            let (mut client, output) = peer();
            client
                .request(&id, "item/commandExecution/requestApproval", &params())
                .unwrap();
            assert!(output.try_recv().is_err());
            respond(&client, Some("accept"), json!({})).unwrap();
            client.poll().unwrap();
            assert_eq!(
                wire(&output),
                json!({"id":id,"result":{"decision":"accept"}})
            );
            assert_eq!(client.broker.snapshot().requests[0].status, "submitting");
            client.observe_line(&json!({"method":"serverRequest/resolved","params":{"threadId":THREAD,"requestId":id}}).to_string()).unwrap();
            assert!(!client.broker.waiting());
            assert_eq!(client.broker.snapshot().requests[0].status, "resolved");
        }
    }
    #[test]
    fn narrowed_decisions_and_denials_do_not_expand_provider_choices() {
        let (mut client, output) = peer();
        let mut p = params();
        p["availableDecisions"] = json!(["decline", "cancel"]);
        client
            .request(&json!(1), "item/commandExecution/requestApproval", &p)
            .unwrap();
        assert!(respond(&client, Some("accept"), json!({})).is_err());
        respond(&client, Some("decline"), json!({})).unwrap();
        client.poll().unwrap();
        assert!(client.denied);
        assert_eq!(wire(&output)["result"]["decision"], "decline");
    }
    #[test]
    fn live_host_cancel_only_rejection_never_invents_a_decline_or_policy_grant() {
        let (mut client, _output) = peer();
        let mut p = params();
        p["availableDecisions"] = json!(["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo"]}},"cancel"]);
        client
            .request(&json!(1), "item/commandExecution/requestApproval", &p)
            .unwrap();
        let s = client.broker.snapshot();
        assert_eq!(
            s.requests[0]
                .choices
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["accept", "cancel"]
        );
        assert!(respond(&client, Some("decline"), json!({})).is_err());
    }
    #[test]
    fn permission_profile_grants_only_requested_access_for_this_turn() {
        for choice in ["allow", "deny"] {
            let (mut client, output) = peer();
            let mut p = params();
            p["permissions"] =
                json!({"network":{"enabled":true},"fileSystem":{"write":["C:\\QA\\marker"]}});
            client
                .request(&json!(4), "item/permissions/requestApproval", &p)
                .unwrap();
            respond(&client, Some(choice), json!({})).unwrap();
            client.poll().unwrap();
            let result = wire(&output)["result"].clone();
            assert_eq!(result["scope"], "turn");
            assert_eq!(
                result["permissions"],
                if choice == "allow" {
                    p["permissions"].clone()
                } else {
                    json!({})
                }
            );
        }
    }
    #[test]
    fn file_approval_requires_reviewable_changes_and_omits_session_grants() {
        let (mut client, _output) = peer();
        assert!(client
            .request(&json!(5), "item/fileChange/requestApproval", &params())
            .is_err());
        client.items.insert(
            "command".into(),
            json!({"type":"fileChange","changes":[{"path":"marker.txt","diff":"+QA"}]}),
        );
        client
            .request(&json!(5), "item/fileChange/requestApproval", &params())
            .unwrap();
        let s = client.broker.snapshot();
        assert!(s.requests[0].details.contains("+QA"));
        assert!(!s.requests[0]
            .choices
            .iter()
            .any(|c| c.id == "acceptForSession"));
    }
    #[test]
    fn user_input_obeys_options_secret_text_and_cancellation_contract() {
        for cancel in [false, true] {
            let (mut client, output) = peer();
            let mut p = params();
            p["questions"] = json!([{"id":"q","header":"Choice","question":"Choose one","options":[{"label":"Alpha","description":"First"}],"isOther":false,"isSecret":true}]);
            client
                .request(&json!(6), "item/tool/requestUserInput", &p)
                .unwrap();
            assert!(client.broker.snapshot().requests[0].questions[0].secret);
            assert!(respond(
                &client,
                None,
                json!({"answers":[{"question_id":"q","text":"unoffered"}]})
            )
            .is_err());
            respond(
                &client,
                None,
                if cancel {
                    json!({"cancel":true})
                } else {
                    json!({"answers":[{"question_id":"q","selected":["Alpha"]}]})
                },
            )
            .unwrap();
            client.poll().unwrap();
            assert_eq!(
                wire(&output)["result"],
                if cancel {
                    json!({"answers":{}})
                } else {
                    json!({"answers":{"q":{"answers":["Alpha"]}}})
                }
            );
        }
    }
    #[test]
    fn mcp_elicitation_cannot_be_accepted_without_supported_form_ui() {
        let (mut client, output) = peer();
        client
            .request(&json!(7), "mcpServer/elicitation/request", &params())
            .unwrap();
        assert!(respond(&client, Some("accept"), json!({})).is_err());
        respond(&client, Some("decline"), json!({})).unwrap();
        client.poll().unwrap();
        assert_eq!(
            wire(&output)["result"],
            json!({"action":"decline","content":null})
        );
    }
    #[test]
    fn foreign_threads_and_stale_turns_are_not_authorized() {
        let (mut client, output) = peer();
        let mut p = params();
        p["threadId"] = json!("unrelated");
        assert!(client
            .request(&json!(8), "item/commandExecution/requestApproval", &p)
            .is_err());
        assert!(wire(&output).get("error").is_some());
        let mut p = params();
        p["turnId"] = json!("old-turn");
        assert!(client
            .request(&json!(9), "item/commandExecution/requestApproval", &p)
            .is_err());
        assert!(client.broker.snapshot().requests.is_empty());
    }
    #[test]
    fn subagent_approval_requires_observed_parent_relationship() {
        let (mut client, _output) = peer();
        client.observe_line(&json!({"method":"thread/started","params":{"thread":{"id":"child","parentThreadId":THREAD}}}).to_string()).unwrap();
        let mut p = params();
        p["threadId"] = json!("child");
        p["turnId"] = json!("child-turn");
        client
            .request(&json!(10), "item/commandExecution/requestApproval", &p)
            .unwrap();
        assert!(client.broker.snapshot().requests[0]
            .title
            .starts_with("Subagent:"));
    }
    #[test]
    fn stop_cancels_enqueued_response_and_completion_without_approval_stays_blocked() {
        let (mut client, output) = peer();
        client
            .request(
                &json!(11),
                "item/commandExecution/requestApproval",
                &params(),
            )
            .unwrap();
        respond(&client, Some("accept"), json!({})).unwrap();
        client.broker.close("Stop");
        client.poll().unwrap();
        assert!(output.try_recv().is_err());
        let (mut client, _output) = peer();
        client
            .request(
                &json!(11),
                "item/commandExecution/requestApproval",
                &params(),
            )
            .unwrap();
        client
            .notification(
                "turn/completed",
                &json!({"threadId":THREAD,"turn":{"id":TURN,"status":"completed"}}),
            )
            .unwrap();
        assert!(client.denied);
        assert_eq!(client.broker.snapshot().requests[0].status, "expired");
    }
    #[test]
    fn missing_control_confirmation_times_out_without_resending() {
        let (mut client, output) = peer();
        client.submitted.insert(
            "request".into(),
            (Instant::now() - Duration::from_secs(61), "accept".into()),
        );
        assert!(client.poll().unwrap_err().contains("60 seconds"));
        assert!(output.try_recv().is_err());
    }
}
