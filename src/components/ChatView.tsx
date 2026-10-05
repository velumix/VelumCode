import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Markdown from "./Markdown";
import { providerNames, type Provider, type RunOptions } from "../providers";
import { copyText } from "./clip";
import Icon, { VelumMark, type IconName } from "./Icon";
import type { PluginChatHandle } from "../plugins";
import { readDraft, saveDraft } from "../desktopHistory";
import { usePreferences } from "../preferences";
import type { BotIdentity } from '../bots';
import BotAvatar from './BotAvatar';
import UsageStrip from './UsageStrip';
import MessageQueue from './MessageQueue';
import AgentActivity from './AgentActivity';
import CorrectionComposer from './CorrectionComposer';
import RequestRecovery from './RequestRecovery';
import InteractionPanel, { PermissionRecord } from './InteractionPanel';
import { emptyInteractions, mergeInteractionResponse, type InteractionSnapshot } from '../interactions';
import { correctionPrompt, filterSlashCommands, friendlyTool, groupActivity, lastMatch, latestRecovery, lessonTitle, projectName, recoverableRequest, type RecoverableRequest, type SlashCommand } from '../conversationUX';
import type { MemoryView } from '../memory';
import { emptyQueue, type MessageQueue as Queue } from '../messageQueue';
import ProviderWait from './ProviderWait';
import { progressMessage, type ProviderProgress } from '../providerProgress';
import { mergeUsage, type UsageSnapshot } from '../usage';
import { ClientMeasurement, type HostMeasurement } from '../turnMeasurement';
import { attachment, chatSnapshot, type AccessCheck, type Diagnostics } from '../context';
import SessionDashboard from './SessionDashboard';
import { parseStatus } from './gitStatus';
const ContextPanel = lazy(() => import('./ContextPanel'));

export type AgentStatus = (
  | { kind: "starting" }
  | { kind: "idle" }
  | { kind: "running"; detail?: string }
  | { kind: "done" }
  | { kind: "error"; message: string }) & { queued?: number; queuePaused?: boolean };

type Block =
  | { id: number; kind: "user"; text: string; notSent?: boolean }
  | { id: number; kind: "assistant"; text: string; open: boolean }
  | {
      id: number;
      kind: "tool";
      taskId: string;
      name: string;
      status: string;
      policy?: string;
      output: string;
      result?: string;
      reason?: string;
    }
  | { id: number; kind: "notice"; text: string; tone: "info" | "error"; recovery?: RecoverableRequest }
  | { id: number; kind: "approval"; tool?: string; summary: string; status: string };

interface TodoEntry {
  text: string;
  status: string;
}

interface AgentEventEnvelope {
  id: string;
  seq?: number;
  event: { kind: string; [key: string]: unknown };
}

interface NewInfo {
  live?: { revision: number; running: boolean; yolo: boolean; terminal: boolean; queue: Queue } | null;
  id: string;
  session_id: string;
  workspace: string;
  workspace_notice?: string | null;
  restored?: AgentEventEnvelope["event"][];
  truncated?: boolean;
}

interface ChatViewProps {
  terminalOwnsConversation?: boolean;
  onContinueInTerminal?: () => void;
  onCloseContinuedTerminal?: () => Promise<void>;
  botId?: string;
  taskId?: string;
  onPluginHandle: (id: string, handle: PluginChatHandle | null) => void;
  onRemember: (text:string)=>void;
  initialWorkspace?: string;
  provider: Provider;
  options: RunOptions;
  sessionId: string;
  active: boolean;
  /** Bump to drop the conversation and start a fresh agent session. */
  sessionKey: number;
  onStatus: (sessionId: string, status: AgentStatus) => void;
  onWorkspace: (sessionId: string, workspace: string) => void;
  onTitle: (sessionId: string, title: string) => void;
}

const PREVIEW_LINES = 6;
const RENDER_CAP = 4000;

function isPlainAllow(decision: string): boolean {
  return decision === "not_applicable" || decision.startsWith("allow:");
}

function statusTone(status: string): "ok" | "bad" | "busy" {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "blocked" || status === "rejected" || status === "cancelled") return "bad";
  return "busy";
}

function preview(text: string): { head: string; rest: number } {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES) return { head: text, rest: 0 };
  return { head: lines.slice(0, PREVIEW_LINES).join("\n"), rest: lines.length - PREVIEW_LINES };
}

function capped(text: string): string {
  return text.length > RENDER_CAP ? `${text.slice(0, RENDER_CAP)}\n…[${text.length - RENDER_CAP} more chars]` : text;
}

function boundedOutput(text: string): string {
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…[truncated]` : text;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function turnTouchedFiles(blocks: Block[], assistantId: number): string[] {
  const idx = blocks.findIndex((b) => b.id === assistantId);
  if (idx === -1) return [];
  let startIdx = idx - 1;
  while (startIdx >= 0 && blocks[startIdx]?.kind !== "user") {
    startIdx--;
  }
  const files = new Set<string>();
  for (let i = Math.max(0, startIdx); i < idx; i++) {
    const b = blocks[i];
    if (b && b.kind === "tool") {
      const toolText = `${b.name} ${b.output} ${b.result || ""}`;
      const matches = toolText.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g);
      if (matches) {
        for (const m of matches) {
          if (!m.includes("http") && !m.endsWith(".jsonl") && (m.includes("/") || m.includes("\\") || m.includes("."))) {
            files.add(m.trim());
          }
        }
      }
    }
  }
  return Array.from(files).slice(0, 4);
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function YoloIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

const STARTERS: { label: string; description: string; icon: IconName; prompt: string }[] = [
  {
    label: "Build something",
    description: "Turn an idea into a first version",
    icon: "plus",
    prompt: "Help me build a new feature. Here's the idea: ",
  },
  {
    label: "Improve what's here",
    description: "Fix a bug or refine an experience",
    icon: "edit",
    prompt: "I'd like to improve this project. Here's what should change: ",
  },
  {
    label: "Understand a project",
    description: "Find a clear starting point",
    icon: "folder",
    prompt: "Help me understand this project. Map the main pieces and suggest a good place to start.",
  },
];

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`msg-copy${copied ? " copied" : ""}`}
      aria-label={copied ? "Message copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
      {copied && <span className="copy-feedback" role="status">Copied</span>}
    </button>
  );
}

function ToolBlock({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const { settings } = usePreferences();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? settings.toolOutput === "expanded";
  const tone = statusTone(block.status);
  const body = [block.output, block.result].filter((s) => s && s.length > 0).join("\n");
  const { head, rest } = preview(body || (block.status === "running" ? "…" : ""));
  return (
    <div className={`tool-card ${tone}`}>
      <button type="button" className="tool-head" onClick={() => setOverride(!open)} aria-expanded={open}>
        <span className={`tool-dot ${tone}`} aria-hidden="true" />
        <span className="tool-name" title={block.name}>
          {friendlyTool(block.name)}
        </span>
        <span className="tool-status">{block.status}</span>
        <span className="tool-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {block.policy && !isPlainAllow(block.policy) && <div className="tool-policy">policy: {block.policy}</div>}
      {block.reason && <div className="tool-reason">{block.reason}</div>}
      {body && (open || settings.toolOutput !== "collapsed") ? (
        open ? (
          <pre className="tool-output full">{capped(body)}</pre>
        ) : (
          <pre className="tool-output">
            {capped(head)}
            {rest > 0 && <span className="tool-more">{`\n…${rest} more lines`}</span>}
          </pre>
        )
      ) : null}
    </div>
  );
}

export default function ChatView({ provider, options, initialWorkspace, sessionId, active, sessionKey, onStatus, onWorkspace, onTitle, onRemember, onPluginHandle, botId, taskId, terminalOwnsConversation: terminalFromParent = false, onContinueInTerminal, onCloseContinuedTerminal }: ChatViewProps) {
  const [attachedTerminal, setAttachedTerminal] = useState(false);
  const terminalOwnsConversation = terminalFromParent || attachedTerminal;
  const { settings } = usePreferences();
  const [bot,setBot]=useState<BotIdentity|null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<string | null>(null);
  const optionsRef = useRef(options); optionsRef.current = options;
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [todos, setTodos] = useState<TodoEntry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState<Queue>(emptyQueue);
  const queueRef = useRef(queue); queueRef.current = queue;
  const lastStatusRef = useRef<AgentStatus>({ kind: 'starting' });
  const [turnEpoch, setTurnEpoch] = useState(0);
  const [ready, setReady] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [activity, setActivity] = useState("");
  const [providerProgress, setProviderProgress] = useState<ProviderProgress | null>(null);
  const [yolo, setYolo] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const yoloRef = useRef(yolo); yoloRef.current = yolo;
  // Workspace bound to this tab's session at creation; null selects the
  // backend default (home). Changing it restarts the session via the effect
  // below, so a session never straddles two directories.
  const [workspace, setWorkspace] = useState<string | null>(initialWorkspace || null);
  const [draft, setDraft] = useState("");
  const workspaceDraftRevision = useRef(0);
  const [effective, setEffective] = useState("");
  // Bump to retry session creation with the same workspace (e.g. the
  // directory was fixed externally after a failed Apply).
  const [retry, setRetry] = useState(0);
  // Prompt-history cursor; null means the composer holds a fresh draft.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [applying, setApplying] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [memoryUsage,setMemoryUsage]=useState<{titles:string[];bytes:number}|null>(null);
  const [usage, setUsage] = useState<UsageSnapshot>({});
  const [interactions, setInteractions] = useState<InteractionSnapshot>(emptyInteractions);
  const refreshInteractions = useRef<() => Promise<void>>(async () => {});
  const [draftError, setDraftError] = useState(false);
  const [correction, setCorrection] = useState<{id:number;answer:string}|null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [chatMode, setChatMode] = useState<"stream" | "split" | "dashboard">(() => {
    try {
      const saved = localStorage.getItem("velum:chat-mode");
      if (saved === "stream" || saved === "split" || saved === "dashboard") return saved;
    } catch {}
    return "stream";
  });
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [gitChangedCount, setGitChangedCount] = useState(0);

  useEffect(() => {
    if (!effective) {
      setGitChangedCount(0);
      return;
    }
    let mounted = true;
    void invoke<{ status: string }>("git_state", { workspace: effective })
      .then((state) => {
        if (mounted && state?.status) {
          const parsed = parseStatus(state.status);
          setGitChangedCount(parsed.files.length);
        }
      })
      .catch(() => {
        if (mounted) setGitChangedCount(0);
      });
    return () => {
      mounted = false;
    };
  }, [effective, running, blocks.length]);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashMatches = useMemo(() => {
    if (!input.startsWith("/") || input.includes("\n")) return [];
    return filterSlashCommands(input);
  }, [input]);

  const applySlashCommand = useCallback((cmd: SlashCommand) => {
    setSlashOpen(false);
    if (cmd.command === "/clear") {
      setInput("");
      inputRef.current = "";
      setBlocks([]);
      setTodos([]);
      composerRef.current?.focus();
      return;
    }
    setInput(cmd.prompt);
    inputRef.current = cmd.prompt;
    composerRef.current?.focus();
  }, []);

  useEffect(() => {
    const onInsertDraft = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (!text) return;
      const next = inputRef.current ? `${inputRef.current}\n\n${text}` : text;
      if (next.length > 64000) return;
      inputRef.current = next;
      setInput(next);
      composerRef.current?.focus();
    };
    window.addEventListener("velum:insert-draft", onInsertDraft);
    return () => window.removeEventListener("velum:insert-draft", onInsertDraft);
  }, []);

  const workspaceEditorId = useId();
  const identityRef = useRef({ workspace, sessionKey });
  useEffect(() => {
    if (!ready) return;
    try { saveDraft(sessionId, input); setDraftError(false); } catch { setDraftError(true); }
  }, [input, ready, sessionId]);

  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const runningRef = useRef(false);
  runningRef.current = running;
  // Latest teardown promise; the next mount awaits it so a restart's
  // destroy always lands before its replacement agent_new.
  const destroyRef = useRef<Promise<unknown>>(Promise.resolve());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<string[]>([]);
  const draftRef = useRef("");
  const turnStartRef = useRef(0);
  const clientMeasurementRef = useRef(new ClientMeasurement());
  const nativeIdRef = useRef<string | null>(null);
  const assistantSeenRef = useRef(false);
  const turnPromptRef = useRef('');
  const optimisticPromptRef = useRef<{ prompt: string; blockId: number } | null>(null);
  const applyingRef = useRef(false);
  const titleAssignedRef = useRef(false);
  const blocksRef = useRef(blocks); blocksRef.current = blocks;
  const inputRef = useRef(input); inputRef.current = input;
  useEffect(() => {
    onPluginHandle(sessionId, {
      messages: () => blocksRef.current.filter(b => (b.kind === "user" && !b.notSent) || b.kind === "assistant").map(b => ({ role: b.kind, text: "text" in b ? b.text : "" })),
      insert: text => {
        const next = inputRef.current ? `${inputRef.current}\n\n${text}` : text;
        if (next.length > 64000) throw new Error("The result would exceed your draft’s 64,000-character limit. Shorten the draft first.");
        setInput(next);
      },
    });
    return () => onPluginHandle(sessionId, null);
  }, [sessionId, onPluginHandle]);

  const setStatus = useCallback(
    (s: AgentStatus) => {
      lastStatusRef.current = s;
      statusRef.current(sessionId, { ...s, queued: queueRef.current.items.length, queuePaused: queueRef.current.paused } as AgentStatus);
    },
    [sessionId],
  );

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let closed = false;
    void listen<{tab_id:string;yolo:boolean}>('agent-permissions', event => {
      if (event.payload.tab_id === sessionId) setYolo(event.payload.yolo);
    }).then(stop => { if (closed) stop(); else dispose = stop; });
    return () => { closed = true; dispose?.(); };
  }, [sessionId]);

  useEffect(() => {
    setInteractions(emptyInteractions());
    if (!ready) return;
    let closed = false;
    let version = 0;
    let dispose: (() => void) | undefined;
    const nativeId = nativeIdRef.current;
    if (!nativeId) return;
    const refresh = async () => {
      const before = version;
      const snapshot = await invoke<InteractionSnapshot>('agent_interactions', { id: nativeId });
      if (!closed && nativeId === nativeIdRef.current && before === version) setInteractions(snapshot);
    };
    refreshInteractions.current = refresh;
    void listen<{ id: string; snapshot: InteractionSnapshot }>('agent-interactions', event => {
      if (closed || event.payload.id !== nativeId) return;
      version++;
      const next = event.payload.snapshot;
      setInteractions(previous => previous.generation === next.generation ? mergeInteractionResponse(previous, next) : next);
    }).then(async stop => {
      if (closed) { stop(); return; }
      dispose = stop;
      await refresh();
    }).catch(() => {});
    return () => { closed = true; dispose?.(); refreshInteractions.current = async () => {}; };
  }, [ready, sessionId, sessionKey, workspace, retry, provider]);

  useEffect(() => {
    if (runningRef.current) setStatus({kind:'running', detail:interactions.active && interactions.requests.some(request => ['pending','submitting'].includes(request.status)) ? 'Waiting for your response…' : 'Working…'});
  }, [interactions, setStatus]);

  // Mount: subscribe, then register the agent session. Unmount: stop the
  // turn (via destroy) and drop the subscription.
  useEffect(() => {
    let disposed = false;
    const draftRevision = workspaceDraftRevision.current;
    setInitializing(true);
    let unlisten: (() => void) | undefined;
    // Fresh sessions get a new identity. On reload agent_new can return the
    // existing live owner, whose numbered events are reconciled below.
    let nativeId = `${sessionId}-agent-${crypto.randomUUID()}`;
    let hydrating = true;
    const buffered: AgentEventEnvelope[] = [];
    const explicitRestart = identityRef.current.sessionKey !== sessionKey;
    const restarting = identityRef.current.workspace !== workspace || explicitRestart;
    identityRef.current = { workspace, sessionKey };
    let replaying = false;
    nativeIdRef.current = null;
    idRef.current = 0;
    setBlocks([]);
    setCorrection(null);
    setTodos([]);
    // Choosing a usable project is a recovery step; keep the unsent prompt.
    setInput(explicitRestart ? "" : readDraft(sessionId));
    setRunning(false);
    queueRef.current = emptyQueue();
    setQueue(queueRef.current);
    runningRef.current = false;
    assistantSeenRef.current = false;
    turnPromptRef.current = '';
    optimisticPromptRef.current = null;
    historyRef.current = [];
    setHistIdx(null);
    stickRef.current = true;
    setShowLatest(false);
    setMemoryUsage(null);
    setUsage({});
    clientMeasurementRef.current.reset();
    titleAssignedRef.current = false;
    setActivity("");
    setProviderProgress(null);
    setReady(false);
    setStatus({ kind: "starting" });

    const applyEvent = (envelope: AgentEventEnvelope) => {
      if (disposed || envelope.id !== nativeId) return;
      const e = envelope.event;
      switch (e.kind) {
        case 'queue_state': {
          const next = e.queue as unknown as Queue;
          queueRef.current = next; setQueue(next);
          if (typeof e.running === 'boolean') {
            runningRef.current = e.running; setRunning(e.running);
          }
          const previous = lastStatusRef.current;
          setStatus(e.running ? { kind: 'running', detail: previous.kind === 'running' ? previous.detail : undefined }
            : previous.kind === 'error' || previous.kind === 'done' ? previous : { kind: 'idle' });
          break;
        }
        case "turn_metrics": clientMeasurementRef.current.observe(e.measurement as unknown as HostMeasurement); break;
        case "usage": setUsage(previous => mergeUsage(previous, e)); break;
        case "usage_reset": clientMeasurementRef.current.reset(); setUsage({}); setMemoryUsage(null); setProviderProgress(null); break;
        case "memory_context": setMemoryUsage({titles:Array.isArray(e.titles)?e.titles as string[]:[],bytes:typeof e.bytes==="number"?e.bytes:0}); break;
        case "turn_start": {
          clientMeasurementRef.current.start(replaying);
          turnStartRef.current = performance.now();
          setTurnEpoch(previous => previous + 1);
          setProviderProgress(null);
          setUsage(previous => ({ ...previous, turn: null }));
          setMemoryUsage(null);
          const prompt = asString(e.prompt) ?? "";
          turnPromptRef.current = prompt;
          if (!e.remote && !e.queued && !replaying && optimisticPromptRef.current?.prompt === prompt) {
            optimisticPromptRef.current = null;
            break;
          }
          assistantSeenRef.current = false;
          runningRef.current = true;
          turnStartRef.current = performance.now();
          setTurnEpoch(previous => previous + 1);
          setRunning(true);
          const detail = e.queued ? 'Starting queued message' : e.remote ? 'Sent from your phone' : 'Starting response';
          setActivity(detail);
          setStatus({ kind: "running", detail });
          if (!titleAssignedRef.current) {
            titleAssignedRef.current = true;
            onTitle(sessionId, prompt.replace(/\s+/g, " ").slice(0, 48));
          }
          historyRef.current = [...historyRef.current.slice(-49), prompt];
          setBlocks((prev) => [...prev, { id: ++idRef.current, kind: "user", text: prompt }]);
          break;
        }
        case "user_message":
          // Local echo already shows the sent prompt; the stream copy would duplicate it.
          break;
        case "assistant_delta": {
          const text = asString(e.text) ?? "";
          if (!text) break;
          if (runningRef.current) {
            setProviderProgress(null);
            setActivity('Responding…');
            setStatus({ kind: 'running', detail: 'Responding…' });
          }
          assistantSeenRef.current = true;
          setBlocks((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.kind === "assistant" && last.open) {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { id: ++idRef.current, kind: "assistant", text, open: true }];
          });
          break;
        }
        case "turn_end": {
          if (!replaying) clientMeasurementRef.current.finish();
          setProviderProgress(null);
          const status = asString(e.status) ?? "completed";
          const reason = asString(e.reason);
          const finalText = asString(e.text);
          const needsFinal = !assistantSeenRef.current && !!finalText;
          const recovery = recoverableRequest(status, turnPromptRef.current);
          setBlocks((prev) => {
            const next: Block[] = prev.map((b) => b.kind === "assistant" ? { ...b, open: false }
              : b.kind === "tool" && b.status === "running" ? { ...b, status } : b);
            if (needsFinal) next.push({ id: ++idRef.current, kind: "assistant", text: finalText!, open: false });
            if (status === "failed" || status === "blocked" || status === "cancelled") {
              return [
                ...next,
                {
                  id: ++idRef.current,
                  kind: "notice",
                  text: status === "cancelled" ? `Stopped.${reason ? ` ${reason}` : ""}` : reason || "The turn failed without an error description. Try again or check the terminal.",
                  tone: status === "cancelled" ? ("info" as const) : ("error" as const),
                  recovery,
                },
              ];
            }
            return next;
          });
          setRunning(false);
          runningRef.current = false;
          setActivity("");
          setStatus(status === "completed" ? { kind: "done" } : status === "failed" || status === "blocked"
            ? { kind: "error", message: reason || "Turn failed" } : { kind: "idle" });
          break;
        }
        case "tool_start": {
          const taskId = asString(e.task_id);
          const name = asString(e.name) ?? "tool";
          if (!taskId) break;
          if (runningRef.current) {
            setProviderProgress(null);
            setActivity(`Running ${name}…`);
            setStatus({ kind: 'running', detail: `Running ${name}…` });
          }
          setBlocks((prev) => {
            if (prev.some((b) => b.kind === "tool" && b.taskId === taskId)) return prev;
            return [
              ...prev,
              { id: ++idRef.current, kind: "tool", taskId, name, status: "running", output: "" },
            ];
          });
          break;
        }
        case "tool_policy": {
          const taskId = asString(e.task_id);
          const decision = asString(e.decision) ?? "";
          if (!taskId || !decision) break;
          setBlocks((prev) =>
            prev.map((b) => (b.kind === "tool" && b.taskId === taskId ? { ...b, policy: decision } : b)),
          );
          break;
        }
        case "tool_delta": {
          const taskId = asString(e.task_id);
          const text = asString(e.text) ?? "";
          if (!taskId || !text) break;
          setBlocks((prev) =>
            prev.map((b) => (b.kind === "tool" && b.taskId === taskId ? { ...b, output: boundedOutput(b.output + text) } : b)),
          );
          break;
        }
        case "tool_end": {
          const taskId = asString(e.task_id);
          const status = asString(e.status) ?? "completed";
          const reason = asString(e.reason);
          if (!taskId) break;
          setBlocks((prev) =>
            prev.map((b) =>
              b.kind === "tool" && b.taskId === taskId ? { ...b, status, reason } : b,
            ),
          );
          break;
        }
        case "tool_result": {
          const text = asString(e.text) ?? "";
          if (!text) break;
          const taskId = asString(e.task_id);
          setBlocks((prev) => {
            if (taskId && prev.some((b) => b.kind === "tool" && b.taskId === taskId)) {
              return prev.map((b) =>
                b.kind === "tool" && b.taskId === taskId
                  ? { ...b, result: boundedOutput(b.result ? `${b.result}\n${text}` : text) }
                  : b,
              );
            }
            const name = asString(e.call_id) ?? "tool";
            return [
              ...prev,
              {
                id: ++idRef.current,
                kind: "tool",
                taskId: taskId ?? `detached-${idRef.current}`,
                name,
                status: "completed",
                output: "",
                result: text,
              },
            ];
          });
          break;
        }
        case "bot_identity": { setBot(e.bot as unknown as BotIdentity); break; }
        case "todos": {
          const items = Array.isArray(e.items) ? (e.items as TodoEntry[]) : [];
          setTodos(items.filter((t) => t && typeof t.text === "string"));
          break;
        }
        case "approval": {
          const summary = asString(e.summary) ?? "approval requested";
          const tool = asString(e.tool);
          const status = asString(e.status) ?? "requested";
          setBlocks((prev) => [...prev, { id: ++idRef.current, kind: "approval", tool, summary, status }]);
          break;
        }
        case "notice": {
          const text = asString(e.text) ?? "";
          if (text) {
            setBlocks((prev) => [...prev, { id: ++idRef.current, kind: "notice", text, tone: "info" }]);
          }
          break;
        }
        case "provider_progress": {
          if (!runningRef.current) break;
          const progress = e.progress as unknown as ProviderProgress;
          setProviderProgress(progress);
          setActivity(progressMessage(progress, provider));
          setStatus({ kind: "running", detail: progressMessage(progress, provider) });
          break;
        }
        case "activity": {
          // Fleeting progress detail for the running indicator. Guarded by
          // the live running flag so a late duplicate can never flip an
          // idle tab back to running.
          if (!runningRef.current) break;
          const text = asString(e.text) ?? "";
          if (!text) break;
          setActivity(text);
          setStatus({ kind: "running", detail: text });
          break;
        }
        default:
          break;
      }
    };

    const setup = (async () => {
      try {
        await destroyRef.current;
        if (disposed) return;
        unlisten = await listen<AgentEventEnvelope>("agent-event", (e) => {
          if (hydrating) { buffered.push(e.payload); if (buffered.length > 8000) buffered.shift(); }
          else applyEvent(e.payload);
        });
        // The listener above filters by session id; register after attaching
        // so no event from our own session can slip past.
        if (disposed) return;
        const info = await invoke<NewInfo>("agent_new", { id: nativeId, workspace, tabId: sessionId, provider, options: optionsRef.current, resume: !restarting, botId:botId||null,taskId:taskId||null });
        nativeId = info.id || nativeId;
        if (!disposed) {
          replaying = true;
          if (info.truncated) applyEvent({ id: nativeId, event: { kind: "notice", text: "Earlier display history was trimmed to keep recovery fast. The provider’s saved conversation is still used when continuing." } });
          for (const event of info.restored || []) applyEvent({ id: nativeId, event });
          if (info.live) applyEvent({id:nativeId,event:{kind:'queue_state',queue:info.live.queue,running:info.live.running}});
          replaying = false;
          hydrating = false;
          for (const envelope of buffered) if (!info.live || (envelope.seq ?? Infinity) > info.live.revision) applyEvent(envelope);
          buffered.length = 0;
          nativeIdRef.current = nativeId;
          setAttachedTerminal(!!info.live?.terminal);
          if (info.live) { yoloRef.current = info.live.yolo; setYolo(info.live.yolo); }
          else await invoke('agent_set_permissions', {id:nativeId,yolo:yoloRef.current});
          if (disposed) return;
          setEffective(info.workspace);
          setWorkspaceNotice(info.workspace_notice || null);
          // A late registration must not replace a path the user just typed
          // or selected while the provider was starting.
          if (workspaceDraftRevision.current === draftRevision) setDraft(info.workspace);
          setReady(true);
          // Replay already established the last turn's outcome. Keep failed
          // and completed states visible when reopening a conversation.
          if (lastStatusRef.current.kind === 'starting') setStatus({ kind: "idle" });
          onWorkspace(sessionId, info.workspace);
        }
      } catch (err) {
        if (!disposed) {
          const message = err instanceof Error ? err.message : String(err);
          setStatus({ kind: "error", message });
          setBlocks((prev) => [...prev, { id: ++idRef.current, kind: "notice", text: message, tone: "error" }]);
        }
      } finally {
        if (!disposed) setInitializing(false);
      }
    })();

    return () => {
      disposed = true;
      nativeIdRef.current = null;
      unlisten?.();
      destroyRef.current = setup.then(async () => {
        unlisten?.();
        await invoke("agent_destroy", { id: nativeId });
      }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionKey, workspace, retry, provider,botId,taskId]);

  // Focus requests from App (palette / Ctrl+L), targeted by session id.
  useEffect(() => {
    if (!active || !ready) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, ready]);

  useEffect(() => {
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== sessionId) return;
      composerRef.current?.focus();
    };
    window.addEventListener("muse:focus-composer", onFocus);
    return () => window.removeEventListener("muse:focus-composer", onFocus);
  }, [sessionId]);

  // Live turn timer for the running indicator.
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const t0 = turnStartRef.current || performance.now();
    const t = window.setInterval(() => setElapsed(Math.max(0, Math.round(performance.now() - t0))), 500);
    return () => window.clearInterval(t);
  }, [running, turnEpoch]);

  // Let a multiline draft grow without crowding out the transcript. CSS caps
  // its height for the available window; hidden tabs are sized when activated.
  useLayoutEffect(() => {
    if (!active) return;
    const resize = () => {
      const el = composerRef.current;
      if (!el) return;
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
      if (stickRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [input, active, settings.chatFontSize, settings.chatFont, settings.uiFont, settings.codeFont, settings.chatWidth, settings.gutter, settings.sidebarWidth, settings.sidebarMode]);

  // Follow new output only when the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (active && el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowLatest(false);
    }
  }, [blocks, todos, interactions, active, running]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowLatest(!stickRef.current);
  }, [active]);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowLatest(false);
  }, []);

  const sendText = useCallback(
    (text: string, preserveDraft = false) => {
      const prompt = text.trim();
      const nativeId = nativeIdRef.current;
      if (!prompt || !ready || !nativeId || applyingRef.current) return Promise.resolve(false);
      if (terminalOwnsConversation) return Promise.resolve(false);
      if (runningRef.current || queueRef.current.items.length || queueRef.current.paused) {
        if (!preserveDraft) { inputRef.current = ''; setInput(''); setHistIdx(null); }
        return invoke('agent_send', { id: nativeId, prompt, yolo }).then(()=>nativeIdRef.current === nativeId).catch((error: unknown) => {
          if (nativeIdRef.current !== nativeId) return false;
          if (!preserveDraft) setInput(draft => draft || prompt);
          setBlocks(previous => [...previous, { id: ++idRef.current, kind: 'user', text: prompt, notSent: true },
            { id: ++idRef.current, kind: 'notice', text: `Could not queue: ${String(error)}`, tone: 'error', recovery: recoverableRequest('not_sent', prompt) }]);
          return false;
        });
      }
      stickRef.current = true;
      setShowLatest(false);
      runningRef.current = true;
      assistantSeenRef.current = false;
      turnPromptRef.current = prompt;
      if (!titleAssignedRef.current) {
        onTitle(sessionId, prompt.replace(/\s+/g, " ").slice(0, 48));
        titleAssignedRef.current = true;
      }
      if (!preserveDraft) { setInput(""); inputRef.current = ''; }
      setUsage(previous => ({ ...previous, turn: null }));
      setMemoryUsage(null);
      setHistIdx(null);
      historyRef.current = [...historyRef.current.slice(-49), prompt];
      turnStartRef.current = performance.now();
      setTurnEpoch(previous => previous + 1);
      const userId = ++idRef.current;
      optimisticPromptRef.current = { prompt, blockId: userId };
      setBlocks((prev) => [...prev, { id: userId, kind: "user", text: prompt }]);
      setRunning(true);
      setActivity("");
      setStatus({ kind: "running" });
      return invoke<{ queued?: boolean }>("agent_send", { id: nativeId, prompt, yolo }).then(info => {
        if (nativeIdRef.current === nativeId && info?.queued) {
          if (optimisticPromptRef.current?.blockId === userId) optimisticPromptRef.current = null;
          setBlocks(previous => previous.filter(block => block.id !== userId));
        }
        return nativeIdRef.current === nativeId;
      }).catch((err: unknown) => {
        if (nativeIdRef.current !== nativeId) return false;
        if (optimisticPromptRef.current?.blockId === userId) optimisticPromptRef.current = null;
        const message = err instanceof Error ? err.message : String(err);
        setBlocks((prev) => [...prev.map((b) => b.id === userId && b.kind === "user" ? { ...b, notSent: true } : b), { id: ++idRef.current, kind: "notice", text: message, tone: "error", recovery: recoverableRequest('not_sent', prompt) }]);
        if (!preserveDraft) setInput((draft) => draft || prompt);
        setRunning(false);
        runningRef.current = false;
        setStatus({ kind: "error", message });
        return false;
      });
    },
    [ready, sessionId, setStatus, yolo, onTitle, terminalOwnsConversation],
  );

  const send = useCallback(() => sendText(inputRef.current), [sendText]);

  const stop = useCallback(() => {
    const nativeId = nativeIdRef.current;
    if (!nativeId) return;
    invoke("agent_stop", { id: nativeId }).catch((err: unknown) => {
      if (nativeIdRef.current !== nativeId) return;
      setBlocks((prev) => [...prev, { id: ++idRef.current, kind: "notice", text: `Could not stop: ${String(err)}`, tone: "error" }]);
    });
  }, [sessionId]);

  const applyWorkspace = useCallback(async () => {
    if (runningRef.current || queueRef.current.items.length || applyingRef.current || initializing) return;
    applyingRef.current = true;
    setApplying(true);
    setWorkspaceError("");
    const nativeId = nativeIdRef.current;
    try {
      const next = await invoke<string>("agent_validate_workspace", { workspace: draft.trim() || null });
      if (nativeIdRef.current !== nativeId) return;
      if (next === workspace && !ready) setRetry((r) => r + 1);
      else if (next !== effective) setWorkspace(next);
      else if (!ready) setRetry((r) => r + 1);
    } catch (err) {
      if (nativeIdRef.current === nativeId) setWorkspaceError(String(err));
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [draft, effective, workspace, ready, initializing]);

  const openTodos = todos.filter((t) => t.status !== "completed");
  const doneTodos = todos.filter((t) => t.status === "completed");
  const lastAssistant = lastMatch(blocks,b=>b.kind==='assistant');
  const recoveryNotice = latestRecovery(blocks);
  const workspaceEditorOpen = workspaceOpen || !settings.compactControls || draft !== effective || !!workspaceError;
  const rememberLesson = async (lesson: string) => {
    if (!effective || !nativeIdRef.current) throw new Error('Choose a project before saving guidance.');
    const view = await invoke<MemoryView>(botId ? 'bots_memory' : 'memory_request', {id:botId,workspace:effective,request:{
      action:'save_lesson',title:lessonTitle(lesson),body:lesson.trim(),
    }});
    return view.settings.enabled ? undefined : 'Lesson saved. Memory is off for this project; enable it in Memory to use saved guidance.';
  };
  const closeCorrection = () => { setCorrection(null); composerRef.current?.focus(); };

  return (
    <div className={active ? "chat-wrap" : "chat-wrap hidden"}>
      {/* Session Header Bar */}
      <div className="chat-view-header">
        <div className="chat-view-header-left">
          <span className="cv-bot-pill">
            {bot ? <BotAvatar bot={bot} size={20} status={running ? "working" : "idle"} /> : <VelumMark size={20} />}
            <strong>{bot?.name || providerNames[provider]}</strong>
            <span className={`cv-status-dot ${running ? "running" : "idle"}`} />
            <span className="cv-status-text">{running ? (activity || "Working…") : "Ready"}</span>
          </span>
          {effective && (
            <span className="cv-project-pill" title={effective}>
              <Icon name="folder" size={13} />
              <span>{projectName(effective)}</span>
            </span>
          )}
        </div>

        <div className="chat-view-header-right">
          {gitChangedCount > 0 && (
            <button
              type="button"
              className="cv-diff-chip"
              title="Inspect changed files and live diffs"
              onClick={() => {
                setChatMode("split");
                try { localStorage.setItem("velum:chat-mode", "split"); } catch {}
              }}
            >
              <Icon name="diff" size={13} />
              <span>{gitChangedCount} {gitChangedCount === 1 ? "file" : "files"} changed</span>
            </button>
          )}

          <div className="cv-mode-toggle" role="group" aria-label="Conversation view mode">
            <button
              type="button"
              className={chatMode === "stream" ? "active" : ""}
              onClick={() => {
                setChatMode("stream");
                try { localStorage.setItem("velum:chat-mode", "stream"); } catch {}
              }}
              title="Stream mode: Focused dialogue stream"
            >
              <Icon name="chat" size={13} />
              <span>Stream</span>
            </button>
            <button
              type="button"
              className={chatMode === "split" ? "active" : ""}
              onClick={() => {
                setChatMode("split");
                try { localStorage.setItem("velum:chat-mode", "split"); } catch {}
              }}
              title="Split Studio: Dialogue + Live Mission Dashboard & Diff"
            >
              <Icon name="split" size={13} />
              <span>Split</span>
            </button>
            <button
              type="button"
              className={chatMode === "dashboard" ? "active" : ""}
              onClick={() => {
                setChatMode("dashboard");
                try { localStorage.setItem("velum:chat-mode", "dashboard"); } catch {}
              }}
              title="Dashboard mode: Full-screen Mission Control & Diff inspector"
            >
              <Icon name="board" size={13} />
              <span>Dashboard</span>
            </button>
          </div>
        </div>
      </div>

      <div className={`chat-main-area mode-${chatMode}`}>
        <div className="chat-stream-column">
          <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
            {blocks.length === 0 && interactions.requests.length === 0 && (
              <div className="chat-empty">
                <div className="welcome-mark">{bot?<BotAvatar bot={bot} size={62} status={running ? "working" : "idle"}/>:<VelumMark size={62}/>}</div>
                <span className="welcome-eyebrow">From an idea to something real</span>
                <h2>{bot?`${bot.name}, ready to help.`:'What are we building?'}</h2>
                <p>Describe what you want to make. Or choose a starting point and make the prompt your own.</p>
                <div className="chat-starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="starter-btn"
                      disabled={!ready || running || applying || (input ? input.length + 2 + s.prompt.length : s.prompt.length) > 64000}
                      onClick={() => { const next = inputRef.current ? `${inputRef.current}\n\n${s.prompt}` : s.prompt; if(next.length > 64000) return; inputRef.current=next; setInput(next); setHistIdx(null); composerRef.current?.focus(); }}
                    >
                      <span className="starter-icon"><Icon name={s.icon} size={21} /></span>
                      <strong>{s.label}</strong>
                      <span>{s.description}</span>
                      <Icon name="arrow" className="starter-arrow" size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {groupActivity(blocks, settings.groupActivity).map((row) => {
              if (row.kind === 'activity_group') {
                const tools = row.items.filter((item): item is Extract<Block,{kind:'tool'}> => item.kind === 'tool');
                const current = lastMatch(tools,tool=>statusTone(tool.status)==='busy');
                return (
                  <AgentActivity
                    key={`activity-${row.id}`}
                    count={tools.length}
                    current={current ? `${friendlyTool(current.name)} in progress` : ''}
                    failed={tools.some(tool=>['failed','blocked','rejected'].includes(tool.status))}
                    stopped={tools.some(tool=>tool.status==='cancelled')}
                    busy={!!current}
                    onOpenDashboard={() => {
                      setChatMode("split");
                      try { localStorage.setItem("velum:chat-mode", "split"); } catch {}
                    }}
                  >
                    {tools.map(tool=><ToolBlock key={tool.id} block={tool}/>)}
                  </AgentActivity>
                );
              }
              const b = row.block;
              switch (b.kind) {
                case "user":
                  return (
                    <div key={b.id} className="msg user">
                      <div className="message-header">
                        <span className="message-avatar user-avatar">Y</span>
                        <div className="message-author"><strong>You</strong>{b.notSent && <span className="message-unsent">Not sent</span>}</div>
                        <CopyButton text={b.text} />
                        <button type="button" className="memory-usage" aria-label="Remember this message" onClick={()=>onRemember(b.text)}><Icon name="memory" size={15}/></button>
                      </div>
                      <pre>{b.text}</pre>
                    </div>
                  );
                case "assistant": {
                  const touched = turnTouchedFiles(blocks, b.id);
                  return (
                    <div key={b.id} className="msg assistant">
                      <div className="message-header">
                        <span className="message-avatar muse-avatar">{bot?<BotAvatar bot={bot} size={38} status={running ? "working" : "idle"}/>:<VelumMark size={38}/>}</span>
                        <div className="message-author"><strong>{bot?.name||providerNames[provider]}<span className="assistant-badge">{bot?providerNames[provider]:'AI'}</span></strong></div>
                        <CopyButton text={b.text} />
                        <button type="button" className="memory-usage" aria-label="Remember this answer" onClick={()=>onRemember(b.text)}><Icon name="memory" size={15}/></button>
                      </div>
                      <Markdown text={b.text} />
                      {!b.open && <div className={`response-actions${lastAssistant?.id===b.id ? ' latest-response' : ''}`}><button type="button" onClick={()=>setCorrection({id:b.id,answer:b.text})}><Icon name="edit" size={14}/>Correct response</button>{lastAssistant?.id===b.id && !running && lastStatusRef.current.kind==='done' && <span className="response-finish"><Icon name="check" size={12}/>Ready for your next idea</span>}</div>}
                      {!b.open && (
                        <div className="turn-scorecard">
                          <div className="turn-scorecard-status">
                            <Icon name="check" size={13} />
                            <span>Turn complete</span>
                          </div>
                          {touched.length > 0 ? (
                            <div className="turn-touched-files">
                              <span style={{ fontSize: "10px", color: "var(--muted)" }}>Touched files:</span>
                              {touched.map((file) => (
                                <button
                                  key={file}
                                  type="button"
                                  className="turn-diff-pill"
                                  title={`Inspect diff for ${file} in Mission Dashboard`}
                                  onClick={() => {
                                    setSelectedDiffFile(file);
                                    setChatMode("split");
                                    try { localStorage.setItem("velum:chat-mode", "split"); } catch {}
                                  }}
                                >
                                  <Icon name="diff" size={11} />
                                  <span>{file.split(/[\\/]/).pop()}</span>
                                </button>
                              ))}
                            </div>
                          ) : gitChangedCount > 0 ? (
                            <button
                              type="button"
                              className="turn-diff-pill"
                              onClick={() => {
                                setChatMode("split");
                                try { localStorage.setItem("velum:chat-mode", "split"); } catch {}
                              }}
                            >
                              <Icon name="diff" size={11} />
                              <span>View {gitChangedCount} changed {gitChangedCount === 1 ? 'file' : 'files'}</span>
                            </button>
                          ) : null}
                        </div>
                      )}
                      {correction?.id === b.id && <CorrectionComposer running={running} disabled={!ready || applying} owner={bot?.name} onClose={closeCorrection} remember={rememberLesson} submit={async (text,lesson)=>{
                        const nativeId = nativeIdRef.current;
                        if (!await sendText(correctionPrompt(b.text,text),true)) throw new Error('Correction was not sent. Your edits are still here; try again when ready.');
                        let notice: string | undefined;
                        if (lesson) {
                          if (nativeId !== nativeIdRef.current) return {sent:true,remembered:false,error:'Correction sent. The conversation changed; save the lesson in Memory for the correct project.'};
                          try { notice = await rememberLesson(lesson); } catch(error) { return {sent:true,remembered:false,error:`Correction sent. The lesson could not be saved: ${String(error)}`}; }
                        }
                        return {sent:true,remembered:!!lesson,notice};
                      }}/>}
                    </div>
                  );
                }
            case "tool":
              return <ToolBlock key={b.id} block={b} />;
            case "notice":
              return (
                <div key={b.id} className={`notice ${b.tone}`}>
                  <span>{b.text}</span>
                  {b.recovery && recoveryNotice?.id === b.id && !running && <RequestRecovery
                    request={b.recovery} disabled={!ready || applying || permissionBusy}
                    queued={queue.paused || queue.items.length > 0} paused={queue.paused}
                    submit={prompt => sendText(prompt, true)}
                  />}
                </div>
              );
            case "approval":
              return (
                <PermissionRecord key={b.id} status={b.status} tool={b.tool} details={b.summary} />
              );
          }
        })}
        <InteractionPanel snapshot={interactions} canRespond={ready && !applying} onRefresh={() => refreshInteractions.current()} onRespond={async decision => {
          const nativeId = nativeIdRef.current;
          if (!nativeId) throw new Error('Conversation is still starting.');
          const next = await invoke<InteractionSnapshot>('agent_respond', { id: nativeId, decision });
          if (nativeId === nativeIdRef.current) setInteractions(previous => mergeInteractionResponse(previous, next));
        }} />
        {!terminalOwnsConversation && ready && !running && blocks.length > 0 && provider !== 'codex' && onContinueInTerminal && <div className="notice"><button type="button" className="workspace-btn" disabled={applying || queue.items.length > 0} onClick={onContinueInTerminal}><Icon name="terminal" size={14}/>Continue this conversation in terminal</button><span>Answer native prompts on this desktop. The saved conversation continues; this transcript remains.</span></div>}
        {running && !interactions.requests.some(request => interactions.active && ['pending', 'submitting'].includes(request.status)) && (
          <div className="chat-running" role="status">
            <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            {providerProgress?.phase === 'retrying' ? <ProviderWait progress={providerProgress} provider={provider}/> : <>
              Working…{elapsed >= 1000 ? ` ${fmtElapsed(elapsed)}` : ""}
              {activity ? ` · ${activity}` : ""}
            </>}
          </div>
        )}
      </div>
      <div className="composer-dock">
      <UsageStrip usage={usage} memory={memoryUsage} provider={provider} running={running} elapsed={elapsed} active={active} />
      <MessageQueue queue={queue} running={running} onAction={async request => {
        const nativeId = nativeIdRef.current;
        if (!nativeId) throw new Error('Conversation is still starting.');
        await invoke('agent_queue', { id: nativeId, request });
      }} />
      {showLatest && <div className="latest-wrap"><button type="button" className="latest-btn" onClick={jumpToLatest}><Icon name="down" size={14} />Back to latest</button></div>}
      {todos.length > 0 && (
        <details className="task-progress"><summary><Icon name="check" size={13}/><span>{doneTodos.length} of {todos.length} steps complete{openTodos.find(t=>t.status==='in_progress') ? ` · ${openTodos.find(t=>t.status==='in_progress')!.text}` : ''}</span><Icon name="down" size={12}/></summary><div className="todos">
          <span className="todos-title">Tasks</span>
          {openTodos.map((t, i) => (
            <span key={`o${i}`} className={`todo ${t.status}`}>
              {t.status === "in_progress" ? "◐" : "○"} {t.text}
            </span>
          ))}
          {doneTodos.length > 0 && <span className="todo done">✓ {doneTodos.length} done</span>}
        </div></details>
      )}
      {workspaceError && <div className="notice error" role="alert">{workspaceError}</div>}
      {!yolo && workspaceNotice && <div className="notice" role="status">{workspaceNotice}</div>}
      {draftError && <div className="notice error" role="alert">Your draft could not be saved. Copy it before closing Velum Code.</div>}
      {terminalOwnsConversation && <div className="notice" role="status">A terminal owns this conversation. Native prompts are answered there; close it before returning to chat. <button type="button" className="workspace-btn" onClick={() => void onCloseContinuedTerminal?.().then(() => setAttachedTerminal(false)).catch(error => setWorkspaceError(String(error)))}>Close terminal and return to chat</button></div>}
      <div className={`composer${running ? " is-running" : ""}${input.trim() ? " has-draft" : ""}`}>
        {slashOpen && slashMatches.length > 0 && (
          <div className="slash-menu" role="listbox" aria-label="Available slash commands">
            <div className="slash-menu-head">
              <span>Commands</span>
              <span className="slash-hint">↑↓ navigate · ↵ select · esc close</span>
            </div>
            <div className="slash-menu-list">
              {slashMatches.map((cmd: SlashCommand, idx: number) => (
                <button
                  key={cmd.command}
                  type="button"
                  role="option"
                  aria-selected={idx === slashIdx}
                  className={`slash-item${idx === slashIdx ? " active" : ""}`}
                  onClick={() => applySlashCommand(cmd)}
                  onMouseEnter={() => setSlashIdx(idx)}
                >
                  <span className="slash-icon"><Icon name={cmd.icon} size={14} /></span>
                  <strong className="slash-cmd">{cmd.command}</strong>
                  <span className="slash-label">{cmd.label}</span>
                  <span className="slash-desc">{cmd.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          maxLength={64000}
          ref={composerRef}
          value={input}
          rows={2}
          placeholder={ready ? running ? 'Add a message to the queue…' : `What’s on your mind? Ask ${bot?.name||providerNames[provider]}…` : "Getting ready…"}
          aria-label={`Message ${bot?.name||providerNames[provider]}`}
          disabled={!ready || applying || terminalOwnsConversation}
          onChange={(e) => {
            const val = e.target.value;
            setHistIdx(null);
            inputRef.current = val;
            setInput(val);
            if (val.startsWith("/") && !val.includes("\n")) {
              setSlashOpen(true);
              setSlashIdx(0);
            } else {
              setSlashOpen(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.repeat) return;
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIdx((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                applySlashCommand(slashMatches[slashIdx]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashOpen(false);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.altKey && (settings.sendShortcut === "enter" || e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              const h = historyRef.current;
              if (h.length === 0) return;
              if (histIdx === null) {
                // Only hijack Up on an empty composer; editing text keeps caret keys.
                if (e.key === "ArrowDown" || input !== "") return;
                e.preventDefault();
                draftRef.current = input;
                setHistIdx(h.length - 1);
                setInput(h[h.length - 1]);
              } else {
                e.preventDefault();
                const next = histIdx + (e.key === "ArrowUp" ? -1 : 1);
                if (next < 0) return;
                if (next >= h.length) {
                  setHistIdx(null);
                  setInput(draftRef.current);
                } else {
                  setHistIdx(next);
                  setInput(h[next]);
                }
              }
            }
          }}
        />
        <div className="composer-actions">
        <button type="button" className={yolo ? "yolo-btn on" : "yolo-btn"} disabled={!ready || running || queue.items.length > 0 || permissionBusy || terminalOwnsConversation} onClick={async () => {
          if (!nativeIdRef.current) return;
          setPermissionBusy(true);
          try { await invoke('agent_set_permissions', {id:nativeIdRef.current,yolo:!yolo}); setYolo(!yolo); }
          catch (e) { setWorkspaceError(String(e)); }
          finally { setPermissionBusy(false); }
        }} aria-pressed={yolo} aria-label="YOLO mode" title={yolo ? "YOLO is on: turns skip approvals and sandboxing" : "Turn on YOLO: skip approvals and sandboxing"}>
          {yolo ? <YoloIcon /> : <Icon name="shield" size={16} />}<span>{yolo ? "YOLO on" : "Standard"}</span>
        </button>
        <span className="composer-hint">
          {input.length > 200 ? (
            <span className={`composer-char-count${input.length > 50000 ? " near-limit" : ""}`}>
              {input.length.toLocaleString()} chars · ~{Math.round(input.length / 4)} tokens
            </span>
          ) : null}
          {settings.sendShortcut === "ctrl-enter" ? "Ctrl / ⌘ + Enter to send" : "Shift + Enter for a new line"}
        </span>
        <button
          type="button"
          className="yolo-btn"
          aria-label="Add Git context"
          title={effective ? "Add Git diff or status to draft" : "Choose a project first"}
          disabled={!effective || running}
          onClick={async () => {
            try {
              const state = await invoke<{ current: string; status: string }>("git_state", { workspace: effective });
              if (!state?.current) {
                setWorkspaceError("No Git repository in this project.");
                return;
              }
              const fileDiff = await invoke<{ diff: string }>("git_file_diff", { workspace: effective, base: state.current, path: "" }).catch(() => ({ diff: "" }));
              const addition = fileDiff.diff
                ? `Here is the current git diff on branch \`${state.current}\`:\n\n\`\`\`diff\n${fileDiff.diff.slice(0, 8000)}\n\`\`\`\nPlease review these changes:`
                : `[Git: repository is clean on branch ${state.current}]`;
              const next = inputRef.current ? `${inputRef.current}\n\n${addition}` : addition;
              if (next.length <= 64000) {
                inputRef.current = next;
                setInput(next);
                composerRef.current?.focus();
              }
            } catch (e) {
              setWorkspaceError(`Could not read Git state: ${String(e)}`);
            }
          }}
        >
          <Icon name="branch" size={16} />
        </button>
        <button type="button" className="yolo-btn" aria-label="Project context and diagnostics" title="Project context and diagnostics" disabled={!effective} onClick={e => setContextSnapshot(chatSnapshot(e.currentTarget.closest('.chat-wrap'), provider, options, running, 'desktop'))}><Icon name="settings" size={16}/></button>
        {running && (
          <button type="button" className="composer-btn stop" onClick={stop} aria-label="Stop" title="Stop">
            <StopIcon />
          </button>
        )}
          <button
            type="button"
            className="composer-btn"
            onClick={send}
            disabled={!ready || !input.trim() || terminalOwnsConversation}
            aria-label={running || queue.items.length > 0 ? 'Queue message' : 'Send'}
            title={running || queue.items.length > 0 ? 'Queue message' : 'Send'}
          >
            <SendIcon />
          </button>
        </div>
      </div>
      <div className="project-context-row"><button type="button" className="project-context-toggle" aria-label="Project folder" aria-controls={workspaceEditorId} aria-expanded={workspaceEditorOpen} title={effective || 'Choose a project'} onClick={()=>setWorkspaceOpen(open=>!open)}><Icon name="folder" size={13}/><span>{projectName(effective)}</span><Icon name="down" size={11}/></button>{running && <small>You can queue your next thought</small>}</div>
      <div id={workspaceEditorId} className="workspace-bar" hidden={!workspaceEditorOpen}>
        <button type="button" className="workspace-btn" aria-label="Choose project folder" title="Choose project folder, then Apply" disabled={running || queue.items.length > 0 || applying} onClick={async () => {
          if (runningRef.current || queueRef.current.items.length || applyingRef.current) return;
          applyingRef.current = true; setApplying(true); setWorkspaceError('');
          try { const path = await invoke<string | null>('workspace_pick'); if (path) { workspaceDraftRevision.current++; setDraft(path); } }
          catch (e) { setWorkspaceError(String(e)); }
          finally { applyingRef.current = false; setApplying(false); }
        }}><Icon name="folder" size={14} /></button>
        <input value={draft} disabled={applying} onChange={(e) => { workspaceDraftRevision.current++; setDraft(e.target.value); }} onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void applyWorkspace(); }
        }} placeholder={effective || "Choose a workspace"} aria-label="Workspace directory" title={effective || "default (home)"} spellCheck={false} />
        {(draft !== effective || !ready || workspaceError) && <button type="button" className="workspace-btn" onClick={applyWorkspace} disabled={running || queue.items.length > 0 || applying || initializing} title="Apply workspace (restarts this tab's session)">Apply</button>}
        <span className="workspace-label">Workspace</span>
      </div>
      {workspaceEditorOpen && blocks.some(b=>b.kind==='assistant') && <p className="workspace-editor-hint">Applying a different project starts a fresh conversation in this tab.</p>}
      </div>
      </div>

      {chatMode !== "stream" && (
        <div className="chat-dashboard-column">
          <SessionDashboard
            workspace={effective}
            bot={bot}
            provider={provider}
            options={options}
            running={running}
            activity={activity}
            todos={todos}
            blocks={blocks}
            usage={usage}
            memoryUsage={memoryUsage}
            selectedDiffFile={selectedDiffFile}
            onSelectDiffFile={setSelectedDiffFile}
            onClose={() => {
              setChatMode("stream");
              try { localStorage.setItem("velum:chat-mode", "stream"); } catch {}
            }}
            onInsertDraft={(text) => {
              const next = inputRef.current ? `${inputRef.current}\n\n${text}` : text;
              if (next.length > 64000) return;
              inputRef.current = next;
              setInput(next);
              composerRef.current?.focus();
            }}
          />
        </div>
      )}
    </div>
      {contextSnapshot !== null && active && <Suspense fallback={null}><ContextPanel key={`${nativeIdRef.current}:${yolo}`} snapshot={contextSnapshot} load={async () => { const report = await invoke<Diagnostics>('app_diagnostics', { workspace: effective, id: nativeIdRef.current }); return {...report, client_measurement:clientMeasurementRef.current.report(report.turn_measurement)}; }} check={() => invoke<AccessCheck>('workspace_check', { workspace: effective, write: true, id: nativeIdRef.current })} agentBusy={running || queue.items.length > 0 || !ready} checkAgent={async () => {
        if (!nativeIdRef.current || runningRef.current || queueRef.current.items.length) throw new Error('Finish or clear queued messages before testing agent access.');
        runningRef.current = true; setRunning(true); setActivity('Checking workspace access'); setStatus({kind:'running',detail:'Checking workspace access'});
        turnStartRef.current = performance.now(); assistantSeenRef.current = false;
        try { await invoke('agent_check_access', {id:nativeIdRef.current,yolo}); }
        catch (e) { runningRef.current = false; setRunning(false); setStatus({kind:'error',message:String(e)}); throw e; }
      }} onClose={() => setContextSnapshot(null)} onAttach={(label, text) => {
        const extra = attachment(label, text);
        if (input.length + extra.length > 64000) throw new Error('The message is too long to add this report. Copy it instead, or shorten your draft.');
        setInput(previous => previous + extra); setContextSnapshot(null); composerRef.current?.focus();
      }}/></Suspense>}
    </div>
  );
}
