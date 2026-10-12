import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {root} from '../src/core.js';
import {reconcileServices,superviseMonitor} from '../src/monitor-runtime.js';
process.env.AGENT_CONTEXT_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-supervisor-'));
fs.mkdirSync(root(),{recursive:true});
test('R6: worker version switch restarts immediately; crash has backoff',async()=>{
 const controller=new AbortController();let starts=0;const waits=[];
 await superviseMonitor({signal:controller.signal,start:()=>{
  const c=new EventEmitter();c.kill=()=>c.emit('exit',0);
  queueMicrotask(()=>{starts++;if(starts===3)controller.abort();else c.emit('exit',starts===1?75:1);});return c;
 },wait:async ms=>waits.push(ms)});
 assert.equal(starts,3);assert.deepEqual(waits,[1000]);
});
test('R6/R8: reconcile only configured agents; removal disables starts',async()=>{
 fs.mkdirSync(root(),{recursive:true});fs.writeFileSync(path.join(root(),'integration.json'),JSON.stringify({agents:['codex','codex','invalid']}));
 const seen=[];await reconcileServices({ensure:async a=>seen.push(a)});assert.deepEqual(seen,['codex']);
 fs.writeFileSync(path.join(root(),'uninstalling.json'),'{}');await reconcileServices({ensure:async()=>assert.fail('removal must not restart service')});
 fs.rmSync(path.join(root(),'uninstalling.json'));fs.rmSync(process.env.AGENT_CONTEXT_HOME,{recursive:true,force:true});
});
