import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import { parseStatus } from "./gitStatus";

interface GitChipState {
  branch: string;
  changed: number;
  header: string;
  ahead: number;
  behind: number;
  upstream: string;
}

// Delays before retrying a failed resolve. "No Git repository detected" is a
// settled answer for a plain folder and never retries; anything else (a
// transient lock, timeout or half-written repo) is retried so the chip keeps
// trying to resolve instead of going quiet until the next tab switch.
const RETRY_DELAYS = [1000, 2500, 6000, 15000];

// Compact read-only Git readout for the status bar. Follows the selected
// conversation's workspace and refreshes whenever `signal` changes (tab
// switch, run settled, panel closed) or the window regains focus. The stale
// branch is cleared the moment the workspace changes so the chip never shows
// one folder's branch for another. Renders nothing outside a Git repository
// so plain folders keep a quiet footer. Clicking opens the full Git panel.
export default function GitChip({
  workspace,
  signal,
  onOpen,
}: {
  workspace: string | undefined;
  signal: string;
  onOpen: () => void;
}) {
  const [chip, setChip] = useState<GitChipState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never flash the previous folder's branch once the workspace moves on.
  useEffect(() => {
    setChip(null);
    failures.current = 0;
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const id = ++request.current;
    let cancelled = false;
    void invoke<{
      current: string;
      status: string;
      ahead?: number;
      behind?: number;
      upstream?: string;
    }>("git_state", { workspace })
      .then((next) => {
        if (cancelled || request.current !== id) return;
        if (!next?.current) {
          setChip(null);
          return;
        }
        failures.current = 0;
        const { header, files } = parseStatus(next.status ?? "");
        setChip({
          branch: next.current,
          changed: files.length,
          header,
          ahead: next.ahead ?? 0,
          behind: next.behind ?? 0,
          upstream: next.upstream ?? "",
        });
      })
      .catch((error) => {
        if (cancelled || request.current !== id) return;
        // A settled failure keeps whatever is shown (usually nothing after
        // the workspace change above); a transient one schedules a retry.
        if (String(error).includes("No Git repository detected.")) {
          setChip(null);
          return;
        }
        const delay = RETRY_DELAYS[Math.min(failures.current, RETRY_DELAYS.length - 1)];
        failures.current += 1;
        if (failures.current > RETRY_DELAYS.length) return;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (!cancelled) setAttempt((n) => n + 1);
        }, delay);
      });
    return () => {
      cancelled = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [workspace, signal, attempt]);

  // Re-resolve when the user comes back from a terminal or Git client — the
  // folder's branches may have moved while we were away.
  useEffect(() => {
    const refocus = () => setAttempt((n) => n + 1);
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, []);

  if (!workspace || !chip) return null;
  const summary =
    chip.changed === 0
      ? `Working tree clean on ${chip.branch}`
      : `${chip.changed} changed file${chip.changed === 1 ? "" : "s"} on ${chip.branch}`;
  const sync =
    chip.ahead > 0 || chip.behind > 0
      ? `${chip.ahead > 0 ? `ahead ${chip.ahead}` : ""}${chip.ahead > 0 && chip.behind > 0 ? ", " : ""}${chip.behind > 0 ? `behind ${chip.behind}` : ""}`
      : "";
  return (
    <button
      type="button"
      className="git-chip"
      onClick={onOpen}
      title={`${summary}${sync ? ` · ${sync}` : ""}${chip.upstream ? ` · ${chip.upstream}` : ""}${chip.header ? ` · ${chip.header}` : ""} — open Git branches and diff`}
      aria-label={`Git: ${summary}. Open Git branches and diff.`}
    >
      <Icon name="branch" size={13} />
      <span className="git-chip-branch">{chip.branch}</span>
      {chip.changed > 0 && (
        <span className="git-chip-count" aria-hidden="true">
          {chip.changed}
        </span>
      )}
      {sync && (
        <span className="git-chip-sync" aria-hidden="true">
          {chip.ahead > 0 && `↑${chip.ahead}`}
          {chip.ahead > 0 && chip.behind > 0 && " "}
          {chip.behind > 0 && `↓${chip.behind}`}
        </span>
      )}
    </button>
  );
}
