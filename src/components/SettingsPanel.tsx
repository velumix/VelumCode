import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Icon from "./Icon";
import ToolsSettings from "./ToolsSettings";
import { checkForUpdates, downloadUpdate, restartToUpdate, setAutomaticUpdates, updateMessage, type UpdateStatus } from "../updates";
import { openUrl } from "@tauri-apps/plugin-opener";
import { palette, themes } from "../appearance";
import {
  defaults,
  exportProfile,
  MAX_PROFILE_BYTES,
  parseProfile,
  ranges,
  retryPreferences,
  updatePreferences,
  usePreferences,
  type Preferences,
} from "../preferences";
import "./SettingsPanel.css";

type Page = "appearance" | "glass" | "layout" | "terminal" | "preferences" | "updates";
const pages: {
  id: Page;
  title: string;
  subtitle: string;
  icon: "settings" | "code" | "board" | "terminal" | "command";
}[] = [
  {
    id: "appearance",
    title: "Appearance",
    subtitle: "Find your atmosphere",
    icon: "settings",
  },
  {
    id: "glass",
    title: "Glass & finish",
    subtitle: "Light, depth, and texture",
    icon: "code",
  },
  {
    id: "layout",
    title: "Layout & text",
    subtitle: "A space that fits you",
    icon: "board",
  },
  {
    id: "terminal",
    title: "Terminal",
    subtitle: "Make the command line yours",
    icon: "terminal",
  },
  {
    id: "preferences",
    title: "Preferences",
    subtitle: "The way you like to work",
    icon: "command",
  },
  {
    id: "updates",
    title: "Updates",
    subtitle: "Keep Velum current",
    icon: "command",
  },
];
const Search = createContext("");
function Group({ title, children }: { title: string; children: ReactNode }) {
  const query = useContext(Search);
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <Search.Provider value={title.toLowerCase().includes(query) ? "" : query}>
        {children}
      </Search.Provider>
    </section>
  );
}
function Setting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, hintId: string) => ReactNode;
}) {
  const query = useContext(Search);
  const id = useId();
  if (query && !`${label} ${hint || ""}`.toLowerCase().includes(query))
    return null;
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <label htmlFor={id} id={`${id}-label`}>
          {label}
        </label>
        {hint && <p id={`${id}-hint`}>{hint}</p>}
      </div>
      <div className="setting-control">
        {children(id, hint ? `${id}-hint` : "")}
      </div>
    </div>
  );
}
function Slider({
  label,
  hint,
  name,
  value,
  change,
  unit = "",
  disabled = false,
}: {
  label: string;
  hint?: string;
  name: keyof Preferences;
  value: number;
  change: (value: number) => void;
  unit?: string;
  disabled?: boolean;
}) {
  const [min, max, step] = ranges[name]!;
  return (
    <Setting label={label} hint={hint}>
      {(id, description) => (
        <div className="settings-slider">
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => change(Number(e.target.value))}
            aria-describedby={description || undefined}
            aria-valuetext={`${value}${unit}`}
            disabled={disabled}
          />
          <output htmlFor={id} aria-hidden="true">
            {value}
            {unit}
          </output>
        </div>
      )}
    </Setting>
  );
}
function Select({
  label,
  hint,
  value,
  options,
  change,
}: {
  label: string;
  hint?: string;
  value: string;
  options: [string, string][];
  change: (value: string) => void;
}) {
  return (
    <Setting label={label} hint={hint}>
      {(id, description) => (
        <select
          id={id}
          value={value}
          onChange={(e) => change(e.target.value)}
          aria-describedby={description || undefined}
        >
          {options.map(([value, title]) => (
            <option value={value} key={value}>
              {title}
            </option>
          ))}
        </select>
      )}
    </Setting>
  );
}
function Toggle({
  label,
  hint,
  value,
  change,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: boolean;
  change: () => void;
  disabled?: boolean;
}) {
  return (
    <Setting label={label} hint={hint}>
      {(id, description) => (
        <button
          id={id}
          className="settings-switch"
          type="button"
          role="switch"
          aria-checked={value}
          aria-labelledby={`${id}-label`}
          aria-describedby={description || undefined}
          onClick={change}
          disabled={disabled}
        >
          <span />
        </button>
      )}
    </Setting>
  );
}
function Color({
  label,
  hint,
  value,
  fallback,
  change,
}: {
  label: string;
  hint: string;
  value: string;
  fallback: string;
  change: (value: string) => void;
}) {
  return (
    <Setting label={label} hint={hint}>
      {(id, description) => (
        <div className="settings-color">
          <input
            id={id}
            type="color"
            value={value || fallback}
            aria-describedby={description}
            onChange={(e) => change(e.target.value)}
          />
          <span>{(value || fallback).toUpperCase()}</span>
          <button
            type="button"
            aria-label={`Reset ${label.toLowerCase()}`}
            disabled={!value}
            onClick={() => change("")}
          >
            <Icon name="reset" size={14} />
          </button>
        </div>
      )}
    </Setting>
  );
}

export default function SettingsPanel({
  onClose,
  phone = false,
  notifications,
  updates,
  initialPage = "appearance",
}: {
  onClose: () => void;
  phone?: boolean;
  updates?: UpdateStatus | null;
  initialPage?: Page;
  notifications?: {
    enabled: boolean;
    toggle: () => Promise<void>;
    test: () => Promise<void>;
  };
}) {
  const {
    settings: s,
    systemDark,
    reducedTransparency,
    status,
    error,
  } = usePreferences();
  const visiblePages = phone
    ? pages.filter((item) => item.id !== "terminal" && item.id !== "updates")
    : pages;
  const [page, setPage] = useState<Page>(initialPage);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [fileError, setFileError] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const p = palette(s, systemDark);
  const search = query.trim().toLowerCase();
  const show = (id: Page) => search || page === id;
  const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    updatePreferences({ [key]: value });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLInputElement>("input[type=search]")
      ?.focus();
    // Prevent background controls (including live terminals) receiving focus or
    // shortcuts while the settings dialog is open. Restore their exact state.
    const parents = [
      ...(dialog.current?.parentElement?.parentElement?.children || []),
    ];
    const blocked = parents
      .filter((el) => el !== dialog.current?.parentElement)
      .map((el) => ({
        el: el as HTMLElement,
        inert: (el as HTMLElement).inert,
      }));
    for (const { el } of blocked) el.inert = true;
    return () => {
      for (const { el, inert } of blocked) el.inert = inert;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [page, search]);
  useEffect(() => {
    if (confirmReset) resetCancel.current?.focus();
  }, [confirmReset]);
  const choose = (id: Page) => {
    setPage(id);
    setQuery("");
    setConfirmReset(false);
  };
  const cancelReset = () => {
    setConfirmReset(false);
    resetTrigger.current?.focus();
  };
  const keys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (confirmReset) cancelReset();
      else closeRef.current();
    }
    if (event.key !== "Tab") return;
    const owner = confirmReset
      ? dialog.current?.querySelector('[role="alertdialog"]')
      : dialog.current;
    const controls = [
      ...(owner?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), a[href], [tabindex="0"]',
      ) || []),
    ].filter((el) => !!el.getClientRects().length);
    const first = controls[0],
      last = controls[controls.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialog.current?.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !dialog.current?.contains(document.activeElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
  };
  const exportSettings = () => {
    const url = URL.createObjectURL(
      new Blob([exportProfile()], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "velum-settings.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Settings exported.");
    setFileError("");
  };
  const importSettings = async (selected?: File) => {
    if (!selected) return;
    try {
      if (selected.size > MAX_PROFILE_BYTES)
        throw new Error("Choose a settings file smaller than 32 KB.");
      updatePreferences(parseProfile(JSON.parse(await selected.text())));
      setMessage("Settings imported. Unsupported values use safe defaults.");
      setFileError("");
    } catch (error) {
      setFileError(String(error).replace(/^Error: /, ""));
      setMessage("");
    } finally {
      if (file.current) file.current.value = "";
    }
  };
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };
  const updateAction = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setUpdateError("");
    try { await run(); }
    catch (error) { setUpdateError(String(error).replace(/^Error: /, "")); }
    finally { setBusy(false); }
  };
  const updating = busy || updates?.phase === "checking" || updates?.phase === "downloading" || updates?.phase === "installing";
  const slider = (
    name: keyof Preferences,
    label: string,
    hint?: string,
    unit = "",
    disabled = false,
  ) => (
    <Slider
      name={name}
      label={label}
      hint={hint}
      unit={unit}
      value={s[name] as number}
      change={(value) => updatePreferences({ [name]: value })}
      disabled={disabled}
    />
  );
  const toggle = (name: keyof Preferences, label: string, hint?: string) => (
    <Toggle
      label={label}
      hint={hint}
      value={s[name] as boolean}
      change={() => updatePreferences({ [name]: !s[name] })}
    />
  );
  const select = (
    name: keyof Preferences,
    label: string,
    options: [string, string][],
    hint?: string,
  ) => (
    <Select
      label={label}
      hint={hint}
      value={s[name] as string}
      options={options}
      change={(value) => updatePreferences({ [name]: value })}
    />
  );
  const themeQuery =
    search &&
    !"appearance theme themes color palette dark light".includes(search)
      ? search
      : "";
  const visibleThemes = themes.filter(
    (t) =>
      !themeQuery ||
      `${t.name} ${t.description}`.toLowerCase().includes(themeQuery),
  );
  return (
    <div
      className="settings-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`settings-panel${phone ? " settings-phone" : ""}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={keys}
      >
        <header className="settings-header">
          <div className="settings-title-icon">
            <Icon name="settings" size={20} />
          </div>
          <div>
            <h2 id="settings-title">Make yourself at home</h2>
            <p>
              {phone ? "Appearance for this phone" : "Your Velum, your way"}
            </p>
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings (Esc)"
          >
            <Icon name="close" size={19} />
          </button>
        </header>
        <div className="settings-body">
          <aside className="settings-nav">
            <label className="settings-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                aria-label="Search settings"
                placeholder="Find a setting…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setConfirmReset(false);
                }}
              />
            </label>
            <div
              role="tablist"
              aria-label="Settings sections"
              aria-orientation={phone ? "horizontal" : "vertical"}
              onKeyDown={(e) => {
                const index = visiblePages.findIndex((p) => p.id === page);
                const next =
                  e.key === "ArrowDown" || e.key === "ArrowRight"
                    ? (index + 1) % visiblePages.length
                    : e.key === "ArrowUp" || e.key === "ArrowLeft"
                      ? (index + visiblePages.length - 1) % visiblePages.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? visiblePages.length - 1
                          : -1;
                if (next >= 0) {
                  e.preventDefault();
                  choose(visiblePages[next].id);
                  e.currentTarget
                    .querySelectorAll<HTMLButtonElement>("button")
                    [next]?.focus();
                }
              }}
            >
              {visiblePages.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-selected={!search && page === item.id}
                  aria-controls={`settings-page-${item.id}`}
                  tabIndex={page === item.id ? 0 : -1}
                  onClick={() => choose(item.id)}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.title}</span>
                  {page === item.id && !search && (
                    <span className="settings-nav-dot" />
                  )}
                </button>
              ))}
            </div>
            <div className="settings-nav-note">
              <span className="settings-saved-dot" />
              Changes preview instantly.
              <br />
              Saved on this device.
            </div>
          </aside>
          <div className="settings-content" ref={content}>
            <div className="settings-page-heading">
              <span className="settings-eyebrow">
                {search ? "Search results" : "Personalize your space"}
              </span>
              <h2>
                {search
                  ? `Settings matching “${query.trim()}”`
                  : pages.find((item) => item.id === page)?.title}
              </h2>
              <p>
                {search
                  ? "Adjust any matching setting below."
                  : pages.find((item) => item.id === page)?.subtitle}
              </p>
            </div>
            <Search.Provider value={search}>
              {show("appearance") && (
                <div
                  id="settings-page-appearance"
                  role={search ? undefined : "tabpanel"}
                  aria-labelledby="settings-tab-appearance"
                >
                  {visibleThemes.length > 0 && (
                    <section className="settings-group settings-themes">
                      <div className="settings-group-heading">
                        <h3>Choose your theme</h3>
                        <span>12 atmospheres</span>
                      </div>
                      <div className="theme-grid">
                        {visibleThemes.map((theme) => (
                          <button
                            type="button"
                            className="theme-card"
                            key={theme.id}
                            aria-label={`${theme.name} theme`}
                            aria-pressed={s.theme === theme.id}
                            onClick={() =>
                              updatePreferences({
                                theme: theme.id,
                                customAccent: "",
                                customBackground: "",
                                customSurface: "",
                              })
                            }
                            style={
                              {
                                "--preview-bg": theme.background,
                                "--preview-panel": theme.surface,
                                "--preview-text": theme.text,
                                "--preview-accent": theme.accent,
                              } as CSSProperties
                            }
                          >
                            <div className="theme-miniature" aria-hidden="true">
                              <div className="theme-mini-sidebar">
                                <i />
                                <i />
                                <i />
                              </div>
                              <div className="theme-mini-feed">
                                <i />
                                <i />
                                <div />
                                <span />
                              </div>
                              {s.theme === theme.id && (
                                <span className="theme-check">
                                  <Icon name="check" size={12} />
                                </span>
                              )}
                            </div>
                            <span className="theme-name">
                              {theme.name}
                              <i>{theme.dark ? "Dark" : "Light"}</i>
                            </span>
                            <span className="theme-description">
                              {theme.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <Group title="Colors">
                    <Toggle
                      label="Follow system theme"
                      hint="Automatically switch between Graphite and Daylight when your device changes appearance."
                      value={s.theme === "system"}
                      change={() =>
                        updatePreferences({
                          theme: s.theme === "system" ? p.theme.id : "system",
                          customAccent: "",
                          customBackground: "",
                          customSurface: "",
                        })
                      }
                    />
                    <Color
                      label="Accent color"
                      hint="Buttons, selected items, links, and focus rings. Adjusted for readable contrast."
                      value={s.customAccent}
                      fallback={p.theme.accent}
                      change={(value) => change("customAccent", value)}
                    />
                    <div
                      className="accent-swatches"
                      aria-label="Accent presets"
                    >
                      {[
                        "#94bfff",
                        "#b6a3ff",
                        "#ec9ec5",
                        "#e9b68a",
                        "#a9ce98",
                        "#85e3c8",
                        "#82d3eb",
                      ].map((color) => (
                        <button
                          type="button"
                          key={color}
                          style={{ background: color }}
                          title={color}
                          aria-label={`Use ${color} accent`}
                          aria-pressed={s.customAccent === color}
                          onClick={() => change("customAccent", color)}
                        />
                      ))}
                    </div>
                    <Color
                      label="Canvas color"
                      hint="The background beneath your glass panels."
                      value={s.customBackground}
                      fallback={p.theme.background}
                      change={(value) => change("customBackground", value)}
                    />
                    <Color
                      label="Surface color"
                      hint="The tint used for cards, menus, and panels. Text adjusts automatically."
                      value={s.customSurface}
                      fallback={p.theme.surface}
                      change={(value) => change("customSurface", value)}
                    />
                  </Group>
                </div>
              )}
              {show("glass") && (
                <div
                  id="settings-page-glass"
                  role={search ? undefined : "tabpanel"}
                  aria-labelledby="settings-tab-glass"
                >
                  <Group title="Glass effects">
                    <div className="glass-presets">
                      <button
                        type="button"
                        onClick={() =>
                          updatePreferences({
                            glass: true,
                            opacity: 84,
                            blur: 22,
                            saturation: 130,
                            glow: 55,
                            grain: 3,
                            borders: 45,
                            shadows: 55,
                          })
                        }
                      >
                        Frosted
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updatePreferences({
                            glass: true,
                            opacity: 68,
                            blur: 32,
                            saturation: 150,
                            glow: 75,
                            grain: 2,
                            borders: 60,
                            shadows: 70,
                          })
                        }
                      >
                        Crystal
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updatePreferences({
                            glass: false,
                            glow: 0,
                            grain: 0,
                            shadows: 20,
                          })
                        }
                      >
                        Solid
                      </button>
                    </div>
                    {toggle(
                      "glass",
                      "Enable glass",
                      "Translucent panels with a softened backdrop. Respects your device’s reduced transparency setting.",
                    )}
                    {reducedTransparency && (
                      <p className="settings-info">
                        Your device’s reduced transparency preference is active.
                      </p>
                    )}
                    {slider(
                      "opacity",
                      "Panel opacity",
                      "Lower values reveal more of the canvas.",
                      "%",
                      !s.glass || reducedTransparency,
                    )}
                    {slider(
                      "blur",
                      "Backdrop blur",
                      "Softens the colors behind glass panels.",
                      "px",
                      !s.glass || reducedTransparency,
                    )}
                    {slider(
                      "saturation",
                      "Glass saturation",
                      "Adds richness to the blurred backdrop.",
                      "%",
                      !s.glass || reducedTransparency,
                    )}
                    {slider(
                      "glow",
                      "Ambient glow",
                      "A quiet wash of your accent color behind the workspace.",
                      "%",
                      !s.glass || reducedTransparency,
                    )}
                    {slider(
                      "grain",
                      "Fine grain",
                      "A subtle texture that gives glass a tactile finish.",
                      "%",
                      !s.glass || reducedTransparency,
                    )}
                  </Group>
                  <Group title="Finish">
                    {slider(
                      "borders",
                      "Border strength",
                      "Set the contrast of panel edges.",
                      "%",
                    )}
                    {slider(
                      "shadows",
                      "Shadow depth",
                      "Control the lift beneath floating panels.",
                      "%",
                    )}
                    {slider(
                      "corners",
                      "Corner radius",
                      "From crisp squares to softer cards and composers.",
                      "px",
                    )}
                  </Group>
                </div>
              )}
              {show("layout") && (
                <div
                  id="settings-page-layout"
                  role={search ? undefined : "tabpanel"}
                  aria-labelledby="settings-tab-layout"
                >
                  <Group title="Layout">
                    {select(
                      "density",
                      "Interface density",
                      [
                        ["compact", "Compact"],
                        ["comfortable", "Comfortable"],
                        ["spacious", "Spacious"],
                      ],
                      "Controls, cards, and conversation spacing.",
                    )}
                    {!phone && (
                      <>
                        {select(
                          "sidebarMode",
                          "Sidebar style",
                          [
                            ["auto", "Automatic"],
                            ["expanded", "Expanded"],
                            ["rail", "Icons only"],
                          ],
                          "Automatic becomes an icon rail in smaller windows.",
                        )}
                        {slider(
                          "sidebarWidth",
                          "Sidebar width",
                          "Applied when the sidebar is expanded.",
                          "px",
                        )}
                      </>
                    )}
                    {!phone &&
                      slider(
                        "chatWidth",
                        "Conversation width",
                        "Maximum width of messages and the composer.",
                        "px",
                      )}
                    {slider(
                      "gutter",
                      "Conversation margins",
                      "Space around the conversation feed.",
                      "px",
                    )}
                  </Group>
                  <Group title="Typography">
                    {select("uiFont", "Interface font", [
                      ["system", "System · Segoe UI"],
                      ["classic", "Classic · Arial"],
                      ["rounded", "Rounded · Trebuchet"],
                    ])}
                    {slider(
                      "uiScale",
                      "Interface text scale",
                      "Resize labels and controls without changing message text.",
                      "%",
                    )}
                    {select("chatFont", "Message font", [
                      ["system", "Interface font"],
                      ["serif", "Serif · Georgia"],
                      ["mono", "Code font"],
                    ])}
                    {slider(
                      "chatFontSize",
                      "Message text size",
                      "For your messages and agent responses.",
                      "px",
                    )}
                    {slider(
                      "chatLineHeight",
                      "Message line spacing",
                      "Give longer responses a little more room.",
                    )}
                    {select(
                      "codeFont",
                      "Code font",
                      [
                        ["cascadia", "Cascadia Code"],
                        ["consolas", "Consolas"],
                        ["jetbrains", "JetBrains Mono"],
                        ["courier", "Courier New"],
                      ],
                      "Shared by code blocks and the terminal. Uses a local fallback if the font is unavailable.",
                    )}
                    {slider(
                      "codeFontSize",
                      "Code block text size",
                      undefined,
                      "px",
                    )}
                  </Group>
                  <Group title="Display">
                    {!phone &&
                      toggle(
                        "showStarters",
                        "Conversation starters",
                        "Show idea cards in an empty desktop conversation.",
                      )}
                    {toggle(
                      "showHints",
                      "Keyboard hints",
                      "Show composer and footer tips.",
                    )}
                    {toggle(
                      "showAvatars",
                      "Message avatars",
                      "Show identities beside message headers.",
                    )}
                    {!phone &&
                      toggle(
                        "alwaysShowCopy",
                        "Always show copy buttons",
                        "Keep message copy controls visible without hovering.",
                      )}
                    {select(
                      "motion",
                      "Animations",
                      [
                        ["system", "Follow device preference"],
                        ["reduced", "Reduced motion"],
                      ],
                      "Device reduced motion is always respected.",
                    )}
                  </Group>
                </div>
              )}
              {!phone && show("terminal") && (
                <div
                  id="settings-page-terminal"
                  role={search ? undefined : "tabpanel"}
                  aria-labelledby="settings-tab-terminal"
                >
                  {!search && (
                    <div
                      className="settings-terminal-preview"
                      aria-label="Terminal appearance preview"
                      style={{
                        fontSize: s.terminalFontSize,
                        lineHeight: s.terminalLineHeight,
                      }}
                    >
                      <span>~/your-workspace</span>
                      <p>
                        <b>❯</b> make something great
                        <span
                          className={`terminal-preview-cursor ${s.terminalCursor}${s.terminalBlink ? " blink" : ""}`}
                        />
                      </p>
                      <small>
                        Colors follow your theme. Active sessions stay
                        connected.
                      </small>
                    </div>
                  )}
                  <Group title="Terminal appearance">
                    {slider(
                      "terminalFontSize",
                      "Terminal text size",
                      "Ctrl + / − adjusts the active terminal. Ctrl 0 returns to this size.",
                      "px",
                    )}
                    {slider("terminalLineHeight", "Terminal line spacing")}
                    {select("terminalCursor", "Cursor style", [
                      ["bar", "Bar"],
                      ["block", "Block"],
                      ["underline", "Underline"],
                    ])}
                    {toggle(
                      "terminalBlink",
                      "Blinking cursor",
                      "Disabled automatically when reduced motion is active.",
                    )}
                    {slider(
                      "terminalScrollback",
                      "Scrollback lines",
                      "How much terminal output to keep in memory.",
                    )}
                  </Group>
                </div>
              )}
              {!phone && show("updates") && (
                <div id="settings-page-updates" role={search ? undefined : "tabpanel"} aria-labelledby="settings-tab-updates">
                  <Group title="App updates">
                    <Setting label="Velum Code" hint={updates ? `Installed version ${updates.current_version}` : "Update status unavailable."}>
                      {() => <button type="button" className="settings-button" onClick={() => void updateAction(() => openUrl("https://github.com/velumix/VelumCode/releases"))}>Release notes</button>}
                    </Setting>
                    {updates?.supported ? <>
                      <Toggle label="Automatic updates" hint="Check, download and install signed GitHub updates during the opening animation. While the app is open, updates download in the background." value={updates.automatic} change={() => void updateAction(() => setAutomaticUpdates(!updates.automatic))} disabled={busy || updates.phase === "installing"} />
                      <Setting label={updateMessage(updates)} hint="Updates install automatically at startup and download quietly in the background while running. Choose Restart to update when ready. Saved conversations and drafts are restored.">
                        {() => <div className="settings-update-actions">
                          <button type="button" className="settings-button" disabled={updating || updates.phase === "ready"} onClick={() => void updateAction(checkForUpdates)}>Check for updates</button>
                          {updates.phase === "available" && <button type="button" className="settings-button settings-primary" disabled={updating} onClick={() => void updateAction(downloadUpdate)}>Download update</button>}
                          {updates.phase === "ready" && <button type="button" className="settings-button settings-primary" disabled={updating} onClick={() => void updateAction(restartToUpdate)}>Restart to update</button>}
                        </div>}
                      </Setting>
                      {updates.phase === "downloading" && <progress className="settings-update-progress" aria-label="Update download progress" max={updates.total || undefined} value={updates.total ? updates.downloaded : undefined} />}
                      {updates.checked_at && <p className="settings-info">Last checked {new Date(updates.checked_at).toLocaleString()}.</p>}
                    </> : <p className="settings-info">App updates are available in the installed Windows release.</p>}
                    {(updateError || updates?.error) && <p className="settings-error" role="alert">{updateError || updates?.error}</p>}
                  </Group>
                </div>
              )}
              {show("preferences") && (
                <div
                  id="settings-page-preferences"
                  role={search ? undefined : "tabpanel"}
                  aria-labelledby="settings-tab-preferences"
                >
                  <Group title="Conversation preferences">
                    {!phone &&
                      select(
                        "sendShortcut",
                        "Send message with",
                        [
                          ["enter", "Enter"],
                          ["ctrl-enter", "Ctrl / ⌘ + Enter"],
                        ],
                        "Shift + Enter always inserts a new line. The Send button remains available.",
                      )}
                    {phone && (
                      <p className="settings-info">
                        On a phone, use Send or Ctrl / ⌘ + Enter. Enter inserts
                        a new line.
                      </p>
                    )}
                    {toggle("compactControls", "Compact assistant controls", "Keep provider and model controls folded until you need them.")}
                    {toggle("groupActivity", "Group agent activity", "Keep actions together so the response stays easy to follow. Open a group for the full details.")}
                    {select(
                      "toolOutput",
                      "Tool output by default",
                      [
                        ["preview", "Short preview"],
                        ["collapsed", "Collapsed"],
                        ["expanded", "Expanded"],
                      ],
                      "Choose how tool results initially appear. Each result can still be opened or closed.",
                    )}
                    {!phone &&
                      select(
                        "defaultProvider",
                        "New conversation provider",
                        [
                          ["last", "Last used provider"],
                          ["muse", "Muse"],
                          ["codex", "Codex"],
                          ["antigravity", "Antigravity"],
                        ],
                        "Applies to new conversations. Existing conversations keep their provider.",
                      )}
                  </Group>
                  {!phone && <ToolsSettings search={search} />}
                  {notifications && (
                    <Group title="Notifications">
                      <Toggle
                        label="Background notifications"
                        hint="Get a Windows notification when background work needs your attention."
                        value={notifications.enabled}
                        change={() => void action(notifications.toggle)}
                        disabled={busy}
                      />
                      <Setting
                        label="Test notification"
                        hint="Send a sample to Windows."
                      >
                        {() => (
                          <button
                            type="button"
                            className="settings-button"
                            onClick={() => void action(notifications.test)}
                            disabled={busy}
                          >
                            Send test
                          </button>
                        )}
                      </Setting>
                    </Group>
                  )}
                  <Group title="Your settings profile">
                    <Setting
                      label="Export settings"
                      hint="Save a JSON file with your appearance and preferences."
                    >
                      {() => (
                        <button
                          type="button"
                          className="settings-button"
                          onClick={exportSettings}
                        >
                          <Icon name="down" size={15} />
                          Export
                        </button>
                      )}
                    </Setting>
                    <Setting
                      label="Import settings"
                      hint="Load a Velum settings JSON file. Unsupported values are adjusted safely."
                    >
                      {() => (
                        <button
                          type="button"
                          className="settings-button"
                          onClick={() => file.current?.click()}
                        >
                          <Icon name="folder" size={15} />
                          Import
                        </button>
                      )}
                    </Setting>
                    <input
                      ref={file}
                      type="file"
                      accept=".json,application/json"
                      hidden
                      onChange={(e) => void importSettings(e.target.files?.[0])}
                    />
                    <Setting
                      label="Restore defaults"
                      hint="Reset appearance, layout, typography, and conversation preferences."
                    >
                      {() => (
                        <button
                          type="button"
                          ref={resetTrigger}
                          className="settings-button"
                          onClick={() => setConfirmReset(true)}
                        >
                          <Icon name="reset" size={15} />
                          Reset all
                        </button>
                      )}
                    </Setting>
                    {confirmReset && (
                      <div
                        className="settings-reset"
                        role="alertdialog"
                        aria-labelledby="settings-reset-title"
                      >
                        <strong id="settings-reset-title">
                          Restore default settings?
                        </strong>
                        <p>
                          Your custom appearance and preferences will be
                          replaced.
                        </p>
                        <div>
                          <button
                            ref={resetCancel}
                            type="button"
                            className="settings-button"
                            onClick={cancelReset}
                          >
                            Keep my settings
                          </button>
                          <button
                            type="button"
                            className="settings-button settings-primary"
                            onClick={() => {
                              updatePreferences({ ...defaults });
                              cancelReset();
                              setMessage("Default settings restored.");
                            }}
                          >
                            Restore defaults
                          </button>
                        </div>
                      </div>
                    )}
                  </Group>
                </div>
              )}
            </Search.Provider>
            <p className="settings-empty">
              No settings match “{query}”. Try theme, glass, font, or
              notifications.
            </p>
            {fileError && (
              <p className="settings-error" role="alert">
                {fileError}
              </p>
            )}
            {message && (
              <p className="settings-info" role="status">
                {message}
              </p>
            )}
          </div>
        </div>
        <footer className="settings-footer">
          <span
            role="status"
            className={status === "error" ? "settings-error" : ""}
          >
            <Icon name={status === "error" ? "bell" : "check"} size={14} />
            {status === "saving"
              ? "Saving changes…"
              : status === "error"
                ? error
                : "All changes saved"}
          </span>
          {status === "error" && (
            <button
              type="button"
              className="settings-button"
              onClick={retryPreferences}
            >
              Retry save
            </button>
          )}
          <button
            type="button"
            className="settings-button settings-primary"
            onClick={onClose}
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
