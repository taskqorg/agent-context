import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {enqueueCodexExport,processCodexExports,nativeExportStats,nativeExportDiagnostics,nativeExportLastFailure} from '../src/native-export.js';
import {root,version} from '../src/core.js';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-native-export-'));
process.env.AGENT_CONTEXT_HOME=profile;
const source=path.join(profile,'.codex/sessions/fixture.jsonl');fs.mkdirSync(path.dirname(source),{recursive:true});
const lines=[{type:'session_meta',payload:{id:'native-session'}},...['earlier','current'].flatMap(turn=>[{type:'event_msg',payload:{type:'task_started',turn_id:turn}},{type:'response_item',payload:{type:'message',content:[{type:'input_text',text:turn+' exact literal'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:turn}}])];
fs.writeFileSync(source,lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
test('R9: Stop only queues; retry preserves job, worker exports one exact turn and acknowledges once',async()=>{
 const input={transcript_path:source,turn_id:'current'};
 const hook=spawnSync(process.execPath,['bin/agent-context.js','native-hook','codex'],{input:JSON.stringify(input),encoding:'utf8',env:process.env});
 assert.equal(hook.status,0,hook.stderr);assert.deepEqual(JSON.parse(hook.stdout),{continue:true,suppressOutput:true});
 assert.deepEqual(enqueueCodexExport(input),enqueueCodexExport(input));assert.equal(nativeExportStats().queue_batches,1);
 assert.equal(nativeExportLastFailure(),null);
 const collector=async()=>({base_url:'http://127.0.0.1:18787',public_key:'synthetic',secret_key:'synthetic'});
 await processCodexExports({collector,run:async()=>{throw new Error('fixture unavailable')}});
 assert.equal(nativeExportStats().queue_batches,1);
 assert.equal(nativeExportLastFailure().stage,'process');assert.equal(nativeExportLastFailure().version,version);assert.equal(nativeExportLastFailure().exitCode,null);
 let tick=Date.now()+600000;
 for(const [code,options] of [
  ['concurrency_limit',{collector,run:async()=>{throw new Error('Concurrent export limit reached secret-fixture')}}],
  ['timeout',{collector,run:async()=>{throw Object.assign(new Error('secret-fixture'),{killed:true})}}],
  ['collector_unavailable',{collector:async()=>{throw new Error('secret-fixture')}}],
  ['unacknowledged',{collector,run:async()=>({stdout:''})}]
 ]) {
  await processCodexExports({...options,now:tick});
  assert.equal(nativeExportDiagnostics(tick)['native_export_'+code],1);
  const saved=fs.readFileSync(path.join(root(),'native-hook-outbox',fs.readdirSync(path.join(root(),'native-hook-outbox')).find(n=>/^[a-f0-9]{64}\.json$/.test(n))),'utf8');
  assert.ok(!saved.includes('secret-fixture'));
  assert.ok(nativeExportDiagnostics(tick).native_export_retry_seconds>0);
  tick+=600000;
 }
 const batches=[];
 await processCodexExports({collector,now:tick,run:async(command,args,options)=>{batches.push(options.env.LANGFUSE_FLUSH_AT);assert.equal(options.env.LANGFUSE_CODEX_FAIL_ON_ERROR,'true');throw Object.assign(new Error('private SDK response'),{exportStatus:413});}});
 assert.deepEqual(batches,['128','32','8']);assert.equal(nativeExportDiagnostics(tick).native_export_payload_too_large,1);assert.equal(nativeExportStats().queue_batches,1);tick+=600000;
 let rejected=0;
 await processCodexExports({collector,now:tick,run:async()=>{rejected++;throw Object.assign(new Error('private auth failure'),{exportStatus:401});}});
 assert.equal(rejected,1);tick+=600000;
 let calls=0;
 await processCodexExports({collector,now:tick,run:async(command,args,options)=>{
  calls++;assert.equal(options.env.LANGFUSE_FLUSH_AT,'128');assert.equal(JSON.parse(options.env.LANGFUSE_CODEX_METADATA)['agent_context.exporter_version'], version);const payload=JSON.parse(options.input),text=fs.readFileSync(payload.transcript_path,'utf8');
  assert.equal(payload.turn_id,'current');assert.ok(text.includes('current exact literal'));assert.ok(!text.includes('earlier exact literal'));assert.ok(text.includes('native-session'));
  assert.match(path.relative(path.resolve(path.dirname(payload.transcript_path),'../../..'),path.dirname(payload.transcript_path)),/^\d{4}[\\/]\d{2}[\\/]\d{2}$/);
  assert.ok(path.resolve(path.dirname(payload.transcript_path),'../../..').startsWith(path.join(root(),'native-hook-outbox','snapshot-')));
  fs.writeFileSync(payload.transcript_path+'.langfuse','current\n');
 }});
 assert.equal(calls,1);assert.ok(Number.isFinite(nativeExportDiagnostics().native_export_recovery_age_seconds));assert.equal(nativeExportStats().queue_batches,0);assert.equal(fs.readFileSync(source+'.langfuse','utf8'),'current\n');
 assert.equal(nativeExportLastFailure(),null);
 enqueueCodexExport(input);await processCodexExports({run:async()=>assert.fail('acknowledged turn must not be exported twice')});
 assert.equal(nativeExportStats().queue_batches,0);
 assert.throws(()=>enqueueCodexExport({transcript_path:path.join(profile,'secret.json')}));
 fs.rmSync(profile,{recursive:true,force:true});
});
