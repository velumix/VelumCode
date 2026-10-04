#!/usr/bin/env node
// Publish guard for @velum-code/plugin-sdk.
// Blocks `npm publish` / `npm pack` until the owner/legal SDK license
// decision is recorded and the approved LICENSE ships with the package.
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

const problems = [];
if (typeof manifest.license !== "string" || manifest.license.trim().length === 0) {
  problems.push("package.json \"license\" is unset (record the approved SDK license first)");
}
if (!existsSync(resolve(target, "LICENSE"))) {
  problems.push("LICENSE file is missing from packages/plugin-sdk/");
}

if (problems.length > 0) {
  console.error(
    "publish-guard: SDK publication blocked — no license has been approved.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\nComplete legal/publisher.json (sdkLicense), add packages/plugin-sdk/LICENSE, " +
      "and set the matching \"license\" field before publishing. See LEGAL.md.",
  );
  process.exit(1);
}
