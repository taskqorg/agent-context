import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('R9: direct Windows-compatible stdin writer accepts only its bounded installation outbox',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-private-outbox-'));
  const config=path.join(home,'.codex/langfuse.json');fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config,JSON.stringify({public_key:'synthetic',secret_key:'synthetic',base_url:'https://lf.invalid'}));
  const env={...process.env,AGENT_CONTEXT_HOME:home,AGENT_CONTEXT_LANGFUSE_CONFIG:config};
  const target=path.join(home,'.agent-context/telemetry-outbox/local/codex','a'.repeat(64),'b'.repeat(32)+'.json');
  const input='{"resourceSpans":[]}';
  const run=file=>spawnSync(process.execPath,['bin/agent-context.js','telemetry','enqueue',file],{env,input,encoding:'utf8',timeout:20000});
  try {
    assert.equal(run(target).status,0);assert.equal(fs.readFileSync(target,'utf8'),input);
    const foreign=path.join(home,'unrelated.json');assert.notEqual(run(foreign).status,0);assert.equal(fs.existsSync(foreign),false);
  }finally {fs.rmSync(home,{recursive:true,force:true});}
});
