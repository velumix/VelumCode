// Validate installed CLI configuration without API credentials or model calls.
// Muse's local echo provider connects through the real Velum stdio adapter to
// a private MCP fixture. Codex metadata also checks real adapter discovery;
// Agy checks configuration parsing. No model request is made.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'win32');
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '.qa', `provider MCP ${Date.now()}`);
const app = process.argv.includes('--installed')
  ? path.join(process.env.LOCALAPPDATA, 'Velum Code/velum-code.exe')
  : path.join(root, `src-tauri/target/${process.argv.includes('--release') ? 'release' : 'debug'}/velum-code.exe`);
assert(existsSync(app), 'Build Velum before checking its adapter.');
mkdirSync(fixture, { recursive: true });
const report = {};
const cli = (binary, args, env) => run(binary, args, {
  cwd: fixture, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, ...env },
});

const codexHome = path.join(fixture, 'codex'); mkdirSync(codexHome);
const config = { command: app, args: ['--velum-tool-stdio'], env_vars: ['VELUM_TOOL_TOKEN', 'VELUM_TOOL_URL'], enabled: true, startup_timeout_sec: 15, tool_timeout_sec: 45 };
const codex = await cli(path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe'),
  ['mcp', 'get', 'velum_code', '--json', ...Object.entries(config).flatMap(([k, v]) => ['-c', `mcp_servers.velum_code.${k}=${JSON.stringify(v)}`])], { CODEX_HOME: codexHome });
const parsed = JSON.parse(codex.stdout);
assert.equal(parsed.transport.command, app);
assert(parsed.transport.env_vars.includes('VELUM_TOOL_TOKEN') && parsed.transport.env_vars.includes('VELUM_TOOL_URL'));
report.codex = { configurationAccepted: true, credentialNamesForwarded: true, liveConnectionTested: false };

const agyHome = path.join(fixture, 'agy-home'); mkdirSync(path.join(agyHome, '.gemini/config'), { recursive: true });
writeFileSync(path.join(agyHome, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { velum_code: { command: app, args: ['--velum-tool-stdio'] } } }));
const agy = await cli(path.join(process.env.LOCALAPPDATA, 'agy/bin/agy.exe'), ['mcp', 'list'], { USERPROFILE: agyHome });
assert(agy.stdout.includes('velum_code') && agy.stdout.includes('--velum-tool-stdio'));
report.antigravity = { configurationAccepted: true, liveConnectionTested: false };

const museDir = path.join(process.env.LOCALAPPDATA, 'Programs/muse');
const version = JSON.parse(readFileSync(path.join(museDir, '.muse-release-info.json'), 'utf8')).version;
assert(/^\d+\.\d+\.\d+-R[\d.]+$/.test(version));
const museBinary = path.join(museDir, `muse-bin-${version}.exe`);
const token = randomBytes(32).toString('hex'); const methods = [];
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  let bytes = ''; for await (const chunk of req) bytes += chunk;
  const request = JSON.parse(bytes); methods.push(request.method);
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'velum_code', version: 'fixture' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'turn_diagnostics', description: 'Fixture timing', inputSchema: { type: 'object', properties: {} } }] } : null;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(result === null ? {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}} : { jsonrpc: '2.0', id: request.id, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const museHome = path.join(fixture, 'muse-home'); const xdg = path.join(museHome, '.config');
  mkdirSync(path.join(xdg, 'muse'), { recursive: true });
  writeFileSync(path.join(xdg, 'muse/settings.json'), JSON.stringify({ schema_version: 1, mcpServers: { velum_code: { command: app, args: ['--velum-tool-stdio'], mode: 'optional', framing: 'line_delimited_json', env: { VELUM_TOOL_TOKEN: '${VELUM_TOOL_TOKEN:-}', VELUM_TOOL_URL: '${VELUM_TOOL_URL:-}' } } } }));
  const project = path.join(fixture, 'project'); mkdirSync(project);
  const result = await cli(museBinary, ['exec', '--json', '--provider', 'echo', '--workspace', project, '--trust-workspace', '--max-model-steps', '1', '--no-session-log', '--disable-web-tools', '--no-foreign-personal-context', '--approval-judge', 'off', 'Verify local echo transport.'], {
    USERPROFILE: museHome, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: path.join(museHome, '.data'),
    VELUM_TOOL_TOKEN: token, VELUM_TOOL_URL: `http://127.0.0.1:${server.address().port}/mcp`,
  });
  assert(!result.stdout.includes(token) && !result.stderr.includes(token));
  assert(methods.includes('initialize') && methods.includes('tools/list'), 'Installed Muse did not initialize/discover the configured adapter. ' + result.stderr.slice(0,1200));
  report.muse = { version, localEcho: true, realAdapterInitialize: true, realAdapterDiscovery: true, methods: [...methods] };
  const before = methods.length;
  const child = spawn(path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe'), ['app-server', ...Object.entries(config).flatMap(([k,v])=>['-c',`mcp_servers.velum_code.${k}=${JSON.stringify(v)}`])], {
    cwd:fixture,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_HOME:codexHome,VELUM_TOOL_TOKEN:token,VELUM_TOOL_URL:`http://127.0.0.1:${server.address().port}/mcp`},
  });
  let serial=0;const pending=new Map();
  createInterface({input:child.stdout}).on('line',line=>{let response;try{response=JSON.parse(line);}catch{return;}const request=pending.get(response.id);if(request){pending.delete(response.id);response.error?request.reject(Error(response.error.message)):request.resolve(response.result);}});
  child.stderr.resume();
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++serial;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('Codex metadata request timed out.'));},15000);
    pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try {
    await rpc('initialize',{clientInfo:{name:'velum-tool-qa',version:'1'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const status=await rpc('mcpServerStatus/list',{limit:10});
    assert(status.data.some(server=>server.name==='velum_code'&&server.tools.turn_diagnostics));
    assert(methods.slice(before).includes('initialize')&&methods.slice(before).includes('tools/list'));
    report.codex={...report.codex,liveConnectionTested:true,realAdapterInitialize:true,realAdapterDiscovery:true,modelCalls:false,methods:methods.slice(before)};
  } finally {
    try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
console.log(`Artifacts: ${fixture}`);
