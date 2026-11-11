import type { ITheme } from "@xterm/xterm";

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  accent: string;
}

export const themes: readonly ThemePreset[] = [
  {
    id: "graphite",
    name: "Graphite",
    description: "Quiet charcoal, clear blue",
    dark: true,
    background: "#18191e",
    surface: "#272930",
    text: "#e8eaf0",
    accent: "#94bfff",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep navy, electric indigo",
    dark: true,
    background: "#101522",
    surface: "#202a40",
    text: "#e6edff",
    accent: "#b0baff",
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Northern lights in soft mint",
    dark: true,
    background: "#111e22",
    surface: "#22383b",
    text: "#e2f2ef",
    accent: "#85e3c8",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Near black with silver light",
    dark: true,
    background: "#0d0e10",
    surface: "#202124",
    text: "#ededf0",
    accent: "#c9cbd3",
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Marine blue, luminous cyan",
    dark: true,
    background: "#10202c",
    surface: "#203849",
    text: "#e1f0fa",
    accent: "#81d5f4",
  },
  {
    id: "orchid",
    name: "Orchid",
    description: "Smoky violet, lilac accents",
    dark: true,
    background: "#211a2b",
    surface: "#342b44",
    text: "#f1e8fa",
    accent: "#d3afff",
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm graphite, sunset copper",
    dark: true,
    background: "#251c19",
    surface: "#3c302a",
    text: "#f7ece3",
    accent: "#f4b98b",
  },
  {
    id: "forest",
    name: "Forest",
    description: "Moss, sage, a slower pace",
    dark: true,
    background: "#19211b",
    surface: "#2c392f",
    text: "#e8f0e6",
    accent: "#b7d49a",
  },
  {
    id: "daylight",
    name: "Daylight",
    description: "Crisp white, cobalt details",
    dark: false,
    background: "#edf1f7",
    surface: "#ffffff",
    text: "#202d43",
    accent: "#245dba",
  },
  {
    id: "linen",
    name: "Linen",
    description: "Warm paper, terracotta ink",
    dark: false,
    background: "#eee8dd",
    surface: "#fcf9f2",
    text: "#42352c",
    accent: "#975133",
  },
  {
    id: "lavender",
    name: "Lavender",
    description: "Pale lilac, plum details",
    dark: false,
    background: "#ede8f6",
    surface: "#faf7ff",
    text: "#392c4e",
    accent: "#7650a8",
  },
  {
    id: "mint",
    name: "Mint",
    description: "Fresh green, light and airy",
    dark: false,
    background: "#e5efea",
    surface: "#f7fdf9",
    text: "#233e34",
    accent: "#216c53",
  },
];

export const uiFonts = {
  system: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
  classic: "Arial, Helvetica, sans-serif",
  rounded: '"Trebuchet MS", "Segoe UI", sans-serif',
};
export const codeFonts = {
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Liberation Mono", monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  courier: '"Courier New", Courier, monospace',
};
export const chatFonts = {
  system: "var(--ui-font)",
  serif: 'Georgia, "Times New Roman", serif',
  mono: "var(--code-font)",
};

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
export function mix(a: string, b: string, amount: number): string {
  const target = rgb(b);
  return (
    "#" +
    rgb(a)
      .map((v, i) =>
        Math.round(v + (target[i] - v) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function alpha(color: string, opacity: number): string {
  return `rgba(${rgb(color).join(", ")}, ${Math.max(0, Math.min(1, opacity))})`;
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) =>
    v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
// Keep small labels and colored actions readable on every preset, including
// glass over its canvas. Custom colors use the same contrast correction.
function readable(color: string, backgrounds: string[], target = 4.6): string {
  const light = "#f9fafc",
    dark = "#10151d";
  let best = color,
    score = 0;
  for (let i = 0; i <= 100; i++) {
    for (const extreme of [light, dark]) {
      const candidate = mix(color, extreme, i / 100);
      const current = Math.min(
        ...backgrounds.map((b) => contrast(candidate, b)),
      );
      if (current >= target) return candidate;
      if (current > score) {
        best = candidate;
        score = current;
      }
    }
  }
  return best;
}

export interface AppearanceValues {
  theme: string;
  customAccent: string;
  customBackground: string;
  customSurface: string;
  glass: boolean;
  opacity: number;
  blur: number;
  saturation: number;
  glow: number;
  grain: number;
  borders: number;
  shadows: number;
  corners: number;
  density: "compact" | "comfortable" | "spacious";
  sidebarWidth: number;
  sidebarMode: "auto" | "expanded" | "rail";
  chatWidth: number;
  gutter: number;
  uiFont: keyof typeof uiFonts;
  uiScale: number;
  chatFont: keyof typeof chatFonts;
  chatFontSize: number;
  chatLineHeight: number;
  codeFont: keyof typeof codeFonts;
  codeFontSize: number;
  motion: "system" | "reduced";
  showStarters: boolean;
  showHints: boolean;
  showAvatars: boolean;
  alwaysShowCopy: boolean;
  sendShortcut: "enter" | "ctrl-enter";
  toolOutput: "preview" | "collapsed" | "expanded";
  compactControls: boolean;
  groupActivity: boolean;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursor: "bar" | "block" | "underline";
  terminalBlink: boolean;
  terminalScrollback: number;
  defaultProvider: "last" | "muse" | "codex" | "claude" | "antigravity";
}

export function resolvedTheme(
  settings: AppearanceValues,
  systemDark: boolean,
): ThemePreset {
  const id =
    settings.theme === "system"
      ? systemDark
        ? "graphite"
        : "daylight"
      : settings.theme;
  return themes.find((t) => t.id === id) || themes[0];
}

export function palette(settings: AppearanceValues, systemDark: boolean) {
  const theme = resolvedTheme(settings, systemDark);
  const bg = settings.customBackground || theme.background;
  const surface = settings.customSurface || theme.surface;
  const dark = luminance(surface) < 0.35;
  const text = readable(theme.text, [surface, bg], 7);
  const raised = mix(surface, text, dark ? 0.07 : 0.05);
  const hover = mix(surface, text, dark ? 0.11 : 0.08);
  let accent = readable(settings.customAccent || theme.accent, [
    surface,
    bg,
    raised,
    hover,
  ]);
  // Colored labels must remain legible on their selected and hover tints too.
  // A few iterations converge without washing out already readable presets.
  for (let i = 0; i < 12; i++) {
    const next = readable(accent, [
      surface,
      bg,
      raised,
      hover,
      mix(surface, accent, dark ? 0.16 : 0.1),
      mix(hover, accent, 0.16),
    ]);
    if (next === accent) break;
    accent = next;
  }
  const accentDim = mix(surface, accent, dark ? 0.16 : 0.1);
  const opacity = settings.glass ? settings.opacity / 100 : 1;
  const scrimCanvas = mix(bg, dark ? "#080b12" : "#35405b", 0.48);
  const surfaces = [
    bg,
    surface,
    raised,
    hover,
    accentDim,
    mix(scrimCanvas, surface, opacity),
    mix(
      bg,
      accent,
      settings.glass ? (settings.glow / 100) * (dark ? 0.19 : 0.11) : 0,
    ),
  ];
  const muted = readable(mix(surface, text, 0.65), surfaces, 6);
  const subtle = readable(mix(surface, text, 0.55), surfaces, 5.2);
  return {
    theme,
    bg,
    surface,
    dark,
    text,
    accent,
    raised,
    hover,
    accentDim,
    muted,
    subtle,
    primary: readable(settings.customAccent || theme.accent, [surface], 3.1),
    border: mix(surface, text, 0.2),
    strongBorder: mix(surface, text, 0.32),
    ok: readable(dark ? "#9cddb0" : "#237046", surfaces),
    danger: readable(dark ? "#ffb1ab" : "#b92f40", surfaces),
    warning: readable(dark ? "#ebce97" : "#8c5a19", surfaces),
  };
}

export function terminalTheme(
  settings: AppearanceValues,
  systemDark: boolean,
): ITheme {
  const p = palette(settings, systemDark);
  const ansi = p.dark
    ? [
        p.bg,
        "#e88f8a",
        "#a4d893",
        "#e5c078",
        "#91bbf7",
        "#d3a1e8",
        "#8ad4d6",
        p.text,
      ]
    : [
        "#253047",
        "#b53040",
        "#237046",
        "#88600f",
        "#245dba",
        "#8549a2",
        "#146e80",
        "#697182",
      ];
  return {
    background: p.bg,
    foreground: p.text,
    cursor: p.accent,
    cursorAccent: p.bg,
    selectionBackground: alpha(p.accent, 0.28),
    selectionForeground: p.text,
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: p.muted,
    brightRed: ansi[1],
    brightGreen: ansi[2],
    brightYellow: ansi[3],
    brightBlue: ansi[4],
    brightMagenta: ansi[5],
    brightCyan: ansi[6],
    brightWhite: p.text,
  };
}

export function applyAppearance(
  settings: AppearanceValues,
  systemDark: boolean,
  reduceTransparency: boolean,
) {
  const p = palette(settings, systemDark);
  const root = document.documentElement;
  const glass = settings.glass && !reduceTransparency;
  const opacity = glass ? settings.opacity / 100 : 1;
  const glow = glass ? settings.glow / 100 : 0;
  const values: Record<string, string> = {
    bg: p.bg,
    panel: p.surface,
    sidebar: mix(p.bg, p.surface, 0.55),
    raised: p.raised,
    hover: p.hover,
    text: p.text,
    muted: p.muted,
    subtle: p.subtle,
    accent: p.accent,
    blue: p.primary,
    "on-accent":
      contrast(p.primary, "#ffffff") >= contrast(p.primary, "#000000")
        ? "#ffffff"
        : "#000000",
    "accent-dim": p.accentDim,
    "accent-hover": mix(p.hover, p.accent, 0.16),
    "accent-border": mix(p.surface, p.accent, 0.42),
    border: mix(p.surface, p.text, 0.1 + (settings.borders / 100) * 0.22),
    "strong-border": p.strongBorder,
    "control-border": p.strongBorder,
    "control-bg": p.surface,
    danger: p.danger,
    "danger-bg": mix(p.surface, p.danger, 0.13),
    "danger-border": mix(p.surface, p.danger, 0.36),
    ok: p.ok,
    "ok-bg": mix(p.surface, p.ok, 0.12),
    "ok-border": mix(p.surface, p.ok, 0.3),
    warning: p.warning,
    "warning-bg": mix(p.surface, p.warning, 0.12),
    "warning-border": mix(p.surface, p.warning, 0.3),
    "code-bg": mix(p.bg, p.surface, 0.2),
    selection: alpha(p.accent, 0.28),
    scrim: alpha(p.dark ? "#080b12" : "#35405b", 0.48),
    "glass-panel": alpha(p.surface, opacity),
    "glass-sidebar": alpha(mix(p.bg, p.surface, 0.55), opacity),
    "glass-highlight": alpha(
      p.dark ? "#ffffff" : "#ffffff",
      glass ? 0.04 + (settings.borders / 100) * 0.07 : 0,
    ),
    "glass-filter": glass
      ? `blur(${settings.blur}px) saturate(${settings.saturation}%)`
      : "none",
    "glass-shadow": `0 14px 40px ${alpha("#000000", (settings.shadows / 100) * (p.dark ? 0.28 : 0.12))}`,
    "glow-a": alpha(p.accent, glow * (p.dark ? 0.19 : 0.11)),
    "glow-b": alpha(p.accent, glow * (p.dark ? 0.08 : 0.06)),
    "grain-opacity": glass ? String(settings.grain / 100) : "0",
    radius: `${settings.corners}px`,
    "control-radius": `${Math.min(settings.corners, 8)}px`,
    "sidebar-width": `${settings.sidebarWidth}px`,
    "chat-width": `${settings.chatWidth}px`,
    gutter: `${settings.gutter}px`,
    density:
      settings.density === "compact"
        ? ".8"
        : settings.density === "spacious"
          ? "1.18"
          : "1",
    "control-height":
      settings.density === "compact"
        ? "30px"
        : settings.density === "spacious"
          ? "36px"
          : "32px",
    "ui-font": uiFonts[settings.uiFont],
    "ui-scale": String(settings.uiScale / 100),
    "chat-font": chatFonts[settings.chatFont],
    "chat-font-size": `${settings.chatFontSize}px`,
    "chat-line-height": String(settings.chatLineHeight),
    "code-font": codeFonts[settings.codeFont],
    "code-font-size": `${settings.codeFontSize}px`,
    "phone-bg": p.bg,
    "phone-panel": p.surface,
  };
  for (const [name, value] of Object.entries(values))
    root.style.setProperty(`--${name}`, value);
  root.style.colorScheme = p.dark ? "dark" : "light";
  root.dataset.theme = p.theme.id;
  root.dataset.glass = String(glass);
  root.dataset.motion = settings.motion;
  root.dataset.sidebar = settings.sidebarMode;
  root.dataset.starters = String(settings.showStarters);
  root.dataset.hints = String(settings.showHints);
  root.dataset.avatars = String(settings.showAvatars);
  root.dataset.copy = settings.alwaysShowCopy ? "always" : "hover";
}
