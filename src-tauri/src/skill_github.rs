//! GitHub-only skill downloads. No git checkout, archive extraction or
//! build scripts; a skill is `SKILL.md` plus optional `velum-skill.json`.
use crate::plugin_github::{repository, valid_origin, Origin};
use reqwest::blocking::Client;
use std::{io::Read, time::Duration};

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("VelumCode-Skills/1")
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
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
            return Err("Repository or skill files not found. Use a public repository with SKILL.md at its root.".into())
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
    let repository = repository(input)?;
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
    let skill_md = download(
        &client,
        &format!(
            "{}/contents/SKILL.md?ref={}",
            origin.repository, origin.commit
        ),
        "application/vnd.github.raw+json",
        crate::skills::MAX_SKILL_FILE,
        false,
    )?
    .ok_or(
        "Repository or skill files not found. Use a public repository with SKILL.md at its root.",
    )?;
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
    Ok((origin, manifest, skill_md))
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
}
