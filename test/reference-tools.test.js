import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {referenceTools,referenceHandler} from '../src/reference-tools.js';
test('stable document contract retains snapshot and survives engine replacement',async()=>{
 const previous=process.env.AGENT_CONTEXT_HOME,dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-contract-'));
 process.env.AGENT_CONTEXT_HOME=dir;
 try{
  const source=path.join(dir,'guide.txt');fs.writeFileSync(source,'Exact ERROR E42; never restart production.');
  const calls=[];const engine={callTool:async call=>{calls.push(call);return {content:[{type:'text',text:'Exact ERROR E42'}]}}};
  const run=referenceHandler(engine);
  const indexed=JSON.parse((await run('index_document',{path:source})).content[0].text);
  fs.writeFileSync(source,'changed');
  assert.equal(JSON.parse((await run('get_original',{ref:indexed.ref})).content[0].text).content,'Exact ERROR E42; never restart production.');
  await run('search_document',{ref:indexed.ref,queries:['E42']});assert.equal(calls.length,2);
  const replacement=referenceHandler(engine);
  await replacement('search_document',{ref:indexed.ref,queries:['restart']});
  assert.equal(calls.at(-2).arguments.content,'Exact ERROR E42; never restart production.');
  assert.deepEqual(referenceTools.map(t=>t.name),['index_document','search_document','get_original']);
  await assert.rejects(run('get_original',{ref:'../../secret'}));
  await assert.rejects(run('search_document',{ref:indexed.ref,queries:['']}));
 }finally{if(previous===undefined)delete process.env.AGENT_CONTEXT_HOME;else process.env.AGENT_CONTEXT_HOME=previous;fs.rmSync(dir,{recursive:true,force:true})}
});
