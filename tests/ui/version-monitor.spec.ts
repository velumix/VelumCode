import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { boot } from "./fixture";

test("header and footer display current version, monitor update state, and open updates settings", async ({
  page,
}) => {
  await boot(page);

  // 1. Header TitleBar version badge
  const headerBadge = page.locator(".titlebar-version");
  await expect(headerBadge).toBeVisible();
  await expect(headerBadge).toContainText(/v0\.7\./);

  // 2. Footer statusbar version chip
  const footerChip = page.locator(".statusbar-version");
  await expect(footerChip).toBeVisible();
  await expect(footerChip).toContainText(/v0\.7\./);

  // 3. Accessibility check on statusbar and titlebar
  const statusbarAxe = await new AxeBuilder({ page }).include(".statusbar").analyze();
  expect(statusbarAxe.violations).toEqual([]);

  const titlebarAxe = await new AxeBuilder({ page }).include(".titlebar").analyze();
  expect(titlebarAxe.violations).toEqual([]);

  // 4. Click header badge opens Settings Updates page
  await headerBadge.click();
  await expect(page.getByRole("dialog", { name: "Make yourself at home" })).toBeVisible();
  await expect(page.locator("#settings-page-updates")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 5. Click footer chip opens Settings Updates page
  await footerChip.click();
  await expect(page.getByRole("dialog", { name: "Make yourself at home" })).toBeVisible();
  await expect(page.locator("#settings-page-updates")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 6. Simulate update available: header, footer, and top banner reactively indicate the new version
  await page.evaluate(() => {
    (window as any).qa.update({
      phase: "available",
      version: "0.8.0",
    });
  });

  await expect(footerChip).toHaveClass(/update-available/);
  await expect(footerChip).toContainText(/→ v0\.8\.0/);
  await expect(headerBadge).toHaveClass(/has-update/);

  const availableBanner = page.locator(".update-banner.available");
  await expect(availableBanner).toBeVisible();
  await expect(availableBanner).toContainText("v0.8.0 is available");
  await expect(availableBanner.getByRole("button", { name: "Download update" })).toBeVisible();

  // 7. Simulate update ready: statusbar and top banner change to update-ready with Restart action
  await page.evaluate(() => {
    (window as any).qa.update({
      phase: "ready",
      version: "0.8.0",
    });
  });

  await expect(footerChip).toHaveClass(/update-ready/);
  await expect(footerChip).toContainText("Update ready · 0.8.0");

  const readyBanner = page.locator(".update-banner.ready");
  await expect(readyBanner).toBeVisible();
  await expect(readyBanner).toContainText("v0.8.0 is ready to install");
  await expect(readyBanner.getByRole("button", { name: "Restart to update" })).toBeVisible();

  // 8. Clicking "Later" dismisses the top banner while keeping the statusbar chip active
  await readyBanner.getByRole("button", { name: "Later" }).click();
  await expect(page.locator(".update-banner")).toHaveCount(0);
  await expect(footerChip).toContainText("Update ready · 0.8.0");
});
