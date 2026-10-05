//! Fold Muse MSP view notifications into UI-ready [`AgentEvent`]s.
//!
//! The caller filters notifications to the active session/turn and handles
//! all approval/userInput RPC traffic separately. This fold therefore never
//! decides permissions and never creates approval UI state: it only renders
//! transcript, progress, todo, and usage facts.
//!
//! Supported methods (Muse 1.4.2, `.qa/permissions/muse-schema`):
//! `item/started`, `item/delta`, `item/updated`, `item/completed`,
//! `turn/completed`, `session/todoListChanged`, `session/contextUsage`,
//! `session/tokenUsage`. Everything else (including `turn/started`, all
//! `approval/*` and `userInput/*` traffic, and `rawLog`, which the installed
//! schema reserves as unsupported) yields no events. Unknown item kinds are
//! ignored without approving anything.
//!
//! Deduplication rules, from the schema apply semantics:
//! - `item/delta` appends stream text immediately; a later full snapshot
//!   (`item/updated`, `item/completed`) emits only text not already streamed.
//! - `item/updated` replaces state only when its `revision` is newer; stale
//!   revisions never overwrite newer items.
//! - `item/completed` for an unseen id is accepted (single-shot kinds, gap
//!   fills) and emits the full terminal content once.

use crate::events::AgentEvent;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Cap for bulky text so one giant item can't flood the event channel.
const MAX_TEXT_CHARS: usize = 64_000;
const TRUNCATED_MARKER: &str = "\n…[truncated]";

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn truncate(mut text: String) -> String {
    if text.chars().count() > MAX_TEXT_CHARS {
        text = text.chars().take(MAX_TEXT_CHARS).collect();
        text.push_str(TRUNCATED_MARKER);
    }
    text
}

/// Normalize an item status into the transcript vocabulary. `inProgress` is
/// open; everything else is terminal, with unknown values terminal-unknown.
fn is_terminal_status(status: &str) -> bool {
    status != "inProgress"
}

/// Map an item status onto the `ToolEnd` status vocabulary shared with the
/// exec fold (`completed`/`failed`/`cancelled`/`rejected`, unknown kept
/// verbatim so newer values still render).
fn tool_status(status: &str) -> String {
    status.to_owned()
}

/// Map a `turn/completed` terminal onto the `TurnEnd` status vocabulary.
/// `completed`/`failed`/`cancelled` pass through. `blocked` passes through
/// when a newer server emits it. Any other unknown terminal is `failed`
/// only when an `error` object is present, else `blocked` is never invented
/// here — unknown bare terminals surface as `failed` so the runner never
/// reports success it did not see.
fn turn_status(terminal: &str, has_error: bool) -> String {
    match terminal {
        "completed" | "failed" | "cancelled" | "blocked" => terminal.to_owned(),
        _ if has_error => "failed".to_owned(),
        _ => "failed".to_owned(),
    }
}

fn counter(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
}

/// Per-item fold state: last accepted revision, what assistant/tool text was
/// already emitted (so full snapshots emit only the unseen suffix), and
/// whether lifecycle events were already emitted.
#[derive(Default)]
struct ItemState {
    revision: u64,
    kind: String,
    tool_name: Option<String>,
    emitted_text_len: usize,
    emitted_output_len: usize,
    started: bool,
    tool_start_emitted: bool,
    ended: bool,
}

#[derive(Default)]
pub struct View {
    items: HashMap<String, ItemState>,
    usage_cursors: HashSet<String>,
    turn_usage: Option<crate::provider_usage::TurnUsage>,
}

impl View {
    fn item_id(params: &Value) -> Option<String> {
        params
            .get("item")
            .and_then(|i| i.get("itemId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    }

    fn revision(item: &Value) -> u64 {
        item.get("revision").and_then(Value::as_u64).unwrap_or(0)
    }

    /// Fold one view notification into zero or more UI events. Unknown
    /// methods, missing fields, and stale revisions yield no events.
    pub fn observe(
        &mut self,
        method: &str,
        params: &serde_json::Value,
    ) -> Vec<crate::events::AgentEvent> {
        match method {
            "item/started" => self.on_item_full(params, false),
            "item/updated" => self.on_item_full(params, false),
            "item/completed" => self.on_item_full(params, true),
            "item/delta" => self.on_item_delta(params),
            "turn/completed" => Self::on_turn_completed(params),
            "session/todoListChanged" => Self::on_todos(params),
            "session/contextUsage" => Self::on_context_usage(params),
            "session/tokenUsage" => self.on_token_usage(params),
            _ => Vec::new(),
        }
    }

    /// Shared handler for `item/started`, `item/updated`, `item/completed`.
    /// Full snapshots emit only content not already streamed, keyed on the
    /// revision guard (replace iff higher). `item/completed` additionally
    /// closes tool items with `ToolEnd`.
    fn on_item_full(&mut self, params: &Value, terminal: bool) -> Vec<AgentEvent> {
        let item = match params.get("item") {
            Some(i) => i,
            None => return Vec::new(),
        };
        let item_id = match item.get("itemId").and_then(Value::as_str) {
            Some(id) => id.to_owned(),
            None => return Vec::new(),
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let revision = Self::revision(item);
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("inProgress")
            .to_owned();

        let state = self.items.entry(item_id.clone()).or_default();
        if revision > 0 && revision <= state.revision && state.revision > 0 {
            return Vec::new();
        }
        // A revision-0 snapshot (no revision field) is still newer than
        // nothing; once any revision was accepted, require a higher one.
        if revision == 0 && state.revision > 0 {
            return Vec::new();
        }
        state.revision = revision.max(state.revision);
        state.kind = kind.clone();
        let mut out = Vec::new();

        match kind.as_str() {
            "agentMessage" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                let streamed = state.emitted_text_len.min(text.chars().count());
                let fresh: String = text.chars().skip(streamed).collect();
                state.emitted_text_len = text.chars().count();
                if !fresh.is_empty() {
                    out.push(AgentEvent::AssistantDelta {
                        text: truncate(fresh),
                    });
                }
                if terminal {
                    state.ended = true;
                }
            }
            "reasoning" => {
                // Reasoning is never an assistant answer: surface only as
                // fleeting activity when a fresh summary part lands.
                let summary_count = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                if summary_count > 0 && !state.started {
                    out.push(AgentEvent::Activity {
                        text: "Thinking…".to_owned(),
                    });
                }
            }
            "toolCall" => {
                let name = item
                    .get("tool")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| "tool".to_owned());
                state.tool_name = Some(name.clone());
                if !state.tool_start_emitted {
                    state.tool_start_emitted = true;
                    out.push(AgentEvent::ToolStart {
                        task_id: item_id.clone(),
                        name,
                    });
                }
                let output = item
                    .get("visibleOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let streamed = state.emitted_output_len.min(output.chars().count());
                let fresh: String = output.chars().skip(streamed).collect();
                state.emitted_output_len = output.chars().count();
                if !fresh.is_empty() {
                    out.push(AgentEvent::ToolDelta {
                        task_id: item_id.clone(),
                        text: truncate(fresh),
                    });
                }
                if (terminal || is_terminal_status(&status)) && !state.ended {
                    state.ended = true;
                    let reason = str_field(item, "failureReason");
                    out.push(AgentEvent::ToolEnd {
                        task_id: item_id.clone(),
                        status: tool_status(&status),
                        reason,
                    });
                    // The output already arrived as deltas; repeating it
                    // as ToolResult duplicates the phone transcript.
                }
            }
            "userShell" => {
                let command = str_field(item, "commandText").unwrap_or_default();
                if !state.tool_start_emitted {
                    state.tool_start_emitted = true;
                    out.push(AgentEvent::ToolStart {
                        task_id: item_id.clone(),
                        name: if command.is_empty() {
                            "shell".to_owned()
                        } else {
                            command.clone()
                        },
                    });
                }
                let output = item
                    .get("visibleOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let streamed = state.emitted_output_len.min(output.chars().count());
                let fresh: String = output.chars().skip(streamed).collect();
                state.emitted_output_len = output.chars().count();
                if !fresh.is_empty() {
                    out.push(AgentEvent::ToolDelta {
                        task_id: item_id.clone(),
                        text: truncate(fresh),
                    });
                }
                if (terminal || is_terminal_status(&status)) && !state.ended {
                    state.ended = true;
                    let mut reason: Option<String> = None;
                    match (
                        item.get("exitCode").and_then(Value::as_i64),
                        item.get("exitSignal").and_then(Value::as_u64),
                    ) {
                        (Some(0), _) => {}
                        (Some(code), _) => {
                            reason = Some(format!("exit code {code}"));
                        }
                        (None, Some(sig)) => {
                            reason = Some(format!("signal {sig}"));
                        }
                        _ => {}
                    }
                    out.push(AgentEvent::ToolEnd {
                        task_id: item_id.clone(),
                        status: tool_status(&status),
                        reason,
                    });
                }
            }
            "userMessage" => {
                if item
                    .get("retracted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Vec::new();
                }
                // The runner owns the local echo and TurnStart; only steer
                // injections (mid-turn user messages the runner did not
                // submit) need a transcript line from the view.
                if item
                    .get("steered")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && !state.started
                {
                    state.started = true;
                    let text = item
                        .get("displayText")
                        .or_else(|| item.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !text.is_empty() {
                        out.push(AgentEvent::UserMessage {
                            text: truncate(text.to_owned()),
                        });
                    }
                }
            }
            "subagent" => {
                if !state.tool_start_emitted {
                    state.tool_start_emitted = true;
                    out.push(AgentEvent::ToolStart {
                        task_id: item_id.clone(),
                        name: "subagent".to_owned(),
                    });
                }
                if terminal || is_terminal_status(&status) {
                    if !state.ended {
                        state.ended = true;
                        let reason = str_field(item, "failureReason");
                        out.push(AgentEvent::ToolEnd {
                            task_id: item_id.clone(),
                            status: tool_status(&status),
                            reason,
                        });
                    }
                } else if !state.started {
                    state.started = true;
                    out.push(AgentEvent::Activity {
                        text: "Working…".to_owned(),
                    });
                }
            }
            "workflow" => {
                if (terminal || is_terminal_status(&status)) && !state.ended {
                    state.ended = true;
                    let reason = item
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    out.push(AgentEvent::Notice {
                        text: truncate(match status.as_str() {
                            "completed" => "Workflow completed".to_owned(),
                            _ => match reason {
                                Some(r) if !r.is_empty() => format!("Workflow {status}: {r}"),
                                _ => format!("Workflow {status}"),
                            },
                        }),
                    });
                }
            }
            "compaction" => {
                if (terminal || is_terminal_status(&status)) && !state.ended {
                    state.ended = true;
                    let reason = str_field(item, "reason");
                    out.push(AgentEvent::Notice {
                        text: match reason {
                            Some(r) if !r.is_empty() => format!("Transcript compacted: {r}"),
                            _ => "Transcript compacted".to_owned(),
                        },
                    });
                }
            }
            "reminderChild" => {
                // Child transcripts are drill-down via session/read; the
                // parent transcript only notes completion.
                if (terminal || is_terminal_status(&status)) && !state.ended {
                    state.ended = true;
                    out.push(AgentEvent::Notice {
                        text: format!("Background task {status}"),
                    });
                }
            }
            _ => {
                if !state.started {
                    out.push(AgentEvent::Notice {
                        text: truncate(format!(
                            "{kind} ({status}): {}",
                            str_field(item, "fallbackText").unwrap_or_default()
                        )),
                    });
                }
            }
        }
        state.started = true;
        out
    }

    /// `item/delta` appends streamed text to an open item. Deltas never bump
    /// revision. Absent `field` means `text`; `output` targets tool/shell
    /// visible output; `summary.N` targets reasoning parts (not answers).
    fn on_item_delta(&mut self, params: &Value) -> Vec<AgentEvent> {
        let item_id = match Self::item_id(params) {
            Some(id) => id,
            None => return Vec::new(),
        };
        let delta = match params.get("delta").and_then(Value::as_str) {
            Some(d) if !d.is_empty() => d.to_owned(),
            _ => return Vec::new(),
        };
        let field = params
            .get("field")
            .and_then(Value::as_str)
            .unwrap_or("text");

        let state = self.items.entry(item_id.clone()).or_default();
        if state.ended {
            return Vec::new();
        }
        if field == "text" {
            // Only agentMessage streams text-as-answer. Reasoning raw text
            // is never streamed in v1; a text delta for any other tracked
            // kind is ignored to avoid double-rendering.
            if state.kind != "agentMessage" {
                return Vec::new();
            }
            state.kind = "agentMessage".to_owned();
            state.emitted_text_len += delta.chars().count();
            state.started = true;
            return vec![AgentEvent::AssistantDelta {
                text: truncate(delta),
            }];
        }
        if field == "output" {
            state.emitted_output_len += delta.chars().count();
            state.started = true;
            // Tool identity may not be known yet on an ephemeral-sourced
            // open; keep the id stable (itemId) and name the card
            // generically until the full snapshot names the tool.
            if !state.tool_start_emitted
                && (state.kind.is_empty() || state.kind == "toolCall" || state.kind == "userShell")
            {
                state.tool_start_emitted = true;
                let name = state.tool_name.clone().unwrap_or_else(|| "tool".to_owned());
                return vec![
                    AgentEvent::ToolStart {
                        task_id: item_id.clone(),
                        name,
                    },
                    AgentEvent::ToolDelta {
                        task_id: item_id,
                        text: truncate(delta),
                    },
                ];
            }
            return vec![AgentEvent::ToolDelta {
                task_id: item_id,
                text: truncate(delta),
            }];
        }
        if field.starts_with("summary.") {
            // Reasoning summaries stream but are never assistant answers.
            return Vec::new();
        }
        Vec::new()
    }

    fn on_turn_completed(params: &Value) -> Vec<AgentEvent> {
        let terminal = params
            .get("terminal")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let error = params.get("error").filter(|value| !value.is_null());
        let mut reason = params
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(err) = error {
            let message = err.get("message").and_then(Value::as_str).unwrap_or("");
            if !message.is_empty() {
                reason = Some(match reason {
                    Some(r) if !r.is_empty() => format!("{r}: {message}"),
                    _ => message.to_owned(),
                });
            }
        }
        let mut out = Vec::new();
        // The turn's aggregate usage rides along when present; it describes
        // this turn only (session totals arrive via session/tokenUsage).
        if let Some(usage) = params.get("usage") {
            if let Some(turn) = turn_usage_from_raw(usage, None) {
                out.push(AgentEvent::Usage {
                    context: None,
                    turn: Some(turn),
                });
            }
        }
        out.push(AgentEvent::TurnEnd {
            status: turn_status(&terminal, error.is_some()),
            text: None,
            reason,
        });
        out
    }

    fn on_todos(params: &Value) -> Vec<AgentEvent> {
        let items = match params.get("items").and_then(Value::as_array) {
            Some(items) => items,
            None => return Vec::new(),
        };
        vec![AgentEvent::Todos {
            items: items
                .iter()
                .map(|item| crate::events::TodoItem {
                    text: str_field(item, "text").unwrap_or_default(),
                    status: str_field(item, "status").unwrap_or_default(),
                })
                .collect(),
        }]
    }

    fn on_context_usage(params: &Value) -> Vec<AgentEvent> {
        let used = match u64_field(params, "usedTokens") {
            Some(n) => n,
            None => return Vec::new(),
        };
        vec![AgentEvent::Usage {
            context: Some(crate::provider_usage::ContextUsage {
                used_tokens: used,
                window_tokens: u64_field(params, "windowTokens").filter(|n| *n > 0),
                measured_at: chrono::Utc::now().timestamp_millis(),
                estimated: false,
            }),
            turn: None,
        }]
    }

    fn on_token_usage(&mut self, params: &Value) -> Vec<AgentEvent> {
        if let Some(cursor) = params["viewCursor"].as_str() {
            if !self.usage_cursors.insert(cursor.to_owned()) {
                return vec![];
            }
        }
        let usage = match params.get("usage") {
            Some(u) => u,
            None => return Vec::new(),
        };
        // Prefer the server-derived counted-once derivations; never
        // re-derive the provider's cache convention locally.
        let prompt = u64_field(params, "promptTokens");
        let mut turn = match turn_usage_from_raw(usage, u64_field(params, "durationMs")) {
            Some(t) => t,
            None => return Vec::new(),
        };
        if let Some(p) = prompt {
            turn.input_tokens = Some(p);
        }
        let turn = self
            .turn_usage
            .as_ref()
            .map(|previous| previous.add(&turn))
            .unwrap_or(turn);
        self.turn_usage = Some(turn.clone());
        vec![AgentEvent::Usage {
            context: None,
            turn: Some(turn),
        }]
    }
}

/// Build a [`TurnUsage`] from a raw `TokenUsage` block. Returns `None` when
/// the schema supplies no evidence (no input/output counts) rather than
/// inventing a zero that looks measured.
fn turn_usage_from_raw(
    usage: &Value,
    elapsed_ms: Option<u64>,
) -> Option<crate::provider_usage::TurnUsage> {
    let input = counter(&usage["inputTokens"]);
    let output = counter(&usage["outputTokens"]);
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(crate::provider_usage::TurnUsage {
        input_tokens: input,
        cached_input_tokens: counter(&usage["cachedTokens"])
            .or_else(|| counter(&usage["cacheReadTokens"])),
        output_tokens: output,
        reasoning_output_tokens: counter(&usage["reasoningTokens"]),
        elapsed_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::View;
    use crate::events::AgentEvent;
    use serde_json::json;

    fn turn_usage(events: &[AgentEvent]) -> Option<crate::provider_usage::TurnUsage> {
        events.iter().find_map(|event| match event {
            AgentEvent::Usage { turn, .. } => turn.clone(),
            _ => None,
        })
    }

    fn has_answer(events: &[AgentEvent]) -> bool {
        events.iter().any(|event| {
            matches!(
                event,
                AgentEvent::AssistantDelta { .. } | AgentEvent::ToolResult { .. }
            )
        })
    }

    #[test]
    fn reasoning_summary_never_becomes_answer() {
        let mut view = View::default();
        let started = view.observe(
            "item/started",
            &json!({"item": {"itemId": "r1", "kind": "reasoning", "revision": 1,
                "status": "inProgress", "summary": [{"text": "plan"}]}}),
        );
        assert!(!has_answer(&started), "{started:?}");
        assert!(
            started
                .iter()
                .any(|event| matches!(event, AgentEvent::Activity { .. })),
            "{started:?}"
        );
        let completed = view.observe(
            "item/completed",
            &json!({"item": {"itemId": "r1", "kind": "reasoning", "revision": 2,
                "status": "completed", "summary": [{"text": "plan"}, {"text": "more"}]}}),
        );
        assert!(!has_answer(&completed), "{completed:?}");

        let mut bare = View::default();
        let events = bare.observe(
            "item/started",
            &json!({"item": {"itemId": "r2", "kind": "reasoning", "revision": 1,
                "status": "inProgress"}}),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn reasoning_text_and_summary_deltas_are_ignored() {
        let mut view = View::default();
        // A text delta with no agentMessage identity must not render as an answer.
        let text = view.observe(
            "item/delta",
            &json!({"itemId": "r1", "delta": "thinking out loud"}),
        );
        assert!(text.is_empty());
        let summary = view.observe(
            "item/delta",
            &json!({"itemId": "r1", "delta": "part", "field": "summary.0"}),
        );
        assert!(summary.is_empty());
    }

    #[test]
    fn agent_delta_then_snapshot_emits_only_unseen_suffix() {
        let mut view = View::default();
        let started = view.observe(
            "item/started",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 1,
                "status": "inProgress", "text": ""}}),
        );
        assert!(started.is_empty());
        let delta = view.observe(
            "item/delta",
            &json!({"item": {"itemId": "m1"}, "delta": "hello", "field": "text"}),
        );
        assert_eq!(delta.len(), 1);
        assert!(matches!(
            &delta[0],
            AgentEvent::AssistantDelta { text } if text == "hello"
        ));
        let snapshot = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 2,
                "status": "inProgress", "text": "hello world"}}),
        );
        assert_eq!(snapshot.len(), 1);
        assert!(matches!(
            &snapshot[0],
            AgentEvent::AssistantDelta { text } if text == " world"
        ));
    }

    #[test]
    fn duplicate_and_stale_snapshots_emit_nothing() {
        let mut view = View::default();
        view.observe(
            "item/started",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 1,
                "status": "inProgress", "text": "hello"}}),
        );
        let duplicate = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 2,
                "status": "inProgress", "text": "hello"}}),
        );
        assert!(duplicate.is_empty());
        let stale = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 1,
                "status": "inProgress", "text": "hello world!!!"}}),
        );
        assert!(stale.is_empty());
        // A revision-0 snapshot after an accepted revision is also stale.
        let zero = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage",
                "status": "inProgress", "text": "hello world!!!"}}),
        );
        assert!(zero.is_empty());
    }

    #[test]
    fn tool_completion_emits_end_exactly_once() {
        let mut view = View::default();
        let first = view.observe(
            "item/completed",
            &json!({"item": {"itemId": "t1", "kind": "toolCall", "revision": 1,
                "status": "completed", "tool": "bash", "visibleOutput": "out"}}),
        );
        assert_eq!(
            first
                .iter()
                .filter(|event| matches!(event, AgentEvent::ToolEnd { .. }))
                .count(),
            1
        );
        let repeat = view.observe(
            "item/completed",
            &json!({"item": {"itemId": "t1", "kind": "toolCall", "revision": 2,
                "status": "completed", "tool": "bash", "visibleOutput": "out"}}),
        );
        assert!(repeat.is_empty(), "{repeat:?}");
    }

    #[test]
    fn nonterminal_tool_snapshot_has_start_but_no_end() {
        let mut view = View::default();
        let events = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "t1", "kind": "toolCall", "revision": 1,
                "status": "inProgress", "tool": "bash", "visibleOutput": "partial"}}),
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::ToolStart { .. })),
            "{events:?}"
        );
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, AgentEvent::ToolEnd { .. })),
            "{events:?}"
        );
    }

    #[test]
    fn agent_terminal_does_not_duplicate_streamed_text() {
        let mut view = View::default();
        view.observe(
            "item/started",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 1,
                "status": "inProgress", "text": ""}}),
        );
        view.observe(
            "item/delta",
            &json!({"item": {"itemId": "m1"}, "delta": "hello", "field": "text"}),
        );
        let terminal = view.observe(
            "item/completed",
            &json!({"item": {"itemId": "m1", "kind": "agentMessage", "revision": 2,
                "status": "completed", "text": "hello"}}),
        );
        assert!(terminal.is_empty(), "{terminal:?}");

        // An unseen single-shot answer still arrives exactly once, terminal-only.
        let mut single = View::default();
        let events = single.observe(
            "item/completed",
            &json!({"item": {"itemId": "m2", "kind": "agentMessage", "revision": 1,
                "status": "completed", "text": "hi"}}),
        );
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            AgentEvent::AssistantDelta { text } if text == "hi"
        ));
    }

    #[test]
    fn output_delta_opens_generic_tool_card_before_snapshot_names_tool() {
        let mut view = View::default();
        let events = view.observe(
            "item/delta",
            &json!({"itemId": "t9", "delta": "out", "field": "output"}),
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], AgentEvent::ToolStart { task_id, .. } if task_id == "t9"));
        let snapshot = view.observe(
            "item/updated",
            &json!({"item": {"itemId": "t9", "kind": "toolCall", "revision": 1,
                "status": "inProgress", "tool": "bash", "visibleOutput": "out"}}),
        );
        assert!(
            snapshot
                .iter()
                .all(|event| !matches!(event, AgentEvent::ToolStart { .. })),
            "{snapshot:?}"
        );
    }

    #[test]
    fn unknown_methods_and_kinds_never_approve() {
        let mut view = View::default();
        for method in [
            "turn/started",
            "approval/requested",
            "approval/updated",
            "userInput/request",
            "rawLog",
            "something/else",
        ] {
            assert!(
                view.observe(method, &json!({})).is_empty(),
                "{method} must yield no events"
            );
        }
        let unknown = view.observe(
            "item/started",
            &json!({"item": {"itemId": "u1", "kind": "mysteryKind", "revision": 1,
                "status": "inProgress", "fallbackText": "hi"}}),
        );
        assert!(
            unknown.iter().all(|event| !matches!(
                event,
                AgentEvent::Approval { .. }
                    | AgentEvent::AssistantDelta { .. }
                    | AgentEvent::ToolStart { .. }
            )),
            "{unknown:?}"
        );
    }

    #[test]
    fn turn_completed_usage_normalizes_counts() {
        let mut view = View::default();
        let events = view.observe(
            "turn/completed",
            &json!({"terminal": "completed",
                "usage": {"inputTokens": 10, "outputTokens": 5, "cachedTokens": 2,
                    "reasoningTokens": 1}}),
        );
        assert_eq!(events.len(), 2);
        let usage = turn_usage(&events).expect("usage present");
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(5));
        assert_eq!(usage.cached_input_tokens, Some(2));
        assert_eq!(usage.reasoning_output_tokens, Some(1));
        assert!(matches!(
            &events[1],
            AgentEvent::TurnEnd { status, .. } if status == "completed"
        ));

        let mut empty = View::default();
        let events = empty.observe(
            "turn/completed",
            &json!({"terminal": "completed", "usage": {}}),
        );
        assert_eq!(events.len(), 1);
        assert!(turn_usage(&events).is_none());

        // Unsafe integers are filtered rather than surfaced as usage.
        let mut huge = View::default();
        let events = huge.observe(
            "turn/completed",
            &json!({"terminal": "completed",
                "usage": {"inputTokens": 9_007_199_254_740_992_u64, "outputTokens": 1}}),
        );
        let usage = turn_usage(&events).expect("partial usage present");
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.output_tokens, Some(1));
    }

    #[test]
    fn token_usage_accumulates_and_dedups_cursor() {
        let mut view = View::default();
        let first = view.observe(
            "session/tokenUsage",
            &json!({"usage": {"inputTokens": 10, "outputTokens": 4},
                "durationMs": 7, "viewCursor": "c1"}),
        );
        let usage = turn_usage(&first).expect("first usage");
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.elapsed_ms, Some(7));

        let replay = view.observe(
            "session/tokenUsage",
            &json!({"usage": {"inputTokens": 10, "outputTokens": 4},
                "durationMs": 7, "viewCursor": "c1"}),
        );
        assert!(replay.is_empty(), "duplicate cursor must not double-count");

        let second = view.observe(
            "session/tokenUsage",
            &json!({"usage": {"inputTokens": 3, "outputTokens": 2}, "viewCursor": "c2"}),
        );
        let total = turn_usage(&second).expect("accumulated usage");
        assert_eq!(total.input_tokens, Some(13));
        assert_eq!(total.output_tokens, Some(6));

        let mut missing = View::default();
        assert!(missing.observe("session/tokenUsage", &json!({})).is_empty());
    }

    #[test]
    fn context_usage_requires_used_tokens() {
        let mut view = View::default();
        let events = view.observe(
            "session/contextUsage",
            &json!({"usedTokens": 100, "windowTokens": 1000}),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::Usage { context, turn } => {
                let context = context.as_ref().expect("context present");
                assert_eq!(context.used_tokens, 100);
                assert_eq!(context.window_tokens, Some(1000));
                assert!(!context.estimated);
                assert!(turn.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        // A zero window carries no capacity information.
        let events = view.observe(
            "session/contextUsage",
            &json!({"usedTokens": 5, "windowTokens": 0}),
        );
        match &events[0] {
            AgentEvent::Usage { context, .. } => {
                assert_eq!(context.as_ref().unwrap().window_tokens, None);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(view.observe("session/contextUsage", &json!({})).is_empty());
    }

    #[test]
    fn turn_terminal_mapping_never_invents_success() {
        let mut view = View::default();
        for terminal in ["completed", "failed", "cancelled", "blocked"] {
            let events = view.observe("turn/completed", &json!({"terminal": terminal}));
            assert!(matches!(
                &events[0],
                AgentEvent::TurnEnd { status, .. } if status == terminal
            ));
        }
        let events = view.observe("turn/completed", &json!({"terminal": "stalled"}));
        assert!(matches!(
            &events[0],
            AgentEvent::TurnEnd { status, .. } if status == "failed"
        ));
        let events = view.observe(
            "turn/completed",
            &json!({"terminal": "stalled", "reason": "cut",
                "error": {"message": "boom"}}),
        );
        match &events[0] {
            AgentEvent::TurnEnd { status, reason, .. } => {
                assert_eq!(status, "failed");
                assert_eq!(reason.as_deref(), Some("cut: boom"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
