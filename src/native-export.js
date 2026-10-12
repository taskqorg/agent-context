import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {execFile} from 'node:child_process';
import {home,root,atomicWrite,sha,tryLock,version} from './core.js';
import {recordIncident} from './incidents.js';
import {atomicSecretWrite} from './private-file.js';
const execute=(command,args,{input,...options})=>new Promise((resolve,reject)=>{
  const child=execFile(command,args,options,(error,stdout,stderr)=>{
    if(error&&/\bcode:\s*413\b/.test(stderr)) error.exportStatus=413;
    error?reject(error):resolve({stdout});
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
});
const directory=()=>path.join(root(),'native-hook-outbox');
export const codexExporterPath=()=>path.join(home(),'.codex/plugins/cache/codex-observability-plugin/tracing/0.4.2/dist/index.mjs');
const files=()=>fs.existsSync(directory())?fs.readdirSync(directory()).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)):[];
export const nativeExportCodes = ['concurrency_limit','timeout','collector_unavailable','snapshot_unavailable','unacknowledged','process_failed','unknown'];
const retryDelay = attempts => Math.min(300000,1000*2**Math.min(attempts,9));
export function nativeExportDiagnostics(now=Date.now()) {
  const metrics=Object.fromEntries(nativeExportCodes.map(code=>['native_export_'+code,0]));
  metrics.native_export_attempts=0;metrics.native_export_retry_seconds=0;
  let next;
  for(const name of files()) {
    const job=JSON.parse(fs.readFileSync(path.join(directory(),name)));
    if(!Number.isSafeInteger(job.attempts)||job.attempts<0||job.lastAttempt!==undefined&&(!Number.isSafeInteger(job.lastAttempt)||job.lastAttempt<0)) throw new Error('Invalid native export queue');
    if(!job.attempts) continue;
    const code=nativeExportCodes.includes(job.diagnostic)?job.diagnostic:'unknown';
    metrics['native_export_'+code]++;
    metrics.native_export_attempts=Math.max(metrics.native_export_attempts,job.attempts);
    const due=Math.max(0,((job.lastAttempt||0)+retryDelay(job.attempts)-now)/1000);
    next=next===undefined?due:Math.min(next,due);
  }
  metrics.native_export_retry_seconds=next||0;
  const recovery=path.join(directory(),'recovery.status');
  if(fs.existsSync(recovery)) {
    const value=JSON.parse(fs.readFileSync(recovery));
    if(!Number.isSafeInteger(value.at)||value.at<0||value.at>now) throw new Error('Invalid native recovery receipt');
    metrics.native_export_recovery_age_seconds=(now-value.at)/1000;
  }
  return metrics;
}
function exportFailure(error,stage) {
  if(stage==='snapshot') return 'snapshot_unavailable';
  if(stage==='collector') return 'collector_unavailable';
  if(stage==='acknowledgement') return 'unacknowledged';
  if(error.killed||error.code==='ETIMEDOUT') return 'timeout';
  if(String(error.message).includes('Concurrent export limit reached')) return 'concurrency_limit';
  return 'process_failed';
}
function transcript(file) {
  const base=fs.realpathSync(path.join(home(),'.codex/sessions')),source=fs.realpathSync(file);
  if(!source.startsWith(base+path.sep)||!source.endsWith('.jsonl')||!fs.statSync(source).isFile()) throw new Error('Invalid native transcript');
  return source;
}

export function enqueueCodexExport(input) {
  if(fs.existsSync(path.join(root(),'uninstalling.json'))) throw new Error('Removal in progress');
  const source=transcript(input.transcript_path);
  if(input.turn_id!==undefined&&(typeof input.turn_id!=='string'||!/^[a-zA-Z0-9_:-]{1,128}$/.test(input.turn_id))) throw new Error('Invalid native turn');
  fs.mkdirSync(directory(),{recursive:true,mode:0o700});
  const id=sha(source+'\0'+(input.turn_id||fs.statSync(source).mtimeMs));
  const target=path.join(directory(),id+'.json');
  if(fs.existsSync(target)) return {status:'queued',id};
  if(files().length>=1000) throw new Error('Native telemetry queue full');
  atomicWrite(target,JSON.stringify({id,source,turn:input.turn_id||null,at:Date.now(),attempts:0}));
  return {status:'queued',id};
}

export function nativeExportStats() {
  const jobs=files().map(n=>JSON.parse(fs.readFileSync(path.join(directory(),n))));
  return {queue_batches:jobs.length,queue_bytes:jobs.reduce((n,j)=>n+Buffer.byteLength(JSON.stringify(j)),0),queue_oldest_seconds:jobs.length?Math.max(0,(Date.now()-Math.min(...jobs.map(j=>j.at)))/1000):0};
}

export async function snapshotTurn(source,wanted,target) {
  source=transcript(source);
  if(fs.statSync(source).size>512*1024*1024) throw new Error('Native transcript exceeds worker limit');
  let header,context,lines=[],selected=false,turn,complete=null,bytes=0;
  for await(const line of readline.createInterface({input:fs.createReadStream(source),crlfDelay:Infinity})) {
    const item=JSON.parse(line),event=item.type==='event_msg'?item.payload:{};
    if(item.type==='session_meta') header=line;
    if(item.type==='turn_context'&&!selected) context=line;
    if(event.type==='task_started') {
      if(wanted&&selected) break;
      selected=!wanted||event.turn_id===wanted;
      if(selected) {lines=[header,...context?[context]:[]].filter(Boolean);bytes=lines.join('\n').length;turn=event.turn_id;}
    }
    if(selected) {
      bytes+=Buffer.byteLength(line)+1;
      if(bytes>32*1024*1024) throw new Error('Native turn exceeds worker limit');
      lines.push(line);
      if(['task_complete','turn_aborted'].includes(event.type)) {complete={lines:[...lines],turn};if(wanted) break;}
    }
  }
  if(!complete?.turn||!header) throw new Error('Completed native turn unavailable');
  atomicSecretWrite(target,complete.lines.join('\n')+'\n');return complete.turn;
}

async function ownedCollector() {
  const config=JSON.parse(fs.readFileSync(path.join(home(),'.codex/langfuse.json')));
  const state=JSON.parse(fs.readFileSync(path.join(root(),'services/codex.json')));
  const url=new URL(config.base_url);
  if(config.enabled===false||url.origin!==`http://127.0.0.1:${state.port}`||url.pathname!=='/'||url.search||url.hash||url.username||url.password) throw new Error('Native collector routing drift');
  const health=await fetch(`http://127.0.0.1:${state.managementPort||state.port}/agent-context/health`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  if(health.owner!==state.owner||health.pid!==state.childPid||health.native_event_protocol!==1||health.telemetry!==true||health.backendHealthy===false) throw new Error('Native collector identity unavailable');
  return config;
}

export async function processCodexExports({run=execute,now=Date.now(),collector=ownedCollector}={}) {
  if(!fs.existsSync(directory())||fs.existsSync(path.join(root(),'uninstalling.json'))) return;
  const release=tryLock(path.join(directory(),'worker.lock'),120000);
  if(!release) return;
  let snapshot,snapshotRoot;
  try {
    if(fs.existsSync(path.join(root(),'uninstalling.json'))) return;
    for(const name of fs.readdirSync(directory())) if(/^[a-f0-9]{64}\.jsonl(?:\.langfuse)?$/.test(name)) fs.rmSync(path.join(directory(),name),{force:true});
    const jobFile=files().map(n=>path.join(directory(),n)).find(f=>{
      const j=JSON.parse(fs.readFileSync(f));return !j.lastAttempt||now-j.lastAttempt>=retryDelay(j.attempts);
    });
    if(!jobFile) return;
    const job=JSON.parse(fs.readFileSync(jobFile));
    // The exporter resolves its sessions root three levels above the transcript.
    snapshotRoot=fs.mkdtempSync(path.join(directory(),'snapshot-'));
    snapshot=path.join(snapshotRoot,...new Date(job.at).toISOString().slice(0,10).split('-'),job.id+'.jsonl');
    fs.mkdirSync(path.dirname(snapshot),{recursive:true,mode:0o700});
    let stage='snapshot';
    try {
      const turn=await snapshotTurn(job.source,job.turn,snapshot);
      const marker=job.source+'.langfuse';
      if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8').split('\n').includes(turn)) {fs.unlinkSync(jobFile);return;}
      stage='collector';const config=await collector();
      const env={...process.env,CODEX_HOME:path.join(home(),'.codex'),LANGFUSE_FLUSH_AT:'128',LANGFUSE_CODEX_PUBLIC_KEY:config.public_key,LANGFUSE_CODEX_SECRET_KEY:config.secret_key,LANGFUSE_CODEX_BASE_URL:config.base_url,LANGFUSE_CODEX_ENVIRONMENT:config.environment||'production',LANGFUSE_CODEX_METADATA:JSON.stringify({...config.metadata,'agent_context.exporter_version':version,'agent_context.capture_scope':'current_turn'})};
      if(config.user_id) env.LANGFUSE_CODEX_USER_ID=config.user_id;
      stage='process';
      for(const batch of [128,32,8]) {
        try {
          await run(process.execPath,[codexExporterPath()],{input:JSON.stringify({transcript_path:snapshot,turn_id:turn}),env:{...env,LANGFUSE_FLUSH_AT:String(batch),LANGFUSE_CODEX_DEBUG:'true',LANGFUSE_CODEX_FAIL_ON_ERROR:'true'},timeout:25000,maxBuffer:65536,windowsHide:true});
          break;
        }catch(error){if(error.exportStatus!==413||batch===8)throw error;}
      }
      stage='acknowledgement';
      const receipt=snapshot+'.langfuse';
      if(!fs.existsSync(receipt)||!fs.readFileSync(receipt,'utf8').split('\n').includes(turn)) throw new Error('Native exporter did not acknowledge turn');
      fs.appendFileSync(marker,turn+'\n',{mode:0o600});
      if(job.attempts) atomicWrite(path.join(directory(),'recovery.status'),JSON.stringify({at:Date.now(),version}));
      fs.unlinkSync(jobFile);
    }catch(error) {
      atomicWrite(jobFile,JSON.stringify({...job,lastAttempt:now,attempts:job.attempts+1,diagnostic:exportFailure(error,stage)}));
      recordIncident({component:'telemetry',operation:'native_export',category:'delivery_failed',agent:'codex'});
    }
  }catch {
    recordIncident({component:'telemetry',operation:'native_export_queue',category:'delivery_failed',agent:'codex'});
  }finally {
    if(snapshot) {fs.rmSync(snapshot,{force:true});fs.rmSync(snapshot+'.langfuse',{force:true});}
    if(snapshotRoot) fs.rmSync(snapshotRoot,{recursive:true,force:true});
    release();
  }
}
