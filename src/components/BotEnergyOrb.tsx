import { useEffect, useRef } from "react";

export type OrbStatus = "idle" | "starting" | "thinking" | "working" | "done" | "error" | "disabled";

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
            ? mix(cachedBase, [255, 90, 85], 0.7)
            : currentMode === "done"
              ? mix(cachedBase, [80, 240, 180], 0.65)
              : currentMode === "thinking"
                ? mix(cachedBase, [168, 85, 247], 0.45)
                : currentMode === "working"
                  ? mix(cachedBase, [120, 200, 255], 0.35)
                  : currentMode === "starting"
                    ? mix(cachedBase, [100, 130, 255], 0.45)
                    : currentMode === "disabled"
                      ? [128, 134, 148]
                      : cachedBase;
        cachedLight = mix(
          cachedTint,
          [255, 255, 255],
          currentMode === "disabled" ? 0.25 : currentMode === "working" ? 0.7 : 0.55,
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
      const r = Math.min(w, h) / 2;

      // Jitter offset during error
      const jx = mode === "error" ? (Math.random() - 0.5) * r * 0.08 : 0;
      const jy = mode === "error" ? (Math.random() - 0.5) * r * 0.08 : 0;
      const cx = w / 2 + jx;
      const cy = h / 2 + jy;

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

      // Collect node positions for synaptic filaments (in thinking mode)
      const nodePositions: { x: number; y: number }[] = [];

      // Orbiting plasma blobs
      for (const b of blobs) {
        const speedMultiplier = mode === "working" ? 2.2 : mode === "thinking" ? 1.4 : 1;
        const angle = b.phase + phaseAcc * b.speed * 0.6 * speedMultiplier;
        const wob =
          1 +
          0.18 *
            Math.sin(phaseAcc * b.wobble + b.phase) *
            (mode === "working" ? 1.8 : 1);
        const px = cx + Math.cos(angle) * r * b.orbit * 2.4 * wob;
        const py = cy + Math.sin(angle) * r * b.orbit * 2.4 * wob;
        nodePositions.push({ x: px, y: py });

        const br = r * b.radius * 2.2 * (mode === "working" ? wob * 1.15 : 1);
        const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(br, 1));
        g.addColorStop(0, css(light, mode === "disabled" ? 0.5 : 0.88));
        g.addColorStop(0.5, css(tint, mode === "disabled" ? 0.35 : 0.55));
        g.addColorStop(1, css(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(br, 1), 0, Math.PI * 2);
        ctx.fill();
      }

      // Thinking: draw synaptic filaments between close nodes
      if (mode === "thinking") {
        for (let i = 0; i < nodePositions.length; i++) {
          for (let j = i + 1; j < nodePositions.length; j++) {
            const dx = nodePositions[i].x - nodePositions[j].x;
            const dy = nodePositions[i].y - nodePositions[j].y;
            const dist = Math.hypot(dx, dy);
            if (dist < r * 1.05) {
              const alpha = (1 - dist / (r * 1.05)) * (0.35 + 0.35 * Math.sin(phaseAcc * 3 + i));
              ctx.strokeStyle = css(light, alpha);
              ctx.lineWidth = Math.max(1, w * 0.02);
              ctx.beginPath();
              ctx.moveTo(nodePositions[i].x, nodePositions[i].y);
              ctx.lineTo(nodePositions[j].x, nodePositions[j].y);
              ctx.stroke();
            }
          }
        }
      }

      // Working: energetic coronal solar rays around the rim
      if (mode === "working") {
        const flareCount = 10;
        ctx.lineWidth = Math.max(1, w * 0.025);
        for (let i = 0; i < flareCount; i++) {
          const fa = (i / flareCount) * Math.PI * 2 + phaseAcc * 1.8;
          const flen = r * (0.85 + 0.13 * Math.sin(phaseAcc * 4.5 + i * 2));
          const fx1 = cx + Math.cos(fa) * (r * 0.72);
          const fy1 = cy + Math.sin(fa) * (r * 0.72);
          const fx2 = cx + Math.cos(fa) * flen;
          const fy2 = cy + Math.sin(fa) * flen;
          ctx.strokeStyle = css(light, 0.5 + 0.4 * Math.sin(phaseAcc * 3 + i));
          ctx.beginPath();
          ctx.moveTo(fx1, fy1);
          ctx.lineTo(fx2, fy2);
          ctx.stroke();
        }
      }

      // Done: harmonic outward wave bloom
      if (mode === "done") {
        const waveProgress = (pulseAcc % 2.5) / 2.5;
        const waveR = r * (0.3 + 0.65 * waveProgress);
        const waveAlpha = (1 - waveProgress) * 0.7;
        ctx.strokeStyle = css(light, waveAlpha);
        ctx.lineWidth = Math.max(1.5, w * 0.04 * (1 - waveProgress));
        ctx.beginPath();
        ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Rim light, breathing slowly (faster and brighter while working/thinking)
      const pulseSpeed = mode === "working" ? 2.5 : mode === "thinking" ? 1.6 : 1;
      const pulse = 0.55 + 0.35 * Math.sin(pulseAcc * pulseSpeed);
      ctx.strokeStyle = css(light, mode === "disabled" ? 0.35 : pulse);
      ctx.lineWidth = Math.max(1, w * 0.035);
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
      const isThinking = mode === "thinking";
      const speed = isWorking ? 2.6 : isThinking ? 1.6 : mode === "starting" ? 2.0 : 0.85;
      const pulseSpeed = isWorking ? 3.6 : isThinking ? 2.2 : mode === "error" ? 3.8 : 1.1;

      phaseAcc += dt * speed;
      pulseAcc += dt * pulseSpeed;

      const frameInterval = isWorking ? 16 : isThinking ? 20 : 45;
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
