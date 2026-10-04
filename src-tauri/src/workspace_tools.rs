//! Host tools are confined to the selected project. Search is resumable and
//! reports every omission. Deletion requires a fresh content hash and is never
//! recursive. No tool can alter Git metadata.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
};

pub const GENERATED: &[&str] = &[
    "node_modules",
    ".preview",
    "target",
    "dist",
    "dist-ssr",
    ".qa",
    "build",
    ".gradle",
    "vendor",
    "coverage",
    "playwright-report",
    "test-results",
];
const MAX_HASH: u64 = 256 * 1024 * 1024;
const MAX_SEARCH_FILE: u64 = 2 * 1024 * 1024;

pub fn linked(meta: &fs::Metadata) -> bool {
    // On Windows Rust uses the reparse tag's name-surrogate bit, so this
    // includes junctions and symbolic links, without mistaking OneDrive Cloud
    // Files for path redirects. Canonical containment is checked separately.
    meta.file_type().is_symlink()
}

pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(
            "Use a relative path inside the selected project; parent traversal is unavailable."
                .into(),
        );
    }
    let mut joined = root.to_path_buf();
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name_text = name.to_string_lossy();
            if name_text.eq_ignore_ascii_case(".git")
                || name_text.contains(':')
                || name_text.ends_with(['.', ' '])
            {
                return Err(
                    "Git metadata, alternate streams and ambiguous Windows paths are unavailable."
                        .into(),
                );
            }
            joined.push(name);
            let metadata = fs::symlink_metadata(&joined)
                .map_err(|_| "Path is missing or unreadable.".to_string())?;
            if linked(&metadata) {
                return Err(
                    "Links and redirecting reparse points below the project root are unavailable."
                        .into(),
                );
            }
        }
    }
    let actual = fs::canonicalize(&joined).map_err(|_| "Path is unreadable.".to_string())?;
    if !actual.starts_with(root) {
        return Err("Path leaves the selected project.".into());
    }
    Ok(actual)
}

fn digest(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|_| "Cannot read this file.".to_string())?;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect this file.".to_string())?;
    if !meta.is_file() || meta.len() > MAX_HASH {
        return Err("Expected a regular file no larger than 256 MiB.".into());
    }
    let mut hasher = Sha256::new();
    let mut file = file.take(MAX_HASH + 1);
    let mut total = 0u64;
    let mut bytes = [0u8; 65536];
    loop {
        let size = file
            .read(&mut bytes)
            .map_err(|_| "Cannot hash this file.".to_string())?;
        if size == 0 {
            break;
        }
        total += size as u64;
        if total > MAX_HASH {
            return Err("File grew beyond the hash limit; inspect it again.".into());
        }
        hasher.update(&bytes[..size]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn inspect(root: &Path, relative: &str) -> Result<Value, String> {
    let path = resolve(root, relative)?;
    let hash = digest(&path)?;
    Ok(
        json!({"path":relative,"bytes":fs::metadata(path).map_err(|_|"Cannot inspect this file.")?.len(),"sha256":hash}),
    )
}

pub fn delete(root: &Path, relative: &str, expected: &str) -> Result<Value, String> {
    if expected.len() != 64 || !expected.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "Invalid expected_sha256: supply all 64 hexadecimal characters from inspect_file.sha256 unchanged; received {} characters. A hash prefix cannot authorize removal. No file was deleted.",
            expected.chars().count()
        ));
    }
    let path = resolve(root, relative)?;
    if digest(&path)? != expected.to_ascii_lowercase() {
        return Err("The file changed. Inspect it again before deleting.".into());
    }
    // Recheck the path immediately before removal. This is a regular-file
    // operation; remove_file never recursively follows a directory.
    if resolve(root, relative)? != path {
        return Err("The path changed. Inspect it again.".into());
    }
    fs::remove_file(path).map_err(|_| {
        "File removal failed; Windows or another process may hold it open.".to_string()
    })?;
    Ok(json!({"path":relative,"deleted":true,"sha256":expected,"recursive":false}))
}

pub fn repository_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.join(".git").is_dir() || p.join(".git").is_file())
        .map(Path::to_path_buf)
}

fn run_git(
    operation: &str,
    repository: &Path,
    args: &[&str],
    paths: &[PathBuf],
    cap: usize,
) -> Result<(String, bool), String> {
    // Read-only Git inspection. safe.directory applies to this repository for
    // this command only; global configuration, ownership, commits and files
    // are never changed.
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-c")
        .arg(format!("safe.directory={}", repository.display()))
        .args(["-c", "core.fsmonitor=false"])
        .arg("--no-optional-locks")
        .args(args);
    if !paths.is_empty() {
        cmd.arg("--");
        for path in paths {
            cmd.arg(path);
        }
    }
    cmd.current_dir(repository)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| "Git is unavailable on the host PATH.".to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || read_bounded(stdout, cap));
    let err = std::thread::spawn(move || read_bounded(stderr, 0));
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            _ => {}
        }
        if started.elapsed() > std::time::Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    let output = out
        .join()
        .map_err(|_| format!("Cannot collect Git {operation}."))??;
    let _ = err.join();
    let status = status.ok_or(format!(
        "Git {operation} timed out or could not be monitored; no Git configuration was changed."
    ))?;
    if !status.success() {
        return Err(format!(
            "Git {operation} failed (exit {:?}); no Git configuration was changed.",
            status.code()
        ));
    }
    let text = String::from_utf8_lossy(&output.0);
    let mut end = text.len().min(cap);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((text[..end].to_string(), output.1 || end < text.len()))
}

pub fn git_status(root: &Path) -> Result<Value, String> {
    let repository = repository_root(root).ok_or("No Git repository detected.")?;
    let (status, truncated) = run_git(
        "status",
        &repository,
        &["status", "--short", "--branch", "--untracked-files=normal"],
        &[root.to_path_buf()],
        24000,
    )?;
    Ok(
        json!({"status":status,"truncated":truncated,"trust":"Selected repository only, for this command.","global_config_changed":false}),
    )
}

pub fn git_branches(root: &Path) -> Result<Value, String> {
    let repository = repository_root(root).ok_or("No Git repository detected.")?;
    let (current, _) = run_git(
        "branch",
        &repository,
        &["branch", "--show-current"],
        &[],
        4096,
    )?;
    let (locals, truncated) = run_git(
        "branch",
        &repository,
        &[
            "branch",
            "--format=%(refname:short)|%(upstream:short)|%(objectname:short)",
        ],
        &[],
        24000,
    )?;
    let branches: Vec<Value> = locals
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '|');
            let name = parts.next().unwrap_or("");
            if name.is_empty() {
                return None;
            }
            Some(json!({
                "name": name,
                "upstream": parts.next().unwrap_or(""),
                "head": parts.next().unwrap_or(""),
            }))
        })
        .collect();
    Ok(json!({
        "root": repository.display().to_string(),
        "current": current.trim(),
        "branches": branches,
        "truncated": truncated,
        "trust": "Selected repository only, for this command.",
        "global_config_changed": false,
    }))
}

fn check_revision(base: &str) -> Result<&str, String> {
    if base.is_empty() {
        return Ok("HEAD");
    }
    let safe = !base.starts_with('-')
        && base
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
    if !safe {
        return Err("Unknown or unsafe Git revision.".into());
    }
    Ok(base)
}

fn check_diff_path(relative: &str) -> Result<PathBuf, String> {
    // Syntactic checks only: deleted files no longer exist, so resolve()
    // (which requires filesystem access) cannot validate them. The path is
    // passed to Git after `--`, so it is never interpreted as an option.
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(
            "Use a relative path inside the selected project; parent traversal is unavailable."
                .into(),
        );
    }
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name_text = name.to_string_lossy();
            if name_text.eq_ignore_ascii_case(".git")
                || name_text.contains(':')
                || name_text.ends_with(['.', ' '])
            {
                return Err(
                    "Git metadata, alternate streams and ambiguous Windows paths are unavailable."
                        .into(),
                );
            }
        }
    }
    Ok(path.to_path_buf())
}

pub fn git_diff(root: &Path, base: &str, relative: Option<&str>) -> Result<Value, String> {
    let repository = repository_root(root).ok_or("No Git repository detected.")?;
    let base = check_revision(base)?;
    let mut paths = vec![root.to_path_buf()];
    if let Some(relative) = relative {
        if !relative.is_empty() {
            paths.push(check_diff_path(relative)?);
        }
    }
    // Without a file path this returns `--stat` for the overview; with one it
    // returns the unified diff of that file. `path` is repository-relative.
    let (text, truncated) = if relative.is_some_and(|r| !r.is_empty()) {
        run_git(
            "diff",
            &repository,
            &["diff", "--no-color", "--no-ext-diff", "-U3", base],
            &paths,
            24000,
        )?
    } else {
        run_git(
            "diff",
            &repository,
            &["diff", "--no-color", "--stat=200,200", base],
            &paths,
            24000,
        )?
    };
    Ok(json!({
        "base": base,
        "path": relative.unwrap_or(""),
        "diff": text,
        "truncated": truncated,
        "trust": "Selected repository only, for this command.",
        "global_config_changed": false,
    }))
}

pub fn git_log(root: &Path, limit: usize) -> Result<Value, String> {
    // Recent commits for the Git panel and the git_log agent tool.
    // Read-only; same per-command safe.directory confinement as git_diff.
    let repository = repository_root(root).ok_or("No Git repository detected.")?;
    let limit = limit.clamp(1, 50);
    let limit_arg = format!("-n{limit}");
    let (text, truncated) = run_git(
        "log",
        &repository,
        &[
            "log",
            "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
            "--date=short",
            &limit_arg,
        ],
        &[],
        24000,
    )?;
    let commits: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(5, '\x1f');
            let hash = parts.next().unwrap_or("");
            let short = parts.next().unwrap_or("");
            let author = parts.next().unwrap_or("");
            let date = parts.next().unwrap_or("");
            let subject = parts.next().unwrap_or("");
            if hash.is_empty() || short.is_empty() {
                return None;
            }
            Some(json!({
                "hash": hash,
                "short": short,
                "author": author.chars().take(120).collect::<String>(),
                "date": date,
                "subject": subject.chars().take(240).collect::<String>(),
            }))
        })
        .collect();
    Ok(json!({
        "commits": commits,
        "truncated": truncated,
        "trust": "Selected repository only, for this command.",
        "global_config_changed": false,
    }))
}

pub fn git_sync(root: &Path) -> Result<Value, String> {
    // Ahead/behind of HEAD against its upstream. Missing upstream or a
    // detached HEAD is a settled zero, never an error, so the Git panel can
    // keep showing branches and status.
    let repository = repository_root(root).ok_or("No Git repository detected.")?;
    let (upstream, _) = run_git(
        "upstream",
        &repository,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        &[],
        1024,
    )
    .unwrap_or_default();
    let upstream = upstream.trim().to_string();
    if upstream.is_empty() {
        return Ok(json!({"upstream": "", "ahead": 0, "behind": 0}));
    }
    let range = format!("HEAD...{upstream}");
    let (counts, _) = run_git(
        "sync",
        &repository,
        &["rev-list", "--left-right", "--count", &range],
        &[],
        1024,
    )
    .unwrap_or_default();
    let mut numbers = counts
        .split_whitespace()
        .filter_map(|n| n.parse::<u64>().ok());
    Ok(json!({
        "upstream": upstream,
        "ahead": numbers.next().unwrap_or(0),
        "behind": numbers.next().unwrap_or(0),
    }))
}

// Drain both pipes even after the retained output is full, so a large tree
// cannot fill a pipe and deadlock Git. Never retain stderr/config contents.
fn read_bounded(mut reader: impl Read, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::with_capacity(cap);
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|_| "Cannot read Git output.")?;
        if count == 0 {
            break;
        }
        let keep = count.min(cap.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..keep]);
        truncated |= keep < count;
    }
    Ok((bytes, truncated))
}

/// A cursor retains directory iterators and an open file position, not a giant
/// list of results. Every page bounds work and output independently.
pub struct Search {
    root: PathBuf,
    query: String,
    needle: String,
    files_only: bool,
    case_sensitive: bool,
    generated: bool,
    directories: Vec<fs::ReadDir>,
    pending: VecDeque<PathBuf>,
    reader: Option<(PathBuf, BufReader<std::io::Take<fs::File>>, usize)>,
    pub skipped: usize,
    pub scanned: usize,
}
impl Search {
    pub fn new(
        root: &Path,
        path: &str,
        query: &str,
        mode: &str,
        case_sensitive: bool,
        generated: bool,
    ) -> Result<Self, String> {
        if query.len() > 500 {
            return Err("Search query exceeds 500 bytes.".into());
        }
        if mode != "text" && mode != "files" {
            return Err("Search mode must be text or files.".into());
        }
        if mode == "text" && query.is_empty() {
            return Err("Text search needs a nonempty literal query.".into());
        }
        if generated && (path.is_empty() || path == ".") {
            return Err(
                "To search generated files, choose a specific subdirectory or file.".into(),
            );
        }
        let start = resolve(root, path)?;
        let mut directories = vec![];
        let mut pending = VecDeque::new();
        if start.is_dir() {
            directories
                .push(fs::read_dir(start).map_err(|_| "Cannot list this directory.".to_string())?);
        } else {
            pending.push_back(start);
        }
        Ok(Self {
            root: root.into(),
            query: query.into(),
            needle: if case_sensitive {
                query.into()
            } else {
                query.to_lowercase()
            },
            files_only: mode == "files",
            case_sensitive,
            generated,
            directories,
            pending,
            reader: None,
            skipped: 0,
            scanned: 0,
        })
    }
    pub fn matches_request(&self, query: &str) -> bool {
        self.query == query
    }
    fn contains(&self, value: &str) -> bool {
        if self.case_sensitive {
            value.contains(&self.needle)
        } else {
            value.to_lowercase().contains(&self.needle)
        }
    }
    fn next_file(&mut self, work: &mut usize) -> Option<PathBuf> {
        while *work < 1500 {
            if let Some(path) = self.pending.pop_front() {
                return Some(path);
            }
            let entry = self.directories.last_mut()?.next();
            *work += 1;
            let Some(entry) = entry else {
                self.directories.pop();
                continue;
            };
            let Ok(entry) = entry else {
                self.skipped += 1;
                continue;
            };
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                self.skipped += 1;
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name == ".git"
                || linked(&meta)
                || (!self.generated && meta.is_dir() && GENERATED.contains(&name.as_str()))
            {
                self.skipped += 1;
                continue;
            }
            if meta.is_dir() {
                match fs::read_dir(path) {
                    Ok(dir) => self.directories.push(dir),
                    Err(_) => self.skipped += 1,
                }
            } else if meta.is_file() {
                return Some(path);
            }
        }
        None
    }
    pub fn page(&mut self, limit: usize) -> Value {
        let mut matches = vec![];
        let mut work = 0;
        let mut bytes = 0;
        while matches.len() < limit.clamp(1, 50) && work < 1500 && bytes < 18000 {
            if self.reader.is_none() {
                let Some(file) = self.next_file(&mut work) else {
                    break;
                };
                let relative = file
                    .strip_prefix(&self.root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let Ok(file) = resolve(&self.root, &relative) else {
                    self.skipped += 1;
                    continue;
                };
                self.scanned += 1;
                let relative = file
                    .strip_prefix(&self.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if self.files_only {
                    if self.contains(&relative) {
                        bytes += relative.len();
                        matches.push(json!({"path":relative}));
                    }
                    continue;
                }
                if fs::metadata(&file)
                    .map(|m| m.len() > MAX_SEARCH_FILE)
                    .unwrap_or(true)
                {
                    self.skipped += 1;
                    continue;
                }
                match fs::File::open(&file) {
                    Ok(open) => {
                        self.reader = Some((file, BufReader::new(open.take(MAX_SEARCH_FILE)), 0))
                    }
                    Err(_) => {
                        self.skipped += 1;
                        continue;
                    }
                }
            }
            work += 1;
            let (path, reader, number) = self.reader.as_mut().unwrap();
            // File size bounds even a single enormous line. Invalid UTF-8 and
            // binary files are skipped explicitly, never lossy-searched.
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    self.reader = None;
                    continue;
                }
                Err(_) => {
                    self.skipped += 1;
                    self.reader = None;
                    continue;
                }
                _ => *number += 1,
            }
            if line.contains('\0') {
                self.skipped += 1;
                self.reader = None;
                continue;
            }
            let path = path
                .strip_prefix(&self.root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let number = *number;
            if self.contains(&line) {
                let snippet: String = line
                    .trim_end_matches(['\r', '\n'])
                    .chars()
                    .take(1600)
                    .collect();
                bytes += snippet.len() + path.len();
                matches.push(json!({"path":path,"line":number,"text":snippet,"snippet_truncated":line.trim_end().chars().count()>1600}));
            }
        }
        let more =
            self.reader.is_some() || !self.pending.is_empty() || !self.directories.is_empty();
        json!({"matches":matches,"more":more,"scanned_files":self.scanned,"skipped_entries":self.skipped,
            "omissions":"Git metadata and links are excluded. Generated directories are excluded by default. Binary, unreadable and files over 2 MiB are skipped; counts are cumulative. No .gitignore filtering is applied.","excluded_generated_directories":GENERATED})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("velum-tools-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(fs::canonicalize(p).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn bounded_git_output_drains_the_entire_stream() {
        let mut input = std::io::Cursor::new(vec![b'x'; 64000]);
        let (output, truncated) = read_bounded(&mut input, 24000).unwrap();
        assert_eq!(output.len(), 24000);
        assert!(truncated);
        assert_eq!(input.position(), 64000);
    }
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
    fn git(repo: &Path, args: &[&str]) {
        // Per-command identity: never touch the developer's global Git config.
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=velum-test@example.com",
                "-c",
                "user.name=Velum Test",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(repo)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("git must run");
        assert!(status.success(), "git {args:?} failed");
    }
    fn git_repo() -> Option<Fixture> {
        if !git_available() {
            return None;
        }
        let fixture = Fixture::new();
        git(&fixture.0, &["init", "-b", "main"]);
        fs::write(fixture.0.join("note.txt"), "first\n").unwrap();
        git(&fixture.0, &["add", "note.txt"]);
        git(&fixture.0, &["commit", "-m", "initial"]);
        Some(fixture)
    }
    #[test]
    fn git_reports_branches_status_and_diff() {
        let Some(repo) = git_repo() else {
            return;
        };
        git(&repo.0, &["checkout", "-b", "feature/work"]);
        fs::write(repo.0.join("note.txt"), "first\nsecond\n").unwrap();
        let branches = git_branches(&repo.0).unwrap();
        assert_eq!(branches["current"], "feature/work");
        let names: Vec<&str> = branches["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"feature/work"));
        let status = git_status(&repo.0).unwrap()["status"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(status.contains("## feature/work"), "{status}");
        assert!(status.contains("note.txt"), "{status}");
        let stat = git_diff(&repo.0, "", None).unwrap();
        assert_eq!(stat["base"], "HEAD");
        assert!(stat["diff"].as_str().unwrap().contains("note.txt"));
        let file = git_diff(&repo.0, "", Some("note.txt")).unwrap();
        let diff = file["diff"].as_str().unwrap().to_owned();
        assert!(diff.contains("+second"), "{diff}");
        assert!(!file["truncated"].as_bool().unwrap());
    }
    #[test]
    fn git_outside_a_repository_reports_no_repo() {
        let fixture = Fixture::new();
        for result in [
            git_branches(&fixture.0),
            git_status(&fixture.0),
            git_diff(&fixture.0, "", None),
            git_log(&fixture.0, 20),
            git_sync(&fixture.0),
        ] {
            assert_eq!(result.unwrap_err(), "No Git repository detected.");
        }
    }
    #[test]
    fn git_reports_log_newest_first_and_zero_sync_without_upstream() {
        let Some(repo) = git_repo() else {
            return;
        };
        fs::write(repo.0.join("second.txt"), "second\n").unwrap();
        git(&repo.0, &["add", "second.txt"]);
        git(&repo.0, &["commit", "-m", "second commit"]);
        let log = git_log(&repo.0, 20).unwrap();
        let commits = log["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0]["subject"], "second commit");
        assert_eq!(commits[1]["subject"], "initial");
        assert_eq!(commits[0]["author"], "Velum Test");
        assert!(!commits[0]["hash"].as_str().unwrap().is_empty());
        assert!(!commits[0]["short"].as_str().unwrap().is_empty());
        assert_eq!(log["global_config_changed"], false);
        let limited = git_log(&repo.0, 1).unwrap();
        assert_eq!(limited["commits"].as_array().unwrap().len(), 1);
        let sync = git_sync(&repo.0).unwrap();
        assert_eq!(sync["upstream"], "");
        assert_eq!(sync["ahead"], 0);
        assert_eq!(sync["behind"], 0);
    }
    #[test]
    fn git_diff_rejects_traversal_metadata_and_option_like_revisions() {
        let Some(repo) = git_repo() else {
            return;
        };
        for bad in [
            "../outside",
            "C:\\outside",
            ".git/config",
            "note.txt:secret",
            "sub/../..",
        ] {
            assert!(git_diff(&repo.0, "", Some(bad)).is_err(), "{bad}");
        }
        for bad in ["-h", "--help", "HEAD;rm", "a b"] {
            assert!(git_diff(&repo.0, bad, None).is_err(), "{bad}");
        }
    }
    #[test]
    fn incomplete_hash_reports_the_actual_argument_length_without_removal() {
        let f = Fixture::new();
        fs::write(f.0.join("probe.txt"), "probe v2").unwrap();
        let hash = inspect(&f.0, "probe.txt").unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        for short in [&hash[..41], &hash[..8], ""] {
            let error = delete(&f.0, "probe.txt", short).unwrap_err();
            assert!(error.contains("all 64 hexadecimal characters"));
            assert!(error.contains(&format!("received {} characters", short.len())));
            assert!(f.0.join("probe.txt").is_file());
        }
        assert!(delete(&f.0, "probe.txt", &"z".repeat(64)).is_err());
        assert!(f.0.join("probe.txt").is_file());
        assert!(delete(&f.0, "probe.txt", &hash.to_ascii_uppercase()).is_ok());
        assert!(!f.0.join("probe.txt").exists());
    }
    #[test]
    fn removal_is_hash_guarded_and_confined() {
        let f = Fixture::new();
        fs::write(f.0.join("draft.txt"), "a").unwrap();
        let hash = inspect(&f.0, "draft.txt").unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        fs::write(f.0.join("draft.txt"), "b").unwrap();
        assert!(delete(&f.0, "draft.txt", &hash).is_err());
        for path in [
            "../outside",
            "C:\\outside",
            ".git/config",
            "draft.txt:secret",
        ] {
            assert!(resolve(&f.0, path).is_err(), "{path}");
        }
        assert!(delete(&f.0, ".", &hash).is_err());
        let hash = inspect(&f.0, "draft.txt").unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(delete(&f.0, "draft.txt", &hash).is_ok());
        assert!(!f.0.join("draft.txt").exists());
    }
    #[cfg(windows)]
    #[test]
    fn real_source_on_onedrive_is_a_regular_file() {
        let root = fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
        let source = root.join("src/lib.rs");
        assert!(!linked(&fs::symlink_metadata(&source).unwrap()));
        assert!(inspect(&root, "src/lib.rs").unwrap()["sha256"].is_string());
    }
    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_search_or_deletion() {
        use std::os::windows::process::CommandExt;
        let root = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("keep.txt"), "keep outside").unwrap();
        let link = root.0.join("redirect");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside.0)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(linked(&fs::symlink_metadata(&link).unwrap()));
        assert!(inspect(&root.0, "redirect/keep.txt").is_err());
        let mut search = Search::new(&root.0, ".", "keep", "text", false, false).unwrap();
        assert!(search.page(10)["matches"].as_array().unwrap().is_empty());
        assert!(outside.0.join("keep.txt").exists());
    }
    #[test]
    fn large_trees_have_continuation_without_generated_noise() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("node_modules")).unwrap();
        fs::create_dir(f.0.join(".preview")).unwrap();
        fs::write(f.0.join("node_modules/noise"), "needle").unwrap();
        fs::write(f.0.join(".preview/noise"), "needle").unwrap();
        for n in 0..110 {
            fs::write(f.0.join(format!("source-{n}.txt")), "needle\nneedle\n").unwrap();
        }
        let mut search = Search::new(&f.0, ".", "needle", "text", false, false).unwrap();
        let mut count = 0;
        for _ in 0..100 {
            let page = search.page(7);
            count += page["matches"].as_array().unwrap().len();
            if page["more"] == false {
                break;
            }
        }
        assert_eq!(count, 220);
        assert_eq!(search.skipped, 2);
        assert!(Search::new(&f.0, ".", "needle", "text", false, true).is_err());
        assert_eq!(
            Search::new(&f.0, ".preview", "needle", "text", false, true)
                .unwrap()
                .page(5)["matches"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
