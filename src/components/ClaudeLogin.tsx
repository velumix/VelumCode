import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon, { VelumMark } from "./Icon";
import "./AntigravityLogin.css";

type ClaudeMode = "claudeai" | "console";
interface Status { phase: "starting" | "browser" | "complete" | "error"; url: string | null; message: string }
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string | null;
  apiProvider?: string | null;
  email?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
}

/**
 * Claude Code signs in through its own browser flow and local callback.
 * Anthropic's terms don't allow other apps to collect or relay Claude
 * credentials, so this dialog never asks for a code: it starts
 * `claude auth login` and waits for Claude Code to finish.
 */
export default function ClaudeLogin({ onClose, onAuthChanged }: { onClose: () => void; onAuthChanged?: (status: ClaudeAuthStatus | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<ClaudeMode>("claudeai");
  const [attempt, setAttempt] = useState(0);
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus | null>(null);
  const [status, setStatus] = useState<Status>({ phase: "starting", url: null, message: "Starting Claude Code sign-in…" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshAuthStatus = async () => {
    try {
      const next = await invoke<ClaudeAuthStatus>("claude_auth_status");
      setAuthStatus(next);
      onAuthChanged?.(next);
      return next;
    } catch {
      /* Auth status check is informational. */
      return null;
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
    const id = crypto.randomUUID();
    let disposed = false;
    let timer: number | undefined;
    setError(""); setBusy(false);
    setStatus({ phase: "starting", url: null, message: "Starting Claude Code sign-in…" });
    const starting = invoke("claude_login_start", { id, mode });
    const poll = async () => {
      try {
        const result = await invoke<Status>("claude_login_status", { id });
        if (disposed) return;
        setStatus(result);
        if (result.phase === "complete") { void refreshAuthStatus(); return; }
        if (result.phase === "error") return;
        timer = window.setTimeout(() => void poll(), 500);
      } catch {
        if (!disposed) setStatus({ phase: "error", url: null, message: "The sign-in session ended. Start again when you're ready." });
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

  // Covers a sign-in finished elsewhere, such as `claude auth login` in Terminal.
  const check = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const next = await refreshAuthStatus();
    setBusy(false);
    if (next?.loggedIn) setStatus({ phase: "complete", url: null, message: "Claude is connected." });
    else setError("Claude Code isn't signed in yet. Finish in your browser, or run `claude auth login` in the Terminal view.");
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
    <p className="auth-description">{status.phase === "complete"
      ? "Your Claude account is ready. Return to your conversation and send your message when you're ready."
      : accountSummary
        ? `Currently signed in (${accountSummary}). Sign in again below to refresh or switch accounts.`
        : "Sign in with your Claude account. Claude Code handles the whole sign-in in your browser; Velum never sees your credentials."}</p>
    {status.phase !== "complete" && <div className="auth-modes" role="group" aria-label="Claude sign-in account type">
      <button type="button" className={`auth-mode${mode === "claudeai" ? " active" : ""}`} disabled={busy} onClick={() => setMode("claudeai")}>Claude subscription</button>
      <button type="button" className={`auth-mode${mode === "console" ? " active" : ""}`} disabled={busy} onClick={() => setMode("console")}>Anthropic Console API</button>
    </div>}
    <div className={`auth-status ${status.phase}`} role={status.phase === "error" ? "alert" : "status"}>{status.message}</div>
    {status.phase === "browser" && <div className="auth-step"><span>1</span><div><h3>Approve in your browser</h3>
      <p>Claude Code opened a sign-in page. Approve it there and Claude Code finishes on its own.</p>
      <p>No browser window? Run <code>claude auth login</code> in this tab's Terminal view, then choose <strong>Check sign-in</strong>.</p></div></div>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {status.phase === "complete"
      ? <button className="auth-primary" onClick={onClose}>Back to conversation</button>
      : <div className="auth-actions">
          <button onClick={onClose}>Cancel</button>
          {status.phase !== "starting" && <button disabled={busy} onClick={() => setAttempt((n) => n + 1)}>Start again</button>}
          <button disabled={busy} onClick={() => void check()}>Check sign-in</button>
          {authStatus?.loggedIn && <button disabled={busy} onClick={() => void logout()}>Sign out</button>}
        </div>}
    <p className="auth-footnote">Claude Code keeps your credentials in its own credential store. Velum only reads whether you're signed in.</p>
  </dialog>;
}
