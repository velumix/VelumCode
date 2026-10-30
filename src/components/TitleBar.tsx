import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Icon, { VelumMark } from "./Icon";
import type { UpdateStatus } from "../updates";

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M0 5.5h10" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x=".5" y=".5" width="9" height="9" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M2.5 2.5V.5h7v7h-2" />
      <rect x=".5" y="2.5" width="7" height="7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m.5.5 9 9m0-9-9 9" />
    </svg>
  );
}

export default function TitleBar({
  onCommands,
  updates,
  onOpenUpdates,
}: {
  onCommands: () => void;
  updates?: UpdateStatus | null;
  onOpenUpdates?: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();
  const currentVersion = updates?.current_version || "0.7.15";
  const hasUpdate = updates?.phase === "available" || updates?.phase === "ready";
  const versionTitle = hasUpdate
    ? `Velum Code v${currentVersion} — Update v${updates?.version || "new"} is available. Click to open Updates.`
    : `Velum Code v${currentVersion} — Click to check for updates`;

  useEffect(() => {
    const w = getCurrentWindow();
    let disposed = false;
    w.isMaximized().then(setMaximized).catch(() => {});
    let unlisten: (() => void) | undefined;
    listen("tauri://resize", () => {
      w.isMaximized().then(setMaximized).catch(() => {});
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  return (
    <header
      className="titlebar"
      onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
          void win.startDragging();
        }
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) {
          void win.toggleMaximize();
        }
      }}
    >
      <div className="titlebar-brand">
        <VelumMark size={18} />
        <span>Velum Code</span>
        {currentVersion && (
          <button
            type="button"
            className={`titlebar-version ${hasUpdate ? "has-update" : ""}`}
            onClick={onOpenUpdates}
            title={versionTitle}
            aria-label={`Velum Code version ${currentVersion}${hasUpdate ? `. Update available: ${updates?.version}` : ""}`}
          >
            v{currentVersion}
            {hasUpdate && <span className="titlebar-update-dot" aria-hidden="true" />}
          </button>
        )}
      </div>
      <button type="button" className="global-search" onClick={onCommands} aria-label="Search commands and conversations">
        <Icon name="search" size={14} />
        <span>Search Velum</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="titlebar-drag-space" />
      <div className="titlebar-controls">
        <button type="button" aria-label="Minimize" onClick={() => void win.minimize()}>
          <MinimizeIcon />
        </button>
        <button type="button" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" aria-label="Close" title="Hide to system tray — Velum Code keeps running" className="close" onClick={() => void win.close()}>
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}
