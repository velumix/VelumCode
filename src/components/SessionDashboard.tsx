import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import BotAvatar from "./BotAvatar";
import type { BotIdentity } from "../bots";
import { providerNames, type Provider, type RunOptions } from "../providers";
import type { UsageSnapshot } from "../usage";
import { extractToolSnippet, fmtToolDuration, friendlyTool, toolCategory } from "../conversationUX";
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
  detail?: string;
  status: string;
  output: string;
  result?: string;
  reason?: string;
  durationMs?: number;
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
  requestedTab?: { tab: "diff" | "tasks" | "activity" | "telemetry" | "github"; seq: number } | null;
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
  requestedTab,
}: SessionDashboardProps) {
  const [activeTab, setActiveTab] = useState<"diff" | "tasks" | "activity" | "telemetry" | "github">(initialTab);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [gitError, setGitError] = useState("");
  const [busyGit, setBusyGit] = useState(false);
  const [fileDiff, setFileDiff] = useState("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffSearch, setDiffSearch] = useState("");
  const [copiedDiff, setCopiedDiff] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<number>>(new Set());
  const [toolSearch, setToolSearch] = useState("");
  const [toolCategoryFilter, setToolCategoryFilter] = useState<"all" | "shell" | "file" | "search" | "git" | "error">("all");
  const [copiedToolId, setCopiedToolId] = useState<number | null>(null);
  const requestSeq = useRef(0);
  const diffRequestSeq = useRef(0);

  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab.tab);
    }
  }, [requestedTab?.seq]);

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

  // Reload git state when workspace changes, turns finish, or window regains focus
  useEffect(() => {
    void loadGit();
    const onFocus = () => void loadGit();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadGit, running]);

  // Load diff for selected file
  const loadDiff = useCallback(
    async (path: string) => {
      if (!workspace || !path) {
        setFileDiff("");
        setLoadingDiff(false);
        setDiffTruncated(false);
        return;
      }
      const id = ++diffRequestSeq.current;
      setLoadingDiff(true);
      try {
        const base = gitState?.current || "HEAD";
        const res = await invoke<{ diff: string; truncated?: boolean }>("git_file_diff", {
          workspace,
          base,
          path,
        });
        if (diffRequestSeq.current !== id) return;
        setFileDiff(res.diff || "[No difference in this file]");
        setDiffTruncated(Boolean(res.truncated));
      } catch (e) {
        if (diffRequestSeq.current === id) {
          setFileDiff(`Could not load diff: ${String(e)}`);
          setDiffTruncated(false);
        }
      } finally {
        if (diffRequestSeq.current === id) setLoadingDiff(false);
      }
    },
    [workspace, gitState?.current],
  );

  // Sync selectedDiffFile with parsed files and lazily load diff only when diff tab is active
  useEffect(() => {
    if (parsedGit.files.length === 0) {
      if (selectedDiffFile) onSelectDiffFile(null);
      setFileDiff("");
      return;
    }
    if (selectedDiffFile && !parsedGit.files.some((f) => f.path === selectedDiffFile)) {
      const fallback = parsedGit.files[0]!.path;
      onSelectDiffFile(fallback);
      if (activeTab === "diff") void loadDiff(fallback);
    } else if (!selectedDiffFile && parsedGit.files.length > 0) {
      const first = parsedGit.files[0]!.path;
      onSelectDiffFile(first);
      if (activeTab === "diff") void loadDiff(first);
    } else if (selectedDiffFile && activeTab === "diff") {
      void loadDiff(selectedDiffFile);
    }
  }, [selectedDiffFile, parsedGit.files, loadDiff, onSelectDiffFile, activeTab]);

  // Extract tools from blocks
  const toolActions = useMemo<ToolActionSummary[]>(() => {
    return blocks
      .filter((b): b is { id: number; kind: "tool"; taskId: string; name: string; detail?: string; status: string; output: string; result?: string; reason?: string; durationMs?: number } => b.kind === "tool")
      .map((b) => ({
        id: b.id,
        taskId: b.taskId,
        name: b.name,
        detail: b.detail || extractToolSnippet(b.name, b.output, b.result),
        status: b.status,
        output: b.output,
        result: b.result,
        reason: b.reason,
        durationMs: b.durationMs,
      }));
  }, [blocks]);

  const toolStats = useMemo(() => {
    let cmdCount = 0;
    let fileCount = 0;
    let searchCount = 0;
    let gitCount = 0;
    let errorCount = 0;
    for (const t of toolActions) {
      const cat = toolCategory(t.name);
      if (cat === "shell") cmdCount++;
      else if (cat === "git") gitCount++;
      else if (cat === "file") fileCount++;
      else if (cat === "search") searchCount++;
      if (t.status === "failed" || t.status === "blocked" || t.status === "rejected" || !!t.reason) {
        errorCount++;
      }
    }
    return { cmdCount, fileCount, searchCount, gitCount, errorCount, total: toolActions.length };
  }, [toolActions]);

  const filteredTools = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    return toolActions.filter((tool) => {
      const cat = toolCategory(tool.name);
      const isError = tool.status === "failed" || tool.status === "blocked" || tool.status === "rejected" || !!tool.reason;

      if (toolCategoryFilter === "shell" && cat !== "shell") return false;
      if (toolCategoryFilter === "git" && cat !== "git") return false;
      if (toolCategoryFilter === "file" && cat !== "file") return false;
      if (toolCategoryFilter === "search" && cat !== "search") return false;
      if (toolCategoryFilter === "error" && !isError) return false;

      if (q) {
        const matchName = tool.name.toLowerCase().includes(q) || friendlyTool(tool.name).toLowerCase().includes(q);
        const matchDetail = tool.detail?.toLowerCase().includes(q);
        const matchOutput = tool.output?.toLowerCase().includes(q);
        const matchResult = tool.result?.toLowerCase().includes(q);
        const matchReason = tool.reason?.toLowerCase().includes(q);
        return Boolean(matchName || matchDetail || matchOutput || matchResult || matchReason);
      }
      return true;
    });
  }, [toolActions, toolCategoryFilter, toolSearch]);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAllTools = useCallback(() => {
    setExpandedToolIds(new Set(toolActions.map((t) => t.id)));
  }, [toolActions]);

  const collapseAllTools = useCallback(() => {
    setExpandedToolIds(new Set());
  }, []);

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
                        {loadingDiff ? (
                          <div style={{ color: "var(--muted)", padding: "12px" }}>
                            Loading diff…
                          </div>
                        ) : fileDiff ? (
                          <>
                            {diffTruncated && (
                              <div style={{ fontSize: "10px", color: "var(--muted)", padding: "4px 8px", background: "var(--raised)", borderRadius: "4px", marginBottom: "8px" }}>
                                Diff exceeds 24 KB and was truncated for preview.
                              </div>
                            )}
                            <DiffLines text={fileDiff} query={diffSearch} />
                          </>
                        ) : (
                          <div style={{ color: "var(--muted)", padding: "12px" }}>
                            [No difference in this file]
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
              <>
                <div className="sd-activity-toolbar">
                  <div className="sd-activity-search-wrap">
                    <Icon name="search" size={13} />
                    <input
                      type="text"
                      className="sd-activity-search-input"
                      placeholder="Filter by command, file, query, or output…"
                      value={toolSearch}
                      onChange={(e) => setToolSearch(e.target.value)}
                    />
                    {toolSearch && (
                      <button
                        type="button"
                        className="sd-search-clear-btn"
                        onClick={() => setToolSearch("")}
                        aria-label="Clear tool search"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  <div className="sd-activity-actions-row">
                    <div className="sd-activity-filters" role="tablist" aria-label="Tool category filters">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={toolCategoryFilter === "all"}
                        className={`sd-filter-pill${toolCategoryFilter === "all" ? " active" : ""}`}
                        onClick={() => setToolCategoryFilter("all")}
                      >
                        All <span className="sd-pill-count">{toolStats.total}</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={toolCategoryFilter === "shell"}
                        className={`sd-filter-pill${toolCategoryFilter === "shell" ? " active" : ""}`}
                        onClick={() => setToolCategoryFilter("shell")}
                      >
                        Commands <span className="sd-pill-count">{toolStats.cmdCount}</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={toolCategoryFilter === "file"}
                        className={`sd-filter-pill${toolCategoryFilter === "file" ? " active" : ""}`}
                        onClick={() => setToolCategoryFilter("file")}
                      >
                        Files <span className="sd-pill-count">{toolStats.fileCount}</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={toolCategoryFilter === "search"}
                        className={`sd-filter-pill${toolCategoryFilter === "search" ? " active" : ""}`}
                        onClick={() => setToolCategoryFilter("search")}
                      >
                        Search <span className="sd-pill-count">{toolStats.searchCount}</span>
                      </button>
                      {toolStats.gitCount > 0 && (
                        <button
                          type="button"
                          role="tab"
                          aria-selected={toolCategoryFilter === "git"}
                          className={`sd-filter-pill${toolCategoryFilter === "git" ? " active" : ""}`}
                          onClick={() => setToolCategoryFilter("git")}
                        >
                          Git <span className="sd-pill-count">{toolStats.gitCount}</span>
                        </button>
                      )}
                      {toolStats.errorCount > 0 && (
                        <button
                          type="button"
                          role="tab"
                          aria-selected={toolCategoryFilter === "error"}
                          className={`sd-filter-pill error-filter${toolCategoryFilter === "error" ? " active" : ""}`}
                          onClick={() => setToolCategoryFilter("error")}
                        >
                          Errors <span className="sd-pill-count">{toolStats.errorCount}</span>
                        </button>
                      )}
                    </div>

                    <div className="sd-view-toggle-btns">
                      <button
                        type="button"
                        className="sd-action-chip"
                        onClick={expandAllTools}
                        title="Expand all tool events"
                      >
                        Expand All
                      </button>
                      <button
                        type="button"
                        className="sd-action-chip"
                        onClick={collapseAllTools}
                        title="Collapse all tool events"
                      >
                        Collapse All
                      </button>
                    </div>
                  </div>
                </div>

                <div className="sd-activity-list">
                  {filteredTools.length === 0 ? (
                    <div className="sd-activity-none">
                      <span>No actions match the current filter or search criteria.</span>
                    </div>
                  ) : (
                    filteredTools.map((tool) => {
                      const open = expandedToolIds.has(tool.id);
                      const cat = toolCategory(tool.name);
                      const isError = tool.status === "failed" || tool.status === "blocked" || tool.status === "rejected" || !!tool.reason;
                      const isBusy = tool.status === "running";
                      const body = [tool.reason ? `Error / Reason: ${tool.reason}` : "", tool.output, tool.result].filter(Boolean).join("\n");
                      const snippet = tool.detail;
                      
                      let previewText = "";
                      if (!open) {
                        const raw = (tool.output || tool.result || "").trim();
                        if (raw) {
                          const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
                          if (lines.length > 0) {
                            previewText = lines[0].slice(0, 140);
                          }
                        }
                      }

                      return (
                        <div key={tool.id} className={`sd-activity-item ${cat}${isError ? " is-error" : ""}${isBusy ? " is-busy" : ""}`}>
                          <div className="sd-activity-head">
                            <button
                              type="button"
                              className="sd-activity-toggle-btn"
                              aria-expanded={open}
                              onClick={() => toggleExpanded(tool.id)}
                            >
                              <div className="sd-activity-title">
                                <span className={`sd-tool-dot ${isError ? "bad" : isBusy ? "busy" : "ok"}`}>
                                  <Icon
                                    name={isError ? "shield" : isBusy ? "terminal" : "check"}
                                    size={12}
                                  />
                                </span>
                                <span className={`sd-tool-type-badge cat-${cat}`}>
                                  {cat === "shell" ? "CMD" : cat.toUpperCase()}
                                </span>
                                {snippet ? (
                                  <code className="sd-tool-cmd-chip" title={snippet}>
                                    {snippet}
                                  </code>
                                ) : null}
                                <span className="sd-tool-name-sub">
                                  {friendlyTool(tool.name)}
                                </span>
                              </div>
                              <span className="sd-caret-indicator" aria-hidden="true">
                                {open ? "▾" : "▸"}
                              </span>
                            </button>

                            <div className="sd-activity-meta-actions">
                              {tool.durationMs != null && (
                                <span className="sd-tool-duration" title={`Execution time: ${fmtToolDuration(tool.durationMs)}`}>
                                  {fmtToolDuration(tool.durationMs)}
                                </span>
                              )}
                              {body ? (
                                <button
                                  type="button"
                                  className={`sd-action-chip sd-copy-btn${copiedToolId === tool.id ? " copied" : ""}`}
                                  title="Copy output to clipboard"
                                  onClick={async () => {
                                    await copyText(body);
                                    setCopiedToolId(tool.id);
                                    setTimeout(() => setCopiedToolId(null), 1500);
                                  }}
                                >
                                  <Icon name={copiedToolId === tool.id ? "check" : "copy"} size={11} />
                                  <span>{copiedToolId === tool.id ? "Copied" : "Copy"}</span>
                                </button>
                              ) : null}
                              {onInsertDraft && body ? (
                                <button
                                  type="button"
                                  className="sd-action-chip sd-ask-btn"
                                  title="Insert output into prompt composer"
                                  onClick={() => {
                                    const prompt = `Regarding the output from \`${tool.detail || tool.name}\`:\n\`\`\`\n${body.slice(0, 1500)}\n\`\`\``;
                                    onInsertDraft(prompt);
                                  }}
                                >
                                  <Icon name="chat" size={11} />
                                  <span>Ask</span>
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {!open && previewText && (
                            <button
                              type="button"
                              className="sd-activity-preview"
                              onClick={() => toggleExpanded(tool.id)}
                              title="Click to view full output"
                            >
                              <code>{previewText}</code>
                            </button>
                          )}

                          {open && (
                            <div className="sd-activity-body">
                              {tool.detail && (
                                <div className="sd-activity-target-row">
                                  <span className="sd-meta-tag">Command / Target</span>
                                  <code className="sd-target-code">{tool.detail}</code>
                                  <button
                                    type="button"
                                    className="sd-mini-copy"
                                    title="Copy target"
                                    onClick={() => copyText(tool.detail!)}
                                  >
                                    <Icon name="copy" size={11} />
                                  </button>
                                </div>
                              )}
                              {tool.reason && (
                                <div className="sd-activity-reason">
                                  <Icon name="shield" size={13} />
                                  <span>{tool.reason}</span>
                                </div>
                              )}
                              {body ? (
                                <pre className="sd-activity-out">{body}</pre>
                              ) : (
                                <div className="sd-activity-empty-out">
                                  {isBusy ? "Executing command in workspace…" : "No text output recorded."}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
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
            <GitHubHub workspace={workspace || ""} embedded onInsertDraft={onInsertDraft} onClose={onClose} />
          </div>
        )}
      </div>
    </aside>
  );
}
