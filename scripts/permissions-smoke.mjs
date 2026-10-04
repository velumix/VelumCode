// Native Rust runner + desktop WebView + paired phone, with either a deterministic
// MSP peer or the installed Muse CLI. All app/workspace data is isolated.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const liveAgy=process.argv.includes('--live-agy');
const liveCodex=process.argv.includes('--live-codex');
const live=process.argv.includes('--live-muse')||liveAgy||liveCodex;
const provider=liveAgy?'antigravity':liveCodex?'codex':'muse';
const run=path.join(root,'.qa',`permissions-${live?`live-${provider}`:'fixture'}-${Date.now()}`);
const workspace=path.join(run,'workspace'),port=19425;
mkdirSync(workspace,{recursive:true});
const log=path.join(run,'rpc.jsonl');writeFileSync(log,'');
const sdk=path.join(run,'sdk');mkdirSync(path.join(sdk,'platform-tools'),{recursive:true});
execFileSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe',`/out:${path.join(sdk,'platform-tools/adb.exe')}`,path.join(root,'tests/fixtures/adb.cs')],{windowsHide:true});
if(!live)writeFileSync(path.join(run,'muse.cmd'),`@echo off\r\n"${process.execPath}" "${path.join(root,'tests/fixtures/msp-permissions.cjs')}" %*\r\n`);
if(!live)writeFileSync(path.join(run,'agy.cmd'),`@echo off\r\n"${process.execPath}" "${path.join(root,'tests/fixtures/agy-permissions.cjs')}" %*\r\n`);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let vite,app,browser,phoneBrowser,page,phone,current;
const errors=[];
const invoke=(cmd,args={})=>page.evaluate(({cmd,args})=>window.__TAURI_INTERNALS__.invoke(cmd,args),{cmd,args});
const rpcRecords=()=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const snapshot=()=>invoke('agent_interactions',{id:current});
const decision=(s,choice)=>({generation:s.generation,id:s.requests.at(-1).id,revision:s.requests.at(-1).revision,choice_id:choice});
async function waiting(){
  let state;
  await expect.poll(async()=>{state=await snapshot();if(!state.active)throw new Error(`Turn ended before requesting permission: ${await page.locator('.chat-wrap:not(.hidden)').innerText()}`);return state.requests.some(r=>r.status==='pending');},{timeout:live?180000:15000,message:'Provider must produce a pending permission request'}).toBe(true);
  return state;
}
async function start(prompt){
  const composer=page.locator('.chat-wrap:not(.hidden) .composer textarea');
  await expect(composer).toBeEnabled();await composer.fill(prompt);await composer.press('Enter');
  return waiting();
}
async function ended(){
  await expect.poll(async()=>{
    const result=await invoke('agent_new',{id:'reattach-probe',tabId:tabId,workspace,provider,resume:true});
    assert.equal(result.id,current);return result.live.running;
  },{timeout:live?180000:15000}).toBe(false);
}
let tabId;
try{
  try{await fetch('http://127.0.0.1:1420',{signal:AbortSignal.timeout(1000)});}catch{
    vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1'],{cwd:root,windowsHide:true,stdio:'ignore'});
  }
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1420')).ok)break;}catch{}await pause(100);}
  app=spawn(path.join(root,'src-tauri/target/debug/velum-code.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
    PATH:`${run};${process.env.PATH}`,VELUM_ISOLATED_TEST:'1',MUSE_CODE_CONFIG_DIR:path.join(run,'settings'),XDG_DATA_HOME:path.join(run,'provider-data'),
    ANDROID_HOME:sdk,MUSE_QA_ADB_DIR:run,VELUM_PERMISSION_LOG:log,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:path.join(run,'webview')
  }});
  for(let i=0;i<150;i++){assert.equal(app.exitCode,null,'Native app exited');try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{}await pause(100);}
  assert(browser,'Native WebView unavailable');page=browser.contexts()[0].pages()[0];
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__?.invoke);
  await expect(page.locator('.chat-wrap:not(.hidden) .composer textarea')).toBeEnabled();
  await expect(page.locator('#startup')).toHaveCount(0);await invoke('desktop_set_notifications',{enabled:false});await invoke('desktop_show');
  if(provider!=='muse'){
    await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.getByLabel('AI provider').selectOption(provider);
    await expect(page.locator('.chat-wrap:not(.hidden) .composer textarea')).toBeEnabled();
  }
  const folder=page.locator('.chat-wrap:not(.hidden)').getByLabel('Workspace directory');
  if(!await folder.isVisible())await page.locator('.chat-wrap:not(.hidden)').getByRole('button',{name:'Project folder',exact:true}).click();
  await folder.fill(workspace);await page.getByRole('button',{name:'Apply',exact:true}).click();
  await expect(page.locator('.chat-wrap:not(.hidden) .composer textarea')).toBeEnabled();
  const desktopState=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('velum-desktop-tabs-v1')));
  tabId=(await desktopState()).activeId;
  await expect.poll(async()=>(await desktopState())?.tabs.find(t=>t.id===tabId)?.workspace).toBe(workspace);
  const owner=await invoke('agent_new',{id:'reattach-probe',tabId,workspace,provider,resume:true});
  assert(owner.live,'UI must own the native session before testing');current=owner.id;
  // Exercise a reload before the asynchronous disk checkpoint can win.
  const saved=await desktopState();saved.drafts={[tabId]:'Current native draft'};
  await invoke('history_desktop_save',{snapshot:saved});
  assert.equal((await invoke('history_desktop_load')).drafts[tabId],'Current native draft');
  if(liveAgy){
    const target=path.join(run,'agy-marker.txt');
    await invoke('agent_send',{id:current,yolo:false,prompt:`Permission integration test. Use your run_command shell tool to run PowerShell Set-Content -LiteralPath '${target}' -Value 'VELUM_PERMISSION_OK'. Do not use file editing tools or touch any other files. If permission is denied, stop; do not try another method.`});
    await ended();
    const info=await invoke('agent_new',{id:'reattach-probe',tabId,workspace,provider,resume:true});
    const terminal=info.restored.filter(e=>e.kind==='turn_end').at(-1);assert(['blocked','completed'].includes(terminal.status),JSON.stringify(terminal));
    if(terminal.status==='blocked')assert(!existsSync(target));else assert.equal(readFileSync(target,'utf8').trim(),'VELUM_PERMISSION_OK');assert(info.session_id);
    await page.evaluate(async()=>{const {listen}=await import('/node_modules/@tauri-apps/api/event.js');window.__qaPty='';await listen('pty-data',e=>{window.__qaPty=(window.__qaPty+e.payload.data).slice(-50000);});});
    await page.getByRole('button',{name:'Continue this conversation in terminal',exact:true}).click();
    await expect.poll(async()=>(await invoke('agent_new',{id:'reattach-probe',tabId,workspace,provider,resume:true})).live.terminal).toBe(true);
    await expect.poll(()=>page.evaluate(()=>window.__qaPty.length),{timeout:30000}).toBeGreaterThan(100);
    await assert.rejects(invoke('agent_send',{id:current,prompt:'Cannot overlap terminal',yolo:false}));
    await invoke('pty_close_continuation',{tabId});
    await expect.poll(async()=>(await invoke('agent_new',{id:'reattach-probe',tabId,workspace,provider,resume:true})).live.terminal).toBe(false);
    console.log(`PASS: real Agy turn ${terminal.status}; native same-session continuation opens and excludes headless work. ${terminal.status==='completed'?'Existing provider policy allowed this write; denial coverage uses the fixture.':''} Evidence: ${run}`);
  }else{
  const marker=path.join(workspace,'allow-marker.txt');
  const livePrompt=(name)=>`Permission integration test. Use the PowerShell shell tool to write exactly VELUM_PERMISSION_OK to the file ${JSON.stringify(path.join(workspace,name))}. Use Set-Content -LiteralPath with this exact path. Do not use file-editing tools or change any other files. ${liveCodex?'Request escalated execution (sandbox_permissions=require_escalated) for this exact command so the client can approve it; explain that this is an authorization integration test.':'Request user permission if needed.'} After that, read it back with PowerShell and report the content. Do not work around a denied tool request; if denied, stop.`;
  let state=await start(live?livePrompt('allow-marker.txt'):'ALLOW');
  console.log(`Pending ${live?`real ${provider}`:'fixture'} request: ${state.requests.at(-1).title}`);
  // Reload must recover the same running native owner and actionable request.
  await page.reload();await expect(page.locator('#startup')).toHaveCount(0);
  await expect(page.locator('.interaction-card.interaction-pending')).toHaveCount(1);
  assert.equal((await snapshot()).generation,state.generation);
  console.log('PASS: pending approval survives desktop reload with the same owner');
  // Pair a mobile browser through the real Rust USB HTTP transport. Only ADB is faked.
  await invoke('remote_usb_connect',{serial:'USB_FIXTURE'});
  phoneBrowser=await chromium.launch({executablePath:process.env.BROWSER_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync),headless:true});
  const context=await phoneBrowser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});phone=await context.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.goto(readFileSync(path.join(run,'invitation.txt'),'utf8'));
  await phone.getByLabel('Name this phone').fill('Permission QA');await phone.getByRole('button',{name:'Pair with desktop',exact:true}).click();
  const code=await phone.getByLabel('Pairing code').innerText();await invoke('remote_approve',{code,control:true});
  await expect(phone.locator('.interaction-card.interaction-pending')).toHaveCount(1);
  await phone.reload();await expect(phone.locator('.interaction-card.interaction-pending')).toHaveCount(1);
  if(!live){
    await context.setOffline(true);
    await expect(phone.getByRole('button',{name:'Allow once',exact:true})).toBeDisabled({timeout:15000});
    assert(!rpcRecords().some(r=>r.method==='approval/decide'));
    await context.setOffline(false);await phone.reload();
    await expect(phone.getByRole('button',{name:'Allow once',exact:true})).toBeEnabled();
    console.log('PASS: offline phone disables approval and reconnect restores the pending request');
  }
  const allow=state.requests.at(-1).choices.find(c=>c.decision.startsWith('approve')&&c.scope==='once')||state.requests.at(-1).choices.find(c=>/allow|approve/i.test(c.label)&&c.scope==='once');
  assert(allow,JSON.stringify(state.requests.at(-1).choices));
  await phone.getByRole('button',{name:allow.label,exact:true}).click();
  // A second desktop response must never authorize the same stage again.
  await assert.rejects(invoke('agent_respond',{id:current,decision:decision(state,allow.id)}));
  // Live Muse may ask separately for the read-back operation; allow only this test's actions.
  if(live){
    for(let i=0;i<180;i++){
      state=await snapshot();const request=state.requests.find(r=>r.status==='pending');
      if(request){assert(request.details.includes('allow-marker.txt'),'Unexpected live action');const c=request.choices.find(c=>c.scope==='once'&&(/approve|allow/i.test(c.decision+' '+c.label)));assert(c);await invoke('agent_respond',{id:current,decision:{generation:state.generation,id:request.id,revision:request.revision,choice_id:c.id}});}
      const info=await invoke('agent_new',{id:'reattach-probe',tabId,workspace,provider,resume:true});if(!info.live.running)break;await pause(1000);
    }
    assert.equal(readFileSync(marker,'utf8').trim(),'VELUM_PERMISSION_OK');
  }
  await ended();console.log('PASS: phone allow reaches provider; duplicate desktop response rejected');
  state=await start(live?livePrompt('deny-marker.txt'):'DENY');
  const deny=state.requests.at(-1).choices.find(c=>/deny|decline|abort|reject/i.test(c.decision+' '+c.label))||state.requests.at(-1).choices.find(c=>c.decision==='cancelled');assert(deny);
  await page.getByRole('button',{name:deny.label,exact:true}).click();await ended();
  if(live)assert(!existsSync(path.join(workspace,'deny-marker.txt')),'Denied action wrote its file');
  console.log(`PASS: desktop rejection (${deny.label}) reaches provider without executing the action`);
  if(!live){
    state=await start('STAGED');const stale=decision(state,'allow_once');await invoke('agent_respond',{id:current,decision:stale});
    await expect.poll(async()=>{const next=await snapshot();return next.requests.at(-1).status==='pending'&&next.requests.at(-1).revision>stale.revision;}).toBe(true);
    await assert.rejects(invoke('agent_respond',{id:current,decision:stale}));state=await snapshot();await invoke('agent_respond',{id:current,decision:decision(state,'deny')});await ended();
    console.log('PASS: staged approval rejects stale responses and retains action details');
    state=await start('QUESTION');await page.getByRole('checkbox',{name:'Alpha First feature'}).check();await page.getByRole('button',{name:'Send answers',exact:true}).click();await ended();
    const answer=rpcRecords().find(r=>r.method==='userInput/answer');assert.deepEqual(answer.params.answers,[{questionId:'features',selectedLabels:['Alpha']}]);assert(!('answerModes' in answer.params));
    console.log('PASS: single selection in a multiple-choice question uses selectedLabels on the wire');
    state=await start('STOP');await invoke('agent_stop',{id:current});await assert.rejects(invoke('agent_respond',{id:current,decision:decision(state,'allow_once')}));await ended();assert(!(await snapshot()).active);
    console.log('PASS: Stop expires approval and rejects subsequent authorization');
    state=await start('REVOKE');const me=await phone.evaluate(async()=>await(await fetch('/api/me')).json());await invoke('remote_revoke',{id:me.device.id});
    const status=await phone.evaluate(async({id,decision})=>(await fetch(`/api/sessions/${id}/respond`,{method:'POST',headers:{'content-type':'application/json','x-muse-request':'1'},body:JSON.stringify(decision)})).status,{id:current,decision:decision(state,'allow_once')});assert.equal(status,401);assert.equal((await snapshot()).requests.at(-1).status,'pending');
    console.log('PASS: revoked phone cannot respond to a pending approval');
    await invoke('remote_usb_connect',{serial:'USB_FIXTURE'});
    const viewContext=await phoneBrowser.newContext({viewport:{width:390,height:844}}),view=await viewContext.newPage();
    await view.goto(readFileSync(path.join(run,'invitation.txt'),'utf8'));await view.getByLabel('Name this phone').fill('View only QA');await view.getByRole('button',{name:'Pair with desktop',exact:true}).click();
    await invoke('remote_approve',{code:await view.getByLabel('Pairing code').innerText(),control:false});
    await expect(view.getByRole('button',{name:'Allow once',exact:true})).toBeDisabled();
    const forbidden=await view.evaluate(async({id,decision})=>(await fetch(`/api/sessions/${id}/respond`,{method:'POST',headers:{'content-type':'application/json','x-muse-request':'1'},body:JSON.stringify(decision)})).status,{id:current,decision:decision(state,'allow_once')});assert.equal(forbidden,403);
    await viewContext.close();await invoke('agent_stop',{id:current});await ended();
    console.log('PASS: view-only phone sees the request but both UI and server reject authorization');
    const agyId='agy-permission-qa',agyTab='agy-permission-tab';
    await invoke('agent_new',{id:agyId,tabId:agyTab,workspace,provider:'antigravity'});
    await invoke('agent_send',{id:agyId,prompt:'Request the fixture action',yolo:false});
    let agyInfo;
    await expect.poll(async()=>{agyInfo=await invoke('agent_new',{id:'agy-probe',tabId:agyTab,workspace,provider:'antigravity',resume:true});return agyInfo.live.running;},{timeout:15000}).toBe(false);
    assert.equal(agyInfo.restored.filter(e=>e.kind==='turn_end').at(-1).status,'blocked');
    assert.equal((await invoke('agent_interactions',{id:agyId})).requests.length,0);
    await invoke('pty_spawn',{id:'agy-continued',cols:100,rows:30,resumeTabId:agyTab});
    await expect.poll(()=>rpcRecords().find(r=>r.provider==='antigravity'&&r.kind==='terminal')?.args).toContain(agyInfo.session_id);
    await assert.rejects(invoke('agent_send',{id:agyId,prompt:'Cannot overlap terminal',yolo:false}));
    await assert.rejects(invoke('agent_set_permissions',{id:agyId,yolo:true}));
    await assert.rejects(invoke('pty_spawn',{id:'agy-rival',cols:100,rows:30,resumeTabId:agyTab}));
    await page.reload();await expect(page.locator('#startup')).toHaveCount(0);
    await invoke('pty_close_continuation',{tabId:agyTab});
    agyInfo=await invoke('agent_new',{id:'agy-probe',tabId:agyTab,workspace,provider:'antigravity',resume:true});assert.equal(agyInfo.live.terminal,false);
    await invoke('pty_spawn',{id:'agy-exit',cols:100,rows:30,resumeTabId:agyTab});
    await expect.poll(()=>rpcRecords().filter(r=>r.provider==='antigravity'&&r.kind==='terminal').length).toBe(2);
    writeFileSync(log+'.exit','exit owned fixture');
    await expect.poll(()=>rpcRecords().filter(r=>r.provider==='antigravity'&&r.kind==='terminal-exit'&&r.code===0).length).toBe(1);
    console.log('Agy fixture exited normally; checking terminal ownership release');
    await expect.poll(async()=>(await invoke('agent_new',{id:'agy-probe',tabId:agyTab,workspace,provider:'antigravity',resume:true})).live.terminal,{timeout:10000}).toBe(false);
    console.log('PASS: Agy denial stays blocked; exact-session terminal excludes competing sends and releases ownership on close/reload/exit');
  }
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(run,'desktop.png')});
  console.log(`PASS: native permission smoke (${live?`live ${provider}`:'MSP and Agy fixtures'}). Evidence: ${run}`);
  }
}catch(error){
  if(page){await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});writeFileSync(path.join(run,'failure-ui.txt'),await page.locator('body').innerText().catch(()=>''));if(current)writeFileSync(path.join(run,'failure-state.json'),JSON.stringify(await snapshot().catch(e=>String(e)),null,2));}
  throw error;
}finally{
  if(current&&page)await invoke('agent_stop',{id:current}).catch(()=>{});
  if(page)await invoke('remote_usb_disconnect').catch(()=>{});
  await phoneBrowser?.close().catch(()=>{});await browser?.close().catch(()=>{});
  if(app&&app.exitCode===null)try{execFileSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
  if(vite&&vite.exitCode===null)vite.kill();
}
