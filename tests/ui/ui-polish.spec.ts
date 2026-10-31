import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { boot } from "./fixture";

test("conversation toolbar is streamlined, informative, and accessible", async ({ page }) => {
  await boot(page);

  // 1. Toolbar structure and heading
  const toolbar = page.locator(".conversation-toolbar");
  await expect(toolbar).toBeVisible();
  const heading = toolbar.locator(".conversation-heading h1");
  await expect(heading).toBeVisible();
  await expect(heading).toContainText("New conversation");

  // Verify redundant static text is gone
  await expect(toolbar.locator(".section-label")).toHaveCount(0);

  // 2. Toolbar controls
  await expect(toolbar.getByRole("group", { name: "Tab mode" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Memory" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Git branches and diff" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Restart" })).toBeVisible();

  // 3. Accessibility check
  const axe = await new AxeBuilder({ page }).include(".conversation-toolbar").analyze();
  expect(axe.violations).toEqual([]);
});

test("statusbar footer displays tray pill, notification toggle, and passes accessibility", async ({ page }) => {
  await boot(page);

  const statusbar = page.locator(".statusbar");
  await expect(statusbar).toBeVisible();

  // Tray pill
  const trayPill = statusbar.locator(".footer-tray-pill");
  await expect(trayPill).toBeVisible();
  await expect(trayPill).toContainText("Tray");
  await expect(trayPill).toHaveAttribute("title", /system tray/i);

  // Notification toggle
  const notifToggle = statusbar.getByRole("button", { name: "Background notifications", exact: true });
  await expect(notifToggle).toBeVisible();
  await expect(notifToggle).toHaveText(/Alerts|Muted/);

  // Accessibility check
  const axe = await new AxeBuilder({ page }).include(".statusbar").analyze();
  expect(axe.violations).toEqual([]);
});

test("tool execution cards show duration telemetry and 1-click copy action", async ({ page }) => {
  await boot(page);

  // Send a prompt so the conversation begins
  await page.locator(".composer textarea").fill("Show diff");
  await page.locator(".composer textarea").press("Enter");

  // Simulate a tool execution with output
  await page.evaluate(() => {
    const q = (window as any).qa;
    q.agent({ kind: "tool_start", task_id: "task-test-1", name: "git_diff" });
    q.agent({ kind: "tool_delta", task_id: "task-test-1", text: "diff --git a/file.ts b/file.ts\n+console.log('polished');" });
    q.agent({ kind: "tool_end", task_id: "task-test-1", status: "completed" });
    q.agent({ kind: "turn_end", status: "completed", text: "Here is the diff." });
  });

  // Expand agent activity to reveal the tool card
  await page.locator(".activity-toggle").click();

  const toolCard = page.locator(".tool-card");
  await expect(toolCard).toBeVisible();

  // Check tool name and status
  await expect(toolCard.locator(".tool-name")).toContainText(/Git [Dd]iff/);
  await expect(toolCard.locator(".tool-status")).toHaveText("completed");

  // Check duration badge
  const duration = toolCard.locator(".tool-duration");
  await expect(duration).toBeVisible();
  await expect(duration).toHaveText(/ms|s/);

  // Click to open tool output
  await toolCard.locator(".tool-head").click();
  const output = toolCard.locator(".tool-output");
  await expect(output).toBeVisible();
  await expect(output).toContainText("diff --git a/file.ts");

  // Check copy button
  const copyBtn = toolCard.locator(".tool-output-copy");
  await expect(copyBtn).toBeVisible();
  await expect(copyBtn).toContainText("Copy");

  // Click copy and verify feedback
  await copyBtn.click();
  await expect(copyBtn).toContainText("Copied");

  // Accessibility check on tool card
  const axe = await new AxeBuilder({ page }).include(".tool-card").analyze();
  expect(axe.violations).toEqual([]);
});

test("unified header hierarchy, assistant summary pill, and chat view mode toggle pass accessibility", async ({ page }) => {
  await boot(page);

  // 1. Assistant summary pill bar
  const assistantSummary = page.locator(".assistant-summary");
  await expect(assistantSummary).toBeVisible();
  await expect(assistantSummary.locator(".assistant-summary-provider")).toBeVisible();
  await expect(assistantSummary.locator(".assistant-summary-model")).toBeVisible();

  // 2. Chat view header with bot pill and mode toggle
  const chatHeader = page.locator(".chat-view-header");
  await expect(chatHeader).toBeVisible();
  await expect(chatHeader.locator(".cv-bot-pill")).toBeVisible();

  const modeToggle = chatHeader.locator(".cv-mode-toggle");
  await expect(modeToggle).toBeVisible();
  const streamBtn = modeToggle.getByRole("button", { name: "Stream" });
  const splitBtn = modeToggle.getByRole("button", { name: "Split" });
  const dashBtn = modeToggle.getByRole("button", { name: "Dashboard" });

  await expect(streamBtn).toBeVisible();
  await expect(splitBtn).toBeVisible();
  await expect(dashBtn).toBeVisible();

  // 3. Switch to Split mode
  await splitBtn.click();
  await expect(splitBtn).toHaveClass(/active/);
  await expect(page.locator(".chat-main-area")).toHaveClass(/mode-split/);

  // Switch back to Stream mode
  await streamBtn.click();
  await expect(streamBtn).toHaveClass(/active/);

  // 4. Accessibility check
  const axe = await new AxeBuilder({ page }).include(".assistant-summary").include(".chat-view-header").analyze();
  expect(axe.violations).toEqual([]);
});
