import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {boot, pickProvider, revealAssistant} from "./fixture";
const composer = (page: Page) => page.locator(".chat-wrap:not(.hidden) textarea");

test('memory cannot close or prompt to discard while a save is pending',async({page})=>{
  await boot(page);await page.getByRole('button',{name:'Memory',exact:true}).click();
  await page.getByRole('button',{name:'New note',exact:true}).click();
  await page.getByLabel('Memory title',{exact:true}).fill('Save before closing');
  await page.getByLabel('Memory note',{exact:true}).fill('Keep this fact.');
  await page.evaluate(()=>{(window as any).qa.holdMemorySave=true;});
  await page.getByRole('button',{name:'Save note',exact:true}).click();
  await expect(page.getByLabel('Close memory')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Discard your unsaved changes?')).toHaveCount(0);
  await expect(page.locator('.memory-panel')).toBeVisible();
  await page.evaluate(()=>{(window as any).qa.releaseMemorySave();});
  await expect(page.getByLabel('Close memory')).toBeEnabled();
  await expect(page.getByRole('button',{name:'Cancel edits',exact:true})).toHaveCount(0);
  await page.getByLabel('Close memory').click();await expect(page.locator('.memory-panel')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).qa.memory.notes[0].title)).toBe('Save before closing');
});

test("memory supports editing, archive, restore and keyboard-confirmed deletion",async({page})=>{
  await boot(page);await composer(page).fill("Keep my chat draft");
  await page.getByRole("button",{name:"Memory",exact:true}).click();
  await page.getByRole("button",{name:"New note",exact:true}).click();
  await page.getByLabel("Memory title",{exact:true}).fill("Database decision");await page.getByLabel("Memory note",{exact:true}).fill("Use SQLite with WAL mode.");
  await page.getByLabel("Memory scope").selectOption("shared");
  await page.getByRole("button",{name:"Save note",exact:true}).click();
  await expect(page.locator(".memory-list")).toContainText("Database decision");
  await page.getByRole("button",{name:"Archive",exact:true}).click();await expect(page.getByRole("button",{name:"Restore",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Restore",exact:true}).click();
  await page.getByRole("button",{name:"Delete",exact:true}).click();await expect(page.getByRole("button",{name:"Keep editing",exact:true})).toBeFocused();
  await page.keyboard.press("Shift+Tab");await expect(page.getByRole("button",{name:"Delete permanently"})).toBeFocused();
  await page.keyboard.press("Enter");await expect(page.locator(".memory-list button")).toHaveCount(0);
  await page.getByRole("button",{name:"Close memory"}).click();await expect(composer(page)).toHaveValue("Keep my chat draft");
});

test("memory review, settings and conflicts preserve the unsaved note",async({page})=>{
  await boot(page);await page.evaluate(()=>{(window as any).qa.memory={root:"C:\\Vault",settings:{enabled:true,capture:"review",budget_bytes:3000},warning:null,notes:[{id:"pending",revision:"r1",title:"Build system",body:"Use npm for scripts.",tags:[],scope:"project",status:"pending",pinned:false,source:"Codex conversation",created_at:1,updated_at:1}]};});
  await page.getByRole("button",{name:"Memory",exact:true}).click();await page.getByRole("button",{name:/^Review/}).click();await page.locator(".memory-list button").click();
  await expect(page.getByText("This suggestion is not used until you save it.")).toBeVisible();await page.getByRole("button",{name:"Approve & save"}).click();
  await page.getByRole("button",{name:"Memory settings",exact:true}).click();await page.getByLabel("Memory learning").selectOption("manual");await page.getByLabel("Memory context limit").selectOption("1000");
  expect(await page.evaluate(()=>(window as any).qa.memory.settings)).toEqual({enabled:true,capture:"manual",budget_bytes:1000});
  await page.getByRole("button",{name:"Memory settings",exact:true}).click();await page.getByLabel("Memory note",{exact:true}).fill("My unsaved changes");
  await page.evaluate(()=>{(window as any).qa.memoryConflict=true;});await page.getByRole("button",{name:"Save note",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");await expect(page.getByLabel("Memory note",{exact:true})).toHaveValue("My unsaved changes");
  await page.getByRole("button",{name:"Close memory"}).click();await expect(page.getByRole("alertdialog")).toBeVisible();await page.keyboard.press("Escape");
  await expect(page.getByLabel("Memory note",{exact:true})).toHaveValue("My unsaved changes");
  await page.screenshot({path:".qa/memory-desktop.png",animations:"disabled"});
  const results=await new AxeBuilder({page}).include(".memory-panel").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();expect(results.violations).toEqual([]);
});

test("conversation selectors share one row and one refresh updates providers and models", async ({ page }) => {
  await boot(page);
  const controls = [page.getByLabel("AI provider"), page.getByRole("button", { name: "Model: Deep model", exact: true }), page.getByRole("button", { name: "Reasoning: High", exact: true }), page.getByRole("button", { name: "Bot: Provider assistant", exact: true })];
  await expect(controls[1]).toBeEnabled();
  for (const width of [1560, 1200, 980, 760]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await Promise.all(controls.map((control) => control.boundingBox()));
    for (const [index, box] of bounds.entries()) {
      expect(box!.y).toBeCloseTo(bounds[0]!.y, 0);
      expect(box!.height).toBe(bounds[0]!.height);
      if (index > 0) expect(box!.x).toBeGreaterThanOrEqual(bounds[index - 1]!.x + bounds[index - 1]!.width);
      await expect(controls[index]).toBeInViewport();
    }
    expect(await page.locator(".provider-bar").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  const refresh = page.locator(".provider-bar").getByRole("button", { name: /Refresh/ });
  await expect(refresh).toHaveCount(1);
  await expect(refresh).toHaveAccessibleName("Refresh providers and models");
  await composer(page).fill("Keep this draft");
  const callsBefore = await page.evaluate(() => (window as any).qa.calls.length);
  await refresh.click();
  await expect(controls[1]).toBeEnabled();
  const calls = await page.evaluate((from) => (window as any).qa.calls.slice(from), callsBefore);
  expect(calls.filter((c: any) => c.cmd === "provider_status")).toHaveLength(1);
  expect(calls.filter((c: any) => c.cmd === "provider_models")).toEqual([{ cmd: "provider_models", args: { provider: "muse", refresh: true } }]);
  expect(calls.filter((c: any) => c.cmd === "agent_new" || c.cmd === "agent_stop")).toHaveLength(0);
  await expect(composer(page)).toHaveValue("Keep this draft");
  await page.screenshot({ path: ".qa/toolbar-compact.png", animations: "disabled" });
  await page.setViewportSize({ width: 1560, height: 800 });
  await page.screenshot({ path: ".qa/toolbar-desktop.png", animations: "disabled" });
});

test("model and reasoning changes preserve the conversation and persist per provider", async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("velum-options-muse") || "null"))).toEqual({ model: "muse-deep", reasoning: "high" });
  await composer(page).fill("First message"); await composer(page).press("Enter");
  await page.evaluate(() => (window as any).qa.agent({ kind: "turn_end", status: "completed", text: "Existing answer" }));
  await composer(page).fill("Keep my draft");
  const registrations = await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_new").length);
  await page.getByRole("button", { name: "Model: Deep model", exact: true }).click();
  await expect(page.getByRole("option", { name: /CLI default/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Deep model", exact: false }).click();
  await page.getByRole("button", { name: "Reasoning: High", exact: true }).click();
  await expect(page.getByRole("option", { name: /^Default/ })).toHaveCount(0);
  await page.getByRole("option", { name: /^Maximum/ }).click();
  await expect(page.getByRole("button", { name: "Reasoning: Maximum", exact: true })).toBeEnabled();
  await expect(composer(page)).toHaveValue("Keep my draft");
  await expect(page.locator(".msg.assistant")).toContainText("Existing answer");
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_new").length)).toBe(registrations);
  await pickProvider(page,"codex");
  await expect(page.getByRole("button", { name: "Model: Deep model", exact: true })).toBeVisible();
  await page.getByRole("tab").first().click();
  await revealAssistant(page);
  await expect(page.getByRole("button", { name: "Reasoning: Maximum", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Model: Deep model", exact: true }).click();
  await page.getByRole("option", { name: /^Fast model/ }).click();
  await expect(page.getByRole("button", { name: "Reasoning: Low", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Reasoning: Low", exact: true }).click();
  await expect(page.getByRole("option", { name: /^Maximum/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Reasoning: Low", exact: true })).toBeFocused();
  await pickProvider(page,"codex");
  await pickProvider(page,"muse");
  await page.reload();
  await revealAssistant(page);
  await expect(page.getByRole("button", { name: "Model: Fast model", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).qa.calls.findLast((c: any) => c.cmd === "agent_new").args.options)).toEqual({ model: "muse-fast", reasoning: "low" });
});

test("catalog defaults resolve empty preferences without replacing saved choices", async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("velum-options-muse") || "null"))).toEqual({ model: "muse-deep", reasoning: "high" });
  await page.evaluate(() => { (window as any).qa.modelDefaults = { model: "muse-fast", reasoning: "low" }; });
  await page.getByRole("button", { name: "Refresh providers and models" }).click();
  await expect(page.locator(".model-controls")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Model: Deep model", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const qa = (window as any).qa;
    const tab = qa.calls.find((c: any) => c.cmd === "agent_new").args.tabId;
    qa.emit("agent-options", { tab_id: tab, options: { model: "", reasoning: "" } });
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("velum-options-muse") || "null"))).toEqual({ model: "muse-fast", reasoning: "low" });
  await expect(page.getByRole("button", { name: "Reasoning: Low", exact: true })).toBeEnabled();
});

test("Remember opens an editable note and bounds long Unicode messages",async({page})=>{
  await boot(page);await composer(page).fill("Remember my deployment preference");await composer(page).press("Enter");
  await page.evaluate(()=>(window as any).qa.agent({kind:"turn_end",status:"completed",text:"資料🦀".repeat(1500)}));
  await page.getByRole("button",{name:"Remember this answer"}).click();
  const text=await page.getByLabel("Memory note",{exact:true}).inputValue();expect(Buffer.byteLength(text)).toBeLessThanOrEqual(6000);expect(text).not.toContain("�");
  await expect(page.getByText(/This message was shortened/)).toBeVisible();await page.getByLabel("Memory title",{exact:true}).fill("Deployment preference");
  await page.getByRole("button",{name:"Save note",exact:true}).click();await expect(page.getByRole("button",{name:"Archive",exact:true})).toBeVisible();
});

test("model menus are accessible and disable edits during a response", async ({ page }) => {
  await boot(page);
  const model = page.getByRole("button", { name: "Model: Deep model", exact: true });
  await model.focus(); await model.press("ArrowDown");
  await expect(page.getByRole("option", { name: /^Deep model/ })).toBeFocused();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Model: Deep model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reasoning: High", exact: true }).click();
  expect((await new AxeBuilder({ page }).include(".choice-menu").analyze()).violations).toEqual([]);
  await page.screenshot({ path: ".qa/model-reasoning-menu.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await composer(page).fill("Hold this response"); await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "Model: Deep model", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reasoning: High", exact: true })).toBeDisabled();
});

test("failed settings keep the selection and terminal changes wait for Restart", async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("velum-options-muse"))).toContain("muse-deep");
  await page.evaluate(() => { (window as any).qa.failConfigure = true; });
  await page.getByRole("button", { name: "Model: Deep model", exact: true }).click();
  await page.getByRole("option", { name: /^Fast model/ }).click();
  await expect(page.getByRole("alert")).toContainText("Wait for the current response");
  await expect(page.getByRole("button", { name: "Model: Deep model", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).qa.failConfigure = false; });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "pty_spawn").length)).toBe(1);
  await page.getByRole("button", { name: "Model: Deep model", exact: true }).click();
  await page.getByRole("option", { name: /^Basic model/ }).click();
  await expect(page.getByRole("status", { name: "Reasoning: Not adjustable", exact: true })).toBeVisible();
  await expect(page.getByText("Terminal changes apply when you restart the session.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "pty_spawn").length)).toBe(1);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).qa.calls.findLast((c: any) => c.cmd === "pty_spawn").args.options)).toEqual({ model: "muse-basic", reasoning: "" });
});

test("unavailable catalogs retain saved settings and accept a custom model", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).qa.failModels = true; });
  await page.getByRole("button", { name: "Refresh providers and models" }).click();
  await expect(page.getByText("Sign in to load models.")).toBeVisible();
  await page.getByRole("button", { name: "Model: muse-deep", exact: true }).click();
  await page.getByRole("option", { name: /^Enter model ID/ }).click();
  await page.getByLabel("Custom model ID").fill("my/custom-model");
  await page.getByRole("button", { name: "Apply model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Model: my/custom-model", exact: true })).toBeVisible();
});

test("Antigravity sign-in keeps codes out of conversations and preserves drafts", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).qa.antigravityInstalled = true; });
  await page.getByLabel("Refresh providers and models").click();
  await pickProvider(page,"antigravity");
  await composer(page).fill("Keep this draft");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Antigravity" });
  await expect(dialog.getByLabel("Paste your authorization code")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Connect account" })).toBeDisabled();
  await expect(dialog.getByLabel("Paste your authorization code")).toHaveAttribute("type", "password");
  expect((await new AxeBuilder({ page }).include(".auth-dialog").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: ".qa/antigravity-sign-in.png" });
  await dialog.getByLabel("Paste your authorization code").fill("4/fixture-only-code");
  await dialog.getByRole("button", { name: "Connect account" }).click();
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await expect(composer(page)).toHaveValue("Keep this draft");
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_send"))).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => (window as any).qa.calls.some((c: any) => c.cmd === "antigravity_login_cancel"))).toBe(true);
});

test("Antigravity authentication errors open sign-in and retries replace the session", async ({ page }) => {
  await boot(page);
  await pickProvider(page,"antigravity");
  await composer(page).fill("Start task"); await composer(page).press("Enter");
  await page.evaluate(() => (window as any).qa.agent({ kind: "turn_end", status: "failed", reason: "Please sign in to use Antigravity" }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => { (window as any).qa.auth = { phase: "error", url: null, message: "Code expired. Start again." }; });
  await expect(page.getByRole("alert")).toContainText("Code expired");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect.poll(() => page.evaluate(() => new Set((window as any).qa.calls.filter((c: any) => c.cmd === "antigravity_login_start").map((c: any) => c.args.id)).size)).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("startup does not greet the user with a Google sign-in popup even when previous session had an interrupted turn", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).qaAgentRestore = [
      { kind: "turn_start", prompt: "Previous question" },
      { kind: "turn_end", status: "failed", reason: "Antigravity ended without a completion event. Open Terminal to check its sign-in and setup." },
    ];
  });
  await boot(page);
  await pickProvider(page, "antigravity");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("providers keep separate conversations, drafts and terminal sessions", async ({ page }) => {
  await boot(page);
  await composer(page).fill("My Muse draft");
  await pickProvider(page,"codex");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Message Codex", exact: true })).toBeVisible();
  await composer(page).fill("Codex conversation");
  await composer(page).press("Enter");
  await page.evaluate(() => (window as any).qa.agent({ kind: "turn_end", status: "completed", text: "Codex response" }));
  await expect(page.locator(".msg.assistant")).toContainText("Codex response");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).qa.calls.findLast((c: any) => c.cmd === "pty_spawn")?.args.provider)).toBe("codex");
  await page.getByRole("tab").first().click();
  await expect(composer(page)).toHaveValue("My Muse draft");
  await expect(page.getByLabel("AI provider")).toHaveValue("muse");
  await pickProvider(page,"antigravity");
  await expect(page.getByText("CLI not installed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_new").map((c: any) => c.args.provider))).toEqual(expect.arrayContaining(["muse", "codex", "antigravity"]));
});

test("USB pairing works with Tailscale disabled and requires desktop approval", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).qa.remote.tailscale.connected = false; });
  await page.getByRole("button", { name: "Connect phone", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Connect your phone" });
  await panel.getByRole("button", { name: "USB cable", exact: true }).click();
  await expect(panel.getByText("Pixel 7 Pro", { exact: true })).toBeVisible();
  await expect(panel.locator(".remote-device").filter({ hasText: "Allow USB debugging" }).getByRole("button")).toBeDisabled();
  await panel.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(panel.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).qa.remote.enabled)).toBe(false);
  await page.evaluate(() => {
    const qa = (window as any).qa;
    qa.remote.pending = { name: "Cable phone", code: "129483", expires_at: Math.floor(Date.now() / 1000) + 120 };
    qa.emit("remote-status", { ...qa.remote });
  });
  await expect(panel.getByRole("region", { name: "Confirm phone pairing" })).toContainText("129483");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Connect phone", exact: true }).click();
  await expect(panel.getByText("Cable phone", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Disconnect USB", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Disconnect USB", exact: true })).toHaveCount(0);
});

test("desktop pairing offers QR, matching-code approval, view-only access and revocation", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Connect phone", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Connect your phone" });
  await panel.getByRole("button", { name: "Enable remote access" }).click();
  await panel.getByRole("button", { name: "Show pairing code" }).click();
  await expect(panel.getByRole("img")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await page.evaluate(() => {
    const qa = (window as any).qa;
    qa.remote.pending = { name: "My Pixel", code: "482196", expires_at: Math.floor(Date.now() / 1000) + 120 };
    qa.emit("remote-status", { ...qa.remote });
  });
  await expect(panel.getByText("482196")).toBeVisible();
  await panel.getByLabel("Allow sending messages and stopping tasks").uncheck();
  await panel.getByRole("button", { name: "Connect phone", exact: true }).click();
  await expect(panel.getByText(/View only · paired/)).toBeVisible();
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel.getByText("My Pixel", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect phone", exact: true })).toBeFocused();
});

test("desktop reflects phone-originated messages without duplicating CLI echoes", async ({ page }) => {
  await boot(page);
  await composer(page).fill("Desktop draft");
  await page.evaluate(() => {
    const qa = (window as any).qa;
    const id = qa.calls.filter((c: any) => c.cmd === "agent_new").at(-1).args.id;
    qa.emit("agent-event", { id, event: { kind: "turn_start", prompt: "From my phone", remote: true } });
    qa.emit("agent-event", { id, event: { kind: "user_message", text: "From my phone" } });
    qa.emit("agent-event", { id, event: { kind: "assistant_delta", text: "Shared result" } });
    qa.emit("agent-event", { id, event: { kind: "turn_end", status: "completed" } });
  });
  await expect(page.locator(".msg.user")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("From my phone");
  await expect(page.locator(".msg.assistant")).toContainText("Shared result");
  await expect(composer(page)).toHaveValue("Desktop draft");
});

async function send(page: Page, text = "Review this project") {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
}
async function event(page: Page, value: object) { await page.evaluate((e) => (window as any).qa.agent(e), value); }

test("same-mode click and round-trip preserve conversation, draft, workspace and YOLO", async ({ page }) => {
  await boot(page);
  await send(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review this project");
  await event(page, { kind: "assistant_delta", text: "Answer to preserve" });
  await event(page, { kind: "turn_end", status: "completed" });
  await composer(page).fill("unsent draft");
  await page.getByRole("button", { name: "YOLO mode" }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByText("Answer to preserve", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-host:not(.hidden)")).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByText("Answer to preserve", { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("unsent draft");
  await expect(page.getByRole("button", { name: "YOLO mode" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Workspace directory")).toHaveValue("C:\\QA");
});

test("invalid workspace preserves transcript and can be corrected with Apply", async ({ page }) => {
  await boot(page);
  await send(page);
  await event(page, { kind: "assistant_delta", text: "Keep this conversation" });
  await event(page, { kind: "turn_end", status: "completed" });
  await page.getByLabel("Workspace directory").fill("C:\\missing");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".notice.error")).toContainText("workspace is not a directory");
  await expect(page.getByText("Keep this conversation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await page.getByLabel("Workspace directory").fill("C:\\QA2");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByLabel("Workspace directory")).toHaveAttribute("title", "C:\\QA2");
  await expect(composer(page)).toBeEnabled();
});

test("workspace Enter cannot restart an active turn", async ({ page }) => {
  await boot(page);
  await send(page);
  await page.getByLabel("Workspace directory").fill("C:\\QA2");
  await page.getByLabel("Workspace directory").press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.locator(".msg.user")).toContainText("Review this project");
});

test("terminal-only final answer and failures are visible; interrupted tools stop spinning", async ({ page }) => {
  await boot(page);
  await send(page);
  await event(page, { kind: "turn_end", status: "completed", text: "Final without deltas" });
  await expect(page.locator(".msg.assistant")).toContainText("Final without deltas");
  await send(page, "Another turn");
  await event(page, { kind: "tool_start", task_id: "tool-1", name: "powershell" });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator('.activity-toggle')).toContainText('Activity stopped');
  await page.locator('.activity-toggle').click();
  await expect(page.locator(".tool-status")).toHaveText("cancelled");
  await send(page, "Fail this turn");
  await event(page, { kind: "turn_end", status: "failed" });
  await expect(page.locator(".notice.error")).toBeVisible();
  await expect(page.locator(".status-text")).not.toHaveText("Ready");
});

test("failed sends restore the prompt and IME Enter does not send", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).qa.failSend = true; });
  await composer(page).fill("Retry this exact prompt");
  await composer(page).press("Enter");
  await expect(page.locator(".notice.error")).toContainText("Could not launch muse");
  await expect(composer(page)).toHaveValue("Retry this exact prompt");
  await page.evaluate(() => { (window as any).qa.failSend = false; });
  const before = await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_send").length);
  await composer(page).dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c: any) => c.cmd === "agent_send").length)).toBe(before);
});

test("StrictMode and closing during delayed initialization leave no ghost sessions/listeners", async ({ page }) => {
  await boot(page, 100);
  await page.waitForTimeout(450);
  const initial = await page.evaluate(() => ({ count: (window as any).qa.sessions.size, listeners: (window as any).qa.listenerCount() }));
  expect(initial.count).toBe(1);
  await page.getByRole("button", { name: "New session (Ctrl+T)", exact: true }).click();
  await page.getByRole("tab", { selected: true }).getByTitle("Close New conversation", { exact: true }).click();
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => (window as any).qa.sessions.size)).toBe(1);
  expect(await page.evaluate(() => (window as any).qa.listenerCount())).toBe(initial.listeners);
});

test("palette traps focus and restores it on Escape; tabs support arrow keys", async ({ page }) => {
  await boot(page);
  await composer(page).focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press("Control+t");
  await page.getByRole("tab").last().focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
});

test("tools, todos, markdown, multi-tab isolation and terminal search work", async ({ page }) => {
  await boot(page);
  await send(page);
  await event(page, { kind: "tool_start", task_id: "t1", name: "read_file" });
  await event(page, { kind: "tool_result", task_id: "t1", text: "a\nb\nc\nd\ne\nf\ng\nh" });
  await event(page, { kind: "tool_end", task_id: "t1", status: "completed" });
  await event(page, { kind: "todos", items: [{ text: "Check tests", status: "in_progress" }, { text: "Read files", status: "completed" }] });
  await event(page, { kind: "assistant_delta", text: "**Review complete**\n\n```js\nconst x = 1;\n```\n\n[Docs](https://example.com)" });
  await event(page, { kind: "turn_end", status: "completed" });
  await expect(page.locator(".md strong")).toHaveText("Review complete");
  await page.locator('.task-progress > summary').click();
  await expect(page.locator(".todos")).toContainText("Check tests");
  await page.locator('.activity-toggle').click();
  await page.locator(".tool-head").click();
  await expect(page.locator(".tool-output.full")).toContainText("h");
  await page.getByRole("link", { name: "Docs" }).click();
  expect(await page.evaluate(() => (window as any).qa.calls.some((c: any) => c.cmd === "plugin:opener|open_url"))).toBe(true);
  await page.keyboard.press("Control+t");
  await expect(composer(page)).toBeEnabled();
  await expect(page.locator(".chat-wrap:not(.hidden) .msg")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.locator(".chat-wrap:not(.hidden) .md strong")).toHaveText("Review complete");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".status-text")).toContainText("fixture muse");
  await page.keyboard.press("Control+f");
  await page.getByLabel("Find in terminal").fill("search target");
  await page.getByLabel("Find in terminal").press("Enter");
  await expect(page.locator(".xterm-selection div").first()).toBeVisible();
  await page.getByLabel("Find in terminal").press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(page.locator(".terminal-host:not(.hidden) .xterm-helper-textarea")).toBeFocused();
});

test("restart ignores stale events and closing the last tab creates a usable replacement", async ({ page }) => {
  await boot(page);
  await send(page);
  const oldId = await page.evaluate(() => (window as any).qa.calls.find((c: any) => c.cmd === "agent_send").args.id);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(composer(page)).toBeEnabled();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New conversation");
  await page.evaluate((id) => (window as any).qa.emit("agent-event", { id, event: { kind: "assistant_delta", text: "STALE OUTPUT" } }), oldId);
  await expect(page.locator(".msg")).toHaveCount(0);
  await page.getByRole("tab").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(composer(page)).toBeEnabled();
  await send(page, "Fresh tab");
  await event(page, { kind: "turn_end", status: "completed", text: "Fresh answer" });
  await expect(page.locator(".msg.assistant")).toContainText("Fresh answer");
});

test("multiline prompts, prompt history, code copy and palette commands", async ({ page }) => {
  await boot(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await composer(page).fill("First line");
  await composer(page).press("Shift+Enter");
  await composer(page).pressSequentially("Second line");
  await expect(page.locator(".msg.user")).toHaveCount(0);
  await composer(page).press("Enter");
  await event(page, { kind: "assistant_delta", text: "```js\nconst answer = 42;\n```" });
  await event(page, { kind: "turn_end", status: "completed", text: "```js\nconst answer = 42;\n```" });
  await expect(page.locator(".msg.assistant")).toHaveCount(1);
  await page.screenshot({ path: ".qa/ui-conversation.png", animations: "disabled" });
  await composer(page).press("ArrowUp");
  await expect(composer(page)).toHaveValue("First line\nSecond line");
  await composer(page).press("ArrowDown");
  await expect(composer(page)).toHaveValue("");
  await page.locator(".md-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const answer = 42;");
  await composer(page).focus();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Command palette" }).fill("zzzzzzzzzz");
  await expect(page.getByText("No matching commands")).toBeVisible();
  await page.getByRole("combobox", { name: "Command palette" }).fill("new agent");
  await page.getByRole("combobox", { name: "Command palette" }).press("Enter");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.keyboard.press("Control+1");
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
});

test("initial and palette UI meet automated accessibility checks at minimum window size", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await boot(page);
  await page.screenshot({ path: ".qa/ui-empty.png", animations: "disabled" });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 760, height: 480 });
  await page.screenshot({ path: ".qa/ui-compact.png", animations: "disabled" });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Control+k");
  await page.screenshot({ path: ".qa/ui-palette.png", animations: "disabled" });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("long drafts grow within the window and reading position survives streaming and tab switches", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page);
  const initialHeight = await composer(page).evaluate((el) => el.clientHeight);
  await composer(page).fill(Array.from({ length: 20 }, (_, i) => `Draft line ${i + 1}`).join("\n"));
  expect(await composer(page).evaluate((el) => el.clientHeight)).toBeGreaterThan(initialHeight);
  await page.setViewportSize({ width: 760, height: 480 });
  const draftBounds = await composer(page).boundingBox();
  expect(draftBounds!.height).toBeLessThanOrEqual(116);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  await composer(page).fill("");
  expect(await composer(page).evaluate((el) => el.clientHeight)).toBeLessThan(initialHeight + 1);
  await send(page, "Review the project structure");
  await event(page, { kind: "assistant_delta", text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. This is a part of the project review.`).join("\n\n") });
  const feed = page.locator(".chat-wrap:not(.hidden) .chat-scroll");
  await expect.poll(() => feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(48);
  await feed.evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
  await event(page, { kind: "assistant_delta", text: "\n\nMore output while you are reading earlier messages." });
  expect(await feed.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  await page.keyboard.press("Control+t");
  await expect(composer(page)).toBeEnabled();
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
  expect(await feed.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  await page.getByRole("button", { name: "Back to latest" }).click();
  await expect(page.getByRole("button", { name: "Back to latest" })).toHaveCount(0);
  await expect.poll(() => feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(48);
  await event(page, { kind: "turn_end", status: "completed" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator(".chat-wrap:not(.hidden) .msg.user").scrollIntoViewIfNeeded();
  await page.locator(".chat-wrap:not(.hidden) .msg.user").hover();
  await page.locator(".chat-wrap:not(.hidden) .msg.user").getByRole("button", { name: "Copy message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Message copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Review the project structure");
  expect(await page.locator(".msg.user").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(composer(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Back to latest" })).toHaveCount(0);
});

test("desktop notification controls and activation restore the intended conversation", async ({ page }) => {
  await boot(page);
  const firstId = await page.getByRole("tab").getAttribute("data-session-id");
  await send(page, "Original conversation");
  await event(page, { kind: "turn_end", status: "completed", text: "Result to return to" });
  await page.getByRole("button", { name: "Background notifications", exact: true }).click();
  await expect(page.getByRole("button", { name: "Background notifications", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+t");
  await expect(composer(page)).toBeEnabled();
  await page.evaluate((id) => { (window as any).qa.pendingNavigation = id; (window as any).qa.emit("desktop-navigation", null); }, firstId);
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".chat-wrap:not(.hidden) .msg.assistant")).toContainText("Result to return to");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Command palette" }).fill("test Windows notification");
  await page.getByRole("combobox", { name: "Command palette" }).press("Enter");
  await expect(page.getByText("Test notification sent to Windows.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss notification message", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Command palette" }).fill("Quit Velum");
  await page.getByRole("combobox", { name: "Command palette" }).press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).qa.calls.some((c: any) => c.cmd === "desktop_quit"))).toBe(true);
});
