// Bump the app to the next free PATCH version and stage every file a
// manual "chore: bump" commit touches. Used by the auto-release workflow so
// every push to main ships a signed, published update without human steps.
// Local use: `node scripts/auto-bump.mjs` (leaves changes uncommitted).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: "utf8" }).trim();
const tagExists = (version) => {
  try {
    git(`rev-parse --verify --quiet v${version}`);
    return true;
  } catch {
    return false;
  }
};

const app = JSON.parse(read("package.json"));
const [major, minor, patch] = app.version.split(".").map(Number);
let next = `${major}.${minor}.${patch + 1}`;
while (tagExists(next)) {
  const parts = next.split(".").map(Number);
  next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}
const prev = app.version;
console.log(`Bumping ${prev} -> ${next}`);

// Version strings the release manifest checks for consistency.
const pkg = JSON.parse(read("package.json"));
pkg.version = next;
write("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(read("package-lock.json"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
write(
  "src-tauri/Cargo.toml",
  read("src-tauri/Cargo.toml").replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`),
);
write(
  "src-tauri/Cargo.lock",
  read("src-tauri/Cargo.lock").replace(/(name = "velum-code"\nversion = ")[^"]+(")/, `$1${next}$2`),
);
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
conf.version = next;
write("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

// Human-facing version references.
const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Denver" });
write(
  "PRIVACY.md",
  read("PRIVACY.md")
    .replace(/(desktop )\d+\.\d+\.\d+/, `$1${next}`)
    .replace(/(desktop [\d.]+ and Android companion [\d.]+, )[A-Z][a-z]+ \d{1,2}, \d{4}/, `$1${today}`),
);
write("TERMS.md", read("TERMS.md").replace(/(Version )\d+\.\d+\.\d+( has no)/, `$1${next}$2`));
const publisher = JSON.parse(read("legal/publisher.json"));
publisher.reviewedAppVersion = next;
write("legal/publisher.json", JSON.stringify(publisher, null, 2) + "\n");
write("tests/ui/fixture.ts", read("tests/ui/fixture.ts").replace(/(current_version: ")[^"]+(")/, `$1${next}$2`));

// Release notes from everything shipped since the previous release tag.
let notes = `# Velum Code ${next}\n`;
try {
  const lastTag = git("describe --tags --abbrev=0");
  const subjects = git(`log ${lastTag}..HEAD --format=%s`).split("\n").filter(Boolean);
  const interesting = subjects.filter((s) => !/^\[skip ci\]/.test(s)).slice(0, 12);
  notes += `\n${interesting.map((s) => `- ${s}`).join("\n")}\n`;
} catch {
  notes += `\n- Velum Code ${next}. See the GitHub release for details.\n`;
}
write(`docs/releases/${next}.md`, notes);

// Regenerate the dependency inventory, input hashes and third-party notices
// for the new version (same as a manual bump).
execFileSync(process.execPath, ["scripts/legal-notices.mjs"], { cwd: root, stdio: "inherit" });

console.log(`Staged bump to ${next}.`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${next}\n`);
