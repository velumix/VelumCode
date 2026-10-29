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

test("GitHub Hub filters pulls and issues by search term and copies markdown references", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Git branches and diff", exact: true }).click();
  await page.getByRole("button", { name: "GitHub Hub", exact: true }).click();

  // Test Pull Requests search filter
  await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
  await expect(page.getByText("#42")).toBeVisible();
  const prSearch = page.getByPlaceholder("Filter pull requests…");
  await expect(prSearch).toBeVisible();
  await prSearch.fill("nonexistent keyword");
  await expect(page.getByText(/No pull requests match/)).toBeVisible();
  await prSearch.fill("42");
  await expect(page.getByText("#42")).toBeVisible();
  await page.getByRole("button", { name: "Copy Ref" }).first().click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  // Test Issues search filter
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(page.getByText("#10")).toBeVisible();
  const issueSearch = page.getByPlaceholder("Filter issues…");
  await expect(issueSearch).toBeVisible();
  await issueSearch.fill("browser");
  await expect(page.getByText("#10")).toBeVisible();
  await issueSearch.fill("xyz-not-found");
  await expect(page.getByText(/No issues match/)).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByText("#10")).toBeVisible();
});
