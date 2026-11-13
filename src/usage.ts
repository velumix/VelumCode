export interface ContextUsage {
  used_tokens: number;
  window_tokens: number | null;
  measured_at: number;
  /** True when the provider reported no capacity and `used_tokens` is a
      flagged estimate (Muse). The strip must label it, never show a %. */
  estimated?: boolean;
}

export interface TurnUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  elapsed_ms: number | null;
}

export interface UsageSnapshot {
  context?: ContextUsage | null;
  turn?: TurnUsage | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function mergeUsage(previous: UsageSnapshot, event: Record<string, unknown>): UsageSnapshot {
  const next = { ...previous };
  const context = record(event.context);
  const used = count(context?.used_tokens);
  const stamp = count(context?.measured_at);
  if (context && used !== null && stamp !== null) {
    const capacity = count(context.window_tokens);
    next.context = { used_tokens: used, window_tokens: capacity && capacity > 0 ? capacity : null, measured_at: stamp, estimated: context.estimated === true };
  }
  const turn = record(event.turn);
  if (turn) next.turn = {
    input_tokens: count(turn.input_tokens), cached_input_tokens: count(turn.cached_input_tokens),
    output_tokens: count(turn.output_tokens), reasoning_output_tokens: count(turn.reasoning_output_tokens), elapsed_ms: count(turn.elapsed_ms),
  };
  return next;
}

/** One subscription usage window from the signed-in provider account. */
export interface LimitWindow {
  name: string;
  /** Fraction used, 0–1. */
  utilization: number | null;
  /** Unix seconds when the window resets. */
  resets_at: number | null;
}

export interface RateLimits {
  status: string;
  windows: LimitWindow[];
}

export function parseRateLimits(event: Record<string, unknown>): RateLimits | null {
  const status = typeof event.status === "string" ? event.status : "";
  if (!status || !Array.isArray(event.windows)) return null;
  const windows = event.windows.flatMap((value): LimitWindow[] => {
    const window = record(value);
    if (!window || typeof window.name !== "string") return [];
    const used = window.utilization;
    return [{
      name: window.name,
      utilization: typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : null,
      resets_at: count(window.resets_at),
    }];
  }).slice(0, 8);
  return windows.length ? { status, windows } : null;
}

export function limitLabel(name: string): string {
  const labels: Record<string, string> = {
    five_hour: "5-hour", seven_day: "Weekly", seven_day_opus: "Weekly (Opus)", seven_day_sonnet: "Weekly (Sonnet)",
  };
  return Object.prototype.hasOwnProperty.call(labels, name) ? labels[name] : name.replace(/_/g, " ");
}

export function tokenRate(turn?: TurnUsage | null, elapsedMs = turn?.elapsed_ms): number | null {
  const output = count(turn?.output_tokens);
  const elapsed = count(elapsedMs);
  if (output === null || elapsed === null || elapsed === 0) return null;
  const rate = output * 1000 / elapsed;
  return Number.isFinite(rate) ? rate : null;
}

export function compactCount(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
