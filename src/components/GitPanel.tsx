import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import { groupStatus, parseStatus, type ChangedFile } from "./gitStatus";
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
}

function DiffLines({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  const lines = text.split("\n");
  const visible = needle
    ? lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.toLowerCase().includes(needle))
    : lines.map((line, index) => ({ line, index }));
  return (
    <>
      {needle && (
        <span className="git-diff-count" role="status">
          {visible.length} of {lines.length} lines match
          {visible.length === 0 ? " — clear the search to see the full diff." : "."}
        </span>
      )}
      {visible.map(({ line, index }) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <span key={index} className={`git-diff-line git-diff-${kind}`}>
            <span className="git-diff-ln" aria-hidden="true">
              {index + 1}
            </span>
            <span className="git-diff-text">{line || " "}</span>
            {"\n"}
          </span>
        );
      })}
    </>
  );
}

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
  return (
    <li key={file.path}>
      <button
        type="button"
        aria-pressed={active}
        className={active ? "active" : ""}
        disabled={disabled}
        onClick={() => onSelect(file.path)}
      >
        <span className="git-flags" aria-hidden="true">
          {file.x}
          {file.y}
        </span>
        <span className="git-path">{file.path}</span>
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
  const [find, setFind] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
        const next = await invoke<{ diff: string; truncated: boolean }>(
          "git_file_diff",
          { workspace, base: baseName, path },
        );
        if (request.current !== id) return;
        if (path) {
          setDiff(next.diff);
          setDiffTruncated(next.truncated);
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
    setStat("");
    setFind("");
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state || !base) return;
    setSelected("");
    setDiff("");
    setFind("");
    void loadDiff(base, "");
  }, [base, state, loadDiff]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button, select")?.focus();
  }, []);

  const { header, files } = parseStatus(state?.status ?? "");
  const groups = useMemo(() => groupStatus(files), [state?.status]);
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
          <button type="button" aria-label="Close Git panel" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="git-content" aria-busy={busy}>
          {error && (
            <p role="alert" className="git-error">
              {error}
            </p>
          )}
          {state && (
            <>
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
              </p>
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
              <p className="git-caption" title={header}>
                Status: {header || "—"}
                {state.status_truncated ? " (truncated)" : ""}
              </p>
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
                          <span className="git-hash" aria-hidden="true">
                            {c.short}
                          </span>
                          <span className="git-subject">{c.subject}</span>
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
              <div className="git-split">
                <div className="git-diff-pane git-stat-pane">
                  <pre className="git-stat">{stat || "Select a file."}</pre>
                </div>
                <div className="git-diff-pane">
                  {!selected ? (
                    <p className="git-caption">Select a file to see its diff.</p>
                  ) : (
                    <>
                      <h3>{selected}</h3>
                      <div className="git-row">
                        <label htmlFor="git-diff-find">Find in diff</label>
                        <input
                          id="git-diff-find"
                          type="search"
                          value={find}
                          disabled={busy || !diff}
                          placeholder="Filter changed lines"
                          onChange={(e) => setFind(e.target.value)}
                        />
                        <button
                          type="button"
                          disabled={busy || !diff}
                          onClick={() => void copyDiff()}
                        >
                          {copied ? "Copied" : "Copy diff"}
                        </button>
                        <button
                          type="button"
                          disabled={busy || !diff}
                          onClick={() => {
                            const prompt = `Please review these changes in \`${selected}\` against \`${effectiveBase}\`:\n\n\`\`\`diff\n${diff.slice(0, 10000)}\n\`\`\`\n`;
                            window.dispatchEvent(new CustomEvent("velum:insert-draft", { detail: prompt }));
                            onClose();
                          }}
                          title="Ask agent to review this diff in chat"
                        >
                          <Icon name="chat" size={13} /> Ask agent to review
                        </button>
                      </div>
                      <pre aria-label={`Diff of ${selected}`}>
                        <DiffLines text={diff || "(no diff — select Refresh)"} query={find} />
                      </pre>
                      {diffTruncated && (
                        <p className="git-caption">
                          Diff truncated to recent output — narrow Find in diff
                          or open the file.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
              <p className="git-note">
                This panel never changes files or branches. Switch branches in
                a terminal; paths are repository-relative.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
