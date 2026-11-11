import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyAppearance, themes, type AppearanceValues } from "./appearance";

export type Preferences = AppearanceValues;
export const defaults: Readonly<Preferences> = {
  theme: "graphite",
  customAccent: "",
  customBackground: "",
  customSurface: "",
  glass: true,
  opacity: 84,
  blur: 22,
  saturation: 130,
  glow: 55,
  grain: 3,
  borders: 45,
  shadows: 55,
  corners: 14,
  density: "comfortable",
  sidebarWidth: 248,
  sidebarMode: "auto",
  chatWidth: 736,
  gutter: 28,
  uiFont: "system",
  uiScale: 100,
  chatFont: "system",
  chatFontSize: 14,
  chatLineHeight: 1.75,
  codeFont: "cascadia",
  codeFontSize: 12,
  motion: "system",
  showStarters: true,
  showHints: true,
  showAvatars: true,
  alwaysShowCopy: false,
  sendShortcut: "enter",
  toolOutput: "preview",
  compactControls: true,
  groupActivity: true,
  terminalFontSize: 14,
  terminalLineHeight: 1.2,
  terminalCursor: "bar",
  terminalBlink: true,
  terminalScrollback: 5000,
  defaultProvider: "last",
};
export const ranges: Partial<
  Record<keyof Preferences, readonly [number, number, number]>
> = {
  opacity: [65, 100, 1],
  blur: [0, 40, 1],
  saturation: [80, 180, 5],
  glow: [0, 100, 1],
  grain: [0, 12, 1],
  borders: [0, 100, 1],
  shadows: [0, 100, 1],
  corners: [0, 24, 1],
  sidebarWidth: [200, 320, 4],
  chatWidth: [560, 1120, 8],
  gutter: [12, 40, 2],
  uiScale: [85, 125, 5],
  chatFontSize: [12, 22, 1],
  chatLineHeight: [1.4, 2.1, 0.05],
  codeFontSize: [11, 18, 1],
  terminalFontSize: [10, 26, 1],
  terminalLineHeight: [1, 1.8, 0.05],
  terminalScrollback: [1000, 50000, 1000],
};
const choices: Partial<Record<keyof Preferences, readonly string[]>> = {
  theme: ["system", ...themes.map((t) => t.id)],
  density: ["compact", "comfortable", "spacious"],
  sidebarMode: ["auto", "expanded", "rail"],
  uiFont: ["system", "classic", "rounded"],
  chatFont: ["system", "serif", "mono"],
  codeFont: ["cascadia", "consolas", "jetbrains", "courier"],
  motion: ["system", "reduced"],
  sendShortcut: ["enter", "ctrl-enter"],
  toolOutput: ["preview", "collapsed", "expanded"],
  terminalCursor: ["bar", "block", "underline"],
  defaultProvider: ["last", "muse", "codex", "claude", "antigravity"],
};
export function normalizePreferences(value: unknown): Preferences {
  const result = { ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
    const v = source[key];
    const range = ranges[key];
    if (range && typeof v === "number" && Number.isFinite(v)) {
      const [min, max, step] = range;
      (result as unknown as Record<string, unknown>)[key] = Number(
        (
          Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step +
          min
        ).toFixed(2),
      );
    } else if (typeof defaults[key] === "boolean" && typeof v === "boolean") {
      (result as unknown as Record<string, unknown>)[key] = v;
    } else if (choices[key]?.includes(v as string)) {
      (result as unknown as Record<string, unknown>)[key] = v;
    } else if (
      key.startsWith("custom") &&
      typeof v === "string" &&
      (v === "" || /^#[a-f\d]{6}$/i.test(v))
    ) {
      (result as unknown as Record<string, unknown>)[key] = v.toLowerCase();
    }
  }
  return result;
}

const KEY = "velum-preferences-v1";
export const MAX_PROFILE_BYTES = 32768;
const systemScheme = matchMedia("(prefers-color-scheme: dark)");
const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
export interface PreferenceSnapshot {
  settings: Preferences;
  systemDark: boolean;
  reducedTransparency: boolean;
  status: "saved" | "saving" | "error";
  error: string;
}
function localPreferences(): Preferences {
  try {
    const value = localStorage.getItem(KEY);
    return value && value.length <= MAX_PROFILE_BYTES
      ? parseProfile(JSON.parse(value))
      : { ...defaults };
  } catch {
    return { ...defaults };
  }
}
let snapshot: PreferenceSnapshot = {
  settings: localPreferences(),
  systemDark: systemScheme.matches,
  reducedTransparency: transparency.matches,
  status: "saved",
  error: "",
};
let native = false;
let revision = 0;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let styledSettings: Preferences | undefined;
let styledDark: boolean | undefined;
let styledTransparency: boolean | undefined;
function publish() {
  if (
    styledSettings !== snapshot.settings ||
    styledDark !== snapshot.systemDark ||
    styledTransparency !== transparency.matches
  ) {
    applyAppearance(
      snapshot.settings,
      snapshot.systemDark,
      transparency.matches,
    );
    styledSettings = snapshot.settings;
    styledDark = snapshot.systemDark;
    styledTransparency = transparency.matches;
  }
  for (const listener of listeners) listener();
}
publish();
systemScheme.addEventListener("change", () => {
  snapshot = { ...snapshot, systemDark: systemScheme.matches };
  publish();
});
transparency.addEventListener("change", () => {
  snapshot = { ...snapshot, reducedTransparency: transparency.matches };
  publish();
});
export function getPreferences() {
  return snapshot.settings;
}
export function usePreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
}
export async function initializePreferences(desktop = false) {
  native = desktop;
  if (!native) return;
  try {
    const saved = await invoke<unknown>("preferences_load");
    if (saved !== null && saved !== undefined) {
      snapshot = {
        ...snapshot,
        settings: parseProfile(saved),
        status: "saved",
        error: "",
      };
      try {
        localStorage.setItem(KEY, exportProfile(snapshot.settings));
      } catch {
        /* Native preferences remain available. */
      }
    }
  } catch (error) {
    snapshot = {
      ...snapshot,
      status: "error",
      error: `Could not load settings: ${String(error)}`,
    };
  }
  publish();
}
export function exportProfile(settings = snapshot.settings): string {
  return JSON.stringify({ version: 1, settings }, null, 2);
}
export function parseProfile(value: unknown): Preferences {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1
  )
    throw new Error("Choose a Velum settings file with version 1.");
  const settings = (value as Record<string, unknown>).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("This file does not contain Velum settings.");
  return normalizePreferences(settings);
}
export function updatePreferences(patch: Partial<Preferences>) {
  const settings = normalizePreferences({ ...snapshot.settings, ...patch });
  const current = ++revision;
  snapshot = { ...snapshot, settings, status: "saving", error: "" };
  publish();
  let storageError = "";
  try {
    localStorage.setItem(KEY, exportProfile(settings));
  } catch (error) {
    storageError = String(error);
  }
  // Serialize atomic native writes so a slow slider update never replaces a
  // newer choice. Browser storage failure does not prevent the native save.
  writes = writes
    .then(async () => {
      if (native)
        await invoke("preferences_save", { profile: { version: 1, settings } });
      else if (storageError) throw new Error(storageError);
      if (current === revision) {
        snapshot = { ...snapshot, status: "saved", error: "" };
        publish();
      }
    })
    .catch((error) => {
      if (current === revision) {
        snapshot = {
          ...snapshot,
          status: "error",
          error: `Settings are applied, but could not be saved: ${String(error)}`,
        };
        publish();
      }
    });
}
export function retryPreferences() {
  updatePreferences({});
}
export async function flushPreferences() {
  let pending: Promise<void>;
  do { pending = writes; await pending; } while (pending !== writes);
  if (snapshot.status === "error") throw new Error(snapshot.error);
}
// Settings in separate phone tabs share one local profile. Desktop preferences
// are owned by the native single-instance app and do not follow browser writes.
window.addEventListener("storage", (event) => {
  if (native || event.key !== KEY) return;
  snapshot = {
    ...snapshot,
    settings: localPreferences(),
    status: "saved",
    error: "",
  };
  publish();
});
