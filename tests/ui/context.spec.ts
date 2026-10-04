import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {boot, pickProvider} from './fixture';

test('a project path entered while a provider starts survives its late registration', async ({page}) => {
  await boot(page);
  await page.evaluate(() => { (window as any).qa.holdAgentNew = true; });
  await pickProvider(page,'codex');
  await page.waitForFunction(() => typeof (window as any).qa.releaseAgentNew === 'function');
  const field = page.locator('.chat-wrap:not(.hidden)').getByLabel('Workspace directory');
  await field.fill('C:\\My selected project');
  const apply = page.getByRole('button', {name:'Apply',exact:true});
  await expect(apply).toBeDisabled();
  await field.press('Enter');
  await page.evaluate(() => { const qa=(window as any).qa; qa.holdAgentNew=false; qa.releaseAgentNew(); });
  await expect(page.locator('.chat-wrap:not(.hidden) .composer textarea')).toBeEnabled();
  await expect(field).toHaveValue('C:\\My selected project');
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(field).toHaveAttribute('title','C:\\My selected project');
  expect(await page.evaluate(() => (window as any).qa.calls.filter((c:any)=>c.cmd==='agent_new').at(-1).args.workspace)).toBe('C:\\My selected project');
});

test('project picker cancellation and failed access preserve the chat and draft', async({page}) => {
  await boot(page);
  const input=page.locator('.composer textarea');
  await input.fill('Keep this draft');
  await page.getByLabel('Choose project folder').click();
  await expect(page.getByLabel('Workspace directory')).toHaveValue('C:\\QA');
  await page.evaluate(()=>{(window as any).qa.pickedFolder='C:\\denied-project';});
  await page.getByLabel('Choose project folder').click();
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('cannot list');
  await expect(input).toHaveValue('Keep this draft');
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_new').length)).toBe(1);
});

test('diagnostics previews exact sanitized text and attaches without sending', async({page})=>{
  await boot(page);const input=page.locator('.composer textarea');
  await input.fill('My private draft token=do-not-include');
  await page.getByLabel('Project context and diagnostics').click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('not checked');
  expect(await page.getByLabel('Velum diagnostics preview').inputValue()).not.toContain('do-not-include');
  await page.evaluate(()=>{(window as any).qa.readOnlyFolder=true;});
  await page.getByRole('button',{name:'Test host access'}).click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('"status": "fail"');
  const report=await page.getByLabel('Velum diagnostics preview').inputValue();
  await page.getByRole('button',{name:'Add to message'}).click();
  await expect(input).toHaveValue('My private draft token=do-not-include\n\n[Velum diagnostics — reference data captured by Velum]\n```json\n'+report+'\n```');
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_send').length)).toBe(0);
});

test('layout preview excludes conversation and input text and supports keyboard focus', async({page})=>{
  await boot(page);await page.locator('.composer textarea').fill('unsent-secret');
  await page.getByLabel('Project context and diagnostics').click();
  await page.getByRole('button',{name:'Chat layout',exact:true}).click();
  const view=JSON.parse(await page.getByLabel('Chat layout snapshot preview').inputValue());
  expect(view.layout.map((r:any)=>r.region)).toContain('composer');
  expect(JSON.stringify(view)).not.toContain('unsent-secret');
  expect(JSON.stringify(view)).not.toContain('C:\\QA');
  expect((await new AxeBuilder({page}).include('.context-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath('context-desktop.png')});
  await page.getByRole('button',{name:'Add to message'}).focus();await page.keyboard.press('Tab');
  await expect(page.getByLabel('Close diagnostics')).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toHaveValue('unsent-secret');
});

test('blocked provider output remains visible and allows retry',async({page})=>{
  await boot(page);await page.locator('.composer textarea').fill('Inspect project');await page.getByLabel('Send',{exact:true}).click();
  await page.evaluate(()=>{const qa=(window as any).qa;qa.agent({kind:'assistant_delta',text:'Partial result'});qa.agent({kind:'turn_end',status:'blocked',reason:'Antigravity blocked a tool. Review /permissions.'});});
  await expect(page.locator('.msg.assistant')).toContainText('Partial result');
  await expect(page.locator('.notice.error')).toContainText('/permissions');
  await expect(page.getByLabel('Stop',{exact:true})).toHaveCount(0);
  await page.locator('.composer textarea').fill('Retry');await expect(page.getByLabel('Send',{exact:true})).toBeEnabled();
});


test('host success and blocked agent writes stay separate; permission changes invalidate results',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{(window as any).qa.blockAgentWrites=true;});
  await page.getByLabel('Project context and diagnostics').click();
  await page.getByRole('button',{name:'Test agent access'}).click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('"status": "blocked"');
  let report=JSON.parse(await page.getByLabel('Velum diagnostics preview').inputValue());
  expect(report.workspace_access.host.checks[2].status).toBe('pass');
  expect(report.workspace_access.agent.checks[2].status).toBe('blocked');
  expect(report.attachments.detail).toContain('does not discover');
  await page.getByLabel('Close diagnostics').click();
  await page.getByLabel('YOLO mode').click();
  await expect(page.getByLabel('YOLO mode')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.notice').filter({hasText:'invalidated'})).toBeVisible();
  const calls=await page.evaluate(()=>(window as any).qa.calls);
  expect(calls.filter((c:any)=>c.cmd==='agent_set_permissions').at(-1).args.yolo).toBe(true);
  await page.getByLabel('Project context and diagnostics').click();
  report=JSON.parse(await page.getByLabel('Velum diagnostics preview').inputValue());
  expect(report.workspace_access.agent.checks.every((c:any)=>c.status==='untested')).toBe(true);
  expect(report.workspace_access.permissions.requested_mode).toBe('yolo');
});

test('permission control is disabled during an active turn',async({page})=>{
  await boot(page);await page.locator('.composer textarea').fill('Work');await page.getByLabel('Send',{exact:true}).click();
  await expect(page.getByLabel('YOLO mode')).toBeDisabled();
});

test('ordinary tool results leave diagnostic checks untested and report refresh does not run probes',async({page})=>{
  await boot(page);
  await page.locator('.composer textarea').fill('List this project');
  await page.getByLabel('Send',{exact:true}).click();
  await page.evaluate(()=>{const qa=(window as any).qa;qa.agent({kind:'tool_output',id:'ordinary',text:'listing succeeded'});qa.agent({kind:'turn_end',status:'completed'});});
  await page.getByLabel('Project context and diagnostics').click();
  await expect(page.locator('.context-intro')).toContainText('Ordinary chat commands do not update');
  await page.getByRole('button',{name:'Refresh report',exact:true}).click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('"status": "untested"');
  const report=JSON.parse(await page.getByLabel('Velum diagnostics preview').inputValue());
  expect(report.workspace_access.agent.checks.every((c:any)=>c.status==='untested')).toBe(true);
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_check_access').length)).toBe(0);
});

test('profile-root guidance clears after selecting a project and preserves the draft',async({page})=>{
  await boot(page);
  await page.locator('.composer textarea').fill('Keep my draft');
  await page.getByLabel('Workspace directory').fill('C:\\profile-home');
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.locator('.notice').filter({hasText:'Choose a project folder and Apply'})).toBeVisible();
  await page.getByLabel('Project context and diagnostics').click();
  await expect(page.locator('.context-panel')).toContainText('Choose a project folder and Apply');
  await page.getByLabel('Close diagnostics').click();
  await page.getByLabel('Workspace directory').fill('C:\\selected-project');
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.locator('.notice').filter({hasText:'Choose a project folder and Apply'})).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my draft');
});

test('workspace replacement applies the tab permission mode before diagnostics',async({page})=>{
  await boot(page);await page.getByLabel('YOLO mode').click();
  await page.getByLabel('Workspace directory').fill('C:\\next-project');
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.getByLabel('YOLO mode')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('YOLO mode')).toBeEnabled();
  const calls=await page.evaluate(()=>(window as any).qa.calls);
  const latest=calls.filter((c:any)=>c.cmd==='agent_new').at(-1);
  expect(calls.filter((c:any)=>c.cmd==='agent_set_permissions'&&c.args.id===latest.args.id).at(-1).args.yolo).toBe(true);
  await page.getByLabel('Project context and diagnostics').click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('"requested_mode": "yolo"');
  const report=JSON.parse(await page.getByLabel('Velum diagnostics preview').inputValue());
  expect(report.workspace_access.permissions.requested_mode).toBe('yolo');
});
