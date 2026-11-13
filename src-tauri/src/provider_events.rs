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
    claude_msg_id: Option<String>,
    /// Claude tool calls whose one-line detail has already reached the card.
    claude_detailed: HashSet<String>,
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
fn extract_antigravity_detail(tool_name: &Value, step: &Value, info: &Value) -> Option<String> {
    let name = tool_name.as_str().unwrap_or_default();
    let params = if info["parameters"].is_object() {
        &info["parameters"]
    } else if step["parameters"].is_object() {
        &step["parameters"]
    } else if step["args"].is_object() {
        &step["args"]
    } else {
        return None;
    };
    match name {
        "run_command" | "execute_command" | "powershell" | "bash" | "sh" | "cmd" => params
            .get("CommandLine")
            .or_else(|| params.get("command"))
            .or_else(|| params.get("toolSummary"))
            .and_then(Value::as_str)
            .map(|s| bounded(s.trim())),
        "read_file" | "write_file" | "edit_file" | "inspect_file" | "delete_file" => params
            .get("Path")
            .or_else(|| params.get("path"))
            .and_then(Value::as_str)
            .map(|s| bounded(s.trim())),
        "search_web" | "web_search" | "workspace_search" | "vault_search" | "search" => params
            .get("query")
            .or_else(|| params.get("q"))
            .and_then(Value::as_str)
            .map(|s| bounded(s.trim())),
        _ => params
            .get("toolSummary")
            .or_else(|| params.get("Path"))
            .or_else(|| params.get("query"))
            .or_else(|| params.get("CommandLine"))
            .and_then(Value::as_str)
            .map(|s| bounded(s.trim())),
    }
}
fn extract_claude_detail(input: &Value) -> Option<String> {
    if !input.is_object() {
        return None;
    }
    [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
    ]
    .iter()
    .find_map(|key| input.get(*key).and_then(Value::as_str))
    .map(|s| bounded(s.trim()))
}
fn claude_tool_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["text"].as_str().or_else(|| item.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
/// Tool inputs can carry whole files. Cards and the session log need their
/// shape, not every byte, so long strings and collections are capped.
pub(crate) fn bounded_input(value: &Value) -> Value {
    const STRING_CHARS: usize = 16_000;
    fn walk(value: &Value, budget: &mut usize, depth: usize) -> Value {
        match value {
            Value::String(text) => {
                let keep = (*budget).min(STRING_CHARS);
                let mut chars = text.chars();
                let mut kept: String = chars.by_ref().take(keep).collect();
                *budget = budget.saturating_sub(kept.len());
                if chars.next().is_some() {
                    kept.push_str("\n…[truncated]");
                }
                Value::String(kept)
            }
            Value::Array(items) if depth < 8 => Value::Array(
                items
                    .iter()
                    .take(200)
                    .map(|item| walk(item, budget, depth + 1))
                    .collect(),
            ),
            Value::Object(fields) if depth < 8 => Value::Object(
                fields
                    .iter()
                    .take(100)
                    .map(|(key, item)| (key.clone(), walk(item, budget, depth + 1)))
                    .collect(),
            ),
            Value::Array(_) | Value::Object(_) => Value::Null,
            other => other.clone(),
        }
    }
    walk(value, &mut 64_000, 0)
}
/// Claude subscription windows (five-hour, weekly) from `rate_limit_event`.
fn claude_rate_limit(info: &Value) -> Option<Event> {
    let status = info["status"].as_str()?.to_owned();
    let window = |name: &str, value: &Value| crate::events::LimitWindow {
        name: name.into(),
        utilization: value["utilization"]
            .as_f64()
            .filter(|used| used.is_finite() && *used >= 0.0),
        resets_at: value["resetsAt"].as_i64().filter(|at| *at > 0),
    };
    let mut windows: Vec<_> = info["unifiedWindows"]
        .as_object()
        .into_iter()
        .flatten()
        .take(8)
        .map(|(name, value)| window(name, value))
        .collect();
    if windows.is_empty() {
        windows.push(window(
            info["rateLimitType"].as_str().unwrap_or("usage"),
            info,
        ));
    }
    Some(Event::RateLimit { status, windows })
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
            claude_msg_id: None,
            claude_detailed: HashSet::new(),
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
        self.fold_value(value)
    }
    /// Fold one already parsed record from a JSON provider stream.
    pub fn fold_value(&mut self, value: Value) -> Vec<Event> {
        match self.provider {
            Provider::Codex => self.codex(value),
            Provider::Claude => self.claude(value),
            Provider::Antigravity => self.antigravity(value),
            Provider::Muse => self.muse.fold_line(&value.to_string()),
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
                    let detail = match kind {
                        "command_execution" => text(item, "command"),
                        "web_search" => text(item, "query"),
                        "mcp_tool_call" => text(item, "tool"),
                        _ => String::new(),
                    };
                    events.push(Event::ToolStart {
                        task_id: id.clone(),
                        name: match kind {
                            "command_execution" => "Shell",
                            "file_change" => "File changes",
                            "web_search" => "Web search",
                            _ => "MCP tool",
                        }
                        .into(),
                        detail: if detail.is_empty() {
                            None
                        } else {
                            Some(detail.clone())
                        },
                    });
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
                    let status = if item["status"] == "declined"
                        || shell_error
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
    fn claude(&mut self, value: Value) -> Vec<Event> {
        self.remember(&value["session_id"]);
        // Subagent records keep their tools nested and never join the answer.
        let parent = value["parent_tool_use_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        match value["type"].as_str().unwrap_or_default() {
            "system" => match value["subtype"].as_str().unwrap_or_default() {
                "init" => vec![Event::Activity {
                    text: "Thinking…".into(),
                }],
                "api_retry" => crate::provider_progress::claude_retry(
                    &value,
                    crate::provider_progress::now_ms(),
                )
                .map(|progress| vec![Event::ProviderProgress { progress }])
                .unwrap_or_default(),
                "status" if value["status"] == "compacting" => vec![Event::Activity {
                    text: "Compacting context…".into(),
                }],
                "session_state_changed" if value["state"] == "requires_action" => {
                    vec![Event::Activity {
                        text: "Waiting for your response…".into(),
                    }]
                }
                _ => vec![],
            },
            "rate_limit_event" => claude_rate_limit(&value["rate_limit_info"])
                .into_iter()
                .collect(),
            "stream_event" if parent.is_none() => {
                let ev = &value["event"];
                let block_id = || {
                    format!(
                        "{}:{}",
                        self.claude_msg_id.as_deref().unwrap_or("current"),
                        ev["index"].as_u64().unwrap_or_default()
                    )
                };
                match ev["type"].as_str().unwrap_or_default() {
                    "message_start" => {
                        self.claude_msg_id = ev["message"]["id"].as_str().map(str::to_owned);
                        vec![]
                    }
                    "content_block_start" => {
                        match ev["content_block"]["type"].as_str().unwrap_or_default() {
                            "thinking" | "redacted_thinking" => vec![
                                Event::Activity {
                                    text: "Thinking…".into(),
                                },
                                Event::Reasoning {
                                    id: block_id(),
                                    text: String::new(),
                                },
                            ],
                            // Open the card while a large input (a file write)
                            // is still streaming; its input arrives with the
                            // completed assistant record.
                            "tool_use" => {
                                let block = &ev["content_block"];
                                match block["id"].as_str().filter(|id| !id.is_empty()) {
                                    Some(id) if self.tools.insert(id.to_owned()) => {
                                        vec![Event::ToolStart {
                                            task_id: id.to_owned(),
                                            name: text(block, "name"),
                                            detail: None,
                                        }]
                                    }
                                    _ => vec![],
                                }
                            }
                            _ => vec![],
                        }
                    }
                    "content_block_delta" => match ev["delta"]["type"].as_str().unwrap_or_default()
                    {
                        "text_delta" => {
                            let delta = text(&ev["delta"], "text");
                            if delta.is_empty() {
                                return vec![];
                            }
                            let key = format!(
                                "claude-msg:{}",
                                self.claude_msg_id.as_deref().unwrap_or("current")
                            );
                            self.text.entry(key).or_default().push_str(&delta);
                            vec![Event::AssistantDelta { text: delta }]
                        }
                        "thinking_delta" => {
                            let delta = text(&ev["delta"], "thinking");
                            if delta.is_empty() {
                                return vec![];
                            }
                            vec![Event::Reasoning {
                                id: block_id(),
                                text: delta,
                            }]
                        }
                        _ => vec![],
                    },
                    _ => vec![],
                }
            }
            "assistant" => {
                let msg = &value["message"];
                let msg_id = msg["id"].as_str().unwrap_or("current").to_owned();
                let mut events = vec![];
                let mut full_text = String::new();
                if let Some(blocks) = msg["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str().unwrap_or_default() {
                            "text" if parent.is_none() => {
                                full_text.push_str(block["text"].as_str().unwrap_or_default());
                            }
                            "tool_use" => {
                                let name = text(block, "name");
                                if name == "TodoWrite" && parent.is_none() {
                                    if let Some(items) = block["input"]["todos"].as_array() {
                                        let todos = items
                                            .iter()
                                            .filter_map(|item| {
                                                let text = item["content"]
                                                    .as_str()
                                                    .or_else(|| item["text"].as_str())?
                                                    .to_owned();
                                                let status = item["status"]
                                                    .as_str()
                                                    .unwrap_or("pending")
                                                    .to_owned();
                                                Some(crate::events::TodoItem { text, status })
                                            })
                                            .collect::<Vec<_>>();
                                        events.push(Event::Todos { items: todos });
                                    }
                                }
                                let Some(id) = block["id"]
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned)
                                else {
                                    continue;
                                };
                                let detail = extract_claude_detail(&block["input"]);
                                if self.tools.insert(id.clone()) {
                                    events.push(Event::ToolStart {
                                        task_id: id.clone(),
                                        name,
                                        detail: detail.clone(),
                                    });
                                }
                                // Repeated records for one call carry the same
                                // input; the card keeps the latest copy.
                                events.push(Event::ToolInput {
                                    task_id: id.clone(),
                                    detail: detail.clone(),
                                    input: bounded_input(&block["input"]),
                                    parent: parent.clone(),
                                });
                                if let Some(d) = detail.filter(|s| !s.is_empty()) {
                                    if self.claude_detailed.insert(id.clone()) {
                                        events.push(Event::ToolDelta {
                                            task_id: id,
                                            text: format!("{d}\n"),
                                        });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if !full_text.is_empty() {
                    let addition =
                        self.append(&format!("claude-msg:{msg_id}"), bounded(&full_text));
                    if !addition.is_empty() {
                        events.push(Event::AssistantDelta { text: addition });
                    }
                }
                events
            }
            "user" => {
                let mut events = vec![];
                if let Some(blocks) = value["message"]["content"].as_array() {
                    for block in blocks {
                        if block["type"] != "tool_result" {
                            continue;
                        }
                        let Some(id) = block["tool_use_id"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                        else {
                            continue;
                        };
                        let output = claude_tool_content(&block["content"]);
                        let is_error = block["is_error"].as_bool().unwrap_or(false);
                        let shell_failure =
                            if is_error || crate::workspace_access::powershell_error(&output) {
                                crate::workspace_access::failure(&output)
                            } else {
                                None
                            };
                        let status = if shell_failure
                            .is_some_and(|(s, _, _)| s == crate::workspace_access::Status::Blocked)
                        {
                            "blocked"
                        } else if is_error || shell_failure.is_some() {
                            "failed"
                        } else {
                            "completed"
                        };
                        if !output.is_empty() {
                            events.push(Event::ToolDelta {
                                task_id: id.clone(),
                                text: bounded(&crate::events::tool_text(output.clone())),
                            });
                        }
                        events.push(Event::ToolEnd {
                            task_id: id,
                            status: status.into(),
                            reason: shell_failure.map(|(_, detail, _)| detail.into()).or_else(
                                || {
                                    (status != "completed" && !output.is_empty())
                                        .then(|| bounded(&output))
                                },
                            ),
                        });
                    }
                }
                events
            }
            "result" => {
                let is_error = value["is_error"].as_bool().unwrap_or(false);
                let subtype = value["subtype"].as_str().unwrap_or_default();
                let denied = value["permission_denials"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty());
                let status = if denied {
                    "blocked"
                } else if is_error || subtype.starts_with("error") {
                    "failed"
                } else {
                    "completed"
                };
                let resp_text = text(&value, "result");
                let error_text = value["errors"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                    .filter(|s| !s.is_empty());
                let reason = if status == "blocked" {
                    Some("Claude denied a tool under the current permissions. Review permissions in Terminal or enable Full auto if appropriate, then retry.".into())
                } else if status == "failed" {
                    error_text.or_else(|| (!resp_text.is_empty()).then(|| resp_text.clone()))
                } else {
                    None
                };
                let mut events = vec![];
                if let Some(turn) = crate::provider_usage::claude_turn(&value) {
                    events.push(Event::Usage {
                        context: None,
                        turn: Some(turn),
                    });
                }
                events.push(end(status, Some(resp_text), reason));
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
                let mut status = match result["status"].as_str() {
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
                let resp_text = text(result, "response");
                let mut reason = if status == "blocked" {
                    Some("Antigravity denied a tool under the current permissions. Review the command with /permissions in Terminal, or add a scoped rule such as \"command(...)\" under permissions.allow in ~/.gemini/antigravity-cli/settings.json; allow only what is needed, then retry.".into())
                } else {
                    error(&result["error"])
                };
                if status == "failed"
                    && reason
                        .as_deref()
                        .is_some_and(|e| e.contains("Function call is empty"))
                {
                    if !resp_text.is_empty() {
                        status = "completed";
                        reason = None;
                    } else {
                        reason = Some("Antigravity completed its turn without visible text. Please send a follow-up message to continue.".into());
                    }
                }
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
                events.push(end(status, Some(resp_text), reason));
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
                    let detail =
                        extract_antigravity_detail(&step["tool_name"], step, &step["tool_info"]);
                    events.push(Event::ToolStart {
                        task_id: id.clone(),
                        name: text(step, "tool_name"),
                        detail,
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
    #[test]
    fn antigravity_empty_function_call_glitch_recovers_when_response_is_present() {
        let mut stream = Stream::new(Provider::Antigravity);
        let events = stream.fold_line(r#"{"event":"result","result":{"status":"ERROR","response":"Task completed.","error":"Malformed function call: Failed to parse function call: Function call is empty - no input to parse."}}"#);
        assert!(
            matches!(&events[0], Event::TurnEnd { status, text: Some(t), reason: None } if status == "completed" && t == "Task completed.")
        );

        let mut empty_stream = Stream::new(Provider::Antigravity);
        let events = empty_stream.fold_line(r#"{"event":"result","result":{"status":"ERROR","response":"","error":"Malformed function call: Failed to parse function call: Function call is empty - no input to parse."}}"#);
        assert!(
            matches!(&events[0], Event::TurnEnd { status, reason: Some(r), .. } if status == "failed" && r.contains("without visible text"))
        );
    }
    #[test]
    fn claude_deduplicates_streamed_text_and_folds_tools_and_usage() {
        let mut stream = Stream::new(Provider::Claude);
        let sid = "62c2d305-9dd5-4c94-b4c0-667eb612f401";
        assert!(matches!(
            &stream.fold_line(&format!(r#"{{"type":"system","subtype":"init","session_id":"{sid}"}}"#))[0],
            Event::Activity { text } if text == "Thinking…"
        ));
        assert_eq!(stream.session_id.as_deref(), Some(sid));
        assert!(stream.fold_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}"#).is_empty());
        assert_eq!(
            stream.fold_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}}"#),
            vec![Event::AssistantDelta { text: "Hi ".into() }]
        );
        // Full assistant message repeats already-streamed prefix, plus starts a Bash tool.
        let assistant = stream.fold_line(r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hi there"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"git status"}}]}}"#);
        assert!(assistant.contains(&Event::AssistantDelta {
            text: "there".into()
        }));
        assert!(assistant.contains(&Event::ToolStart {
            task_id: "tu_1".into(),
            name: "Bash".into(),
            detail: Some("git status".into())
        }));
        let user = stream.fold_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"clean","is_error":false}]}}"#);
        assert!(user.contains(&Event::ToolEnd {
            task_id: "tu_1".into(),
            status: "completed".into(),
            reason: None
        }));
        let result = stream.fold_line(r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":450,"result":"Hi there","usage":{"input_tokens":10,"cache_read_input_tokens":4,"output_tokens":2}}"#);
        assert!(
            matches!(&result[0], Event::Usage { turn: Some(t), .. } if t.input_tokens == Some(10) && t.elapsed_ms == Some(450))
        );
        assert!(matches!(&result[1], Event::TurnEnd { status, .. } if status == "completed"));
    }
    #[test]
    fn claude_streams_reasoning_opens_tools_early_and_attaches_structured_input() {
        let mut stream = Stream::new(Provider::Claude);
        stream.fold_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_2"}},"parent_tool_use_id":null}"#);
        let start = stream.fold_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"parent_tool_use_id":null}"#);
        assert!(start.contains(&Event::Reasoning {
            id: "msg_2:0".into(),
            text: String::new()
        }));
        assert_eq!(
            stream.fold_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking the tests first."}},"parent_tool_use_id":null}"#),
            vec![Event::Reasoning {
                id: "msg_2:0".into(),
                text: "Checking the tests first.".into()
            }]
        );
        // Shape captured from Claude Code 2.1.302: the card opens while the
        // input is still streaming.
        assert_eq!(
            stream.fold_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"Edit","input":{},"caller":{"type":"direct"}}},"parent_tool_use_id":null}"#),
            vec![Event::ToolStart {
                task_id: "toolu_01".into(),
                name: "Edit".into(),
                detail: None
            }]
        );
        let line = r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"toolu_01","name":"Edit","input":{"file_path":"src/lib.rs","old_string":"a","new_string":"b"}}]},"parent_tool_use_id":null}"#;
        let assistant = stream.fold_line(line);
        assert!(!assistant
            .iter()
            .any(|e| matches!(e, Event::ToolStart { .. })));
        assert!(assistant.contains(&Event::ToolInput {
            task_id: "toolu_01".into(),
            detail: Some("src/lib.rs".into()),
            input: serde_json::json!({"file_path":"src/lib.rs","old_string":"a","new_string":"b"}),
            parent: None,
        }));
        assert!(assistant.contains(&Event::ToolDelta {
            task_id: "toolu_01".into(),
            text: "src/lib.rs\n".into()
        }));
        // A repeated record refreshes the input without repeating the detail line.
        let again = stream.fold_line(line);
        assert!(again.iter().any(|e| matches!(e, Event::ToolInput { .. })));
        assert!(!again.iter().any(|e| matches!(e, Event::ToolDelta { .. })));
    }
    #[test]
    fn claude_subagent_text_stays_out_of_the_answer_while_its_tools_nest() {
        let mut stream = Stream::new(Provider::Claude);
        assert!(stream
            .fold_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"inner"}},"parent_tool_use_id":"toolu_task"}"#)
            .is_empty());
        let events = stream.fold_line(r#"{"type":"assistant","message":{"id":"msg_sub","content":[{"type":"text","text":"Subagent notes"},{"type":"tool_use","id":"toolu_inner","name":"Grep","input":{"pattern":"TODO"}}]},"parent_tool_use_id":"toolu_task"}"#);
        assert!(!events
            .iter()
            .any(|e| matches!(e, Event::AssistantDelta { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            Event::ToolInput { task_id, parent: Some(parent), .. }
                if task_id == "toolu_inner" && parent == "toolu_task"
        )));
    }
    #[test]
    fn claude_rate_limits_report_each_subscription_window() {
        use crate::events::LimitWindow;
        let mut stream = Stream::new(Provider::Claude);
        // Captured from Claude Code 2.1.302 on a Claude Pro sign-in.
        let events = stream.fold_line(r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794540600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.56,"resetsAt":1794540600},"seven_day":{"utilization":0.24,"resetsAt":1795032000}}},"uuid":"c06bdb5e","session_id":"8c85e3f8-d20b-49ad-89f0-2efc8b8506bc"}"#);
        assert_eq!(
            events,
            vec![Event::RateLimit {
                status: "allowed".into(),
                windows: vec![
                    LimitWindow {
                        name: "five_hour".into(),
                        utilization: Some(0.56),
                        resets_at: Some(1794540600)
                    },
                    LimitWindow {
                        name: "seven_day".into(),
                        utilization: Some(0.24),
                        resets_at: Some(1795032000)
                    },
                ]
            }]
        );
        // Records without unified windows still describe the active window.
        let events = stream.fold_line(r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1794540600,"rateLimitType":"five_hour","utilization":0.9}}"#);
        assert_eq!(
            events,
            vec![Event::RateLimit {
                status: "allowed_warning".into(),
                windows: vec![LimitWindow {
                    name: "five_hour".into(),
                    utilization: Some(0.9),
                    resets_at: Some(1794540600)
                }]
            }]
        );
    }
    #[test]
    fn bounded_input_caps_large_file_contents_but_keeps_shape() {
        let input = serde_json::json!({"file_path":"a.txt","content":"x".repeat(40_000)});
        let value = bounded_input(&input);
        let content = value["content"].as_str().unwrap();
        assert!(content.ends_with("…[truncated]"));
        assert!(content.len() < 20_000);
        assert_eq!(value["file_path"], "a.txt");
    }
}
