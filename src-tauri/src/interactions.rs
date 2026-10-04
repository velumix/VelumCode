//! Live, turn-owned approval state. Transcript replay never authorizes an action.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub scope: String,
    pub decision: String,
    pub accepts_feedback: bool,
    pub rule: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multiple: bool,
    pub free_text: bool,
    pub secret: bool,
    pub min: usize,
    pub max: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub id: String,
    pub revision: u64,
    pub kind: String,
    pub title: String,
    pub tool: String,
    pub details: String,
    pub choices: Vec<Choice>,
    pub questions: Vec<Question>,
    pub status: String,
    pub message: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub generation: String,
    pub revision: u64,
    pub active: bool,
    pub requests: Vec<Request>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub question_id: String,
    #[serde(default)]
    pub selected: Vec<String>,
    pub text: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub generation: String,
    pub id: String,
    pub revision: u64,
    pub choice_id: Option<String>,
    pub feedback: Option<String>,
    #[serde(default)]
    pub answers: Vec<Answer>,
    #[serde(default)]
    pub cancel: bool,
}

pub struct Command {
    pub decision: Decision,
    /// Constructed by the provider adapter, never supplied by a web client.
    pub binding: Value,
}

struct Entry {
    request: Request,
    binding: Value,
}
struct State {
    generation: String,
    revision: u64,
    active: bool,
    entries: BTreeMap<String, Entry>,
    waiting_since: Option<Instant>,
    waited: Duration,
}
pub struct Broker {
    state: Mutex<State>,
    commands: mpsc::SyncSender<Command>,
}

impl Broker {
    pub fn new(generation: String) -> (Arc<Self>, mpsc::Receiver<Command>) {
        let (commands, receiver) = mpsc::sync_channel(32);
        (
            Arc::new(Self {
                state: Mutex::new(State {
                    generation,
                    revision: 0,
                    active: true,
                    entries: BTreeMap::new(),
                    waiting_since: None,
                    waited: Duration::ZERO,
                }),
                commands,
            }),
            receiver,
        )
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().unwrap();
        Self::snapshot_locked(&state)
    }

    fn snapshot_locked(state: &State) -> Snapshot {
        Snapshot {
            generation: state.generation.clone(),
            revision: state.revision,
            active: state.active,
            requests: state
                .entries
                .values()
                .map(|entry| entry.request.clone())
                .collect(),
        }
    }

    pub fn waiting(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.active
            && state
                .entries
                .values()
                .any(|e| matches!(e.request.status.as_str(), "pending" | "submitting"))
    }

    pub fn waited_seconds(&self) -> u64 {
        let state = self.state.lock().unwrap();
        (state.waited
            + state
                .waiting_since
                .map(|since| since.elapsed())
                .unwrap_or_default())
        .as_secs()
    }

    fn update_waiting(state: &mut State) {
        let waiting = state.active
            && state
                .entries
                .values()
                .any(|e| matches!(e.request.status.as_str(), "pending" | "submitting"));
        if waiting && state.waiting_since.is_none() {
            state.waiting_since = Some(Instant::now());
        }
        if !waiting {
            if let Some(since) = state.waiting_since.take() {
                state.waited += since.elapsed();
            }
        }
    }

    pub fn present(&self, mut request: Request, binding: Value) -> Result<(), String> {
        if request.details.len() > 256_000
            || request.choices.len() > 64
            || request.questions.len() > 32
            || serde_json::to_vec(&request)
                .map_err(|e| e.to_string())?
                .len()
                > 512_000
        {
            return Err(
                "The provider sent an approval request too large to display safely.".into(),
            );
        }
        let mut ids = HashSet::new();
        if request.id.is_empty()
            || request
                .choices
                .iter()
                .any(|choice| choice.id.is_empty() || !ids.insert(&choice.id))
        {
            return Err("The provider sent an invalid permission identity.".into());
        }
        ids.clear();
        if request.questions.iter().any(|q| {
            q.id.is_empty()
                || !ids.insert(&q.id)
                || q.min > q.max
                || q.options.len() > 64
                || q.options.iter().any(|o| o.label.is_empty())
                || q.options
                    .iter()
                    .map(|o| &o.label)
                    .collect::<HashSet<_>>()
                    .len()
                    != q.options.len()
        }) {
            return Err("The provider sent an invalid question.".into());
        }
        let mut state = self.state.lock().unwrap();
        if !state.active {
            return Err("This turn has stopped.".into());
        }
        if let Some(previous) = state.entries.get(&request.id) {
            // Receipt requests and mirrored view notifications describe the same stage.
            if previous.binding == binding
                && previous.request.choices == request.choices
                && previous.request.questions == request.questions
                && previous.request.title == request.title
                && previous.request.tool == request.tool
                && previous.request.details == request.details
            {
                return Ok(());
            }
        }
        if state.entries.len() >= 128 && !state.entries.contains_key(&request.id) {
            let retired = state
                .entries
                .iter()
                .find(|(_, e)| !matches!(e.request.status.as_str(), "pending" | "submitting"))
                .map(|(id, _)| id.clone());
            if let Some(id) = retired {
                state.entries.remove(&id);
            } else {
                return Err(
                    "Too many simultaneous permission requests. Stop this turn and retry.".into(),
                );
            }
        }
        state.revision += 1;
        request.revision = state.revision;
        request.status = "pending".into();
        state
            .entries
            .insert(request.id.clone(), Entry { request, binding });
        Self::update_waiting(&mut state);
        Ok(())
    }

    pub fn respond(&self, decision: Decision, source: &str) -> Result<Snapshot, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Approval state unavailable.")?;
        if !state.active || state.generation != decision.generation {
            return Err("This permission request belongs to a turn that has ended.".into());
        }
        let entry = state
            .entries
            .get(&decision.id)
            .ok_or("This permission request is no longer pending.")?;
        if entry.request.revision != decision.revision || entry.request.status != "pending" {
            return Err(
                "This request changed or already received a response. Review its current state."
                    .into(),
            );
        }
        Self::validate(&entry.request, &decision)?;
        let command = Command {
            binding: entry.binding.clone(),
            decision: decision.clone(),
        };
        self.commands.try_send(command).map_err(|_| {
            "The provider is not accepting decisions. Refresh the request or stop the turn."
        })?;
        let entry = state.entries.get_mut(&decision.id).unwrap();
        entry.request.status = "submitting".into();
        entry.request.message = None;
        entry.request.source = Some(source.into());
        state.revision += 1;
        Ok(Self::snapshot_locked(&state))
    }

    fn validate(request: &Request, decision: &Decision) -> Result<(), String> {
        if request.kind == "approval" {
            if decision.cancel || !decision.answers.is_empty() {
                return Err("Choose one of the offered permission decisions.".into());
            }
            let choice = request
                .choices
                .iter()
                .find(|choice| Some(&choice.id) == decision.choice_id.as_ref())
                .ok_or("That permission choice is no longer available.")?;
            if let Some(feedback) = &decision.feedback {
                if !choice.accepts_feedback || feedback.chars().count() > 2000 {
                    return Err("This choice does not accept that feedback.".into());
                }
            }
            return Ok(());
        }
        if request.kind != "question" || decision.choice_id.is_some() || decision.feedback.is_some()
        {
            return Err("Unsupported response for this request.".into());
        }
        if decision.cancel {
            return if decision.answers.is_empty() {
                Ok(())
            } else {
                Err("A cancelled question cannot also contain answers.".into())
            };
        }
        if decision.answers.len() != request.questions.len() {
            return Err("Answer every question before continuing.".into());
        }
        let mut seen = HashSet::new();
        for answer in &decision.answers {
            if !seen.insert(&answer.question_id) {
                return Err("A question was answered more than once.".into());
            }
            let question = request
                .questions
                .iter()
                .find(|q| q.id == answer.question_id)
                .ok_or("That question is no longer available.")?;
            if let Some(text) = &answer.text {
                if !question.free_text
                    || text.trim().is_empty()
                    || text.chars().count() > 500
                    || !answer.selected.is_empty()
                {
                    return Err(
                        "Enter an answer of 1 to 500 characters or select the offered options."
                            .into(),
                    );
                }
            } else {
                let distinct: HashSet<_> = answer.selected.iter().collect();
                if distinct.len() != answer.selected.len()
                    || answer.selected.len() < question.min
                    || answer.selected.len() > question.max
                    || (!question.multiple && answer.selected.len() != 1)
                    || answer
                        .selected
                        .iter()
                        .any(|label| !question.options.iter().any(|o| &o.label == label))
                {
                    return Err("Select valid options for each question.".into());
                }
            }
        }
        Ok(())
    }

    pub fn dispatch(
        &self,
        command: &Command,
        send: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        if state.active
            && state.generation == command.decision.generation
            && state
                .entries
                .get(&command.decision.id)
                .is_some_and(|entry| {
                    entry.request.revision == command.decision.revision
                        && entry.request.status == "submitting"
                        && entry.binding == command.binding
                })
        {
            // Serialize the nonblocking transport enqueue with Stop and stage changes.
            send()?;
        }
        Ok(())
    }

    pub fn settle(&self, id: &str, status: &str, message: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.entries.get_mut(id) {
            if entry.request.status != status || entry.request.message != message {
                entry.request.status = status.into();
                entry.request.message = message;
                state.revision += 1;
            }
        }
        Self::update_waiting(&mut state);
    }

    pub fn close(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        if !state.active {
            return;
        }
        state.active = false;
        state.revision += 1;
        for entry in state.entries.values_mut() {
            if matches!(entry.request.status.as_str(), "pending" | "submitting") {
                entry.request.status = "expired".into();
                entry.request.message = Some(reason.into());
            }
        }
        Self::update_waiting(&mut state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_binding() -> Value {
        json!({"session": "s1", "adapter": "test"})
    }

    fn approval_request(id: &str) -> Request {
        Request {
            id: id.into(),
            revision: 0,
            kind: "approval".into(),
            title: "Run command".into(),
            tool: "exec".into(),
            details: "ls".into(),
            choices: vec![
                Choice {
                    id: "allow".into(),
                    label: "Allow".into(),
                    scope: "turn".into(),
                    decision: "allow".into(),
                    accepts_feedback: false,
                    rule: None,
                },
                Choice {
                    id: "deny".into(),
                    label: "Deny".into(),
                    scope: "turn".into(),
                    decision: "deny".into(),
                    accepts_feedback: true,
                    rule: None,
                },
            ],
            questions: vec![],
            status: String::new(),
            message: None,
            source: None,
        }
    }

    fn single_question_request(id: &str) -> Request {
        Request {
            id: id.into(),
            revision: 0,
            kind: "question".into(),
            title: "Pick one".into(),
            tool: String::new(),
            details: String::new(),
            choices: vec![],
            questions: vec![Question {
                id: "q".into(),
                header: "H".into(),
                question: "Which?".into(),
                options: vec![
                    QuestionOption {
                        label: "a".into(),
                        description: String::new(),
                    },
                    QuestionOption {
                        label: "b".into(),
                        description: String::new(),
                    },
                ],
                multiple: false,
                free_text: false,
                secret: false,
                min: 1,
                max: 1,
            }],
            status: String::new(),
            message: None,
            source: None,
        }
    }

    fn multi_question_request(id: &str) -> Request {
        let mut request = single_question_request(id);
        let question = &mut request.questions[0];
        question.multiple = true;
        question.min = 1;
        question.max = 2;
        question.options.push(QuestionOption {
            label: "c".into(),
            description: String::new(),
        });
        request
    }

    fn free_text_request(id: &str) -> Request {
        let mut request = single_question_request(id);
        let question = &mut request.questions[0];
        question.free_text = true;
        question.options.clear();
        question.multiple = false;
        question.min = 0;
        question.max = 0;
        request
    }

    fn decision_for(broker: &Broker, id: &str, choice_id: Option<&str>) -> Decision {
        let snapshot = broker.snapshot();
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.id == id)
            .expect("request presented");
        Decision {
            generation: snapshot.generation.clone(),
            id: id.into(),
            revision: request.revision,
            choice_id: choice_id.map(str::to_owned),
            feedback: None,
            answers: Vec::new(),
            cancel: false,
        }
    }

    fn question_decision_for(broker: &Broker, id: &str, answers: Vec<Answer>) -> Decision {
        let mut decision = decision_for(broker, id, None);
        decision.answers = answers;
        decision
    }

    fn selected_answer(labels: &[&str]) -> Answer {
        Answer {
            question_id: "q".into(),
            selected: labels.iter().map(|label| label.to_string()).collect(),
            text: None,
        }
    }

    #[test]
    fn allow_choice_enqueues_command_with_provider_binding() {
        let (broker, receiver) = Broker::new("gen-1".into());
        let binding = test_binding();
        broker
            .present(approval_request("r1"), binding.clone())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("allow"));
        let snapshot = broker.respond(decision, "ui").expect("allow responds");
        let pending = snapshot
            .requests
            .iter()
            .find(|request| request.id == "r1")
            .unwrap();
        assert_eq!(pending.status, "submitting");
        assert_eq!(pending.source.as_deref(), Some("ui"));
        let command = receiver.try_recv().expect("command enqueued");
        assert_eq!(command.binding, binding);
        assert_eq!(command.decision.choice_id.as_deref(), Some("allow"));
    }

    #[test]
    fn deny_choice_with_feedback_succeeds() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let mut decision = decision_for(&broker, "r1", Some("deny"));
        decision.feedback = Some("needs review".into());
        broker.respond(decision, "ui").expect("deny responds");
        let command = receiver.try_recv().expect("command enqueued");
        assert_eq!(command.decision.choice_id.as_deref(), Some("deny"));
    }

    #[test]
    fn unknown_choice_id_rejected() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("maybe"));
        let error = broker
            .respond(decision, "ui")
            .err()
            .expect("unknown choice");
        assert!(error.contains("no longer available"), "{error}");
    }

    #[test]
    fn feedback_rejected_when_choice_disallows_it_or_too_long() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let mut disallowed = decision_for(&broker, "r1", Some("allow"));
        disallowed.feedback = Some("note".into());
        let error = broker
            .respond(disallowed, "ui")
            .err()
            .expect("feedback refused");
        assert!(error.contains("does not accept that feedback"), "{error}");

        let mut too_long = decision_for(&broker, "r1", Some("deny"));
        too_long.feedback = Some("x".repeat(2001));
        let error = broker
            .respond(too_long, "ui")
            .err()
            .expect("oversize feedback");
        assert!(error.contains("does not accept that feedback"), "{error}");
    }

    #[test]
    fn approval_rejects_answers_and_cancel() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let mut with_answers = decision_for(&broker, "r1", Some("allow"));
        with_answers.answers = vec![selected_answer(&["a"])];
        let error = broker
            .respond(with_answers, "ui")
            .err()
            .expect("answers refused");
        assert!(error.contains("Choose one of the offered"), "{error}");

        let mut cancelled = decision_for(&broker, "r1", Some("allow"));
        cancelled.cancel = true;
        let error = broker
            .respond(cancelled, "ui")
            .err()
            .expect("cancel refused");
        assert!(error.contains("Choose one of the offered"), "{error}");
    }

    #[test]
    fn question_request_rejects_choice_id_and_feedback() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let mut decision = question_decision_for(&broker, "q1", vec![selected_answer(&["a"])]);
        decision.choice_id = Some("allow".into());
        let error = broker
            .respond(decision, "ui")
            .err()
            .expect("choice refused");
        assert!(error.contains("Unsupported response"), "{error}");

        let mut decision = question_decision_for(&broker, "q1", vec![selected_answer(&["a"])]);
        decision.feedback = Some("note".into());
        let error = broker
            .respond(decision, "ui")
            .err()
            .expect("feedback refused");
        assert!(error.contains("Unsupported response"), "{error}");
    }

    #[test]
    fn duplicate_and_competing_responses_rejected() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let first = decision_for(&broker, "r1", Some("allow"));
        broker.respond(first, "ui").expect("first responds");
        let competing = decision_for(&broker, "r1", Some("deny"));
        let error = broker
            .respond(competing, "ui")
            .err()
            .expect("competing refused");
        assert!(error.contains("already received a response"), "{error}");
    }

    #[test]
    fn stale_generation_and_unknown_request_rejected() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let mut foreign = decision_for(&broker, "r1", Some("allow"));
        foreign.generation = "gen-2".into();
        let error = broker
            .respond(foreign, "ui")
            .err()
            .expect("foreign generation");
        assert!(error.contains("turn that has ended"), "{error}");

        let mut unknown = decision_for(&broker, "r1", Some("allow"));
        unknown.id = "missing".into();
        let error = broker
            .respond(unknown, "ui")
            .err()
            .expect("unknown request");
        assert!(error.contains("no longer pending"), "{error}");
    }

    #[test]
    fn stale_revision_rejected() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let mut stale = decision_for(&broker, "r1", Some("allow"));
        stale.revision = stale.revision.saturating_sub(1);
        let error = broker.respond(stale, "ui").err().expect("stale revision");
        assert!(error.contains("changed or already received"), "{error}");
    }

    #[test]
    fn settle_invalidates_enqueued_command() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("allow"));
        broker.respond(decision, "ui").expect("responds");
        let command = receiver.try_recv().expect("command enqueued");
        broker.settle("r1", "approved", None);
        let mut sent = false;
        broker
            .dispatch(&command, || {
                sent = true;
                Ok(())
            })
            .expect("dispatch checks state");
        assert!(!sent, "settled stage must not dispatch");
    }

    #[test]
    fn re_present_supersedes_enqueued_command() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("allow"));
        broker.respond(decision, "ui").expect("responds");
        let stale = receiver.try_recv().expect("command enqueued");
        let mut updated = approval_request("r1");
        updated.title = "Run revised command".into();
        broker.present(updated, test_binding()).unwrap();
        let mut sent = false;
        broker
            .dispatch(&stale, || {
                sent = true;
                Ok(())
            })
            .expect("dispatch checks state");
        assert!(!sent, "superseded revision must not dispatch");
        let fresh = decision_for(&broker, "r1", Some("deny"));
        broker
            .respond(fresh, "ui")
            .expect("fresh revision responds");
    }

    #[test]
    fn stop_before_dispatch_suppresses_send() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("allow"));
        broker.respond(decision, "ui").expect("responds");
        let command = receiver.try_recv().expect("command enqueued");
        broker.close("Stop requested");
        let mut sent = false;
        broker
            .dispatch(&command, || {
                sent = true;
                Ok(())
            })
            .expect("dispatch tolerates stop");
        assert!(!sent, "stopped turn must not dispatch");
        assert!(!broker.waiting());
        let snapshot = broker.snapshot();
        assert!(!snapshot.active);
        let expired = snapshot
            .requests
            .iter()
            .find(|request| request.id == "r1")
            .unwrap();
        assert_eq!(expired.status, "expired");
    }

    #[test]
    fn dispatch_sends_only_for_matching_submitting_binding() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        let decision = decision_for(&broker, "r1", Some("allow"));
        broker.respond(decision, "ui").expect("responds");
        let command = receiver.try_recv().expect("command enqueued");
        let mut sent = false;
        broker
            .dispatch(&command, || {
                sent = true;
                Ok(())
            })
            .expect("matching dispatch sends");
        assert!(sent);

        let forged = Command {
            decision: command.decision.clone(),
            binding: json!({"forged": true}),
        };
        let mut forged_sent = false;
        broker
            .dispatch(&forged, || {
                forged_sent = true;
                Ok(())
            })
            .expect("forged dispatch tolerated");
        assert!(!forged_sent, "forged binding must not dispatch");
    }

    #[test]
    fn strict_serde_rejects_injected_routing_fields() {
        let routed = json!({
            "generation": "gen-1",
            "id": "r1",
            "revision": 1,
            "choice_id": "allow",
            "feedback": null,
            "answers": [],
            "cancel": false,
            "binding": {"session": "evil"},
        });
        assert!(serde_json::from_value::<Decision>(routed).is_err());
        let sourced = json!({
            "generation": "gen-1",
            "id": "r1",
            "revision": 1,
            "choice_id": null,
            "feedback": null,
            "answers": [],
            "cancel": false,
            "source": "evil",
        });
        assert!(serde_json::from_value::<Decision>(sourced).is_err());
        let minimal = json!({
            "generation": "gen-1",
            "id": "r1",
            "revision": 1,
        });
        let decision: Decision = serde_json::from_value(minimal).expect("defaults apply");
        assert!(decision.answers.is_empty());
        assert!(!decision.cancel);

        let extra = json!({"question_id": "q", "selected": [], "text": null, "extra": 1});
        assert!(serde_json::from_value::<Answer>(extra).is_err());
    }

    #[test]
    fn single_select_accepts_exactly_one_known_option() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let valid = question_decision_for(&broker, "q1", vec![selected_answer(&["a"])]);
        broker.respond(valid, "ui").expect("single select responds");
    }

    #[test]
    fn single_select_rejects_empty_repeated_or_unknown_options() {
        for (labels, hint) in [
            (vec![], "empty"),
            (vec!["a", "b"], "two"),
            (vec!["zzz"], "unknown"),
            (vec!["a", "a"], "repeated"),
        ] {
            let (broker, _receiver) = Broker::new("gen-1".into());
            broker
                .present(single_question_request("q1"), test_binding())
                .unwrap();
            let decision = question_decision_for(&broker, "q1", vec![selected_answer(&labels)]);
            let error = broker.respond(decision, "ui").err().expect(hint);
            assert!(error.contains("Select valid options"), "{hint}: {error}");
        }
    }

    #[test]
    fn multiple_select_honors_min_and_max() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(multi_question_request("q1"), test_binding())
            .unwrap();
        let valid = question_decision_for(&broker, "q1", vec![selected_answer(&["a", "c"])]);
        broker.respond(valid, "ui").expect("two options respond");

        for (labels, hint) in [(vec![], "below min"), (vec!["a", "b", "c"], "above max")] {
            let (broker, _receiver) = Broker::new("gen-1".into());
            broker
                .present(multi_question_request("q1"), test_binding())
                .unwrap();
            let decision = question_decision_for(&broker, "q1", vec![selected_answer(&labels)]);
            let error = broker.respond(decision, "ui").err().expect(hint);
            assert!(error.contains("Select valid options"), "{hint}: {error}");
        }
    }

    #[test]
    fn free_text_requires_trimmed_text_alone_within_limit() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(free_text_request("q1"), test_binding())
            .unwrap();
        let valid = question_decision_for(
            &broker,
            "q1",
            vec![Answer {
                question_id: "q".into(),
                selected: Vec::new(),
                text: Some("hello".into()),
            }],
        );
        broker.respond(valid, "ui").expect("free text responds");

        let cases = [
            (
                Some("   ".to_owned()),
                vec!["a".to_owned()].into(),
                "blank with selection",
            ),
            (Some("   ".to_owned()), Vec::new(), "blank"),
            (Some("x".repeat(501)), Vec::new(), "too long"),
            (
                Some("hello".to_owned()),
                vec!["a".to_owned()],
                "text plus selection",
            ),
        ];
        for (text, selected, hint) in cases {
            let (broker, _receiver) = Broker::new("gen-1".into());
            broker
                .present(free_text_request("q1"), test_binding())
                .unwrap();
            let decision = question_decision_for(
                &broker,
                "q1",
                vec![Answer {
                    question_id: "q".into(),
                    selected,
                    text,
                }],
            );
            let error = broker.respond(decision, "ui").err().expect(hint);
            assert!(error.contains("Enter an answer"), "{hint}: {error}");
        }

        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let decision = question_decision_for(
            &broker,
            "q1",
            vec![Answer {
                question_id: "q".into(),
                selected: Vec::new(),
                text: Some("hello".into()),
            }],
        );
        let error = broker.respond(decision, "ui").err().expect("text refused");
        assert!(error.contains("Enter an answer"), "{error}");
    }

    #[test]
    fn cancel_and_answer_shapes_validated() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let mut cancelled = decision_for(&broker, "q1", None);
        cancelled.cancel = true;
        broker.respond(cancelled, "ui").expect("cancel responds");

        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let mut answered_cancel =
            question_decision_for(&broker, "q1", vec![selected_answer(&["a"])]);
        answered_cancel.cancel = true;
        let error = broker
            .respond(answered_cancel, "ui")
            .err()
            .expect("answered cancel");
        assert!(error.contains("cannot also contain answers"), "{error}");

        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let missing = question_decision_for(&broker, "q1", Vec::new());
        let error = broker.respond(missing, "ui").err().expect("missing answer");
        assert!(error.contains("Answer every question"), "{error}");

        let (broker, _receiver) = Broker::new("gen-1".into());
        let mut request = single_question_request("q1");
        let mut second = request.questions[0].clone();
        second.id = "q2".into();
        request.questions.push(second);
        broker.present(request, test_binding()).unwrap();
        let duplicated = question_decision_for(
            &broker,
            "q1",
            vec![selected_answer(&["a"]), selected_answer(&["b"])],
        );
        let error = broker
            .respond(duplicated, "ui")
            .err()
            .expect("duplicate answer");
        assert!(error.contains("more than once"), "{error}");

        let (broker, _receiver) = Broker::new("gen-1".into());
        broker
            .present(single_question_request("q1"), test_binding())
            .unwrap();
        let unknown = question_decision_for(
            &broker,
            "q1",
            vec![Answer {
                question_id: "other".into(),
                selected: vec!["a".into()],
                text: None,
            }],
        );
        let error = broker
            .respond(unknown, "ui")
            .err()
            .expect("unknown question");
        assert!(error.contains("no longer available"), "{error}");
    }

    #[test]
    fn channel_backpressure_rejects_when_receiver_full() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        for index in 0..33 {
            let id = format!("r{index}");
            broker
                .present(approval_request(&id), test_binding())
                .unwrap();
            let decision = decision_for(&broker, &id, Some("allow"));
            if index < 32 {
                broker.respond(decision, "ui").expect("channel has room");
            } else {
                let error = broker.respond(decision, "ui").err().expect("channel full");
                assert!(error.contains("not accepting"), "{error}");
            }
        }
    }

    #[test]
    fn disconnected_receiver_rejected() {
        let (broker, receiver) = Broker::new("gen-1".into());
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        drop(receiver);
        let decision = decision_for(&broker, "r1", Some("allow"));
        let error = broker.respond(decision, "ui").err().expect("receiver gone");
        assert!(error.contains("not accepting"), "{error}");
    }

    #[test]
    fn waiting_lifecycle_tracks_pending_submitting_and_close() {
        let (broker, _receiver) = Broker::new("gen-1".into());
        assert!(!broker.waiting());
        assert_eq!(broker.waited_seconds(), 0);
        broker
            .present(approval_request("r1"), test_binding())
            .unwrap();
        assert!(broker.waiting());
        broker.settle("r1", "approved", None);
        assert!(!broker.waiting());

        broker
            .present(approval_request("r2"), test_binding())
            .unwrap();
        assert!(broker.waiting());
        let decision = decision_for(&broker, "r2", Some("allow"));
        broker.respond(decision, "ui").expect("responds");
        assert!(broker.waiting(), "submitting still waits");
        broker.close("turn ended");
        assert!(!broker.waiting());
    }
}
