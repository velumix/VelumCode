//! Backend-owned replay buffers let phones reconnect without depending on WebView timers.
use crate::events::AgentEvent;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 8_000;

#[derive(Clone, Serialize)]
pub struct Entry {
    pub seq: u64,
    pub event: AgentEvent,
}

#[derive(Clone, Serialize)]
pub struct Summary {
    pub measurement: Option<crate::tool_bridge::Measurement>,
    pub queue: crate::message_queue::Snapshot,
    pub provider_progress: Option<crate::provider_progress::Progress>,
    pub last_provider_retry: Option<crate::provider_progress::Progress>,
    pub bot: Option<crate::bots::Identity>,
    pub options: crate::provider_models::RunOptions,
    pub provider: crate::providers::Provider,
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub running: bool,
    pub status: String,
    pub revision: u64,
}

struct Log {
    summary: Summary,
    started: bool,
    events: VecDeque<(Entry, usize)>,
    bytes: usize,
}

#[derive(Serialize)]
pub struct Replay {
    pub session: Summary,
    pub events: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Default)]
pub struct SessionLog(Mutex<HashMap<String, Log>>);

impl SessionLog {
    #[cfg(test)]
    pub fn register(&self, id: &str, workspace: String) {
        self.register_provider(id, workspace, crate::providers::Provider::Muse);
    }

    pub fn register_provider(
        &self,
        id: &str,
        workspace: String,
        provider: crate::providers::Provider,
    ) {
        self.0.lock().unwrap().insert(
            id.into(),
            Log {
                summary: Summary {
                    measurement: None,
                    queue: crate::message_queue::Snapshot::default(),
                    provider_progress: None,
                    last_provider_retry: None,
                    bot: None,
                    options: crate::provider_models::RunOptions::default(),
                    provider,
                    id: id.into(),
                    title: "New conversation".into(),
                    workspace,
                    running: false,
                    status: "idle".into(),
                    revision: 0,
                },
                events: VecDeque::new(),
                started: false,
                bytes: 0,
            },
        );
    }

    pub fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }

    pub fn configure(&self, id: &str, options: crate::provider_models::RunOptions) {
        if let Some(log) = self.0.lock().unwrap().get_mut(id) {
            log.summary.options = options;
        }
    }

    pub fn interactions_changed(&self, id: &str, waiting: bool) {
        if let Some(log) = self.0.lock().unwrap().get_mut(id) {
            // Live requests travel separately from history. Revision changes
            // still wake phone replay so its authoritative snapshot refreshes.
            log.summary.revision += 1;
            if log.summary.running {
                log.summary.status = if waiting {
                    "awaiting_review"
                } else {
                    "running"
                }
                .into();
            }
        }
    }

    pub fn record(&self, id: &str, event: &AgentEvent) -> Option<u64> {
        // The runner emits an authoritative turn_start before reading CLI output.
        if matches!(event, AgentEvent::UserMessage { .. }) {
            return None;
        }
        let mut logs = self.0.lock().unwrap();
        let Some(log) = logs.get_mut(id) else {
            return None;
        };
        match event {
            AgentEvent::QueueState { queue, running } => {
                log.summary.queue = queue.clone();
                log.summary.running = *running;
            }
            AgentEvent::BotIdentity { bot } => {
                log.summary.bot = Some(bot.clone());
            }
            AgentEvent::TurnStart { prompt, .. } => {
                log.summary.measurement = None;
                log.summary.provider_progress = None;
                log.summary.last_provider_retry = None;
                if !log.started {
                    log.started = true;
                    log.summary.title = prompt
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(64)
                        .collect();
                }
                log.summary.running = true;
                log.summary.status = "running".into();
            }
            AgentEvent::ProviderProgress { progress } => {
                log.summary.provider_progress = Some(progress.clone());
                if progress.phase == crate::provider_progress::Phase::Retrying {
                    log.summary.last_provider_retry = Some(progress.clone());
                }
            }
            AgentEvent::UsageReset => {
                log.summary.measurement = None;
                log.summary.provider_progress = None;
                log.summary.last_provider_retry = None;
            }
            AgentEvent::TurnMetrics { measurement } => {
                log.summary.measurement = Some(measurement.clone());
            }
            AgentEvent::AssistantDelta { text } if !text.is_empty() => {
                log.summary.provider_progress = None;
            }
            AgentEvent::ToolStart { .. } => log.summary.provider_progress = None,
            AgentEvent::TurnEnd { status, .. } => {
                log.summary.provider_progress = None;
                log.summary.running = false;
                log.summary.status.clone_from(status);
            }
            _ => {}
        }
        log.summary.revision += 1;
        let size = serde_json::to_vec(event).map(|v| v.len()).unwrap_or(0);
        log.events.push_back((
            Entry {
                seq: log.summary.revision,
                event: event.clone(),
            },
            size,
        ));
        log.bytes += size;
        while log.events.len() > MAX_EVENTS || log.bytes > MAX_BYTES {
            if let Some((_, bytes)) = log.events.pop_front() {
                log.bytes -= bytes;
            } else {
                break;
            }
        }
        Some(log.summary.revision)
    }

    pub fn summaries(&self) -> Vec<Summary> {
        let mut items: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .values()
            .map(|log| log.summary.clone())
            .collect();
        items.sort_by(|a, b| b.running.cmp(&a.running).then(a.id.cmp(&b.id)));
        items
    }

    pub fn replay(&self, id: &str, after: u64) -> Option<Replay> {
        self.0.lock().unwrap().get(id).map(|log| Replay {
            session: log.summary.clone(),
            events: log
                .events
                .iter()
                .filter(|(e, _)| e.seq > after)
                .map(|(e, _)| e.clone())
                .collect(),
            truncated: log
                .events
                .front()
                .is_some_and(|(e, _)| e.seq > after.saturating_add(1)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_retry_evidence_survives_recovery_but_not_new_turns_or_permission_resets() {
        use crate::provider_progress::{Phase, Progress};
        let log = SessionLog::default();
        log.register("one", "workspace".into());
        let retry = Progress {
            phase: Phase::Retrying,
            checked_at_ms: 1000,
            attempt: Some(2),
            max_attempts: Some(10),
            http_status: Some(503),
            retry_at_ms: Some(61_000),
        };
        log.record(
            "one",
            &AgentEvent::ProviderProgress {
                progress: retry.clone(),
            },
        );
        let connected = Progress {
            phase: Phase::Connected,
            http_status: None,
            retry_at_ms: None,
            ..retry.clone()
        };
        log.record(
            "one",
            &AgentEvent::ProviderProgress {
                progress: connected.clone(),
            },
        );
        log.record(
            "one",
            &AgentEvent::TurnEnd {
                status: "completed".into(),
                text: None,
                reason: None,
            },
        );
        let summary = log.summaries().remove(0);
        assert_eq!(summary.provider_progress, None);
        assert_eq!(summary.last_provider_retry, Some(retry.clone()));
        assert!(!summary.running);
        for reset in [
            AgentEvent::TurnStart {
                prompt: "new".into(),
                remote: false,
                queued: false,
            },
            AgentEvent::UsageReset,
        ] {
            log.record(
                "one",
                &AgentEvent::ProviderProgress {
                    progress: retry.clone(),
                },
            );
            log.record("one", &reset);
            let summary = log.summaries().remove(0);
            assert_eq!(summary.provider_progress, None);
            assert_eq!(summary.last_provider_retry, None);
        }
        log.register("one", "other workspace".into());
        assert_eq!(log.summaries()[0].last_provider_retry, None);
    }
    #[test]
    fn bot_identity_does_not_prevent_the_first_prompt_from_naming_a_conversation() {
        let log = SessionLog::default();
        log.register("bot", "workspace".into());
        log.record(
            "bot",
            &AgentEvent::BotIdentity {
                bot: crate::bots::Identity {
                    id: "id".into(),
                    name: "Grokbot".into(),
                    avatar: String::new(),
                    color: "#79a9ff".into(),
                },
            },
        );
        log.record(
            "bot",
            &AgentEvent::TurnStart {
                prompt: "Review this change".into(),
                remote: false,
                queued: false,
            },
        );
        log.record(
            "bot",
            &AgentEvent::TurnStart {
                prompt: "A follow-up".into(),
                remote: true,
                queued: false,
            },
        );
        assert_eq!(log.summaries()[0].title, "Review this change");
        assert_eq!(log.summaries()[0].bot.as_ref().unwrap().name, "Grokbot");
    }
    #[test]
    fn replay_is_ordered_and_tracks_remote_turns_without_cli_echoes() {
        let log = SessionLog::default();
        log.register("one", "C:\\project".into());
        log.record(
            "one",
            &AgentEvent::TurnStart {
                prompt: "Review code".into(),
                remote: true,
                queued: false,
            },
        );
        log.record(
            "one",
            &AgentEvent::UserMessage {
                text: "Review code".into(),
            },
        );
        log.record(
            "one",
            &AgentEvent::AssistantDelta {
                text: "Hello".into(),
            },
        );
        let replay = log.replay("one", 1).unwrap();
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq, 2);
        assert!(replay.session.running);
        log.record(
            "one",
            &AgentEvent::TurnEnd {
                status: "completed".into(),
                text: None,
                reason: None,
            },
        );
        assert!(!log.replay("one", 2).unwrap().session.running);
        log.remove("one");
        assert!(log.replay("one", 0).is_none());
    }
    #[test]
    fn buffers_are_bounded_and_disclose_missing_history() {
        let log = SessionLog::default();
        log.register("one", "workspace".into());
        for _ in 0..300 {
            log.record(
                "one",
                &AgentEvent::AssistantDelta {
                    text: "x".repeat(12_000),
                },
            );
        }
        let replay = log.replay("one", 0).unwrap();
        assert!(replay.truncated);
        assert!(replay.events.len() < 200);
        assert_eq!(replay.session.revision, 300);
    }
}
