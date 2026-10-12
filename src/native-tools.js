import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {serveTools} from './mcp.js';
import {referenceTools,referenceHandler} from './reference-tools.js';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { root, atomicWrite, tryLock, version } from './core.js';
import {recordIncident} from './incidents.js';
const execute = promisify(execFile);
export const toolVersions = { rtk: '0.51.0', contextMode: '1.0.169', mcpSdk: '1.32.1' };
const assets = {
  'darwin/arm64': ['rtk-aarch64-apple-darwin.tar.gz','8817d8b71afc02ac8bf06eb24bcc41c306592ab735b68e8fee9db1ba0de7cb59'],
  'darwin/x64': ['rtk-x86_64-apple-darwin.tar.gz','bd39c8153f4147358360c7dc51665a8131cc9ee16f81f69a9402ffa500be3cc2'],
  'linux/x64': ['rtk-x86_64-unknown-linux-musl.tar.gz','5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5'],
  'linux/arm64': ['rtk-aarch64-unknown-linux-gnu.tar.gz','8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632'],
  'win32/x64': ['rtk-x86_64-pc-windows-msvc.zip','1623e9b45d28b15122d69e7314776e1123a804224885ce07e7182fb40080f05c'],
};
export function nativePaths() {
  const dir = path.join(root(), 'native-tools', `${toolVersions.rtk}-${toolVersions.contextMode}-${toolVersions.mcpSdk}`);
  return { dir, rtk: path.join(dir, process.platform === 'win32' ? 'rtk.exe' : 'rtk'), mcp: path.join(dir, 'node_modules/context-mode/server.bundle.mjs') };
}
export async function prepareNativeTools({ run = execute, request = fetch } = {}) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||major===22&&minor<5) throw new Error('Native tools require Node 22.5 or newer');
  const p = nativePaths(), asset = assets[`${process.platform}/${process.arch}`];
  if (!asset) throw new Error('Unsupported native tool platform');
  try {
    const ready=JSON.parse(fs.readFileSync(path.join(p.dir,'ready.json')));
    if(ready.rtk===toolVersions.rtk&&ready.contextMode===toolVersions.contextMode&&ready.privateInstall===true&&ready.mcpSdk===toolVersions.mcpSdk&&fs.existsSync(p.rtk)&&JSON.parse(fs.readFileSync(path.join(p.dir,'node_modules/context-mode/package.json'))).version===toolVersions.contextMode&&fs.existsSync(p.mcp)) return p;
  }catch{/* Rebuild incomplete private installs. */}
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const release = tryLock(path.join(p.dir, 'prepare.lock'), 10 * 60000);
  if (!release) throw new Error('Native tools preparation already running');
  try {
    const response = await request(`https://github.com/rtk-ai/rtk/releases/download/v${toolVersions.rtk}/${asset[0]}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Native tools download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 30000000 || crypto.createHash('sha256').update(bytes).digest('hex') !== asset[1]) throw new Error('Native tools checksum mismatch');
    const archive = path.join(p.dir, asset[0]); fs.writeFileSync(archive, bytes, { mode: 0o600 });
    if (process.platform === 'win32') {
      const q = x => "'" + x.replaceAll("'", "''") + "'";
      const env={...process.env};
      for(const key of Object.keys(env)) if(key.toUpperCase()==='PSMODULEPATH') delete env[key];
      await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(p.dir)} -Force`], { env, timeout: 60000, windowsHide: true });
    } else await run('tar', ['-xzf', archive, '-C', p.dir], { timeout: 60000 });
    if (!fs.existsSync(p.rtk)) throw new Error('Native tools archive layout unsupported');
    atomicWrite(path.join(p.dir, 'package.json'), JSON.stringify({ name: 'agent-context-private-tools', private: true, version: '1.0.0' }));
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = process.platform === 'win32' ? ['/d','/s','/c',`npm install --ignore-scripts --no-audit --no-fund context-mode@${toolVersions.contextMode} @modelcontextprotocol/sdk@${toolVersions.mcpSdk}`] : ['install','--ignore-scripts','--no-audit','--no-fund',`context-mode@${toolVersions.contextMode}`,`@modelcontextprotocol/sdk@${toolVersions.mcpSdk}`];
    await run(command, args, { cwd: p.dir, timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true });
    const result = await run(p.rtk, ['--version'], { timeout: 10000 });
    if (result.stdout.trim() !== `rtk ${toolVersions.rtk}` || !fs.existsSync(p.mcp)) throw new Error('Native tools qualification failed');
    atomicWrite(path.join(p.dir, 'ready.json'), JSON.stringify({...toolVersions,privateInstall:true}));
    return p;
  } finally { release(); }
}
export async function nativeMcp(agent) {
  const p=await prepareNativeTools();
  const sdk=path.join(p.dir,'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const {Client}=await import(pathToFileURL(path.join(sdk,'index.js')));
  const {StdioClientTransport}=await import(pathToFileURL(path.join(sdk,'stdio.js')));
  const indexId=crypto.randomUUID(),dir=path.join(os.tmpdir(),'agent-context-index-'+indexId);
  fs.mkdirSync(dir,{mode:0o700});
  atomicWrite(path.join(dir,'run.json'),JSON.stringify({schema:1,id:indexId,kind:'index',owner:root(),pid:process.pid,at:Date.now(),completed:false}));
  const client=new Client({name:'agent-context',version:'1.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[p.mcp],env:{...process.env,CONTEXT_MODE_DIR:dir,CONTEXT_MODE_PROJECT_DIR:process.cwd(),CONTEXT_MODE_PLATFORM:agent==='claude'?'claude-code':'codex',DO_NOT_TRACK:'1'},stderr:'pipe'});
  transport.stderr?.resume();
  try {await client.connect(transport)} catch(error) {await client.close();fs.rmSync(dir,{recursive:true,force:true});throw error;}
  const close=async()=>{await client.close();fs.rmSync(dir,{recursive:true,force:true});};
  process.stdin.once('end',close);process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));
  serveTools(referenceTools,referenceHandler(client,{recall:async(dir,hash)=>{
    const run=nativeTemporaryRuns().find(r=>r.id===path.basename(dir).slice('agent-context-native-'.length));
    if(!run||!run.completed) throw new Error('Missing or expired original');
    dir=run.dir;
    const {stdout}=await execute(p.rtk,['recall','--full',hash],{env:{...process.env,RTK_RECALL_DB:path.join(dir,'recall.db')},timeout:10000,maxBuffer:11*1024*1024});
    return stdout;
  }}),nativePolicy(path.join(root(),'launcher.mjs'),process.execPath,agent));
}
export function nativePolicy(launcher, node, agent) {
  return `<!-- agent-context:start -->\n# Agent Context\nUse agent_context index_document/search_document for large reference documents when selected passages suffice; get_original recovers retained bytes without rerunning commands. Read code, complete JSON and short results normally. For supported noisy test/build commands use: ${JSON.stringify(node)} ${JSON.stringify(launcher)} tools run --agent ${agent} <native command arguments>. Unsupported commands keep native output. Proxy routes traffic and telemetry; it does not shorten history, user requests or tool schemas. Never recompress results. Keep normal login, model, sandbox and approval policy. On problems run agent-context doctor.\n<!-- agent-context:end -->`;

}
export async function nativeHook(input, launcher, node) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return {};
  const cmd = input.tool_input?.command;
  // Only simple qualified test/build commands; unsupported shell composition stays native.
  if (typeof cmd !== 'string' || /[;&|<>\r\n`]/.test(cmd) || /\$\(/.test(cmd) || !/^(?:pytest\b|cargo (?:test|build|check)\b|npm (?:test|run (?:build|lint))\b|go test\b)/.test(cmd)) return {};
  const { rtk } = nativePaths();
  if (!fs.existsSync(rtk)) return {};
  let rewritten;
  try { rewritten = (await execute(rtk, ['rewrite', cmd], { timeout: 2000 })).stdout.trim(); }
  catch (error) {
    // RTK 0.51 exit 3 means rewrite with host-owned approval; exit 2 preserves native deny.
    if (error.code !== 3 || typeof error.stdout !== 'string') return {};
    rewritten = error.stdout.trim();
  }
  if (!rewritten.startsWith('rtk ')) return {};
  const q = x => "'" + x.replaceAll("'", "'\"'\"'") + "'";
  const trace = Buffer.from(JSON.stringify({ agent: 'claude', session: input.session_id || null, call: input.tool_use_id || null })).toString('base64url');
  const command = `${q(node.replaceAll('\\','/'))} ${q(launcher.replaceAll('\\','/'))} tools run --trace ${trace} -- ${cmd}`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command } } };
}
async function deliverNativeEvent(event) {
  if(!['codex','claude','hermes'].includes(event.agent)) throw new Error('Native agent identity unavailable');
  const state=JSON.parse(fs.readFileSync(path.join(root(),'services',event.agent+'.json')));
  if(!Number.isInteger(state.port)||state.port<1||state.port>65535||!Number.isInteger(state.childPid)||!state.owner) throw new Error('Native service identity unavailable');
  const port=state.managementPort||state.port;
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Native management identity unavailable');
  const url=`http://127.0.0.1:${port}`;
  const health=await fetch(url+'/agent-context/health',{redirect:'error',signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  if(health.owner!==state.owner||health.pid!==state.childPid||health.native_event_protocol!==1||health.backendHealthy===false) throw new Error('Native service protocol unavailable');
  const response=await fetch(`http://127.0.0.1:${state.port}/agent-context/native-event`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-agent-context-control':state.controlKey},body:JSON.stringify(event),signal:AbortSignal.timeout(2000)});
  if(!response.ok) throw Object.assign(new Error('Native event delivery failed'),{status:response.status});
  return response.json();
}
export function nativeTemporaryRuns() {
  const runs=[];
  for(const base of new Set([os.tmpdir(),...(process.platform==='win32'?[]:['/tmp'])])) for(const entry of fs.readdirSync(base,{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^agent-context-(?:native|index)-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir=path.join(base,entry.name);
    try {
      const stat=fs.statSync(dir),file=path.join(dir,'run.json');
      if(process.getuid&&stat.uid!==process.getuid()||fs.statSync(file).size>1024||fs.lstatSync(file).isSymbolicLink()) continue;
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      if(value.schema!==1||value.owner!==root()||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.completed!=='boolean'||!Number.isFinite(value.at)||entry.name!=='agent-context-'+(value.kind==='index'?'index':'native')+'-'+value.id) continue;
      runs.push({...value,dir,bytes:fs.readdirSync(dir).reduce((n,name)=>n+fs.statSync(path.join(dir,name)).size,0)});
    }catch{/* Unknown temporary folders are never removed. */}
  }
  return runs;
}
export async function nativeRtk(args) {
  if(fs.existsSync(path.join(root(),'uninstalling.json'))) throw new Error('Removal in progress');
  const p = await prepareNativeTools(); let trace = { agent: process.env.AGENT_CONTEXT_AGENT || 'unknown', ...(process.env.CODEX_THREAD_ID ? {session:process.env.CODEX_THREAD_ID} : {}) };
  if (args[0] === '--agent') { trace.agent = args[1]; args = args.slice(2); }
  if (args[0] === '--trace' && args[2] === '--') { trace = JSON.parse(Buffer.from(args[1], 'base64url').toString()); args = args.slice(3); }
  if (!trace || typeof trace !== 'object' || !['codex', 'claude', 'hermes', 'unknown'].includes(trace.agent)) throw new Error('Invalid native tool identity');
  trace = { agent: trace.agent, ...(typeof trace.session === 'string' ? { session: trace.session.slice(0,128) } : {}), ...(typeof trace.call === 'string' ? { call: trace.call.slice(0,128) } : {}) };
  const runId=crypto.randomUUID(),dir=path.join(process.platform==='win32'?os.tmpdir():'/tmp','agent-context-native-'+runId); fs.mkdirSync(dir,{mode:0o700});
  const run={schema:1,id:runId,owner:root(),pid:process.pid,at:Date.now(),completed:false};
  atomicWrite(path.join(dir,'run.json'),JSON.stringify(run));
  if(fs.existsSync(path.join(root(),'uninstalling.json'))) throw new Error('Removal in progress');
  const env = { ...process.env, RTK_DB_PATH: path.join(dir,'gain.db'), RTK_RECALL_DB: path.join(dir,'recall.db'), RTK_TELEMETRY_DISABLED:'1', RTK_SUPPRESS_HOOK_WARNING:'1' };
  const started = Date.now();
  const code = await new Promise((resolve,reject) => { const child=spawn(p.rtk,args,{stdio:'inherit',env,windowsHide:true});child.once('error',reject);child.once('close',n=>resolve(n??1)); });
  try {
    const { stdout } = await execute(p.rtk,['gain','--format','json'],{env,timeout:2000});
    const gain=JSON.parse(stdout).summary;
    const event={schema:1,id:crypto.randomUUID(),at:new Date().toISOString(),recipe:'local-tools',engine:'rtk',engine_version:toolVersions.rtk,wrapper_version:version,...trace,elapsed_ms:Date.now()-started,exit_code:code,input_tokens:gain.total_input,output_tokens:gain.total_output,token_source:'rtk_estimate'};
    event.delivery='queued';
    atomicWrite(path.join(dir,'event.json'),JSON.stringify(event));
  } catch { process.stderr.write('Native metrics unavailable; command exit preserved\n'); }
  process.stdout.write(`\n[Agent Context original ref: rtk:${runId}; use get_original with the hash from RTK's recovery hint. Retention: latest 500 completed runs, 7 days, 512 MiB cap.]\n`);
  try {
    atomicWrite(path.join(dir,'run.json'),JSON.stringify({...run,completed:true}));
    const old=nativeTemporaryRuns().filter(r=>r.completed).sort((a,b)=>b.at-a.at);let bytes=0;
    for(const [i,item] of old.entries()) {bytes+=item.bytes;if(i>=500||Date.now()-item.at>7*86400000||bytes>512*1024*1024) fs.rmSync(item.dir,{recursive:true,force:true});}
  }catch {process.stderr.write('Native recovery cleanup unavailable; command exit preserved\n');}
  return code;
}

export async function nativeRun(args) {
  const offset=args[0]==='--agent'?2:args[0]==='--trace'&&args[2]==='--'?3:0;
  const command=args.slice(offset);
  if(fs.existsSync(nativePaths().rtk) && (command[0]==='pytest' || command[0]==='cargo'&&['test','build','check'].includes(command[1]) || command[0]==='go'&&command[1]==='test')) {
    try{return await nativeRtk(args)} catch(error){
      if(!['EPERM','EACCES','EROFS'].includes(error.code)) throw error;
      process.stderr.write('Optimization skipped: sandbox cannot store recovery; native command preserved\n');
    }
  }
  if(!command[0]) throw new Error('Native command required');
  return new Promise(resolve=>{const child=spawn(command[0],command.slice(1),{stdio:'inherit',windowsHide:true});child.once('error',()=>{process.stderr.write('Native command could not start\n');resolve(127)});child.once('close',n=>resolve(n??1));});
}

export async function flushNativeEvents() {
  const pending=nativeTemporaryRuns().filter(r=>{try{return r.completed&&fs.statSync(path.join(r.dir,'event.json')).size<=4096&&JSON.parse(fs.readFileSync(path.join(r.dir,'event.json'))).delivery!=='submitted'}catch{return false}}).sort((a,b)=>a.at-b.at).slice(0,10);
  await Promise.all(pending.map(async run=>{
    const file=path.join(run.dir,'event.json');
    try {
      const event=JSON.parse(fs.readFileSync(file));if(event.delivery==='submitted')return;
      const result=await deliverNativeEvent(event);
      if(result.accepted&&result.telemetry)atomicWrite(file,JSON.stringify({...event,delivery:'submitted'}));
      else throw new Error('Native telemetry acknowledgement unavailable');
    }catch(error){
      recordIncident({component:'telemetry',operation:'native_event',category:/^[45][0-9]{2}$/.test(String(error.status))?'http_'+error.status:'delivery_failed'});
    }
  }));
}
