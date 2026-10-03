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
