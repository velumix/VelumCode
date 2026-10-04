import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {emptyInteractions,type InteractionDecision} from '../../src/interactions';
import {commandApproval,featureQuestion} from './interaction-fixtures';

for (const theme of ['graphite', 'daylight']) {
  test(`${theme}: phone approval stays compact, reveals broader scopes and sends the exact response`, async ({page}) => {
    const remote=await boot(page,true,true,'muse',false);
    await expect(page.locator('.phone-online')).toBeVisible();
    await page.getByRole('button',{name:'Phone settings',exact:true}).click();
    await page.getByRole('button',{name:'Appearance & preferences',exact:true}).click();
    await page.getByRole('button',{name:theme==='graphite'?'Graphite theme':'Daylight theme',exact:true}).click();
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.getByRole('button',{name:'Phone settings',exact:true}).click();
    remote.interactions=commandApproval();remote.sessions[0].running=true;remote.sessions[0].status='awaiting_review';remote.sessions[0].revision++;
    await page.evaluate(()=>(window as any).remoteEvent());
    const card=page.getByRole('region',{name:'Permission required: powershell',exact:true});
    await expect(card).toBeVisible();
    await expect(page.locator('.phone-working')).toHaveCount(0);
    await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeEnabled();
    expect((await card.boundingBox())!.height).toBeLessThan(260);
    for (const [width,height] of [[320,568],[844,390],[390,844]]) {
      await page.setViewportSize({width,height});
      expect(await page.locator('.phone-transcript').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
      await card.getByRole('button',{name:'Allow once',exact:true}).scrollIntoViewIfNeeded();
      await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeInViewport();
    }
    await page.screenshot({path:`.qa/approval-${theme}-phone.png`,animations:'disabled'});
    await card.getByRole('button',{name:'Details',exact:true}).click();
    await expect(card.locator('.interaction-payload')).toHaveText(remote.interactions.requests[0].details);
    await card.getByRole('button',{name:'More options',exact:true}).click();
    await expect(card.locator('.interaction-more')).toContainText('Saved for this workspace');
    expect((await new AxeBuilder({page}).include('.interaction-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await card.getByRole('button',{name:'More options',exact:true}).click();
    await card.getByRole('button',{name:'Allow once',exact:true}).click();
    expect(remote.responses).toEqual([{generation:'review-turn',id:'review-command',revision:2,choice_id:'once'}]);
    await expect(card).toContainText('Waiting for confirmation');
  });
}

test('phone questions remain usable and view-only approvals cannot submit', async ({page}) => {
  const remote=await boot(page,true,false,'muse',false);
  await expect(page.locator('.phone-online')).toBeVisible();
  remote.interactions=commandApproval();remote.sessions[0].revision++;
  await page.evaluate(()=>(window as any).remoteEvent());
  await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeDisabled();
  await expect(page.locator('.interaction-panel')).toContainText('Control access is required');
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await expect(page.locator('.interaction-payload')).toBeVisible();
  expect(remote.responses).toEqual([]);
  remote.interactions=featureQuestion();remote.sessions[0].revision++;
  await page.evaluate(()=>(window as any).remoteEvent());
  await expect(page.getByRole('button',{name:'Send answers',exact:true})).toBeDisabled();
  await expect(page.getByRole('checkbox').first()).toBeDisabled();
  const card=page.getByRole('region',{name:'Which details should stay visible?',exact:true});
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:'.qa/approval-question-phone.png',animations:'disabled'});
  expect((await new AxeBuilder({page}).include('.interaction-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
});

test('phone questions indicate a written answer and submit only the active answer mode', async ({page}) => {
  const remote=await boot(page,true,true,'muse',false);
  await expect(page.locator('.phone-online')).toBeVisible();
  remote.interactions=featureQuestion();remote.sessions[0].running=true;remote.sessions[0].revision++;
  await page.evaluate(()=>(window as any).remoteEvent());
  const card=page.getByRole('region',{name:'Which details should stay visible?',exact:true});
  const send=card.getByRole('button',{name:'Send answers',exact:true});
  await expect(send).toBeDisabled();
  await card.getByRole('checkbox').first().check();await expect(send).toBeEnabled();
  await card.locator('.interaction-write-answer > summary').click();
  await card.getByLabel('Or write your answer').fill('Show the file and command.');
  await expect(card.getByRole('checkbox').first()).not.toBeChecked();
  await card.locator('.interaction-write-answer > summary').click();
  await expect(card.locator('.interaction-write-answer > summary')).toHaveText('Edit your answer');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path:'.qa/approval-question-phone.png',animations:'disabled'});
  await send.click();
  expect(remote.responses).toEqual([{generation:'review-turn',id:'question-layout',revision:2,answers:[{question_id:'details',text:'Show the file and command.'}]}]);
});

test('phone permission history is a compact expandable record', async ({page}) => {
  const remote=await boot(page,true,true,'muse',false);
  await expect(page.locator('.phone-online')).toBeVisible();
  remote.entries.push({seq:4,event:{kind:'approval',tool:'powershell',status:'approved',summary:'This action was allowed from the desktop.'}});remote.sessions[0].revision++;
  await page.evaluate(()=>(window as any).remoteEvent());
  const record=page.locator('.phone-transcript > .interaction-record');
  await expect(record.locator('summary')).toContainText('Allowed');
  await expect(record.locator('pre')).toBeHidden();
  expect((await record.boundingBox())!.height).toBeLessThan(50);
  await record.locator('summary').click();
  await expect(record.locator('pre')).toHaveText('This action was allowed from the desktop.');
});

test('phone recovery edits stopped work separately and retains both drafts after a rejected retry', async ({ page }) => {
  const remote = await boot(page, true, true, 'codex', false);
  const composer = page.getByRole('textbox', { name: 'Message your desktop agent' });
  await composer.fill('Finish the interrupted task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await composer.fill('My separate phone draft');
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Request to retry' });
  await expect(editor).toHaveValue('Finish the interrupted task');
  await editor.fill('Finish the task using the existing layout');
  remote.failSend = true;
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(page.locator('.request-recovery-error')).toContainText('Desktop could not start');
  await expect(editor).toHaveValue('Finish the task using the existing layout');
  await expect(composer).toHaveValue('My separate phone draft');
  for (const [width, height] of [[390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height });
    expect(await page.locator('.phone-transcript').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect((await new AxeBuilder({ page }).include('.request-recovery').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.qa/request-recovery-phone.png', animations: 'disabled' });
  remote.failSend = false;
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recover request' })).toHaveCount(0);
  expect(remote.sends).toEqual(['Finish the interrupted task', 'Finish the task using the existing layout']);
  await expect(composer).toHaveValue('My separate phone draft');
});

test('phone recovery queues a retry without resuming or replacing pending work', async ({ page }) => {
  const remote = await boot(page, true, true, 'muse', false);
  const composer = page.getByRole('textbox', { name: 'Message your desktop agent' });
  await composer.fill('Original task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await composer.fill('Existing follow-up');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await composer.fill('Keep this draft');
  await page.getByRole('button', { name: 'Queue retry', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Message queue' })).toContainText('2 queued');
  expect(remote.sessions[0].running).toBe(false);
  expect(remote.sessions[0].queue.paused).toBe(true);
  expect(remote.sessions[0].queue.items.map(item => item.prompt)).toEqual(['Existing follow-up', 'Original task']);
  await expect(page.getByRole('button', { name: 'Queue retry', exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this draft');
});

test('phone recovery follows the failed turn and is unavailable to view-only devices', async ({ page }) => {
  const remote = await boot(page, true, false, 'antigravity', false);
  remote.entries.push({ seq: 4, event: { kind: 'turn_start', prompt: 'Blocked desktop work' } }, { seq: 5, event: { kind: 'turn_end', status: 'blocked', reason: 'Command permission required' } });
  remote.sessions[0].status = 'blocked'; remote.sessions[0].revision = 5;
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator('.phone-notice')).toContainText('Command permission required');
  await expect(page.getByRole('region', { name: 'Recover request' })).toHaveCount(0);
  expect(remote.sends).toEqual([]);
});

test('phone recovery keeps an oversized desktop request intact and requires shortening it before retry', async ({ page }) => {
  const remote = await boot(page, true, true, 'muse', false);
  const original = 'Detailed project requirement. '.repeat(600);
  remote.entries.push({ seq: 4, event: { kind: 'turn_start', prompt: original } }, { seq: 5, event: { kind: 'turn_end', status: 'failed', reason: 'Desktop response failed.' } });
  remote.sessions[0].status = 'failed'; remote.sessions[0].revision = 5;
  await page.evaluate(() => (window as any).remoteEvent());
  const recovery = page.getByRole('region', { name: 'Recover request' });
  await expect(recovery).toContainText('Revise it to 16,000 characters or fewer');
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Revise request', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Request to retry' });
  await expect(editor).toHaveValue(original);
  await expect(editor).toHaveAttribute('maxlength', '16000');
  expect(remote.sends).toEqual([]);
  await editor.fill('Continue with the existing project requirements.');
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  expect(remote.sends).toEqual(['Continue with the existing project requirements.']);
});

test('phone corrections keep drafts and save reviewed project guidance',async({page})=>{
  const remote=await boot(page,true,true,'codex',false);
  await expect(page.locator('.phone-assistant-controls')).not.toHaveAttribute('open','');
  const draft=page.getByRole('textbox',{name:'Message your desktop agent'});await draft.fill('Keep my next thought');
  await page.getByRole('button',{name:'Correct response',exact:true}).click();
  await page.getByLabel('What should change?',{exact:true}).fill('Explain what was changed before listing implementation details.');
  await page.getByRole('checkbox',{name:'Remember a lesson for this project',exact:true}).check();
  await page.getByLabel('Lesson for next time',{exact:true}).fill('Start summaries with the outcome and the next action.');
  for(const [width,height] of [[390,844],[844,390],[320,568]]){
    await page.setViewportSize({width,height});
    expect(await page.locator('.phone-transcript').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeInViewport();
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'.qa/focus-ux-phone.png',animations:'disabled'});
  expect((await new AxeBuilder({page}).include('.correction-composer').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button',{name:'Send & save lesson',exact:true}).click();
  await expect(page.getByRole('region',{name:'Correct this response'})).toContainText('Lesson saved');
  await expect(draft).toHaveValue('Keep my next thought');expect(remote.sends).toHaveLength(1);
  expect(remote.sends[0]).toContain('What to change');expect(remote.memory.notes[0].body).toBe('Start summaries with the outcome and the next action.');
  expect(remote.memory.notes[0].scope).toBe('project');expect(remote.memory.notes[0].pinned).toBe(true);
});
test('a phone retries only the lesson save and view-only devices have no correction actions',async({page})=>{
  const remote=await boot(page,true,true,'muse',false);remote.failMemorySave=true;
  await page.getByRole('button',{name:'Correct response',exact:true}).click();
  await page.getByLabel('What should change?',{exact:true}).fill('Use the existing design tokens.');
  await page.getByRole('checkbox',{name:'Remember a lesson for this project',exact:true}).check();
  await page.getByRole('button',{name:'Send & save lesson',exact:true}).click();
  await expect(page.locator('.correction-error')).toContainText('Correction sent');remote.failMemorySave=false;
  await page.getByRole('button',{name:'Retry saving lesson',exact:true}).click();
  await expect(page.getByRole('region',{name:'Correct this response'})).toContainText('Lesson saved');expect(remote.sends).toHaveLength(1);
  await boot(page,true,false,'muse',false);await expect(page.getByRole('button',{name:'Correct response',exact:true})).toHaveCount(0);
});

test('phone appearance is local, responsive, and preserves the draft', async ({ page }) => {
  const remote = await boot(page);
  const input = page.getByRole('textbox', {name:'Message your desktop agent'});
  await input.fill('Keep my phone draft');
  await page.getByRole('button', {name:'Phone settings', exact:true}).click();
  await page.getByRole('button', {name:'Appearance & preferences', exact:true}).click();
  await expect(page.getByLabel('Search settings')).toBeFocused();
  await page.getByRole('button', {name:'Mint theme', exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','mint');
  await expect(page.getByRole('tab',{name:'Terminal',exact:true})).toHaveCount(0);
  for (const [width,height] of [[390,844],[844,390],[320,568]]) {
    await page.setViewportSize({width,height});
    for (const title of ['Appearance','Glass & finish','Layout & text','Preferences']) {
      await page.getByRole('tab',{name:title,exact:true}).click();
      expect(await page.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
      await expect(page.getByRole('button',{name:'Done',exact:true})).toBeInViewport();
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('tab',{name:'Layout & text',exact:true}).click();
  await page.getByLabel('Interface text scale',{exact:true}).press('End');
  await page.getByLabel('Message font',{exact:true}).selectOption('serif');
  expect((await new AxeBuilder({page}).include('.settings-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:'.qa/settings-phone.png',animations:'disabled'});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(input).toHaveValue('Keep my phone draft'); expect(remote.sends).toEqual([]);
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme','mint');
  await expect(input).toHaveValue('Keep my phone draft');
  expect(await input.evaluate(el=>getComputedStyle(el).fontFamily)).toContain('Georgia');
});

test('phone replays the original Muse retry deadline and clears it after recovery', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-29T20:00:00Z') });
  const remote = await boot(page);
  remote.sessions[0].running = true; remote.sessions[0].revision++;
  const now = await page.evaluate(() => Date.now());
  remote.entries.push({ seq: 4, event: { kind: 'turn_start', prompt: 'Retry fixture' } },
    { seq: 5, event: { kind: 'provider_progress', progress: { phase: 'retrying', checked_at_ms: now - 30_000, retry_at_ms: now + 30_000, attempt: 2, max_attempts: 10, http_status: 503 } } });
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator('.provider-wait')).toContainText('HTTP 503');
  await expect(page.locator('.provider-wait')).toContainText('Retrying in 30s');
  await page.clock.fastForward(10_000);
  await expect(page.locator('.provider-wait')).toContainText('Retrying in 20s');
  expect(await page.locator('.phone-working').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: '.qa/provider-retry-phone.png' });
  remote.entries.push({ seq: 6, event: { kind: 'turn_end', status: 'completed', text: 'Recovered' } });
  remote.sessions[0].running = false; remote.sessions[0].revision++;
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator('.provider-wait')).toHaveCount(0);
  await expect(page.locator('.phone-message.assistant').last()).toContainText('Recovered');
});

async function boot(page: Page, paired = true, control = true, provider = "muse", configure = true) {
  const remote = {
    interactions: emptyInteractions(), responses: [] as InteractionDecision[],
    paired, control, pending: false, failSend: false, failMemorySave: false, revoked: false, sends: [] as string[],
    memory: {root:"C:\\Vault",settings:{enabled:true,capture:"review",budget_bytes:3000},notes:[] as any[],warning:null},
    board: {revision:0,cards:[] as any[],trash:[] as any[]},
    bots:{profiles:[] as any[],root:'C:\\Bots',warnings:[]},jobs:{enabled:true,jobs:[] as any[],runs:[] as any[],warning:null},
    sessions: [{ queue:{items:[] as any[],paused:false,reason:null as string|null}, provider, options: { model: "", reasoning: "" }, id: "session-one", title: "Review the project", workspace: "C:\\Projects\\VelumCode", running: false, status: "completed", revision: 3 }],
    entries: [
      { seq: 1, event: { kind: "turn_start", prompt: "Review the project", remote: false } },
      { seq: 2, event: { kind: "assistant_delta", text: "**Review complete.**\n\n```ts\nconst connected = true;\n```\n\n[Documentation](https://example.com)" } },
      { seq: 3, event: { kind: "turn_end", status: "completed" } },
    ] as { seq: number; event: Record<string, unknown> }[],
  };
  const publishQueue=()=>{remote.entries.push({seq:remote.entries.length+1,event:{kind:'queue_state',queue:structuredClone(remote.sessions[0].queue),running:remote.sessions[0].running}});remote.sessions[0].revision=remote.entries.length;};
  const nextQueued=()=>{const session=remote.sessions[0];if(session.running||session.queue.paused||!session.queue.items.length)return;const message=session.queue.items.shift();session.running=true;session.status='running';publishQueue();remote.entries.push({seq:remote.entries.length+1,event:{kind:'turn_start',prompt:message.prompt,queued:true,remote:true}});session.revision=remote.entries.length;};
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const streams: EventTarget[] = [];
    class FixtureSource extends EventTarget {
      onerror = null;
      constructor() { super(); streams.push(this); }
      close() { const index = streams.indexOf(this); if (index >= 0) streams.splice(index, 1); }
    }
    (window as any).EventSource = FixtureSource;
    (window as any).remoteEvent = (name = "change") => streams.forEach((stream) => stream.dispatchEvent(new Event(name)));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    const answer = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/pair/claim") { remote.pending = true; return answer({ pending: { name: body.name, code: "482196", expires_at: Math.floor(Date.now() / 1000) + 120 } }); }
    if (url.pathname === "/api/pair/finish") return answer(remote.paired ? { status: "paired", device: { id: "phone", name: "My phone", control } } : { status: "pending", pending: { name: "My phone", code: "482196", expires_at: Math.floor(Date.now() / 1000) + 120 } });
    if (!remote.paired || remote.revoked) return answer({ error: "Pair again" }, 401);
    if(url.pathname.endsWith('/diagnostics'))return answer({app:'Velum Code',version:'0.6.1',host_os:'windows',checked_at:1800000000,workspace:{directory_listing:true,git_repository:true,message:'Folder listing passed.'},providers:[{provider:'muse',installed:true,authentication:'not checked',tool_connections:'not checked'}],memory:{readable:true,enabled:true,notes:2,budget_bytes:3000,capture:'review'},sessions:{active:0,failed:0,blocked:0}});
    if (url.pathname === "/api/me") return answer({ device: { id: "phone", name: "My phone", control }, computer: "desktop.tail.ts.net" });
    if(url.pathname==='/api/bots'){
      if(body.action!=='list'&&!control)return answer({error:'View only'},403);
      if(body.action==='save')remote.bots.profiles=[...remote.bots.profiles.filter(b=>b.id!==body.profile.id),{...body.profile,revision:'saved'}];
      return answer(remote.bots);
    }
    if(url.pathname.endsWith('/automation'))return answer(body.action==='preview'?{times:[1800000000,1800000900]}:remote.jobs);
    if(url.pathname.endsWith('/chat')){if(!control)return answer({error:'View only'},403);const id=url.pathname.split('/').at(-2);const bot=remote.bots.profiles.find(b=>b.id===id);const session={...remote.sessions[0],id:'bot-conversation',bot,provider:bot.provider};remote.sessions.push(session);return answer({id:session.id});}
    if (url.pathname === "/api/sessions") return answer({ sessions: remote.sessions });
    if(url.pathname.endsWith("/memory")) {
      expect(request.headers()["x-muse-request"]).toBe("1");
      if(body.action!=="list"&&!control)return answer({error:"View only"},403);
      if(body.action==="save")remote.memory.notes=[{...body,id:"phone-note",revision:"r1",source:"Saved by you",created_at:1,updated_at:1}];
      if(body.action==='save_lesson'){
        if(remote.failMemorySave)return answer({error:'Fixture could not save the lesson'},500);
        if(!remote.memory.notes.some(note=>note.scope==='project'&&note.body===body.body&&note.pinned))remote.memory.notes.push({...body,id:'lesson-note',revision:'r1',tags:['lesson','correction'],scope:'project',status:'active',pinned:true,source:'Reviewed correction',created_at:1,updated_at:1});
      }
      return answer(remote.memory);
    }
    if(url.pathname.endsWith("/kanban")) {
      expect(request.headers()["x-muse-request"]).toBe("1");
      if(body.action!=="load"&&!control)return answer({error:"View only"},403);
      if(body.action==="save") {remote.board.cards=[...remote.board.cards.filter(c=>c.id!==body.card.id),body.card];remote.board.revision++;}
      if(body.action==="move") {remote.board.cards.find(c=>c.id===body.id).column=body.column;remote.board.revision++;}
      if(body.action==="delete") {remote.board.trash.unshift({card:remote.board.cards.find(c=>c.id===body.id),deleted_at:Date.now()/1000});remote.board.cards=remote.board.cards.filter(c=>c.id!==body.id);remote.board.revision++;}
      if(body.action==="restore") {const card=remote.board.trash.find(e=>e.card.id===body.id).card;if(card.assignment)card.assignment.automatic=false;remote.board.cards.push(card);remote.board.trash=remote.board.trash.filter(e=>e.card.id!==body.id);remote.board.revision++;}
      if(body.action==="purge") {remote.board.trash=remote.board.trash.filter(e=>e.card.id!==body.id);remote.board.revision++;}
      return answer(remote.board);
    }
    if (url.pathname.endsWith("/models")) return answer({ models: [{ id: "phone-model", label: "Phone model", efforts: ["low", "high"], default_effort: "low", description: "Available on your desktop" }], notice: null });
    if (url.pathname.endsWith("/options")) {
      expect(request.headers()["x-muse-request"]).toBe("1");
      if (!remote.control || remote.sessions[0].running) return answer({ error: "Cannot change options now." }, 403);
      remote.sessions[0].options = body; return answer({ ok: true });
    }
    if (url.pathname.endsWith("/send")) {
      expect(request.headers()["x-muse-request"]).toBe("1");
      if (remote.failSend) return answer({ error: "Desktop could not start the task." }, 409);
      remote.sends.push(body.prompt);
      const session=remote.sessions[0];
      if(session.running||session.queue.items.length||session.queue.paused){
        session.queue.items.push({id:`queue-${remote.sends.length}`,prompt:body.prompt,yolo:false,remote:true});publishQueue();
        return answer({queued:true,turn_id:''});
      }
      remote.entries.push({ seq: remote.entries.length + 1, event: { kind: "turn_start", prompt: body.prompt, remote: true } });
      remote.sessions[0] = { ...remote.sessions[0], running: true, status: "running", revision: remote.entries.length };
      return answer({ turn_id: "turn" });
    }
    if (url.pathname.endsWith("/stop")) {
      if(remote.sessions[0].queue.items.length){remote.sessions[0].queue.paused=true;remote.sessions[0].queue.reason='Stopped. Pending messages wait for Resume.';publishQueue();}
      remote.entries.push({ seq: remote.entries.length + 1, event: { kind: "turn_end", status: "cancelled" } });
      remote.sessions[0] = { ...remote.sessions[0], running: false, status: "cancelled", revision: remote.entries.length };
      return answer({ ok: true });
    }
    if(url.pathname.endsWith('/queue')){
      expect(request.headers()['x-muse-request']).toBe('1');
      if(body.action!=='load'&&!remote.control)return answer({error:'View only'},403);
      const q=remote.sessions[0].queue;
      if(body.action==='load')return answer(q);
      if(body.action==='pause'){q.paused=true;q.reason='Queue paused.';}
      if(body.action==='resume'){q.paused=false;q.reason=null;}
      if(body.action==='clear'){q.items=[];q.paused=false;q.reason=null;}
      if(body.action==='remove')q.items=q.items.filter(m=>m.id!==body.message_id);
      if(body.action==='edit')q.items.find(m=>m.id===body.message_id).prompt=body.prompt.trim();
      publishQueue();nextQueued();return answer(q);
    }
    if (url.pathname === "/api/logout") { remote.revoked = true; return answer({ ok: true }); }
    if (url.pathname === '/api/sessions/session-one/respond') {
      if (!control) return answer({error:'View only'},403);
      remote.responses.push(body);
      remote.interactions={...remote.interactions,revision:remote.interactions.revision+1,requests:remote.interactions.requests.map(request=>request.id===body.id?{...request,status:'submitting',source:'phone'}:request)};
      return answer(remote.interactions);
    }
    if (url.pathname === "/api/sessions/session-one") return answer({ session: remote.sessions[0], events: remote.entries.filter((e) => e.seq > Number(url.searchParams.get("after") || 0)), truncated: false, interactions:remote.interactions });
    if (url.pathname === "/api/sessions/bot-conversation") return answer({session:remote.sessions.find(s=>s.id==='bot-conversation'),events:[],truncated:false});
    return answer({ error: "Not found" }, 404);
  });
  await page.goto(`/remote.html${paired ? "" : "#pair=one-use-test-invitation"}`);
  if(paired && configure)await page.locator('.phone-assistant-controls > summary').click();
  return remote;
}

for(const provider of ['muse','codex','antigravity']) {
  test(`${provider}: phone queues active follow-ups and edits, removes and resumes pending messages`,async({page})=>{
    const remote=await boot(page,true,true,provider);
    await expect(page.locator('.phone-online')).toBeVisible();
    const composer=page.getByRole('textbox',{name:'Message your desktop agent'});
    await composer.fill('Active request');await page.getByRole('button',{name:'Send message',exact:true}).click();
    for(const prompt of ['Edit from phone','Remove from phone']){
      await composer.fill(prompt);await page.getByRole('button',{name:'Queue message',exact:true}).click();
      await expect(composer).toHaveValue('');
    }
    const queue=page.getByRole('region',{name:'Message queue'});
    await expect(queue).toContainText('2 queued');
    await expect(page.locator('.phone-message.user')).toHaveCount(2);
    await page.getByRole('button',{name:'Pause queue',exact:true}).click();
    await page.getByRole('button',{name:'Edit queued message 1',exact:true}).click();
    await page.getByRole('textbox',{name:'Edit queued message 1',exact:true}).fill('Edited from phone');
    await page.getByRole('button',{name:'Save queued message',exact:true}).click();
    await page.getByRole('button',{name:'Remove queued message 2',exact:true}).click();
    await expect(queue).toContainText('1 queued');
    for(const [width,height] of [[320,568],[844,390],[390,844]]){
      await page.setViewportSize({width,height});
      expect(await queue.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await expect(composer).toBeInViewport();
    }
    expect((await new AxeBuilder({page}).include('.message-queue').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    if(provider==='muse')await page.screenshot({path:'.qa/message-queue-phone.png',animations:'disabled'});
    await page.getByRole('button',{name:'Stop task',exact:true}).click();
    await expect(queue).toContainText('Paused');
    await page.getByRole('button',{name:'Resume queue',exact:true}).click();
    await expect(queue).toHaveCount(0);
    await expect(page.locator('.phone-message.user').last()).toContainText('Edited from phone');
    expect(remote.sessions[0].running).toBe(true);
  });
}

test('view-only phone shows queue without mutation controls and activity clears stale retry',async({page})=>{
  const remote=await boot(page,true,false,'codex');
  remote.sessions[0].queue={items:[{id:'one',prompt:'Desktop pending request',yolo:false,remote:false}],paused:true,reason:'Review queued work'};
  remote.sessions[0].running=true;remote.sessions[0].revision++;
  remote.entries.push({seq:4,event:{kind:'provider_progress',progress:{phase:'retrying',checked_at_ms:Date.now(),retry_at_ms:Date.now()+60000,attempt:2,max_attempts:10,http_status:503}}});
  await page.evaluate(()=>(window as any).remoteEvent());
  await expect(page.getByRole('region',{name:'Message queue'})).toContainText('Desktop pending request');
  await expect(page.getByRole('button',{name:'Resume queue'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Clear queue'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Edit queued message 1'})).toHaveCount(0);
  await expect(page.locator('.provider-wait')).toContainText('Codex service is temporarily unavailable');
  remote.entries.push({seq:5,event:{kind:'assistant_delta',text:'Recovered stream'}});remote.sessions[0].revision++;
  await page.evaluate(()=>(window as any).remoteEvent());
  await expect(page.locator('.provider-wait')).toHaveCount(0);
  await expect(page.locator('.phone-working')).toContainText('Responding');
});

test('phone usage replays provider counters, resets per turn, and never invents unknown capacity', async ({ page }) => {
  const remote = await boot(page, true, true, 'codex');
  remote.entries.push({ seq: 4, event: { kind: 'memory_context', titles: ['Phone preference'], bytes: 288 } },
    { seq: 5, event: { kind: 'usage', context: { used_tokens: 80000, window_tokens: 100000, measured_at: Date.now() }, turn: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 120, reasoning_output_tokens: 20, elapsed_ms: 2000 } } });
  remote.sessions[0].revision = 5;
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator('.usage-summary')).toContainText('Context 80%');
  await expect(page.locator('.usage-speed')).toContainText('60 tok/s');
  await page.locator('.usage-summary').click();
  await expect(page.getByRole('dialog', { name: 'Context and usage', exact: true })).toContainText('80,000 / 100,000');
  await expect(page.locator('.usage-details')).toContainText('Phone preference');
  expect((await new AxeBuilder({ page }).include('.usage-strip').analyze()).violations).toEqual([]);
  await page.getByLabel('Close usage details').click();
  await page.getByLabel('Message your desktop agent').fill('A new turn');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.usage-speed')).toHaveText('— tok/s');
  await expect(page.locator('.usage-context')).toContainText('80%');
  await page.getByRole('button', { name: 'Stop task' }).click();
  remote.entries.push({ seq: remote.entries.length + 1, event: { kind: 'usage_reset' } });
  remote.sessions[0].revision = remote.entries.length;
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator('.usage-context')).toHaveClass(/unknown/);
  await page.locator('.usage-summary').click();
  await expect(page.locator('.usage-details')).not.toContainText('Phone preference');
  await expect(page.locator('.usage-details')).toContainText('has not reported a context snapshot');
});

test('phone controls and usage fit the physical keyboard and landscape viewport sizes', async ({ page }) => {
  await boot(page);
  await page.getByLabel('Message your desktop agent').fill('Keep my draft while resizing');
  for (const size of [{ width: 411, height: 774 }, { width: 411, height: 447 }, { width: 852, height: 299 }]) {
    await page.setViewportSize(size);
    await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Project context & diagnostics' })).toBeInViewport();
    await expect(page.locator('.usage-summary')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.phone-transcript').evaluate(el => el.clientHeight)).toBeGreaterThan(100);
    await page.locator('.phone-session-select').click();
    const select = await page.locator('.phone-session-select').boundingBox();
    const menu = await page.locator('.phone-sessions').boundingBox();
    expect(menu!.y).toBeGreaterThanOrEqual(select!.y + select!.height - 1);
    await page.locator('.phone-sessions button').first().click();
    await page.locator('.usage-summary').click();
    await expect(page.getByLabel('Close usage details')).toBeInViewport();
    await page.getByLabel('Close usage details').click();
  }
  await expect(page.getByLabel('Message your desktop agent')).toHaveValue('Keep my draft while resizing');
  await page.setViewportSize({ width: 850, height: 65 });
  await expect(page.getByLabel('Message your desktop agent')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
  expect(await page.locator('.phone-composer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  await page.setViewportSize({ width: 411, height: 774 });
  await expect(page.locator('.usage-summary')).toBeVisible();
});

test('phone diagnostics preserve drafts, fit the screen and disappear after revocation',async({page})=>{
  const remote=await boot(page);
  await page.getByLabel('Message your desktop agent').fill('Keep phone draft');
  await page.getByRole('button',{name:'Project context & diagnostics'}).click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('not checked');
  await page.getByRole('button',{name:'Chat layout',exact:true}).click();
  expect(JSON.parse(await page.getByLabel('Chat layout snapshot preview').inputValue()).source).toBe('phone');
  expect((await new AxeBuilder({page}).include('.context-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath('context-phone.png')});
  expect(await page.locator('.context-panel').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await page.getByRole('button',{name:'Add to message'}).click();
  await expect(page.getByLabel('Message your desktop agent')).toHaveValue(/^Keep phone draft\n\n\[Chat layout snapshot/);
  expect(remote.sends).toEqual([]);
  await page.getByRole('button',{name:'Project context & diagnostics'}).click();
  remote.revoked=true;await page.evaluate(()=>(window as any).remoteEvent('revoked'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('view-only phone diagnostics expose no attachment or write check controls',async({page})=>{
  await boot(page,true,false);await page.getByRole('button',{name:'Project context & diagnostics'}).click();
  await expect(page.getByLabel('Velum diagnostics preview')).toContainText('not checked');
  await expect(page.getByRole('button',{name:'Add to message'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Test host access'})).toHaveCount(0);
});

test('phone creates a bot with personality, model and schedule controls',async({page})=>{
  const remote=await boot(page);await expect(page.locator('.phone-online')).toBeVisible();await page.getByRole('button',{name:'Bots',exact:true}).click();await page.getByRole('button',{name:'New bot',exact:true}).click();await page.getByLabel('Bot name',{exact:true}).fill('Grokbot');
  await expect(page.locator('.bots-panel').getByRole('button',{name:'Model: Phone model',exact:true})).toBeEnabled();await page.locator('.bots-panel').getByRole('button',{name:'Reasoning: Low',exact:true}).click();await page.getByRole('option',{name:/^High/}).click();
  await page.getByRole('button',{name:'Personality & instructions'}).click();await page.getByLabel('soul.md',{exact:true}).fill('You are {{name}}. Keep answers clear.');
  expect((await new AxeBuilder({page}).include('.bots-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:'.qa/bots-phone-editor.png'});
  await page.getByRole('button',{name:'Automation',exact:true}).click();await page.getByLabel('Run automatically on schedule').uncheck();await expect(page.getByText(/Next runs:/)).toBeVisible();
  await page.getByRole('button',{name:'Save bot',exact:true}).click();expect(remote.bots.profiles[0]).toMatchObject({name:'Grokbot',automatic:false,options:{model:'phone-model',reasoning:'high'}});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.qa/bots-phone.png'});
  await page.locator('.bot-card').getByRole('button',{name:'Chat',exact:true}).click();await expect(page.locator('.bots-panel')).toHaveCount(0);await expect(page.locator('.phone-session-select')).toContainText('Grokbot');await expect(page.locator('.phone-online')).toBeVisible();expect(remote.sends).toEqual([]);
});
test('view-only phone bots expose profiles without write or chat controls',async({page})=>{
  await boot(page,true,false);await expect(page.locator('.phone-online')).toBeVisible();await page.getByRole('button',{name:'Bots',exact:true}).click();await expect(page.getByRole('button',{name:'New bot',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Schedules',exact:true}).click();await expect(page.getByRole('button',{name:'Pause scheduling'})).toBeDisabled();
});

test("phone Kanban edits shared cards and prepares a draft with accessible touch controls",async({page})=>{
  const remote=await boot(page);await expect(page.locator(".phone-online")).toBeVisible();
  await page.getByLabel("Message your desktop agent").fill("Existing phone draft");
  await page.getByRole("button",{name:"Kanban",exact:true}).click();
  await page.getByRole("button",{name:"Add task to Backlog",exact:true}).click();
  await page.getByLabel("Title",{exact:true}).fill("Check the phone layout");await page.getByLabel("Details",{exact:true}).fill("Keep touch targets comfortable.");await page.getByRole("button",{name:"Save task",exact:true}).click();
  expect(remote.board.cards).toHaveLength(1);await page.getByLabel("Move Check the phone layout",{exact:true}).selectOption("progress");
  await expect(page.locator(".progress .kanban-card-title")).toHaveText("Check the phone layout");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).include(".kanban-panel").analyze()).violations).toEqual([]);
  await page.locator(".progress").scrollIntoViewIfNeeded();await page.screenshot({path:".qa/kanban-phone.png",animations:"disabled"});
  await page.getByRole("button",{name:"Work on this",exact:false}).click();
  await expect(page.getByLabel("Message your desktop agent")).toHaveValue(`Existing phone draft\n\nWork on this task: Check the phone layout\nTask ID: ${remote.board.cards[0].id}\n\nKeep touch targets comfortable.`);expect(remote.sends).toEqual([]);
});
test("view-only phone Kanban cannot mutate cards",async({page})=>{
  const remote=await boot(page,true,false);remote.board.cards=[{id:"one",title:"Read only",description:"",column:"backlog",priority:"normal"}];
  remote.board.trash=[{card:{id:"deleted",title:"Archived task",description:"",column:"backlog",priority:"normal"},deleted_at:Date.now()/1000}];
  await expect(page.locator(".phone-online")).toBeVisible();await page.getByRole("button",{name:"Kanban",exact:true}).click();
  await expect(page.getByRole("button",{name:"Add task to Backlog",exact:true})).toBeDisabled();await expect(page.getByLabel("Move Read only",{exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Work on this",exact:false})).toHaveCount(0);
  await page.getByRole("button",{name:/Trash 1/}).click();
  await expect(page.getByRole("button",{name:"Restore Archived task"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Delete permanently",exact:true})).toHaveCount(0);
});
test("phone planning fits touch screens and restoration leaves automatic work off",async({page})=>{
  const remote=await boot(page);
  remote.board.cards=[{id:"first",title:"Build the endpoint",description:"Acceptance criteria",column:"backlog",priority:"normal"},{id:"second",title:"Verify the endpoint",description:"Regression checks",column:"review",priority:"high",due_date:"2020-01-01",dependencies:["first"],assignment:{bot_id:"bot",cron:"*/15 * * * *",timezone:"UTC",automatic:true}}];
  await expect(page.locator(".phone-online")).toBeVisible();await page.getByRole("button",{name:"Kanban",exact:true}).click();
  await page.getByRole("button",{name:/Needs attention/}).click();
  await expect(page.locator(".kanban-card")).toHaveCount(1);
  await expect(page.getByRole("button",{name:/Work on this/})).toBeDisabled();
  await page.screenshot({path:".qa/planning-phone.png",animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).include(".kanban-panel").analyze()).violations).toEqual([]);
  await page.getByRole("button",{name:"Verify the endpoint",exact:true}).click();
  await expect(page.getByLabel("Due date")).toHaveValue("2020-01-01");
  await expect(page.getByRole("checkbox",{name:/Build the endpoint/})).toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).include(".kanban-panel").analyze()).violations).toEqual([]);
  await page.getByRole("button",{name:"Delete task",exact:true}).click();
  await page.getByRole("button",{name:"Move to Trash",exact:true}).click();
  await page.getByRole("button",{name:/Trash 1/}).click();
  await page.getByRole("button",{name:"Restore Verify the endpoint",exact:true}).click();
  expect(remote.board.cards.find(c=>c.id==="second").assignment.automatic).toBe(false);
  expect(remote.sends).toEqual([]);
});
test("revoking a phone closes its open Kanban and removes task details",async({page})=>{
  const remote=await boot(page);remote.board.cards=[{id:"one",title:"Private board task",description:"Project context",column:"backlog",priority:"normal"}];
  await expect(page.locator(".phone-online")).toBeVisible();await page.getByRole("button",{name:"Kanban",exact:true}).click();await expect(page.getByRole("button",{name:"Private board task",exact:true})).toBeVisible();
  remote.revoked=true;await page.evaluate(()=>(window as any).remoteEvent());await expect(page.locator(".kanban-panel")).toHaveCount(0);await expect(page.getByText("Private board task",{exact:true})).toHaveCount(0);
});

test("phone model choices update the session without losing the draft", async ({ page }) => {
  const remote = await boot(page);
  await expect(page.locator(".phone-online")).toBeVisible();
  await page.getByLabel("Message your desktop agent").fill("Keep this phone draft");
  await page.getByRole("button", { name: "Model: Phone model", exact: true }).click();
  await page.getByRole("option", { name: /^Phone model/ }).click();
  await page.getByRole("button", { name: "Reasoning: Low", exact: true }).click();
  await page.getByRole("option", { name: /^High/ }).click();
  await expect(page.getByRole("button", { name: "Reasoning: High", exact: true })).toBeVisible();
  expect(remote.sessions[0].options).toEqual({ model: "phone-model", reasoning: "high" });
  await expect(page.getByLabel("Message your desktop agent")).toHaveValue("Keep this phone draft");
  await expect(page.locator(".md strong")).toHaveText("Review complete.");
  await page.screenshot({ path: ".qa/phone-model-controls.png", animations: "disabled" });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Model: Phone model", exact: true })).toBeDisabled();
});

test("phone memory editor fits the viewport and leaves the conversation intact",async({page})=>{
  const remote=await boot(page);await expect(page.locator(".phone-online")).toBeVisible();
  await page.getByLabel("Message your desktop agent").fill("My draft");await page.getByRole("button",{name:"Memory",exact:true}).click();
  await page.getByRole("button",{name:"New note",exact:true}).click();await page.getByLabel("Memory title",{exact:true}).fill("Deployment");await page.getByLabel("Memory note",{exact:true}).fill("Use the staging branch for previews.");
  await page.getByRole("button",{name:"Save note",exact:true}).click();expect(remote.memory.notes[0].body).toContain("staging");
  await page.screenshot({path:".qa/memory-phone.png",animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const axe=await new AxeBuilder({page}).include(".memory-panel").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();expect(axe.violations).toEqual([]);
  await page.setViewportSize({width:390,height:440});await expect(page.getByRole("button",{name:"Close memory"})).toBeInViewport();
  await page.getByRole("button",{name:"Close memory"}).click();await expect(page.getByLabel("Message your desktop agent")).toHaveValue("My draft");
});

test("phone drafts survive reload and are removed when access is revoked",async({page})=>{
  const remote=await boot(page);await expect(page.locator(".phone-online")).toBeVisible();
  await page.getByLabel("Message your desktop agent").fill("Recover after Android restart\nSecond line");
  const saved=await page.evaluate(()=>localStorage.getItem("velum-phone-drafts-v1"));await page.reload();
  await expect(page.getByLabel("Message your desktop agent")).toHaveValue("Recover after Android restart\nSecond line");
  expect(await page.evaluate(()=>localStorage.getItem("velum-phone-drafts-v1"))).toBe(saved);
  remote.revoked=true;await page.evaluate(()=>(window as any).remoteEvent());await expect(page.locator(".phone-message")).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem("velum-phone-drafts-v1"))).toBeNull();
  await page.reload();await expect(page.getByLabel("Message your desktop agent")).toHaveCount(0);
});

async function durableDrafts(page: Page) {
  return page.evaluate(() => new Promise<Record<string, string>>((resolve, reject) => {
    const open = indexedDB.open('velum-phone-drafts', 1);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('velum-phone-drafts-v1');
      tx.oncomplete = () => { db.close(); resolve(request.result?.drafts || {}); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    open.onerror = () => reject(open.error);
  }));
}

test('durable phone drafts recover stale WebView local storage and revoke both stores', async ({ page }) => {
  const remote = await boot(page);
  await page.getByLabel('Message your desktop agent').fill('Durable phone draft');
  await expect.poll(() => durableDrafts(page)).toEqual({ 'session-one': 'Durable phone draft' });
  await page.evaluate(() => localStorage.setItem('velum-phone-drafts-v1', JSON.stringify({ time: Date.now() - 60000, drafts: { 'session-one': 'Stale WebView copy' } })));
  await page.reload();
  await expect(page.getByLabel('Message your desktop agent')).toHaveValue('Durable phone draft');
  remote.revoked = true;
  await page.evaluate(() => (window as any).remoteEvent('revoked'));
  await expect(page.getByLabel('Message your desktop agent')).toHaveCount(0);
  await expect.poll(() => durableDrafts(page)).toEqual({});
  expect(await page.evaluate(() => localStorage.getItem('velum-phone-drafts-v1'))).toBeNull();
  await page.reload();
  await expect(page.getByLabel('Message your desktop agent')).toHaveCount(0);
  await expect.poll(() => durableDrafts(page)).toEqual({});
});

test('phone storage failure leaves editing and the local fallback usable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('Storage disabled'); } } }); });
  await boot(page);
  await page.getByLabel('Message your desktop agent').fill('Fallback draft');
  await page.reload();
  await expect(page.getByLabel('Message your desktop agent')).toHaveValue('Fallback draft');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test("view-only phone memory cannot be edited",async({page})=>{
  await boot(page,true,false);await expect(page.locator(".phone-online")).toBeVisible();await page.getByRole("button",{name:"Memory",exact:true}).click();
  await expect(page.getByRole("button",{name:"New note",exact:true})).toBeDisabled();await page.getByRole("button",{name:"Memory settings",exact:true}).click();await expect(page.getByLabel("Memory learning")).toBeDisabled();
});

test("phone Remember creates a reviewable note from an answer",async({page})=>{
  await boot(page);await expect(page.locator(".phone-online")).toBeVisible();
  await page.locator(".phone-message.assistant").getByRole("button",{name:"Remember this message"}).click();
  await expect(page.getByLabel("Memory note",{exact:true})).toContainText("Review complete.");
  await expect(page.getByRole("button",{name:"Save note",exact:true})).toBeDisabled();
  await page.getByLabel("Memory title",{exact:true}).fill("Review result");await page.getByRole("button",{name:"Save note",exact:true}).click();
  await expect(page.getByRole("button",{name:"Archive",exact:true})).toBeVisible();
});

test("view-only phones cannot edit model settings", async ({ page }) => {
  await boot(page, true, false);
  await expect(page.locator(".phone-online")).toBeVisible();
  await expect(page.getByRole("button", { name: "Model: Phone model", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reasoning: Low", exact: true })).toBeDisabled();
});

test("phone pairs with a matching code and waits for desktop approval", async ({ page }) => {
  const remote = await boot(page, false);
  await expect(page.getByLabel("Name this phone")).toBeVisible();
  expect(page.url()).not.toContain("pair=");
  await page.getByLabel("Name this phone").fill("Pixel");
  await page.getByRole("button", { name: "Pair with desktop" }).click();
  await expect(page.getByLabel("Pairing code")).toHaveText("482196");
  await expect(page.getByText("Waiting for desktop confirmation")).toBeVisible();
  expect(remote.pending).toBe(true);
  await expect(page.getByLabel("Message your desktop agent")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Pairing code")).toHaveText("482196");
  remote.paired = true;
  await expect(page.getByLabel("Message your desktop agent")).toBeVisible();
  await expect(page.locator(".phone-online")).toBeVisible();
});

test("phone sends and stops real session actions while preserving multiline drafts", async ({ page }) => {
  const remote = await boot(page, true, true, "codex");
  await expect(page.locator(".phone-online")).toBeVisible();
  await expect(page.locator(".md strong")).toHaveText("Review complete.");
  await expect(page.locator(".phone-message.assistant .phone-message-label")).toHaveText("Codex");
  await page.screenshot({ path: ".qa/velum-phone.png", animations: "disabled" });
  const composer = page.getByLabel("Message your desktop agent");
  await composer.fill("Run the tests\nand report failures");
  await composer.press("Enter");
  expect(remote.sends).toHaveLength(0);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop task" })).toBeVisible();
  expect(remote.sends).toEqual(["Run the tests\nand report failures"]);
  await expect(page.locator(".phone-message.user").last()).toContainText("Run the tests");
  await composer.fill("My follow-up draft");
  await page.getByRole("button", { name: "Stop task" }).click();
  await expect(page.getByText("Task stopped.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("My follow-up draft");
});

test("send failures retain the phone draft and refresh restores history without duplicates", async ({ page }) => {
  const remote = await boot(page);
  await expect(page.locator(".phone-online")).toBeVisible();
  remote.failSend = true;
  await page.getByLabel("Message your desktop agent").fill("Keep this message");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("Desktop could not start");
  await expect(page.getByLabel("Message your desktop agent")).toHaveValue("Keep this message");
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.locator(".phone-message.user")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".phone-message.assistant")).toHaveCount(1);
});

test("revoking a phone immediately removes private data and controls", async ({ page }) => {
  const remote = await boot(page);
  await expect(page.locator(".phone-online")).toBeVisible();
  remote.revoked = true;
  await page.evaluate(() => (window as any).remoteEvent("revoked"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your desktop. In your pocket.");
  await expect(page.locator(".phone-message")).toHaveCount(0);
  await expect(page.getByLabel("Message your desktop agent")).toHaveCount(0);
});

test("view-only phone cannot send and mobile layout passes accessibility checks", async ({ page }) => {
  await boot(page, true, false);
  await expect(page.locator(".phone-online")).toBeVisible();
  await expect(page.getByText("View-only access", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message your desktop agent")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("phone survives disconnects, follows desktop output and keeps control disabled offline", async ({ page }) => {
  const remote = await boot(page);
  await expect(page.locator(".phone-online")).toBeVisible();
  await page.getByLabel("Message your desktop agent").fill("Unsent thought");
  await page.route("**/api/sessions", (route) => route.abort());
  await page.evaluate(() => (window as any).remoteEvent());
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByLabel("Message your desktop agent")).toHaveValue("Unsent thought");
  await page.unroute("**/api/sessions");
  remote.entries.push({ seq: 4, event: { kind: "turn_start", prompt: "From desktop", remote: false } }, { seq: 5, event: { kind: "turn_end", status: "completed", text: "Desktop result" } });
  remote.sessions[0].revision = 5;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Desktop result", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});
