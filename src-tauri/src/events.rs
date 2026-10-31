//! Fold `muse exec --json` JSONL lines into UI-ready [`AgentEvent`]s.
//!
//! The `--json` stream uses a dotted `payload_type` vocabulary
//! (`turn.input.user`, `run.output.delta`, `task.lifecycle.*`, `tool.result`,
//! `todo.snapshot.updated`, `approval.*`, ...). Record shapes were captured
//! from real CLI 1.4.0 output; the fold stays tolerant — unknown types and
//! missing fields are skipped, never fatal — because the vocabulary evolves
//! faster than this app.
//!
//! Non-tool task progress (`task.lifecycle.started` / `.status`) folds into
//! fleeting [`AgentEvent::Activity`] detail so long model calls and reminder
//! wrap-up never look like a stuck spinner.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Cap for bulky text (tool results, deltas) so one giant read can't flood
/// the event channel. The UI truncates display further.
const MAX_TEXT_CHARS: usize = 12_000;
const TRUNCATED_MARKER: &str = "\n…[truncated]";

/// Cap for one-line activity detail shown in the status bar / spinner.
const MAX_ACTIVITY_CHARS: usize = 120;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TodoItem {
    pub text: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    QueueState {
        queue: crate::message_queue::Snapshot,
        #[serde(default)]
        running: bool,
    },
    ProviderProgress {
        progress: crate::provider_progress::Progress,
    },
    Usage {
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<crate::provider_usage::ContextUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<crate::provider_usage::TurnUsage>,
    },
    UsageReset,
    TurnMetrics {
        measurement: crate::tool_bridge::Measurement,
    },
    BotIdentity {
        bot: crate::bots::Identity,
    },
    MemoryContext {
        titles: Vec<String>,
        bytes: usize,
        budget_bytes: usize,
    },
    TurnStart {
        prompt: String,
        remote: bool,
        #[serde(default)]
        queued: bool,
    },
    UserMessage {
        text: String,
    },
    AssistantDelta {
        text: String,
    },
    TurnEnd {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    ToolStart {
        task_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    ToolPolicy {
        task_id: String,
        decision: String,
    },
    ToolDelta {
        task_id: String,
        text: String,
    },
    ToolEnd {
        task_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    ToolResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        text: String,
    },
    Todos {
        items: Vec<TodoItem>,
    },
    Approval {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
        summary: String,
    },
    Notice {
        text: String,
    },
    /// Fleeting progress detail ("Thinking…", "opening model stream…").
    /// Shown in the running indicator; never persisted as a chat block.
    Activity {
        text: String,
    },
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// First present string among `keys`, searching `value` then its `event`
/// object (dotted records nest the body under `event`, some under `result`).
fn first_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = str_field(value, key) {
            return Some(s);
        }
    }
    for nest in ["event", "result"] {
        if let Some(inner) = value.get(nest) {
            for key in keys {
                if let Some(s) = str_field(inner, key) {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn truncate(mut text: String) -> String {
    if text.chars().count() > MAX_TEXT_CHARS {
        text = text.chars().take(MAX_TEXT_CHARS).collect();
        text.push_str(TRUNCATED_MARKER);
    }
    text
}

/// Transcript rendering never needs MCP image bytes. The original response
/// still goes directly to the provider; only derived UI/log events use this.
pub(crate) fn tool_output(value: &Value) -> String {
    fn summarize(value: &mut Value) {
        if value["type"] == "image" && value["data"].is_string() {
            let mime = value["mimeType"].as_str().unwrap_or("image").to_owned();
            *value = serde_json::json!({"type":"image","mimeType":mime,"delivery":"Image supplied to provider; binary data omitted from this transcript."});
            return;
        }
        match value {
            Value::Array(items) => items.iter_mut().for_each(summarize),
            Value::Object(object) => object.values_mut().for_each(summarize),
            _ => {}
        }
    }
    let mut display = value.clone();
    summarize(&mut display);
    display.to_string()
}

pub(crate) fn tool_text(text: String) -> String {
    if text.contains("\"image\"") && text.contains("\"data\"") {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            return tool_output(&value);
        }
    }
    text
}

fn is_tool_kind(kind: &str) -> bool {
    kind.starts_with("tool.")
}

fn tool_name(kind: &str) -> String {
    kind.strip_prefix("tool.").unwrap_or(kind).to_owned()
}

fn truncate_activity(text: String) -> String {
    if text.chars().count() > MAX_ACTIVITY_CHARS {
        let mut short: String = text.chars().take(MAX_ACTIVITY_CHARS).collect();
        short.push('…');
        short
    } else {
        text
    }
}

/// Friendly one-line label for a started non-tool task. Tool tasks already
/// surface as cards; everything else would otherwise be a silent gap.
fn activity_label(kind: &str) -> String {
    if kind.starts_with("model.") {
        return "Thinking…".to_owned();
    }
    if let Some(rest) = kind.strip_prefix("reminder.") {
        let lower = rest.to_ascii_lowercase();
        if lower.contains("verify") {
            return "Verifying…".to_owned();
        }
        if lower.contains("skill") {
            return "Checking skills…".to_owned();
        }
        return prettify_kind(rest);
    }
    prettify_kind(kind)
}

fn prettify_kind(kind: &str) -> String {
    let last = kind.rsplit('.').next().unwrap_or(kind);
    let spaced: String = last
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let mut chars = spaced.chars();
    let titled = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Working".to_owned(),
    };
    truncate_activity(format!("{titled}…"))
}

/// Join state across the lines of one turn: task kinds (to tell tool tasks
/// from model/reminder tasks at their terminal record) and `call_id` →
/// `task_id` (to attach `tool.result` records, which cite the call).
#[derive(Default)]
pub struct Fold {
    task_kinds: HashMap<String, String>,
    call_tasks: HashMap<String, String>,
}

impl Fold {
    fn remember_idempotency(&mut self, event: &Value, task_id: &str) {
        if let Some(key) = str_field(event, "idempotency_key") {
            if let Some(call_id) = key.strip_prefix("tool:") {
                self.call_tasks
                    .insert(call_id.to_owned(), task_id.to_owned());
            }
        }
    }

    fn task_id_of(&self, payload: &Value) -> Option<String> {
        first_str(payload, &["task_id", "taskId"])
    }

    /// Fold one `--json` output line into zero or more UI events.
    /// Garbage lines and unknown record types yield no events.
    pub fn fold_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let record: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let Some(record_type) = str_field(&record, "payload_type") else {
            return Vec::new();
        };
        let payload = record.get("payload").cloned().unwrap_or(Value::Null);
        match record_type.as_str() {
            "turn.input.user" => first_str(&payload, &["prompt", "displayText", "text"])
                .map(|text| AgentEvent::UserMessage { text })
                .into_iter()
                .collect(),
            "run.output.delta" => first_str(&payload, &["text", "delta"])
                .map(|text| AgentEvent::AssistantDelta { text })
                .into_iter()
                .collect(),
            "run.terminal.completed" | "run.terminal.failed" | "run.terminal.cancelled" => {
                let status = first_str(&payload, &["terminal"])
                    .unwrap_or_else(|| record_type["run.terminal.".len()..].to_owned());
                vec![AgentEvent::TurnEnd {
                    status,
                    text: first_str(&payload, &["text"]),
                    reason: first_str(&payload, &["reason"]),
                }]
            }
            "task.lifecycle.proposed" => {
                let event = payload.get("event").cloned().unwrap_or(Value::Null);
                let (Some(task_id), Some(kind)) =
                    (self.task_id_of(&payload), str_field(&event, "task_kind"))
                else {
                    return Vec::new();
                };
                self.task_kinds.insert(task_id.clone(), kind.clone());
                if is_tool_kind(&kind) {
                    vec![AgentEvent::ToolStart {
                        task_id,
                        name: tool_name(&kind),
                        detail: None,
                    }]
                } else {
                    Vec::new()
                }
            }
            "task.lifecycle.scheduled" => {
                let event = payload.get("event").cloned().unwrap_or(Value::Null);
                if let Some(task_id) = self.task_id_of(&payload) {
                    self.remember_idempotency(&event, &task_id);
                }
                Vec::new()
            }
            "task.lifecycle.side_effect_intent" => {
                let event = payload.get("event").cloned().unwrap_or(Value::Null);
                let Some(task_id) = self.task_id_of(&payload) else {
                    return Vec::new();
                };
                self.remember_idempotency(&event, &task_id);
                str_field(&event, "policy_decision")
                    .map(|decision| AgentEvent::ToolPolicy { task_id, decision })
                    .into_iter()
                    .collect()
            }
            "task.lifecycle.started" => {
                let Some(task_id) = self.task_id_of(&payload) else {
                    return Vec::new();
                };
                match self.task_kinds.get(&task_id) {
                    Some(kind) if !is_tool_kind(kind) => {
                        vec![AgentEvent::Activity {
                            text: activity_label(kind),
                        }]
                    }
                    _ => Vec::new(),
                }
            }
            "task.lifecycle.status" => {
                let event = payload.get("event").cloned().unwrap_or(Value::Null);
                if let Some(progress) = crate::provider_progress::muse(
                    &event["details"],
                    crate::provider_progress::now_ms(),
                ) {
                    return vec![
                        AgentEvent::Activity {
                            text: progress.message(),
                        },
                        AgentEvent::ProviderProgress { progress },
                    ];
                }
                str_field(&event, "message")
                    .map(|text| AgentEvent::Activity {
                        text: truncate_activity(text),
                    })
                    .into_iter()
                    .collect()
            }
            "task.lifecycle.tool_delta" => {
                let Some(task_id) = self.task_id_of(&payload) else {
                    return Vec::new();
                };
                first_str(&payload, &["text", "delta", "chunk"])
                    .map(|text| AgentEvent::ToolDelta {
                        task_id,
                        text: truncate(tool_text(text)),
                    })
                    .into_iter()
                    .collect()
            }
            "task.lifecycle.completed"
            | "task.lifecycle.failed"
            | "task.lifecycle.cancelled"
            | "task.lifecycle.rejected" => {
                let status = record_type["task.lifecycle.".len()..].to_owned();
                let Some(task_id) = self.task_id_of(&payload) else {
                    return Vec::new();
                };
                let reason = first_str(&payload, &["reason", "failureReason"]);
                let is_tool = self
                    .task_kinds
                    .get(&task_id)
                    .map(|k| is_tool_kind(k))
                    .unwrap_or(false);
                if is_tool {
                    vec![AgentEvent::ToolEnd {
                        task_id,
                        status,
                        reason,
                    }]
                } else if status == "failed" {
                    // A failed model/reminder task is worth surfacing; the
                    // turn often still completes around it.
                    let kind = self
                        .task_kinds
                        .get(&task_id)
                        .cloned()
                        .unwrap_or_else(|| "task".to_owned());
                    vec![AgentEvent::Notice {
                        text: match reason {
                            Some(r) => format!("{kind} failed: {r}"),
                            None => format!("{kind} failed"),
                        },
                    }]
                } else {
                    Vec::new()
                }
            }
            "tool.result" => {
                let call_id = first_str(&payload, &["call_id", "callId", "tool_call_id"]);
                let task_id = self.task_id_of(&payload).or_else(|| {
                    call_id
                        .as_ref()
                        .and_then(|c| self.call_tasks.get(c))
                        .cloned()
                });
                first_str(&payload, &["text", "output", "result", "chunk"])
                    .map(|text| AgentEvent::ToolResult {
                        task_id,
                        call_id,
                        text: truncate(tool_text(text)),
                    })
                    .into_iter()
                    .collect()
            }
            "todo.snapshot.updated" => {
                let items_value = payload
                    .get("event")
                    .and_then(|e| e.get("items"))
                    .or_else(|| payload.get("items"));
                match items_value.and_then(Value::as_array) {
                    Some(items) => vec![AgentEvent::Todos {
                        items: items
                            .iter()
                            .map(|item| TodoItem {
                                text: str_field(item, "text").unwrap_or_default(),
                                status: str_field(item, "status").unwrap_or_default(),
                            })
                            .collect(),
                    }],
                    None => Vec::new(),
                }
            }
            "approval.requested" | "approval.decided" | "approval.cancelled"
            | "approval.resolved" => {
                let status = record_type["approval.".len()..].to_owned();
                let tool = first_str(&payload, &["tool_name", "toolName", "tool"]);
                let summary = first_str(
                    &payload,
                    &[
                        "raw_command",
                        "rawCommand",
                        "raw_args",
                        "rawArgs",
                        "summary",
                        "text",
                    ],
                )
                .map(truncate)
                .unwrap_or_else(|| format!("approval {status}"));
                vec![AgentEvent::Approval {
                    status,
                    tool,
                    summary,
                }]
            }
            "user_shell.rejected" => first_str(&payload, &["reason", "text", "commandText"])
                .map(|text| AgentEvent::Notice {
                    text: format!("shell command rejected: {text}"),
                })
                .into_iter()
                .collect(),
            "user_shell.result" => first_str(&payload, &["text", "output", "result"])
                .map(|text| AgentEvent::ToolResult {
                    task_id: self.task_id_of(&payload),
                    call_id: None,
                    text: truncate(text),
                })
                .into_iter()
                .collect(),
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentEvent, Fold, TodoItem};

    #[test]
    fn image_tool_results_keep_metadata_without_binary_transcript_noise() {
        let image = serde_json::json!({"content":[{"type":"image","mimeType":"image/png","data":"private-image-binary"},{"type":"text","text":"Preview captured"}]});
        let line = serde_json::json!({"payload_type":"tool.result","payload":{"call_id":"screenshot","text":image.to_string()}}).to_string();
        let event = Fold::default().fold_line(&line);
        let AgentEvent::ToolResult { text, .. } = &event[0] else {
            panic!("Expected a tool result");
        };
        assert!(text.contains("image/png"));
        assert!(text.contains("Preview captured"));
        assert!(!text.contains("private-image-binary"));
        assert_eq!(super::tool_text("normal output".into()), "normal output");
        assert_eq!(image["content"][0]["data"], "private-image-binary");
    }

    // Verbatim records captured from `muse exec --json` (CLI 1.4.0); only
    // task_kind values were swapped where the echo provider never emits a
    // tool task (same record family, confirmed in session logs).
    const USER_LINE: &str = r#"{"schema_version":1,"id":"018f0000-0000-7000-8000-08ed1ef0b9e5","stream":{"kind":"session","id":"01a0d8ed-9999-7aaa-8aaa-aaaaaaaaaaaa"},"sequence":4,"recorded_at":1790345919314069,"record_type":"status","durability":"ephemeral","causation_id":"746994a5-aa83-444f-a884-4c175cd18d6a","payload_type":"turn.input.user","payload_schema_version":1,"payload":{"kind":"turn_input_user","command_id":"746994a5-aa83-444f-a884-4c175cd18d6a","run_stream":{"kind":"run","id":"746994a5-aa83-444f-a884-4c175cd18d6a"},"prompt":"second turn"}}"#;
    const DELTA_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":17,"recorded_at":1,"record_type":"status","durability":"ephemeral","causation_id":"c","payload_type":"run.output.delta","payload_schema_version":1,"payload":{"kind":"run_output_delta","command_id":"c","run_stream":{"kind":"run","id":"c"},"text":"echo: second turn"}}"#;
    const TERMINAL_LINE: &str = r#"{"schema_version":1,"id":"018f0000-0000-7000-8000-08ed1ef0ba15","stream":{"kind":"session","id":"01a0d8ed-9999-7aaa-8aaa-aaaaaaaaaaaa"},"sequence":28,"recorded_at":1790345919314117,"record_type":"event","durability":"durable","causation_id":"746994a5-aa83-444f-a884-4c175cd18d6a","payload_type":"run.terminal.completed","payload_schema_version":1,"payload":{"kind":"run_terminal","command_id":"746994a5-aa83-444f-a884-4c175cd18d6a","run_stream":{"kind":"run","id":"746994a5-aa83-444f-a884-4c175cd18d6a"},"terminal":"completed","text":"echo: second turn","reason":null}}"#;
    const FAILED_LINE: &str = r#"{"schema_version":1,"id":"018f0000-0000-7000-8000-08ed1ef0ba13","stream":{"kind":"session","id":"01a0d8ed-9999-7aaa-8aaa-aaaaaaaaaaaa"},"sequence":27,"recorded_at":1790345919314115,"record_type":"event","durability":"durable","causation_id":"746994a5-aa83-444f-a884-4c175cd18d6a","payload_type":"task.lifecycle.failed","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"746994a5-aa83-444f-a884-4c175cd18d6a","run_stream":{"kind":"run","id":"746994a5-aa83-444f-a884-4c175cd18d6a"},"task_stream":{"kind":"task","id":"01a0d8ee-e8c1-7141-8f41-a13c3b113e27"},"task_id":"01a0d8ee-e8c1-7141-8f41-a13c3b113e27","event":{"kind":"failed","task_id":"01a0d8ee-e8c1-7141-8f41-a13c3b113e27","reason":"invalid run configuration: provider does not support base instructions"}}}"#;
    const PROPOSED_TOOL_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":7,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.proposed","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"t1"},"task_id":"t1","event":{"kind":"proposed","task_id":"t1","task_kind":"tool.powershell"}}}"#;
    const PROPOSED_MODEL_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":13,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.proposed","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"m1"},"task_id":"m1","event":{"kind":"proposed","task_id":"m1","task_kind":"model.unknown.response"}}}"#;
    const SCHEDULED_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":8,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.scheduled","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"t1"},"task_id":"t1","event":{"kind":"scheduled","task_id":"t1","idempotency_key":"tool:call_abc"}}}"#;
    const INTENT_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":9,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.side_effect_intent","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"t1"},"task_id":"t1","event":{"kind":"side_effect_intent","task_id":"t1","operation":"tool:powershell","idempotency_key":"tool:call_abc","policy_decision":"allow:policy"}}}"#;
    const COMPLETED_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":10,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.completed","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"t1"},"task_id":"t1","event":{"kind":"completed","task_id":"t1"}}}"#;
    const TOOL_RESULT_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":11,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"tool.result","payload_schema_version":1,"payload":{"kind":"tool_result","command_id":"c","run_stream":{"kind":"run","id":"c"},"call_id":"call_abc","text":"hello"}}"#;
    const TODOS_LINE: &str = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":12,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"todo.snapshot.updated","payload_schema_version":1,"payload":{"kind":"todo_snapshot","event":{"kind":"todo_snapshot_updated","revision":1,"source_tool":"write_todos","items":[{"text":"Investigate","status":"in_progress"},{"text":"Design","status":"pending"}]}}}"#;

    #[test]
    fn user_prompt_becomes_user_message() {
        let mut fold = Fold::default();
        assert_eq!(
            fold.fold_line(USER_LINE),
            vec![AgentEvent::UserMessage {
                text: "second turn".to_owned()
            }]
        );
    }

    #[test]
    fn output_deltas_stream_through() {
        let mut fold = Fold::default();
        assert_eq!(
            fold.fold_line(DELTA_LINE),
            vec![AgentEvent::AssistantDelta {
                text: "echo: second turn".to_owned()
            }]
        );
    }

    #[test]
    fn terminal_record_ends_the_turn() {
        let mut fold = Fold::default();
        assert_eq!(
            fold.fold_line(TERMINAL_LINE),
            vec![AgentEvent::TurnEnd {
                status: "completed".to_owned(),
                text: Some("echo: second turn".to_owned()),
                reason: None,
            }]
        );
    }

    #[test]
    fn tool_task_lifecycle_folds_to_start_and_end() {
        let mut fold = Fold::default();
        assert_eq!(
            fold.fold_line(PROPOSED_TOOL_LINE),
            vec![AgentEvent::ToolStart {
                task_id: "t1".to_owned(),
                name: "powershell".to_owned(),
                detail: None,
            }]
        );
        assert!(fold.fold_line(SCHEDULED_LINE).is_empty());
        assert_eq!(
            fold.fold_line(INTENT_LINE),
            vec![AgentEvent::ToolPolicy {
                task_id: "t1".to_owned(),
                decision: "allow:policy".to_owned(),
            }]
        );
        assert_eq!(
            fold.fold_line(COMPLETED_LINE),
            vec![AgentEvent::ToolEnd {
                task_id: "t1".to_owned(),
                status: "completed".to_owned(),
                reason: None,
            }]
        );
    }

    #[test]
    fn tool_result_joins_call_id_to_task() {
        let mut fold = Fold::default();
        fold.fold_line(PROPOSED_TOOL_LINE);
        fold.fold_line(SCHEDULED_LINE);
        assert_eq!(
            fold.fold_line(TOOL_RESULT_LINE),
            vec![AgentEvent::ToolResult {
                task_id: Some("t1".to_owned()),
                call_id: Some("call_abc".to_owned()),
                text: "hello".to_owned(),
            }]
        );
    }

    #[test]
    fn failed_model_task_becomes_notice() {
        let mut fold = Fold::default();
        fold.fold_line(PROPOSED_MODEL_LINE);
        let mut failed = FAILED_LINE.replace("01a0d8ee-e8c1-7141-8f41-a13c3b113e27", "m1");
        // Keep the verbatim reason; only re-point the task id at the model task.
        let events = fold.fold_line(&failed);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::Notice { text } => {
                assert!(
                    text.starts_with("model.unknown.response failed: "),
                    "{text}"
                );
                assert!(text.contains("base instructions"), "{text}");
            }
            other => panic!("expected notice, got {other:?}"),
        }
        let _ = std::mem::take(&mut failed);
    }

    #[test]
    fn todo_snapshot_folds_items() {
        let mut fold = Fold::default();
        assert_eq!(
            fold.fold_line(TODOS_LINE),
            vec![AgentEvent::Todos {
                items: vec![
                    TodoItem {
                        text: "Investigate".to_owned(),
                        status: "in_progress".to_owned(),
                    },
                    TodoItem {
                        text: "Design".to_owned(),
                        status: "pending".to_owned(),
                    },
                ]
            }]
        );
    }

    #[test]
    fn task_status_message_becomes_activity() {
        // Shape captured live from CLI 1.4.0 (`task.lifecycle.status`).
        let mut fold = Fold::default();
        let line = r#"{"schema_version":1,"stream":{"kind":"session","id":"s"},"sequence":18,"recorded_at":1,"record_type":"event","durability":"durable","causation_id":"c","payload_type":"task.lifecycle.status","payload_schema_version":1,"payload":{"kind":"task_lifecycle","command_id":"c","run_stream":{"kind":"run","id":"c"},"task_stream":{"kind":"task","id":"m1"},"task_id":"m1","event":{"kind":"status","task_id":"m1","message":"opening meta model stream attempt 1/10","details":{"phase":"opening_stream"}}}}"#;
        let events = fold.fold_line(line);
        assert!(
            matches!(&events[0], AgentEvent::Activity { text } if text == "Connecting to Muse…")
        );
        assert!(
            matches!(&events[1], AgentEvent::ProviderProgress { progress } if progress.phase == crate::provider_progress::Phase::Connecting)
        );
        // A status without a message carries no displayable detail.
        assert!(fold
            .fold_line(
                r#"{"payload_type":"task.lifecycle.status","payload":{"event":{"kind":"status"}}}"#
            )
            .is_empty());
    }

    #[test]
    fn muse_retry_details_reach_ui_and_diagnostics_as_safe_structured_progress() {
        let mut fold = Fold::default();
        let events = fold.fold_line(r#"{"payload_type":"task.lifecycle.status","payload":{"event":{"kind":"status","message":"retrying meta model stream in 60000ms (attempt 2/10)","details":{"phase":"retry_scheduled","facets":[{"kind":"external_attempt","system":"meta","operation":"model.response","attempt":1,"next_attempt":2,"max_attempts":10,"http_status":503,"retry_delay_ms":60000},{"kind":"producer","detail":{"request_id":"PRIVATE"}}]}}}}"#);
        assert!(matches!(&events[0], AgentEvent::Activity{text} if text.contains("HTTP 503")));
        assert!(
            matches!(&events[1], AgentEvent::ProviderProgress{progress} if progress.http_status == Some(503) && progress.attempt == Some(2))
        );
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn started_non_tool_tasks_become_activity() {
        let mut fold = Fold::default();
        fold.fold_line(PROPOSED_MODEL_LINE);
        assert_eq!(
            fold.fold_line(r#"{"payload_type":"task.lifecycle.started","payload":{"task_id":"m1","event":{"kind":"started","task_id":"m1"}}}"#),
            vec![AgentEvent::Activity {
                text: "Thinking…".to_owned()
            }]
        );
        let mut fold = Fold::default();
        fold.fold_line(r#"{"payload_type":"task.lifecycle.proposed","payload":{"task_id":"v1","event":{"kind":"proposed","task_id":"v1","task_kind":"reminder.agent.verify-reminder"}}}"#);
        assert_eq!(
            fold.fold_line(r#"{"payload_type":"task.lifecycle.started","payload":{"task_id":"v1","event":{"kind":"started","task_id":"v1"}}}"#),
            vec![AgentEvent::Activity {
                text: "Verifying…".to_owned()
            }]
        );
        // Tool tasks already surface as cards; unknown tasks stay silent.
        let mut fold = Fold::default();
        fold.fold_line(PROPOSED_TOOL_LINE);
        assert!(fold
            .fold_line(r#"{"payload_type":"task.lifecycle.started","payload":{"task_id":"t1","event":{"kind":"started","task_id":"t1"}}}"#)
            .is_empty());
        assert!(fold
            .fold_line(r#"{"payload_type":"task.lifecycle.started","payload":{"task_id":"ghost","event":{"kind":"started","task_id":"ghost"}}}"#)
            .is_empty());
    }

    #[test]
    fn long_activity_detail_is_capped() {
        let mut fold = Fold::default();
        let big = "w".repeat(500);
        let line = format!(
            r#"{{"payload_type":"task.lifecycle.status","payload":{{"event":{{"kind":"status","message":"{big}"}}}}}}"#
        );
        let events = fold.fold_line(&line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::Activity { text } => {
                assert!(text.ends_with('…'));
                assert!(text.chars().count() <= 121);
            }
            other => panic!("expected activity, got {other:?}"),
        }
    }

    #[test]
    fn unknown_types_and_garbage_are_ignored() {
        let mut fold = Fold::default();
        assert!(fold.fold_line("").is_empty());
        assert!(fold.fold_line("not json at all").is_empty());
        assert!(fold
            .fold_line(r#"{"payload_type":"runtime.session.route_facts","payload":{}}"#)
            .is_empty());
        assert!(fold.fold_line(r#"{"no_payload_type":true}"#).is_empty());
        // Missing task_id must not panic, just yield nothing.
        assert!(fold.fold_line(r#"{"payload_type":"task.lifecycle.completed","payload":{"event":{"kind":"completed"}}}"#).is_empty());
    }

    #[test]
    fn bulky_tool_results_are_capped() {
        let mut fold = Fold::default();
        let big = "x".repeat(20_000);
        let line = format!(
            r#"{{"payload_type":"tool.result","payload":{{"call_id":"c","text":"{big}"}}}}"#
        );
        let events = fold.fold_line(&line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::ToolResult { text, .. } => {
                assert!(text.ends_with("…[truncated]"));
                assert!(text.len() < big.len());
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }
}
