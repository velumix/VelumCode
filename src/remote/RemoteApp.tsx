import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clearDrafts, loadDrafts, saveDrafts, loadSelection, saveSelection } from "./drafts";
import type { MemoryView } from "../memory";
const MemoryPanel=lazy(()=>import("../components/MemoryPanel"));
const KanbanPanel=lazy(()=>import("../components/KanbanPanel"));
import { taskPrompt, type Board } from "../kanban";
import type {BotProfile,BotView} from '../bots';
import BotAvatar from '../components/BotAvatar';
const BotsPanel=lazy(()=>import('../components/BotsPanel'));
import { providerNames, defaultOptions, type ModelCatalog } from "../providers";
import Icon, { VelumMark } from "../components/Icon";
import Markdown from "../components/Markdown";
import { transcript, type Block, type Replay, type Session } from "./transcript";
import { usePreferences } from "../preferences";
import MessageQueue from '../components/MessageQueue';
import AgentActivity from '../components/AgentActivity';
import CorrectionComposer from '../components/CorrectionComposer';
import RequestRecovery from '../components/RequestRecovery';
import InteractionPanel, { PermissionRecord } from '../components/InteractionPanel';
import { emptyInteractions, mergeInteractionResponse, type InteractionSnapshot } from '../interactions';
import { correctionPrompt, friendlyTool, groupActivity, lastMatch, latestRecovery, lessonTitle } from '../conversationUX';
const SettingsPanel = lazy(() => import("../components/SettingsPanel"));

import ModelControls from "../components/ModelControls";
import UsageStrip from "../components/UsageStrip";
import ProviderWait from '../components/ProviderWait';
import { attachment, chatSnapshot, type Diagnostics } from '../context';
import { ClientMeasurement } from '../turnMeasurement';
const ContextPanel = lazy(() => import('../components/ContextPanel'));

interface Device { id: string; name: string; control: boolean }
interface Pending { name: string; code: string; expires_at: number }
interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
const usb = location.origin === "http://127.0.0.1:43827";
function PhoneTool({ block }: { block: Block }) {
  const { settings } = usePreferences();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? settings.toolOutput === "expanded";
  const text = block.text || "Waiting for output…";
  return <div className="phone-tool"><button type="button" className="phone-tool-head" aria-expanded={open} onClick={() => setOverride(!open)}><Icon name="code" size={15} /><strong>{friendlyTool(block.name || "tool")}</strong><span>{block.status}</span><Icon name="down" size={14}/></button>{(open || settings.toolOutput !== "collapsed") && <pre>{open ? text : text.split("\n").slice(0, 3).join("\n")}</pre>}</div>;
}
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json", "X-Muse-Request": "1" }, body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(value.error || `Could not connect (${response.status}).`, response.status);
  return value as T;
}
function secret() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""); }
function storedClaim(): string { try { return sessionStorage.getItem("muse-pair-claim") || ""; } catch { return ""; } }
function saveClaim(value: string) { try { if (value) sessionStorage.setItem("muse-pair-claim", value); else sessionStorage.removeItem("muse-pair-claim"); } catch { /* Pairing still works without storage. */ } }
function mergeReplay(previous: Replay | undefined, next: Replay): Replay {
  const events = [...(!next.truncated ? previous?.events || [] : []), ...next.events].slice(-8000);
  let size = 0;
  let start = events.length;
  while (start > 0) { const length = JSON.stringify(events[start - 1]).length; if (size + length > 2 * 1024 * 1024) break; size += length; start--; }
  return { ...next, events: events.slice(start), truncated: next.truncated || !!previous?.truncated || start > 0 };
}

export default function RemoteApp() {
  const {settings} = usePreferences();
  const [invitation, setInvitation] = useState(() => new URLSearchParams(location.hash.slice(1)).get("pair") || "");
  const [claim, setClaim] = useState(storedClaim);
  const [pending, setPending] = useState<Pending | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [computer, setComputer] = useState("");
  const [name, setName] = useState("My phone");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState(loadSelection);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftsReady, setDraftsReady] = useState(false);
  const draftGeneration = useRef(0);
  const [memorySession,setMemorySession]=useState("");
  const [boardSession,setBoardSession]=useState("");
  const [botsOpen,setBotsOpen]=useState(false);
  const [context, setContext] = useState<{id:string;snapshot:string}|null>(null);
  useEffect(() => { if (context && (!device || !sessions.some(s => s.id === context.id))) setContext(null); }, [context, device, sessions]);
  const [bots,setBots]=useState<BotProfile[]>([]);
  const [memorySeed,setMemorySeed]=useState<string>();
  const [listOpen, setListOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [signout, setSignout] = useState(false);
  const [correction, setCorrection] = useState<{session:string;id:number;answer:string}|null>(null);
  useEffect(()=>{setCorrection(null);},[selected,device?.id]);
  const cache = useRef(new Map<string, Replay>());
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const input = drafts[selected] || "";
  const current = sessions.find((s) => s.id === selected);
  const view = useMemo(() => transcript(replay?.events || []), [replay]);
  const lastAssistant = lastMatch(view.blocks,block=>block.kind==='assistant');
  const recoveryNotice = latestRecovery(view.blocks);
  async function rememberLesson(lesson: string) {
    if (!current || !device?.control || !connected) throw new Error('Reconnect with control access before saving guidance.');
    const botPath = current.bot ? `bots/${encodeURIComponent(current.bot.id)}/` : '';
    const saved = await api<MemoryView>(`/sessions/${encodeURIComponent(selected)}/${botPath}memory`,{action:'save_lesson',title:lessonTitle(lesson),body:lesson.trim()});
    return saved.settings.enabled ? undefined : 'Lesson saved. Memory is off for this project; enable it in Memory to use saved guidance.';
  }

  const discardDrafts = () => { draftGeneration.current++; setDrafts({}); clearDrafts(); };
  const forget = () => { setDevice(null); setSessions([]); setReplay(null); cache.current.clear(); setConnected(false); discardDrafts();setMemorySession("");setBoardSession("");setMemorySeed(undefined);setBotsOpen(false);setBots([]); saveClaim(""); setClaim(""); };
  useEffect(() => {
    let disposed = false;
    const generation = draftGeneration.current;
    void loadDrafts().then(saved => {
      if (!disposed) {
        if (draftGeneration.current === generation) setDrafts(saved);
        setDraftsReady(true);
      }
    });
    return () => { disposed = true; };
  }, []);
  useEffect(()=>{if(!device||!connected||(!boardSession&&!botsOpen))return;let alive=true;void api<BotView>('/bots',{action:'list'}).then(v=>{if(alive)setBots(v.profiles||[]);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[device,connected,boardSession,botsOpen]);
  useEffect(()=>{if(device && draftsReady)saveDrafts(drafts);},[drafts,device,draftsReady]);
  useEffect(()=>{if(device&&selected)saveSelection(selected);},[selected,device]);

  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname);
    let disposed = false;
    api<{ device: Device; computer: string }>("/me").then((value) => {
      if (!disposed) { setDevice(value.device); setInvitation(""); setComputer(value.computer || "Your desktop"); saveClaim(""); setClaim(""); }
    }).catch((e) => { if(disposed)return; if(e instanceof ApiError&&e.status===401){discardDrafts();}else setError(usb ? "Check the USB cable and choose Reconnect in Connect phone on your desktop." : "Your desktop is unavailable. Connect Tailscale and make sure Velum Code is running."); })
      .finally(() => { if (!disposed) setLoading(false); });
    const installable = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    window.addEventListener("beforeinstallprompt", installable);
    return () => { disposed = true; window.removeEventListener("beforeinstallprompt", installable); };
  }, []);

  useEffect(() => {
    if (!claim || device) return;
    let disposed = false;
    let timer: number;
    const poll = async () => {
      try {
        const value = await api<{ status: string; device?: Device; pending?: Pending }>("/pair/finish", { claim });
        if (disposed) return;
        if (value.device) { setDevice(value.device); setInvitation(""); setPending(null); setClaim(""); saveClaim(""); setError(""); return; }
        if (value.pending) setPending(value.pending);
      } catch (e) {
        if (disposed) return;
        setError(String(e instanceof Error ? e.message : e));
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) { setPending(null); setClaim(""); saveClaim(""); return; }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 1800);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [claim, device]);

  useEffect(() => {
    if (!device) return;
    let disposed = false;
    let inFlight = false;
    let again = false;
    let debounce: number;
    const refresh = async () => {
      if (disposed) return;
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const value = await api<{ sessions: Session[] }>("/sessions");
        if (disposed) return;
        setSessions(value.sessions);
        for (const id of cache.current.keys()) if (!value.sessions.some((s) => s.id === id)) cache.current.delete(id);
        const id = value.sessions.some((s) => s.id === selected) ? selected : value.sessions[0]?.id || "";
        if (id !== selected) { setSelected(id); setReplay(null); follow.current = true; return; }
        const item = value.sessions.find((s) => s.id === id);
        if (item) {
          const previous = cache.current.get(id);
          if (!previous || previous.session.revision !== item.revision) {
            const next = await api<Replay>(`/sessions/${encodeURIComponent(id)}?after=${previous?.session.revision || 0}`);
            if (disposed) return;
            const merged = mergeReplay(previous, next);
            cache.current.set(id, merged); setReplay(merged);
          } else { setReplay(previous); }
        } else { setReplay(null); }
        setConnected(true);
      } catch (e) {
        if (disposed) return;
        setConnected(false);
        if (e instanceof ApiError && e.status === 401) { forget(); setError("This phone was disconnected. Scan a new QR code on your desktop."); }
      } finally {
        inFlight = false;
        if (again && !disposed) { again = false; debounce = window.setTimeout(() => void refresh(), 100); }
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const source = new EventSource("/api/events");
    source.addEventListener("change", () => { clearTimeout(debounce); debounce = window.setTimeout(() => void refresh(), 100); });
    source.addEventListener("revoked", () => { if (!disposed) { forget(); setError(usb ? "This phone was disconnected. Choose Connect phone → USB cable on your desktop to reconnect." : "This phone was disconnected. Scan a new QR code."); } });
    source.onerror = () => { if (!disposed) setConnected(false); };
    const wake = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; source.close(); clearInterval(timer); clearTimeout(debounce); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [device?.id, selected]);

  useLayoutEffect(() => {
    if (follow.current && scroll.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setLatest(false); }
  }, [replay, selected]);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const resize = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight; });
    resize.observe(element);
    return () => resize.disconnect();
  }, [device?.id]);

  const pair = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const claim = secret();
      const value = await api<{ pending: Pending }>("/pair/claim", { invitation, claim, name });
      saveClaim(claim); setClaim(claim); setPending(value.pending);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const send = async () => {
    const prompt = input.trim();
    if (busy || !prompt || !current || !connected || !device?.control) return;
    const id = selected;
    setBusy(true); setError(""); follow.current = true;
    try {
      await api(`/sessions/${encodeURIComponent(id)}/send`, { prompt });
      setDrafts((drafts) => ({ ...drafts, [id]: drafts[id]?.trim() === prompt ? "" : drafts[id] }));
      await refreshRef.current();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection interrupted. Reconnect and check the conversation before sending again."); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    if (busy || !current?.running || !connected) return;
    setBusy(true); setError("");
    try { await api(`/sessions/${encodeURIComponent(selected)}/stop`, {}); await refreshRef.current(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try { await api("/logout", {}); forget(); setSignout(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!device) return <main className="phone-entry">
    <div className="phone-entry-brand"><VelumMark size={52} /><span>Velum Code</span></div>
    <div className="phone-entry-card">
      <div className="phone-eyebrow"><Icon name="shield" size={15} />Your private workspace</div>
      <h1>{loading ? "Finding your desktop…" : claim ? "One last check." : invitation ? "Meet your desktop, here." : "Your desktop. In your pocket."}</h1>
      <p>{claim ? "Confirm this connection in Velum Code on your desktop. Keep this screen open." : invitation ? "Pair this phone to follow your agent and keep work moving, wherever you are." : usb ? "Open Connect phone on your desktop, choose USB cable, and connect this phone." : "Open Velum Code on your desktop, choose Connect phone, and scan its QR code."}</p>
      {error && <div className="phone-error" role="alert">{error}</div>}
      {claim ? <><div className="phone-pair-code" aria-label="Pairing code">{pending?.code || "Waiting…"}</div><div className="phone-wait"><span className="phone-pulse" />Waiting for desktop confirmation</div></> : !loading && invitation ? <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
        <label htmlFor="phone-name">Name this phone</label><input id="phone-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <button className="phone-primary" disabled={busy || !name.trim()}>{busy ? "Connecting…" : "Pair with desktop"}<Icon name="arrow" size={18} /></button>
      </form> : null}
      <div className="phone-entry-note"><Icon name="shield" size={16} /><span>{usb ? "Connected through your USB cable." : "Connect Tailscale on both devices."}<br />Your conversations stay on your private connection.</span></div>
    </div>
    <p className="phone-entry-footer">Made for the moments away from your desk.</p>
  </main>;

  return <main className="phone-app">
    <header className="phone-header"><VelumMark size={35} /><div><h1>Velum Code</h1><span className={connected ? "phone-online" : "phone-offline"}><i />{connected ? "Desktop connected" : "Reconnecting…"}</span></div>
      <button className="phone-icon-button" aria-label="Phone settings" onClick={() => setInstallHelp((value) => !value)}><Icon name="phone" size={21} /></button>
    </header>
    <nav className="phone-tools" aria-label="Workspace tools"><button disabled={!current||!connected} onClick={()=>setBotsOpen(true)}><Icon name="chat" size={17}/>Bots</button><button aria-label="Kanban" disabled={!current||!connected} onClick={()=>setBoardSession(selected)}><Icon name="board" size={17}/>Kanban</button><button aria-label="Memory" disabled={!current||!connected} onClick={()=>{setMemorySeed(undefined);setMemorySession(selected);}}><Icon name="memory" size={17}/>Memory</button>{current && <button type="button" className="phone-context" aria-label="Project context & diagnostics" title="Project context & diagnostics" disabled={!connected} onClick={e => setContext({id:current.id,snapshot:chatSnapshot(e.currentTarget.closest('.phone-app'),current.provider || 'muse',current.options || defaultOptions,current.running,'phone')})}><Icon name="settings" size={18}/><span>Context</span></button>}</nav>
    {installHelp && <section className="phone-settings" aria-label="Phone settings"><strong>{device.name}</strong><p>{computer || "Your desktop"}</p><p>{device.control ? "View and control · standard agent permissions" : "View-only access"}</p>
      <button type="button" onClick={() => setAppearanceOpen(true)}>Appearance & preferences</button>
      {install ? <button onClick={() => void install.prompt().then(() => setInstall(null))}>Add to home screen</button> : <p>Use your browser menu → Add to Home screen or Install app.</p>}
      <button onClick={() => setSignout(true)}>Disconnect this phone</button>
      {signout && <div className="phone-signout"><p>You’ll need to scan a new QR code to reconnect.</p><button disabled={busy} onClick={() => void disconnect()}>Disconnect</button><button onClick={() => setSignout(false)}>Keep connected</button></div>}
    </section>}
    <div className="phone-conversations">
    <button className="phone-session-select" aria-expanded={listOpen} aria-controls="phone-sessions" onClick={() => setListOpen((value) => !value)}>{current?.bot&&<BotAvatar bot={current.bot} size={30}/>}<span><span className="phone-eyebrow">{current?.bot?.name||'Conversation'}</span><strong>{current?.title || "Your conversations"}</strong></span><Icon name="down" size={18} /></button>
    {listOpen && <nav className="phone-sessions" id="phone-sessions" aria-label="Conversations">{sessions.map((session) => <button key={session.id} aria-current={session.id === selected ? "true" : undefined} onClick={() => { setSelected(session.id); setReplay(cache.current.get(session.id) || null); setListOpen(false); follow.current = true; setError(""); }}>{session.bot?<BotAvatar bot={session.bot} size={28}/>:<Icon name="chat" size={18}/>}<span><strong>{session.title}</strong><small>{session.bot?.name||providerNames[session.provider || "muse"]} · {session.workspace.split(/[\\/]/).filter(Boolean).pop()}</small></span><i className={session.running ? "working" : ""}>{session.running ? "Working" : session.status === "completed" ? "Done" : "Ready"}</i></button>)}</nav>}
    </div>
    {current && <details className="phone-assistant-controls" open={!settings.compactControls}><summary><span>{current.bot?.name || providerNames[current.provider || 'muse']}</span><span>Assistant settings<Icon name="down" size={13}/></span></summary><div className="phone-models"><ModelControls key={current.id} provider={current.provider || "muse"} options={current.options || defaultOptions} disabled={busy || !connected || current.running || !!current.queue?.items.length || !device.control} load={(provider, refresh) => api<ModelCatalog>(`/providers/${provider}/models?refresh=${refresh}`)} onChange={async (options) => {
      const id = current.id;
      setBusy(true);
      try {
        await api(`/sessions/${encodeURIComponent(id)}/options`, options);
        setSessions((sessions) => sessions.map((s) => s.id === id ? { ...s, options } : s));
        await refreshRef.current();
      } finally { setBusy(false); }
    }} /></div></details>}
    {!connected && <div className="phone-reconnect" role="status">{usb ? "Check your USB cable and keep your desktop awake." : "Reconnect Tailscale and keep your desktop awake."} Your draft is safe.<button onClick={() => void refreshRef.current()}>Retry</button></div>}
    <div className="phone-transcript" ref={scroll} onScroll={() => { const el = scroll.current; if (el) { follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setLatest(!follow.current); } }}>
      {!sessions.length ? <div className="phone-empty"><Icon name="chat" size={32} /><h2>No conversations yet</h2><p>Open an Agent conversation on your desktop. It will appear here automatically.</p></div> : !view.blocks.length && !replay?.interactions?.requests.length ? <div className="phone-empty"><VelumMark size={64} /><h2>What’s next?</h2><p>Send a message to your desktop agent. Your files and tools stay on your computer.</p></div> : null}
      {replay?.truncated && <p className="phone-history-note">Showing recent activity. Earlier messages remain in the desktop conversation.</p>}
      {groupActivity(view.blocks,settings.groupActivity).map(row=>{
        if(row.kind==='activity_group'){
          const currentTool=lastMatch(row.items,tool=>tool.status==='running');
          return <AgentActivity key={`activity-${row.id}`} count={row.items.length} current={currentTool?.name || 'Working'} busy={!!currentTool} stopped={row.items.some(tool=>tool.status==='cancelled')} failed={row.items.some(tool=>['failed','blocked','rejected'].includes(tool.status || ''))}>{row.items.map(tool=><PhoneTool key={tool.id} block={tool}/>)}</AgentActivity>;
        }
        const block=row.block;
        return block.kind==='approval'?<PermissionRecord key={block.id} status={block.status || 'resolved'} tool={block.name} details={block.text}/>:block.kind==='tool'?<PhoneTool block={block} key={block.id}/>:block.kind==='notice'?<div className="phone-notice" key={`${selected}-${block.id}`}><span>{block.text}</span>
          {block.recovery && recoveryNotice?.id === block.id && device.control && current && !current.running && replay?.session.id === selected && <RequestRecovery
            request={block.recovery} disabled={!connected || busy} maxLength={16000}
            queued={!!(current.queue || view.queue).items.length || (current.queue || view.queue).paused} paused={(current.queue || view.queue).paused}
            submit={async prompt => {
              if (!connected || busy || !device.control || current.running) return false;
              const target = selected;
              setBusy(true); setError(''); follow.current = true;
              try {
                await api(`/sessions/${encodeURIComponent(target)}/send`, { prompt });
                await refreshRef.current();
                return true;
              } finally { setBusy(false); }
            }}
          />}
        </div>:<article className={`phone-message ${block.kind}`} key={block.id}><div className="phone-message-label">{block.kind === "user" ? "You" : <>{current?.bot?<BotAvatar bot={current.bot} size={24}/>:<VelumMark size={20}/>}<span>{current?.bot?.name||providerNames[current?.provider || "muse"]}</span></>}</div>{block.kind === "user" ? <p>{block.text}</p> : <Markdown text={block.text} />}{device.control&&<button type="button" className="phone-remember" aria-label="Remember this message" disabled={!connected||!!current?.running} onClick={()=>{setMemorySeed(block.text);setMemorySession(selected);}}><Icon name="memory" size={14}/>Remember</button>}
          {block.kind==='assistant' && device.control && (!current?.running || block.id!==lastAssistant?.id) && <div className="response-actions"><button type="button" disabled={!connected} onClick={()=>setCorrection({session:selected,id:block.id,answer:block.text})}><Icon name="edit" size={14}/>Correct response</button></div>}
          {correction?.session===selected && correction.id===block.id && <CorrectionComposer running={!!current?.running} disabled={!connected || !device.control || busy} owner={current?.bot?.name} onClose={()=>setCorrection(null)} remember={rememberLesson} submit={async(text,lesson)=>{
            if(!connected || !device.control || busy) throw new Error('Reconnect before sending this correction.');
            const target=selected;
            await api(`/sessions/${encodeURIComponent(target)}/send`,{prompt:correctionPrompt(block.text,text)});
            let notice:string|undefined;
            if(lesson){try{notice=await rememberLesson(lesson);}catch(error){return {sent:true,remembered:false,error:`Correction sent. The lesson could not be saved: ${String(error)}`};}}
            await refreshRef.current();
            return {sent:true,remembered:!!lesson,notice};
          }}/>}</article>;
      })}
      {replay?.session.id === selected && <InteractionPanel
        snapshot={replay.interactions || emptyInteractions()}
        canRespond={!!device.control && connected}
        disabledReason={connected ? 'Control access is required to answer this request.' : 'Reconnect to your desktop to answer this request.'}
        onRefresh={() => refreshRef.current()}
        onRespond={async decision => {
          if (!device.control || !connected) throw new Error('Reconnect with control access before responding.');
          const target = selected;
          const next = await api<InteractionSnapshot>(`/sessions/${encodeURIComponent(target)}/respond`, decision);
          const previous = cache.current.get(target);
          if (previous?.interactions) cache.current.set(target, { ...previous, interactions: mergeInteractionResponse(previous.interactions, next) });
          setReplay(previous => previous?.session.id === target && previous.interactions ? { ...previous, interactions: mergeInteractionResponse(previous.interactions, next) } : previous);
          await refreshRef.current();
        }}
      />}
      {view.todos.length > 0 && <details className="phone-todos"><summary>Task checklist <span>{view.todos.filter((todo) => todo.status === "completed").length}/{view.todos.length}</span></summary>{view.todos.map((todo, index) => <p key={index}><Icon name={todo.status === "completed" ? "check" : "code"} size={14} />{todo.text}</p>)}</details>}
      {current?.running && !(replay?.session.id === selected && replay.interactions?.active && replay.interactions.requests.some(request => ['pending', 'submitting'].includes(request.status))) && <div className="phone-working" role="status"><span className="phone-pulse" />{current.status === 'awaiting_review' ? 'Waiting for your response…' : view.providerProgress?.phase === 'retrying' ? <ProviderWait progress={view.providerProgress} provider={current.provider || 'muse'}/> : view.activity || `${current?.bot?.name||providerNames[current?.provider || "muse"]} is working…`}</div>}
    </div>
    {latest && !correction && <button className="phone-latest" onClick={() => { follow.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setLatest(false); }}>Latest activity <Icon name="down" size={15} /></button>}
    <footer className="phone-composer">
      <UsageStrip key={selected} usage={view.usage} memory={view.memory} provider={current?.provider || "muse"} running={!!current?.running} elapsed={view.usage.turn?.elapsed_ms ?? null} active={!!current} />
      <MessageQueue key={`queue-${selected}`} queue={current?.queue ?? view.queue} running={!!current?.running} readOnly={!device.control} maxLength={16000} onAction={async request => {
        if (!current || !device.control || !connected) throw new Error('Reconnect to your desktop to change the queue.');
        await api(`/sessions/${encodeURIComponent(selected)}/queue`, request);
        await refreshRef.current();
      }} />
      {error && <div className="phone-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" size={15} /></button></div>}
      {device.control ? <form onSubmit={(e) => { e.preventDefault(); void send(); }}><textarea aria-label="Message your desktop agent" placeholder={current?.running ? "Write your next thought…" : "Message your desktop agent…"} value={input} maxLength={16_000} rows={2} disabled={!selected || !draftsReady} onChange={(e) => setDrafts((drafts) => ({ ...drafts, [selected]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        {current?.running && <button type="button" className="phone-stop" disabled={busy || !connected} onClick={() => void stop()} aria-label="Stop task"><span />Stop</button>}<button className="phone-send" aria-label={current?.running || (current?.queue ?? view.queue).items.length ? 'Queue message' : 'Send message'} disabled={busy || !connected || !input.trim() || !selected}><Icon name="arrow" size={21} /></button>
      </form> : <p className="phone-view-only"><Icon name="shield" size={15} />View-only access</p>}
      <span className="phone-composer-note">{current?.workspace.split(/[\\/]/).filter(Boolean).pop() || "Velum Code"} · runs on your desktop</span>
    </footer>
    {memorySession&&<Suspense fallback={null}><MemoryPanel ownerName={sessions.find(s=>s.id===memorySession)?.bot?.name} seed={memorySeed} readOnly={!device.control||!connected} request={request=>{const bot=sessions.find(s=>s.id===memorySession)?.bot;return api<MemoryView>(`/sessions/${encodeURIComponent(memorySession)}/${bot?`bots/${bot.id}/`:''}memory`,request);}} onClose={()=>{setMemorySession("");setMemorySeed(undefined);}}/></Suspense>}
    {boardSession&&<Suspense fallback={null}><KanbanPanel bots={bots} previewSchedule={(cron,timezone)=>api(`/sessions/${encodeURIComponent(boardSession)}/automation`,{action:'preview',cron,timezone})} workspace={sessions.find(s=>s.id===boardSession)?.workspace||"Workspace"} readOnly={!device.control||!connected} request={request=>api<Board>(`/sessions/${encodeURIComponent(boardSession)}/kanban`,request)} onClose={()=>setBoardSession("")} onWork={async card=>{
      let target=boardSession;
      if(card.assignment&&sessions.find(s=>s.id===boardSession)?.bot?.id!==card.assignment.bot_id){const opened=await api<{id:string}>(`/sessions/${encodeURIComponent(boardSession)}/bots/${card.assignment.bot_id}/chat`,{});target=opened.id;await refreshRef.current();}
      const prompt=[drafts[target],taskPrompt(card)].filter(Boolean).join("\n\n");
      if(prompt.length>16000)throw new Error("Your message is too long. Shorten the current draft first.");
      setDrafts(drafts=>({...drafts,[target]:prompt}));setSelected(target);setBoardSession("");
    }}/></Suspense>}
    {botsOpen&&current&&<Suspense fallback={null}><BotsPanel workspace={current.workspace} provider={current.provider||'muse'} options={current.options||defaultOptions} readOnly={!device.control||!connected} request={request=>api<BotView>('/bots',request)} automation={request=>api(`/sessions/${encodeURIComponent(selected)}/automation`,request)} memory={(id,request)=>api<MemoryView>(`/sessions/${encodeURIComponent(selected)}/bots/${encodeURIComponent(id)}/memory`,request)} loadModels={(provider,refresh)=>api<ModelCatalog>(`/providers/${provider}/models?refresh=${refresh}`)} onClose={()=>setBotsOpen(false)} onChat={device.control?(async bot=>{const result=await api<{id:string}>(`/sessions/${encodeURIComponent(selected)}/bots/${bot.id}/chat`,{});setSelected(result.id);setReplay(null);setBotsOpen(false);await refreshRef.current();}):undefined}/></Suspense>}
    {context && <Suspense fallback={null}><ContextPanel key={context.id} snapshot={context.snapshot} load={async () => { const report=await api<Diagnostics>(`/sessions/${encodeURIComponent(context.id)}/diagnostics`);return {...report,client_measurement:new ClientMeasurement().report(report.turn_measurement)}; }} onClose={() => setContext(null)} onAttach={device.control && connected ? (label, text) => {
      const extra = attachment(label, text);
      if ((drafts[context.id] || '').length + extra.length > 16000) throw new Error('Shorten your draft before adding this report, or copy it instead.');
      setDrafts(previous => ({...previous, [context.id]:(previous[context.id] || '') + extra})); setContext(null);
    } : undefined}/></Suspense>}
    {appearanceOpen && <Suspense fallback={null}><SettingsPanel phone onClose={() => setAppearanceOpen(false)} /></Suspense>}
  </main>;
}
