import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { boot } from "./fixture";
test("Git panel shows branches, status and per-file diff without editing", async ({page}) => {
  await boot(page);
  await page.getByRole("button",{name:"Git branches and diff",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("main");
  await expect(page.getByLabel("Compare working tree against")).toHaveValue("main");
  await page.getByLabel("Compare working tree against").selectOption("improve/ui-customization");
  await expect(page.getByRole("button",{name:/src\/App\.tsx/})).toBeVisible();
  await expect(page.getByRole("button",{name:/GitPanel\.tsx/})).toBeVisible();
  await page.getByRole("button",{name:/src\/App\.tsx/}).click();
  await expect(page.getByLabel("Diff of src/App.tsx")).toContainText("+new");
  await expect(page.getByText("never changes files",{exact:false})).toBeVisible();
  expect((await new AxeBuilder({page}).include(".git-panel").analyze()).violations).toEqual([]);
  await page.getByRole("button",{name:"Close Git panel",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
