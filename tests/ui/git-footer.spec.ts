import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { boot } from "./fixture";

const composer = (page: Page) => page.locator(".chat-wrap:not(.hidden) .composer textarea");

test("footer shows the selected conversation branch and opens the Git panel", async ({ page }) => {
  await boot(page);
  const chip = page.getByRole("button", { name: /Git: .* on main/ });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("main");
  await expect(chip).toContainText("2");
  await chip.click();
  await expect(page.getByRole("dialog")).toContainText("main");
  expect((await new AxeBuilder({ page }).include(".statusbar").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Close Git panel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("conversation pill names the model and follows the live state", async ({ page }) => {
  await boot(page);
  const tab = page.locator('[role="tab"]').first();
  await expect(tab).toContainText("muse-deep");
  await composer(page).fill("Pill state check");
  await composer(page).press("Enter");
  await expect(tab).toContainText("Working");
  await page.evaluate(() => (window as any).qa.agent({ kind: "turn_end", status: "completed", text: "done" }));
  await expect(tab).toContainText("All caught up");
});
