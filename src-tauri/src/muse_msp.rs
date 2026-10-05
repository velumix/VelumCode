//! One durable MSP connection owned by one Velum turn. Only this adapter emits RPC.
use crate::{
    events::AgentEvent,
    interactions::{self, Broker},
    provider_models::RunOptions,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    process::ChildStdin,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

enum Pending {
    Initialize,
    Open,
    Policy,
    Model,
    Ready,
    Turn,
    Refresh(String, u64),
    Decision(String, u64),
}

pub struct Client {
    writer: Option<mpsc::SyncSender<Vec<u8>>>,
    writer_errors: mpsc::Receiver<String>,
    controls: mpsc::Receiver<interactions::Command>,
    pub broker: Arc<Broker>,
    pending: HashMap<u64, (Pending, Instant)>,
    next_id: u64,
    resume: String,
    workspace: String,
    prompt: String,
    display: String,
    options: RunOptions,
    mode: &'static str,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    view: crate::muse_view::View,
    approvals: HashMap<String, Value>,
    before_turn: Vec<String>,
    before_turn_bytes: usize,
    interaction_epoch: u64,
    completed: bool,
    pub denied: bool,
}

fn command_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

impl Client {
    // Mirrors the Codex constructor's positional shape; grouping would hide the parity.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        input: ChildStdin,
        broker: Arc<Broker>,
        controls: mpsc::Receiver<interactions::Command>,
        resume: String,
        workspace: String,
        prompt: String,
        display: String,
        options: RunOptions,
        yolo: bool,
    ) -> Result<Self, String> {
        // MSP validates workspaceRoots against Rust's canonical path spelling.
        // On Windows that includes the extended-length prefix; display paths
        // such as C:\\project are rejected even when they name the same folder.
        let workspace = std::fs::canonicalize(&workspace)
            .map_err(|error| format!("Could not resolve Muse's workspace: {error}"))?
            .to_string_lossy()
            .into_owned();
        // Pipe writes must not block the supervisor, including during cancellation.
        let (writer, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
        let (errors, writer_errors) = mpsc::channel();
        std::thread::spawn(move || {
            let mut input = input;
            for bytes in receiver {
                if let Err(error) = input.write_all(&bytes).and_then(|_| input.flush()) {
                    let _ = errors.send(format!("Muse's input connection closed: {error}"));
                    break;
                }
            }
        });
        let mut client = Self {
            writer: Some(writer),
            writer_errors,
            controls,
            broker,
            pending: HashMap::new(),
            next_id: 0,
            resume,
            workspace,
            prompt,
            display,
            options,
            mode: if yolo { "allowAll" } else { "promptUnmatched" },
            session_id: None,
            run_id: None,
            view: Default::default(),
            approvals: HashMap::new(),
            before_turn: vec![],
            before_turn_bytes: 0,
            interaction_epoch: 0,
            completed: false,
            denied: false,
        };
        client.call("initialize", json!({"clientInfo":{"name":"velum_code","version":env!("CARGO_PKG_VERSION")},"capabilities":{"userInputDialogs":true}}), Pending::Initialize)?;
        Ok(client)
    }

    fn write(&self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Muse request exceeds the transport limit.".into());
        }
        bytes.push(b'\n');
        self.writer
            .as_ref()
            .ok_or("Muse's connection has closed.")?
            .try_send(bytes)
            .map_err(|_| "Muse's input connection is unavailable or backpressured.".into())
    }

    fn call(&mut self, method: &str, params: Value, pending: Pending) -> Result<(), String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        self.pending.insert(id, (pending, Instant::now()));
        Ok(())
    }

    pub fn poll(&mut self) -> Result<(), String> {
        if let Ok(error) = self.writer_errors.try_recv() {
            return Err(error);
        }
        if self
            .pending
            .values()
            .any(|(_, since)| since.elapsed() > Duration::from_secs(60))
        {
            return Err("Muse did not acknowledge a control request within 60 seconds. The turn was stopped; inspect partial work before retrying.".into());
        }
        while let Ok(command) = self.controls.try_recv() {
            let decision = &command.decision;
            let mut params = command.binding.clone();
            params
                .as_object_mut()
                .ok_or("Invalid provider request binding.")?
                .remove("turnId");
            params.as_object_mut().unwrap().remove("answerModes");
            params["commandId"] = json!(command_id());
            let method;
            if let Some(choice) = &decision.choice_id {
                method = "approval/decide";
                params["choiceId"] = json!(choice);
                if let Some(feedback) = &decision.feedback {
                    params["feedback"] = json!(feedback);
                }
            } else if decision.cancel {
                method = "userInput/cancel";
                params["reason"] = json!("The user declined to answer in Velum Code.");
            } else {
                method = "userInput/answer";
                params["answers"] = Value::Array(
                    decision
                        .answers
                        .iter()
                        .map(|answer| {
                            let mut value = json!({"questionId":answer.question_id});
                            if let Some(text) = &answer.text {
                                value["freeText"] = json!(text);
                            } else if command.binding["answerModes"][&answer.question_id]
                                != "multiple"
                            {
                                value["selectedLabel"] = json!(answer.selected[0]);
                            } else {
                                value["selectedLabels"] = json!(answer.selected);
                            }
                            value
                        })
                        .collect(),
                );
            }
            let broker = self.broker.clone();
            broker.dispatch(&command, || {
                self.call(
                    method,
                    params,
                    Pending::Decision(decision.id.clone(), decision.revision),
                )
            })?;
        }
        if self.completed && !self.broker.waiting() && self.pending.is_empty() {
            self.writer.take();
        }
        Ok(())
    }

    pub fn settling(&self) -> bool {
        self.completed && !self.broker.waiting() && self.pending.is_empty()
    }

    pub fn observe_line(&mut self, line: &str) -> Result<Vec<AgentEvent>, String> {
        let value: Value = serde_json::from_str(line)
            .map_err(|_| "Muse returned invalid JSON on its control connection.")?;
        if value.get("method").is_some()
            && self
                .pending
                .values()
                .any(|(pending, _)| matches!(pending, Pending::Turn))
        {
            // The acknowledgement owns the turn ID, including queued submits.
            // Keep early requests inert until that identity is established.
            if self.before_turn.len() >= 2048
                || self.before_turn_bytes.saturating_add(line.len()) > 4 * 1024 * 1024
            {
                return Err(
                    "Muse did not establish its turn identity before the event buffer filled."
                        .into(),
                );
            }
            self.before_turn_bytes += line.len();
            self.before_turn.push(line.into());
            return Ok(vec![]);
        }
        if let Some(method) = value["method"].as_str() {
            let params = &value["params"];
            let is_request = value.get("id").is_some();
            if is_request && !matches!(method, "approval/request" | "userInput/request") {
                self.write(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"This client does not support that request."}}))?;
                return Ok(vec![]);
            }
            let owned = self
                .session_id
                .as_deref()
                .is_some_and(|id| params["sessionId"] == id);
            if !owned {
                if is_request {
                    return Err("Muse sent a permission request for a different session.".into());
                }
                return Ok(vec![]);
            }
            if method.starts_with("approval/") || method.starts_with("userInput/") {
                self.interaction_epoch += 1;
            }
            if matches!(
                method,
                "approval/request" | "approval/requested" | "approval/updated"
            ) {
                self.present_approval(params)?;
            } else if matches!(method, "userInput/request" | "userInput/requested") {
                self.present_question(params)?;
            } else if method == "approval/resolved" {
                if self.run_id.is_none() || params["turnId"].as_str() != self.run_id.as_deref() {
                    return Ok(vec![]);
                }
                let id = string(params, "approvalId");
                let decision = string(params, "decision");
                let status = if decision.starts_with("approved") {
                    "approved"
                } else if decision.starts_with("denied") {
                    "denied"
                } else {
                    "cancelled"
                };
                self.denied |= status != "approved";
                let source = self
                    .broker
                    .snapshot()
                    .requests
                    .into_iter()
                    .find(|r| r.id == format!("approval:{id}"))
                    .and_then(|r| r.source)
                    .unwrap_or_else(|| "provider".into());
                self.broker.settle(
                    &format!("approval:{id}"),
                    status,
                    Some(format!("Muse: {decision}")),
                );
                let previous = self.approvals.remove(&id).unwrap_or_default();
                return Ok(vec![AgentEvent::Approval {
                    status: status.into(),
                    tool: previous["toolName"].as_str().map(str::to_owned),
                    summary: format!("Permission {status} ({decision}); response from {source}."),
                }]);
            } else if method == "userInput/settled" {
                let id = format!("question:{}", string(params, "userInputId"));
                let known = self
                    .broker
                    .snapshot()
                    .requests
                    .into_iter()
                    .find(|request| request.id == id);
                if known.is_none() {
                    return Ok(vec![]);
                }
                let source = known
                    .and_then(|request| request.source)
                    .unwrap_or_else(|| "provider".into());
                let outcome = string(params, "outcome");
                self.broker
                    .settle(&id, "resolved", Some(format!("Muse: {outcome}")));
                return Ok(vec![AgentEvent::Notice {
                    text: format!("Question {outcome}; response from {source}."),
                }]);
            }
            if is_request {
                // Receipt is presentation acknowledgement only, never a grant.
                self.write(json!({"jsonrpc":"2.0","id":value["id"],"result":{}}))?;
                return Ok(vec![]);
            }
            if method == "view/gap" {
                return Err("Muse reported a gap in its event stream. The turn was stopped so permission state cannot silently diverge. Retry to resume the saved conversation.".into());
            }
            if self.run_id.is_none() {
                return Ok(vec![]);
            }
            if let Some(turn) = params["turnId"].as_str() {
                if Some(turn) != self.run_id.as_deref() {
                    return Ok(vec![]);
                }
            }
            if method == "turn/completed" {
                self.completed = true;
                for request in self.broker.snapshot().requests {
                    if matches!(request.status.as_str(), "pending" | "submitting") {
                        self.denied |= request.kind == "approval";
                        self.broker.settle(
                            &request.id,
                            "expired",
                            Some("Muse ended the turn before confirming this request.".into()),
                        );
                    }
                }
            }
            return Ok(self.view.observe(method, params));
        }
        let Some(id) = value["id"].as_u64() else {
            return Ok(vec![]);
        };
        let Some((pending, _)) = self.pending.remove(&id) else {
            return Ok(vec![]);
        };
        if let Some(error) = value.get("error") {
            let message = string(error, "message");
            if let Pending::Decision(request_id, revision) = pending {
                if !self.broker.snapshot().requests.iter().any(|request| {
                    request.id == request_id
                        && request.revision == revision
                        && request.status == "submitting"
                }) {
                    return Ok(vec![]);
                }
                self.broker.settle(&request_id, "submitting", Some(message));
                self.call(
                    "approval/listPending",
                    json!({"sessionId":self.session_id}),
                    Pending::Refresh(request_id, self.interaction_epoch),
                )?;
                return Ok(vec![]);
            }
            if matches!(pending, Pending::Open) && !self.resume.is_empty() {
                return Err(format!("Muse could not resume this saved conversation: {message}. Its history has been preserved. Start a new conversation to use interactive approvals, or continue this session in Muse's terminal."));
            }
            return Err(format!("Muse control request failed: {message}"));
        }
        let result = &value["result"];
        match pending {
            Pending::Initialize => {
                if result["schema"]["version"] != 1 {
                    return Err("This Muse version uses an unsupported control protocol. Update Muse and Velum Code together.".into());
                }
                if result
                    .get("sessionDurability")
                    .is_some_and(|v| v != "durable")
                {
                    return Err("Muse started without durable sessions. Resume and interactive approval recovery require a durable host.".into());
                }
                self.write(json!({"jsonrpc":"2.0","method":"initialized"}))?;
                if self.resume.is_empty() {
                    let mut params = json!({"commandId":command_id(),"workspaceRoot":self.workspace,"approvalMode":self.mode});
                    if !self.options.model.is_empty() {
                        params["modelId"] = json!(self.options.model);
                    }
                    self.call("session/start", params, Pending::Open)?;
                } else {
                    self.call("session/resume", json!({"commandId":command_id(),"sessionId":self.resume,"excludeItems":true}), Pending::Open)?;
                }
            }
            Pending::Open => {
                let id = result["session"]["sessionId"]
                    .as_str()
                    .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    .ok_or("Muse did not return a valid session identity.")?;
                if !self.resume.is_empty() && id != self.resume {
                    return Err("Muse resumed a different session than requested.".into());
                }
                if result["session"]["activeTurnId"].as_str().is_some() {
                    return Err("Muse restored unfinished work. Continue that work in Muse's terminal or start a new conversation; no permission decision was sent.".into());
                }
                self.session_id = Some(id.into());
                self.call(
                    "session/setApprovalMode",
                    json!({"commandId":command_id(),"sessionId":id,"mode":self.mode}),
                    Pending::Policy,
                )?;
            }
            Pending::Policy => {
                if !self.options.model.is_empty() {
                    self.call("session/setModel", json!({"commandId":command_id(),"sessionId":self.session_id,"model":{"modelId":self.options.model}}), Pending::Model)?;
                } else {
                    self.ready()?;
                }
            }
            Pending::Model => self.ready()?,
            Pending::Ready => {
                if result["approvals"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
                    || result["userInputs"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty())
                {
                    return Err("Muse restored pending requests from an earlier turn. Continue them in Muse's terminal or start a new conversation; no decision was sent.".into());
                }
                let command = command_id();
                let mut params = json!({"commandId":command,"sessionId":self.session_id,"input":[{"type":"text","text":self.prompt}],"displayText":self.display,"workspaceRoots":[self.workspace],"ifBusy":"queue"});
                if !self.options.reasoning.is_empty() {
                    params["reasoningEffort"] = json!(self.options.reasoning);
                }
                self.call("turn/start", params, Pending::Turn)?;
                self.prompt.clear();
            }
            Pending::Turn => {
                let turn = result["turnId"]
                    .as_str()
                    .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    .ok_or("Muse did not acknowledge a valid turn identity.")?;
                if !matches!(result["disposition"].as_str(), Some("started" | "queued")) {
                    return Err("Muse did not start or queue this request as a separate turn. No approval was sent.".into());
                }
                self.run_id = Some(turn.into());
                let buffered = std::mem::take(&mut self.before_turn);
                self.before_turn_bytes = 0;
                let mut events = vec![];
                for line in buffered {
                    events.extend(self.observe_line(&line)?);
                }
                return Ok(events);
            }
            Pending::Decision(_, _) => { /* Accepted does not mean resolved. */ }
            Pending::Refresh(rejected, epoch) => {
                if epoch != self.interaction_epoch {
                    self.call(
                        "approval/listPending",
                        json!({"sessionId":self.session_id}),
                        Pending::Refresh(rejected, self.interaction_epoch),
                    )?;
                    return Ok(vec![]);
                }
                let mut present = std::collections::HashSet::new();
                for approval in result["approvals"].as_array().into_iter().flatten() {
                    let id = format!("approval:{}", string(approval, "approvalId"));
                    self.present_approval(approval)?;
                    // A rejected decide with the same stage can be offered again.
                    if id == rejected {
                        self.broker.settle(&id, "pending", None);
                    }
                    present.insert(id);
                }
                for question in result["userInputs"].as_array().into_iter().flatten() {
                    let id = format!("question:{}", string(question, "userInputId"));
                    self.present_question(question)?;
                    if id == rejected {
                        self.broker.settle(&id, "pending", None);
                    }
                    present.insert(id);
                }
                for request in self.broker.snapshot().requests {
                    if matches!(request.status.as_str(), "pending" | "submitting")
                        && !present.contains(&request.id)
                    {
                        self.broker.settle(
                            &request.id,
                            "resolved",
                            Some("This request was already resolved by Muse.".into()),
                        );
                    }
                }
            }
        }
        Ok(vec![])
    }

    fn ready(&mut self) -> Result<(), String> {
        self.call(
            "approval/listPending",
            json!({"sessionId":self.session_id}),
            Pending::Ready,
        )
    }

    fn present_approval(&mut self, params: &Value) -> Result<(), String> {
        let id = string(params, "approvalId");
        if id.is_empty() || !params["currentRequirementId"].is_object() {
            return Err("Muse sent an approval without its request/stage identity.".into());
        }
        let mut merged = self
            .approvals
            .get(&id)
            .cloned()
            .unwrap_or_else(|| json!({}));
        for (key, value) in params.as_object().ok_or("Invalid approval request.")? {
            merged[key] = value.clone();
        }
        if !merged["rawArgs"].is_string()
            || !merged["subject"].is_object()
            || string(&merged, "toolName").is_empty()
        {
            return Err(
                "Muse sent a permission request without a displayable action and arguments.".into(),
            );
        }
        if self.run_id.is_none()
            || merged["turnId"].as_str() != self.run_id.as_deref()
            || self.completed
        {
            return Err("Muse sent a permission request outside this active turn. No permission was granted.".into());
        }
        if merged["currentRequirementId"]["approvalId"] != id
            || !merged["currentRequirementId"]["sourceIndex"].is_u64()
        {
            return Err("Muse sent an invalid permission requirement.".into());
        }
        let choices = merged["availableChoices"]
            .as_array()
            .ok_or("Muse sent an approval without choices.")?
            .iter()
            .map(|choice| {
                let id = string(choice, "choiceId");
                let label = string(choice, "label");
                if id.is_empty() || label.is_empty() {
                    return Err("Muse sent an invalid approval choice.".to_string());
                }
                Ok(interactions::Choice {
                    id,
                    label,
                    scope: string(choice, "scope"),
                    decision: string(choice, "decision"),
                    accepts_feedback: choice["acceptsFeedback"].as_bool().unwrap_or(false),
                    rule: choice.get("rulePreview").filter(|v| !v.is_null()).cloned(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if choices.is_empty() {
            return Err("Muse sent a request with no available decision.".into());
        }
        let tool = string(&merged, "toolName");
        let details = format!(
            "{}\n\n{}",
            serde_json::to_string_pretty(&merged["subject"]).unwrap_or_default(),
            string(&merged, "rawArgs")
        );
        let title = if merged["subagentOrigin"].is_object() {
            format!("Subagent permission: {tool}")
        } else {
            format!("Permission required: {tool}")
        };
        self.broker.present(interactions::Request { id: format!("approval:{id}"), revision: 0, kind: "approval".into(), title, tool, details, choices, questions: vec![], status: "pending".into(), message: None, source: None }, json!({"sessionId":merged["sessionId"],"turnId":merged["turnId"],"approvalId":id,"requirementId":merged["currentRequirementId"]}))?;
        self.approvals.insert(id, merged);
        Ok(())
    }

    fn present_question(&self, params: &Value) -> Result<(), String> {
        if self.run_id.is_none()
            || params["turnId"].as_str() != self.run_id.as_deref()
            || self.completed
        {
            return Err(
                "Muse sent a question outside this active turn. No answer was sent.".into(),
            );
        }
        let id = string(params, "userInputId");
        if id.is_empty() {
            return Err("Muse sent a question without an identity.".into());
        }
        let questions = params["questions"]
            .as_array()
            .ok_or("Muse sent an invalid question list.")?
            .iter()
            .map(|question| {
                let mode = question["selection"]["mode"].as_str().unwrap_or_default();
                if !matches!(mode, "single" | "multiple") {
                    return Err("Muse requested an unsupported answer format.".to_owned());
                }
                let options = question["options"]
                    .as_array()
                    .ok_or("Muse sent invalid question options.")?
                    .iter()
                    .map(|option| interactions::QuestionOption {
                        label: string(option, "label"),
                        description: string(option, "description"),
                    })
                    .collect::<Vec<_>>();
                let multiple = mode == "multiple";
                Ok(interactions::Question {
                    id: string(question, "id"),
                    header: string(question, "header"),
                    question: string(question, "question"),
                    min: question["selection"]["minSelections"].as_u64().unwrap_or(1) as usize,
                    max: question["selection"]["maxSelections"]
                        .as_u64()
                        .map(|v| v as usize)
                        .unwrap_or(if multiple { options.len().max(1) } else { 1 }),
                    options,
                    multiple,
                    free_text: true,
                    secret: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if questions.is_empty() {
            return Err("Muse sent an empty question request.".into());
        }
        let answer_modes = questions
            .iter()
            .map(|question| {
                (
                    question.id.clone(),
                    json!(if question.multiple {
                        "multiple"
                    } else {
                        "single"
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        self.broker.present(
            interactions::Request {
                id: format!("question:{id}"),
                revision: 0,
                kind: "question".into(),
                title: "Your answer is needed".into(),
                tool: string(params, "toolName"),
                details: String::new(),
                choices: vec![],
                questions,
                status: "pending".into(),
                message: None,
                source: None,
            },
            json!({"sessionId":params["sessionId"],"turnId":params["turnId"],"userInputId":id,"answerModes":answer_modes}),
        )
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.broker.close("The provider connection has ended.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const TURN: &str = "22222222-2222-4222-8222-222222222222";

    fn peer() -> (Client, mpsc::Receiver<Vec<u8>>) {
        let (broker, controls) = Broker::new("generation".into());
        let (writer, output) = mpsc::sync_channel(16);
        let (_, writer_errors) = mpsc::channel();
        (
            Client {
                writer: Some(writer),
                writer_errors,
                controls,
                broker,
                pending: HashMap::new(),
                next_id: 0,
                resume: String::new(),
                workspace: String::new(),
                prompt: String::new(),
                display: String::new(),
                options: RunOptions::default(),
                mode: "promptUnmatched",
                session_id: Some(SESSION.into()),
                run_id: Some(TURN.into()),
                view: Default::default(),
                approvals: HashMap::new(),
                before_turn: vec![],
                before_turn_bytes: 0,
                interaction_epoch: 0,
                completed: false,
                denied: false,
            },
            output,
        )
    }
    fn approval() -> Value {
        json!({"sessionId":SESSION,"turnId":TURN,"approvalId":"approval-a","toolName":"powershell","rawArgs":"{\"command\":\"echo QA\"}","subject":{"kind":"shell","command":"echo QA"},"currentRequirementId":{"approvalId":"approval-a","sourceIndex":0},"availableChoices":[{"choiceId":"allow_once","label":"Allow once","scope":"once","decision":"approved"},{"choiceId":"abort","label":"Reject","scope":"once","decision":"abort","acceptsFeedback":true}]})
    }
    fn observe(
        client: &mut Client,
        method: &str,
        params: Value,
    ) -> Result<Vec<AgentEvent>, String> {
        client.observe_line(&json!({"jsonrpc":"2.0","method":method,"params":params}).to_string())
    }
    fn respond(client: &Client, id: &str, choice: Option<&str>) {
        let snapshot = client.broker.snapshot();
        let request = snapshot.requests.iter().find(|r| r.id == id).unwrap();
        client.broker.respond(serde_json::from_value(json!({"generation":snapshot.generation,"id":id,"revision":request.revision,"choice_id":choice})).unwrap(),"test").unwrap();
    }
    fn wire(output: &mpsc::Receiver<Vec<u8>>) -> Value {
        serde_json::from_slice(&output.try_recv().unwrap()).unwrap()
    }

    #[test]
    fn receipt_and_mirror_present_one_request_without_granting() {
        let (mut client, output) = peer();
        client
            .observe_line(
                &json!({"id":"receipt","method":"approval/request","params":approval()})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(
            wire(&output),
            json!({"jsonrpc":"2.0","id":"receipt","result":{}})
        );
        let revision = client.broker.snapshot().revision;
        observe(&mut client, "approval/requested", approval()).unwrap();
        assert_eq!(client.broker.snapshot().revision, revision);
        client.poll().unwrap();
        assert!(output.try_recv().is_err());
        assert!(client.broker.waiting());
    }
    #[test]
    fn early_approval_waits_for_authoritative_turn_ack() {
        let (mut client, output) = peer();
        client.run_id = None;
        client.pending.insert(77, (Pending::Turn, Instant::now()));
        client
            .observe_line(
                &json!({"id":"receipt","method":"approval/request","params":approval()})
                    .to_string(),
            )
            .unwrap();
        assert!(client.broker.snapshot().requests.is_empty());
        assert!(output.try_recv().is_err());
        client
            .observe_line(
                &json!({"id":77,"result":{"turnId":TURN,"disposition":"started"}}).to_string(),
            )
            .unwrap();
        assert!(client.broker.waiting());
        assert_eq!(wire(&output)["id"], "receipt");
    }
    #[test]
    fn approval_ack_is_not_authoritative_resolution() {
        let (mut client, output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        respond(&client, "approval:approval-a", Some("allow_once"));
        client.poll().unwrap();
        let request = wire(&output);
        assert_eq!(request["method"], "approval/decide");
        assert_eq!(
            request["params"]["requirementId"],
            json!({"approvalId":"approval-a","sourceIndex":0})
        );
        assert!(request["params"].get("turnId").is_none());
        assert_eq!(
            uuid::Uuid::parse_str(request["params"]["commandId"].as_str().unwrap())
                .unwrap()
                .get_version_num(),
            7
        );
        client
            .observe_line(
                &json!({"id":request["id"],"result":{"status":"accepted","terminal":true}})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(client.broker.snapshot().requests[0].status, "submitting");
        observe(&mut client,"approval/resolved",json!({"sessionId":SESSION,"turnId":TURN,"approvalId":"approval-a","decision":"approved"})).unwrap();
        assert!(!client.broker.waiting());
        assert!(!client.denied);
    }
    #[test]
    fn stage_change_cancels_queued_grant_and_preserves_action_details() {
        let (mut client, output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        respond(&client, "approval:approval-a", Some("allow_once"));
        observe(&mut client,"approval/updated",json!({"sessionId":SESSION,"approvalId":"approval-a","currentRequirementId":{"approvalId":"approval-a","sourceIndex":1},"availableChoices":approval()["availableChoices"]})).unwrap();
        client.poll().unwrap();
        assert!(output.try_recv().is_err());
        let snapshot = client.broker.snapshot();
        assert_eq!(snapshot.requests[0].status, "pending");
        assert!(snapshot.requests[0].details.contains("echo QA"));
        respond(&client, "approval:approval-a", Some("abort"));
        client.poll().unwrap();
        assert_eq!(wire(&output)["params"]["requirementId"]["sourceIndex"], 1);
    }
    #[test]
    fn stop_prevents_queued_permission_from_reaching_transport() {
        let (mut client, output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        respond(&client, "approval:approval-a", Some("allow_once"));
        client.broker.close("Stopped");
        client.poll().unwrap();
        assert!(output.try_recv().is_err());
    }
    #[test]
    fn foreign_turn_and_receipt_session_are_rejected() {
        let (mut client, output) = peer();
        let mut params = approval();
        params["turnId"] = json!("other");
        assert!(observe(&mut client, "approval/requested", params).is_err());
        let mut params = approval();
        params["sessionId"] = json!("other");
        assert!(client
            .observe_line(&json!({"id":5,"method":"approval/request","params":params}).to_string())
            .is_err());
        assert!(client.broker.snapshot().requests.is_empty());
        assert!(output.try_recv().is_err());
    }
    #[test]
    fn rejection_refresh_cannot_roll_back_a_newer_stage() {
        let (mut client, output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        respond(&client, "approval:approval-a", Some("allow_once"));
        client.poll().unwrap();
        let sent = wire(&output);
        client
            .observe_line(&json!({"id":sent["id"],"error":{"message":"stage changed"}}).to_string())
            .unwrap();
        let refresh = wire(&output);
        assert_eq!(refresh["method"], "approval/listPending");
        observe(&mut client,"approval/updated",json!({"sessionId":SESSION,"approvalId":"approval-a","currentRequirementId":{"approvalId":"approval-a","sourceIndex":1}})).unwrap();
        client
            .observe_line(
                &json!({"id":refresh["id"],"result":{"approvals":[approval()],"userInputs":[]}})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(wire(&output)["method"], "approval/listPending");
        respond(&client, "approval:approval-a", Some("abort"));
        client.poll().unwrap();
        assert_eq!(wire(&output)["params"]["requirementId"]["sourceIndex"], 1);
    }
    #[test]
    fn abort_is_blocked_and_completed_turn_expires_unanswered_requests() {
        let (mut client, _output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        observe(
            &mut client,
            "approval/resolved",
            json!({"sessionId":SESSION,"turnId":TURN,"approvalId":"approval-a","decision":"abort"}),
        )
        .unwrap();
        assert!(client.denied);
        assert_eq!(client.broker.snapshot().requests[0].status, "cancelled");
        let (mut client, _output) = peer();
        observe(&mut client, "approval/requested", approval()).unwrap();
        observe(
            &mut client,
            "turn/completed",
            json!({"sessionId":SESSION,"turnId":TURN,"terminal":"completed"}),
        )
        .unwrap();
        assert!(client.denied);
        assert_eq!(client.broker.snapshot().requests[0].status, "expired");
    }
}
