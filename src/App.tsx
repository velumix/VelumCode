import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import TabBar, { conversationTitle } from "./components/TabBar";
import Icon from "./components/Icon";
import SearchBar from "./components/SearchBar";
const TerminalView = lazy(() => import("./components/TerminalView"));
import type { PtyStatus, TerminalHandles } from "./components/TerminalView";
import ChatView from "./components/ChatView";
import GitChip from "./components/GitChip";
import type { AgentStatus } from "./components/ChatView";
import CommandPalette from "./components/CommandPalette";
const RemotePanel = lazy(() => import("./components/RemotePanel"));
import type { PaletteAction } from "./components/CommandPalette";
import "./App.css";
import "./appearance.css";
import { getPreferences, usePreferences } from "./preferences";
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
import ProviderPicker from "./components/ProviderPicker";
import ChoiceMenu from './components/ChoiceMenu';
import type {BotProfile,BotView} from './bots';
import type {ModelCatalog} from './providers';
const BotsPanel=lazy(()=>import('./components/BotsPanel'));
const MemoryPanel = lazy(() => import("./components/MemoryPanel"));
const PluginPanel = lazy(() => import("./components/PluginPanel"));
const KanbanPanel = lazy(() => import("./components/KanbanPanel"));
const GitPanel = lazy(() => import("./components/GitPanel"));
import { taskPrompt, type Board, type Card } from "./kanban";
import type { PluginSelection } from "./components/PluginPanel";
import type { InstalledPlugin, PluginChatHandle } from "./plugins";
import { loadDesktop, saveDesktop, saveDraft, recoveryError } from "./desktopHistory";
import { finishStartup } from "./startup";
import { useUpdates } from "./updates";
import type { MemoryView } from "./memory";
import { preferredProvider, preferredOptions, saveOptions, providerNames, type Provider, type RunOptions } from "./providers";

type TabMode = "agent" | "terminal";
interface DesktopStatus { notifications_enabled: boolean; last_error: string | null }

interface Tab {
  bot_id?: string;
  task_id?: string;
  options: RunOptions;
  provider: Provider;
  id: string;
  title: string;
  mode: TabMode;
  agentStatus: AgentStatus;
  terminalStatus: PtyStatus;
  agentKey: number;
  terminalKey: number;
  terminalStarted: boolean;
  workspace?: string;
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `tab-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function newProvider(): Provider {
  const provider = getPreferences().defaultProvider;
  return provider === "last" ? preferredProvider() : provider;
}
function createTab(n: number, provider = newProvider()): Tab {
  return { provider, options: preferredOptions(provider), id: newId(), title: `New conversation ${n}`, mode: "agent", agentStatus: { kind: "starting" }, terminalStatus: { kind: "starting" }, agentKey: 0, terminalKey: 0, terminalStarted: false };
}

function tabStatus(tab: Tab): PtyStatus | AgentStatus {
  return tab.mode === "agent" ? tab.agentStatus : tab.terminalStatus;
}

function statusText(tab: Tab): string {
  const status = tabStatus(tab);
  if (tab.mode === 'agent' && tab.agentStatus.kind !== 'running' && tab.agentStatus.queuePaused && tab.agentStatus.queued) return `Queue paused · ${tab.agentStatus.queued} pending`;
  switch (status.kind) {
    case "starting":
      return `Starting ${providerNames[tab.provider]}…`;
    case "idle":
      return "Ready";
    case "done":
      return "\u2713 Done";
    case "running":
      if ("backend" in status) return `${providerNames[tab.provider]} · ${status.backend}`;
      return "detail" in status && status.detail ? `Working… · ${status.detail}` : "Working…";
    case "exited":
      return status.code === null ? `${providerNames[tab.provider]} exited` : `${providerNames[tab.provider]} exited (code ${status.code})`;
    case "error":
      return status.message;
  }
}

export default function App() {
  const updates = useUpdates();
  const {settings} = usePreferences();
  const [recovery] = useState(loadDesktop);
  const [tabs, setTabs] = useState<Tab[]>(() => recovery.tabs.length ? recovery.tabs.map((saved, i) => ({ ...createTab(i + 1, saved.provider), ...saved })) : [createTab(1)]);
  const [activeId, setActiveId] = useState<string>(() => recovery.activeId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"appearance" | "updates">("appearance");
  const [bots,setBots]=useState<BotProfile[]>([]);
  const [botPanel,setBotPanel]=useState<'manage'|'handoff'|'activity'|null>(null);
  const refreshBots=useCallback(async()=>{const view=await invoke<BotView>('bots_request',{request:{action:'list'}});setBots(view?.profiles||[]);},[]);
  useEffect(()=>{void refreshBots().catch(()=>{});const registration=listen('bots-changed',()=>void refreshBots().catch(()=>{}));return()=>{void registration.then(off=>off());};},[refreshBots]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [pluginPanel, setPluginPanel] = useState<{ selection?: PluginSelection } | null>(null);
  const [memory, setMemory] = useState<{workspace:string;seed?:string;bot_id?:string;initialFilter?:'active'|'pending'}|null>(null);
  const [guidanceReviewCount, setGuidanceReviewCount] = useState(0);
  const [boardWorkspace, setBoardWorkspace] = useState<string | null>(null);
  const [gitWorkspace, setGitWorkspace] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<DesktopStatus>({ notifications_enabled: true, last_error: null });
  const [desktopMessage, setDesktopMessage] = useState<{ text: string; error: boolean } | null>(() => recoveryError ? { text: recoveryError, error: true } : null);
  useEffect(() => {
    const error = (e:Event) => setDesktopMessage({text:`Recovery could not save: ${(e as CustomEvent<string>).detail}`,error:true});
    window.addEventListener("velum:recovery-error",error);
    return () => window.removeEventListener("velum:recovery-error",error);
  }, []);

  const counter = useRef(1);
  useEffect(()=>{const registration=listen<{tab_id:string;bot:BotProfile;workspace:string}>('bot-chat-open',({payload})=>{
    setTabs(tabs=>{if(tabs.length>=32||tabs.some(t=>t.id===payload.tab_id))return tabs;return [...tabs,{...createTab(++counter.current,payload.bot.provider),id:payload.tab_id,bot_id:payload.bot.id,title:payload.bot.name,options:payload.bot.options,workspace:payload.workspace}];});
  });return()=>{void registration.then(off=>off());};},[]);
  const handlesRef = useRef(new Map<string, TerminalHandles>());
  const pluginHandles = useRef(new Map<string, PluginChatHandle>());
  const handlePlugin = useCallback((id: string, handle: PluginChatHandle | null) => {
    if (handle) pluginHandles.current.set(id, handle); else pluginHandles.current.delete(id);
  }, []);
  const refreshPlugins = useCallback(async () => setPlugins(await invoke<InstalledPlugin[]>("plugins_list") || []), []);
  useEffect(() => { void refreshPlugins().catch(e => setDesktopMessage({ text: `Could not load plugins: ${String(e)}`, error: true })); }, [refreshPlugins]);
  // Render-committed snapshot so global shortcut handlers never go stale.
  const stateRef = useRef({ tabs, activeId });
  stateRef.current = { tabs, activeId };
  useEffect(() => {
    try { saveDesktop(tabs, activeId); } catch { setDesktopMessage({ text: "Could not save your open conversations. Check available disk space before quitting.", error: true }); }
  }, [tabs, activeId]);

  // Default to the first tab on initial mount.
  useEffect(() => {
    setActiveId((prev) => prev || stateRef.current.tabs[0]?.id || "");
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const navigate = async () => {
      const id = await invoke<string | null>("desktop_take_navigation");
      if (disposed || !id) return;
      if(id.startsWith('bot-run-')){setBotPanel('activity');return;}
      if (stateRef.current.tabs.some((t) => t.id === id)) {
        setTabs((tabs) => tabs.map((t) => t.id === id ? { ...t, mode: "agent" } : t));
        setActiveId(id);
        setSearchOpen(false);
      } else {
        setDesktopMessage({ text: "That conversation has already been closed.", error: false });
      }
    };
    const setup = (async () => {
      const track = async (registration: Promise<() => void>) => {
        const unlisten = await registration;
        if (disposed) unlisten(); else unlistens.push(unlisten);
      };
      await Promise.all([
        track(listen<string | null>("history-status", ({payload}) => { if (payload && !disposed) setDesktopMessage({ text: `Conversation recovery could not save: ${payload}`, error:true }); })),
        track(listen<{ tab_id: string; options: RunOptions }>("agent-options", ({ payload }) => {
          if (disposed) return;
          const provider = stateRef.current.tabs.find((t) => t.id === payload.tab_id)?.provider;
          if (provider) saveOptions(provider, payload.options);
          setTabs((tabs) => tabs.map((t) => t.id === payload.tab_id ? { ...t, options: payload.options } : t));
        })),
        track(listen<DesktopStatus>("desktop-status", ({ payload }) => { if (!disposed) setDesktop(payload); })),
        track(listen("desktop-navigation", () => { if (!disposed) void navigate().catch(() => {}); })),
      ]);
      if (disposed) return;
      const initial = await invoke<DesktopStatus>("desktop_status");
      if (!disposed && initial) setDesktop(initial);
      if (!disposed) await navigate();
    })().catch(() => {});
    return () => { disposed = true; for (const off of unlistens) off(); void setup; };
  }, []);

  const toggleNotifications = useCallback(async () => {
    try {
      setDesktop(await invoke<DesktopStatus>("desktop_set_notifications", { enabled: !desktop.notifications_enabled }));
      setDesktopMessage(null);
    } catch (error) { setDesktopMessage({ text: String(error), error: true }); }
  }, [desktop.notifications_enabled]);

  const testNotification = useCallback(async () => {
    try {
      await invoke("desktop_test_notification");
      setDesktopMessage({ text: "Test notification sent to Windows.", error: false });
    } catch (error) { setDesktopMessage({ text: String(error), error: true }); }
  }, []);

  const handleAgentStatus = useCallback((sessionId: string, s: AgentStatus) => {
    setTabs((prev) => prev.map((t) => (t.id === sessionId ? { ...t, agentStatus: s } : t)));
  }, []);

  const handleWorkspace = useCallback((sessionId: string, workspace: string) => {
    setTabs((prev) => prev.map((t) => t.id === sessionId
      ? { ...t, workspace, title: t.workspace && t.workspace !== workspace ? "New conversation" : t.title }
      : t));
  }, []);

  const handleTitle = useCallback((sessionId: string, title: string) => {
    setTabs((prev) => prev.map((t) => t.id === sessionId ? { ...t, title } : t));
  }, []);

  const handleTerminalStatus = useCallback((sessionId: string, s: PtyStatus) => {
    setTabs((prev) => prev.map((t) => (t.id === sessionId ? { ...t, terminalStatus: s } : t)));
    if (s.kind === "error") {
      // Surface spawn failures inside the terminal view itself (chat view
      // renders its own errors inline, so this only fires for terminals).
      const h = handlesRef.current.get(sessionId);
      h?.term.writeln(`\r\n\x1b[31m${s.message}\x1b[0m`);
      h?.term.writeln("\x1b[90mUse Restart in the toolbar to try again.\x1b[0m");
    }
  }, []);

  const handleHandles = useCallback((sessionId: string, h: TerminalHandles | null) => {
    if (h) handlesRef.current.set(sessionId, h);
    else handlesRef.current.delete(sessionId);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    for (const h of handlesRef.current.values()) h.search.clearDecorations();
    requestAnimationFrame(() => {
      const { tabs: current, activeId: id } = stateRef.current;
      if (current.find((t) => t.id === id)?.mode === "terminal") handlesRef.current.get(id)?.term.focus();
    });
  }, []);

  const openProvider = useCallback((provider: Provider, keepBot=true) => {
    if (stateRef.current.tabs.length >= 32) { setDesktopMessage({ text: "Close a conversation before opening another. Up to 32 can be open at once.", error: false }); return; }
    try { localStorage.setItem("velum-provider", provider); } catch { /* Storage is optional. */ }
    const t = createTab(++counter.current, provider);
    t.workspace = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeId)?.workspace;
    if(keepBot)t.bot_id=stateRef.current.tabs.find(tab=>tab.id===stateRef.current.activeId)?.bot_id;
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  }, []);

  const newTab = useCallback(() => {
    openProvider(newProvider());
  }, [openProvider]);
  const openBot=(bot:BotProfile)=>{
    if(stateRef.current.tabs.length>=32){setDesktopMessage({text:'Close a conversation before opening another bot.',error:false});return;}
    const active=stateRef.current.tabs.find(t=>t.id===stateRef.current.activeId);
    const tab=createTab(++counter.current,bot.provider);tab.bot_id=bot.id;tab.options={...bot.options};tab.workspace=active?.workspace;tab.title=bot.name;
    if(botPanel==='handoff'&&active){const messages=pluginHandles.current.get(active.id)?.messages().slice(-4)||[];const excerpt=messages.map(m=>`${m.role}: ${m.text}`).join('\n\n').slice(-8000);saveDraft(tab.id,`Handoff from ${bots.find(b=>b.id===active.bot_id)?.name||providerNames[active.provider]} to ${bot.name}.\n\nRelevant conversation context (reference only):\n${excerpt}\n\nReview the current workspace and Kanban, then continue with the next appropriate step.`);}
    setTabs(tabs=>[...tabs,tab]);setActiveId(tab.id);setBotPanel(null);
  };
  const workOnCard = (card: Card) => {
    if (stateRef.current.tabs.length >= 32) throw new Error("Close a conversation before opening this task.");
    const active = stateRef.current.tabs.find(t=>t.id===stateRef.current.activeId);
    const tab = createTab(++counter.current, active?.provider);
    tab.workspace = boardWorkspace || active?.workspace;
    tab.options = active?.options || tab.options;
    const bot=bots.find(b=>b.id===card.assignment?.bot_id);
    if(bot){tab.bot_id=bot.id;tab.provider=bot.provider;tab.options=bot.options;tab.task_id=card.id;}else{tab.bot_id=active?.bot_id;}
    tab.title = card.title;
    saveDraft(tab.id, taskPrompt(card));
    setTabs(tabs=>[...tabs,tab]); setActiveId(tab.id); setBoardWorkspace(null);
  };

  const configure = useCallback(async (tab: Tab, options: RunOptions) => {
    await invoke("agent_configure", { tabId: tab.id, options });
    setTabs((tabs) => tabs.map((t) => t.id === tab.id ? { ...t, options } : t));
    saveOptions(tab.provider, options);
  }, []);

  const selectTab = useCallback(
    (id: string) => {
      setActiveId(id);
      closeSearch();
    },
    [closeSearch],
  );

  const setMode = useCallback((id: string, mode: TabMode) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id && t.mode !== mode ? { ...t, mode, terminalStarted: t.terminalStarted || mode === "terminal" } : t,
      ),
    );
    closeSearch();
  }, [closeSearch]);

  const closeTab = useCallback((id: string) => {
    void invoke("history_forget", { tabId: id }).catch(e => setDesktopMessage({ text: `Could not delete saved conversation: ${String(e)}`, error: true }));
    try { saveDraft(id, ""); } catch { /* Reported by the persistence effect if storage is unavailable. */ }
    // Each view owns its native session and completes cleanup after any
    // pending initialization. Sending a second kill here races that owner.
    handlesRef.current.delete(id);
    const prev = stateRef.current.tabs;
    const next = prev.filter((t) => t.id !== id);
    if (next.length === 0) {
      const t = createTab(++counter.current);
      setTabs([t]);
      setActiveId(t.id);
      return;
    }
    setTabs(next);
    if (stateRef.current.activeId === id) {
      const idx = prev.findIndex((t) => t.id === id);
      setActiveId(next[Math.min(idx, next.length - 1)].id);
    }
  }, []);

  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const { tabs: current, activeId: currentActive } = stateRef.current;
      if (current.length < 2) return;
      const idx = current.findIndex((t) => t.id === currentActive);
      setActiveId(current[(idx + dir + current.length) % current.length].id);
      closeSearch();
    },
    [closeSearch],
  );

  const togglePalette = useCallback(() => {
    setPaletteOpen((v) => !v);
  }, []);

  const focusComposer = useCallback(() => {
    const id = stateRef.current.activeId;
    if (id) setMode(id, "agent");
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("muse:focus-composer", { detail: id }));
    });
  }, [setMode]);

  useEffect(() => finishStartup(focusComposer), [focusComposer]);

  const jumpTab = useCallback(
    (idx: number) => {
      const t = stateRef.current.tabs[idx];
      if (t) selectTab(t.id);
    },
    [selectTab],
  );

  const zoomActive = useCallback((delta: number | null) => {
    const h = handlesRef.current.get(stateRef.current.activeId);
    if (!h) return;
    const baseSize = getPreferences().terminalFontSize;
    const next = delta === null ? baseSize : Math.min(32, Math.max(8, (h.term.options.fontSize ?? baseSize) + delta));
    h.term.options.fontSize = next;
    try {
      h.fit.fit();
      invoke("pty_resize", {
        id: h.id,
        cols: Math.max(1, h.term.cols),
        rows: Math.max(1, h.term.rows),
      }).catch(() => {});
    } catch {
      // Tearing down; safe to ignore.
    }
  }, []);

  const actionsRef = useRef({ newTab, cycleTab, zoomActive, togglePalette, focusComposer, jumpTab });
  actionsRef.current = { newTab, cycleTab, zoomActive, togglePalette, focusComposer, jumpTab };

  // Global shortcuts in the capture phase so the terminal never sees them.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const actions = actionsRef.current;
      if (e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(true);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        e.stopPropagation();
        actions.zoomActive(1);
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        actions.zoomActive(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        actions.zoomActive(null);
      } else if (e.key === "f" || e.key === "F") {
        const { tabs: ts, activeId: aid } = stateRef.current;
        if (ts.find((t) => t.id === aid)?.mode !== "terminal") return;
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        e.stopPropagation();
        actions.newTab();
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        actions.cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        e.stopPropagation();
        actions.togglePalette();
      } else if (e.key === "l" || e.key === "L") {
        const { tabs: ts, activeId: aid } = stateRef.current;
        if (ts.find((t) => t.id === aid)?.mode !== "agent") return;
        e.preventDefault();
        e.stopPropagation();
        actions.focusComposer();
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        actions.jumpTab(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const find = useCallback(
    (dir: 1 | -1, query: string) => {
      const h = handlesRef.current.get(stateRef.current.activeId);
      if (!h || !query) return;
      if (dir === 1) h.search.findNext(query);
      else h.search.findPrevious(query);
    },
    [],
  );

  const restartActive = useCallback(() => {
    const id = stateRef.current.activeId;
    if (!id) return;
    setTabs((prev) => prev.map((t) => t.id !== id ? t : t.mode === "agent"
      ? { ...t, title: "New conversation", agentStatus: { kind: "starting" }, agentKey: t.agentKey + 1 }
      : { ...t, terminalStatus: { kind: "starting" }, terminalKey: t.terminalKey + 1 }));
  }, []);

  const clearActive = useCallback(() => {
    handlesRef.current.get(stateRef.current.activeId)?.term.clear();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  useEffect(()=>{
    let disposed = false, generation = 0;
    setGuidanceReviewCount(0);
    const workspace = activeTab?.workspace, botId = activeTab?.bot_id;
    if (!workspace) return;
    const refresh = async () => {
      const version = ++generation;
      try {
        const view = await invoke<MemoryView>(botId?'bots_memory':'memory_request',{id:botId,workspace,request:{action:'list',query:''}});
        if(!disposed && version===generation) setGuidanceReviewCount(view.notes.filter(note=>note.status==='pending').length);
      } catch { if(!disposed && version===generation) setGuidanceReviewCount(0); }
    };
    void refresh();
    const registration = listen('memory-changed',()=>void refresh());
    return ()=>{disposed=true;void registration.then(off=>off()).catch(()=>{});};
  },[activeTab?.workspace,activeTab?.bot_id]);
  const failed = activeTab && (tabStatus(activeTab).kind === "error" || tabStatus(activeTab).kind === "exited");

  const paletteActions: PaletteAction[] = [
    { id: "cmd-settings", title: "Open settings: themes, glass, layout, and preferences", hint: "Ctrl+,", run: () => setSettingsOpen(true) },
    {id:'cmd-bots',title:'Open bots and schedules',run:()=>setBotPanel('manage')},
    { id: "cmd-kanban", title: "Open workspace Kanban board", run: () => { if(activeTab?.workspace)setBoardWorkspace(activeTab.workspace); } },
    { id: "cmd-git", title: "Open Git branches and diff", run: () => { if(activeTab?.workspace)setGitWorkspace(activeTab.workspace); } },
    { id: "cmd-plugins", title: "Manage plugins", run: () => setPluginPanel({}) },
    ...plugins.filter(p => p.enabled).flatMap(p => p.manifest.commands.map(c => ({ id: `plugin-${p.manifest.id}-${c.id}`, title: `${c.title} · ${p.manifest.name}`, run: () => setPluginPanel({ selection: { id: p.manifest.id, command: c.id } }) }))),
    { id:"cmd-memory", title:"Open project memory vault", run:()=>{ if(activeTab?.workspace)setMemory({workspace:activeTab.workspace}); } },
    { id: "cmd-remote", title: "Connect your phone with Tailscale or USB", run: () => setRemoteOpen(true) },
    { id: "cmd-new", title: "New agent tab", hint: "Ctrl+T", run: newTab },
    { id: "cmd-focus", title: "Focus message input", hint: "Ctrl+L", run: focusComposer },
    {
      id: "cmd-agent",
      title: "Switch this tab to Agent mode",
      run: () => {
        const id = stateRef.current.activeId;
        if (id) setMode(id, "agent");
      },
    },
    {
      id: "cmd-terminal",
      title: "Switch this tab to Terminal mode",
      run: () => {
        const id = stateRef.current.activeId;
        if (id) setMode(id, "terminal");
      },
    },
    { id: "cmd-restart", title: "Restart this tab's session", run: restartActive },
    { id: "cmd-notifications", title: desktop.notifications_enabled ? "Turn off background notifications" : "Turn on background notifications", run: () => void toggleNotifications() },
    { id: "cmd-test-notification", title: "Send a test Windows notification", run: () => void testNotification() },
    { id: "cmd-tray", title: "Hide Velum Code to the system tray", run: () => void getCurrentWindow().close() },
    { id: "cmd-quit", title: "Quit Velum Code and stop background work", run: () => void invoke("desktop_quit") },
    {
      id: "cmd-close",
      title: "Close this tab",
      run: () => {
        const id = stateRef.current.activeId;
        if (id) closeTab(id);
      },
    },
    ...tabs.map((t, i) => ({
      id: `cmd-goto-${t.id}`,
      title: `Go to conversation: ${conversationTitle(t.title)} (${t.mode})`,
      hint: i < 9 ? `Ctrl+${i + 1}` : undefined,
      run: () => selectTab(t.id),
    })),
  ];

  return (
    <div className="app">
      <TitleBar onCommands={togglePalette} />
      {(desktopMessage || desktop.last_error) && <div className={`desktop-notice${desktopMessage?.error || desktop.last_error ? " error" : ""}`} role={desktopMessage?.error || desktop.last_error ? "alert" : "status"}>
        <span>{desktopMessage?.text || desktop.last_error}</span>
        <button type="button" aria-label="Dismiss notification message" onClick={() => { setDesktopMessage(null); setDesktop((s) => ({ ...s, last_error: null })); }}><Icon name="close" size={15} /></button>
      </div>}
      <div className="app-body">
      <TabBar tabs={tabs.map((t) => ({ ...t, bot:bots.find(b=>b.id===t.bot_id),model:t.options.model,mode:t.mode,status: tabStatus(t) }))} activeId={activeTab?.id ?? ""} onSelect={selectTab} onClose={closeTab} onNew={newTab} onCommands={togglePalette} onSettings={() => setSettingsOpen(true)} onBots={()=>setBotPanel('manage')} onPlugins={() => setPluginPanel({})} onKanban={()=>{if(activeTab?.workspace)setBoardWorkspace(activeTab.workspace);}} workspace={activeTab?.workspace} />
      <main className="conversation-pane" aria-label="Current conversation">
      <div className="conversation-toolbar">
        <div className="conversation-heading">
          <span className="section-label">Your space to create</span>
          <h1>{activeTab ? conversationTitle(activeTab.title) : "New conversation"}</h1>
        </div>
        {activeTab && (
          <div className="mode-toggle" data-mode={activeTab.mode} role="group" aria-label="Tab mode">
            <button type="button" className={activeTab.mode === "agent" ? "active" : ""} aria-pressed={activeTab.mode === "agent"} onClick={() => setMode(activeTab.id, "agent")}>
              <Icon name="chat" size={16} />Agent
            </button>
            <button type="button" className={activeTab.mode === "terminal" ? "active" : ""} aria-pressed={activeTab.mode === "terminal"} title={`Open a separate ${providerNames[activeTab.provider]} terminal conversation in this workspace`} onClick={() => setMode(activeTab.id, "terminal")}>
              <Icon name="terminal" size={17} />Terminal
            </button>
          </div>
        )}
        {activeTab?.mode === "terminal" && <button type="button" className="status-btn" onClick={clearActive}>Clear</button>}
        <button type="button" aria-label="Memory" title={guidanceReviewCount ? `${guidanceReviewCount} suggestions to review` : "Project guidance and saved notes"} className="status-btn" disabled={!activeTab?.workspace} onClick={()=>{if(activeTab?.workspace)setMemory({workspace:activeTab.workspace,bot_id:activeTab.bot_id,initialFilter:guidanceReviewCount?'pending':'active'});}}><Icon name="memory" size={17}/><span>Memory</span>{guidanceReviewCount>0&&<span className="guidance-review-count" aria-label={`${guidanceReviewCount} suggestions to review`}>{guidanceReviewCount}</span>}</button>
        <button type="button" aria-label="Git branches and diff" title="Branches, working-tree status and diffs (read-only)" className="status-btn" disabled={!activeTab?.workspace} onClick={()=>{if(activeTab?.workspace)setGitWorkspace(activeTab.workspace);}}><Icon name="code" size={17}/><span>Git</span></button>
        <button type="button" className={`restart-btn${failed ? " primary" : ""}`} onClick={restartActive} aria-label="Restart" title="Restart this session">
          <Icon name="reset" size={17} />
        </button>
      </div>
      {activeTab && <ProviderPicker compact={settings.compactControls} key={activeTab.id} value={activeTab.provider} options={activeTab.options} onOptionsChange={(options) => configure(activeTab, options)} disabled={activeTab.agentStatus.kind === "starting" || activeTab.agentStatus.kind === "running" || (activeTab.agentStatus.queued ?? 0) > 0} terminal={activeTab.mode === "terminal"} failure={activeTab.agentStatus.kind === "error" ? activeTab.agentStatus.message : undefined} onChange={(provider) => { if (provider !== activeTab.provider) openProvider(provider); }}
        botPicker={activeTab.mode === 'agent' && <ChoiceMenu label="Bot" value={activeTab.bot_id||'provider'} choices={[{id:'provider',label:'Provider assistant',description:'Use the CLI without a custom personality'},...bots.filter(b=>b.enabled).map(b=>({id:b.id,label:b.name,description:b.role||providerNames[b.provider]})),{id:'manage',label:'Create or edit bots…'}]} onChange={id=>{
            if(id==='manage')setBotPanel('manage');
            else if(id==='provider')openProvider(activeTab.provider,false);
            else{const bot=bots.find(b=>b.id===id);if(bot)openBot(bot);}
          }}/>}
        actions={activeTab.mode === 'agent' && bots.length > 0 && <button className="status-btn" onClick={()=>setBotPanel('handoff')} title="Prepare a handoff in a new bot conversation">Hand off</button>}
      />}
      <div className="terminal-wrap">
        {tabs.map((t) => (
          <Fragment key={t.id}>
            <ChatView
              onPluginHandle={handlePlugin}
              sessionId={t.id}
              provider={t.provider}
              botId={t.bot_id}
              taskId={t.task_id}
              options={t.options}
              initialWorkspace={t.workspace}
              onRemember={(seed)=>{if(t.workspace)setMemory({workspace:t.workspace,seed,bot_id:t.bot_id});}}
              active={t.id === activeTab?.id && t.mode === "agent"}
              sessionKey={t.agentKey}
              onStatus={handleAgentStatus}
              onWorkspace={handleWorkspace}
              onTitle={handleTitle}
            />
            {t.terminalStarted && <Suspense fallback={t.id === activeTab?.id && t.mode === "terminal" ? <p>Loading terminal…</p> : null}>
            <TerminalView
              sessionId={t.id}
              provider={t.provider}
              options={t.options}
              active={t.id === activeTab?.id && t.mode === "terminal"}
              sessionKey={t.terminalKey}
              workspace={t.workspace}
              onStatus={handleTerminalStatus}
              onHandles={handleHandles}
            />
            </Suspense>}
          </Fragment>
        ))}
        {searchOpen && activeTab?.mode === "terminal" && (
          <SearchBar onNext={(q) => find(1, q)} onPrevious={(q) => find(-1, q)} onClose={closeSearch} />
        )}
      </div>
      <footer className="statusbar">
        {activeTab && (
          <>
            <span className={`status-dot ${tabStatus(activeTab).kind}`} aria-hidden="true" />
            <span className="status-text" title={statusText(activeTab)}>
              {statusText(activeTab)}
            </span>
            {activeTab.workspace && <GitChip workspace={activeTab.workspace} signal={`${activeTab.id}:${tabStatus(activeTab).kind}`} onOpen={() => { if (activeTab.workspace) setGitWorkspace(activeTab.workspace); }} />}
          </>
        )}
        <span className="status-spacer" />
        {updates?.phase === "ready" && <button type="button" className="notification-toggle update-ready" onClick={() => { setSettingsPage("updates"); setSettingsOpen(true); }}>Update ready · {updates.version}</button>}
        <button type="button" className="notification-toggle" onClick={() => setRemoteOpen(true)}><Icon name="phone" size={13} />Connect phone</button>
        <button type="button" className="notification-toggle" aria-label="Background notifications" aria-pressed={desktop.notifications_enabled} title={desktop.notifications_enabled ? "Background notifications on — click to mute" : "Background notifications muted — click to enable"} onClick={() => void toggleNotifications()}><Icon name="bell" size={13} />{desktop.notifications_enabled ? "Notifications on" : "Notifications muted"}</button>
        <span className="footer-hint" title="Closing the window keeps Velum Code running. Use the tray menu or Ctrl+K → Quit to exit.">Runs in tray</span>
      </footer>
      </main>
      </div>
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <Suspense fallback={null}><SettingsPanel initialPage={settingsPage} updates={updates} onClose={() => { setSettingsOpen(false); setSettingsPage("appearance"); }} notifications={{ enabled: desktop.notifications_enabled, toggle: toggleNotifications, test: testNotification }} /></Suspense>}
      {remoteOpen && <Suspense fallback={null}><RemotePanel onClose={() => setRemoteOpen(false)} /></Suspense>}
      {boardWorkspace && <Suspense fallback={null}><KanbanPanel workspace={boardWorkspace} bots={bots} previewSchedule={(cron,timezone)=>invoke('automation_request',{request:{action:'preview',cron,timezone}})} request={request=>invoke<Board>("kanban_request",{workspace:boardWorkspace,request})} onClose={()=>setBoardWorkspace(null)} onWork={workOnCard}/></Suspense>}
      {gitWorkspace && <Suspense fallback={null}><GitPanel workspace={gitWorkspace} onClose={()=>setGitWorkspace(null)} /></Suspense>}
      {pluginPanel && <Suspense fallback={null}><PluginPanel plugins={plugins} selection={pluginPanel.selection} onClose={() => setPluginPanel(null)} onRefresh={refreshPlugins} workspace={activeTab?.workspace || ""} messages={() => pluginHandles.current.get(activeTab?.id)?.messages() || []} onInsert={text => { pluginHandles.current.get(activeTab?.id)?.insert(text); focusComposer(); }} /></Suspense>}
      {memory&&<Suspense fallback={null}><MemoryPanel initialFilter={memory.initialFilter} ownerName={bots.find(b=>b.id===memory.bot_id)?.name} seed={memory.seed} onClose={()=>setMemory(null)} request={(request)=>invoke<MemoryView>(memory.bot_id?'bots_memory':'memory_request',{workspace:memory.workspace,request,id:memory.bot_id})} openVault={()=>memory.bot_id?invoke('bots_open',{id:memory.bot_id,memory:true}):invoke("memory_open")}/></Suspense>}
      {botPanel&&<Suspense fallback={null}><BotsPanel initialPage={botPanel==='activity'?'activity':'profiles'} openMemory={id=>invoke('bots_open',{id,memory:true})} workspace={activeTab?.workspace||''} provider={activeTab?.provider||'muse'} options={activeTab?.options||{model:'',reasoning:''}} request={request=>invoke<BotView>('bots_request',{request})} automation={request=>invoke('automation_request',{request})} memory={(id,request)=>invoke<MemoryView>('bots_memory',{id,workspace:activeTab?.workspace||'',request})} loadModels={(provider,refresh)=>invoke<ModelCatalog>('provider_models',{provider,refresh})} openFolder={id=>invoke('bots_open',{id})} onClose={()=>setBotPanel(null)} chatLabel={botPanel==='handoff'?'Hand off':'Chat'} onChat={openBot} onChange={()=>void refreshBots()}/></Suspense>}
    </div>
  );
}
