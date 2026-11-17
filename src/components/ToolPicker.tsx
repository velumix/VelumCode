import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { providerNames, type Provider } from "../providers";
import Icon from "./Icon";
import "./ToolPicker.css";

interface Permissions {
  enabled: boolean;
  file_delete: boolean;
  vault_search: boolean;
  browser: boolean;
  native_screenshot: boolean;
  native_control: boolean;
  swarm: boolean;
}

interface ToolsStatus {
  permissions: Permissions;
  ready: boolean;
  browser_available: boolean;
  native_available: boolean;
  providers: { provider: Provider; installed: boolean; registration: string }[];
}

const CAPABILITY_ITEMS: { key: keyof Permissions; label: string; hint: string }[] = [
  {
    key: "enabled",
    label: "Velum host tools",
    hint: "Workspace search, Git status/diff/branches/log, inspect_file & diagnostics",
  },
  {
    key: "file_delete",
    label: "Safe file delete",
    hint: "Allow SHA-256 verified delete_file in the project workspace",
  },
  {
    key: "vault_search",
    label: "Memory vault search",
    hint: "Query active project & bot memories during turns",
  },
  {
    key: "browser",
    label: "Headless browser preview",
    hint: "Edge/Chrome browser_open, snapshot, click/fill actions & screenshots",
  },
  {
    key: "native_screenshot",
    label: "Desktop window screenshots",
    hint: "List and capture visible Windows app windows (native_screenshot)",
  },
  {
    key: "native_control",
    label: "Windows app input control",
    hint: "Focus, click, type and press keys in visible Windows apps (native_input)",
  },
  {
    key: "swarm",
    label: "Multi-provider swarm delegation",
    hint: "Delegate subtasks or run /swarm across Codex, Claude, Antigravity, Muse, Bonsai Fast, and Velum Bots",
  },
];

export default function ToolPicker({
  provider,
  totalTools,
  runningTools,
  disabled,
  onOpenActivity,
}: {
  provider: Provider;
  totalTools: number;
  runningTools: number;
  disabled?: boolean;
  onOpenActivity: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await invoke<ToolsStatus>("agent_tools_status");
      if (next?.permissions) {
        setStatus(next);
        setError("");
      }
    } catch {
      setError("Could not read host tool status.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, loadStatus]);

  const togglePermission = async (key: keyof Permissions) => {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await invoke<ToolsStatus>("agent_tools_configure", {
        permissions: { ...status.permissions, [key]: !status.permissions[key] },
      });
      setStatus(next);
    } catch {
      setError("Could not update host tool permissions.");
    } finally {
      setBusy(false);
    }
  };

  const perms = status?.permissions;
  const activeCount = perms
    ? !perms.enabled
      ? 0
      : 1 +
        (perms.file_delete ? 1 : 0) +
        (perms.vault_search ? 1 : 0) +
        (perms.browser && status?.browser_available ? 1 : 0) +
        (perms.native_screenshot && status?.native_available ? 1 : 0) +
        (perms.native_control && status?.native_available ? 1 : 0) +
        (perms.swarm ? 1 : 0)
    : null;
  const providerEntry = status?.providers.find((p) => p.provider === provider);
  const regLabel = !perms?.enabled
    ? "Off"
    : providerEntry?.registration === "per_turn"
      ? "Per-turn stdio MCP"
      : providerEntry?.registration === "configured"
        ? "Registered MCP"
        : "Connects on turn";

  return (
    <span className="tool-picker" ref={root}>
      <button
        type="button"
        className={`yolo-btn${perms?.enabled ? " tools-on" : ""}${runningTools > 0 ? " tools-busy" : ""}`}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Tools and MCP capabilities"
        title={
          perms?.enabled
            ? `${providerNames[provider]} tools & MCP bridge active (${activeCount} host groups enabled · applies next turn)`
            : "Velum host tools are currently off — click to enable"
        }
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="layers" size={15} />
        <span>
          Tools
          {runningTools > 0
            ? ` (${runningTools} running)`
            : activeCount !== null
              ? perms?.enabled
                ? ` (${activeCount})`
                : " (off)"
              : ""}
        </span>
      </button>

      {open && (
        <div className="tool-picker-menu" role="dialog" aria-label="Agent Tools & MCP">
          <div className="tool-picker-head">
            <div>
              <strong>Agent Tools &amp; MCP</strong>
              <span className="tool-picker-sub">
                {providerNames[provider]} · {status?.ready ? regLabel : "Tool host starting"}
              </span>
            </div>
            <span className={`tool-picker-badge${perms?.enabled && status?.ready ? " ready" : ""}`}>
              {perms?.enabled ? (status?.ready ? "Ready" : "Starting") : "Disabled"}
            </span>
          </div>

          {provider === "bonsai" && (
            <div className="tool-picker-bridge">
              <div className="tool-picker-bridge-row">
                <strong>Workspace Core</strong>
                <span>8 builtin tools (read, write, edit, glob, grep, dir, shell, todos)</span>
              </div>
              <div className="tool-picker-bridge-row">
                <strong>Bonsai Local MCP (:8081)</strong>
                <span>11 tools (Web search/fetch, Python, GitHub, Health, Weather, Memory · Vision)</span>
              </div>
            </div>
          )}

          <div className="tool-picker-list">
            {CAPABILITY_ITEMS.map((item) => {
              const unavailable =
                item.key === "browser"
                  ? status ? !status.browser_available : false
                  : item.key.startsWith("native_")
                    ? status ? !status.native_available : false
                    : false;
              const checked = !!perms?.[item.key];
              const rowDisabled =
                !status ||
                busy ||
                (item.key !== "enabled" && !perms?.enabled) ||
                (unavailable && !checked);
              return (
                <label
                  key={item.key}
                  className={`tool-picker-item${rowDisabled ? " disabled" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={rowDisabled}
                    onChange={() => void togglePermission(item.key)}
                  />
                  <span className="tool-picker-copy">
                    <strong>{item.label}</strong>
                    <span>
                      {item.hint}
                      {unavailable && status ? " (Unavailable on this installation)" : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {error && (
            <p className="tool-picker-error" role="alert">
              {error}
            </p>
          )}

          <div className="tool-picker-foot">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenActivity();
              }}
            >
              Inspect tool activity{totalTools > 0 ? ` (${totalTools})` : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("velum:open-plugins"));
              }}
            >
              Plugins &amp; MCP…
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
