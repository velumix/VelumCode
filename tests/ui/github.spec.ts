import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { boot } from "./fixture";

test("GitHub Hub displays account identity, repository stats, pulls, and issues with accessibility compliance", async ({ page }) => {
  await boot(page);
  // Open the Git & Version Control modal
  await page.getByRole("button", { name: "Git branches and diff", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Switch to GitHub Hub mode
  const githubBtn = page.getByRole("button", { name: "GitHub Hub", exact: true });
  await expect(githubBtn).toBeVisible();
  await githubBtn.click();

  // Check identity header & profile card
  await expect(page.getByText("@velumix")).toBeVisible();
  await expect(page.getByText("Connected (cli)")).toBeVisible();
  await expect(page.getByText("velumix/VelumCode").first()).toBeVisible();
  await expect(page.getByText("12 Stars")).toBeVisible();
  await expect(page.getByText("3 Forks")).toBeVisible();
  await expect(page.getByText("2 Issues")).toBeVisible();
  await expect(page.getByText("Branch: main")).toBeVisible();
  await expect(page.getByText("Public Repos")).toBeVisible();

  // Test Pull Requests tab
  await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
  await expect(page.getByText("#42")).toBeVisible();
  await expect(page.getByText("Support GitHub live identity and repository hub")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Agent" }).first()).toBeVisible();

  // Test Issues tab
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(page.getByText("#10")).toBeVisible();
  await expect(page.getByText("Add GitHub pull request and issue browser")).toBeVisible();
  await expect(page.getByText("enhancement")).toBeVisible();

  // Test Create New Issue form
  await page.getByRole("button", { name: "New Issue", exact: true }).click();
  await expect(page.getByPlaceholder("Issue title")).toBeVisible();
  await page.getByPlaceholder("Issue title").fill("Report a test issue from Velum");
  await page.getByPlaceholder("Description (Markdown supported)").fill("Details regarding this issue.");
  await page.getByRole("button", { name: "Submit Issue", exact: true }).click();
  await expect(page.getByText("#11")).toBeVisible();
  await expect(page.getByText("Report a test issue from Velum")).toBeVisible();

  // Test Account & Auth tab
  await page.getByRole("button", { name: "Account & Auth", exact: true }).click();
  await expect(page.getByText("GitHub CLI (Keyring)")).toBeVisible();
  await expect(page.getByText("Active (velumix)")).toBeVisible();
  await expect(page.getByLabel("Set Personal Access Token (Classic or Fine-Grained)")).toBeVisible();

  // Accessibility audit
  const axe = await new AxeBuilder({ page }).include(".git-panel").analyze();
  expect(axe.violations).toEqual([]);

  // Close modal
  await page.getByRole("button", { name: "Close Git panel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
