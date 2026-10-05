import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import {
  describeFile,
  groupStatus,
  parseStatus,
  summarizeStatus,
  type ChangedFile,
} from "./gitStatus";
import "./GitPanel.css";

interface Branch {
  name: string;
  upstream: string;
  head: string;
}

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

interface GitState {
  root: string;
  current: string;
  branches: Branch[];
  branches_truncated: boolean;
  status: string;
  status_truncated: boolean;
  log?: Commit[];
  log_truncated?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  remote_url?: string;
}

import GitHubHub from "./GitHubHub";
import { DiffLines, parseDiff, type DiffRow } from "./diffViewer";
export { DiffLines, parseDiff, type DiffRow };

function FileButton({
  file,
  active,
  disabled,
  onSelect,
}: {
  file: ChangedFile;
  active: boolean;
  disabled: boolean;
  onSelect: (path: string) => void;
}) {
  const label = describeFile(file);
  return (
    <li key={file.path}>
      <button
        type="button"
        aria-pressed={active}
        className={active ? "active" : ""}
        disabled={disabled}
        onClick={() => onSelect(file.path)}
        title={`${file.path} — ${label}`}
      >
        <span className="git-flags" aria-hidden="true">
          {file.x}
          {file.y}
        </span>
        <span className="git-path">{file.path}</span>
        <span className="git-status-label">{label}</span>
      </button>
    </li>
  );
}

export default function GitPanel({
  workspace,
  onClose,
}: {
  workspace: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<GitState | null>(null);
  const [base, setBase] = useState("");
  const [stat, setStat] = useState("");
  const [selected, setSelected] = useState("");
  const [diff, setDiff] = useState("");
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffUntracked, setDiffUntracked] = useState(false);
  const [find, setFind] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"workstation" | "github">("workstation");
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const loadState = useCallback(async () => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await invoke<GitState>("git_state", { workspace });
      if (request.current !== id) return;
      setState(next);
      setBase((previous) =>
        previous && next.branches.some((b) => b.name === previous)
          ? previous
          : next.current,
      );
    } catch (e) {
      if (request.current === id) setError(String(e));
    } finally {
      if (request.current === id) setBusy(false);
    }
  }, [workspace]);

  const loadDiff = useCallback(
    async (baseName: string, path: string) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        const next = await invoke<{
          diff: string;
          truncated: boolean;
          untracked?: boolean;
        }>("git_file_diff", { workspace, base: baseName, path });
        if (request.current !== id) return;
        if (path) {
          setDiff(next.diff);
          setDiffTruncated(next.truncated);
          setDiffUntracked(next.untracked ?? false);
          setFind("");
          setCopied(false);
        } else {
          setStat(next.diff);
        }
      } catch (e) {
        if (request.current === id) setError(String(e));
      } finally {
        if (request.current === id) setBusy(false);
      }
    },
    [workspace],
  );

  useEffect(() => {
    setSelected("");
    setDiff("");
    setDiffUntracked(false);
    setStat("");
    setFind("");
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state || !base) return;
    setSelected("");
    setDiff("");
    setDiffUntracked(false);
    setFind("");
    void loadDiff(base, "");
  }, [base, state, loadDiff]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button, select")?.focus();
  }, []);

  const { header, files } = parseStatus(state?.status ?? "");
  const groups = useMemo(() => groupStatus(files), [state?.status]);
  const summary = useMemo(
    () => summarizeStatus(header, files, groups),
    [header, files, groups],
  );
  const commits = state?.log ?? [];
  const ahead = state?.ahead ?? 0;
  const behind = state?.behind ?? 0;
  const upstream = state?.upstream ?? "";
  const effectiveBase = base || state?.current || "HEAD";

  const copyDiff = useCallback(async () => {
    if (!diff) return;
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Copy unavailable — select the diff text manually.");
    }
  }, [diff]);

  const selectFile = useCallback(
    (path: string) => {
      setSelected(path);
      void loadDiff(effectiveBase, path);
    },
    [effectiveBase, loadDiff],
  );

  const renderGroup = (title: string, list: ChangedFile[]) =>
    list.length > 0 && (
      <section aria-label={title}>
        <h3 className="git-group-title">
          {title} ({list.length})
        </h3>
        <ul className="git-files" aria-label={`${title} files`}>
          {list.map((f) => (
            <FileButton
              key={`${title}:${f.path}`}
              file={f}
              active={selected === f.path}
              disabled={busy}
              onSelect={selectFile}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div
      className="git-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="git-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-title"
        ref={panel}
      >
        <div className="git-header">
          <div>
            <span className="git-eyebrow">Git · read-only</span>
            <h2 id="git-title">
              {state ? (
                <>
                  <Icon name="code" size={16} /> {state.current || "(no branch)"}
                </>
              ) : (
                "Loading repository…"
              )}
            </h2>
          </div>

          <div className="git-header-center">
            <div className="git-view-mode-selector">
              <button
                type="button"
                className={`git-mode-btn ${viewMode === "workstation" ? "active" : ""}`}
                onClick={() => setViewMode("workstation")}
              >
                <Icon name="diff" size={13} /> Workstation
              </button>
              <button
                type="button"
                className={`git-mode-btn ${viewMode === "github" ? "active" : ""}`}
                onClick={() => setViewMode("github")}
              >
                <Icon name="github" size={13} /> GitHub Hub
              </button>
            </div>
          </div>

          <button type="button" aria-label="Close Git panel" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="git-content" aria-busy={busy} style={{ padding: 0, gap: 0 }}>
          {viewMode === "github" ? (
            <GitHubHub workspace={workspace} onClose={onClose} />
          ) : (
            <>
              {error && (
                <p role="alert" className="git-error" style={{ margin: "12px 20px" }}>
                  {error}
                </p>
              )}
              {state && (
                <>
                  <div className="git-top-bar">
                    <div className="git-top-meta">
                      <p className="git-repo" title={state.root}>
                        {state.root}
                      </p>
                      <p className="git-sync">
                        {upstream ? (
                          <>
                            Upstream {upstream}
                            {ahead > 0 && ` · ahead ${ahead}`}
                            {behind > 0 && ` · behind ${behind}`}
                            {ahead === 0 && behind === 0 && " · up to date"}
                          </>
                        ) : (
                          "No upstream tracking for this branch."
                        )}
                        {state.remote_url && (
                          <button
                            type="button"
                            className="git-remote-pill"
                            style={{ marginLeft: "10px" }}
                            onClick={() => setViewMode("github")}
                            title="Open in GitHub Hub"
                          >
                            <Icon name="github" size={12} /> {state.remote_url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}
                          </button>
                        )}
                      </p>
                    </div>
                <div className="git-row">
                  <label htmlFor="git-base">Compare working tree against</label>
                  <select
                    id="git-base"
                    value={effectiveBase}
                    disabled={busy}
                    onChange={(e) => setBase(e.target.value)}
                  >
                    {state.branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.name === state.current ? " (current)" : ""}
                        {b.upstream ? ` → ${b.upstream}` : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void loadState().then(() =>
                        loadDiff(effectiveBase, selected),
                      );
                    }}
                  >
                    <Icon name="reset" size={14} /> Refresh
                  </button>
                </div>
                {state.branches_truncated && (
                  <p className="git-caption">Branch list truncated.</p>
                )}
                <p className="git-caption" title={header || undefined}>
                  {summary || "—"}
                  {state.status_truncated ? " (truncated)" : ""}
                </p>
              </div>

              <div className="git-workstation">
                <div className="git-sidebar">
                  <div className="git-sidebar-files">
                    {files.length === 0 ? (
                      <p className="git-empty">
                        Working tree matches {effectiveBase}. New changes from the
                        agent appear here after you refresh.
                      </p>
                    ) : (
                      <div className="git-groups">
                        {renderGroup("Staged", groups.staged)}
                        {renderGroup("Unstaged", groups.unstaged)}
                        {renderGroup("Untracked", groups.untracked)}
                      </div>
                    )}
                  </div>

                  <div className="git-sidebar-commits">
                    <section aria-label="Recent commits">
                      <h3 className="git-group-title">
                        Recent commits{commits.length > 0 ? ` (${commits.length})` : ""}
                      </h3>
                      {commits.length === 0 ? (
                        <p className="git-caption">No commits to show.</p>
                      ) : (
                        <>
                          <ul className="git-history">
                            {commits.map((c) => (
                              <li key={c.hash} title={c.hash}>
                                <div className="git-history-head">
                                  <span className="git-hash" aria-hidden="true">
                                    {c.short}
                                  </span>
                                  <span className="git-subject">{c.subject}</span>
                                </div>
                                <span className="git-meta">
                                  {c.author}
                                  {c.date ? ` · ${c.date}` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {state.log_truncated && (
                            <p className="git-caption">
                              Commit list truncated to recent history.
                            </p>
                          )}
                        </>
                      )}
                    </section>
                  </div>
                </div>

                <div className="git-canvas">
                  <div className="git-split" style={{ display: "contents" }}>
                    {!selected ? (
                      <div className="git-diff-pane git-stat-pane" style={{ border: 0, padding: "20px", maxHeight: "none", height: "100%" }}>
                        <div className="git-stat-card">
                          <h4>Working Tree Summary</h4>
                          <p className="git-caption" style={{ marginBottom: "12px" }}>
                            Select any file on the left to see unified line changes, or review the overall stat below.
                          </p>
                          <pre className="git-stat">{stat || "Select a file."}</pre>
                        </div>
                      </div>
                    ) : (
                      <div className="git-diff-pane" style={{ border: 0, padding: 0, maxHeight: "none", height: "100%", display: "flex", flexDirection: "column" }}>
                        <div className="git-canvas-head">
                          <div className="git-canvas-title">
                            <h3>
                              {selected}
                              {diffUntracked && (
                                <span className="git-badge" style={{ marginLeft: "8px" }}>
                                  Untracked — new file
                                </span>
                              )}
                            </h3>
                          </div>
                          <div className="git-row git-canvas-actions">
                            <div className="git-diff-find-wrap">
                              <label htmlFor="git-diff-find">Find in diff</label>
                              <input
                                id="git-diff-find"
                                type="search"
                                value={find}
                                disabled={busy || !diff}
                                placeholder="Filter changed lines"
                                onChange={(e) => setFind(e.target.value)}
                              />
                            </div>
                            <button
                              type="button"
                              className="git-btn-action"
                              disabled={busy || !diff}
                              onClick={() => void copyDiff()}
                            >
                              {copied ? "Copied" : "Copy diff"}
                            </button>
                            <button
                              type="button"
                              className="git-btn-action git-btn-primary"
                              disabled={busy || !diff}
                              onClick={() => {
                                const prompt = `Please review these changes in \`${selected}\` against \`${effectiveBase}\`:\n\n\`\`\`diff\n${diff.slice(0, 10000)}\n\`\`\`\n`;
                                window.dispatchEvent(
                                  new CustomEvent("velum:insert-draft", { detail: prompt })
                                );
                                onClose();
                              }}
                              title="Ask agent to review this diff in chat"
                            >
                              <Icon name="chat" size={13} /> Ask agent to review
                            </button>
                          </div>
                        </div>

                        <div className="git-canvas-body">
                          {!diff ? (
                            <p className="git-caption">
                              No diff output for {selected} against {effectiveBase} — the file is unchanged there, or select Refresh to reload.
                            </p>
                          ) : (
                            <pre aria-label={`Diff of ${selected}`}>
                              <DiffLines text={diff} query={find} />
                            </pre>
                          )}
                          {diffTruncated && (
                            <p className="git-caption">
                              Diff truncated to recent output — narrow Find in diff or open the file.
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="git-footer">
                <p className="git-note">
                  This panel never changes files or branches. Switch branches in a terminal; paths are repository-relative.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
      </div>
    </div>
  );
}
