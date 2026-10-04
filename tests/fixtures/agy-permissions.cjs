// Agy has no bidirectional headless approval protocol. Test the native fallback.
const fs=require('node:fs');
const args=process.argv.slice(2),session='ae283c22-1851-4d5c-a5c5-d14d53c23b72';
const log=entry=>fs.appendFileSync(process.env.VELUM_PERMISSION_LOG,JSON.stringify({provider:'antigravity',...entry})+'\n');
if(args[0]==='models'){console.log('fixture-agy    Fixture Antigravity');return;}
if(!args.includes('--input-format')){
  process.on('exit',code=>log({kind:'terminal-exit',code}));
  log({kind:'terminal',args});console.log('Agy native permission prompt');
  process.stdin.resume();
  setInterval(()=>{if(fs.existsSync(process.env.VELUM_PERMISSION_LOG+'.exit'))process.exit(0);},50);return;
}
const raw=fs.readFileSync(0,'utf8');log({kind:'turn',args});
console.log(JSON.stringify({event:'init',conversation_id:session}));
console.error('jetski: a tool required the command permission that headless mode cannot prompt for, so it was auto-denied.');
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Permission required.',conversation_id:session}}));
