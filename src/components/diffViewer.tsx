export interface DiffRow {
  line: string;
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  old: number | null;
  next: number | null;
}

// Parse a unified diff into rows with true old/new file line numbers.
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      rows.push({ line, kind: "meta", old: null, next: null });
    } else if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      old = match ? Number(match[1]) : 0;
      next = match ? Number(match[2]) : 0;
      inHunk = true;
      rows.push({ line, kind: "hunk", old: null, next: null });
    } else if (!inHunk || line.startsWith("\\")) {
      rows.push({ line, kind: "meta", old: null, next: null });
    } else if (line.startsWith("+")) {
      const n = next;
      next += 1;
      rows.push({ line, kind: "add", old: null, next: n });
    } else if (line.startsWith("-")) {
      const n = old;
      old += 1;
      rows.push({ line, kind: "del", old: n, next: null });
    } else {
      const o = old;
      const n = next;
      old += 1;
      next += 1;
      rows.push({ line, kind: "ctx", old: o, next: n });
    }
  }
  return rows;
}

export function DiffLines({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  const rows = parseDiff(text);
  const changed = rows.filter(
    (row) => row.kind === "add" || row.kind === "del",
  ).length;
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !needle ||
        row.kind === "meta" ||
        row.kind === "hunk" ||
        row.line.toLowerCase().includes(needle),
    );
  const matched = needle ? visible.filter(({ row }) => row.kind !== "meta" && row.kind !== "hunk").length : 0;
  return (
    <>
      {needle && (
        <span className="git-diff-count" role="status">
          {matched} of {changed} changed lines match
          {matched === 0 ? " — clear the search to see the full diff." : "."}
        </span>
      )}
      {visible.map(({ row, index }) => (
        <span key={index} className={`git-diff-line git-diff-${row.kind}`}>
          <span className="git-diff-ln git-diff-old" aria-hidden="true">
            {row.old ?? ""}
          </span>
          <span className="git-diff-ln git-diff-new" aria-hidden="true">
            {row.next ?? ""}
          </span>
          <span className="git-diff-text">{row.line || " "}</span>
          {"\n"}
        </span>
      ))}
    </>
  );
}
