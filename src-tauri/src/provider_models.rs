//! Read model capabilities from installed CLIs without starting an agent turn.
use crate::providers::Provider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{ChildStdin, Command, Stdio},
    sync::{mpsc, LazyLock, Mutex},
    time::{Duration, Instant},
};

const EFFORTS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
#[derive(Clone, Default, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct RunOptions {
    pub model: String,
    pub reasoning: String,
}
impl RunOptions {
    pub fn validate(&self, provider: Provider) -> Result<(), String> {
        if self.model.len() > 200
            || self.model.starts_with('-')
            || !self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._/:@+".contains(&b))
        {
            return Err(
                "Use a model ID containing letters, numbers, dots, dashes, underscores or slashes."
                    .into(),
            );
        }
        if !self.reasoning.is_empty()
            && (!EFFORTS.contains(&self.reasoning.as_str())
                || (provider == Provider::Antigravity
                    && !["low", "medium", "high", "max"].contains(&self.reasoning.as_str()))
                || (provider == Provider::Claude
                    && !["low", "medium", "high", "xhigh", "max"]
                        .contains(&self.reasoning.as_str())))
        {
            return Err("This provider does not support that reasoning level.".into());
        }
        if !self.reasoning.is_empty() {
            if let Some((_, catalog)) = CATALOGS.lock().unwrap().get(&provider) {
                if let Some(model) = catalog.models.iter().find(|m| m.id == self.model) {
                    if !model.efforts.contains(&self.reasoning) {
                        return Err("That reasoning level is unavailable for this model. Choose a supported level.".into());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn args(&self, provider: Provider) -> Vec<String> {
        let mut args = vec![];
        if !self.model.is_empty() {
            args.extend(["--model".into(), self.model.clone()]);
        }
        if !self.reasoning.is_empty() {
            args.extend(match provider {
                Provider::Muse => ["--reasoning-effort".into(), self.reasoning.clone()],
                Provider::Codex => [
                    "-c".into(),
                    // TOML literal quotes survive Windows PowerShell and .cmd shims.
                    format!("model_reasoning_effort='{}'", self.reasoning),
                ],
                Provider::Antigravity | Provider::Claude => {
                    ["--effort".into(), self.reasoning.clone()]
                }
            });
        }
        args
    }
}
#[derive(Clone, Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub description: String,
    pub efforts: Vec<String>,
    pub default_effort: String,
    pub is_default: bool,
}
#[derive(Clone, Default, Serialize)]
pub struct Catalog {
    pub models: Vec<Model>,
    pub notice: Option<String>,
    pub defaults: RunOptions,
}
static CATALOGS: LazyLock<Mutex<HashMap<Provider, (Instant, Catalog)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Every discovery process is bounded and reaped, including shim descendants.
struct Process(crate::child_process::Child);
fn command_path(path: &std::path::Path) -> Command {
    let mut cmd = if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ps1"))
    {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(path);
        cmd
    } else {
        Command::new(path)
    };
    cmd.current_dir(crate::pty::home_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
fn command(provider: Provider) -> Result<Command, String> {
    let path = provider.resolve().ok_or_else(|| provider.missing())?;
    Ok(command_path(&path))
}
struct Rpc {
    _process: Process,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    deadline: Instant,
}
impl Rpc {
    fn start(provider: Provider) -> Result<Self, String> {
        let mut cmd = command(provider)?;
        cmd.args(if provider == Provider::Muse {
            vec!["serve", "--no-session-log"]
        } else {
            vec!["app-server", "--stdio"]
        });
        let mut process = Process(
            crate::child_process::Child::spawn(&mut cmd)
                .map_err(|_| "Could not start model discovery.")?,
        );
        let input = process
            .0
            .stdin
            .take()
            .ok_or("Model discovery input unavailable.")?;
        let out = process
            .0
            .stdout
            .take()
            .ok_or("Model discovery output unavailable.")?;
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            // Enforce a total bound as well as a line bound for unknown CLI builds.
            for line in BufReader::new(out.take(2 * 1024 * 1024))
                .lines()
                .take(2000)
                .map_while(Result::ok)
            {
                if line.len() > 1024 * 1024 {
                    break;
                }
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let mut rpc = Self {
            _process: process,
            input,
            output,
            deadline: Instant::now() + Duration::from_secs(20),
        };
        rpc.request(0, "initialize", json!({"clientInfo":{"name":"velum_code","title":"Velum Code","version":env!("CARGO_PKG_VERSION")}}))?;
        rpc.send(json!({"jsonrpc":"2.0", "method":"initialized", "params":{}}))?;
        Ok(rpc)
    }
    fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Model discovery ended unexpectedly.".into())
    }
    fn request(&mut self, id: u32, method: &str, params: Value) -> Result<Value, String> {
        self.send(json!({"jsonrpc":"2.0", "id":id,"method":method,"params":params}))?;
        loop {
            let timeout = self.deadline.saturating_duration_since(Instant::now());
            let value = self.output.recv_timeout(timeout).map_err(|_| {
                "Could not load models. Check the CLI installation and sign-in, then refresh."
            })?;
            if value["id"] == id {
                if value.get("error").is_some() {
                    return Err("This CLI could not list its models. Update or sign in to the CLI, then refresh.".into());
                }
                return Ok(value["result"].clone());
            }
        }
    }
}
fn field(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(1000)
        .collect()
}
fn parse_rpc_models(provider: Provider, value: &Value) -> Vec<Model> {
    let key = if provider == Provider::Muse {
        "models"
    } else {
        "data"
    };
    value[key]
        .as_array()
        .into_iter()
        .flatten()
        .take(500)
        .filter(|m| m["hidden"] != true)
        .filter_map(|entry| {
            let (id, label, variants) = if provider == Provider::Muse {
                (
                    field(entry, "modelId"),
                    field(entry, "displayLabel"),
                    &entry["variants"],
                )
            } else {
                (
                    field(entry, "model"),
                    field(entry, "displayName"),
                    &entry["supportedReasoningEfforts"],
                )
            };
            if id.is_empty()
                || (RunOptions {
                    model: id.clone(),
                    reasoning: String::new(),
                })
                .validate(provider)
                .is_err()
            {
                return None;
            }
            let efforts: Vec<String> = variants
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    effort
                        .as_str()
                        .or_else(|| effort["reasoningEffort"].as_str())
                })
                .filter(|v| EFFORTS.contains(v))
                .map(str::to_owned)
                .collect();
            let mut default_effort = field(entry, "defaultReasoningEffort");
            // Muse's CLI starts at high; only offer it when this model supports it.
            if provider == Provider::Muse
                && default_effort.is_empty()
                && efforts.iter().any(|e| e == "high")
            {
                default_effort = "high".into();
            }
            Some(Model {
                label: if label.is_empty() { id.clone() } else { label },
                id,
                description: field(entry, "description"),
                efforts,
                default_effort,
                is_default: entry["isDefault"] == true,
            })
        })
        .collect()
}
fn parse_agy_models(output: &str) -> Vec<Model> {
    let mut result: Vec<Model> = vec![];
    for line in output.lines().take(1000) {
        let line = line.trim();
        let Some((id, label)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let label = label.trim();
        if !id.contains('-')
            || label.is_empty()
            || id.starts_with('-')
            || id.ends_with(':')
            || (RunOptions {
                model: id.into(),
                reasoning: String::new(),
            })
            .validate(Provider::Antigravity)
            .is_err()
        {
            continue;
        }
        let effort = ["low", "medium", "high", "max"]
            .into_iter()
            .find(|e| id.ends_with(&format!("-{e}")));
        let family = effort
            .map(|e| id.trim_end_matches(&format!("-{e}")))
            .unwrap_or(id);
        if let Some(existing) = result.iter_mut().find(|m| {
            m.id.rsplit_once('-')
                .is_some_and(|(base, _)| base == family)
        }) {
            if let Some(effort) = effort {
                if !existing.efforts.contains(&effort.into()) {
                    existing.efforts.push(effort.into());
                }
                continue;
            }
        }
        let label = if let Some(effort) = effort {
            let suffix = format!(" ({})", effort_label(effort));
            label.strip_suffix(&suffix).unwrap_or(label)
        } else {
            label
        };
        result.push(Model {
            id: id.into(),
            label: label.into(),
            description: String::new(),
            efforts: effort.map(|e| vec![e.into()]).unwrap_or_default(),
            default_effort: effort.unwrap_or_default().into(),
            is_default: false,
        });
    }
    for model in &mut result {
        model
            .efforts
            .sort_by_key(|e| EFFORTS.iter().position(|v| v == e).unwrap_or(99));
    }
    result
}
fn effort_label(value: &str) -> String {
    let mut c = value.chars();
    c.next()
        .map(|first| first.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}
fn resolve_defaults(models: &[Model], configured: RunOptions) -> RunOptions {
    let model_id = if configured.model.is_empty() {
        models
            .iter()
            .find(|m| m.is_default)
            .or_else(|| models.first())
            .map(|m| m.id.clone())
            .unwrap_or_default()
    } else {
        configured.model
    };
    let model = models.iter().find(|m| m.id == model_id);
    let reasoning = match model {
        Some(model) => [configured.reasoning.as_str(), model.default_effort.as_str()]
            .into_iter()
            .find(|effort| model.efforts.iter().any(|e| e == effort))
            .map(str::to_owned)
            .or_else(|| model.efforts.first().cloned())
            .unwrap_or_default(),
        None => configured.reasoning,
    };
    RunOptions {
        model: model_id,
        reasoning,
    }
}
fn parse_claude_models(value: &Value) -> Vec<Model> {
    value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .take(500)
        .filter_map(|entry| {
            let id = field(entry, "value");
            if id.is_empty()
                || (RunOptions {
                    model: id.clone(),
                    reasoning: String::new(),
                })
                .validate(Provider::Claude)
                .is_err()
            {
                return None;
            }
            let efforts: Vec<String> = entry["supportedEffortLevels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|v| ["low", "medium", "high", "xhigh", "max"].contains(v))
                .map(str::to_owned)
                .collect();
            let default_effort = if efforts.iter().any(|e| e == "medium") {
                "medium".into()
            } else {
                efforts.first().cloned().unwrap_or_default()
            };
            let label = field(entry, "displayName");
            Some(Model {
                label: if label.is_empty() { id.clone() } else { label },
                is_default: id == "default",
                id,
                description: field(entry, "description"),
                efforts,
                default_effort,
            })
        })
        .collect()
}
fn discover_claude() -> Result<Catalog, String> {
    let path = Provider::Claude
        .resolve()
        .ok_or_else(|| Provider::Claude.missing())?;
    if !crate::provider_auth::claude_is_authenticated(&path) {
        return Err("Sign in to Claude to load available models, then refresh.".into());
    }
    let mut cmd = command_path(&path);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
    ]);
    let mut process = Process(
        crate::child_process::Child::spawn(&mut cmd)
            .map_err(|_| "Could not load Claude models.")?,
    );
    let mut input = process
        .0
        .stdin
        .take()
        .ok_or("Claude model discovery input unavailable.")?;
    let out = process
        .0
        .stdout
        .take()
        .ok_or("Claude model discovery output unavailable.")?;
    writeln!(
        input,
        "{}",
        json!({"type":"control_request","request_id":"velum-models","request":{"subtype":"initialize"}})
    )
    .and_then(|_| input.flush())
    .map_err(|_| "Could not request Claude models.")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out.take(2 * 1024 * 1024))
            .lines()
            .take(500)
            .map_while(Result::ok)
        {
            if line.len() > 1024 * 1024 {
                break;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value["type"] == "control_response"
                    && value["response"]["request_id"] == "velum-models"
                {
                    let _ = tx.send(value);
                    break;
                }
            }
        }
    });
    let reply = rx
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Claude took too long to list models. Check your sign-in and refresh.")?;
    drop(input);
    if reply["response"]["subtype"] != "success" {
        return Err("Sign in to Claude to load available models, then refresh.".into());
    }
    let models = parse_claude_models(&reply["response"]["response"]);
    Ok(Catalog {
        defaults: resolve_defaults(&models, RunOptions::default()),
        notice: models
            .is_empty()
            .then(|| "The CLI returned no selectable models. Refresh or enter a model ID.".into()),
        models,
    })
}
fn discover(provider: Provider) -> Result<Catalog, String> {
    if provider == Provider::Claude {
        return discover_claude();
    }
    if provider == Provider::Antigravity {
        let mut cmd = command(provider)?;
        cmd.arg("models").stdin(Stdio::null());
        let mut process = Process(
            crate::child_process::Child::spawn(&mut cmd)
                .map_err(|_| "Could not load Antigravity models.")?,
        );
        let mut out = process
            .0
            .stdout
            .take()
            .ok_or("Model output unavailable.")?
            .take(1024 * 1024);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut data = String::new();
            let _ = out.read_to_string(&mut data);
            let _ = tx.send(data);
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        let output = rx.recv_timeout(Duration::from_secs(15)).map_err(|_| {
            "Antigravity took too long to list models. Check your connection and refresh."
        })?;
        let status = loop {
            if let Some(status) = process
                .0
                .try_wait()
                .map_err(|_| "Antigravity model discovery stopped.")?
            {
                break status;
            }
            if Instant::now() >= deadline {
                return Err(
                    "Antigravity took too long to list models. Refresh to try again.".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if !status.success() {
            return Err("Sign in to Antigravity to load available models, then refresh.".into());
        }
        let models = parse_agy_models(&output);
        return Ok(Catalog {
            defaults: resolve_defaults(&models, RunOptions::default()),
            notice: models.is_empty().then(|| {
                "The CLI returned no selectable models. Refresh or enter a model ID.".into()
            }),
            models,
        });
    }
    let mut rpc = Rpc::start(provider)?;
    let mut models = vec![];
    let mut cursor = Value::Null;
    for id in 1..=10 {
        let params = if provider == Provider::Muse {
            json!({})
        } else {
            json!({"limit":100,"includeHidden":false,"cursor":cursor})
        };
        let page = rpc.request(id, "model/list", params)?;
        models.extend(parse_rpc_models(provider, &page));
        cursor = page["nextCursor"].clone();
        if provider == Provider::Muse || cursor.is_null() {
            break;
        }
    }
    models.dedup_by(|a, b| a.id == b.id);
    let mut configured = RunOptions::default();
    if provider == Provider::Codex {
        // Read only the model preferences, never return the rest of the CLI config.
        rpc.deadline = rpc.deadline.min(Instant::now() + Duration::from_secs(2));
        if let Ok(value) = rpc.request(20, "config/read", json!({"includeLayers":false})) {
            let candidate = RunOptions {
                model: field(&value["config"], "model"),
                reasoning: field(&value["config"], "model_reasoning_effort"),
            };
            if candidate.validate(provider).is_ok() {
                configured = candidate;
            }
        }
    }
    Ok(Catalog {
        defaults: resolve_defaults(&models, configured),
        notice: models
            .is_empty()
            .then(|| "The CLI returned no model catalog. Refresh or enter a model ID.".into()),
        models,
    })
}
pub fn invalidate(provider: Provider) {
    CATALOGS.lock().unwrap().remove(&provider);
}
pub fn catalog(provider: Provider, refresh: bool) -> Catalog {
    if !refresh {
        if let Some((time, catalog)) = CATALOGS.lock().unwrap().get(&provider) {
            if time.elapsed() < Duration::from_secs(300) {
                return catalog.clone();
            }
        }
    }
    match discover(provider) {
        Ok(catalog) => {
            CATALOGS
                .lock()
                .unwrap()
                .insert(provider, (Instant::now(), catalog.clone()));
            catalog
        }
        Err(notice) => Catalog {
            models: vec![],
            notice: Some(notice),
            defaults: RunOptions::default(),
        },
    }
}
#[tauri::command]
pub async fn provider_models(provider: Provider, refresh: Option<bool>) -> Result<Catalog, String> {
    tauri::async_runtime::spawn_blocking(move || catalog(provider, refresh.unwrap_or(false)))
        .await
        .map_err(|_| "Could not load models.".into())
}

#[derive(Clone, Serialize)]
pub struct Warmup {
    pub installed: bool,
    pub version: Option<String>,
    pub catalog_models: usize,
    pub catalog_notice: Option<String>,
    pub elapsed_ms: u64,
}

/// First stdout line of `program args`, or `None` when the binary is missing,
/// exits nonzero, or outlives `timeout`. The caller owns the process tree and
/// polls stdout itself; every return reaps the child and closes its job.
fn cli_first_line(program: &std::path::Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = command_path(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::child_process::Child::spawn(&mut command).ok()?;
    let stdout = child.stdout.take()?;
    let mut output = crate::child_process::Output::new(stdout, None).ok()?;
    let deadline = Instant::now() + timeout;
    let mut first = None;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        let batch = output.poll().ok()?;
        if first.is_none() {
            first = batch
                .stdout
                .first()
                .map(|line| line.chars().take(200).collect::<String>());
        }
        if let Some(status) = child.try_wait().ok()? {
            if !status.success() {
                return None;
            }
            if first.is_some() || output.closed() {
                return first.filter(|line| !line.trim().is_empty());
            }
        }
        if !batch.activity {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Prove the CLI launches and prefill the model catalog cache at startup.
/// Advisory only: every turn still validates and every exec still pays the
/// provider's own connection cost (a persistent host is the follow-up).
pub fn warmup(provider: Provider) -> Warmup {
    let started = Instant::now();
    let path = provider.resolve();
    let version = path
        .as_deref()
        .and_then(|path| cli_first_line(path, &["--version"], Duration::from_secs(30)));
    let found = if version.is_some() {
        catalog(provider, false)
    } else {
        Catalog {
            notice: Some(
                "The CLI did not answer its version check. Check the Terminal view, then refresh."
                    .into(),
            ),
            ..Default::default()
        }
    };
    Warmup {
        installed: path.is_some(),
        version,
        catalog_models: found.models.len(),
        catalog_notice: found.notice,
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    }
}

#[tauri::command]
pub async fn provider_warmup(provider: Provider) -> Result<Warmup, String> {
    tauri::async_runtime::spawn_blocking(move || warmup(provider))
        .await
        .map_err(|_| "Could not warm up the provider.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn warmup_reports_install_state_without_failing() {
        let report = warmup(Provider::Muse);
        assert_eq!(report.installed, Provider::Muse.resolve().is_some());
        if !report.installed {
            assert!(report.version.is_none());
        }
        if let Some(version) = report.version {
            assert!(!version.trim().is_empty());
        }
    }
    /// Verify a real timeout and cleanup, including the shim's descendants.
    /// The fixture records only its own PIDs and actually sleeps past the
    /// deadline; shell utilities that exit when stdin is redirected cannot
    /// accidentally make this test pass.
    #[cfg(windows)]
    #[test]
    fn cli_first_line_returns_output_and_enforces_timeout() {
        let shell = std::path::Path::new("cmd");
        assert_eq!(
            cli_first_line(shell, &["/C", "echo hello"], Duration::from_secs(10)).as_deref(),
            Some("hello")
        );
        let fixture = crate::child_process::tests::Fixture::new(&format!(
            "{}\nStart-Sleep -Seconds 60",
            crate::child_process::tests::SPAWN_DESCENDANT
        ));
        let before = Instant::now();
        assert!(cli_first_line(
            &fixture.script,
            &[fixture.pids.to_str().unwrap()],
            crate::child_process::tests::STARTUP_TIMEOUT
        )
        .is_none());
        assert!(
            before.elapsed()
                < crate::child_process::tests::STARTUP_TIMEOUT + Duration::from_secs(5)
        );
        let pids = fixture.recorded_pids();
        assert_eq!(
            pids.len(),
            2,
            "both the probe and its descendant must have started"
        );
        crate::child_process::tests::assert_stopped(&pids);
        assert!(cli_first_line(
            std::path::Path::new("velum-missing-binary-xyz"),
            &[],
            Duration::from_secs(5)
        )
        .is_none());
    }
    #[test]
    fn catalogs_keep_model_specific_efforts_and_hide_hidden_models() {
        let result = parse_rpc_models(
            Provider::Codex,
            &json!({"data":[{"model":"one","displayName":"One","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]},{"model":"hidden","hidden":true}]}),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].efforts, vec!["low", "high"]);
        let muse = parse_rpc_models(
            Provider::Muse,
            &json!({"models":[{"modelId":"spark","variants":["high","max"]}]}),
        );
        assert_eq!(muse[0].efforts, vec!["high", "max"]);
        assert_eq!(muse[0].default_effort, "high");
    }
    #[test]
    fn real_defaults_honor_configured_models_and_supported_efforts() {
        let models = parse_rpc_models(
            Provider::Codex,
            &json!({"data":[
                {"model":"fast","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low"},
                {"model":"deep","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"high"},
                {"model":"basic","supportedReasoningEfforts":[]}
            ]}),
        );
        assert_eq!(
            resolve_defaults(&models, RunOptions::default()),
            RunOptions {
                model: "deep".into(),
                reasoning: "high".into()
            }
        );
        assert_eq!(
            resolve_defaults(
                &models,
                RunOptions {
                    model: "fast".into(),
                    reasoning: "max".into()
                }
            ),
            RunOptions {
                model: "fast".into(),
                reasoning: "low".into()
            }
        );
        assert_eq!(
            resolve_defaults(
                &models,
                RunOptions {
                    model: "deep".into(),
                    reasoning: "low".into()
                }
            )
            .reasoning,
            "low"
        );
        assert!(resolve_defaults(
            &models,
            RunOptions {
                model: "basic".into(),
                reasoning: "high".into()
            }
        )
        .reasoning
        .is_empty());
        let custom = RunOptions {
            model: "custom/model".into(),
            reasoning: "high".into(),
        };
        assert_eq!(resolve_defaults(&models, custom.clone()), custom);
        assert_eq!(
            resolve_defaults(&[], RunOptions::default()),
            RunOptions::default()
        );
    }
    #[test]
    fn antigravity_groups_only_returned_effort_variants() {
        let models=parse_agy_models("Fetching available models...\ngemini-test-high   Gemini Test (High)\ngemini-test-medium   Gemini Test (Medium)\nclaude-test   Claude Test (Thinking)\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].label, "Gemini Test");
        assert_eq!(models[0].efforts, vec!["medium", "high"]);
        assert!(models[1].efforts.is_empty());
    }
    #[test]
    fn options_are_data_and_use_each_cli_flag() {
        let options = RunOptions {
            model: "provider/model-1".into(),
            reasoning: "high".into(),
        };
        assert!(options.validate(Provider::Muse).is_ok());
        assert_eq!(
            options.args(Provider::Codex),
            vec![
                "--model",
                "provider/model-1",
                "-c",
                "model_reasoning_effort='high'"
            ]
        );
        assert!(options
            .args(Provider::Muse)
            .contains(&"--reasoning-effort".into()));
        assert!(options
            .args(Provider::Antigravity)
            .contains(&"--effort".into()));
        for model in ["--yolo", "x\n--yolo", "x\";whoami", "x & whoami"] {
            assert!(RunOptions {
                model: model.into(),
                reasoning: String::new()
            }
            .validate(Provider::Muse)
            .is_err());
        }
        assert!(RunOptions {
            model: String::new(),
            reasoning: "ultra".into()
        }
        .validate(Provider::Antigravity)
        .is_err());
        assert!(RunOptions::default().args(Provider::Codex).is_empty());
    }
    #[test]
    fn claude_models_and_effort_options_parse_cleanly() {
        let parsed = parse_claude_models(&json!({
            "models": [
                {"value": "default", "displayName": "Default (recommended)", "description": "Opus", "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]},
                {"value": "sonnet", "displayName": "Sonnet", "description": "Sonnet", "supportedEffortLevels": ["low", "medium", "high"]},
                {"value": "--bad", "displayName": "Bad"}
            ]
        }));
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].is_default);
        assert_eq!(parsed[0].default_effort, "medium");
        assert_eq!(
            parsed[0].efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        let opts = RunOptions {
            model: "sonnet".into(),
            reasoning: "xhigh".into(),
        };
        assert!(opts.validate(Provider::Claude).is_ok());
        assert_eq!(
            opts.args(Provider::Claude),
            vec!["--model", "sonnet", "--effort", "xhigh"]
        );
        assert!(RunOptions {
            model: String::new(),
            reasoning: "ultra".into()
        }
        .validate(Provider::Claude)
        .is_err());
    }
}
