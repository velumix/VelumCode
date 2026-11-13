//! Provider identities are fixed; shell commands never come from the web client.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Muse,
    Codex,
    Claude,
    Antigravity,
}

impl Provider {
    pub fn command(self) -> &'static str {
        match self {
            Self::Muse => "muse",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Antigravity => "agy",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Muse => "Muse",
            Self::Codex => "Codex",
            Self::Claude => "Claude",
            Self::Antigravity => "Antigravity",
        }
    }
    pub fn resolve(self) -> Option<PathBuf> {
        let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            paths.extend([
                local.join("Programs/muse"),
                local.join("Programs/OpenAI/Codex/bin"),
                local.join("Programs/claude"),
                local.join("agy/bin"),
            ]);
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join("npm"));
        }
        paths.push(crate::pty::home_dir().join(".local/bin"));
        let extensions = if cfg!(windows) {
            vec![".exe", ".cmd", ".bat", ".com", ".ps1", ""]
        } else {
            vec![""]
        };
        for dir in paths {
            for extension in &extensions {
                let path = dir.join(format!("{}{extension}", self.command()));
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    }
    pub fn missing(self) -> String {
        if self == Self::Antigravity {
            return "Antigravity CLI was not found. Install `agy`, refresh providers, then choose Sign in.".into();
        }
        if self == Self::Claude {
            return "Claude Code CLI was not found. Install `claude`, refresh providers, then choose Sign in.".into();
        }
        format!("{} CLI was not found. Install `{}` and sign in using the Terminal view, then try again.", self.label(), self.command())
    }
    pub fn input(self, prompt: &str) -> String {
        if self == Self::Antigravity {
            format!(
                "{}\n",
                serde_json::json!({"event":"user", "message":{"content":prompt}})
            )
        } else {
            prompt.into()
        }
    }
}

#[derive(Serialize)]
pub struct Info {
    id: Provider,
    name: &'static str,
    command: &'static str,
    installed: bool,
    setup_url: &'static str,
}
#[tauri::command]
pub fn provider_status() -> Vec<Info> {
    [
        Provider::Muse,
        Provider::Codex,
        Provider::Claude,
        Provider::Antigravity,
    ]
    .into_iter()
    .map(|id| Info {
        id,
        name: id.label(),
        command: id.command(),
        installed: id.resolve().is_some(),
        setup_url: match id {
            Provider::Muse => "https://github.com/velumix/VelumCode#providers",
            Provider::Codex => "https://developers.openai.com/codex/cli/",
            Provider::Claude => "https://code.claude.com/docs/en/overview",
            Provider::Antigravity => "https://antigravity.google/docs/getting-started?tab=cli",
        },
    })
    .collect()
}

pub fn exec_command(
    provider: Provider,
    path: &Path,
    session: &str,
    workspace: &Path,
    prompt: &Path,
    yolo: bool,
    options: &crate::provider_models::RunOptions,
) -> Result<Command, String> {
    options.validate(provider)?;
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
    match provider {
        Provider::Muse => {
            cmd.arg("serve");
            if !options.model.is_empty() {
                cmd.arg("--model").arg(&options.model);
            }
            if yolo {
                cmd.args(["--disable-sandbox", "--trust-workspace"]);
            }
            // Prompts, approval policy and decisions travel over the owned MSP
            // connection; closing stdin would end the host before a reply.
            cmd.stdin(Stdio::piped());
        }
        Provider::Codex => {
            cmd.args(["app-server", "--listen", "stdio://"]);
            cmd.arg("-c").arg(if yolo {
                "approval_policy=\"never\""
            } else {
                "approval_policy=\"on-request\""
            });
            cmd.args(["-c", "approvals_reviewer=\"user\""]);
            cmd.arg("-c").arg(if yolo {
                "sandbox_mode=\"danger-full-access\""
            } else {
                "sandbox_mode=\"workspace-write\""
            });
            cmd.arg("-c").arg(format!(
                "sandbox_workspace_write.writable_roots={}",
                serde_json::to_string(&[workspace.display().to_string()])
                    .map_err(|e| e.to_string())?
            ));
            cmd.stdin(Stdio::piped());
        }
        Provider::Claude => {
            // Claude Code's SDK host protocol: the turn arrives as a
            // stream-json message, and permission prompts and questions are
            // answered from Velum's chat over the same private connection.
            cmd.args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
            ]);
            cmd.args(options.args(provider));
            if !session.is_empty() {
                cmd.arg("--resume").arg(session);
            }
            if yolo {
                cmd.arg("--dangerously-skip-permissions");
            } else {
                cmd.args([
                    "--permission-mode",
                    "default",
                    "--permission-prompt-tool",
                    "stdio",
                ]);
            }
            cmd.stdin(Stdio::piped());
        }
        Provider::Antigravity => {
            cmd.args([
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
            ]);
            cmd.args(options.args(provider));
            if !session.is_empty() {
                cmd.arg("--conversation").arg(session);
            }
            if yolo {
                cmd.arg("--dangerously-skip-permissions");
            }
            cmd.stdin(std::fs::File::open(prompt).map_err(|e| e.to_string())?);
        }
    }
    cmd.current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The Windows sandbox account can differ from the desktop owner. Trust
    // just this selected repository in the child environment, never '*', ACLs
    // or the user's global Git config. Host git_status also applies it as -c.
    if let Some(root) = crate::workspace_tools::repository_root(workspace) {
        if let Some(count) = match std::env::var("GIT_CONFIG_COUNT") {
            Ok(count) => count.parse::<u32>().ok(),
            Err(std::env::VarError::NotPresent) => Some(0),
            Err(_) => None,
        }
        .filter(|n| *n < 100)
        {
            cmd.env("GIT_CONFIG_COUNT", (count + 1).to_string())
                .env(format!("GIT_CONFIG_KEY_{count}"), "safe.directory")
                .env(format!("GIT_CONFIG_VALUE_{count}"), root);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_fresh_and_resumed_turns_receive_only_the_selected_write_root() {
        let prompt = std::env::temp_dir().join(format!("velum-argv-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&prompt, "probe").unwrap();
        let workspace = Path::new(r"C:\projects\selected & quoted's project");
        for resume in ["", "62c2d305-9dd5-4c94-b4c0-667eb612f401"] {
            for yolo in [false, true] {
                let command = exec_command(
                    Provider::Codex,
                    Path::new("codex.exe"),
                    resume,
                    workspace,
                    &prompt,
                    yolo,
                    &Default::default(),
                )
                .unwrap();
                let args: Vec<_> = command
                    .get_args()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect();
                assert_eq!(command.get_current_dir(), Some(workspace));
                assert_eq!(args.first().map(String::as_str), Some("app-server"));
                let roots = args
                    .iter()
                    .find_map(|a| a.strip_prefix("sandbox_workspace_write.writable_roots="))
                    .unwrap();
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(roots).unwrap(),
                    [workspace.display().to_string()]
                );
                assert!(args.contains(
                    &if yolo {
                        "sandbox_mode=\"danger-full-access\""
                    } else {
                        "sandbox_mode=\"workspace-write\""
                    }
                    .into()
                ));
                assert_eq!(args.contains(&"approval_policy=\"never\"".into()), yolo);
                assert!(!args.contains(&"exec".into()) && !args.contains(&"resume".into()));
            }
        }
        std::fs::remove_file(prompt).unwrap();
    }
    #[test]
    fn claude_builds_stream_json_and_resume_flags() {
        let prompt =
            std::env::temp_dir().join(format!("velum-claude-argv-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&prompt, "probe").unwrap();
        let workspace = std::env::temp_dir();
        let opts = crate::provider_models::RunOptions {
            model: "sonnet".into(),
            reasoning: "high".into(),
        };
        let std_cmd = exec_command(
            Provider::Claude,
            Path::new("claude.exe"),
            "",
            &workspace,
            &prompt,
            false,
            &opts,
        )
        .unwrap();
        let std_args: Vec<_> = std_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(std_args.contains(&"--print".into()));
        assert!(std_args.contains(&"--input-format".into()));
        assert!(std_args.contains(&"stream-json".into()));
        // Standard mode asks Velum, never auto-denies or bypasses prompts.
        let tool = std_args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("permission prompts go to the host");
        assert_eq!(std_args[tool + 1], "stdio");
        assert!(!std_args.contains(&"--permission-prompts".into()));
        assert!(!std_args.contains(&"--dangerously-skip-permissions".into()));
        assert!(!std_args.contains(&"--resume".into()));

        let yolo_cmd = exec_command(
            Provider::Claude,
            Path::new("claude.exe"),
            "62c2d305-9dd5-4c94-b4c0-667eb612f401",
            &workspace,
            &prompt,
            true,
            &opts,
        )
        .unwrap();
        let yolo_args: Vec<_> = yolo_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(yolo_args.contains(&"--dangerously-skip-permissions".into()));
        assert!(!yolo_args.contains(&"--permission-prompt-tool".into()));
        assert!(yolo_args.contains(&"--resume".into()));
        assert!(yolo_args.contains(&"62c2d305-9dd5-4c94-b4c0-667eb612f401".into()));
        std::fs::remove_file(prompt).unwrap();
    }
}
