import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Icon from "./Icon";
import { parseStatus } from "./gitStatus";

interface GitChipState {
  branch: string;
  changed: number;
  header: string;
}

// Compact read-only Git readout for the status bar. Follows the selected
// conversation's workspace and refreshes whenever `signal` changes (tab
// switch, run settled). Renders nothing outside a Git repository so plain
// folders keep a quiet footer. Clicking opens the full Git panel.
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
  const request = useRef(0);

  useEffect(() => {
    if (!workspace) {
      setChip(null);
      return;
    }
    const id = ++request.current;
    let cancelled = false;
    void invoke<{ current: string; status: string }>("git_state", { workspace })
      .then((next) => {
        if (cancelled || request.current !== id) return;
        if (!next?.current) {
          setChip(null);
          return;
        }
        const { header, files } = parseStatus(next.status ?? "");
        setChip({ branch: next.current, changed: files.length, header });
      })
      .catch(() => {
        if (!cancelled && request.current === id) setChip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, signal]);

  if (!workspace || !chip) return null;
  const summary =
    chip.changed === 0
      ? `Working tree clean on ${chip.branch}`
      : `${chip.changed} changed file${chip.changed === 1 ? "" : "s"} on ${chip.branch}`;
  return (
    <button
      type="button"
      className="git-chip"
      onClick={onOpen}
      title={`${summary}${chip.header ? ` · ${chip.header}` : ""} — open Git branches and diff`}
      aria-label={`Git: ${summary}. Open Git branches and diff.`}
    >
      <Icon name="branch" size={13} />
      <span className="git-chip-branch">{chip.branch}</span>
      {chip.changed > 0 && (
        <span className="git-chip-count" aria-hidden="true">
          {chip.changed}
        </span>
      )}
    </button>
  );
}
