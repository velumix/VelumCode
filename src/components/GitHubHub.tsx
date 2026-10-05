import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon from "./Icon";
import {
  clearGitHubPat,
  createGitHubIssue,
  fetchGitHubAuthStatus,
  fetchGitHubIssues,
  fetchGitHubPulls,
  fetchGitHubRepoDetails,
  fetchGitHubUserProfile,
  saveGitHubPat,
  type GitHubAuthStatus,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepoDetails,
  type GitHubUserProfile,
} from "../services/github";
import "./GitHubHub.css";

interface GitHubHubProps {
  workspace: string;
  onClose?: () => void;
}

export default function GitHubHub({ workspace, onClose }: GitHubHubProps) {
  const [tab, setTab] = useState<"overview" | "pulls" | "issues" | "auth">("overview");
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null);
  const [profile, setProfile] = useState<GitHubUserProfile | null>(null);
  const [repoDetails, setRepoDetails] = useState<GitHubRepoDetails | null>(null);
  const [pulls, setPulls] = useState<GitHubPullRequest[]>([]);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [filterState, setFilterState] = useState<"open" | "closed" | "all">("open");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [patInput, setPatInput] = useState("");
  const [patSaving, setPatSaving] = useState(false);
  const [patSuccess, setPatSuccess] = useState("");
  const [copiedUrl, setCopiedUrl] = useState<string>("");

  // Create issue form state
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [creatingIssue, setCreatingIssue] = useState(false);

  const safeOpen = useCallback(async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const status = await fetchGitHubAuthStatus();
      setAuthStatus(status);

      try {
        const u = await fetchGitHubUserProfile();
        setProfile(u);
      } catch (e) {
        console.warn("GitHub profile load error:", e);
      }

      try {
        const r = await fetchGitHubRepoDetails(workspace);
        setRepoDetails(r);
      } catch (e) {
        console.warn("GitHub repo details load error:", e);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  const loadPulls = useCallback(async () => {
    setLoading(true);
    try {
      const p = await fetchGitHubPulls(workspace, undefined, filterState);
      setPulls(p);
    } catch (e) {
      console.warn("Failed to load pulls:", e);
    } finally {
      setLoading(false);
    }
  }, [workspace, filterState]);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      const iss = await fetchGitHubIssues(workspace, undefined, filterState);
      setIssues(iss);
    } catch (e) {
      console.warn("Failed to load issues:", e);
    } finally {
      setLoading(false);
    }
  }, [workspace, filterState]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (tab === "pulls") {
      void loadPulls();
    } else if (tab === "issues") {
      void loadIssues();
    }
  }, [tab, loadPulls, loadIssues]);

  const handleSavePat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patInput.trim()) return;
    setPatSaving(true);
    setError("");
    setPatSuccess("");
    try {
      const u = await saveGitHubPat(patInput.trim());
      setProfile(u);
      setPatSuccess(`Token saved! Connected as @${u.login}`);
      setPatInput("");
      const status = await fetchGitHubAuthStatus();
      setAuthStatus(status);
      void loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setPatSaving(false);
    }
  };

  const handleClearPat = async () => {
    setPatSaving(true);
    setError("");
    setPatSuccess("");
    try {
      await clearGitHubPat();
      setPatSuccess("Custom token removed. Reset to default authentication.");
      const status = await fetchGitHubAuthStatus();
      setAuthStatus(status);
      void loadData();
    } catch (err) {
      setError(String(err));
    } finally {
      setPatSaving(false);
    }
  };

  const handleCreateIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIssueTitle.trim()) return;
    setCreatingIssue(true);
    setError("");
    try {
      const created = await createGitHubIssue(
        workspace,
        newIssueTitle.trim(),
        newIssueBody.trim(),
      );
      setIssues((prev) => [created, ...prev]);
      setNewIssueTitle("");
      setNewIssueBody("");
      setShowNewIssue(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreatingIssue(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUrl(label);
      setTimeout(() => setCopiedUrl(""), 2000);
    } catch {
      // fallback
    }
  };

  const insertPromptToChat = (prompt: string) => {
    window.dispatchEvent(
      new CustomEvent("velum:insert-draft", { detail: prompt }),
    );
    if (onClose) onClose();
  };

  return (
    <div className="github-hub">
      <div className="github-hub-header">
        <div className="github-hub-identity">
          {profile?.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt={profile.login}
              className="github-avatar"
            />
          ) : (
            <div className="github-avatar-placeholder">
              <Icon name="github" size={24} />
            </div>
          )}
          <div className="github-id-info">
            <div className="github-id-row">
              <h3 className="github-name">
                {profile?.name || profile?.login || "GitHub Integration"}
              </h3>
              {profile?.login && (
                <span className="github-handle">@{profile.login}</span>
              )}
              {profile?.authenticated ? (
                <span className="github-badge github-badge-success">
                  <span className="badge-dot" /> Connected ({profile.auth_source})
                </span>
              ) : (
                <span className="github-badge github-badge-warning">
                  Unauthenticated
                </span>
              )}
            </div>
            {repoDetails?.full_name ? (
              <p className="github-repo-active">
                <Icon name="code" size={13} /> {repoDetails.full_name}
                {repoDetails.private ? " (Private)" : " (Public)"}
              </p>
            ) : (
              <p className="github-caption">No GitHub remote repository attached to this workspace.</p>
            )}
          </div>
        </div>

        <div className="github-hub-nav">
          <button
            type="button"
            className={`github-nav-btn ${tab === "overview" ? "active" : ""}`}
            onClick={() => setTab("overview")}
          >
            <Icon name="board" size={14} /> Overview
          </button>
          <button
            type="button"
            className={`github-nav-btn ${tab === "pulls" ? "active" : ""}`}
            onClick={() => setTab("pulls")}
          >
            <Icon name="pr" size={14} /> Pull Requests
          </button>
          <button
            type="button"
            className={`github-nav-btn ${tab === "issues" ? "active" : ""}`}
            onClick={() => setTab("issues")}
          >
            <Icon name="issue" size={14} /> Issues
          </button>
          <button
            type="button"
            className={`github-nav-btn ${tab === "auth" ? "active" : ""}`}
            onClick={() => setTab("auth")}
          >
            <Icon name="settings" size={14} /> Account & Auth
          </button>
          <button
            type="button"
            className="github-nav-btn github-refresh-btn"
            disabled={loading}
            onClick={() => {
              void loadData();
              if (tab === "pulls") void loadPulls();
              if (tab === "issues") void loadIssues();
            }}
            title="Refresh GitHub Data"
          >
            <Icon name="reset" size={14} />
          </button>
        </div>
      </div>

      {error && (
        <div className="github-banner github-banner-error" role="alert">
          <Icon name="bug" size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {patSuccess && (
        <div className="github-banner github-banner-success">
          <Icon name="check" size={16} />
          <span>{patSuccess}</span>
          <button type="button" onClick={() => setPatSuccess("")}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="github-hub-body" aria-busy={loading}>
        {tab === "overview" && (
          <div className="github-overview-grid">
            {/* Repository Card */}
            {repoDetails ? (
              <div className="github-card github-repo-card">
                <div className="github-card-header">
                  <div>
                    <span className="github-card-eyebrow">Repository</span>
                    <h4>{repoDetails.full_name}</h4>
                  </div>
                  <button
                    type="button"
                    className="github-btn-secondary"
                    onClick={() => safeOpen(repoDetails.html_url)}
                  >
                    <Icon name="github" size={14} /> View on GitHub
                  </button>
                </div>

                {repoDetails.description && (
                  <p className="github-repo-desc">{repoDetails.description}</p>
                )}

                <div className="github-stats-row">
                  <div className="github-stat-pill">
                    <Icon name="star" size={13} />
                    <span>{repoDetails.stars.toLocaleString()} Stars</span>
                  </div>
                  <div className="github-stat-pill">
                    <Icon name="branch" size={13} />
                    <span>{repoDetails.forks.toLocaleString()} Forks</span>
                  </div>
                  <div className="github-stat-pill">
                    <Icon name="issue" size={13} />
                    <span>{repoDetails.open_issues_count.toLocaleString()} Issues</span>
                  </div>
                  <div className="github-stat-pill">
                    <Icon name="code" size={13} />
                    <span>Branch: {repoDetails.default_branch}</span>
                  </div>
                </div>

                <div className="github-clone-actions">
                  <span className="github-caption">Quick Git Remotes:</span>
                  <div className="github-clone-bar">
                    <span className="github-url-text">{repoDetails.clone_url}</span>
                    <button
                      type="button"
                      className="github-btn-sm"
                      onClick={() =>
                        copyToClipboard(repoDetails.clone_url, "https")
                      }
                    >
                      <Icon name="copy" size={12} />
                      {copiedUrl === "https" ? "Copied" : "HTTPS"}
                    </button>
                    <button
                      type="button"
                      className="github-btn-sm"
                      onClick={() =>
                        copyToClipboard(repoDetails.ssh_url, "ssh")
                      }
                    >
                      <Icon name="copy" size={12} />
                      {copiedUrl === "ssh" ? "Copied" : "SSH"}
                    </button>
                  </div>
                </div>

                {repoDetails.topics.length > 0 && (
                  <div className="github-topics">
                    {repoDetails.topics.map((t) => (
                      <span key={t} className="github-topic-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="github-card github-empty-card">
                <Icon name="code" size={32} />
                <h4>No Remote Repository Detected</h4>
                <p>
                  This project folder is not yet linked to a GitHub remote.
                  Configure an <code>origin</code> remote pointing to GitHub to
                  manage pull requests, issues, and sync.
                </p>
              </div>
            )}

            {/* Profile & Scopes Card */}
            {profile && (
              <div className="github-card github-profile-card">
                <div className="github-card-header">
                  <div>
                    <span className="github-card-eyebrow">Identity</span>
                    <h4>Account Details</h4>
                  </div>
                  <button
                    type="button"
                    className="github-btn-secondary"
                    onClick={() => safeOpen(profile.html_url)}
                  >
                    Profile
                  </button>
                </div>

                {profile.bio && <p className="github-bio">{profile.bio}</p>}

                <div className="github-profile-meta">
                  <div className="github-meta-item">
                    <strong>{profile.public_repos}</strong>
                    <span>Public Repos</span>
                  </div>
                  {profile.total_private_repos !== undefined && (
                    <div className="github-meta-item">
                      <strong>{profile.total_private_repos}</strong>
                      <span>Private Repos</span>
                    </div>
                  )}
                  <div className="github-meta-item">
                    <strong>{profile.followers}</strong>
                    <span>Followers</span>
                  </div>
                  <div className="github-meta-item">
                    <strong>{profile.following}</strong>
                    <span>Following</span>
                  </div>
                </div>

                {profile.rate_limit_remaining !== undefined && (
                  <div className="github-rate-limit">
                    <span className="github-caption">
                      API Rate Limit Remaining:{" "}
                      <strong>
                        {profile.rate_limit_remaining} /{" "}
                        {profile.rate_limit_limit}
                      </strong>
                    </span>
                  </div>
                )}

                {profile.scopes.length > 0 && (
                  <div className="github-scopes-box">
                    <span className="github-caption">Authorized Token Scopes:</span>
                    <div className="github-scopes-list">
                      {profile.scopes.map((s) => (
                        <span key={s} className="github-scope-badge">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "pulls" && (
          <div className="github-pulls-view">
            <div className="github-sub-header">
              <div className="github-filter-group">
                {(["open", "closed", "all"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`github-filter-btn ${
                      filterState === s ? "active" : ""
                    }`}
                    onClick={() => setFilterState(s)}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="github-btn-secondary"
                onClick={() =>
                  safeOpen(
                    repoDetails?.html_url
                      ? `${repoDetails.html_url}/pulls`
                      : "https://github.com/pulls",
                  )
                }
              >
                <Icon name="pr" size={14} /> View All on GitHub
              </button>
            </div>

            {pulls.length === 0 ? (
              <div className="github-empty-list">
                <Icon name="pr" size={32} />
                <p>No {filterState} pull requests found for this repository.</p>
              </div>
            ) : (
              <ul className="github-item-list">
                {pulls.map((pr) => (
                  <li key={pr.number} className="github-list-item">
                    <div className="github-item-main">
                      <div className="github-item-title-row">
                        <span className="github-item-num">#{pr.number}</span>
                        <h4
                          className="github-item-title"
                          onClick={() => safeOpen(pr.html_url)}
                        >
                          {pr.title}
                        </h4>
                        {pr.draft && (
                          <span className="github-badge github-badge-draft">
                            Draft
                          </span>
                        )}
                        <span
                          className={`github-badge ${
                            pr.state === "open"
                              ? "github-badge-success"
                              : "github-badge-closed"
                          }`}
                        >
                          {pr.state}
                        </span>
                      </div>
                      <div className="github-item-sub">
                        <span>
                          by <strong>{pr.user_login}</strong> · branches:{" "}
                          <code>{pr.head_ref}</code> → <code>{pr.base_ref}</code>
                        </span>
                      </div>
                    </div>
                    <div className="github-item-actions">
                      <button
                        type="button"
                        className="github-btn-action"
                        onClick={() =>
                          insertPromptToChat(
                            `Please review Pull Request #${pr.number} ("${pr.title}") on branch \`${pr.head_ref}\` against \`${pr.base_ref}\`:\n${pr.html_url}`,
                          )
                        }
                        title="Ask agent to review this PR"
                      >
                        <Icon name="chat" size={13} /> Ask Agent
                      </button>
                      <button
                        type="button"
                        className="github-btn-sm"
                        onClick={() => safeOpen(pr.html_url)}
                      >
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "issues" && (
          <div className="github-issues-view">
            <div className="github-sub-header">
              <div className="github-filter-group">
                {(["open", "closed", "all"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`github-filter-btn ${
                      filterState === s ? "active" : ""
                    }`}
                    onClick={() => setFilterState(s)}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="github-row-gap">
                <button
                  type="button"
                  className="github-btn-primary"
                  onClick={() => setShowNewIssue((prev) => !prev)}
                >
                  <Icon name="plus" size={14} /> New Issue
                </button>
                <button
                  type="button"
                  className="github-btn-secondary"
                  onClick={() =>
                    safeOpen(
                      repoDetails?.html_url
                        ? `${repoDetails.html_url}/issues`
                        : "https://github.com/issues",
                    )
                  }
                >
                  <Icon name="issue" size={14} /> View on GitHub
                </button>
              </div>
            </div>

            {showNewIssue && (
              <form onSubmit={handleCreateIssue} className="github-new-issue-card">
                <h4>Create New GitHub Issue</h4>
                <input
                  type="text"
                  placeholder="Issue title"
                  value={newIssueTitle}
                  onChange={(e) => setNewIssueTitle(e.target.value)}
                  required
                  className="github-input"
                />
                <textarea
                  placeholder="Description (Markdown supported)"
                  value={newIssueBody}
                  onChange={(e) => setNewIssueBody(e.target.value)}
                  rows={4}
                  className="github-textarea"
                />
                <div className="github-form-actions">
                  <button
                    type="button"
                    className="github-btn-secondary"
                    onClick={() => setShowNewIssue(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="github-btn-primary"
                    disabled={creatingIssue || !newIssueTitle.trim()}
                  >
                    {creatingIssue ? "Submitting…" : "Submit Issue"}
                  </button>
                </div>
              </form>
            )}

            {issues.length === 0 ? (
              <div className="github-empty-list">
                <Icon name="issue" size={32} />
                <p>No {filterState} issues found for this repository.</p>
              </div>
            ) : (
              <ul className="github-item-list">
                {issues.map((iss) => (
                  <li key={iss.number} className="github-list-item">
                    <div className="github-item-main">
                      <div className="github-item-title-row">
                        <span className="github-item-num">#{iss.number}</span>
                        <h4
                          className="github-item-title"
                          onClick={() => safeOpen(iss.html_url)}
                        >
                          {iss.title}
                        </h4>
                        <span
                          className={`github-badge ${
                            iss.state === "open"
                              ? "github-badge-success"
                              : "github-badge-closed"
                          }`}
                        >
                          {iss.state}
                        </span>
                      </div>
                      <div className="github-item-sub">
                        <span>
                          opened by <strong>{iss.user_login}</strong>
                        </span>
                        {iss.labels.length > 0 && (
                          <div className="github-labels-row">
                            {iss.labels.map((l) => (
                              <span
                                key={l.name}
                                className="github-label-pill"
                                style={{
                                  backgroundColor: `#${l.color}22`,
                                  borderColor: `#${l.color}66`,
                                  color: `#${l.color}`,
                                }}
                              >
                                {l.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="github-item-actions">
                      <button
                        type="button"
                        className="github-btn-action"
                        onClick={() =>
                          insertPromptToChat(
                            `Please resolve GitHub Issue #${iss.number} ("${iss.title}"): ${iss.html_url}`,
                          )
                        }
                        title="Ask agent to work on this issue"
                      >
                        <Icon name="chat" size={13} /> Ask Agent
                      </button>
                      <button
                        type="button"
                        className="github-btn-sm"
                        onClick={() => safeOpen(iss.html_url)}
                      >
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "auth" && (
          <div className="github-auth-view">
            <div className="github-card">
              <h4>Authentication Strategy</h4>
              <p className="github-caption">
                Velum Code seamlessly connects to GitHub using either your
                system's GitHub CLI (<code>gh auth login</code>) or a stored
                Personal Access Token.
              </p>

              <div className="github-auth-status-box">
                <div className="github-auth-row">
                  <span>GitHub CLI (Keyring)</span>
                  <strong>
                    {authStatus?.has_cli
                      ? `Active (${authStatus.cli_account ?? "Logged in"})`
                      : "Not detected"}
                  </strong>
                </div>
                <div className="github-auth-row">
                  <span>Custom Personal Access Token (PAT)</span>
                  <strong>{authStatus?.has_pat ? "Configured" : "None"}</strong>
                </div>
                <div className="github-auth-row">
                  <span>Active Credential Source</span>
                  <span className="github-badge github-badge-success">
                    {authStatus?.active_source ?? "unauthenticated"}
                  </span>
                </div>
              </div>

              <form onSubmit={handleSavePat} className="github-pat-form">
                <label htmlFor="github-pat-input">
                  Set Personal Access Token (Classic or Fine-Grained)
                </label>
                <div className="github-pat-inputs">
                  <input
                    id="github-pat-input"
                    type="password"
                    value={patInput}
                    onChange={(e) => setPatInput(e.target.value)}
                    placeholder="ghp_... or github_pat_..."
                    className="github-input"
                  />
                  <button
                    type="submit"
                    className="github-btn-primary"
                    disabled={patSaving || !patInput.trim()}
                  >
                    {patSaving ? "Validating…" : "Save & Verify"}
                  </button>
                  {authStatus?.has_pat && (
                    <button
                      type="button"
                      className="github-btn-secondary"
                      onClick={() => void handleClearPat()}
                      disabled={patSaving}
                    >
                      Clear Token
                    </button>
                  )}
                </div>
                <p className="github-caption" style={{ marginTop: "8px" }}>
                  Requires <code>repo</code> and <code>user</code> scopes for
                  full pull request, commit status, and issue management.
                </p>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
