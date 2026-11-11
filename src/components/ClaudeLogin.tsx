import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Icon, { VelumMark } from "./Icon";
import "./AntigravityLogin.css";

type ClaudeMode = "claudeai" | "console";
interface Status { phase: "starting" | "code" | "verifying" | "complete" | "error"; url: string | null; message: string }
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string | null;
  apiProvider?: string | null;
  email?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
}

export default function ClaudeLogin({ onClose, onAuthChanged }: { onClose: () => void; onAuthChanged?: (status: ClaudeAuthStatus | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef("");
  const [mode, setMode] = useState<ClaudeMode>("claudeai");
  const [attempt, setAttempt] = useState(0);
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus | null>(null);
  const [status, setStatus] = useState<Status>({ phase: "starting", url: null, message: "Preparing Claude sign-in…" });
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshAuthStatus = async () => {
    try {
      const next = await invoke<ClaudeAuthStatus>("claude_auth_status");
      setAuthStatus(next);
      onAuthChanged?.(next);
    } catch {
      /* Auth status check is informational. */
    }
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    void refreshAuthStatus();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const id = crypto.randomUUID(); current.current = id;
    let disposed = false;
    let timer: number | undefined;
    setCode(""); setError(""); setBusy(false);
    setStatus({ phase: "starting", url: null, message: "Preparing Claude sign-in…" });
    const starting = invoke("claude_login_start", { id, mode });
    const poll = async () => {
      try {
        const result = await invoke<Status>("claude_login_status", { id });
        if (disposed) return;
        setStatus(result);
        if (result.phase === "complete") {
          setCode("");
          void refreshAuthStatus();
          return;
        }
        if (result.phase === "error") { setCode(""); return; }
        timer = window.setTimeout(() => void poll(), 400);
      } catch {
        if (!disposed) setStatus({ phase: "error", url: null, message: "The sign-in session ended. Start again to get a fresh code." });
      }
    };
    void starting.then(() => { if (!disposed) void poll(); }).catch((e) => {
      if (!disposed) setStatus({ phase: "error", url: null, message: String(e) });
    });
    return () => {
      disposed = true; clearTimeout(timer);
      void starting.catch(() => {}).then(() => invoke("claude_login_cancel", { id })).catch(() => {});
    };
  }, [attempt, mode]);

  useEffect(() => { if (status.phase === "code") input.current?.focus(); }, [status.phase]);

  const submit = async () => {
    if (busy || status.phase !== "code" || !code.trim()) return;
    setBusy(true); setError("");
    const value = code.trim(); setCode("");
    try {
      await invoke("claude_login_submit", { id: current.current, code: value });
      setStatus({ phase: "verifying", url: null, message: "Checking your Claude sign-in…" });
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const next = await invoke<ClaudeAuthStatus>("claude_auth_logout");
      setAuthStatus(next);
      onAuthChanged?.(next);
      setAttempt((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const accountSummary = authStatus?.loggedIn
    ? [authStatus.email, authStatus.subscriptionType || authStatus.authMethod, authStatus.orgName].filter(Boolean).join(" · ")
    : "";

  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="auth-title" onCancel={onClose}>
    <button className="auth-close" aria-label="Close sign-in" onClick={onClose}><Icon name="close" /></button>
    <VelumMark size={48} />
    <span className="auth-eyebrow">YOUR PROVIDERS</span>
    <h2 id="auth-title">{status.phase === "complete" ? "You're connected." : "Connect Claude"}</h2>
    <p className="auth-description">{status.phase === "complete" ? "Your Claude account is ready. Return to your conversation and send your message when you're ready." : accountSummary ? `Currently signed in (${accountSummary}). Sign in below to refresh or switch accounts.` : "One Claude sign-in (`claude auth login`). Rock Claude right here in Velum Code."}</p>
    {status.phase !== "complete" && <div className="auth-modes" role="group" aria-label="Claude sign-in account type">
      <button type="button" className={`auth-mode${mode === "claudeai" ? " active" : ""}`} disabled={busy} onClick={() => setMode("claudeai")}>Claude subscription</button>
      <button type="button" className={`auth-mode${mode === "console" ? " active" : ""}`} disabled={busy} onClick={() => setMode("console")}>Anthropic Console API</button>
    </div>}
    <div className={`auth-status ${status.phase}`} role={status.phase === "error" ? "alert" : "status"}>{status.message}</div>
    {status.phase === "code" && <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="auth-step"><span>1</span><div><h3>Sign in with Claude</h3><p>Your browser will display a one-time authentication code after you approve.</p>
        <button type="button" className="auth-browser" onClick={() => void openUrl(status.url!).catch(() => setError("Could not open your browser. Try again."))}>Open Claude sign-in <Icon name="arrow" size={16} /></button></div></div>
      <div className="auth-step"><span>2</span><div><label htmlFor="auth-code">Paste your authentication code</label><input ref={input} id="auth-code" type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from your browser (including #state)" aria-describedby="auth-code-help" />
        <p id="auth-code-help">Paste the complete code string shown in your browser. Older codes won't work.</p></div></div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-primary" type="submit" disabled={busy || !code.trim()}>Connect Claude account</button>
    </form>}
    {status.phase !== "code" && error && <p className="auth-error" role="alert">{error}</p>}
    {status.phase === "complete" ? <button className="auth-primary" onClick={onClose}>Back to conversation</button> : <div className="auth-actions"><button onClick={onClose}>Cancel</button>{status.phase !== "starting" && <button disabled={busy} onClick={() => setAttempt((n) => n + 1)}>Start again</button>}{authStatus?.loggedIn && <button disabled={busy} onClick={() => void logout()}>Sign out</button>}</div>}
    <p className="auth-footnote">Claude Code saves credentials in its own credential store. Velum Code never stores your pasted code.</p>
  </dialog>;
}
