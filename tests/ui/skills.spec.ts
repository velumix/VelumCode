import { test, expect, type Page } from "@playwright/test";
import { boot } from "./fixture";

const BODY =
  "---\nname: Review checklist\ndescription: Review a change carefully.\n---\n# Review checklist\n\nUse this skill when the user asks for a review. Check correctness first.";

async function skillFixture(page: Page) {
  await page.evaluate((body) => {
    const w = window as any;
    const manifest = {
      apiVersion: 1,
      id: "velum.review-checklist",
      name: "Review checklist",
      version: "1.0.0",
      description: "Review a change carefully.",
      author: "Velumix",
      entry: "SKILL.md",
      tags: ["review"],
    };
    const skill = {
      manifest,
      enabled: true,
      digest: "reviewed-skill",
      origin: {
        repository: "velumix/velum-skill-review-checklist",
        commit: "a".repeat(40),
      },
    };
    w.qa.skills = [];
    w.qa.skillCatalog = {
      catalog: {
        schemaVersion: 1,
        skills: [
          {
            manifest,
            repository: "velumix/velum-skill-review-checklist",
            commit: "a".repeat(40),
          },
        ],
      },
      fetched_at: 1,
      notice: null,
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (!cmd.startsWith("skills_") && cmd !== "agent_configure_skills")
        return original(cmd, args);
      w.qa.calls.push({ cmd, args });
      if (cmd === "agent_configure_skills") return [...args.skillIds];
      if (cmd === "skills_catalog") return structuredClone(w.qa.skillCatalog);
      if (cmd === "skills_list") return structuredClone(w.qa.skills);
      if (cmd === "skills_preview")
        return { ...skill, bytes: body.length, body };
      if (cmd === "skills_install") {
        w.qa.skills = [skill];
        return;
      }
      if (cmd === "skills_enable") {
        const found = w.qa.skills.find(
          (s: any) => s.manifest.id === args.id,
        );
        if (found) found.enabled = args.enabled;
        return;
      }
      if (cmd === "skills_remove") {
        w.qa.skills = w.qa.skills.filter(
          (s: any) => s.manifest.id !== args.id,
        );
        return;
      }
      if (cmd === "skills_content") {
        const found = w.qa.skills.find(
          (s: any) => s.manifest.id === args.id,
        );
        return { manifest: found.manifest, body: found.body || body };
      }
      if (cmd === "skills_save_local") {
        const draft = args.draft;
        const id =
          draft.id ||
          `local.${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        const saved = {
          manifest: {
            apiVersion: 1,
            id,
            name: draft.name,
            version: "local",
            description: draft.description,
            author: "You",
            entry: "SKILL.md",
            tags: draft.tags,
          },
          enabled: true,
          digest: `digest-${id}`,
          origin: null,
          body: draft.body,
        };
        w.qa.skills = [
          ...w.qa.skills.filter((s: any) => s.manifest.id !== id),
          saved,
        ];
        return structuredClone(saved);
      }
    };
  }, BODY);
}

test("skills browse, review full instructions, install, and toggle for this chat", async ({
  page,
}) => {
  await boot(page);
  await skillFixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Review checklist");
  await page
    .getByRole("button", { name: "Review & install", exact: true })
    .click();
  const review = page.locator(".plugin-review");
  await expect(review).toContainText(
    "Instructions sent to your provider when enabled",
  );
  await expect(review.locator("pre")).toContainText(
    "Check correctness first.",
  );
  await page.getByRole("button", { name: "Install skill", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Enable Review checklist" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close skills" }).click();
  await page
    .getByRole("button", { name: "Skills for this conversation" })
    .click();
  await page
    .locator(".skill-picker-item", { hasText: "Review checklist" })
    .locator("input")
    .check();
  await expect(
    page.getByRole("button", { name: "Skills for this conversation" }),
  ).toContainText("Skills (1)");
  const configure = await page.evaluate(
    () =>
      (window as any).qa.calls.filter(
        (c: any) => c.cmd === "agent_configure_skills",
      ),
  );
  expect(configure.at(-1).args.skillIds).toEqual(["velum.review-checklist"]);
});

test("create a local skill and read it back", async ({ page }) => {
  await boot(page);
  await skillFixture(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await page.getByLabel("Skill name").fill("Release notes");
  await page
    .getByLabel("Skill description")
    .fill("Draft release notes from merged changes.");
  await page
    .getByLabel("Skill instructions")
    .fill("# Release notes\n\nUse this skill when the user asks for release notes.");
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.locator(".plugin-card")).toContainText("Release notes");
  await expect(page.locator(".plugin-card")).toContainText("Local skill");
  await page
    .getByRole("button", { name: "View instructions", exact: false })
    .click();
  await expect(page.locator(".plugin-run pre")).toContainText(
    "Use this skill when the user asks for release notes.",
  );
});
