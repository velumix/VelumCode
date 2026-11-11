//! Provider counters are separate from Velum's approximate memory-token count.
//! Never use cumulative billable tokens as the current context occupancy.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_COUNTER: u64 = 9_007_199_254_740_991;
const TAIL_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TurnUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub elapsed_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub window_tokens: Option<u64>,
    pub measured_at: i64,
    /// True when `used_tokens` is a clearly-marked provider-side estimate
    /// rather than an exact reported snapshot (Muse reports per-step input
    /// sizes but no window capacity). Absent/false keeps the exact meaning.
    #[serde(default)]
    pub estimated: bool,
}

pub struct CodexUsage {
    pub context: ContextUsage,
    pub total: Option<TurnUsage>,
}

impl TurnUsage {
    pub fn zero() -> Self {
        Self {
            input_tokens: Some(0),
            cached_input_tokens: Some(0),
            output_tokens: Some(0),
            reasoning_output_tokens: Some(0),
            elapsed_ms: None,
        }
    }

    /// Session totals are monotonic. A reset or missing baseline makes the
    /// rate unavailable rather than counting earlier turns again.
    pub fn since(&self, baseline: &Self, elapsed_ms: u64) -> Self {
        fn delta(current: Option<u64>, previous: Option<u64>) -> Option<u64> {
            current?.checked_sub(previous?)
        }
        Self {
            input_tokens: delta(self.input_tokens, baseline.input_tokens),
            cached_input_tokens: delta(self.cached_input_tokens, baseline.cached_input_tokens),
            output_tokens: delta(self.output_tokens, baseline.output_tokens),
            reasoning_output_tokens: delta(
                self.reasoning_output_tokens,
                baseline.reasoning_output_tokens,
            ),
            elapsed_ms: Some(elapsed_ms),
        }
    }

    pub fn add(&self, other: &Self) -> Self {
        fn sum(a: Option<u64>, b: Option<u64>) -> Option<u64> {
            a?.checked_add(b?).filter(|n| *n <= MAX_COUNTER)
        }
        Self {
            input_tokens: sum(self.input_tokens, other.input_tokens),
            cached_input_tokens: sum(self.cached_input_tokens, other.cached_input_tokens),
            output_tokens: sum(self.output_tokens, other.output_tokens),
            reasoning_output_tokens: sum(
                self.reasoning_output_tokens,
                other.reasoning_output_tokens,
            ),
            elapsed_ms: None,
        }
    }
}

fn counter(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_COUNTER)
}

/// Normalize provider counters. Their scope comes from the containing event;
/// cumulative totals need a baseline before they can describe a single turn.
pub fn codex_turn(value: &Value) -> Option<TurnUsage> {
    let usage = TurnUsage {
        input_tokens: counter(&value["input_tokens"]),
        cached_input_tokens: counter(&value["cached_input_tokens"]),
        output_tokens: counter(&value["output_tokens"]),
        reasoning_output_tokens: counter(&value["reasoning_output_tokens"]),
        elapsed_ms: None,
    };
    (usage.input_tokens.is_some() || usage.output_tokens.is_some()).then_some(usage)
}

/// Some exec versions return session totals on resume. Subtract the launch
/// baseline only when completion counters match the retained session totals;
/// otherwise preserve the documented per-turn completion counters.
pub fn codex_completion(
    reported: &TurnUsage,
    total: Option<&TurnUsage>,
    baseline: Option<&TurnUsage>,
    elapsed_ms: u64,
) -> TurnUsage {
    if let Some(total) = total.filter(|total| {
        reported.input_tokens.is_some()
            && reported.output_tokens.is_some()
            && reported.input_tokens == total.input_tokens
            && reported.output_tokens == total.output_tokens
    }) {
        return total.since(baseline.unwrap_or(&TurnUsage::default()), elapsed_ms);
    }
    let mut usage = reported.clone();
    usage.elapsed_ms = Some(elapsed_ms);
    usage
}

pub fn antigravity_step(value: &Value) -> Option<TurnUsage> {
    let usage = TurnUsage {
        input_tokens: counter(&value["input_tokens"]),
        cached_input_tokens: counter(&value["cache_read_tokens"]),
        output_tokens: counter(&value["output_tokens"]),
        reasoning_output_tokens: counter(&value["thinking_tokens"]),
        elapsed_ms: None,
    };
    (usage.input_tokens.is_some() || usage.output_tokens.is_some()).then_some(usage)
}

pub fn claude_turn(value: &Value) -> Option<TurnUsage> {
    let source = if value["usage"].is_object() {
        &value["usage"]
    } else {
        value
    };
    let usage = TurnUsage {
        input_tokens: counter(&source["input_tokens"]),
        cached_input_tokens: counter(&source["cache_read_input_tokens"]),
        output_tokens: counter(&source["output_tokens"]),
        reasoning_output_tokens: None,
        elapsed_ms: counter(&value["duration_ms"]).filter(|ms| *ms > 0),
    };
    (usage.input_tokens.is_some()
        || usage.cached_input_tokens.is_some()
        || usage.output_tokens.is_some())
    .then_some(usage)
}

pub fn muse_session_file(session: &str) -> Option<PathBuf> {
    uuid::Uuid::parse_str(session).ok()?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::pty::home_dir().join(".local").join("share"));
    fn find(root: &Path, session: &str, depth: usize, budget: &mut usize) -> Option<PathBuf> {
        if fs::symlink_metadata(root).ok()?.file_type().is_symlink() {
            return None;
        }
        for entry in fs::read_dir(root).ok()?.flatten() {
            if *budget == 0 {
                return None;
            }
            *budget -= 1;
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            if entry.file_name() == session {
                let path = entry.path().join("session.jsonl");
                if fs::symlink_metadata(&path)
                    .ok()
                    .is_some_and(|m| m.file_type().is_file())
                {
                    return Some(path);
                }
            } else if depth > 0 {
                if let Some(path) = find(&entry.path(), session, depth - 1, budget) {
                    return Some(path);
                }
            }
        }
        None
    }
    find(&data.join("muse").join("sessions"), session, 3, &mut 30_000)
}

/// Muse exec omits usage on stdout. Read only this run's model_completed
/// counters from its retained session, starting at the pre-launch file size.
/// The reader is incremental and skips oversized non-usage records.
pub struct MuseUsage {
    offset: u64,
    partial: Vec<u8>,
    oversized: bool,
    seen: HashSet<String>,
    usage: Option<TurnUsage>,
    /// High-water mark of this run's per-step `input_tokens`. Each step's
    /// input already contains the conversation history, so the maximum is
    /// the closest observable proxy for current context occupancy.
    max_input: Option<u64>,
}
impl MuseUsage {
    pub fn new(offset: u64) -> Self {
        Self {
            offset,
            partial: Vec::new(),
            oversized: false,
            seen: HashSet::new(),
            usage: None,
            max_input: None,
        }
    }
    /// Labeled context estimate for the usage strip. The retained schema
    /// reports no window capacity, so `window_tokens` stays `None` and the
    /// snapshot is flagged `estimated`; the UI must say so, never show a %.
    pub fn context_estimate(&self) -> Option<ContextUsage> {
        self.max_input.map(|used_tokens| ContextUsage {
            used_tokens,
            window_tokens: None,
            measured_at: chrono::Utc::now().timestamp_millis(),
            estimated: true,
        })
    }
    pub fn finish(&mut self, path: &Path, session: &str, run: &str) -> Option<TurnUsage> {
        let length = fs::metadata(path).ok()?.len();
        let mut usage = self.poll(path, session, run);
        while self.offset < length {
            let before = self.offset;
            usage = self.poll(path, session, run);
            if self.offset == before {
                return None;
            }
        }
        usage
    }
    pub fn poll(&mut self, path: &Path, session: &str, run: &str) -> Option<TurnUsage> {
        let mut file = fs::File::open(path).ok()?;
        // A replaced/truncated file cannot preserve an earlier byte position.
        // Run and record IDs still prevent old turns and duplicates being counted.
        if file.metadata().ok()?.len() < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.oversized = false;
        }
        file.seek(SeekFrom::Start(self.offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(5 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
        self.offset += bytes.len() as u64;
        for byte in bytes {
            if byte == b'\n' {
                if !self.oversized {
                    self.observe(session, run);
                }
                self.partial.clear();
                self.oversized = false;
            } else if !self.oversized {
                if self.partial.len() >= 1024 * 1024 {
                    self.partial.clear();
                    self.oversized = true;
                } else {
                    self.partial.push(byte);
                }
            }
        }
        self.usage.clone()
    }
    fn observe(&mut self, session: &str, run: &str) {
        let Ok(value) = serde_json::from_slice::<Value>(&self.partial) else {
            return;
        };
        if value["payload_type"] != "runtime.session"
            || value["stream"]["kind"] != "session"
            || value["stream"]["id"] != session
            || value["payload"]["run_id"] != run
            || value["payload"]["event"]["kind"] != "model_completed"
        {
            return;
        }
        let record_id = value["payload"]["source_run_record_id"]
            .as_str()
            .or_else(|| value["id"].as_str());
        let Some(record_id) = record_id.filter(|id| uuid::Uuid::parse_str(id).is_ok()) else {
            return;
        };
        let value = &value["payload"]["event"]["usage"];
        let usage = TurnUsage {
            input_tokens: counter(&value["input_tokens"]),
            cached_input_tokens: counter(&value["cached_tokens"])
                .or_else(|| counter(&value["cache_read_tokens"])),
            output_tokens: counter(&value["output_tokens"]),
            reasoning_output_tokens: counter(&value["reasoning_tokens"]),
            elapsed_ms: None,
        };
        if usage.input_tokens.is_none() && usage.output_tokens.is_none() {
            return;
        }
        if self.seen.len() >= 100_000 || !self.seen.insert(record_id.to_owned()) {
            return;
        }
        if let Some(input) = usage.input_tokens {
            self.max_input = Some(self.max_input.map_or(input, |mark| mark.max(input)));
        }
        self.usage = Some(
            self.usage
                .as_ref()
                .map(|prior| prior.add(&usage))
                .unwrap_or(usage),
        );
    }
}

/// Locate only the UUID returned by the active provider. Bound the search,
/// do not traverse symlinks, and never select a different recent thread.
pub fn codex_session_file(session: &str) -> Option<PathBuf> {
    uuid::Uuid::parse_str(session).ok()?;
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
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
                return Some(entry.path());
            }
            if kind.is_dir() && depth > 0 {
                if let Some(path) = find(&entry.path(), suffix, depth - 1, budget) {
                    return Some(path);
                }
            }
        }
        None
    }
    find(&home.join("sessions"), &suffix, 3, &mut 30_000)
}

/// Read a bounded tail, retaining only numeric token metadata. The snapshot
/// must belong to this turn; old model/window values cannot revive a reset.
pub fn codex_usage(path: &Path, since_ms: i64) -> Option<CodexUsage> {
    let mut file = fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let mut latest = None;
    for (index, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if index == 0 && start > 0 {
            continue; // The first record may begin outside the bounded tail.
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value["type"] != "event_msg" || value["payload"]["type"] != "token_count" {
            continue;
        }
        let Some(stamp) = value["timestamp"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        else {
            continue;
        };
        let measured_at = stamp.timestamp_millis();
        if measured_at < since_ms {
            continue;
        }
        let info = &value["payload"]["info"];
        let last = &info["last_token_usage"];
        // The provider includes reasoning within output/total; never add it twice.
        let used = counter(&last["total_tokens"]).or_else(|| {
            counter(&last["input_tokens"])?
                .checked_add(counter(&last["output_tokens"])?)
                .filter(|n| *n <= MAX_COUNTER)
        });
        if let Some(used_tokens) = used {
            latest = Some(CodexUsage {
                context: ContextUsage {
                    used_tokens,
                    window_tokens: counter(&info["model_context_window"]).filter(|n| *n > 0),
                    measured_at,
                    estimated: false,
                },
                total: codex_turn(&info["total_token_usage"]),
            });
        }
    }
    latest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Log(PathBuf);
    impl Log {
        fn new(text: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("velum-usage-{}.jsonl", uuid::Uuid::new_v4()));
            fs::write(&path, text).unwrap();
            Self(path)
        }
    }
    impl Drop for Log {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    fn record() -> Value {
        json!({"timestamp":"2026-09-29T18:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{
            "model_context_window":258400,
            "last_token_usage":{"input_tokens":18000,"output_tokens":300,"reasoning_output_tokens":100,"total_tokens":18300},
            "total_token_usage":{"input_tokens":146448,"cached_input_tokens":100000,"output_tokens":899,"reasoning_output_tokens":400}
        }}})
    }
    #[test]
    fn context_uses_latest_request_not_cumulative_billing_or_double_reasoning() {
        let log = Log::new(&record().to_string());
        let result = codex_usage(&log.0, i64::MIN).unwrap();
        assert_eq!(result.context.used_tokens, 18300);
        assert_eq!(result.context.window_tokens, Some(258400));
        assert!(!result.context.estimated);
        assert_eq!(result.total.unwrap().input_tokens, Some(146448));
    }
    #[test]
    fn muse_context_estimate_tracks_input_high_water_mark() {
        let session = uuid::Uuid::new_v4().to_string();
        let run = uuid::Uuid::new_v4().to_string();
        let record = |id: &str, input: u64| {
            json!({"stream":{"kind":"session","id":session},"payload_type":"runtime.session",
                "id":id,"payload":{"run_id":run,"source_run_record_id":id,
                "event":{"kind":"model_completed",
                "usage":{"input_tokens":input,"output_tokens":10,"reasoning_tokens":2}}}})
            .to_string()
        };
        // No records yet: no estimate rather than a zero that looks measured.
        assert!(MuseUsage::new(0).context_estimate().is_none());
        let first = uuid::Uuid::new_v4().to_string();
        let log = Log::new(&format!("{}\n", record(&first, 27020)));
        let mut monitor = MuseUsage::new(0);
        monitor.poll(&log.0, &session, &run);
        let estimate = monitor.context_estimate().unwrap();
        assert_eq!(estimate.used_tokens, 27020);
        assert_eq!(estimate.window_tokens, None);
        assert!(estimate.estimated);
        // A later step with a smaller input (e.g. a compacted retry) must not
        // lower the occupancy mark; duplicates must not move it either.
        let second = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            &log.0,
            format!("{}\n{}\n", record(&first, 27020), record(&second, 8000)),
        )
        .unwrap();
        monitor.poll(&log.0, &session, &run);
        assert_eq!(monitor.context_estimate().unwrap().used_tokens, 27020);
        // Growth is reflected on the next poll.
        let third = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            &log.0,
            format!(
                "{}\n{}\n{}\n",
                record(&first, 27020),
                record(&second, 8000),
                record(&third, 27299)
            ),
        )
        .unwrap();
        monitor.poll(&log.0, &session, &run);
        assert_eq!(monitor.context_estimate().unwrap().used_tokens, 27299);
    }
    #[test]
    fn resumed_turn_subtracts_baseline_and_missing_or_reset_counts_stay_unknown() {
        let baseline =
            codex_turn(&json!({"input_tokens":100,"cached_input_tokens":70,"output_tokens":20}))
                .unwrap();
        let current = codex_turn(&json!({"input_tokens":150,"cached_input_tokens":100,"output_tokens":30,"reasoning_output_tokens":4})).unwrap();
        let turn = current.since(&baseline, 2000);
        assert_eq!(turn.input_tokens, Some(50));
        assert_eq!(turn.cached_input_tokens, Some(30));
        assert_eq!(turn.output_tokens, Some(10));
        assert_eq!(turn.reasoning_output_tokens, None);
        assert_eq!(turn.elapsed_ms, Some(2000));
        assert_eq!(baseline.since(&current, 2000).output_tokens, None);
        assert_eq!(
            current.since(&TurnUsage::default(), 2000).output_tokens,
            None
        );
    }
    #[test]
    fn counters_reject_negative_fractional_and_unsafe_integers() {
        assert!(codex_turn(&json!({"input_tokens":-1,"output_tokens":1.2})).is_none());
        assert!(codex_turn(&json!({"output_tokens":MAX_COUNTER+1})).is_none());
        assert_eq!(
            codex_turn(&json!({"output_tokens":0}))
                .unwrap()
                .output_tokens,
            Some(0)
        );
    }
    #[test]
    fn codex_completion_distinguishes_cumulative_and_per_turn_schemas() {
        let baseline =
            codex_turn(&json!({"input_tokens":100,"cached_input_tokens":70,"output_tokens":20}))
                .unwrap();
        let total =
            codex_turn(&json!({"input_tokens":150,"cached_input_tokens":100,"output_tokens":30}))
                .unwrap();
        let current =
            codex_turn(&json!({"input_tokens":50,"cached_input_tokens":30,"output_tokens":10}))
                .unwrap();
        let cumulative = codex_completion(&total, Some(&total), Some(&baseline), 2000);
        assert_eq!(cumulative.input_tokens, Some(50));
        assert_eq!(cumulative.cached_input_tokens, Some(30));
        assert_eq!(cumulative.output_tokens, Some(10));
        assert_eq!(cumulative.elapsed_ms, Some(2000));
        assert_eq!(
            codex_completion(&current, Some(&total), Some(&baseline), 2000),
            cumulative
        );
        assert_eq!(
            codex_completion(&total, Some(&total), None, 2000).output_tokens,
            None
        );
        assert_eq!(
            codex_completion(&baseline, Some(&baseline), Some(&total), 2000).output_tokens,
            None
        );
        assert_eq!(
            codex_completion(&current, None, None, 2000).output_tokens,
            Some(10)
        );
    }
    fn muse_record(session: &str, run: &str, id: &str, output: Value) -> Value {
        json!({"id":id,"stream":{"kind":"session","id":session},"payload_type":"runtime.session",
            "payload":{"run_id":run,"source_run_record_id":id,"event":{"kind":"model_completed",
                "usage":{"input_tokens":100,"cached_tokens":70,"output_tokens":output,"reasoning_tokens":4}}}})
    }
    #[test]
    fn muse_counts_only_current_root_run_and_deduplicates_model_records() {
        use std::io::Write;
        let session = uuid::Uuid::new_v4().to_string();
        let run = uuid::Uuid::new_v4().to_string();
        let old = muse_record(
            &session,
            "old-run",
            &uuid::Uuid::new_v4().to_string(),
            json!(900),
        );
        let log = Log::new(&format!("{old}\n"));
        let mut tracker = MuseUsage::new(fs::metadata(&log.0).unwrap().len());
        let record = muse_record(&session, &run, &uuid::Uuid::new_v4().to_string(), json!(30));
        let other = muse_record(
            &session,
            "child-run",
            &uuid::Uuid::new_v4().to_string(),
            json!(600),
        );
        let mut file = fs::OpenOptions::new().append(true).open(&log.0).unwrap();
        write!(file, "{record}\n{record}\n{other}\n").unwrap();
        assert_eq!(
            tracker.poll(&log.0, &session, &run).unwrap().output_tokens,
            Some(30)
        );
        let next = muse_record(&session, &run, &uuid::Uuid::new_v4().to_string(), json!(20));
        writeln!(file, "{next}").unwrap();
        let result = tracker.finish(&log.0, &session, &run).unwrap();
        assert_eq!(result.input_tokens, Some(200));
        assert_eq!(result.cached_input_tokens, Some(140));
        assert_eq!(result.output_tokens, Some(50));
        assert_eq!(result.reasoning_output_tokens, Some(8));
        assert_eq!(tracker.poll(&log.0, &session, &run), Some(result));
    }
    #[test]
    fn muse_handles_partial_lines_large_non_usage_records_and_truncation() {
        use std::io::Write;
        let session = uuid::Uuid::new_v4().to_string();
        let run = uuid::Uuid::new_v4().to_string();
        let record = muse_record(&session, &run, &uuid::Uuid::new_v4().to_string(), json!(12));
        let text = record.to_string();
        let log = Log::new(&text[..40]);
        let mut tracker = MuseUsage::new(0);
        assert!(tracker.poll(&log.0, &session, &run).is_none());
        fs::OpenOptions::new()
            .append(true)
            .open(&log.0)
            .unwrap()
            .write_all(format!("{}\n", &text[40..]).as_bytes())
            .unwrap();
        assert_eq!(
            tracker.poll(&log.0, &session, &run).unwrap().output_tokens,
            Some(12)
        );
        let second = muse_record(&session, &run, &uuid::Uuid::new_v4().to_string(), json!(8));
        fs::write(&log.0, format!("{second}\n")).unwrap();
        assert_eq!(
            tracker.poll(&log.0, &session, &run).unwrap().output_tokens,
            Some(20)
        );
        fs::write(
            &log.0,
            format!("{}\n{record}\n{second}\n", "x".repeat(6 * 1024 * 1024)),
        )
        .unwrap();
        let mut fresh = MuseUsage::new(0);
        assert!(fresh.poll(&log.0, &session, &run).is_none());
        assert_eq!(
            fresh.finish(&log.0, &session, &run).unwrap().output_tokens,
            Some(20)
        );
    }
    #[test]
    fn stale_snapshots_cannot_revive_reset_or_changed_model_context() {
        let log = Log::new(&record().to_string());
        let stamp = codex_usage(&log.0, i64::MIN).unwrap().context.measured_at;
        assert!(codex_usage(&log.0, stamp + 1).is_none());
        assert!(codex_usage(&log.0, stamp).is_some());
    }
    #[test]
    fn fallback_excludes_reasoning_and_unknown_capacity_remains_unknown() {
        let mut value = record();
        value["payload"]["info"]["last_token_usage"]["total_tokens"] = Value::Null;
        value["payload"]["info"]["model_context_window"] = json!(0);
        let log = Log::new(&value.to_string());
        let result = codex_usage(&log.0, i64::MIN).unwrap();
        assert_eq!(result.context.used_tokens, 18300);
        assert_eq!(result.context.window_tokens, None);
    }
    #[test]
    fn bounded_tail_ignores_messages_partial_records_and_invalid_json() {
        let log = Log::new(&format!(
            "{}\n{{invalid\n{}\n{}\n{{unfinished",
            "x".repeat(TAIL_BYTES as usize + 20),
            json!({"type":"response_item","payload":{"content":"private content"}}),
            record()
        ));
        assert_eq!(
            codex_usage(&log.0, i64::MIN).unwrap().context.used_tokens,
            18300
        );
        assert!(codex_session_file("../../different-thread").is_none());
    }
}
