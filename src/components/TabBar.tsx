import type { PtyStatus } from "./TerminalView";
import type { AgentStatus } from "./ChatView";
import Icon from "./Icon";
import { providerNames, type Provider } from "../providers";
import type {BotIdentity} from '../bots';
import BotAvatar from './BotAvatar';

export interface TabInfo {
  bot?: BotIdentity;
  provider: Provider;
  model: string;
  mode: "agent" | "terminal";
  id: string;
  title: string;
  status: PtyStatus | AgentStatus;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onCommands: () => void;
  onSettings: () => void;
  onPlugins: () => void;
  onKanban: () => void;
  onBots: () => void;
  workspace?: string;
}

export function conversationTitle(title: string): string {
  return /^(?:muse|New conversation) \d+$/.test(title) ? "New conversation" : title;
}

function sessionDetail(status: PtyStatus | AgentStatus): string {
  if (status.kind === "running") return "backend" in status ? "Terminal open" : "Working on it…";
  if (status.kind === "done") return "All caught up";
  if (status.kind === "error") return "Needs attention";
  if (status.kind === "exited") return "Terminal closed";
  if (status.kind === "starting") return "Getting ready…";
  return "Ready when you are";
}

// Second line of a conversation pill: who is answering (model first, then
// bot or provider) plus the live state — running detail, queue depth, or the
// settled state. Terminal tabs keep the provider name with terminal state.
function pillDetail(t: TabInfo): string {
  if (t.mode === "terminal" || "backend" in t.status) return `${providerNames[t.provider]} · ${sessionDetail(t.status)}`;
  const who = t.model || t.bot?.name || providerNames[t.provider];
  const s = t.status;
  if (s.kind === "running" && !("backend" in s)) {
    const live = s.detail ? s.detail : "Working on it…";
    const queued = s.queued ? ` · ${s.queued} queued` : "";
    return `${who} · ${live}${queued}`;
  }
  const queued = "queued" in s ? (s.queued ?? 0) : 0;
  const paused = "queuePaused" in s ? s.queuePaused : false;
  if (queued > 0) return `${who} · ${paused ? "Queue paused" : "Queued"} (${queued})`;
  return `${who} · ${sessionDetail(s)}`;
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew, onCommands, onSettings, onPlugins, onKanban, onBots, workspace }: TabBarProps) {
  const project = workspace?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Your workspace";
  return (
    <aside className="sidebar" aria-label="Conversations">
      <div className="sidebar-project" title={workspace}>
        <span className="project-icon"><Icon name="folder" size={21} /></span>
        <div><strong>{project}</strong><span>Current workspace</span></div>
      </div>
      <button type="button" className="tab-new" aria-label="New session (Ctrl+T)" title="New session (Ctrl+T)" onClick={onNew}>
        <Icon name="plus" size={19} /><span>New conversation</span>
      </button>
      <div className="sidebar-label"><span>Conversations</span><span>{tabs.length}</span></div>
      <div className="tablist" role="tablist" aria-label="Sessions" aria-orientation="vertical">
      {tabs.map((t, index) => (
        <button
          type="button"
          key={t.id}
          role="tab"
          data-session-id={t.id}
          aria-selected={t.id === activeId}
          aria-label={`${conversationTitle(t.title)}, ${pillDetail(t)}`}
          tabIndex={t.id === activeId ? 0 : -1}
          aria-keyshortcuts="Delete"
          title={`${conversationTitle(t.title)} (Delete to close)`}
          className={`tab${t.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Delete") { e.preventDefault(); onClose(t.id); return; }
            const next = e.key === "ArrowLeft" || e.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
              : e.key === "ArrowRight" || e.key === "ArrowDown" ? (index + 1) % tabs.length
              : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
            if (next < 0) return;
            e.preventDefault();
            onSelect(tabs[next].id);
            (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();
          }}
          onMouseUp={(e) => {
            if (e.button === 1) onClose(t.id);
          }}
        >
          <span className="conversation-icon">{t.bot?<BotAvatar bot={t.bot} size={32} status={t.status.kind === "running" ? "working" : t.status.kind === "error" ? "error" : "idle"}/>:<Icon name="chat" size={19}/>}</span>
          <span className="tab-copy"><span className="tab-title">{conversationTitle(t.title)}</span><span className="tab-detail">{pillDetail(t)}</span></span>
          {t.status.kind === "running" && <span className="status-dot running" aria-hidden="true" />}
          <span
            className="tab-close"
            title={`Close ${conversationTitle(t.title)}`}
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <Icon name="close" size={13} />
          </span>
        </button>
      ))}
      </div>
      <div className="sidebar-footer">
        <button type="button" onClick={onBots} aria-label="Bots" title="Bots and schedules"><Icon name="chat" size={18}/><span>Bots</span></button>
        <button type="button" onClick={onKanban} disabled={!workspace} aria-label="Kanban" title="Workspace Kanban"><Icon name="board" size={18}/><span>Kanban</span></button>
        <button type="button" onClick={onPlugins} aria-label="Plugins" title="Plugins"><Icon name="code" size={18}/><span>Plugins</span></button>
        <button type="button" onClick={onSettings} aria-label="Settings" title="Settings (Ctrl+,)"><Icon name="settings" size={18}/><span>Settings</span><kbd>Ctrl ,</kbd></button>
        <button type="button" onClick={onCommands} aria-label="Command menu" title="Command menu (Ctrl+K)"><Icon name="command" size={18} /><span>Command menu</span><kbd>Ctrl K</kbd></button>
      </div>
    </aside>
  );
}
