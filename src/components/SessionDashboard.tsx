import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import BotAvatar from "./BotAvatar";
import type { BotIdentity } from "../bots";
import { providerNames, type Provider, type RunOptions } from "../providers";
import type { UsageSnapshot } from "../usage";
import { friendlyTool } from "../conversationUX";
import { copyText } from "./clip";
import {
  describeFile,
  parseStatus,
  type ChangedFile,
} from "./gitStatus";
import { DiffLines } from "./diffViewer";
import GitHubHub from "./GitHubHub";
import "./SessionDashboard.css";
import "./GitPanel.css";

interface GitState {
  root: string;
  current: string;
  status: string;
  branches: { name: string; upstream: string; head: string }[];
  ahead?: number;
  behind?: number;
}

export interface TodoItem {
  text: string;
  status: string;
}

export interface ToolActionSummary {
  id: number;
  taskId: string;
  name: string;
  status: string;
  output: string;
  result?: string;
  reason?: string;
}

export interface SessionDashboardProps {
  workspace: string | null;
  bot: BotIdentity | null;
  provider: Provider;
  options: RunOptions;
  running: boolean;
  activity: string;
  todos: TodoItem[];
  blocks: {
    id: number;
    kind: string;
    [key: string]: unknown;
  }[];
  usage: UsageSnapshot;
  memoryUsage: { titles: string[]; bytes: number } | null;
  selectedDiffFile: string | null;
  onSelectDiffFile: (path: string | null) => void;
  onInsertDraft?: (text: string) => void;
  onClose?: () => void;
  initialTab?: "diff" | "tasks" | "activity" | "telemetry" | "github";
}

export default function SessionDashboard({
  workspace,
  bot,
  provider,
  options,
  running,
  activity,
  todos,
  blocks,
  usage,
  memoryUsage,
  selectedDiffFile,
  onSelectDiffFile,
  onInsertDraft,
  onClose,
  initialTab = "diff",
}: SessionDashboardProps) {
  const [activeTab, setActiveTab] = useState<"diff" | "tasks" | "activity" | "telemetry" | "github">(initialTab);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [gitError, setGitError] = useState("");
  const [busyGit, setBusyGit] = useState(false);
  const [fileDiff, setFileDiff] = useState("");
  const [diffSearch, setDiffSearch] = useState("");
  const [copiedDiff, setCopiedDiff] = useState(false);
  const [expandedToolId, setExpandedToolId] = useState<number | null>(null);
  const requestSeq = useRef(0);

  // Parse git files from git status string
  const parsedGit = useMemo(() => {
    if (!gitState?.status) return { header: "", files: [] };
    return parseStatus(gitState.status);
  }, [gitState?.status]);

  // Load git state
  const loadGit = useCallback(async () => {
    if (!workspace) {
      setGitState(null);
      return;
    }
    const id = ++requestSeq.current;
    setBusyGit(true);
    setGitError("");
    try {
      const state = await invoke<GitState>("git_state", { workspace });
      if (requestSeq.current !== id) return;
      setGitState(state);
    } catch (e) {
      if (requestSeq.current === id) setGitError(String(e));
    } finally {
      if (requestSeq.current === id) setBusyGit(false);
    }
  }, [workspace]);

  // Reload git state when workspace changes or turns finish (running flips to false)
  useEffect(() => {
    void loadGit();
  }, [loadGit, running]);

  // Load diff for selected file
  const loadDiff = useCallback(
    async (path: string) => {
      if (!workspace || !gitState?.current || !path) {
        setFileDiff("");
        return;
      }
      try {
        const res = await invoke<{ diff: string }>("git_file_diff", {
          workspace,
          base: gitState.current,
          path,
        });
        setFileDiff(res.diff || "[No difference in this file]");
      } catch (e) {
        setFileDiff(`Could not load diff: ${String(e)}`);
      }
    },
    [workspace, gitState?.current],
  );

  // If a diff file is selected from outside (or first file available)
  useEffect(() => {
    if (selectedDiffFile) {
      setActiveTab("diff");
      void loadDiff(selectedDiffFile);
    } else if (parsedGit.files.length > 0 && !selectedDiffFile) {
      const first = parsedGit.files[0]!.path;
      onSelectDiffFile(first);
      void loadDiff(first);
    }
  }, [selectedDiffFile, parsedGit.files, loadDiff, onSelectDiffFile]);

  // Extract tools from blocks
  const toolActions = useMemo<ToolActionSummary[]>(() => {
    return blocks
      .filter((b): b is { id: number; kind: "tool"; taskId: string; name: string; status: string; output: string; result?: string; reason?: string } => b.kind === "tool")
      .map((b) => ({
        id: b.id,
        taskId: b.taskId,
        name: b.name,
        status: b.status,
        output: b.output,
        result: b.result,
        reason: b.reason,
      }));
  }, [blocks]);

  const completedTodos = useMemo(() => todos.filter((t) => t.status === "completed"), [todos]);
  const progressPercent = todos.length > 0 ? Math.round((completedTodos.length / todos.length) * 100) : 0;

  return (
    <aside className="session-dashboard" aria-label="Session Mission Dashboard">
      <header className="sd-header">
        <div className="sd-title-area">
          {bot ? (
            <BotAvatar bot={bot} size={28} status={running ? "working" : "idle"} />
          ) : (
            <Icon name="sparkles" size={20} style={{ color: "var(--accent)" }} />
          )}
          <div className="sd-title">
            <strong>
              {bot?.name || providerNames[provider]}
              {running && <span className="sd-badge active-count">Active</span>}
            </strong>
            <span>
              {running
                ? activity || "Working on your request…"
                : `${parsedGit.files.length} changed files · ${todos.length} tasks`}
            </span>
          </div>
        </div>
        <div className="sd-header-actions">
          <button
            type="button"
            className="sd-icon-btn"
            title="Refresh Git status and diffs"
            aria-label="Refresh Git status and diffs"
            disabled={busyGit}
            onClick={() => void loadGit()}
          >
            <Icon name="reset" size={14} />
          </button>
          {onClose && (
            <button
              type="button"
              className="sd-icon-btn"
              title="Close Dashboard"
              aria-label="Close Dashboard"
              onClick={onClose}
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
      </header>

      <nav className="sd-tabs-bar" role="tablist" aria-label="Dashboard sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "diff"}
          className={`sd-tab-btn${activeTab === "diff" ? " active" : ""}`}
          onClick={() => setActiveTab("diff")}
        >
          <Icon name="diff" size={13} />
          <span>Diff & Changes</span>
          {parsedGit.files.length > 0 && (
            <span className="sd-badge active-count">{parsedGit.files.length}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "tasks"}
          className={`sd-tab-btn${activeTab === "tasks" ? " active" : ""}`}
          onClick={() => setActiveTab("tasks")}
        >
          <Icon name="board" size={13} />
          <span>Tasks & Plan</span>
          {todos.length > 0 && (
            <span className="sd-badge">{completedTodos.length}/{todos.length}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "activity"}
          className={`sd-tab-btn${activeTab === "activity" ? " active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          <Icon name="terminal" size={13} />
          <span>Tools Log</span>
          {toolActions.length > 0 && (
            <span className="sd-badge">{toolActions.length}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "telemetry"}
          className={`sd-tab-btn${activeTab === "telemetry" ? " active" : ""}`}
          onClick={() => setActiveTab("telemetry")}
        >
          <Icon name="settings" size={13} />
          <span>Telemetry</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "github"}
          className={`sd-tab-btn${activeTab === "github" ? " active" : ""}`}
          onClick={() => setActiveTab("github")}
        >
          <Icon name="github" size={13} />
          <span>GitHub</span>
        </button>
      </nav>

      <div className="sd-content">
        {/* Tab 1: Diff & Changes */}
        {activeTab === "diff" && (
          <div className="sd-diff-container">
            <div className="sd-diff-toolbar">
              <div className="sd-branch-info">
                <Icon name="branch" size={14} />
                <span>
                  {gitState?.current ? (
                    <>
                      Branch <strong>{gitState.current}</strong>
                      {gitState.ahead ? ` ↑${gitState.ahead}` : ""}
                      {gitState.behind ? ` ↓${gitState.behind}` : ""}
                    </>
                  ) : (
                    "Git status"
                  )}
                </span>
              </div>
              {selectedDiffFile && fileDiff && (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    className="sd-action-chip"
                    title="Copy diff to clipboard"
                    onClick={() => {
                      void copyText(fileDiff).then((ok) => {
                        if (ok) {
                          setCopiedDiff(true);
                          setTimeout(() => setCopiedDiff(false), 1400);
                        }
                      });
                    }}
                  >
                    <Icon name={copiedDiff ? "check" : "copy"} size={13} />
                    <span>{copiedDiff ? "Copied" : "Copy"}</span>
                  </button>
                  {onInsertDraft && (
                    <button
                      type="button"
                      className="sd-action-chip"
                      title="Insert diff excerpt into composer"
                      onClick={() => {
                        const snippet = `Here is the diff for \`${selectedDiffFile}\`:\n\`\`\`diff\n${fileDiff.slice(0, 4000)}\n\`\`\``;
                        onInsertDraft(snippet);
                      }}
                    >
                      <Icon name="arrow" size={12} />
                      <span>Ask in chat</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {gitError ? (
              <div className="sd-empty-state">
                <Icon name="shield" size={24} style={{ color: "var(--danger)" }} />
                <strong>Git not detected or error</strong>
                <p>{gitError}</p>
              </div>
            ) : parsedGit.files.length === 0 ? (
              <div className="sd-empty-state">
                <Icon name="check" size={28} style={{ color: "var(--ok)" }} />
                <strong>Clean Working Tree</strong>
                <p>No modified or uncommitted files in this workspace right now.</p>
              </div>
            ) : (
              <div className="sd-diff-layout">
                {/* File selection list */}
                <div className="sd-file-list">
                  <div className="sd-file-list-head">
                    <span>Changed Files</span>
                    <span>{parsedGit.files.length}</span>
                  </div>
                  <ul className="sd-file-items">
                    {parsedGit.files.map((file: ChangedFile) => {
                      const isSel = selectedDiffFile === file.path;
                      const flagClass =
                        file.x === "?" || file.y === "?"
                          ? "untracked"
                          : file.x === "D" || file.y === "D"
                          ? "deleted"
                          : file.x === "A" || file.y === "A"
                          ? "added"
                          : "modified";
                      const flagText =
                        file.x === "?" || file.y === "?"
                          ? "?"
                          : `${file.x.trim()}${file.y.trim()}` || "M";
                      return (
                        <li key={file.path}>
                          <button
                            type="button"
                            className={`sd-file-item${isSel ? " selected" : ""}`}
                            onClick={() => {
                              onSelectDiffFile(file.path);
                              void loadDiff(file.path);
                            }}
                            title={`${file.path} (${describeFile(file)})`}
                          >
                            <span className={`sd-flag ${flagClass}`}>{flagText}</span>
                            <span className="sd-file-name">{file.path}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* Diff Viewer */}
                <div className="sd-diff-viewer">
                  {selectedDiffFile ? (
                    <>
                      <div className="sd-diff-viewer-head">
                        <span className="sd-diff-viewer-path">{selectedDiffFile}</span>
                        <div className="sd-diff-search">
                          <Icon name="search" size={12} />
                          <input
                            type="search"
                            placeholder="Filter diff lines…"
                            value={diffSearch}
                            onChange={(e) => setDiffSearch(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="sd-diff-body">
                        {fileDiff ? (
                          <DiffLines text={fileDiff} query={diffSearch} />
                        ) : (
                          <div style={{ color: "var(--muted)", padding: "12px" }}>
                            Loading diff…
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="sd-empty-state">
                      <Icon name="code" size={24} />
                      <strong>Select a file to inspect diff</strong>
                      <p>Click any file on the left to see unified line changes.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Tasks & Plan */}
        {activeTab === "tasks" && (
          <div className="sd-tasks-pane">
            <div className="sd-task-progress-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Plan Progress</strong>
                <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                  {completedTodos.length} of {todos.length} done ({progressPercent}%)
                </span>
              </div>
              <div className="sd-progress-bar-track">
                <div
                  className="sd-progress-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {todos.length === 0 ? (
              <div className="sd-empty-state">
                <Icon name="board" size={24} />
                <strong>No active tasks in this conversation</strong>
                <p>When the LLM formulates a plan or writes todos, they will stream here in real time.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {todos.map((todo, idx) => (
                  <div key={idx} className={`sd-task-item ${todo.status}`}>
                    <span className={`sd-task-dot ${todo.status}`}>
                      <Icon
                        name={todo.status === "completed" ? "check" : todo.status === "in_progress" ? "sparkles" : "plus"}
                        size={14}
                      />
                    </span>
                    <span className="sd-task-text">{todo.text}</span>
                  </div>
                ))}
              </div>
            )}

            {memoryUsage && memoryUsage.titles.length > 0 && (
              <div className="sd-memory-card">
                <strong>Active Memory & Guidance ({memoryUsage.titles.length})</strong>
                <div className="sd-memory-notes">
                  {memoryUsage.titles.map((title, i) => (
                    <span key={i} className="sd-memory-chip">
                      <Icon name="memory" size={11} style={{ marginRight: "4px" }} />
                      {title}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Tools & Activity Log */}
        {activeTab === "activity" && (
          <div className="sd-activity-pane">
            {toolActions.length === 0 ? (
              <div className="sd-empty-state">
                <Icon name="terminal" size={24} />
                <strong>No tool actions executed yet</strong>
                <p>When the agent searches, edits files, or executes shell commands, a full audit trail appears here.</p>
              </div>
            ) : (
              toolActions.map((tool) => {
                const open = expandedToolId === tool.id;
                const body = [tool.output, tool.result].filter(Boolean).join("\n");
                return (
                  <div key={tool.id} className="sd-activity-item">
                    <button
                      type="button"
                      className="sd-activity-head"
                      onClick={() => setExpandedToolId(open ? null : tool.id)}
                    >
                      <div className="sd-activity-title">
                        <Icon
                          name={tool.status === "completed" ? "check" : tool.status === "running" ? "terminal" : "shield"}
                          size={13}
                          style={{
                            color:
                              tool.status === "completed"
                                ? "var(--ok)"
                                : tool.status === "running"
                                ? "var(--accent)"
                                : "var(--danger)",
                          }}
                        />
                        <span>{friendlyTool(tool.name)}</span>
                      </div>
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>
                        {tool.status} {open ? "▾" : "▸"}
                      </span>
                    </button>
                    {open && body && <pre className="sd-activity-out">{body}</pre>}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Tab 4: Telemetry */}
        {activeTab === "telemetry" && (
          <div className="sd-telemetry-pane">
            <div className="sd-telemetry-grid">
              <div className="sd-metric-card">
                <span className="sd-metric-label">Provider</span>
                <span className="sd-metric-value" style={{ fontSize: "14px" }}>
                  {providerNames[provider]}
                </span>
              </div>
              <div className="sd-metric-card">
                <span className="sd-metric-label">Model</span>
                <span className="sd-metric-value" style={{ fontSize: "13px" }}>
                  {options.model || "Default"}
                </span>
              </div>
              <div className="sd-metric-card">
                <span className="sd-metric-label">Prompt Tokens</span>
                <span className="sd-metric-value">
                  {usage.turn?.input_tokens?.toLocaleString() || usage.context?.used_tokens?.toLocaleString() || "—"}
                </span>
              </div>
              <div className="sd-metric-card">
                <span className="sd-metric-label">Output Tokens</span>
                <span className="sd-metric-value">
                  {usage.turn?.output_tokens?.toLocaleString() || "—"}
                </span>
              </div>
            </div>

            {bot && (
              <div className="sd-metric-card">
                <span className="sd-metric-label">Bot Identity</span>
                <strong>{bot.name}</strong>
                <span style={{ fontSize: "11px", color: "var(--muted)" }}>Autonomous Assistant</span>
              </div>
            )}
          </div>
        )}

        {/* Tab 5: GitHub Hub */}
        {activeTab === "github" && (
          <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
            <GitHubHub workspace={workspace || ""} onClose={onClose} />
          </div>
        )}
      </div>
    </aside>
  );
}
