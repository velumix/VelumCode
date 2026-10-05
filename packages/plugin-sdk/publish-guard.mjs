#!/usr/bin/env node
// Publish guard for @velum-code/plugin-sdk.
// Blocks `npm publish` / `npm pack` until the SDK license recorded in
// legal/publisher.json (sdkLicense) matches package.json "license" and the
// approved LICENSE file ships with the package.
// See LEGAL.md, docs/legal-release.md, and legal/publisher.json (sdkLicense).
// Optional argv[2]: directory to check (used by tests). Defaults to this file's dir.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const manifestPath = resolve(target, "package.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.error(`publish-guard: cannot read ${manifestPath}`);
  process.exit(1);
}

// Walk up from the target so copies of the SDK outside this repository fall
// back to the license+LICENSE checks below when no publisher record exists.
function findPublisherRecord(start) {
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "legal/publisher.json");
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const problems = [];
const license = typeof manifest.license === "string" ? manifest.license.trim() : "";
if (license.length === 0) {
  problems.push('package.json "license" is unset (record the approved SDK license first)');
}

// The recorded owner/legal decision is authoritative when reachable: the
// published license must match it, not just be non-empty.
const record = findPublisherRecord(target);
if (record) {
  const decided = typeof record.sdkLicense === "string" ? record.sdkLicense.trim() : "";
  if (decided.length === 0) {
    problems.push("legal/publisher.json records no sdkLicense decision yet");
  } else if (license !== decided) {
    problems.push(
      `package.json "license" (${license === "" ? "unset" : JSON.stringify(license)}) does not match the recorded sdkLicense decision (${JSON.stringify(decided)})`,
    );
  }
}

const licensePath = resolve(target, "LICENSE");
if (!existsSync(licensePath)) {
  problems.push("LICENSE file is missing from packages/plugin-sdk/");
} else {
  const text = readFileSync(licensePath, "utf8");
  if (text.trim().length === 0) {
    problems.push("LICENSE file is empty");
  } else if (license === "Apache-2.0" && !text.includes("Apache License")) {
    problems.push('LICENSE does not contain the Apache License text matching "license": "Apache-2.0"');
  }
}

if (problems.length > 0) {
  console.error(
    "publish-guard: SDK publication blocked — the SDK license is not approved for publication.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\nComplete legal/publisher.json (sdkLicense), add packages/plugin-sdk/LICENSE, " +
      "and set the matching \"license\" field before publishing. See LEGAL.md.",
  );
  process.exit(1);
}
