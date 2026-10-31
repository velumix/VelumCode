import type { Provider, RunOptions } from "./providers";
export interface BotIdentity {
  id: string;
  name: string;
  avatar: string;
  color: string;
  role?: string;
}
export interface BotProfile extends BotIdentity {
  role: string;
  enabled: boolean;
  provider: Provider;
  options: RunOptions;
  soul: string;
  agent: string;
  shared_memory: boolean;
  memory_budget: number;
  default_cron: string;
  timezone: string;
  automatic: boolean;
  allow_handoffs: boolean;
  max_minutes: number;
  revision: string;
}
export interface BotView {
  profiles: BotProfile[];
  root: string;
  warnings: string[];
}
export type BotRequest =
  | { action: "list" }
  | { action: "save"; profile: BotProfile }
  | { action: "delete"; id: string; revision: string };
export interface Assignment {
  bot_id: string;
  cron: string;
  timezone: string;
  automatic: boolean;
}
export interface Job {
  blocked_by?: string[];
  due_date?: string | null;
  priority?: string;
  id: string;
  workspace: string;
  card_id: string;
  title: string;
  assignment: Assignment;
  next_run: number;
  paused: boolean;
  status: string;
  last_error: string;
  failures: number;
  chain: number;
  handoff: string;
  day: number;
  day_runs: number;
}
export interface BotRun {
  workspace: string;
  id: string;
  job_id: string;
  session_id: string;
  bot_id: string;
  bot_name: string;
  provider: Provider;
  options: RunOptions;
  task: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  output: string;
  detail: string;
  max_minutes: number;
}
export interface AutomationView {
  enabled: boolean;
  jobs: Job[];
  runs: BotRun[];
  warning: string | null;
}
export type AutomationRequest =
  | { action: "list" }
  | { action: "configure"; enabled: boolean }
  | { action: "pause"; id: string; paused: boolean }
  | { action: "run" | "stop"; id: string }
  | { action: "preview"; cron: string; timezone: string };
export const localTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function newBot(provider: Provider, options: RunOptions): BotProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    role: "",
    avatar: "",
    color: "#79a9ff",
    enabled: true,
    provider,
    options: { ...options },
    soul: "You are {{name}}. Be thoughtful, direct, and clear. Keep your personality consistent regardless of the underlying provider. Be candid about uncertainty.",
    agent:
      "Work toward the requested outcome. Inspect before changing things, verify your work, and report what remains. Keep durable facts in memory. Use Kanban to track assigned work. Hand off to a suitable teammate when their expertise is needed, including context, evidence, and a concrete next step.",
    shared_memory: true,
    memory_budget: 3000,
    default_cron: "*/15 * * * *",
    timezone: localTimezone(),
    automatic: true,
    allow_handoffs: true,
    max_minutes: 20,
    revision: "",
  };
}
export function assignmentFor(bot: BotProfile): Assignment {
  return {
    bot_id: bot.id,
    cron: bot.default_cron,
    timezone: bot.timezone,
    automatic: bot.automatic,
  };
}

export const botPresets = [
  {
    id: "builder",
    name: "Builder",
    role: "Implementation and verification",
    color: "#79a9ff",
    soul: "You are {{name}}, a practical builder. Be direct, thoughtful, and honest about uncertainty. Prefer working results and clear evidence to confident claims.",
    agent:
      "Check Kanban and complete prerequisites before starting your assigned task. Read the relevant code and project instructions, make a focused change, and run appropriate verification. Keep durable project decisions in memory. Update the card with changes, checks, and remaining risks. Move finished work to Review or hand it to a reviewer with a concise summary. Do not mark work Done without evidence.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Code review and regression checks",
    color: "#bd9cff",
    soul: "You are {{name}}, a calm, exacting reviewer. Be constructive and specific. Distinguish proven defects from questions or preferences; explain the impact of each finding.",
    agent:
      "Check the assigned Kanban task, its prerequisites, acceptance criteria, and the previous handoff. Inspect changes and relevant tests. Prioritize correctness, regressions, security, and maintainability. Report findings with file locations and reproduction evidence. Keep lasting project conventions in memory. Hand actionable fixes to the appropriate bot; move clean work to Review with a clear account of what was verified. Do not make unrelated edits.",
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Investigation, planning, and documentation",
    color: "#76cbb1",
    soul: "You are {{name}}, a curious and careful investigator. Explain findings plainly. Separate facts, assumptions, and open questions; cite the evidence behind conclusions.",
    agent:
      "Check Kanban for the assigned question and completed prerequisites. Inspect local project context first, and use primary sources when external research is needed and tools are available. Produce a concise recommendation, constraints, and concrete acceptance criteria. Save stable decisions and useful references in memory. Hand implementation to an appropriate bot with evidence and a clear next step. Do not invent sources or claim unperformed verification.",
  },
] as const;
export function duplicateBot(bot: BotProfile): BotProfile {
  let name = "";
  const encoder = new TextEncoder();
  for (const character of bot.name) {
    if (encoder.encode(name + character).length > 75) break;
    name += character;
  }
  return {
    ...bot,
    id: crypto.randomUUID(),
    name: `${name} copy`,
    options: { ...bot.options },
    revision: "",
    automatic: false,
  };
}
export function when(value: number) {
  return new Date(value * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
