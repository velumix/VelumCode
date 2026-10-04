//! Translate provider streams into the same desktop and phone event vocabulary.
use crate::{
    events::{AgentEvent as Event, Fold, TodoItem},
    providers::Provider,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub struct Stream {
    provider: Provider,
    muse: Fold,
    text: HashMap<String, String>,
    tools: HashSet<String>,
    agy_last_tool: Option<(u64, Option<String>)>,
    agy_usage: HashMap<u64, crate::provider_usage::TurnUsage>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
}
fn text(value: &Value, key: &str) -> String {
    bounded(value[key].as_str().unwrap_or_default())
}
fn bounded(value: &str) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(100_000).collect();
    if chars.next().is_some() {
        result.push_str("\n…[truncated]");
    }
    result
}
fn error(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| bounded(value.as_str().unwrap_or(&value.to_string())))
}
fn end(status: &str, response: Option<String>, reason: Option<String>) -> Event {
    Event::TurnEnd {
        status: status.into(),
        text: response.filter(|s| !s.is_empty()),
        reason: reason.filter(|s| !s.is_empty()),
    }
}
impl Stream {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            muse: Fold::default(),
            text: HashMap::new(),
            tools: HashSet::new(),
            agy_last_tool: None,
            agy_usage: HashMap::new(),
            session_id: None,
            run_id: None,
        }
    }
    fn remember(&mut self, value: &Value) {
        if let Some(id) = value
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            self.session_id = Some(id.into());
        }
    }
    fn append(&mut self, id: &str, full: String) -> String {
        let previous = self.text.entry(id.into()).or_default();
        let addition = full
            .strip_prefix(previous.as_str())
            .unwrap_or(if previous.is_empty() { &full } else { "" })
            .to_owned();
        *previous = full;
        addition
    }
    pub fn fold_line(&mut self, line: &str) -> Vec<Event> {
        if self.provider == Provider::Muse {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                let payload = &value["payload"];
                if self.run_id.is_none()
                    && value["payload_type"] == "run.lifecycle.started"
                    && value["stream"]["kind"] == "session"
                    && payload["run_stream"]["kind"] == "run"
                    && payload["command_id"] == payload["run_stream"]["id"]
                {
                    if let Some(id) = payload["command_id"]
                        .as_str()
                        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    {
                        self.run_id = Some(id.into());
                    }
                }
            }
            return self.muse.fold_line(line);
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        match self.provider {
            Provider::Codex => self.codex(value),
            Provider::Antigravity => self.antigravity(value),
            Provider::Muse => unreachable!(),
        }
    }
    /// Some Agy runs omit the structured tool error and only report a
    /// headless denial on stderr. Correct only the latest command without
    /// result evidence; never relabel a completed, evidenced operation.
    pub fn permission_denied(&mut self) -> Vec<Event> {
        self.agy_last_tool
            .as_mut()
            .and_then(|(_, id)| id.take())
            .map(|task_id| Event::ToolEnd {
                task_id,
                status: "blocked".into(),
                reason: Some(
                    "Antigravity's headless permission policy rejected this command.".into(),
                ),
            })
            .into_iter()
            .collect()
    }
    fn codex(&mut self, value: Value) -> Vec<Event> {
        match value["type"].as_str().unwrap_or_default() {
            "thread.started" => {
                self.remember(&value["thread_id"]);
                vec![]
            }
            "turn.started" => vec![Event::Activity {
                text: "Thinking…".into(),
            }],
            "turn.completed" => {
                let mut events = Vec::new();
                if let Some(turn) = crate::provider_usage::codex_turn(&value["usage"]) {
                    events.push(Event::Usage {
                        context: None,
                        turn: Some(turn),
                    });
                }
                events.push(end("completed", None, None));
                events
            }
            "turn.failed" => vec![end("failed", None, Some(text(&value["error"], "message")))],
            "error" => vec![Event::Notice {
                text: text(&value, "message"),
            }],
            "item.started" | "item.updated" | "item.completed" => {
                let item = &value["item"];
                let id = text(item, "id");
                let kind = item["type"].as_str().unwrap_or_default();
                let completed = value["type"] == "item.completed";
                if kind == "agent_message" {
                    let delta = self.append(&id, text(item, "text"));
                    return if delta.is_empty() {
                        vec![]
                    } else {
                        vec![Event::AssistantDelta { text: delta }]
                    };
                }
                if kind == "reasoning" {
                    return vec![Event::Activity {
                        text: "Thinking…".into(),
                    }];
                }
                if kind == "todo_list" {
                    return vec![Event::Todos {
                        items: item["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .take(100)
                            .map(|todo| TodoItem {
                                text: text(todo, "text"),
                                status: if todo["completed"] == true {
                                    "completed"
                                } else {
                                    "pending"
                                }
                                .into(),
                            })
                            .collect(),
                    }];
                }
                if !matches!(
                    kind,
                    "command_execution" | "file_change" | "mcp_tool_call" | "web_search"
                ) {
                    return vec![];
                }
                let mut events = vec![];
                if self.tools.insert(id.clone()) {
                    events.push(Event::ToolStart {
                        task_id: id.clone(),
                        name: match kind {
                            "command_execution" => "Shell",
                            "file_change" => "File changes",
                            "web_search" => "Web search",
                            _ => "MCP tool",
                        }
                        .into(),
                    });
                    let detail = match kind {
                        "command_execution" => text(item, "command"),
                        "web_search" => text(item, "query"),
                        "mcp_tool_call" => text(item, "tool"),
                        _ => String::new(),
                    };
                    if !detail.is_empty() {
                        events.push(Event::ToolDelta {
                            task_id: id.clone(),
                            text: format!("{detail}\n"),
                        });
                    }
                }
                let output = self.append(&format!("tool-{id}"), text(item, "aggregated_output"));
                if !output.is_empty() {
                    events.push(Event::ToolDelta {
                        task_id: id.clone(),
                        text: output,
                    });
                }
                if completed {
                    let shell_error = (kind == "command_execution"
                        && crate::workspace_access::powershell_error(
                            item["aggregated_output"].as_str().unwrap_or(""),
                        ))
                    .then(|| {
                        crate::workspace_access::failure(
                            item["aggregated_output"].as_str().unwrap_or(""),
                        )
                    })
                    .flatten();
                    let status = if item["status"] == "declined" {
                        "blocked"
                    } else if shell_error
                        .is_some_and(|(s, _, _)| s == crate::workspace_access::Status::Blocked)
                    {
                        "blocked"
                    } else if item["status"] == "failed"
                        || shell_error.is_some()
                        || item["exit_code"].as_i64().is_some_and(|n| n != 0)
                    {
                        "failed"
                    } else {
                        "completed"
                    };
                    if kind == "file_change" || kind == "mcp_tool_call" {
                        let output = if kind == "file_change" {
                            &item["changes"]
                        } else {
                            &item["result"]
                        };
                        if !output.is_null() {
                            events.push(Event::ToolResult {
                                task_id: Some(id.clone()),
                                call_id: None,
                                text: bounded(&crate::events::tool_output(output)),
                            });
                        }
                    }
                    events.push(Event::ToolEnd {
                        task_id: id,
                        status: status.into(),
                        reason: error(&item["error"])
                            .or_else(|| shell_error.map(|(_, detail, _)| detail.into())),
                    });
                }
                events
            }
            _ => vec![],
        }
    }
    fn antigravity(&mut self, value: Value) -> Vec<Event> {
        match value["event"].as_str().unwrap_or_default() {
            "init" => {
                self.remember(&value["conversation_id"]);
                vec![Event::Activity {
                    text: "Thinking…".into(),
                }]
            }
            "result" => {
                let result = &value["result"];
                self.remember(&result["conversation_id"]);
                let status = match result["status"].as_str() {
                    Some("SUCCESS")
                        if result["denied_actions"]
                            .as_array()
                            .is_some_and(|actions| !actions.is_empty()) =>
                    {
                        "blocked"
                    }
                    Some("SUCCESS") => "completed",
                    Some("CANCELED" | "INTERRUPTED") => "cancelled",
                    _ => "failed",
                };
                let mut events = if status == "blocked"
                    && result["denied_actions"]
                        .as_array()
                        .is_some_and(|actions| actions.iter().any(|a| a["action"] == "command"))
                {
                    self.permission_denied()
                } else {
                    vec![]
                };
                // Per-step counts belong to this invocation. Result usage may
                // be cumulative when a conversation is resumed.
                let usage = self.agy_total().or_else(|| {
                    (result["num_turns"] == 1)
                        .then(|| crate::provider_usage::antigravity_step(&result["usage"]))
                        .flatten()
                });
                if let Some(turn) = usage {
                    events.push(Event::Usage {
                        context: None,
                        turn: Some(turn),
                    });
                }
                events.push(end(
                    status,
                    Some(text(result, "response")),
                    if status == "blocked" {
                        Some("Antigravity denied a tool under the current permissions. Review the command with /permissions in Terminal, or add a scoped rule such as \"command(...)\" under permissions.allow in ~/.gemini/antigravity-cli/settings.json; allow only what is needed, then retry.".into())
                    } else {
                        error(&result["error"])
                    },
                ));
                events
            }
            "step_update" => {
                let step = &value["step_update"];
                self.remember(&step["conversation_id"]);
                let mut events = vec![];
                if let Some((index, usage)) = step["step_index"]
                    .as_u64()
                    .zip(crate::provider_usage::antigravity_step(&step["usage"]))
                {
                    if self.agy_usage.len() < 100_000 && self.agy_usage.get(&index) != Some(&usage)
                    {
                        self.agy_usage.insert(index, usage);
                        events.push(Event::Usage {
                            context: None,
                            turn: self.agy_total(),
                        });
                    }
                }
                if step["step_type"] == "agent_response" {
                    let delta = text(step, "text_delta");
                    if !delta.is_empty() {
                        events.push(Event::AssistantDelta { text: delta });
                    }
                    return events;
                }
                if step["step_type"] != "tool" {
                    return events;
                }
                let Some(index) = step["step_index"].as_u64() else {
                    return events;
                };
                let id = format!("agy-{index}");
                if self.tools.insert(id.clone()) {
                    events.push(Event::ToolStart {
                        task_id: id.clone(),
                        name: text(step, "tool_name"),
                    });
                }
                let info = &step["tool_info"];
                let output = info["output"]
                    .as_str()
                    .map(|output| {
                        self.append(&id, bounded(&crate::events::tool_text(output.to_owned())))
                    })
                    .unwrap_or_default();
                if self
                    .agy_last_tool
                    .as_ref()
                    .is_none_or(|(last, _)| index >= *last)
                {
                    let unconfirmed = step["tool_name"] == "run_command"
                        && info["error"].is_null()
                        && self.text.get(&id).is_none_or(String::is_empty);
                    self.agy_last_tool = Some((index, unconfirmed.then(|| id.clone())));
                }
                if !output.is_empty() {
                    events.push(Event::ToolDelta {
                        task_id: id.clone(),
                        text: output,
                    });
                }
                if matches!(step["state"].as_str(), Some("DONE" | "ERROR")) {
                    let reason = error(&info["error"]);
                    let policy_blocked = reason
                        .as_deref()
                        .and_then(crate::workspace_access::failure)
                        .is_some_and(|(status, _, _)| {
                            status == crate::workspace_access::Status::Blocked
                        });
                    events.push(Event::ToolEnd {
                        task_id: id,
                        status: if policy_blocked {
                            "blocked"
                        } else if step["state"] == "ERROR" || reason.is_some() {
                            "failed"
                        } else {
                            "completed"
                        }
                        .into(),
                        reason,
                    });
                }
                events
            }
            _ => vec![],
        }
    }
    fn agy_total(&self) -> Option<crate::provider_usage::TurnUsage> {
        self.agy_usage
            .values()
            .cloned()
            .reduce(|total, usage| total.add(&usage))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_mcp_images_do_not_dump_base64_in_tool_results() {
        let mut stream = Stream::new(Provider::Codex);
        let line = serde_json::json!({"type":"item.completed","item":{"id":"shot","type":"mcp_tool_call","tool":"browser_screenshot","status":"completed","result":{"content":[{"type":"image","mimeType":"image/png","data":"private-image-binary"}]}}}).to_string();
        let events = stream.fold_line(&line);
        let text = events
            .iter()
            .find_map(|event| match event {
                Event::ToolResult { text, .. } => Some(text),
                _ => None,
            })
            .unwrap();
        assert!(text.contains("image/png"));
        assert!(!text.contains("private-image-binary"));
    }
    #[test]
    fn antigravity_usage_sums_step_snapshots_once_instead_of_lifetime_result() {
        let mut stream = Stream::new(Provider::Antigravity);
        let first = r#"{"event":"step_update","step_update":{"step_index":8,"step_type":"agent_response","state":"DONE","usage":{"input_tokens":100,"output_tokens":30,"thinking_tokens":4,"cache_read_tokens":70}}}"#;
        assert!(
            matches!(&stream.fold_line(first)[0], Event::Usage { turn:Some(turn),.. } if turn.output_tokens == Some(30))
        );
        assert!(stream.fold_line(first).is_empty());
        stream.fold_line(r#"{"event":"step_update","step_update":{"step_index":9,"step_type":"checkpoint","state":"DONE","usage":{"input_tokens":20,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0}}}"#);
        let events = stream.fold_line(r#"{"event":"result","result":{"status":"SUCCESS","num_turns":3,"usage":{"input_tokens":9000,"output_tokens":1000,"thinking_tokens":300,"cache_read_tokens":6000}}}"#);
        assert!(
            matches!(&events[0], Event::Usage {turn:Some(turn),..} if turn.output_tokens == Some(35) && turn.input_tokens == Some(120) && turn.reasoning_output_tokens == Some(4))
        );
        let mut unknown = Stream::new(Provider::Antigravity);
        assert_eq!(unknown.fold_line(r#"{"event":"result","result":{"status":"SUCCESS","num_turns":2,"usage":{"output_tokens":1000}}}"#).len(), 1);
        let mut fresh = Stream::new(Provider::Antigravity);
        assert!(
            matches!(&fresh.fold_line(r#"{"event":"result","result":{"status":"SUCCESS","num_turns":1,"usage":{"output_tokens":30}}}"#)[0], Event::Usage {turn:Some(turn),..} if turn.output_tokens == Some(30))
        );
    }
    #[test]
    fn muse_usage_root_id_is_captured_only_from_valid_root_lifecycle() {
        let mut stream = Stream::new(Provider::Muse);
        stream.fold_line(r#"{"payload_type":"run.lifecycle.started","stream":{"kind":"session"},"payload":{"command_id":"12855d17-053b-443b-b0f7-d6c1779762b9","run_stream":{"kind":"run","id":"12855d17-053b-443b-b0f7-d6c1779762b9"}}}"#);
        assert_eq!(
            stream.run_id.as_deref(),
            Some("12855d17-053b-443b-b0f7-d6c1779762b9")
        );
        stream.fold_line(r#"{"payload_type":"run.lifecycle.started","stream":{"kind":"session"},"payload":{"command_id":"11111111-1111-4111-8111-111111111111","run_stream":{"kind":"run","id":"11111111-1111-4111-8111-111111111111"}}}"#);
        assert_eq!(
            stream.run_id.as_deref(),
            Some("12855d17-053b-443b-b0f7-d6c1779762b9")
        );
    }
    #[test]
    fn stderr_denial_corrects_only_the_latest_command_without_output_evidence() {
        let done = r#"{"event":"step_update","step_update":{"step_index":8,"step_type":"tool","tool_name":"run_command","state":"DONE","tool_info":{"parameters":{"CommandLine":"probe"}}}}"#;
        let mut stream = Stream::new(Provider::Antigravity);
        stream.fold_line(done);
        assert!(
            matches!(&stream.permission_denied()[0], Event::ToolEnd{task_id,status,..} if task_id == "agy-8" && status == "blocked")
        );
        assert!(stream.permission_denied().is_empty());
        let mut stream = Stream::new(Provider::Antigravity);
        stream.fold_line(r#"{"event":"step_update","step_update":{"step_index":8,"step_type":"tool","tool_name":"run_command","state":"ACTIVE","tool_info":{"output":"actual tool output"}}}"#);
        stream.fold_line(done); // Terminal snapshot omits previously emitted output.
        assert!(stream.permission_denied().is_empty());
        let mut stream = Stream::new(Provider::Antigravity);
        stream.fold_line(done);
        stream.fold_line(r#"{"event":"step_update","step_update":{"step_index":9,"step_type":"tool","tool_name":"read_file","state":"ACTIVE","tool_info":{}}}"#);
        assert!(stream.permission_denied().is_empty());
    }
    #[test]
    fn antigravity_error_state_and_denied_actions_do_not_report_success() {
        let mut stream = Stream::new(Provider::Antigravity);
        let events = stream.fold_line(r#"{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_name":"run_command","state":"ERROR","tool_info":{"error":{"type":"TOOL_ERROR","message":"permission check failed: user denied permission to run command"}}}}"#);
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::ToolEnd{status,..} if status == "blocked")));
        let events = stream.fold_line(r#"{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}"#);
        assert!(
            matches!(&events[0], Event::TurnEnd{status,reason:Some(reason),..} if status == "blocked"
                && reason.contains("permissions.allow")
                && reason.contains("~/.gemini/antigravity-cli/settings.json"))
        );
    }
    #[test]
    fn codex_shell_access_error_is_failed_even_with_zero_exit() {
        let mut stream = Stream::new(Provider::Codex);
        let events = stream.fold_line(r#"{"type":"item.completed","item":{"id":"zero","type":"command_execution","status":"completed","exit_code":0,"aggregated_output":"Get-ChildItem : Access is denied.\n    + CategoryInfo : PermissionDenied\n    + FullyQualifiedErrorId : UnauthorizedAccessException"}}"#);
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::ToolEnd {status,reason:Some(_),..} if status == "failed")));
    }
    #[test]
    fn codex_resumes_only_its_own_id_and_does_not_duplicate_message_updates() {
        let mut stream = Stream::new(Provider::Codex);
        stream.fold_line(
            r#"{"type":"thread.started","thread_id":"62c2d305-9dd5-4c94-b4c0-667eb612f401"}"#,
        );
        assert!(stream.session_id.is_some());
        assert_eq!(stream.fold_line(r#"{"type":"item.updated","item":{"id":"one","type":"agent_message","text":"Hello"}}"#), vec![Event::AssistantDelta { text: "Hello".into() }]);
        assert_eq!(stream.fold_line(r#"{"type":"item.completed","item":{"id":"one","type":"agent_message","text":"Hello there"}}"#), vec![Event::AssistantDelta { text: " there".into() }]);
        assert!(stream.fold_line(r#"{"type":"item.completed","item":{"id":"one","type":"agent_message","text":"Hello there"}}"#).is_empty());
        assert!(
            matches!(&stream.fold_line(r#"{"type":"turn.failed","error":{"message":"Sign in required"}}"#)[0], Event::TurnEnd { status, reason: Some(reason), .. } if status == "failed" && reason == "Sign in required")
        );
    }
    #[test]
    fn antigravity_streams_tools_and_terminal_failures() {
        let mut stream = Stream::new(Provider::Antigravity);
        let events = stream.fold_line(r#"{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_name":"run_command","state":"DONE","tool_info":{"output":"result"}}}"#);
        assert!(matches!(&events[0], Event::ToolStart { name, .. } if name == "run_command"));
        assert!(matches!(&events[2], Event::ToolEnd { status, .. } if status == "completed"));
        assert!(
            matches!(&stream.fold_line(r#"{"event":"result","result":{"status":"ERROR","error":"Authentication required"}}"#)[0], Event::TurnEnd { status, .. } if status == "failed")
        );
        assert!(stream.fold_line("not json").is_empty());
    }
}
