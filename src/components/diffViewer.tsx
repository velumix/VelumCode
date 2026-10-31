import { useMemo } from "react";

export interface DiffRow {
  line: string;
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  old: number | null;
  next: number | null;
  hunkIndex?: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  total: number;
  hunkCount: number;
}

export interface DiffSegment {
  text: string;
  isWordChange?: boolean;
  kind?: "add" | "del";
}

export interface SplitRow {
  kind: "meta" | "hunk" | "pair";
  metaLine?: string;
  hunkLine?: string;
  hunkIndex?: number;
  left?: {
    line: string;
    old: number | null;
    kind: "del" | "ctx";
    segs?: DiffSegment[];
  };
  right?: {
    line: string;
    next: number | null;
    kind: "add" | "ctx";
    segs?: DiffSegment[];
  };
}

export function getDiffStats(text: string): DiffStats {
  if (!text) {
    return { additions: 0, deletions: 0, total: 0, hunkCount: 0 };
  }
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      hunkCount++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { additions, deletions, total: additions + deletions, hunkCount };
}

// Parse a unified diff into rows with true old/new file line numbers.
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  let hunkCount = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      rows.push({ line, kind: "meta", old: null, next: null });
    } else if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      old = match ? Number(match[1]) : 0;
      next = match ? Number(match[2]) : 0;
      inHunk = true;
      rows.push({ line, kind: "hunk", old: null, next: null, hunkIndex: hunkCount++ });
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

export function computeIntraLineDiff(
  delLine: string,
  addLine: string
): { delSegs: DiffSegment[]; addSegs: DiffSegment[] } | null {
  const delBody = delLine.startsWith("-") ? delLine.slice(1) : delLine;
  const addBody = addLine.startsWith("+") ? addLine.slice(1) : addLine;

  if (!delBody.trim() && !addBody.trim()) return null;

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(delBody.length, addBody.length);
  while (prefixLen < minLen && delBody[prefixLen] === addBody[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    delBody[delBody.length - 1 - suffixLen] === addBody[addBody.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // If there's no commonality at all, or whole line changed, skip intra-line diff
  if (prefixLen === 0 && suffixLen === 0) return null;

  const delPrefix = (delLine.startsWith("-") ? "-" : "") + delBody.slice(0, prefixLen);
  const delChanged = delBody.slice(prefixLen, delBody.length - suffixLen);
  const delSuffix = delBody.slice(delBody.length - suffixLen);

  const addPrefix = (addLine.startsWith("+") ? "+" : "") + addBody.slice(0, prefixLen);
  const addChanged = addBody.slice(prefixLen, addBody.length - suffixLen);
  const addSuffix = addBody.slice(addBody.length - suffixLen);

  const delSegs: DiffSegment[] = [];
  if (delPrefix) delSegs.push({ text: delPrefix });
  if (delChanged) delSegs.push({ text: delChanged, isWordChange: true, kind: "del" });
  if (delSuffix) delSegs.push({ text: delSuffix });

  const addSegs: DiffSegment[] = [];
  if (addPrefix) addSegs.push({ text: addPrefix });
  if (addChanged) addSegs.push({ text: addChanged, isWordChange: true, kind: "add" });
  if (addSuffix) addSegs.push({ text: addSuffix });

  return { delSegs, addSegs };
}

export function computeWordDiffMap(rows: DiffRow[]): Map<number, DiffSegment[]> {
  const map = new Map<number, DiffSegment[]>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === "del") {
      const delStart = i;
      while (i < rows.length && rows[i].kind === "del") {
        i++;
      }
      const delCount = i - delStart;

      const addStart = i;
      while (i < rows.length && rows[i].kind === "add") {
        i++;
      }
      const addCount = i - addStart;

      const pairs = Math.min(delCount, addCount);
      for (let p = 0; p < pairs; p++) {
        const delIdx = delStart + p;
        const addIdx = addStart + p;
        const pairDiff = computeIntraLineDiff(rows[delIdx].line, rows[addIdx].line);
        if (pairDiff) {
          map.set(delIdx, pairDiff.delSegs);
          map.set(addIdx, pairDiff.addSegs);
        }
      }
    } else {
      i++;
    }
  }
  return map;
}

export function buildSplitRows(rows: DiffRow[], wordMap?: Map<number, DiffSegment[]>): SplitRow[] {
  const result: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "meta") {
      result.push({ kind: "meta", metaLine: row.line });
      i++;
    } else if (row.kind === "hunk") {
      result.push({ kind: "hunk", hunkLine: row.line, hunkIndex: row.hunkIndex });
      i++;
    } else if (row.kind === "ctx") {
      result.push({
        kind: "pair",
        left: { line: row.line, old: row.old, kind: "ctx" },
        right: { line: row.line, next: row.next, kind: "ctx" },
      });
      i++;
    } else if (row.kind === "del" || row.kind === "add") {
      const dels: { row: DiffRow; index: number }[] = [];
      const adds: { row: DiffRow; index: number }[] = [];
      while (i < rows.length && rows[i].kind === "del") {
        dels.push({ row: rows[i], index: i });
        i++;
      }
      while (i < rows.length && rows[i].kind === "add") {
        adds.push({ row: rows[i], index: i });
        i++;
      }
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        const d = dels[k];
        const a = adds[k];
        result.push({
          kind: "pair",
          left: d
            ? {
                line: d.row.line,
                old: d.row.old,
                kind: "del",
                segs: wordMap?.get(d.index),
              }
            : undefined,
          right: a
            ? {
                line: a.row.line,
                next: a.row.next,
                kind: "add",
                segs: wordMap?.get(a.index),
              }
            : undefined,
        });
      }
    } else {
      i++;
    }
  }
  return result;
}

function renderSegmentsOrText(line: string, segs?: DiffSegment[]) {
  if (!segs || segs.length === 0) return line || " ";
  return (
    <>
      {segs.map((seg, i) =>
        seg.isWordChange ? (
          <span
            key={i}
            className={seg.kind === "add" ? "git-diff-word-add" : "git-diff-word-del"}
          >
            {seg.text}
          </span>
        ) : (
          seg.text
        )
      )}
    </>
  );
}

export interface DiffLinesProps {
  text: string;
  query?: string;
  mode?: "unified" | "split";
  wordDiff?: boolean;
}

export function DiffLines({ text, query = "", mode = "unified", wordDiff = true }: DiffLinesProps) {
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => parseDiff(text), [text]);
  const wordMap = useMemo(
    () => (wordDiff ? computeWordDiffMap(rows) : new Map<number, DiffSegment[]>()),
    [rows, wordDiff]
  );

  const changed = useMemo(
    () => rows.filter((row) => row.kind === "add" || row.kind === "del").length,
    [rows]
  );

  const visibleUnified = useMemo(() => {
    return rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          !needle ||
          row.kind === "meta" ||
          row.kind === "hunk" ||
          row.line.toLowerCase().includes(needle)
      );
  }, [rows, needle]);

  const matchedUnified = needle
    ? visibleUnified.filter(({ row }) => row.kind !== "meta" && row.kind !== "hunk").length
    : 0;

  const splitRows = useMemo(() => {
    if (mode !== "split") return [];
    const baseSplit = buildSplitRows(rows, wordMap);
    if (!needle) return baseSplit;
    return baseSplit.filter((sr) => {
      if (sr.kind === "meta" || sr.kind === "hunk") return true;
      const leftMatch = sr.left?.line.toLowerCase().includes(needle);
      const rightMatch = sr.right?.line.toLowerCase().includes(needle);
      return leftMatch || rightMatch;
    });
  }, [mode, rows, wordMap, needle]);

  return (
    <>
      {needle && (
        <span className="git-diff-count" role="status">
          {matchedUnified} of {changed} changed lines match
          {matchedUnified === 0 ? " — clear the search to see the full diff." : "."}
        </span>
      )}

      {mode === "split" ? (
        <div className="git-diff-split-container">
          {splitRows.map((sr, sidx) => {
            if (sr.kind === "meta") {
              return (
                <div key={sidx} className="git-diff-line git-diff-meta">
                  <span className="git-diff-text">{sr.metaLine}</span>
                </div>
              );
            }
            if (sr.kind === "hunk") {
              return (
                <div
                  key={sidx}
                  id={sr.hunkIndex != null ? `diff-hunk-${sr.hunkIndex}` : undefined}
                  className="git-diff-line git-diff-hunk git-diff-split-hunk-row"
                >
                  <span className="git-diff-text">{sr.hunkLine}</span>
                </div>
              );
            }
            return (
              <div key={sidx} className="git-diff-split-row">
                <div
                  className={`git-diff-split-col left ${
                    sr.left ? `git-diff-${sr.left.kind}` : "git-diff-split-empty"
                  }`}
                >
                  {sr.left ? (
                    <>
                      <span className="git-diff-ln git-diff-old" aria-hidden="true">
                        {sr.left.old ?? ""}
                      </span>
                      <span className="git-diff-text">
                        {renderSegmentsOrText(sr.left.line, sr.left.segs)}
                      </span>
                    </>
                  ) : (
                    <span className="git-diff-ln" aria-hidden="true"> </span>
                  )}
                </div>
                <div
                  className={`git-diff-split-col right ${
                    sr.right ? `git-diff-${sr.right.kind}` : "git-diff-split-empty"
                  }`}
                >
                  {sr.right ? (
                    <>
                      <span className="git-diff-ln git-diff-new" aria-hidden="true">
                        {sr.right.next ?? ""}
                      </span>
                      <span className="git-diff-text">
                        {renderSegmentsOrText(sr.right.line, sr.right.segs)}
                      </span>
                    </>
                  ) : (
                    <span className="git-diff-ln" aria-hidden="true"> </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        visibleUnified.map(({ row, index }) => (
          <span
            key={index}
            id={row.kind === "hunk" && row.hunkIndex != null ? `diff-hunk-${row.hunkIndex}` : undefined}
            className={`git-diff-line git-diff-${row.kind}`}
          >
            <span className="git-diff-ln git-diff-old" aria-hidden="true">
              {row.old ?? ""}
            </span>
            <span className="git-diff-ln git-diff-new" aria-hidden="true">
              {row.next ?? ""}
            </span>
            <span className="git-diff-text">
              {renderSegmentsOrText(row.line, wordMap.get(index))}
            </span>
            {"\n"}
          </span>
        ))
      )}
    </>
  );
}
