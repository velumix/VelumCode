import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { boot, pickProvider } from './fixture';

const composer = (page: Page) => page.locator('.chat-wrap:not(.hidden) .composer textarea');
const recovery = (page: Page) => page.getByRole('region', { name: 'Recover request' });
const sends = (page: Page) => page.evaluate(() => (window as any).qa.calls.filter((call: any) => call.cmd === 'agent_send'));
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}
async function finish(page: Page, status: string) {
  await page.evaluate(status => (window as any).qa.agent({ kind: 'turn_end', status, reason: status === 'completed' ? undefined : 'The response ended before the task finished.' }), status);
}

for (const provider of ['muse', 'codex', 'antigravity']) {
  test(`${provider}: failed, blocked, and stopped requests retry in the same conversation and preserve drafts`, async ({ page }) => {
    await boot(page);
    if (provider === 'antigravity') {
      await page.evaluate(() => { (window as any).qa.antigravityInstalled = true; });
      await page.getByRole('button', { name: 'Refresh providers and models', exact: true }).click();
    }
    if (provider !== 'muse') await pickProvider(page, provider);
    for (const status of ['failed', 'blocked', 'cancelled']) {
      const prompt = `Finish the ${status} task`;
      await send(page, prompt);
      const original = (await sends(page)).at(-1);
      await page.evaluate(() => (window as any).qa.agent({ kind: 'assistant_delta', text: 'I updated one file before the interruption.' }));
      await composer(page).fill('Keep my next idea');
      await finish(page, status);
      await expect(recovery(page)).toContainText('partial changes');
      await page.getByRole('button', { name: 'Retry request', exact: true }).click();
      await expect(composer(page)).toHaveValue('Keep my next idea');
      await expect.poll(async () => (await sends(page)).at(-1)?.args).toEqual(original.args);
      await expect(recovery(page)).toHaveCount(0);
      await finish(page, 'completed');
      await expect(recovery(page)).toHaveCount(0);
    }
  });
}

test('an unsent request can be revised independently and retains the revision after another send failure', async ({ page }) => {
  await boot(page, 0, false);
  await page.evaluate(() => { (window as any).qa.holdSend = true; });
  await send(page, 'Original unsent request');
  await expect.poll(() => page.evaluate(() => typeof (window as any).qa.releaseSend)).toBe('function');
  await composer(page).fill('A separate follow-up draft');
  await page.evaluate(() => { const qa = (window as any).qa; qa.failSend = true; qa.holdSend = false; qa.releaseSend(); });
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Request to retry' });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Original unsent request');
  await editor.fill('Revised request with the missing details');
  await expect(composer(page)).toHaveValue('A separate follow-up draft');
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(page.locator('.msg.user').last()).toContainText('Revised request with the missing details');
  await expect(page.locator('.msg.user').last()).toContainText('Not sent');
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  await expect(editor).toHaveValue('Revised request with the missing details');
  await expect(composer(page)).toHaveValue('A separate follow-up draft');
  expect((await new AxeBuilder({ page }).include('.request-recovery').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 760, height: 600 });
  expect(await page.locator('.chat-scroll').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: '.qa/request-recovery-desktop.png', animations: 'disabled' });
  await page.evaluate(() => { (window as any).qa.failSend = false; });
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect.poll(async () => (await sends(page)).at(-1)?.args.prompt).toBe('Revised request with the missing details');
  await expect(recovery(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue('A separate follow-up draft');
});

test('retry joins a paused queue once and keeps its order and pause state', async ({ page }) => {
  await boot(page);
  await send(page, 'Original task');
  await send(page, 'Existing queued follow-up');
  await finish(page, 'failed');
  await composer(page).fill('Unsent next idea');
  await expect(recovery(page)).toContainText('Resume the queue when ready');
  await page.evaluate(() => { (window as any).qa.holdSend = true; });
  const before = (await sends(page)).length;
  await page.getByRole('button', { name: 'Queue retry', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(async () => (await sends(page)).length).toBe(before + 1);
  await page.evaluate(() => { const qa = (window as any).qa; qa.holdSend = false; qa.releaseSend(); });
  await expect(page.getByRole('region', { name: 'Message queue' })).toContainText('2 queued');
  const state = await page.evaluate(() => Array.from((window as any).qa.agentQueues.values()).at(-1) as any);
  expect(state.running).toBe(false);
  expect(state.queue.paused).toBe(true);
  expect(state.queue.items.map((item: any) => item.prompt)).toEqual(['Existing queued follow-up', 'Original task']);
  await expect(page.getByRole('button', { name: 'Queue retry', exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue('Unsent next idea');
});

test('later informational notices keep the correct recovery and newer turns retire it', async ({ page }) => {
  await boot(page);
  await send(page, 'Interrupted request');
  await finish(page, 'failed');
  await page.evaluate(() => (window as any).qa.agent({ kind: 'notice', text: 'Saved the interrupted conversation.' }));
  await expect(recovery(page)).toHaveCount(1);
  await send(page, 'A newer request');
  await finish(page, 'completed');
  await expect(recovery(page)).toHaveCount(0);
  await expect(page.locator('.notice.error')).toContainText('The response ended');
});

test('a failed active turn retries its own request after a rejected follow-up', async ({ page }) => {
  await boot(page);
  await send(page, 'The active coding task');
  await page.evaluate(() => { (window as any).qa.failSend = true; });
  await send(page, 'A follow-up that could not be queued');
  await expect(page.locator('.msg.user').last()).toContainText('Not sent');
  await page.evaluate(() => { (window as any).qa.failSend = false; });
  await finish(page, 'failed');
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Request to retry' })).toHaveValue('The active coding task');
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect.poll(async () => (await sends(page)).at(-1)?.args.prompt).toBe('The active coding task');
  await expect(composer(page)).toHaveValue('A follow-up that could not be queued');
});

test('cancelling a recovery edit restores keyboard focus without sending or changing the composer', async ({ page }) => {
  await boot(page);
  await send(page, 'Original interrupted task');
  await finish(page, 'cancelled');
  await composer(page).fill('Separate composer draft');
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Request to retry' });
  await editor.fill('Discard this revision');
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revise request', exact: true })).toBeFocused();
  await expect(composer(page)).toHaveValue('Separate composer draft');
  expect(await sends(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  await expect(editor).toHaveValue('Original interrupted task');
});

for (const status of ['failed', 'completed']) {
  test(`reopening a ${status} conversation preserves its outcome and recovery availability`, async ({ page }) => {
    await page.addInitScript(status => {
      (window as any).qaAgentRestore = [
        { kind: 'turn_start', prompt: 'The request before closing' },
        { kind: 'turn_end', status, reason: status === 'failed' ? 'Saved failure' : undefined },
      ];
    }, status);
    await boot(page);
    await expect(page.locator('.status-text')).toContainText(status === 'failed' ? 'Saved failure' : 'Done');
    await expect(recovery(page)).toHaveCount(status === 'failed' ? 1 : 0);
    if (status === 'failed') {
      await page.getByRole('button', { name: 'Revise request', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Request to retry' })).toHaveValue('The request before closing');
    }
  });
}

test('a truncated failure without its original request offers no misleading retry', async ({ page }) => {
  await page.addInitScript(() => { (window as any).qaAgentRestore = [{ kind: 'turn_end', status: 'failed', reason: 'Older request was trimmed' }]; });
  await boot(page);
  await expect(page.locator('.notice.error')).toContainText('Older request was trimmed');
  await expect(recovery(page)).toHaveCount(0);
});
