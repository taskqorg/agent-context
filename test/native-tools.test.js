import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeHook, nativePolicy, nativePaths } from '../src/native-tools.js';

test('native hook leaves protected commands and shell composition unchanged', async () => {
  for (const command of ['cat data.json', 'git log', 'python3.12 -m pytest', 'pytest; cat secret', 'pytest | head', 'pytest $(whoami)', 'pytest\ntrue']) {
    assert.deepEqual(await nativeHook({ hook_event_name:'PreToolUse', tool_name:'Bash', tool_input:{command} },'/launcher','/node'),{});
  }
  assert.deepEqual(await nativeHook({hook_event_name:'PostToolUse',tool_name:'Bash'},'/launcher','/node'),{});
});

test('native hook uses supported upstream rewrite, retains input and approval policy', {skip:process.platform==='win32'}, async () => {
  const previous=process.env.AGENT_CONTEXT_HOME;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-hook-'));
  process.env.AGENT_CONTEXT_HOME=dir;
  try {
    const p=nativePaths(); fs.mkdirSync(p.dir,{recursive:true});
    fs.writeFileSync(p.rtk,'#!/bin/sh\nprintf "rtk pytest -q\\n"\nexit 3\n',{mode:0o700});
    const result=await nativeHook({hook_event_name:'PreToolUse',tool_name:'Bash',session_id:'native-session',tool_input:{command:'pytest -q',timeout:5000}},'/launcher','/node');
    assert.equal(result.hookSpecificOutput.updatedInput.timeout,5000);
    assert.match(result.hookSpecificOutput.updatedInput.command,/tools run --trace .* -- pytest -q$/);
    assert.equal(result.hookSpecificOutput.permissionDecision,undefined);
    fs.writeFileSync(p.rtk,'#!/bin/sh\nprintf "rtk pytest -q\\n"\nexit 2\n',{mode:0o700});
    assert.deepEqual(await nativeHook({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'pytest -q'}},'/launcher','/node'),{});
    assert.match(nativePolicy('/launcher','/node','codex'),/--agent codex/);
  } finally {
    if(previous===undefined) delete process.env.AGENT_CONTEXT_HOME; else process.env.AGENT_CONTEXT_HOME=previous;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('native event retry never sends control token to an old proxy route',async()=>{
 const {nativeTemporaryRuns,flushNativeEvents}=await import('../src/native-tools.js');
 const {root}=await import('../src/core.js');
 const previous=process.env.AGENT_CONTEXT_HOME,originalFetch=globalThis.fetch;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-delivery-'));process.env.AGENT_CONTEXT_HOME=home;
 const id=(await import('node:crypto')).randomUUID(),dir=path.join(os.tmpdir(),'agent-context-native-'+id);
 fs.mkdirSync(dir,{mode:0o700});fs.mkdirSync(path.join(root(),'services'),{recursive:true});
 fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({schema:1,id,owner:root(),pid:process.pid,at:Date.now(),completed:true}));
 const event={id,agent:'codex',delivery:'unavailable'};fs.writeFileSync(path.join(dir,'event.json'),JSON.stringify(event));
 fs.writeFileSync(path.join(root(),'services/codex.json'),JSON.stringify({port:18787,managementPort:18789,owner:id,childPid:42,controlKey:'synthetic'}));
 let posts=0;
 try{
  globalThis.fetch=async(url,options)=>{assert.notEqual(options.method,'POST');return new Response(JSON.stringify({owner:id,pid:42}));};
  await flushNativeEvents();assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'event.json'))).delivery,'unavailable');
  globalThis.fetch=async(url,options)=>options.method==='POST'?new Response('{}',{status:403}):new Response(JSON.stringify({owner:id,pid:42,native_event_protocol:1}));
  await flushNativeEvents();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'event.json'))).delivery,'unavailable');
  const {incidents}=await import('../src/incidents.js');
  assert.ok(incidents().some(item=>item.operation==='native_event'&&item.category==='http_403'));
  assert.ok(!JSON.stringify(incidents()).includes('synthetic'));
  globalThis.fetch=async(url,options)=>{
   assert.ok(url.startsWith('http://127.0.0.1:'+(options.method==='POST'?18787:18789)+'/'));
   if(options.method==='POST'){posts++;assert.equal(options.headers['x-agent-context-control'],'synthetic');return new Response('{"accepted":true,"telemetry":true}');}
   return new Response(JSON.stringify({owner:id,pid:42,native_event_protocol:1}));
  };
  await flushNativeEvents();assert.equal(posts,1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'event.json'))).delivery,'submitted');
  await flushNativeEvents();assert.equal(posts,1);assert.ok(nativeTemporaryRuns().some(r=>r.id===id));
 }finally{globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.AGENT_CONTEXT_HOME;else process.env.AGENT_CONTEXT_HOME=previous;fs.rmSync(home,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true})}
});
