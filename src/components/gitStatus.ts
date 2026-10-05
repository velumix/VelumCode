export interface ChangedFile {
  x: string;
  y: string;
  path: string;
}

// Parse `git status --short --branch` text: the `##` header line plus one
// changed file per remaining line. Rename arrows resolve to the new path.
export function parseStatus(text: string): { header: string; files: ChangedFile[] } {
  const lines = text.split("\n");
  const head = lines[0]?.startsWith("##") ? lines[0].slice(3) : "";
  const header = head.endsWith("\r") ? head.slice(0, -1) : head;
  const files: ChangedFile[] = [];
  for (const raw of lines.slice(1)) {
    // Backends may emit CRLF; a trailing carriage return is not part of the path.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // XY + space + path needs at least 4 characters; shorter lines carry no file.
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
    files.push({ x: line[0]!, y: line[1]!, path });
  }
  return { header, files };
}

export interface StatusGroups {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
}

// Human words for one `git status --short` XY column. Empty means clean.
function columnWord(code: string): string {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return "";
  }
}

// Plain-language description of one changed file, e.g. "Modified (staged)",
// "Modified in index and working tree" or "Untracked — not yet in Git".
// Used for button labels and tooltips so raw `XY` flags never stand alone.
export function describeFile(file: ChangedFile): string {
  if (file.x === "?" && file.y === "?") return "Untracked — not yet in Git";
  const staged = columnWord(file.x);
  const unstaged = columnWord(file.y);
  if (staged && unstaged) {
    return staged === unstaged
      ? `${cap(staged)} in index and working tree`
      : `${cap(staged)} (staged), ${unstaged} (unstaged)`;
  }
  if (staged) return `${cap(staged)} (staged)`;
  if (unstaged) return `${cap(unstaged)} (unstaged)`;
  return "Changed";
}

function cap(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

// Friendly one-line summary of `git status --short --branch` output, e.g.
// "On branch main, tracking origin/main · 1 staged, 1 unstaged, 1 untracked".
// The raw `##` header stays available in `header` for tooltips.
export function summarizeStatus(
  header: string,
  files: ChangedFile[],
  groups?: StatusGroups,
): string {
  const branch = header.split(" [")[0] ?? "";
  const [on, tracking] = branch.includes("...")
    ? branch.split("...")
    : [branch, ""];
  const counts = groups ?? groupStatus(files);
  const parts: string[] = [];
  if (counts.staged.length > 0)
    parts.push(`${counts.staged.length} staged`);
  if (counts.unstaged.length > 0)
    parts.push(`${counts.unstaged.length} unstaged`);
  if (counts.untracked.length > 0)
    parts.push(`${counts.untracked.length} untracked`);
  const name = on?.trim() ?? "";
  // Detached HEAD reports as `HEAD (no branch)` — never claim it is a branch.
  const where = name.startsWith("HEAD")
    ? `Detached ${name}`
    : name
      ? `On branch ${name}`
      : "Working tree";
  const follow = tracking?.trim() ? `, tracking ${tracking.trim()}` : "";
  if (parts.length === 0) return `${where}${follow} · clean`;
  return `${where}${follow} · ${parts.join(", ")}`;
}

// Split `git status --short` files into staged (index column), unstaged
// (worktree column) and untracked (`??`). A both-modified file (`MM`)
// appears in staged and unstaged so neither side looks clean.
export function groupStatus(files: ChangedFile[]): StatusGroups {
  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];
  for (const file of files) {
    if (file.x === "?" && file.y === "?") {
      untracked.push(file);
      continue;
    }
    if (file.x !== " " && file.x !== "?") staged.push(file);
    if (file.y !== " " && file.y !== "?") unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}
