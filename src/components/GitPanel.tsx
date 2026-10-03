import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import { parseStatus } from "./gitStatus";
import "./GitPanel.css";

interface Branch {
  name: string;
  upstream: string;
  head: string;
}

interface GitState {
  root: string;
  current: string;
  branches: Branch[];
  branches_truncated: boolean;
  status: string;
  status_truncated: boolean;
}

function DiffLines({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <span key={i} className={`git-diff-${kind}`}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </>
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
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state || !base) return;
    setSelected("");
    setDiff("");
    void loadDiff(base, "");
  }, [base, state, loadDiff]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button, select")?.focus();
  }, []);

  const { header, files } = parseStatus(state?.status ?? "");
  const effectiveBase = base || state?.current || "HEAD";

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
                <div className="git-split">
                  <ul className="git-files" aria-label="Changed files">
                    {files.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          aria-pressed={selected === f.path}
                          className={selected === f.path ? "active" : ""}
                          onClick={() => {
                            setSelected(f.path);
                            void loadDiff(effectiveBase, f.path);
                          }}
                        >
                          <span className="git-flags" aria-hidden="true">
                            {f.x}
                            {f.y}
                          </span>
                          <span className="git-path">{f.path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="git-diff-pane">
                    {!selected ? (
                      <pre className="git-stat">{stat || "Select a file."}</pre>
                    ) : (
                      <>
                        <h3>{selected}</h3>
                        <pre aria-label={`Diff of ${selected}`}>
                          <DiffLines text={diff || "(no diff — select Refresh)"} />
                        </pre>
                        {diffTruncated && (
                          <p className="git-caption">Diff truncated.</p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
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
