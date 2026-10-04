export function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Choose a project';
}

export function correctionPrompt(answer: string, correction: string): string {
  const excerpt = Array.from(answer.trim()).slice(0, 600).join('');
  return `Please correct this earlier response:\n${excerpt}\n\nWhat to change:\n${correction.trim()}`;
}

export function lessonDraft(correction: string): string {
  return Array.from(correction.trim()).slice(0, 1200).join('');
}

export function lessonTitle(lesson: string): string {
  const text = lesson.trim().split('\n')[0].replace(/\s+/g, ' ');
  const encoder = new TextEncoder();
  let result = '', bytes = 0;
  for (const character of text || 'Project lesson') {
    bytes += encoder.encode(character).length;
    if (bytes > 160 || Array.from(result).length >= 80) break;
    result += character;
  }
  return result;
}

export function lastMatch<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return items[index];
  return undefined;
}

export interface RecoverableRequest {
  prompt: string;
  status: 'failed' | 'blocked' | 'cancelled' | 'not_sent';
}

export function recoverableRequest(status: string, prompt: string): RecoverableRequest | undefined {
  if (!prompt.trim() || !['failed', 'blocked', 'cancelled', 'not_sent'].includes(status)) return undefined;
  return { prompt, status: status as RecoverableRequest['status'] };
}

// A new request retires the previous turn's recovery controls. Informational
// notices can arrive after a failure without changing which request failed.
export function latestRecovery<T extends { kind: string; recovery?: RecoverableRequest }>(blocks: T[]): T | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.recovery) return block;
    if (block.kind === 'user') return undefined;
  }
  return undefined;
}

export function groupActivity<T extends { kind: string; id: number | string }>(blocks: T[], enabled: boolean): ({kind:'block';id:T['id'];block:T} | { kind: 'activity_group'; id: T['id']; items: T[] })[] {
  const result: ({kind:'block';id:T['id'];block:T} | { kind: 'activity_group'; id: T['id']; items: T[] })[] = [];
  for (const block of blocks) {
    if (!enabled || block.kind !== 'tool') { result.push({kind:'block',id:block.id,block}); continue; }
    const previous = result[result.length - 1];
    if (previous?.kind === 'activity_group') previous.items.push(block);
    else result.push({kind:'activity_group',id:block.id,items:[block]});
  }
  return result;
}

export const FRIENDLY_TOOLS: Record<string, string> = {
  powershell: "Shell",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  search: "Search",
  read_memory: "Memory",
  add_memory: "Memory",
  edit_memory: "Memory",
  request_user_input: "Question",
  write_todos: "Todos",
  web_fetch: "Web",
  web_search: "Web",
  inspect_file: "Inspect",
  delete_file: "Delete",
  workspace_search: "Search",
  git_status: "Git Status",
  git_branches: "Git Branches",
  git_diff: "Git Diff",
  vault_search: "Memory",
  turn_diagnostics: "Diagnostics",
  browser_open: "Browser",
  browser_snapshot: "Snapshot",
  browser_action: "Action",
  browser_screenshot: "Screenshot",
  apply_patch: "Patch",
  execute_command: "Command",
  bash: "Shell",
  sh: "Shell",
  cmd: "Command",
  list_dir: "List",
  list_directory: "List",
};

export function friendlyTool(name: string): string {
  return FRIENDLY_TOOLS[name] ?? name;
}

export interface SlashCommand {
  command: string;
  label: string;
  description: string;
  prompt: string;
  icon: import("./components/Icon").IconName;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "/fix",
    label: "Fix",
    description: "Investigate and resolve errors, test failures, or bugs",
    prompt: "Investigate and fix the issue or error in this project. Explain the root cause and implement the necessary changes cleanly.",
    icon: "bug",
  },
  {
    command: "/test",
    label: "Test",
    description: "Run existing tests or write tests for recent changes",
    prompt: "Run the tests for this project and report any failures, or write comprehensive tests for recent changes to verify everything works.",
    icon: "check",
  },
  {
    command: "/explain",
    label: "Explain",
    description: "Explain codebase architecture, modules, or logic flow",
    prompt: "Explain how this project or component is structured, including main entry points, data flow, and key design decisions.",
    icon: "search",
  },
  {
    command: "/review",
    label: "Review",
    description: "Review git changes, diff, and edge cases",
    prompt: "Review the recent changes and git diff in this project. Check for potential bugs, regressions, security considerations, and edge cases.",
    icon: "shield",
  },
  {
    command: "/diff",
    label: "Diff",
    description: "Summarize uncommitted git diff and status",
    prompt: "Check the current git status and diff in the project. Provide a concise summary of modified, added, or deleted files.",
    icon: "branch",
  },
  {
    command: "/refactor",
    label: "Refactor",
    description: "Improve code structure and quality without breaking behavior",
    prompt: "Refactor this code to improve modularity, clarity, and maintainability, preserving existing behavior and passing all tests.",
    icon: "code",
  },
  {
    command: "/doc",
    label: "Document",
    description: "Generate documentation, docstrings, and comments",
    prompt: "Add clear documentation, type annotations, and helpful comments explaining functions, types, and architectural modules.",
    icon: "memory",
  },
  {
    command: "/help",
    label: "Help",
    description: "Show Velum Code harness capabilities, tools, and shortcuts",
    prompt: "Provide a quick overview of Velum Code agent harness features: model & reasoning selection, interactive approvals, Git diff & branch viewer, memory vault, and embedded terminal.",
    icon: "command",
  },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const clean = query.trim().toLowerCase();
  if (!clean.startsWith("/")) return [];
  const tag = clean.slice(1);
  if (!tag) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => cmd.command.slice(1).startsWith(tag) || cmd.label.toLowerCase().includes(tag) || cmd.description.toLowerCase().includes(tag));
}
