//! GitHub-only skill downloads. No git checkout, archive extraction or
//! build scripts; a skill is `SKILL.md` plus optional `velum-skill.json`.
use crate::plugin_github::{repository, valid_origin, Origin};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};

fn get_token() -> Option<String> {
    if let Ok(env_tok) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) {
        let trimmed = env_tok.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
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
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            if let Ok(s) = String::from_utf8(output.stdout) {
                let trimmed = s.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

fn client() -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent("VelumCode-Skills/1")
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());

    if let Some(token) = get_token() {
        if let Ok(mut val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            val.set_sensitive(true);
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(reqwest::header::AUTHORIZATION, val);
            builder = builder.default_headers(headers);
        }
    }

    builder.build().map_err(|e| e.to_string())
}

/// `Ok(None)` only when `optional` and GitHub answered 404, so a repository
/// without `velum-skill.json` still installs from its SKILL.md frontmatter.
fn download_url(
    client: &Client,
    url: &str,
    accept: &str,
    limit: usize,
    optional: bool,
) -> Result<Option<String>, String> {
    let response = client
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| "Cannot reach GitHub. Check your connection and try again.".to_string())?;
    match response.status().as_u16() {
        200 => {}
        404 if optional => return Ok(None),
        403 | 429 => {
            return Err("GitHub is limiting requests or denying access. Try again later. Installed skills still work offline.".into())
        }
        404 => {
            return Err("Repository or skill files not found. Use a public repository with SKILL.md at its root or in skills/.".into())
        }
        301 | 302 | 307 | 308 => return Err("This repository moved. Use its current GitHub URL.".into()),
        code => return Err(format!("GitHub returned HTTP {code}. Try again later.")),
    }
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err("GitHub file exceeds the skill size limit.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not finish downloading the skill.".to_string())?;
    if bytes.len() > limit {
        return Err("GitHub file exceeds the skill size limit.".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Skill files must be UTF-8 text.".into())
}

fn download(
    client: &Client,
    path: &str,
    accept: &str,
    limit: usize,
    optional: bool,
) -> Result<Option<String>, String> {
    download_url(
        client,
        &format!("https://api.github.com/repos/{path}"),
        accept,
        limit,
        optional,
    )
}

pub fn directory() -> Result<String, String> {
    download_url(
        &client()?,
        "https://raw.githubusercontent.com/velumix/velum-code-skills/main/catalog.json",
        "application/json",
        1024 * 1024,
        false,
    )?
    .ok_or_else(|| "The skill directory is unavailable.".to_string())
}

/// Returns the pinned origin, the optional `velum-skill.json` text, and the
/// full `SKILL.md` text at one immutable commit.
pub fn package(
    input: &str,
    pinned: Option<&str>,
) -> Result<(Origin, Option<String>, String), String> {
    let clean = input
        .trim()
        .trim_end_matches('/')
        .replace("https://github.com/", "")
        .replace("http://github.com/", "")
        .replace("github.com/", "");
    let clean = clean.split("/tree/").next().unwrap_or(&clean);
    let clean = clean.split("/blob/").next().unwrap_or(clean);
    let repository = repository(clean)?;
    if pinned.is_some_and(|sha| sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("Invalid listed skill commit. Refresh the directory.".into());
    }
    let client = client()?;
    // HEAD resolves the default branch to one immutable commit before any file is read.
    let commit = if let Some(commit) = pinned {
        commit.to_lowercase()
    } else {
        download(
            &client,
            &format!("{repository}/commits/HEAD"),
            "application/vnd.github.sha",
            256,
            false,
        )?
        .ok_or("GitHub did not return a valid commit.")?
        .trim()
        .to_string()
    };
    let origin = Origin { repository, commit };
    if !valid_origin(&origin) {
        return Err("GitHub did not return a valid commit.".into());
    }

    // 1. Try SKILL.md at root
    let root_skill = download(
        &client,
        &format!(
            "{}/contents/SKILL.md?ref={}",
            origin.repository, origin.commit
        ),
        "application/vnd.github.raw+json",
        crate::skills::MAX_SKILL_FILE,
        true,
    )?;

    let (skill_md, manifest) = if let Some(skill_md) = root_skill {
        let manifest = download(
            &client,
            &format!(
                "{}/contents/velum-skill.json?ref={}",
                origin.repository, origin.commit
            ),
            "application/vnd.github.raw+json",
            32 * 1024,
            true,
        )?;
        (skill_md, manifest)
    } else {
        // 2. Try common subpaths: skills/{repo_name}/SKILL.md, skills/SKILL.md, or first subdir in skills/
        let repo_short_name = origin.repository.split('/').nth(1).unwrap_or("");
        let repo_clean_name = repo_short_name.strip_suffix("-skill").unwrap_or(repo_short_name);

        let candidate_paths = [
            format!("skills/{repo_short_name}/SKILL.md"),
            format!("skills/{repo_clean_name}/SKILL.md"),
            "skills/SKILL.md".to_string(),
        ];

        let mut found = None;
        for path in &candidate_paths {
            if let Ok(Some(content)) = download(
                &client,
                &format!("{}/contents/{}?ref={}", origin.repository, path, origin.commit),
                "application/vnd.github.raw+json",
                crate::skills::MAX_SKILL_FILE,
                true,
            ) {
                let dir = path.strip_suffix("/SKILL.md").unwrap_or("skills");
                let manifest = download(
                    &client,
                    &format!("{}/contents/{}/velum-skill.json?ref={}", origin.repository, dir, origin.commit),
                    "application/vnd.github.raw+json",
                    32 * 1024,
                    true,
                ).unwrap_or(None);
                found = Some((content, manifest));
                break;
            }
        }

        if found.is_none() {
            if let Ok(Some(skills_dir_json)) = download(
                &client,
                &format!("{}/contents/skills?ref={}", origin.repository, origin.commit),
                "application/vnd.github+json",
                128 * 1024,
                true,
            ) {
                #[derive(Deserialize)]
                struct DirEntry {
                    name: String,
                    #[serde(rename = "type")]
                    entry_type: String,
                }
                if let Ok(entries) = serde_json::from_str::<Vec<DirEntry>>(&skills_dir_json) {
                    for entry in entries {
                        if entry.entry_type == "dir" {
                            let path = format!("skills/{}/SKILL.md", entry.name);
                            if let Ok(Some(content)) = download(
                                &client,
                                &format!("{}/contents/{}?ref={}", origin.repository, path, origin.commit),
                                "application/vnd.github.raw+json",
                                crate::skills::MAX_SKILL_FILE,
                                true,
                            ) {
                                let manifest = download(
                                    &client,
                                    &format!("{}/contents/skills/{}/velum-skill.json?ref={}", origin.repository, entry.name, origin.commit),
                                    "application/vnd.github.raw+json",
                                    32 * 1024,
                                    true,
                                ).unwrap_or(None);
                                found = Some((content, manifest));
                                break;
                            }
                        }
                    }
                }
            }
        }

        found.ok_or_else(|| {
            "Repository does not contain SKILL.md at root or in skills/ directory. Use a public repository with a valid SKILL.md file.".to_string()
        })?
    };

    Ok((origin, manifest, skill_md))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoResult {
    pub repository: String,
    pub description: String,
    pub stars: u64,
    pub topics: Vec<String>,
}

pub fn search(query: &str) -> Result<Vec<GitHubRepoResult>, String> {
    let raw = query.trim();
    if raw.len() > 100 || raw.chars().any(char::is_control) {
        return Err("Search query is too long or contains invalid characters.".into());
    }

    let client = client()?;

    // If query looks like a specific repo "owner/name", try fetching that repo directly
    if raw.contains('/') && !raw.contains(' ') {
        let clean = raw
            .replace("https://github.com/", "")
            .replace("http://github.com/", "")
            .replace("github.com/", "");
        let clean = clean.split("/tree/").next().unwrap_or(&clean);
        let clean = clean.split("/blob/").next().unwrap_or(clean);
        if let Ok(repo_name) = repository(clean) {
            let res = client
                .get(format!("https://api.github.com/repos/{repo_name}"))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send();
            if let Ok(response) = res {
                if response.status().is_success() {
                    #[derive(Deserialize)]
                    struct SingleRepo {
                        full_name: String,
                        description: Option<String>,
                        stargazers_count: Option<u64>,
                        #[serde(default)]
                        topics: Vec<String>,
                    }
                    let mut b = Vec::new();
                    if response.take(128 * 1024).read_to_end(&mut b).is_ok() {
                        if let Ok(repo) = serde_json::from_slice::<SingleRepo>(&b) {
                            return Ok(vec![GitHubRepoResult {
                                repository: repo.full_name,
                                description: repo.description.unwrap_or_default(),
                                stars: repo.stargazers_count.unwrap_or(0),
                                topics: repo.topics,
                            }]);
                        }
                    }
                }
            }
        }
    }

    let gh_query = if raw.is_empty() || raw.eq_ignore_ascii_case("all") || raw.eq_ignore_ascii_case("popular") {
        "agent skill sort:stars".to_string()
    } else if raw.contains("skill") || raw.starts_with("topic:") {
        raw.to_string()
    } else {
        format!("{raw} skill")
    };

    let response = client
        .get("https://api.github.com/search/repositories")
        .query(&[("q", gh_query.as_str()), ("per_page", "24"), ("sort", "stars")])
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| "Cannot reach GitHub search. Check your connection.".to_string())?;

    match response.status().as_u16() {
        200 => {}
        403 | 429 => {
            return Err(
                "GitHub search rate limit reached. Please wait a minute and try again.".into(),
            );
        }
        code => {
            return Err(format!(
                "GitHub search returned HTTP {code}. Try again later."
            ))
        }
    }

    let mut bytes = Vec::new();
    response
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not finish reading search results.".to_string())?;

    #[derive(Deserialize)]
    struct RawSearch {
        items: Option<Vec<RawItem>>,
    }
    #[derive(Deserialize)]
    struct RawItem {
        full_name: String,
        description: Option<String>,
        stargazers_count: Option<u64>,
        #[serde(default)]
        topics: Vec<String>,
    }

    let parsed: RawSearch = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read GitHub search response: {e}"))?;

    let items = parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            if crate::plugin_github::repository(&item.full_name).is_err() {
                return None;
            }
            Some(GitHubRepoResult {
                repository: item.full_name,
                description: item.description.unwrap_or_default(),
                stars: item.stargazers_count.unwrap_or(0),
                topics: item.topics,
            })
        })
        .collect();

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires public GitHub access; run explicitly for release verification"]
    fn live_github_skill_download() {
        let (origin, _, skill_md) = package("velumix/velum-skill-review-checklist", None).unwrap();
        assert!(valid_origin(&origin));
        assert!(skill_md.contains("Review checklist"));
        println!("Downloaded SKILL.md at commit {}", origin.commit);
    }

    #[test]
    #[ignore = "Requires public GitHub access; run explicitly for release verification"]
    fn live_github_subfolder_skill_download() {
        let (origin, _, skill_md) = package("Nutlope/hallmark", None).unwrap();
        assert!(valid_origin(&origin));
        assert!(!skill_md.is_empty());
        println!("Downloaded subfolder SKILL.md at commit {}", origin.commit);
    }

    #[test]
    fn live_github_search() {
        let results = search("velum-skill-review-checklist").unwrap();
        assert!(!results.is_empty());
        assert!(results
            .iter()
            .any(|r| r.repository == "velumix/velum-skill-review-checklist"));
    }
}
