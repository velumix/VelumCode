export interface ChangedFile {
  x: string;
  y: string;
  path: string;
}

// Parse `git status --short --branch` text: the `##` header line plus one
// changed file per remaining line. Rename arrows resolve to the new path.
export function parseStatus(text: string): { header: string; files: ChangedFile[] } {
  const lines = text.split("\n");
  const header = lines[0]?.startsWith("##") ? lines[0].slice(3) : "";
  const files: ChangedFile[] = [];
  for (const line of lines.slice(1)) {
    if (line.length < 4) continue;
    const raw = line.slice(3);
    const path = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
    files.push({ x: line[0]!, y: line[1]!, path });
  }
  return { header, files };
}

export interface StatusGroups {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
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
