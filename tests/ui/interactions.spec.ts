import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {boot} from './fixture';
import type {InteractionSnapshot} from '../../src/interactions';
import {mergeInteractionResponse} from '../../src/interactions';
import {actionPreview,interactionTool,interactionStatus,permissionScope} from '../../src/interactionPresentation';
import {commandApproval,featureQuestion} from './interaction-fixtures';

const approval=():InteractionSnapshot=>({generation:'turn-a',revision:1,active:true,requests:[{id:'approval:a',revision:1,kind:'approval',title:'Permission required: shell',tool:'shell',details:'Write a marker in the selected project.',choices:[{id:'allow',label:'Allow once',decision:'approve',scope:'once',accepts_feedback:false},{id:'deny',label:'Deny',decision:'deny',scope:'once',accepts_feedback:true}],questions:[],status:'pending'}]});
async function present(page:Page,snapshot=approval()){
  await page.evaluate(snapshot=>{const qa=(window as any).qa;const id=qa.calls.filter((c:any)=>c.cmd==='agent_new').at(-1).args.id;qa.interactions.set(id,snapshot);qa.emit('agent-interactions',{id,snapshot});},snapshot);
  return page.getByRole('region',{name:snapshot.requests[0].title,exact:true});
}
test('approval clicks carry exact stage identity once and remain submitting until confirmation',async({page})=>{
  await boot(page,0,false);const card=await present(page);
  await page.evaluate(()=>{(window as any).qa.holdResponse=true;});
  await card.getByRole('button',{name:'Allow once',exact:true}).click();
  await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeDisabled();
  await expect(card).toContainText('Waiting for confirmation');
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_respond').map((c:any)=>c.args.decision))).toEqual([{generation:'turn-a',id:'approval:a',revision:1,choice_id:'allow'}]);
  await page.evaluate(()=>{const qa=(window as any).qa;qa.holdResponse=false;qa.releaseResponse();});
  await expect(card).toContainText('Response from desktop');
  const settled=approval();settled.revision=3;settled.requests[0].status='approved';settled.requests[0].source='desktop';await present(page,settled);
  await expect(card.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
});
test('stale response refresh preserves a newer turn and Stop disables outstanding actions',async({page})=>{
  await boot(page,0,false);await page.locator('.composer textarea').fill('Work');await page.getByLabel('Send',{exact:true}).click();
  await present(page);await page.evaluate(()=>{(window as any).qa.holdResponse=true;});
  await page.getByRole('button',{name:'Allow once',exact:true}).click();
  const next=approval();next.generation='turn-b';next.requests[0].title='New turn permission';await present(page,next);
  await page.evaluate(()=>{const qa=(window as any).qa;qa.holdResponse=false;qa.releaseResponse();});
  await expect(page.getByRole('region',{name:'New turn permission'}).getByRole('button',{name:'Allow once'})).toBeEnabled();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_respond').length)).toBe(1);
});
test('denial feedback and multiple-choice answers retain their distinct wire shapes',async({page})=>{
  await boot(page,0,false);const card=await present(page);
  await card.getByRole('button',{name:'Add guidance',exact:true}).click();
  await card.getByLabel('Optional guidance when declining').fill('Use the existing file.');await card.getByRole('button',{name:'Deny',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_respond').at(-1).args.decision)).toMatchObject({choice_id:'deny',feedback:'Use the existing file.'});
  const state=approval();state.revision=2;state.requests=[{...state.requests[0],id:'question:q',revision:2,kind:'question',title:'Choose features',choices:[],details:'',questions:[{id:'features',header:'Features',question:'Choose features',options:[{label:'Alpha',description:'First'},{label:'Beta',description:'Second'}],multiple:true,free_text:true,secret:false,min:1,max:2}]}];
  await present(page,state);await page.getByRole('checkbox',{name:'Alpha First'}).check();await page.getByRole('button',{name:'Send answers',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.cmd==='agent_respond').at(-1).args.decision)).toEqual({generation:'turn-a',id:'question:q',revision:2,answers:[{question_id:'features',selected:['Alpha']}]});
});
test('permission choices and questions remain accessible at narrow desktop sizes',async({page})=>{
  await boot(page,0,false);await page.setViewportSize({width:760,height:480});await present(page);
  await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();
  expect((await new AxeBuilder({page}).include('.interaction-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.locator('.chat-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
test('late response cannot roll back a newer revision or change the active turn',()=>{
  const current=approval();current.revision=8;
  expect(mergeInteractionResponse(current,approval())).toBe(current);
  const other=approval();other.generation='other';other.revision=100;
  expect(mergeInteractionResponse(current,other)).toBe(current);
  const newer={...current,revision:9};expect(mergeInteractionResponse(current,newer)).toBe(newer);
});

for (const theme of ['graphite', 'daylight']) {
  test(`${theme}: long provider payloads stay compact with complete details and explicit broader permissions`, async ({page}) => {
    await page.addInitScript(theme => { (window as any).qaPreferences = {version:1, settings:{theme}}; }, theme);
    await boot(page,0,false);
    await page.locator('.composer textarea').fill('Polish the approval flow and check that it works.');
    await page.getByLabel('Send',{exact:true}).click();
    await page.evaluate(() => (window as any).qa.agent({kind:'assistant_delta',text:'The layout is ready. I need your permission to write the check file.'}));
    const state=commandApproval();const card=await present(page,state);
    await expect(card.locator('.interaction-command')).toContainText('Set-Content');
    await expect(card.locator('.interaction-payload')).toBeHidden();
    await expect(card.locator('textarea')).toBeHidden();
    await expect(card.getByRole('button',{name:'Allow for this session',exact:true})).toBeHidden();
    await expect(page.locator('.chat-running')).toHaveCount(0);
    expect((await card.boundingBox())!.height).toBeLessThan(200);
    await page.screenshot({path:`.qa/approval-${theme}-desktop.png`,animations:'disabled'});
    await card.getByRole('button',{name:'Details',exact:true}).click();
    await expect(card.locator('.interaction-payload')).toHaveText(state.requests[0].details);
    await card.getByRole('button',{name:'More options',exact:true}).click();
    await expect(card.locator('.interaction-payload')).toBeHidden();
    await expect(card.locator('.interaction-more')).toContainText('Saved for this workspace');
    await expect(card.locator('.interaction-rule')).toContainText('commandPrefix');
    expect((await new AxeBuilder({page}).include('.interaction-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await card.getByRole('button',{name:'More options',exact:true}).click();
    await page.setViewportSize({width:760,height:480});
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.interaction-heading')).toBeInViewport({ratio:1});
    await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeInViewport();
    expect(await page.locator('.chat-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.screenshot({path:`.qa/approval-${theme}-small-desktop.png`,animations:'disabled'});
    await card.getByRole('button',{name:'More options',exact:true}).click();
    await card.getByRole('button',{name:'Allow for this session',exact:true}).click();
    expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').at(-1).args.decision)).toEqual({generation:'review-turn',id:'review-command',revision:2,choice_id:'session'});
  });
}

test('a failed decision keeps guidance editable and sends it only with rejection', async ({page}) => {
  await boot(page,0,false);const card=await present(page,commandApproval());
  await card.getByRole('button',{name:'Add guidance',exact:true}).click();
  await card.getByLabel('Optional guidance when declining').fill('Use a temporary folder.');
  await card.getByRole('button',{name:'Edit guidance',exact:true}).click();
  await page.evaluate(() => { (window as any).qa.failResponse=true; });
  await card.getByRole('button',{name:'Reject',exact:true}).click();
  await expect(card.getByRole('alert')).toContainText('This request changed');
  await card.getByRole('button',{name:'Edit guidance',exact:true}).click();
  await expect(card.getByLabel('Optional guidance when declining')).toHaveValue('Use a temporary folder.');
  await page.evaluate(() => { (window as any).qa.failResponse=false; });
  await card.getByRole('button',{name:'Allow once',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').map((call:any)=>call.args.decision))).toEqual([
    {generation:'review-turn',id:'review-command',revision:2,choice_id:'reject',feedback:'Use a temporary folder.'},
    {generation:'review-turn',id:'review-command',revision:2,choice_id:'once'},
  ]);
});

test('past requests collapse into a single row and stay reviewable without live actions', async ({page}) => {
  await boot(page,0,false);const state=commandApproval();
  state.requests=Array.from({length:12},(_,index)=>({...state.requests[0],id:`old-${index}`,status:index%2?'denied':'approved',source:'phone'}));
  await present(page,state);
  const panel=page.locator('.interaction-panel');
  expect((await panel.boundingBox())!.height).toBeLessThan(50);
  await expect(panel).toContainText('12 past requests');
  await expect(panel.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
  await panel.locator('.interaction-history > summary').click();
  await panel.locator('.interaction-record > summary').first().click();
  await expect(panel.locator('.interaction-record').first().locator('pre')).toHaveText(state.requests[0].details);
});

test('question options, free text and private answers remain distinct and accessible', async ({page}) => {
  await boot(page,0,false);const state=featureQuestion();let card=await present(page,state);
  await expect(page.locator('.chat-empty')).toHaveCount(0);
  await card.getByRole('checkbox',{name:'Command preview A short preview of the action.'}).check();
  await expect(card.locator('fieldset')).toHaveAccessibleName('Which details should stay visible?');
  expect((await new AxeBuilder({page}).include('.interaction-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:'.qa/approval-question-desktop.png',animations:'disabled'});
  await card.locator('.interaction-write-answer > summary').click();
  await card.getByLabel('Or write your answer').fill('Show the affected file.');
  await expect(card.getByRole('checkbox').first()).not.toBeChecked();
  await card.getByRole('button',{name:'Send answers',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').at(-1).args.decision.answers)).toEqual([{question_id:'details',text:'Show the affected file.'}]);
  state.revision++;state.requests[0].revision++;state.requests[0].questions[0]={...state.requests[0].questions[0],multiple:false,secret:true,options:[]};
  card=await present(page,state);
  await expect(card.getByLabel('Write your answer')).toHaveAttribute('type','password');
  await card.getByLabel('Write your answer').fill('  private value  ');
  await card.getByRole('button',{name:'Send answers',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').at(-1).args.decision.answers)).toEqual([{question_id:'details',text:'  private value  '}]);
});

test('display previews preserve quoted braces, multiline commands and unrecognized details', () => {
  const command='Write-Output "quoted } { \\\" text"\n\nGet-ChildItem';
  const subject=JSON.stringify({kind:'shell',command,stages:[{argv:['{','}']}]},null,2);
  expect(actionPreview(subject+'\n\n'+JSON.stringify({description:'Run a command'}))).toEqual({command,description:'Run a command',structured:true});
  expect(actionPreview(JSON.stringify({reason:'Review this change'})+'\n\nProposed item:\n{}').description).toBe('Review this change');
  expect(actionPreview('{invalid provider data')).toEqual({command:'',description:'{invalid provider data',structured:false});
  expect(actionPreview('This request cannot be approved here.').description).toBe('This request cannot be approved here.');
});

test('file approvals show affected paths and keep the full proposed patch reviewable', async ({page}) => {
  await boot(page,0,false);const state=commandApproval('codex');
  state.requests[0]={...state.requests[0],title:'Review file changes',tool:'item/fileChange/requestApproval',details:JSON.stringify({threadId:'native-thread',itemId:'native-file'})+'\n\nProposed item:\n'+JSON.stringify({type:'fileChange',changes:[{path:'src/components/InteractionPanel.tsx',diff:'- bulky layout\n+ compact controls'},{path:'src/components/InteractionPanel.css',diff:'+ clean spacing'}]},null,2)};
  const card=await present(page,state);
  await expect(card).toContainText('Review changes to 2 files.');
  await expect(card.locator('.interaction-command')).toContainText('src/components/InteractionPanel.tsx');
  await card.getByRole('button',{name:'Details',exact:true}).click();
  await expect(card.locator('.interaction-payload')).toHaveText(state.requests[0].details);
});

test('questions enforce minimum and maximum choices before a decision can leave the form', async ({page}) => {
  await boot(page,0,false);const state=featureQuestion();
  state.requests[0].questions[0]={...state.requests[0].questions[0],min:2,max:2,free_text:false,options:[{label:'Alpha',description:'First'},{label:'Beta',description:'Second'},{label:'Gamma',description:'Third'}]};
  const card=await present(page,state);const send=card.getByRole('button',{name:'Send answers',exact:true});
  await expect(send).toBeDisabled();
  await card.locator('form').dispatchEvent('submit');
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').length)).toBe(0);
  await card.getByRole('checkbox',{name:'Alpha First'}).check();await expect(send).toBeDisabled();
  await card.getByRole('checkbox',{name:'Beta Second'}).check();await expect(send).toBeEnabled();
  await expect(card.getByRole('checkbox',{name:'Gamma Third'})).toBeDisabled();
  await card.getByRole('checkbox',{name:'Alpha First'}).uncheck();await expect(send).toBeDisabled();
  await card.getByRole('checkbox',{name:'Gamma Third'}).check();await send.click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').at(-1).args.decision.answers)).toEqual([{question_id:'details',selected:['Beta','Gamma']}]);
});

test('status refresh preserves a written answer while a changed provider requirement clears it', async ({page}) => {
  await boot(page,0,false);const state=featureQuestion();let card=await present(page,state);
  await card.locator('.interaction-write-answer > summary').click();
  await card.getByLabel('Or write your answer').fill('Keep the useful details.');
  state.revision++;await present(page,state);
  await expect(card.getByLabel('Or write your answer')).toHaveValue('Keep the useful details.');
  await card.locator('.interaction-write-answer > summary').click();
  await expect(card.locator('.interaction-write-answer > summary')).toHaveText('Edit your answer');
  await expect(card.getByRole('button',{name:'Send answers',exact:true})).toBeEnabled();
  state.revision++;state.requests[0].revision++;state.requests[0].questions[0].question='Review a different requirement';
  card=await present(page,state);
  await expect(card.locator('.interaction-write-answer > summary')).toHaveText('Write your own answer');
  await expect(card.getByRole('button',{name:'Send answers',exact:true})).toBeDisabled();
  await card.locator('.interaction-write-answer > summary').click();
  await expect(card.getByLabel('Or write your answer')).toHaveValue('');
});

test('required free text rejects whitespace and declining stays available', async ({page}) => {
  await boot(page,0,false);const state=featureQuestion();state.requests[0].questions[0].options=[];state.requests[0].questions[0].multiple=false;
  const card=await present(page,state);const send=card.getByRole('button',{name:'Send answers',exact:true});
  await expect(send).toBeDisabled();
  await card.getByLabel('Write your answer').fill('   ');await expect(send).toBeDisabled();
  await card.getByLabel('Write your answer').fill('Use the existing layout.');await expect(send).toBeEnabled();
  await card.getByLabel('Write your answer').clear();
  await card.getByRole('button',{name:'Decline to answer',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).qa.calls.filter((call:any)=>call.cmd==='agent_respond').at(-1).args.decision)).toEqual({generation:'review-turn',id:'question-layout',revision:2,cancel:true});
});

test('unknown provider labels remain text even when they name object properties', async ({page}) => {
  expect(interactionTool('__proto__')).toBe('__proto__');
  expect(permissionScope('constructor')).toBe('constructor');
  expect(interactionStatus('toString')).toBe('ToString');
  await boot(page,0,false);const state=approval();state.requests[0].tool='__proto__';
  const card=await present(page,state);
  await expect(card.locator('.interaction-tool')).toHaveText('__proto__');
  await expect(card.getByRole('button',{name:'Allow once',exact:true})).toBeEnabled();
});
