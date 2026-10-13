import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {validateSdkTransport,captureProcessFailure,nativeFailureReceipt} from '../src/native-failure.js';
const {spans,jsonSpans}=createRequire(import.meta.url)('../src/native-http-observer.cjs');
const varint=n=>{const a=[];do{const b=n%128;n=Math.floor(n/128);a.push(b|(n?128:0));}while(n);return Buffer.from(a);};
const field=(n,b)=>Buffer.concat([varint(n*8+2),varint(b.length),b]);
const proto=(...entries)=>field(1,field(2,Buffer.concat(entries.map(b=>field(2,b)))));
test('FD1 encoded protobuf span lengths skip all attribute values; malformed data is unknown',()=>{
 const a=field(9,Buffer.from('SECRET')),b=field(9,Buffer.alloc(300,7)),body=proto(a,b);
 assert.deepEqual(spans(body),{count:2,max:b.length});
 assert.equal(spans(body.subarray(0,-1)),null);assert.equal(spans(Buffer.from([0])),null);
});
async function observed(mode){
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-http-observer-')),snapshot=path.join(work,'native-hook-outbox','snapshot-test');fs.mkdirSync(snapshot,{recursive:true,mode:0o700});const file=path.join(snapshot,'transport.json');
 const body=proto(field(9,Buffer.from('SECRET')),field(9,Buffer.alloc(700,42)));let received,auth;
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);received=Buffer.concat(chunks);auth=req.headers.authorization;if(mode==='reply'||mode==='pipe')res.writeHead(413).end('PRIVATE RESPONSE');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 try{
  const js=`const http=require('node:http');const data=Buffer.from('${body.toString('base64')}','base64');const req=http.request({hostname:'127.0.0.1',port:${port},path:'/api/public/otel/v1/traces',method:'POST',headers:{'content-type':'application/x-protobuf',authorization:'SECRET'}},res=>{res.resume();res.on('end',()=>{});});req.on('error',()=>{});req.setTimeout(${mode==='reply'||mode==='pipe'?3000:500},()=>req.destroy());${mode==='pipe'?"require('node:stream').Readable.from([data]).pipe(req);":mode==='stream'?'req.write(data.subarray(0,20));req.end(data.subarray(20));':'req.end(data);'}`;
  await new Promise((resolve,reject)=>execFile(process.execPath,['--require',fileURLToPath(new URL('../src/native-http-observer.cjs',import.meta.url)),'-e',js],{env:{...process.env,AGENT_CONTEXT_NATIVE_OBSERVER_FILE:file,AGENT_CONTEXT_NATIVE_OBSERVER_PORT:String(port)},timeout:5000,windowsHide:true},(e)=>e?reject(e):resolve()));
  const value=validateSdkTransport(JSON.parse(fs.readFileSync(file)));
  assert.equal(value.sdkRequests,1);assert.equal(value.sdkMaxBodyBytes,body.length);assert.equal(crypto.createHash('sha256').update(received).digest('hex'),crypto.createHash('sha256').update(body).digest('hex'));assert.equal(auth,'SECRET');
  assert.ok(value.sdkRequestFinishMs>=0);assert.ok(value.sdkSocketWrittenBytes>=body.length);assert.doesNotMatch(JSON.stringify(value),/SECRET|PRIVATE|127\.0\.0\.1|authorization/);
  if(mode==='reply'||mode==='pipe'){assert.equal(value.sdkResponseStatus,413);assert.ok(value.sdkResponseMs>=0);assert.equal(value.sdkTimedOut,false);assert.equal(value.sdkMaxSpans,2);assert.deepEqual(spans(body),{count:value.sdkMaxSpans,max:value.sdkMaxSpanBytes});}
  else{assert.equal(value.sdkResponseStatus,null);assert.equal(value.sdkResponseMs,null);assert.equal(value.sdkTimedOut,true);if(mode==='stream')assert.equal(value.sdkMaxSpanBytes,null);}
  const error={code:1,nativeProcessFailure:{...captureProcessFailure({code:1},'','',5),...value}};delete error.nativeProcessFailure.schema;const receipt=nativeFailureReceipt(error,'process','b'.repeat(64),'0.4.20');assert.equal(receipt.sdkMaxBodyBytes,body.length);
  assert.throws(()=>validateSdkTransport({...value,headers:'SECRET'}));assert.throws(()=>validateSdkTransport({...value,sdkResponseStatus:999}));assert.throws(()=>validateSdkTransport({...value,sdkMaxBodyBytes:-1}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(work,{recursive:true,force:true});}
}
test('FD1 observer preserves actual request bytes/auth/callback and measures HTTP413 without response content',()=>observed('reply'));
test('FD1 installed SDK single-buffer readable pipe measures encoded spans without retaining bytes',()=>observed('pipe'));
test('FD1 observer distinguishes completed writing from a missing response on real socket timeout',()=>observed('timeout'));
test('FD1 streamed bytes are measured while protobuf span dimensions remain unknown',()=>observed('stream'));

test('FD1 ordinary export failure reads fresh bounded transport receipt and preserves pending job/progress',async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'contextq-http-parent-'));process.env.AGENT_CONTEXT_HOME=profile;
 const {enqueueCodexExport,processCodexExports,nativeExportLastFailure,nativeExportStats}=await import('../src/native-export.js');
 const sdk=path.join(profile,'.codex/plugins/cache/codex-observability-plugin/tracing/0.4.2/dist/index.mjs');fs.mkdirSync(path.dirname(sdk),{recursive:true});
 const span={attributes:[{key:'fixture',value:{stringValue:'я'.repeat(900)}}]};const body=Buffer.from(JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[span]}]}]}));
 const server=http.createServer(async(req,res)=>{for await(const b of req){}res.writeHead(413).end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const script=`import http from 'node:http';const req=http.request(process.env.LANGFUSE_CODEX_BASE_URL+'/api/public/otel/v1/traces',{method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>{console.error('[langfuse-codex] error during flush/shutdown: OTLPExporterError: fixture\\n  code: 413,');process.exitCode=1;});});const {Readable}=await import('node:stream');Readable.from([Buffer.from('${body.toString('base64')}','base64')]).pipe(req);`;
 fs.writeFileSync(sdk,script);const source=path.join(profile,'.codex/sessions/fixture.jsonl');fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,[{type:'session_meta',payload:{id:'fixture'}},{type:'event_msg',payload:{type:'task_started',turn_id:'fixture'}},{type:'event_msg',payload:{type:'task_complete',turn_id:'fixture'}}].map(v=>JSON.stringify(v)).join('\n')+'\n');
 try{enqueueCodexExport({transcript_path:source,turn_id:'fixture'});await processCodexExports({collector:async()=>({base_url:'http://127.0.0.1:'+port,public_key:'fixture',secret_key:'fixture'})});const value=nativeExportLastFailure();assert.equal(value.httpStatus,413);assert.equal(value.sdkResponseStatus,413);assert.equal(value.sdkMaxBodyBytes,body.length);assert.equal(value.sdkMaxSpans,1);assert.equal(value.sdkRequests,1);assert.equal(nativeExportStats().queue_batches,1);assert.equal(fs.existsSync(source+'.langfuse'),false);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
});

test('FD1 JSON sizing measures canonical UTF8 spans without normalizing values or unsafe integer representations',()=>{
 const span={traceId:'a'.repeat(32),spanId:'b'.repeat(16),startTimeUnixNano:'1791860000000000001',attributes:[{key:'fixture',value:{stringValue:'я'.repeat(700000)}}]},body=Buffer.from(JSON.stringify({resourceSpans:[{scopeSpans:[{spans:[span,span]}]}]}));const before=crypto.createHash('sha256').update(body).digest('hex');
 assert.deepEqual(jsonSpans(body),{count:2,max:Buffer.byteLength(JSON.stringify(span))});assert.equal(crypto.createHash('sha256').update(body).digest('hex'),before);
 for(const b of [Buffer.from('{ "resourceSpans":[] }'),Buffer.from('{"resourceSpans":[],"n":9007199254740993}'),Buffer.from('{'),Buffer.from('{"resourceSpans":[{}]}'),Buffer.alloc(8*1024*1024+1)])assert.equal(jsonSpans(b),null);
});
