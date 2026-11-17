import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerNames, type Provider } from "../providers";
import type { BotProfile, BotView } from "../bots";
import Icon from "./Icon";
import "./SwarmPicker.css";

interface ProviderAvailability {
  id: Provider;
  installed: boolean;
}

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
}

interface BuiltinTarget {
  id: string;
  label: string;
  detail: string;
  requiresProvider: Provider;
}

const BUILTIN_TARGETS: BuiltinTarget[] = [
  {
    id: "bonsai-fast",
    label: "Bonsai 2 4B · Fast (:8090)",
    detail: "~150 tok/s secondary GPU worker",
    requiresProvider: "bonsai",
  },
  {
    id: "bonsai",
    label: "Bonsai 2 27B · Local (:8080)",
    detail: "Deep local reasoning & tools",
    requiresProvider: "bonsai",
  },
  {
    id: "codex",
    label: "Codex",
    detail: "OpenAI Codex CLI worker",
    requiresProvider: "codex",
  },
  {
    id: "claude",
    label: "Claude Code",
    detail: "Anthropic Claude CLI worker",
    requiresProvider: "claude",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    detail: "Google Gemini / Agy CLI worker",
    requiresProvider: "antigravity",
  },
  {
    id: "muse",
    label: "Muse",
    detail: "Velum Muse CLI worker",
    requiresProvider: "muse",
  },
];

export default function SwarmPicker({
  provider,
  enabled,
  targets,
  disabled,
  onToggleEnabled,
  onChangeTargets,
  onInsertAction,
}: {
  provider: Provider;
  enabled: boolean;
  targets: string[];
  disabled?: boolean;
  onToggleEnabled: (next: boolean) => void;
  onChangeTargets: (next: string[]) => void;
  onInsertAction: (promptPrefix: string, autoEnable?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<ProviderAvailability[]>([]);
  const [bots, setBots] = useState<BotProfile[]>([]);
  const [toolsStatus, setToolsStatus] = useState<ToolsStatus | null>(null);
  const [error, setError] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const menuId = useId();

  const loadRoster = useCallback(async () => {
    const [provRes, botsRes, toolsRes] = await Promise.allSettled([
      invoke<ProviderAvailability[]>("provider_status"),
      invoke<BotView>("bots_request", { request: { action: "list" } }),
      invoke<ToolsStatus>("agent_tools_status"),
    ]);
    if (provRes.status === "fulfilled" && Array.isArray(provRes.value)) {
      setAvailability(provRes.value);
    }
    if (botsRes.status === "fulfilled" && Array.isArray(botsRes.value?.profiles)) {
      setBots(botsRes.value.profiles.filter((b) => b.enabled));
    }
    if (toolsRes.status === "fulfilled" && toolsRes.value?.permissions) {
      setToolsStatus(toolsRes.value);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    if (!open) return;
    void loadRoster();
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
  }, [open, loadRoster]);

  const ensureSwarmBridgeEnabled = useCallback(async () => {
    try {
      const current = toolsStatus ?? (await invoke<ToolsStatus>("agent_tools_status"));
      if (current?.permissions && (!current.permissions.enabled || !current.permissions.swarm)) {
        const updated = await invoke<ToolsStatus>("agent_tools_configure", {
          permissions: { ...current.permissions, enabled: true, swarm: true },
        });
        setToolsStatus(updated);
      }
      setError("");
    } catch {
      setError("Could not enable Velum swarm bridge permissions; Bonsai built-in swarm remains active.");
    }
  }, [toolsStatus]);

  const handleToggleEnabled = (next: boolean) => {
    onToggleEnabled(next);
    if (next) {
      void ensureSwarmBridgeEnabled();
    }
  };

  const toggleTarget = (id: string) => {
    const next = targets.includes(id)
      ? targets.filter((t) => t !== id)
      : [...targets, id];
    onChangeTargets(next);
  };

  const installedMap = new Map<Provider, boolean>(availability.map((p) => [p.id, p.installed]));
  const isInstalled = (prov: Provider) => installedMap.get(prov) ?? true;

  const triggerAction = (prefix: string, autoEnable = true) => {
    if (autoEnable) {
      onToggleEnabled(true);
      void ensureSwarmBridgeEnabled();
    }
    onInsertAction(prefix, autoEnable);
    setOpen(false);
  };

  return (
    <span className="swarm-picker" ref={root}>
      <button
        type="button"
        className={`yolo-btn${enabled ? " swarm-on" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={
          enabled
            ? `Swarm delegation ON (${targets.length} targets selected) — click to configure workers & quick actions`
            : "Configure Multi-Provider Swarm Delegation (/swarm)"
        }
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="layers" size={15} />
        <span>{enabled ? `Swarm · ${targets.length}` : "Swarm"}</span>
      </button>

      {open && (
        <div
          id={menuId}
          className="swarm-picker-menu"
          role="dialog"
          aria-label="Multi-Provider Swarm & Delegation"
        >
          <div className="swarm-picker-head">
            <div>
              <strong>Multi-Provider Swarm</strong>
              <span className="swarm-picker-sub">
                Let {providerNames[provider]} delegate subtasks across local & cloud models
              </span>
            </div>
            <span className={`swarm-picker-badge${enabled ? " on" : ""}`}>
              {enabled ? `Active · ${targets.length}` : "Off"}
            </span>
          </div>

          <label className="swarm-picker-toggle-row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
            />
            <span className="swarm-picker-toggle-copy">
              <strong>Auto-attach swarm delegation instructions to turns</strong>
              <span>
                Injects your selected worker roster so {providerNames[provider]} can spawn parallel{" "}
                <code>run_swarm</code> or <code>delegate_task</code> calls directly.
              </span>
            </span>
          </label>

          <div className="swarm-picker-body">
            <div className="swarm-picker-section">
              <div className="swarm-picker-section-title">
                <span>Provider Workers</span>
                <span>{targets.length} selected</span>
              </div>
              <div className="swarm-picker-grid">
                {BUILTIN_TARGETS.map((item) => {
                  const ok = isInstalled(item.requiresProvider);
                  const selected = targets.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!ok}
                      className={`swarm-target-chip${selected ? " selected" : ""}`}
                      onClick={() => toggleTarget(item.id)}
                      title={ok ? item.detail : `${providerNames[item.requiresProvider]} CLI is not installed`}
                    >
                      <span className="swarm-target-check" aria-hidden="true">
                        {selected ? "✓" : ""}
                      </span>
                      <span className="swarm-target-meta">
                        <strong>{item.label}</strong>
                        <span>{ok ? item.detail : "Not installed"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {bots.length > 0 && (
              <div className="swarm-picker-section">
                <div className="swarm-picker-section-title">
                  <span>Velum Bots</span>
                  <span>{bots.length} enabled</span>
                </div>
                <div className="swarm-picker-grid">
                  {bots.map((bot) => {
                    const id = `bot:${bot.id}`;
                    const selected = targets.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`swarm-target-chip${selected ? " selected" : ""}`}
                        onClick={() => toggleTarget(id)}
                        title={`${bot.name} (${providerNames[bot.provider]}) — ${bot.role || "Velum Bot"}`}
                      >
                        <span className="swarm-target-check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                        <span className="swarm-target-meta">
                          <strong>{bot.name}</strong>
                          <span>
                            {providerNames[bot.provider]}
                            {bot.role ? ` · ${bot.role}` : ""}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="swarm-picker-error" role="status">
              {error}
            </p>
          )}

          <div className="swarm-quick-actions">
            <button
              type="button"
              className="swarm-quick-btn"
              onClick={() =>
                triggerAction(
                  "Run a parallel /swarm across the selected targets: split the task into independent slices with run_swarm, inspect swarm_board, and synthesize the verified result.\n\nTask: ",
                  true
                )
              }
            >
              <Icon name="bot" size={13} />
              <span>Launch /swarm</span>
            </button>
            <button
              type="button"
              className="swarm-quick-btn"
              onClick={() =>
                triggerAction(
                  "Delegate a focused subtask using delegate_task to the best-suited selected target, verify its output, and integrate it.\n\nSubtask: ",
                  true
                )
              }
            >
              <Icon name="layers" size={13} />
              <span>Delegate Subtask</span>
            </button>
            <button
              type="button"
              className="swarm-quick-btn"
              onClick={() =>
                triggerAction(
                  "Run a parallel council comparison via run_swarm (read_only=true) asking 2-3 different providers on the roster to independently analyze/review this problem, then compare their findings on swarm_board:\n\n",
                  true
                )
              }
            >
              <Icon name="sparkles" size={13} />
              <span>Council Compare</span>
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
