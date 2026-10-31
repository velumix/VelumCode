import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon, { VelumMark } from "./Icon";
import BotAvatar from "./BotAvatar";
import type { BotIdentity } from "../bots";
import { providerNames, type Provider, type RunOptions } from "../providers";
import { tokenRate, type UsageSnapshot } from "../usage";
import { extractToolSnippet, fmtToolDuration, friendlyTool, toolCategory } from "../conversationUX";
import { copyText } from "./clip";
import {
  describeFile,
  parseStatus,
  type ChangedFile,
} from "./gitStatus";
import { DiffLines, getDiffStats } from "./diffViewer";
import GitHubHub from "./GitHubHub";
import { taskBlockers, isOverdue, type Board, type Card, type Column } from "../kanban";
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
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<number>>(new Set());
  const [copiedToolId, setCopiedToolId] = useState<number | null>(null);
  const [toolSearch, setToolSearch] = useState("");
  const [toolCategoryFilter, setToolCategoryFilter] = useState<"all" | "shell" | "file" | "search" | "git" | "error">("all");
  const [copiedTelemetry, setCopiedTelemetry] = useState(false);

  const diffStats = useMemo(() => getDiffStats(fileDiff), [fileDiff]);

  const scrollToHunk = useCallback((targetIndex: number) => {
    const el = document.getElementById(`diff-hunk-${targetIndex}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveHunkIndex(targetIndex);
    }
  }, []);

  const goToPrevHunk = useCallback(() => {
    if (diffStats.hunkCount === 0) return;
    const current = activeHunkIndex ?? 0;
    const next = current <= 0 ? diffStats.hunkCount - 1 : current - 1;
    scrollToHunk(next);
  }, [activeHunkIndex, diffStats.hunkCount, scrollToHunk]);

  const goToNextHunk = useCallback(() => {
    if (diffStats.hunkCount === 0) return;
    const current = activeHunkIndex ?? -1;
    const next = current >= diffStats.hunkCount - 1 ? 0 : current + 1;
    scrollToHunk(next);
  }, [activeHunkIndex, diffStats.hunkCount, scrollToHunk]);

  // Telemetry computations
  const contextUsed = usage.context?.used_tokens ?? usage.turn?.input_tokens ?? 0;
  const contextCapacity = usage.context?.window_tokens;
  const contextPercent = contextCapacity && contextCapacity > 0 ? Math.min(100, Math.round((contextUsed / contextCapacity) * 100)) : null;
  const isContextWarning = contextPercent != null && contextPercent >= 80;

  const turnInput = usage.turn?.input_tokens;
  const turnCached = usage.turn?.cached_input_tokens;
  const cacheHitPercent = turnInput && turnCached && turnInput > 0 ? Math.round((turnCached / turnInput) * 100) : null;
  const turnOutput = usage.turn?.output_tokens;
  const turnReasoning = usage.turn?.reasoning_output_tokens;
  const reasoningPercent = turnOutput && turnReasoning && turnOutput > 0 ? Math.round((turnReasoning / turnOutput) * 100) : null;
  const turnSpeed = tokenRate(usage.turn);
  const [board, setBoard] = useState<Board | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [taskSectionFilter, setTaskSectionFilter] = useState<"all" | "plan" | "kanban">("all");
  const requestSeq = useRef(0);
  const diffRequestSeq = useRef(0);

  const loadBoard = useCallback(async () => {
    if (!workspace) {
      setBoard(null);
      return;
    }
    setLoadingBoard(true);
    try {
      const b = await invoke<Board>("kanban_request", { workspace, request: { action: "load" } });
      setBoard(b);
    } catch {
      setBoard(null);
    } finally {
      setLoadingBoard(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (activeTab === "tasks") {
      void loadBoard();
    }
  }, [activeTab, loadBoard]);

  const moveCard = useCallback(async (card: Card, column: Column) => {
    if (!workspace || !board || card.column === column) return;
    try {
      const nextBoard = await invoke<Board>("kanban_request", {
        workspace,
        request: { action: "move", revision: board.revision, id: card.id, column, before: null },
      });
      setBoard(nextBoard);
    } catch {}
  }, [workspace, board]);

  const sortedCards = useMemo(() => {
    if (!board?.cards) return [];
    const colOrder: Record<Column, number> = { progress: 0, review: 1, backlog: 2, done: 3 };
    const prioOrder = { high: 0, normal: 1, low: 2 };
    return [...board.cards].sort((a, b) => {
      const colDiff = (colOrder[a.column] ?? 4) - (colOrder[b.column] ?? 4);
      if (colDiff !== 0) return colDiff;
      return (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1);
    });
  }, [board?.cards]);

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

  const totalToolDurationMs = useMemo(() => {
    return toolActions.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  }, [toolActions]);

  const avgToolDurationMs = useMemo(() => {
    return toolActions.length > 0 ? Math.round(totalToolDurationMs / toolActions.length) : 0;
  }, [toolActions, totalToolDurationMs]);

  const slowestTool = useMemo(() => {
    if (toolActions.length === 0) return null;
    return toolActions.reduce((max, t) => ((t.durationMs || 0) > (max.durationMs || 0) ? t : max), toolActions[0]);
  }, [toolActions]);

  const successfulToolsCount = useMemo(() => {
    return toolActions.filter((t) => t.status === "completed").length;
  }, [toolActions]);

  const copyTelemetry = useCallback(async () => {
    const summary = {
      provider: providerNames[provider],
      model: options.model || "Default",
      reasoning: options.reasoning || "Standard",
      bot: bot?.name || "None",
      context: {
        used_tokens: contextUsed,
        capacity_tokens: contextCapacity,
        percent: contextPercent,
      },
      turn: {
        input_tokens: turnInput,
        cached_tokens: turnCached,
        output_tokens: turnOutput,
        reasoning_tokens: turnReasoning,
        velocity_tps: turnSpeed ? Number(turnSpeed.toFixed(1)) : null,
        elapsed_ms: usage.turn?.elapsed_ms,
      },
      tools: {
        total: toolActions.length,
        success_rate: toolActions.length > 0 ? `${Math.round((successfulToolsCount / toolActions.length) * 100)}%` : "100%",
        total_duration_ms: totalToolDurationMs,
        avg_duration_ms: avgToolDurationMs,
        counts: toolStats,
      },
    };
    await copyText(JSON.stringify(summary, null, 2));
    setCopiedTelemetry(true);
    setTimeout(() => setCopiedTelemetry(false), 1400);
  }, [provider, options.model, options.reasoning, bot?.name, contextUsed, contextCapacity, contextPercent, turnInput, turnCached, turnOutput, turnReasoning, turnSpeed, usage.turn?.elapsed_ms, toolActions.length, successfulToolsCount, totalToolDurationMs, avgToolDurationMs, toolStats]);

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
            <VelumMark size={28} status={running ? "working" : "idle"} />
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
          {(todos.length > 0 || (board && board.cards.length > 0)) && (
            <span className="sd-badge">
              {todos.length > 0 ? `${completedTodos.length}/${todos.length}` : board?.cards.length}
            </span>
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
                        <div className="sd-diff-viewer-title-group">
                          <span className="sd-diff-viewer-path">{selectedDiffFile}</span>
                          {diffStats.total > 0 && (
                            <div
                              className="sd-diff-stats-pill"
                              title={`${diffStats.additions} additions, ${diffStats.deletions} deletions across ${diffStats.hunkCount} hunks`}
                            >
                              <span className="sd-stat-add">+{diffStats.additions}</span>
                              <span className="sd-stat-del">-{diffStats.deletions}</span>
                            </div>
                          )}
                        </div>

                        <div className="sd-diff-head-actions">
                          {diffStats.hunkCount > 0 && (
                            <div className="sd-hunk-nav">
                              <button
                                type="button"
                                className="sd-diff-btn-icon"
                                title="Previous change hunk"
                                aria-label="Previous change hunk"
                                onClick={goToPrevHunk}
                              >
                                <Icon name="arrow" size={11} style={{ transform: "rotate(180deg)" }} />
                              </button>
                              <span className="sd-hunk-count" aria-live="polite">
                                {activeHunkIndex != null ? `${activeHunkIndex + 1}/${diffStats.hunkCount}` : `${diffStats.hunkCount}h`}
                              </span>
                              <button
                                type="button"
                                className="sd-diff-btn-icon"
                                title="Next change hunk"
                                aria-label="Next change hunk"
                                onClick={goToNextHunk}
                              >
                                <Icon name="arrow" size={11} />
                              </button>
                            </div>
                          )}

                          <div className="sd-diff-mode-toggle" role="radiogroup" aria-label="Diff display format">
                            <button
                              type="button"
                              role="radio"
                              aria-checked={diffMode === "unified"}
                              className={`sd-mode-btn${diffMode === "unified" ? " active" : ""}`}
                              onClick={() => setDiffMode("unified")}
                              title="Unified single-column diff"
                            >
                              Unified
                            </button>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={diffMode === "split"}
                              className={`sd-mode-btn${diffMode === "split" ? " active" : ""}`}
                              onClick={() => setDiffMode("split")}
                              title="Side-by-side split diff"
                            >
                              Split
                            </button>
                          </div>

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
                            <DiffLines text={fileDiff} query={diffSearch} mode={diffMode} />
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
            {/* Toolbar with Segmented Controls & Quick Action */}
            <div className="sd-tasks-toolbar">
              <div className="sd-tasks-filters" role="tablist" aria-label="Tasks view filter">
                <button
                  type="button"
                  role="tab"
                  aria-selected={taskSectionFilter === "all"}
                  className={`sd-tasks-filter-btn${taskSectionFilter === "all" ? " active" : ""}`}
                  onClick={() => setTaskSectionFilter("all")}
                >
                  All ({todos.length + (board?.cards?.length || 0)})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={taskSectionFilter === "plan"}
                  className={`sd-tasks-filter-btn${taskSectionFilter === "plan" ? " active" : ""}`}
                  onClick={() => setTaskSectionFilter("plan")}
                >
                  Plan Steps ({todos.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={taskSectionFilter === "kanban"}
                  className={`sd-tasks-filter-btn${taskSectionFilter === "kanban" ? " active" : ""}`}
                  onClick={() => setTaskSectionFilter("kanban")}
                >
                  Kanban Cards ({board?.cards?.length || 0})
                </button>
              </div>

              <div className="sd-tasks-actions">
                <button
                  type="button"
                  className="sd-open-kanban-btn"
                  title="Open full interactive Kanban board"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("velum:open-kanban", { detail: { workspace } }));
                  }}
                >
                  <Icon name="board" size={12} />
                  <span>Open Kanban</span>
                </button>
                <button
                  type="button"
                  className="sd-icon-btn"
                  title="Refresh tasks & board"
                  aria-label="Refresh tasks and board"
                  disabled={loadingBoard}
                  onClick={() => void loadBoard()}
                >
                  <Icon name="reset" size={13} />
                </button>
              </div>
            </div>

            {/* Section 1: Conversation Plan */}
            {(taskSectionFilter === "all" || taskSectionFilter === "plan") && (
              <div className="sd-plan-section">
                <div className="sd-section-header">
                  <strong>Conversation Plan Steps</strong>
                  {todos.length > 0 && (
                    <span className="sd-section-count">
                      {completedTodos.length} of {todos.length} done ({progressPercent}%)
                    </span>
                  )}
                </div>

                {todos.length > 0 && (
                  <div className="sd-progress-bar-track">
                    <div className="sd-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                )}

                {todos.length === 0 ? (
                  <div className="sd-section-empty">
                    <Icon name="check" size={15} />
                    <span>No active turn todos. When the bot plans steps, they stream here.</span>
                  </div>
                ) : (
                  <div className="sd-todos-list">
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
              </div>
            )}

            {/* Section 2: Workspace Kanban Cards */}
            {(taskSectionFilter === "all" || taskSectionFilter === "kanban") && (
              <div className="sd-kanban-section">
                <div className="sd-section-header">
                  <strong>Workspace Kanban Tasks</strong>
                  {board?.cards && (
                    <span className="sd-section-count">
                      {board.cards.length} {board.cards.length === 1 ? "task" : "tasks"}
                    </span>
                  )}
                </div>

                {loadingBoard && !board ? (
                  <div className="sd-section-empty">Loading Kanban cards…</div>
                ) : !board || sortedCards.length === 0 ? (
                  <div className="sd-section-empty">
                    <Icon name="board" size={16} />
                    <span>No cards on this workspace board yet. Click "Open Kanban" to add one.</span>
                  </div>
                ) : (
                  <div className="sd-kanban-cards-list">
                    {sortedCards.map((card) => {
                      const blockers = taskBlockers(card, board.cards);
                      const overdue = isOverdue(card);
                      return (
                        <div key={card.id} className={`sd-kanban-card col-${card.column}`}>
                          <div className="sd-kanban-card-top">
                            <div className="sd-kanban-badges">
                              <span className={`sd-kanban-col-pill col-${card.column}`}>
                                {card.column === "progress"
                                  ? "In Progress"
                                  : card.column === "review"
                                  ? "Review"
                                  : card.column === "done"
                                  ? "Done"
                                  : "Backlog"}
                              </span>
                              {card.priority && card.priority !== "normal" && (
                                <span className={`sd-kanban-prio-pill prio-${card.priority}`}>
                                  {card.priority.toUpperCase()}
                                </span>
                              )}
                              {overdue && <span className="sd-overdue-tag">Overdue</span>}
                              {blockers.length > 0 && (
                                <span className="sd-blocker-tag" title={`Blocked by: ${blockers.join(", ")}`}>
                                  Blocked
                                </span>
                              )}
                            </div>

                            {onInsertDraft && (
                              <button
                                type="button"
                                className="sd-kanban-work-btn"
                                title="Load this task into chat prompt composer"
                                onClick={() => {
                                  const prompt = `Let's work on this task from our Kanban board:\n\n**${card.title}**\n${card.description ? `${card.description}\n` : ""}\nReview current code, verify requirements, and begin implementation.`;
                                  onInsertDraft(prompt);
                                }}
                              >
                                <Icon name="chat" size={11} />
                                <span>Work on this</span>
                              </button>
                            )}
                          </div>

                          <div className="sd-kanban-card-title">{card.title}</div>
                          {card.description && (
                            <div className="sd-kanban-card-desc">{card.description}</div>
                          )}

                          <div className="sd-kanban-card-footer">
                            <span className="sd-kanban-move-label">Move:</span>
                            <div className="sd-kanban-move-actions">
                              {card.column !== "backlog" && (
                                <button
                                  type="button"
                                  className="sd-kanban-shift-btn"
                                  onClick={() => void moveCard(card, "backlog")}
                                  title="Move to Backlog"
                                >
                                  Backlog
                                </button>
                              )}
                              {card.column !== "progress" && (
                                <button
                                  type="button"
                                  className="sd-kanban-shift-btn"
                                  onClick={() => void moveCard(card, "progress")}
                                  title="Move to In Progress"
                                >
                                  In Progress
                                </button>
                              )}
                              {card.column !== "review" && (
                                <button
                                  type="button"
                                  className="sd-kanban-shift-btn"
                                  onClick={() => void moveCard(card, "review")}
                                  title="Move to Review"
                                >
                                  Review
                                </button>
                              )}
                              {card.column !== "done" && (
                                <button
                                  type="button"
                                  className="sd-kanban-shift-btn done"
                                  onClick={() => void moveCard(card, "done")}
                                  title="Mark as Done"
                                >
                                  ✓ Done
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Section 3: Active Memory & Guidance */}
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
            {/* Header with Export / Copy Diagnostics */}
            <div className="sd-telemetry-topbar">
              <div className="sd-telemetry-heading">
                <strong>Session Telemetry & Benchmarks</strong>
                <span>Real-time token usage, context fullness, and tool execution latencies</span>
              </div>
              <button
                type="button"
                className={`sd-action-chip sd-copy-btn${copiedTelemetry ? " copied" : ""}`}
                title="Copy structured telemetry JSON to clipboard"
                onClick={() => void copyTelemetry()}
              >
                <Icon name={copiedTelemetry ? "check" : "copy"} size={12} />
                <span>{copiedTelemetry ? "Copied JSON" : "Copy Diagnostics"}</span>
              </button>
            </div>

            {/* Context Window Capacity Gauge */}
            <div className={`sd-context-gauge-card${isContextWarning ? " warning" : ""}`}>
              <div className="sd-gauge-header">
                <div className="sd-gauge-title-row">
                  <Icon name="memory" size={14} />
                  <strong>Context Window Capacity</strong>
                </div>
                <span className="sd-gauge-stat">
                  {contextUsed.toLocaleString()}{contextCapacity ? ` / ${contextCapacity.toLocaleString()} tokens` : " tokens"}
                  {contextPercent != null ? ` (${contextPercent}%)` : ""}
                </span>
              </div>
              <div className="sd-gauge-track">
                <div
                  className={`sd-gauge-fill${isContextWarning ? " warning" : ""}`}
                  style={{ width: `${contextPercent ?? Math.min(100, Math.round((contextUsed / 128000) * 100))}%` }}
                />
              </div>
              <div className="sd-gauge-subtext">
                {contextCapacity ? (
                  isContextWarning ? (
                    <span className="sd-warning-text">⚠️ Context window is over 80% full. Consider summarizing or opening a new tab.</span>
                  ) : (
                    <span>Provider context headroom is healthy.</span>
                  )
                ) : (
                  <span>Measured token usage for current session.</span>
                )}
              </div>
            </div>

            {/* Token Generation Grid */}
            <div className="sd-telemetry-grid">
              <div className="sd-metric-card">
                <span className="sd-metric-label">Prompt Input</span>
                <span className="sd-metric-value">
                  {turnInput != null ? turnInput.toLocaleString() : "—"}
                </span>
                <span className="sd-metric-sub">
                  {turnCached ? `${turnCached.toLocaleString()} cached (${cacheHitPercent}%)` : "No cache hits"}
                </span>
              </div>

              <div className="sd-metric-card">
                <span className="sd-metric-label">Output Generated</span>
                <span className="sd-metric-value">
                  {turnOutput != null ? turnOutput.toLocaleString() : "—"}
                </span>
                <span className="sd-metric-sub">
                  {turnSpeed ? `${turnSpeed.toFixed(1)} tokens/sec` : "Generation velocity"}
                </span>
              </div>

              <div className="sd-metric-card">
                <span className="sd-metric-label">Reasoning / Thinking</span>
                <span className="sd-metric-value">
                  {turnReasoning != null ? turnReasoning.toLocaleString() : "—"}
                </span>
                <span className="sd-metric-sub">
                  {reasoningPercent != null ? `${reasoningPercent}% of generated tokens` : "Chain-of-thought tokens"}
                </span>
              </div>

              <div className="sd-metric-card">
                <span className="sd-metric-label">Turn Duration</span>
                <span className="sd-metric-value">
                  {usage.turn?.elapsed_ms != null ? fmtToolDuration(usage.turn.elapsed_ms) : "—"}
                </span>
                <span className="sd-metric-sub">
                  Total turn round-trip
                </span>
              </div>
            </div>

            {/* Tool Execution Telemetry */}
            <div className="sd-tool-telemetry-card">
              <div className="sd-card-title-row">
                <Icon name="terminal" size={14} />
                <strong>Tool Execution Telemetry</strong>
                <span className="sd-telemetry-pill">
                  {toolActions.length} total {toolActions.length === 1 ? "call" : "calls"}
                </span>
              </div>

              <div className="sd-tool-telemetry-stats">
                <div className="sd-stat-box">
                  <span className="sd-stat-num">{fmtToolDuration(totalToolDurationMs)}</span>
                  <span className="sd-stat-desc">Total Tool Time</span>
                </div>
                <div className="sd-stat-box">
                  <span className="sd-stat-num">{fmtToolDuration(avgToolDurationMs)}</span>
                  <span className="sd-stat-desc">Average Latency</span>
                </div>
                <div className="sd-stat-box">
                  <span className="sd-stat-num">
                    {toolActions.length > 0 ? `${Math.round((successfulToolsCount / toolActions.length) * 100)}%` : "100%"}
                  </span>
                  <span className="sd-stat-desc">Success Rate</span>
                </div>
              </div>

              <div className="sd-category-breakdown-row">
                <span className="sd-cat-chip cat-shell">Commands: {toolStats.cmdCount}</span>
                <span className="sd-cat-chip cat-file">Files: {toolStats.fileCount}</span>
                <span className="sd-cat-chip cat-search">Search: {toolStats.searchCount}</span>
                <span className="sd-cat-chip cat-git">Git: {toolStats.gitCount}</span>
                {toolStats.errorCount > 0 && (
                  <span className="sd-cat-chip cat-err">Errors: {toolStats.errorCount}</span>
                )}
              </div>

              {slowestTool && (
                <div className="sd-slowest-row">
                  <span className="sd-slowest-label">Slowest Operation:</span>
                  <code className="sd-slowest-chip" title={slowestTool.detail || slowestTool.name}>
                    {slowestTool.detail || friendlyTool(slowestTool.name)}
                  </code>
                  <span className="sd-slowest-time">({fmtToolDuration(slowestTool.durationMs || 0)})</span>
                </div>
              )}
            </div>

            {/* Environment & Persona Specs */}
            <div className="sd-env-specs-card">
              <div className="sd-card-title-row">
                <Icon name="settings" size={14} />
                <strong>Environment & Persona</strong>
              </div>
              <div className="sd-env-grid">
                <div>
                  <span className="sd-env-label">Provider</span>
                  <span className="sd-env-val">{providerNames[provider]}</span>
                </div>
                <div>
                  <span className="sd-env-label">Model</span>
                  <span className="sd-env-val">{options.model || "Default"}</span>
                </div>
                <div>
                  <span className="sd-env-label">Reasoning</span>
                  <span className="sd-env-val">{options.reasoning || "Standard"}</span>
                </div>
                <div>
                  <span className="sd-env-label">Active Bot</span>
                  <span className="sd-env-val">{bot ? bot.name : "Default Assistant"}</span>
                </div>
              </div>
            </div>
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
