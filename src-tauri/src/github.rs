//! Live GitHub account and repository integration for Velum Code.
//! Provides authentication discovery (saved PAT, GitHub CLI keyring, environment),
//! user profile identity, repository details, issues and pull requests.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, State};

const MAX_CONFIG_BYTES: usize = 16384;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitHubCredentials {
    pub token: Option<String>,
    pub preferred_auth: Option<String>,
}

pub struct GitHubState {
    pub config_path: PathBuf,
    pub access: Mutex<()>,
}

impl GitHubState {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_path: config_dir.join("github.json"),
            access: Mutex::new(()),
        }
    }

    pub fn load_credentials(&self) -> GitHubCredentials {
        let _guard = match self.access.lock() {
            Ok(g) => g,
            Err(_) => return GitHubCredentials::default(),
        };
        if !self.config_path.exists() {
            return GitHubCredentials::default();
        }
        if let Ok(bytes) = fs::read(&self.config_path) {
            if bytes.len() <= MAX_CONFIG_BYTES {
                if let Ok(creds) = serde_json::from_slice::<GitHubCredentials>(&bytes) {
                    return creds;
                }
            }
        }
        GitHubCredentials::default()
    }

    pub fn save_credentials(&self, creds: &GitHubCredentials) -> Result<(), String> {
        let _guard = self.access.lock().map_err(|_| "Settings lock unavailable")?;
        crate::storage::write_json(&self.config_path, creds)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUserProfile {
    pub authenticated: bool,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub bio: Option<String>,
    pub company: Option<String>,
    pub location: Option<String>,
    pub blog: Option<String>,
    pub email: Option<String>,
    pub public_repos: u64,
    pub total_private_repos: Option<u64>,
    pub followers: u64,
    pub following: u64,
    pub html_url: String,
    pub auth_source: String, // "cli" | "pat" | "env" | "unauthenticated"
    pub scopes: Vec<String>,
    pub rate_limit_limit: Option<u64>,
    pub rate_limit_remaining: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepoDetails {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub stars: u64,
    pub forks: u64,
    pub open_issues_count: u64,
    pub default_branch: String,
    pub topics: Vec<String>,
    pub permissions: Value,
    pub visibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPullRequest {
    pub number: u64,
    pub title: String,
    pub user_login: String,
    pub user_avatar: String,
    pub state: String,
    pub draft: bool,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref: String,
    pub base_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssue {
    pub number: u64,
    pub title: String,
    pub user_login: String,
    pub user_avatar: String,
    pub state: String,
    pub labels: Vec<GitHubLabel>,
    pub comments: u64,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAuthStatus {
    pub has_pat: bool,
    pub has_cli: bool,
    pub cli_account: Option<String>,
    pub active_source: String,
}

pub fn parse_github_remote(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    if let Some(rest) = url.strip_prefix("https://github.com/") {
        return parse_github_repo_name(rest).ok();
    }
    if let Some(rest) = url.strip_prefix("http://github.com/") {
        return parse_github_repo_name(rest).ok();
    }
    if let Some(rest) = url.strip_prefix("git@github.com:") {
        return parse_github_repo_name(rest).ok();
    }
    if let Some(rest) = url.strip_prefix("ssh://git@github.com/") {
        return parse_github_repo_name(rest).ok();
    }
    None
}

pub fn parse_github_repo_name(input: &str) -> Result<String, String> {
    let input = input.trim().trim_end_matches('/');
    let input = input.strip_prefix("https://github.com/").unwrap_or(input);
    let input = input.strip_prefix("git@github.com:").unwrap_or(input);
    let input = input.strip_suffix(".git").unwrap_or(input);
    let parts: Vec<&str> = input.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("Expected repository format: owner/repo".into());
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

fn get_cli_token() -> Option<(String, Option<String>)> {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["auth", "token"]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if token.is_empty() {
        return None;
    }

    let mut user_cmd = std::process::Command::new("gh");
    user_cmd.args(["api", "user", "-q", ".login"]);
    user_cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        user_cmd.creation_flags(0x08000000);
    }
    let account = user_cmd.output().ok().and_then(|o| {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() { Some(s) } else { None }
        } else {
            None
        }
    });

    Some((token, account))
}

fn resolve_token(state: &GitHubState) -> (Option<String>, String) {
    let creds = state.load_credentials();
    if let Some(ref pat) = creds.token {
        let pat = pat.trim();
        if !pat.is_empty() {
            return (Some(pat.to_string()), "pat".into());
        }
    }

    if let Some((cli_token, _)) = get_cli_token() {
        return (Some(cli_token), "cli".into());
    }

    if let Ok(env_token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) {
        let env_token = env_token.trim().to_string();
        if !env_token.is_empty() {
            return (Some(env_token), "env".into());
        }
    }

    (None, "unauthenticated".into())
}

fn build_client(token: Option<&str>) -> Result<reqwest::blocking::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static("VelumCode-Desktop/1.0"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("x-github-api-version"),
        reqwest::header::HeaderValue::from_static("2022-11-28"),
    );
    if let Some(tok) = token {
        let tok = tok.trim();
        if !tok.is_empty() {
            let auth = format!("Bearer {tok}");
            let mut val = reqwest::header::HeaderValue::from_str(&auth).map_err(|e| e.to_string())?;
            val.set_sensitive(true);
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }
    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())
}

fn parse_json_response(resp: reqwest::blocking::Response) -> Result<Value, String> {
    let text = resp.text().map_err(|e| format!("Failed to read response body: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse JSON response: {e}"))
}

fn fetch_user(client: &reqwest::blocking::Client, source: &str) -> Result<GitHubUserProfile, String> {
    let resp = client
        .get("https://api.github.com/user")
        .send()
        .map_err(|e| format!("Failed to connect to GitHub API: {e}"))?;

    let status = resp.status();
    let scopes_header = resp
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let rate_limit = resp
        .headers()
        .get("x-ratelimit-limit")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let rate_remaining = resp
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub token is invalid or expired. Please re-authenticate or check your Personal Access Token.".into());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("GitHub API rate limit exceeded or access forbidden.".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub API returned HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Error")));
    }

    let val: Value = parse_json_response(resp)?;

    let scopes: Vec<String> = scopes_header
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(GitHubUserProfile {
        authenticated: true,
        login: val["login"].as_str().unwrap_or("").to_string(),
        name: val["name"].as_str().map(|s| s.to_string()),
        avatar_url: val["avatar_url"].as_str().unwrap_or("").to_string(),
        bio: val["bio"].as_str().map(|s| s.to_string()),
        company: val["company"].as_str().map(|s| s.to_string()),
        location: val["location"].as_str().map(|s| s.to_string()),
        blog: val["blog"].as_str().map(|s| s.to_string()),
        email: val["email"].as_str().map(|s| s.to_string()),
        public_repos: val["public_repos"].as_u64().unwrap_or(0),
        total_private_repos: val["total_private_repos"].as_u64(),
        followers: val["followers"].as_u64().unwrap_or(0),
        following: val["following"].as_u64().unwrap_or(0),
        html_url: val["html_url"].as_str().unwrap_or("").to_string(),
        auth_source: source.to_string(),
        scopes,
        rate_limit_limit: rate_limit,
        rate_limit_remaining: rate_remaining,
    })
}

fn resolve_repo_name(workspace: &str, repo_override: Option<&str>) -> Result<String, String> {
    if let Some(r) = repo_override {
        let trimmed = r.trim();
        if !trimmed.is_empty() {
            return parse_github_repo_name(trimmed);
        }
    }
    let root = std::path::Path::new(workspace);
    if let Ok(Some(remote_url)) = crate::workspace_tools::git_remote_url(root) {
        if let Some(parsed) = parse_github_remote(&remote_url) {
            return Ok(parsed);
        }
    }
    Err("No GitHub remote repository found for the current workspace. Ensure 'origin' points to github.com or select a repository.".into())
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()?);
    app.manage(GitHubState::new(config));
    Ok(())
}

#[tauri::command]
pub fn github_auth_status(state: State<'_, GitHubState>) -> Result<GitHubAuthStatus, String> {
    let creds = state.load_credentials();
    let has_pat = creds.token.as_ref().map_or(false, |t| !t.trim().is_empty());
    let cli = get_cli_token();
    let has_cli = cli.is_some();
    let cli_account = cli.and_then(|(_, acc)| acc);

    let active_source = if has_pat {
        "pat"
    } else if has_cli {
        "cli"
    } else if std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")).is_ok() {
        "env"
    } else {
        "unauthenticated"
    };

    Ok(GitHubAuthStatus {
        has_pat,
        has_cli,
        cli_account,
        active_source: active_source.to_string(),
    })
}

#[tauri::command]
pub fn github_save_pat(state: State<'_, GitHubState>, token: String) -> Result<GitHubUserProfile, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token cannot be empty.".into());
    }

    // Verify token by querying GitHub user profile
    let client = build_client(Some(&token))?;
    let profile = fetch_user(&client, "pat")?;

    // Save token if verified
    let mut creds = state.load_credentials();
    creds.token = Some(token);
    state.save_credentials(&creds)?;

    Ok(profile)
}

#[tauri::command]
pub fn github_clear_pat(state: State<'_, GitHubState>) -> Result<(), String> {
    let mut creds = state.load_credentials();
    creds.token = None;
    state.save_credentials(&creds)
}

#[tauri::command]
pub async fn github_user_profile(state: State<'_, GitHubState>) -> Result<GitHubUserProfile, String> {
    let (token, source) = resolve_token(&state);
    if token.is_none() {
        return Err("No GitHub credentials detected. Sign in with 'gh auth login' or enter a Personal Access Token in settings.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(token.as_deref())?;
        fetch_user(&client, &source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_repo_details(
    state: State<'_, GitHubState>,
    workspace: String,
    repo: Option<String>,
) -> Result<GitHubRepoDetails, String> {
    let repo_name = resolve_repo_name(&workspace, repo.as_deref())?;
    let (token, _) = resolve_token(&state);

    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(token.as_deref())?;
        let url = format!("https://api.github.com/repos/{repo_name}");
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("Failed to reach GitHub API: {e}"))?;

        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(format!("Repository '{repo_name}' not found on GitHub or access is restricted."));
        }
        if !status.is_success() {
            return Err(format!("GitHub API returned HTTP {status}"));
        }

        let val: Value = parse_json_response(resp)?;

        let topics = val["topics"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        Ok(GitHubRepoDetails {
            owner: val["owner"]["login"].as_str().unwrap_or("").to_string(),
            name: val["name"].as_str().unwrap_or("").to_string(),
            full_name: val["full_name"].as_str().unwrap_or(&repo_name).to_string(),
            description: val["description"].as_str().map(|s| s.to_string()),
            private: val["private"].as_bool().unwrap_or(false),
            fork: val["fork"].as_bool().unwrap_or(false),
            html_url: val["html_url"].as_str().unwrap_or("").to_string(),
            clone_url: val["clone_url"].as_str().unwrap_or("").to_string(),
            ssh_url: val["ssh_url"].as_str().unwrap_or("").to_string(),
            stars: val["stargazers_count"].as_u64().unwrap_or(0),
            forks: val["forks_count"].as_u64().unwrap_or(0),
            open_issues_count: val["open_issues_count"].as_u64().unwrap_or(0),
            default_branch: val["default_branch"].as_str().unwrap_or("main").to_string(),
            topics,
            permissions: val["permissions"].clone(),
            visibility: val["visibility"].as_str().unwrap_or("public").to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_repo_pulls(
    state: State<'_, GitHubState>,
    workspace: String,
    repo: Option<String>,
    state_filter: Option<String>,
) -> Result<Vec<GitHubPullRequest>, String> {
    let repo_name = resolve_repo_name(&workspace, repo.as_deref())?;
    let (token, _) = resolve_token(&state);
    let filter = state_filter.unwrap_or_else(|| "open".to_string());

    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(token.as_deref())?;
        let url = format!("https://api.github.com/repos/{repo_name}/pulls?state={filter}&per_page=20");
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("Failed to reach GitHub API: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("GitHub API returned HTTP {}", resp.status()));
        }

        let val: Value = parse_json_response(resp)?;
        let arr = val.as_array().ok_or("Expected JSON array from GitHub pulls")?;

        let pulls = arr
            .iter()
            .map(|item| GitHubPullRequest {
                number: item["number"].as_u64().unwrap_or(0),
                title: item["title"].as_str().unwrap_or("").to_string(),
                user_login: item["user"]["login"].as_str().unwrap_or("").to_string(),
                user_avatar: item["user"]["avatar_url"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("").to_string(),
                draft: item["draft"].as_bool().unwrap_or(false),
                html_url: item["html_url"].as_str().unwrap_or("").to_string(),
                created_at: item["created_at"].as_str().unwrap_or("").to_string(),
                updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
                head_ref: item["head"]["ref"].as_str().unwrap_or("").to_string(),
                base_ref: item["base"]["ref"].as_str().unwrap_or("").to_string(),
            })
            .collect();

        Ok(pulls)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_repo_issues(
    state: State<'_, GitHubState>,
    workspace: String,
    repo: Option<String>,
    state_filter: Option<String>,
) -> Result<Vec<GitHubIssue>, String> {
    let repo_name = resolve_repo_name(&workspace, repo.as_deref())?;
    let (token, _) = resolve_token(&state);
    let filter = state_filter.unwrap_or_else(|| "open".to_string());

    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(token.as_deref())?;
        let url = format!("https://api.github.com/repos/{repo_name}/issues?state={filter}&per_page=20");
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("Failed to reach GitHub API: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("GitHub API returned HTTP {}", resp.status()));
        }

        let val: Value = parse_json_response(resp)?;
        let arr = val.as_array().ok_or("Expected JSON array from GitHub issues")?;

        let issues = arr
            .iter()
            // GitHub issues endpoint includes pull requests unless filtered out
            .filter(|item| item.get("pull_request").is_none())
            .map(|item| {
                let labels = item["labels"]
                    .as_array()
                    .map(|l_arr| {
                        l_arr
                            .iter()
                            .map(|l| GitHubLabel {
                                name: l["name"].as_str().unwrap_or("").to_string(),
                                color: l["color"].as_str().unwrap_or("888888").to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                GitHubIssue {
                    number: item["number"].as_u64().unwrap_or(0),
                    title: item["title"].as_str().unwrap_or("").to_string(),
                    user_login: item["user"]["login"].as_str().unwrap_or("").to_string(),
                    user_avatar: item["user"]["avatar_url"].as_str().unwrap_or("").to_string(),
                    state: item["state"].as_str().unwrap_or("").to_string(),
                    labels,
                    comments: item["comments"].as_u64().unwrap_or(0),
                    html_url: item["html_url"].as_str().unwrap_or("").to_string(),
                    created_at: item["created_at"].as_str().unwrap_or("").to_string(),
                    updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
                }
            })
            .collect();

        Ok(issues)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_create_issue(
    state: State<'_, GitHubState>,
    workspace: String,
    repo: Option<String>,
    title: String,
    body: String,
) -> Result<GitHubIssue, String> {
    let repo_name = resolve_repo_name(&workspace, repo.as_deref())?;
    let (token, _) = resolve_token(&state);
    if token.is_none() {
        return Err("Authentication required to create GitHub issues.".into());
    }
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Issue title cannot be empty.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(token.as_deref())?;
        let url = format!("https://api.github.com/repos/{repo_name}/issues");
        let payload = json!({
            "title": title,
            "body": body,
        });
        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let resp = client
            .post(&url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body_bytes)
            .send()
            .map_err(|e| format!("Failed to create GitHub issue: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("GitHub API returned HTTP {}", resp.status()));
        }

        let item: Value = parse_json_response(resp)?;
        let labels = item["labels"]
            .as_array()
            .map(|l_arr| {
                l_arr
                    .iter()
                    .map(|l| GitHubLabel {
                        name: l["name"].as_str().unwrap_or("").to_string(),
                        color: l["color"].as_str().unwrap_or("888888").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(GitHubIssue {
            number: item["number"].as_u64().unwrap_or(0),
            title: item["title"].as_str().unwrap_or("").to_string(),
            user_login: item["user"]["login"].as_str().unwrap_or("").to_string(),
            user_avatar: item["user"]["avatar_url"].as_str().unwrap_or("").to_string(),
            state: item["state"].as_str().unwrap_or("open").to_string(),
            labels,
            comments: item["comments"].as_u64().unwrap_or(0),
            html_url: item["html_url"].as_str().unwrap_or("").to_string(),
            created_at: item["created_at"].as_str().unwrap_or("").to_string(),
            updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
