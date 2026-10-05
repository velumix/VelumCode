import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// gitStatus.ts ships no unit harness, so compile the single dependency-free
// module with the repo's TypeScript and exercise it directly.
async function loadGitStatus() {
  mkdirSync(".qa", { recursive: true });
  const dir = mkdtempSync(path.resolve(".qa/gitstatus-"));
  const compile = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2020",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--outDir",
      dir,
      "src/components/gitStatus.ts",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  return import(pathToFileURL(path.join(dir, "gitStatus.js")).href);
}

test("gitStatus describes files in plain language", async () => {
  const { describeFile } = await loadGitStatus();
  assert.equal(
    describeFile({ x: "?", y: "?", path: "new.tsx" }),
    "Untracked — not yet in Git",
  );
  assert.equal(describeFile({ x: "M", y: " ", path: "a.tsx" }), "Modified (staged)");
  assert.equal(describeFile({ x: " ", y: "M", path: "a.tsx" }), "Modified (unstaged)");
  assert.equal(
    describeFile({ x: "M", y: "M", path: "a.tsx" }),
    "Modified in index and working tree",
  );
  assert.equal(
    describeFile({ x: "A", y: "M", path: "a.tsx" }),
    "Added (staged), modified (unstaged)",
  );
  assert.equal(describeFile({ x: " ", y: "D", path: "a.tsx" }), "Deleted (unstaged)");
});

test("gitStatus parses renames, CRLF and short lines", async () => {
  const { parseStatus } = await loadGitStatus();
  const { header, files } = parseStatus(
    "## main...origin/main\r\n M src/App.tsx\r\nR  old.tsx -> new.tsx\r\n?? added.tsx\r\nX\r\n",
  );
  assert.equal(header, "main...origin/main");
  assert.deepEqual(
    files.map((f) => f.path),
    ["src/App.tsx", "new.tsx", "added.tsx"],
  );
});

test("gitStatus summarizes branches and detached HEAD", async () => {
  const { parseStatus, summarizeStatus } = await loadGitStatus();
  const { header, files } = parseStatus("## main...origin/main\n M src/App.tsx\n?? added.tsx");
  assert.equal(
    summarizeStatus(header, files),
    "On branch main, tracking origin/main · 1 unstaged, 1 untracked",
  );
  assert.equal(summarizeStatus("HEAD (no branch)", []), "Detached HEAD (no branch) · clean");
  assert.equal(summarizeStatus("", []), "Working tree · clean");
});
