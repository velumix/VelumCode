import type { Provider, RunOptions } from "./providers";
import { invoke } from "@tauri-apps/api/core";
export interface SavedTab {
  bot_id?: string;
  task_id?: string;
  skill_ids?: string[];
  id: string;
  title: string;
  workspace?: string;
  provider: Provider;
  options: RunOptions;
}
const KEY = "velum-desktop-tabs-v1";
const DRAFT = "velum-desktop-draft-";
interface DesktopSnapshot { tabs: SavedTab[]; activeId: string }
let desktopCache: DesktopSnapshot | null = null;
const draftCache = new Map<string, string>();
let lastDesktopData = "";
let queued = false;
let writes: Promise<void> = Promise.resolve();
let writeError: string | null = null;
export let recoveryError: string | null = null;
function persist(command: string, args: Record<string, unknown>) {
  // Keep whole-desktop checkpoints and individual drafts in submission order.
  // Otherwise a slow checkpoint can replace a more recent draft in Rust.
  writes = writes.then(async () => {
    await invoke<void>(command, args);
    writeError = null;
  }).catch((error) => {
    writeError = String(error);
    window.dispatchEvent(
      new CustomEvent("velum:recovery-error", { detail: String(error) }),
    );
  });
}
export async function flushDesktop() {
  checkpoint();
  await Promise.resolve();
  let pending: Promise<void>;
  do { pending = writes; await pending; } while (pending !== writes);
  if (writeError) throw new Error(`Could not save the desktop before restarting: ${writeError}`);
}
function checkpoint() {
  if (queued) return;
  queued = true;
  // One native update per rendering batch. Disk snapshots are coalesced by Rust.
  queueMicrotask(() => {
    queued = false;
    const desktop = loadDesktop();
    const drafts = Object.fromEntries(
      desktop.tabs.map((t) => [t.id, readDraft(t.id)]),
    );
    persist("history_desktop_save", {
      snapshot: { ...desktop, drafts },
    });
  });
}
export async function initializeDesktop() {
  try {
    const saved = await invoke<{
      tabs: SavedTab[];
      activeId: string;
      drafts: Record<string, string>;
    } | null>("history_desktop_load");
    if (!saved || !Array.isArray(saved.tabs)) return;
    desktopCache = parseDesktop(saved);
    try { localStorage.setItem(KEY, JSON.stringify(desktopCache)); } catch { /* Native recovery remains available. */ }
    for (const tab of desktopCache.tabs) {
      const draft = saved.drafts?.[tab.id];
      const text = typeof draft === "string" ? draft.slice(0, 64000) : "";
      draftCache.set(tab.id, text);
      try {
        if (text) localStorage.setItem(DRAFT + tab.id, text);
        else localStorage.removeItem(DRAFT + tab.id);
      } catch { /* The in-memory draft is backed by the native checkpoint. */ }
    }
  } catch (error) {
    recoveryError = `Could not load the recovery checkpoint: ${String(error)}`;
  }
}
function parseDesktop(value: { tabs?: SavedTab[]; activeId?: string } | null): DesktopSnapshot {
  try {
    if (!value || !Array.isArray(value.tabs)) return { tabs: [], activeId: "" };
    const seen = new Set<string>();
    const tabs: SavedTab[] = value.tabs
      .slice(0, 32)
      .filter((t: SavedTab) => {
        if (
          !t ||
          typeof t.id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,150}$/.test(t.id) ||
          seen.has(t.id) ||
          !["muse", "codex", "antigravity"].includes(t.provider) ||
          typeof t.title !== "string" ||
          t.title.length > 200 ||
          (t.workspace !== undefined &&
            (typeof t.workspace !== "string" || t.workspace.length > 4096))
        )
          return false;
        seen.add(t.id);
        return true;
      })
      .map((t: SavedTab) => ({
        bot_id:typeof t.bot_id==='string'&&/^[a-f0-9-]{36}$/i.test(t.bot_id)?t.bot_id:undefined,
        task_id:typeof t.task_id==='string'&&/^[a-f0-9-]{36}$/i.test(t.task_id)?t.task_id:undefined,
        skill_ids:Array.isArray(t.skill_ids)?[...new Set(t.skill_ids.filter((id): id is string => typeof id==='string'&&/^[a-z][a-z0-9.-]{2,63}$/.test(id)&&!id.includes('..')&&!id.endsWith('.')))].slice(0,8):undefined,
        id: t.id,
        title: t.title,
        workspace: t.workspace,
        provider: t.provider,
        options: {
          model: typeof t.options?.model === "string" ? t.options.model : "",
          reasoning:
            typeof t.options?.reasoning === "string" ? t.options.reasoning : "",
        },
      }));
    return {
      tabs,
      activeId:
        typeof value.activeId === "string" &&
        tabs.some((t) => t.id === value.activeId)
          ? value.activeId
          : tabs[0]?.id || "",
    };
  } catch {
    return { tabs: [], activeId: "" };
  }
}
export function loadDesktop(): DesktopSnapshot {
  if (desktopCache) return desktopCache;
  try { desktopCache = parseDesktop(JSON.parse(localStorage.getItem(KEY) || "null")); }
  catch { desktopCache = { tabs: [], activeId: "" }; }
  return desktopCache;
}
export function saveDesktop(tabs: SavedTab[], activeId: string) {
  const desktop = {
    tabs: tabs.map(({ id, title, workspace, provider, options,bot_id,task_id,skill_ids }) => ({
      bot_id,task_id,skill_ids:skill_ids?.length?skill_ids:undefined,
      id,
      title,
      workspace,
      provider,
      options,
    })),
    activeId,
  };
  const data = JSON.stringify(desktop);
  desktopCache = desktop;
  if (lastDesktopData !== data) {
    lastDesktopData = data;
    const open = new Set(tabs.map(tab => tab.id));
    for (const id of draftCache.keys()) if (!open.has(id)) draftCache.delete(id);
    try { localStorage.setItem(KEY, data); } catch { /* Native checkpoints do not depend on browser storage. */ }
    checkpoint();
  }
}
export function readDraft(id: string) {
  if (draftCache.has(id)) return draftCache.get(id)!;
  let text = "";
  try {
    text = (localStorage.getItem(DRAFT + id) || "").slice(0, 64000);
  } catch { /* Native recovery or the current editor can supply the draft. */ }
  draftCache.set(id, text);
  return text;
}
export function saveDraft(id: string, text: string) {
  text = text.slice(0, 64000);
  if (readDraft(id) === text) return;
  draftCache.set(id, text);
  try {
    if (text) localStorage.setItem(DRAFT + id, text);
    else localStorage.removeItem(DRAFT + id);
  } catch { /* Preserve the draft in memory and still submit the native save. */ }
  persist("history_draft_save", { tabId: id, text });
}
