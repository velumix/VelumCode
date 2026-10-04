import { useEffect, useRef } from "react";
import type { Provider, RunOptions } from "../providers";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { usePreferences } from "../preferences";
import { codeFonts, terminalTheme } from "../appearance";

export type PtyStatus =
  | { kind: "starting" }
  | { kind: "running"; backend: string }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

export interface TerminalHandles {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

interface TerminalViewProps {
  provider: Provider;
  options: RunOptions;
  sessionId: string;
  active: boolean;
  /** Bump to tear down the session and spawn a fresh one. */
  sessionKey: number;
  workspace?: string;
  resumeConversation?: boolean;
  onStatus: (sessionId: string, status: PtyStatus) => void;
  onHandles: (sessionId: string, handles: TerminalHandles | null) => void;
}

export default function TerminalView({ provider, options, sessionId, active, sessionKey, workspace, resumeConversation, onStatus, onHandles }: TerminalViewProps) {
  const { settings, systemDark } = usePreferences();
  const appearanceRef = useRef({ settings, systemDark });
  appearanceRef.current = { settings, systemDark };
  const optionsRef = useRef(options); optionsRef.current = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<{ id: string; term: Terminal; fit: FitAddon } | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const handlesRef = useRef(onHandles);
  handlesRef.current = onHandles;
  // Latest teardown promise; the next mount awaits it so a restart's
  // kill always lands before its replacement spawn.
  const killRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let spawned = false;
    let exited = false;
    const nativeId = `${sessionId}-terminal-${crypto.randomUUID()}`;
    const { settings: initial, systemDark: initialDark } = appearanceRef.current;
    const term = new Terminal({
      cursorBlink: initial.terminalBlink && initial.motion !== "reduced" && !matchMedia("(prefers-reduced-motion: reduce)").matches,
      cursorStyle: initial.terminalCursor,
      fontFamily: codeFonts[initial.codeFont],
      fontSize: initial.terminalFontSize,
      lineHeight: initial.terminalLineHeight,
      scrollback: initial.terminalScrollback,
      theme: terminalTheme(initial, initialDark),
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch(() => {});
      }),
    );
    term.open(el);
    fit.fit();
    liveRef.current = { id: nativeId, term, fit };
    handlesRef.current(sessionId, { id: nativeId, term, fit, search });

    const unlistens: Array<() => void> = [];
    const setStatus = (s: PtyStatus) => {
      if (!disposed) statusRef.current(sessionId, s);
    };
    setStatus({ kind: "starting" });

    // Attach listeners before spawning so early output can't be missed.
    const setup = (async () => {
      try {
        await killRef.current;
        if (disposed) return;
        unlistens.push(
          await listen<{ id: string; data: string }>("pty-data", (e) => {
            if (!disposed && e.payload.id === nativeId) term.write(e.payload.data);
          }),
        );
        if (disposed) return;
        unlistens.push(
          await listen<{ id: string; code: number | null }>("pty-exit", (e) => {
            if (e.payload.id === nativeId) {
              exited = true;
              setStatus({ kind: "exited", code: e.payload.code });
            }
          }),
        );
        if (disposed) return;
        const info = await invoke<{ id: string; backend: string }>("pty_spawn", {
          provider,
          options: optionsRef.current,
          id: nativeId,
          workspace,
          resumeTabId: resumeConversation ? sessionId : null,
          cols: Math.max(1, term.cols),
          rows: Math.max(1, term.rows),
        });
        spawned = true;
        if (!exited) setStatus({ kind: "running", backend: info.backend });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    term.onData((data) => {
      if (spawned && !disposed && !exited) invoke("pty_write", { id: nativeId, data }).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      if (disposed || !spawned || !el.clientWidth || !el.clientHeight) return;
      try {
        fit.fit();
        invoke("pty_resize", {
          id: nativeId,
          cols: Math.max(1, term.cols),
          rows: Math.max(1, term.rows),
        }).catch(() => {});
      } catch {
        // Resize during teardown; safe to ignore.
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const unlisten of unlistens) unlisten();
      liveRef.current = null;
      handlesRef.current(sessionId, null);
      term.dispose();
      killRef.current = setup.then(async () => {
        for (const unlisten of unlistens) unlisten();
        await invoke("pty_kill", { id: nativeId });
      }).catch(() => {});
    };
  }, [sessionId, sessionKey, workspace, provider, resumeConversation]);

  // Change the renderer in place. Appearance never restarts the native PTY or
  // discards its buffer. Unrelated settings also preserve per-tab zoom.
  const previousSize = useRef(settings.terminalFontSize);
  useEffect(() => {
    const live = liveRef.current;
    if (!live) return;
    live.term.options.theme = terminalTheme(settings, systemDark);
    live.term.options.fontFamily = codeFonts[settings.codeFont];
    if (previousSize.current !== settings.terminalFontSize) live.term.options.fontSize = settings.terminalFontSize;
    previousSize.current = settings.terminalFontSize;
    live.term.options.lineHeight = settings.terminalLineHeight;
    live.term.options.scrollback = settings.terminalScrollback;
    live.term.options.cursorStyle = settings.terminalCursor;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const blink = () => { if (liveRef.current === live) live.term.options.cursorBlink = settings.terminalBlink && settings.motion !== "reduced" && !motion.matches; };
    blink(); motion.addEventListener("change", blink);
    const frame = requestAnimationFrame(() => {
      if (!active || liveRef.current !== live) return;
      try { live.fit.fit(); void invoke("pty_resize", { id: live.id, cols: Math.max(1, live.term.cols), rows: Math.max(1, live.term.rows) }).catch(() => {}); } catch { /* Teardown. */ }
    });
    return () => { cancelAnimationFrame(frame); motion.removeEventListener("change", blink); };
  }, [settings, systemDark, active, sessionKey, workspace, provider]);

  // Hidden tabs have no layout box; refit once this tab becomes visible.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const live = liveRef.current;
      if (!live) return;
      try {
        live.fit.fit();
        invoke("pty_resize", {
          id: live.id,
          cols: Math.max(1, live.term.cols),
          rows: Math.max(1, live.term.rows),
        }).catch(() => {});
      } catch {
        // Tearing down; safe to ignore.
      }
      live.term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, sessionId]);

  return <div ref={containerRef} className={active ? "terminal-host" : "terminal-host hidden"} />;
}
