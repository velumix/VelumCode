import { useEffect, useRef } from "react";

export type OrbStatus = "idle" | "working" | "error" | "disabled";

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean.slice(0, 6).padEnd(6, "0");
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return [121, 169, 255];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const css = (c: [number, number, number], alpha: number) =>
  `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;

/**
 * Ball-of-energy bot visual. Deterministic per seed (bot name), tinted by the
 * bot accent color, animated by status. Static when reduced motion is set.
 */
export default function BotEnergyOrb({
  color,
  size,
  status = "idle",
  seed = "",
}: {
  color: string;
  size: number;
  status?: OrbStatus;
  seed?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ color, status, seed });
  stateRef.current = { color, status, seed };
  const maybeStartRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));

    const rng = mulberry32(hashSeed(`${seed}\u0000${color}`));
    const blobs = Array.from({ length: 5 }, () => ({
      orbit: 0.12 + rng() * 0.26,
      phase: rng() * Math.PI * 2,
      wobble: 0.5 + rng() * 1.5,
      radius: 0.1 + rng() * 0.16,
      speed: 0.4 + rng() * 0.9,
    }));

    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Cache computed palette and core gradient to avoid per-frame allocations
    let cachedColor = "";
    let cachedMode = "";
    let cachedBase: [number, number, number] = [121, 169, 255];
    let cachedTint: [number, number, number] = [121, 169, 255];
    let cachedLight: [number, number, number] = [255, 255, 255];
    let cachedDark: [number, number, number] = [8, 12, 24];
    let cachedCoreGradient: CanvasGradient | null = null;

    const getPalette = (currentColor: string, currentMode: OrbStatus) => {
      if (currentColor !== cachedColor || currentMode !== cachedMode || !cachedCoreGradient) {
        cachedColor = currentColor;
        cachedMode = currentMode;
        cachedBase = hexToRgb(currentColor);
        cachedTint =
          currentMode === "error"
            ? mix(cachedBase, [255, 107, 94], 0.55)
            : currentMode === "disabled"
              ? [128, 134, 148]
              : cachedBase;
        cachedLight = mix(
          cachedTint,
          [255, 255, 255],
          currentMode === "disabled" ? 0.25 : 0.55,
        );
        cachedDark = mix(cachedTint, [8, 12, 24], 0.72);

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const r = Math.min(canvas.width, canvas.height) / 2;
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        core.addColorStop(0, css(cachedLight, currentMode === "disabled" ? 0.9 : 0.95));
        core.addColorStop(0.35, css(cachedTint, currentMode === "disabled" ? 0.75 : 0.9));
        core.addColorStop(1, css(cachedDark, 1));
        cachedCoreGradient = core;
      }
      return {
        base: cachedBase,
        tint: cachedTint,
        light: cachedLight,
        dark: cachedDark,
        core: cachedCoreGradient,
      };
    };

    const draw = (phaseAcc: number, pulseAcc: number) => {
      const { color: current, status: mode } = stateRef.current;
      const { tint, light, core } = getPalette(current, mode);

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2;
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();

      // Deep core (reusing cached gradient)
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // Orbiting plasma blobs.
      for (const b of blobs) {
        const angle = b.phase + phaseAcc * b.speed * 0.6;
        const wob =
          1 +
          0.18 *
            Math.sin(phaseAcc * b.wobble + b.phase) *
            (mode === "working" ? 1.6 : 1);
        const px = cx + Math.cos(angle) * r * b.orbit * 2.4 * wob;
        const py = cy + Math.sin(angle) * r * b.orbit * 2.4 * wob;
        const br = r * b.radius * 2.2 * (mode === "working" ? wob : 1);
        const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(br, 1));
        g.addColorStop(0, css(light, mode === "disabled" ? 0.5 : 0.85));
        g.addColorStop(0.5, css(tint, mode === "disabled" ? 0.35 : 0.55));
        g.addColorStop(1, css(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(br, 1), 0, Math.PI * 2);
        ctx.fill();
      }

      // Rim light, breathing slowly (faster while working).
      const pulse = 0.55 + 0.3 * Math.sin(pulseAcc);
      ctx.strokeStyle = css(light, mode === "disabled" ? 0.35 : pulse);
      ctx.lineWidth = Math.max(1, w * 0.03);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    };

    if (reduced) {
      draw(1.2, 1.2);
      return;
    }

    let frame = 0;
    let running = false;
    let phaseAcc = 0;
    let pulseAcc = 0;
    let lastTime = performance.now();
    let lastDrawTime = 0;

    const tick = (now: number) => {
      if (!running) return;
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const { status: mode } = stateRef.current;
      if (mode === "disabled") {
        draw(phaseAcc, pulseAcc);
        stop();
        return;
      }

      const isWorking = mode === "working";
      const speed = isWorking ? 2.4 : 0.9;
      phaseAcc += dt * speed;
      pulseAcc += dt * (isWorking ? 3.4 : 1.1);

      const frameInterval = isWorking ? 16 : 50; // ~20fps for idle saves battery
      if (now - lastDrawTime >= frameInterval) {
        lastDrawTime = now;
        draw(phaseAcc, pulseAcc);
      }

      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    let onScreen = true;
    const maybeStart = () => {
      const mode = stateRef.current.status;
      if (onScreen && document.visibilityState === "visible" && mode !== "disabled") {
        start();
      } else {
        stop();
        draw(phaseAcc, pulseAcc);
      }
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries[0]?.isIntersecting !== false;
            maybeStart();
          });
    if (observer) observer.observe(canvas);
    document.addEventListener("visibilitychange", maybeStart);
    maybeStartRef.current = maybeStart;
    maybeStart();

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", maybeStart);
      maybeStartRef.current = () => {};
      stop();
    };
  }, [size]);

  useEffect(() => {
    maybeStartRef.current();
  }, [status, color]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block", borderRadius: "50%" }}
      aria-hidden="true"
    />
  );
}
