import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {serveFront} from '../src/front-proxy.js';
import {root} from '../src/core.js';
import {incidents} from '../src/incidents.js';
process.env.AGENT_CONTEXT_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-front-'));
fs.mkdirSync(root(),{recursive:true});
const selected=path.join(root(),'active.json');
const select=version=>fs.writeFileSync(selected,JSON.stringify({version}));
const wait=async predicate=>{for(let n=0;n<100;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error('Fixture condition timeout');};
test('R6: live socket stays on previous worker, new sockets switch atomically, failed active worker rolls back; at most two workers',async()=>{
 select('0.4.7');const children=[];
 const running=serveFront('codex',0,{retireMs:10000,graceMs:100,pollMs:20,start:({controlKey})=>{
  const child=fork(new URL('./fixtures/front-worker.mjs',import.meta.url),[JSON.parse(fs.readFileSync(selected)).version],{stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{...process.env,AGENT_CONTEXT_FRONT_CONTROL:controlKey}});children.push(child);return child;
 }});
 const stateFile=path.join(root(),'services/codex.json');
 await wait(()=>fs.existsSync(stateFile));
 const state=JSON.parse(fs.readFileSync(stateFile));
 const status=()=>fetch(`http://127.0.0.1:${state.managementPort}/agent-context/health`).then(r=>r.json());
 const event=await fetch(`http://127.0.0.1:${state.port}/agent-context/native-event`,{method:'POST',headers:{'x-agent-context-control':state.controlKey,connection:'close'},body:'{}'});
 assert.equal(event.status,200);assert.deepEqual(await event.json(),{accepted:true,telemetry:true});
 assert.equal((await fetch(`http://127.0.0.1:${state.port}/agent-context/native-event`,{method:'POST',headers:{connection:'close'},body:'{}'})).status,403);
 const socket=net.connect(state.port,'127.0.0.1');await once(socket,'connect');
 socket.write('GET /held HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
 await once(socket,'data');
 select('0.4.8');await wait(async()=> (await status()).version==='0.4.8');
 socket.write('exact bytes');assert.equal(String((await once(socket,'data'))[0]),'0.4.7:exact bytes');
 assert.equal(await fetch(`http://127.0.0.1:${state.port}/id`,{headers:{connection:'close'}}).then(r=>r.text()),'0.4.8');
 select('0.4.9');await new Promise(r=>setTimeout(r,100));assert.equal(children.length,2);
 children[1].kill('SIGKILL');await wait(async()=> (await status()).version==='0.4.7');
 assert.equal((await status()).rejectedVersion,'0.4.8');
 // Prevent a queued later version from starting during fixture shutdown.
 select('0.4.7');socket.destroy();await wait(async()=> (await status()).active===0);
 const response=await fetch(`http://127.0.0.1:${state.managementPort}/agent-context/shutdown`,{method:'POST',headers:{'x-agent-context-control':state.controlKey}});assert.equal(response.status,200);
 await running;
 for(const child of children) if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');

});

test('R6: retirement deadline closes an idle upgraded socket after grace and reports forced exit',async()=>{
 select('0.4.7');const children=[];fs.rmSync(path.join(root(),'services/codex.json'),{force:true});
 const running=serveFront('codex',0,{retireMs:150,graceMs:100,pollMs:20,start:({controlKey})=>{
  const child=fork(new URL('./fixtures/front-worker.mjs',import.meta.url),[JSON.parse(fs.readFileSync(selected)).version,'ignore-stop'],{stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{...process.env,AGENT_CONTEXT_FRONT_CONTROL:controlKey}});children.push(child);return child;
 }});
 const stateFile=path.join(root(),'services/codex.json');await wait(()=>fs.existsSync(stateFile));
 const state=JSON.parse(fs.readFileSync(stateFile));const status=()=>fetch(`http://127.0.0.1:${state.managementPort}/agent-context/health`).then(r=>r.json());
 const socket=net.connect(state.port,'127.0.0.1');await once(socket,'connect');
 socket.write('GET /idle HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');await once(socket,'data');
 const descendantPid=(await status()).descendantPid;
 const closed=once(socket,'close');socket.resume();select('0.4.8');await wait(async()=> (await status()).version==='0.4.8');
 assert.equal((await status()).retiringWorker.version,'0.4.7');
 await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Idle client did not close')),2000))]);await wait(async()=> (await status()).workerSlots===1);
 assert.ok(incidents().some(item=>item.operation==='retirement_forced'));
 await wait(()=>{try {process.kill(descendantPid,0);return false;}catch(error){return error.code==='ESRCH';}});
 assert.equal(await fetch(`http://127.0.0.1:${state.port}/id`,{headers:{connection:'close'}}).then(r=>r.text()),'0.4.8');
 await wait(async()=> (await status()).active===0);const shutdown=await fetch(`http://127.0.0.1:${state.managementPort}/agent-context/shutdown`,{method:'POST',headers:{'x-agent-context-control':state.controlKey}});assert.equal(shutdown.status,200);await running;
 await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'exit')));

});

test('R6: failed readiness leaves the active version and existing connections intact',async()=>{
 select('0.4.7');fs.rmSync(path.join(root(),'services/codex.json'),{force:true});const children=[];
 const running=serveFront('codex',0,{pollMs:20,graceMs:100,start:({controlKey})=>{
  const version=JSON.parse(fs.readFileSync(selected)).version;
  const child=fork(new URL('./fixtures/front-worker.mjs',import.meta.url),[version,version==='0.4.8'?'bad-ready':'normal'],{stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{...process.env,AGENT_CONTEXT_FRONT_CONTROL:controlKey}});children.push(child);return child;
 }});
 const stateFile=path.join(root(),'services/codex.json');await wait(()=>fs.existsSync(stateFile));const state=JSON.parse(fs.readFileSync(stateFile));
 const status=()=>fetch(`http://127.0.0.1:${state.managementPort}/agent-context/health`).then(r=>r.json());
 select('0.4.8');await wait(async()=> (await status()).stageFailures>0);
 const failed=await status();assert.equal(failed.version,'0.4.7');assert.equal(failed.targetVersion,'0.4.8');assert.equal(failed.retiringWorker,null);
 assert.equal(await fetch(`http://127.0.0.1:${state.port}/id`,{headers:{connection:'close'}}).then(r=>r.text()),'0.4.7');
 select('0.4.7');await wait(async()=> (await status()).active===0);
 const response=await fetch(`http://127.0.0.1:${state.managementPort}/agent-context/shutdown`,{method:'POST',headers:{'x-agent-context-control':state.controlKey}});assert.equal(response.status,200);await running;
 await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'exit')));
 fs.rmSync(process.env.AGENT_CONTEXT_HOME,{recursive:true,force:true});
});
