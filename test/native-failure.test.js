import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {captureProcessFailure,nativeFailureReceipt,validateNativeFailure} from '../src/native-failure.js';
import {validateMonitor,monitorExport} from '../src/monitor-protocol.js';
import {overview,nativeExportExplanation} from '../src/serviceq-overview.js';
const jobId='b'.repeat(64);
const receipt = error => nativeFailureReceipt(error,'process',jobId,'0.4.17');

test('FD1/FD4 receipts distinguish exit, spawn, cap and deadline without serializing private diagnostics',()=>{
  for(const [error,expected] of [
    [Object.assign(new Error('SECRET'),{code:1}),{exitCode:1,nodeCode:null,killed:null}],
    [Object.assign(new Error('SECRET'),{code:'ENOENT'}),{exitCode:null,nodeCode:'ENOENT',killed:null}],
    [Object.assign(new Error('SECRET'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),{exitCode:null,nodeCode:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',outputCapped:true}],
    [Object.assign(new Error('SECRET'),{code:1,signal:'SIGTERM',killed:true}),{exitCode:1,signal:'SIGTERM',killed:true}],
    [Object.assign(new Error('SECRET'),{code:'SECRET',signal:'SECRET'}),{exitCode:null,nodeCode:null,signal:null}]
  ]) {
    const value=receipt(error);validateNativeFailure(value);
    for(const [key,expectedValue] of Object.entries(expected)) assert.equal(value[key],expectedValue);
    assert.equal(JSON.stringify(value).includes('SECRET'),false);
    assert.equal(value.stdoutCapturedBytes,null);
  }
});

test('FD1 SDK logger phases/status and captured byte counts retain no raw stderr or IO',()=>{
  const stderr='[langfuse-codex] error during flush/shutdown: OTLPExporterError\n  code: 413,\n SECRET private response';
  const error=Object.assign(new Error('SECRET'),{code:1});
  error.nativeProcessFailure=captureProcessFailure(error,'SECRET',stderr,5.7);
  const value=receipt(error);
  assert.equal(value.sdkPhase,'flush');assert.equal(value.httpStatus,413);assert.equal(value.elapsedMs,6);
  assert.equal(value.stdoutCapturedBytes,6);assert.equal(value.stderrCapturedBytes,Buffer.byteLength(stderr));
  assert.equal(JSON.stringify(value).includes('SECRET'),false);
  assert.equal(captureProcessFailure(error,'','[langfuse-codex] failed to convert rollout: SECRET',1).sdkPhase,'conversion');
  assert.equal(captureProcessFailure(error,'','{"message":"[langfuse-codex] error during flush/shutdown: OTLPExporterError code: 413"}',1).sdkPhase,'unknown');
  error.nativeProcessFailure={...error.nativeProcessFailure,nodeCode:'SECRET'};
  assert.equal(receipt(error).nodeCode,null);
});

test('FD1 actual execFile stdio limit is distinguishable without changing its cap or running an exporter',async()=>{
  const detail=await new Promise(resolve=>execFile(process.execPath,['-e','process.stderr.write("x".repeat(100000))'],{maxBuffer:65536,timeout:25000,windowsHide:true},(error,stdout,stderr)=>resolve(captureProcessFailure(error,stdout,stderr,0))));
  assert.equal(detail.nodeCode,'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');assert.equal(detail.outputCapped,true);
  assert.ok(detail.stderrCapturedBytes<=65536);assert.equal(detail.stdoutCapturedBytes,0);
});

test('FD1/FD4 gateway rejects unknown fields/values and reader receives the same safe receipt',()=>{
  const now=Date.now(),value=receipt(Object.assign(new Error('SECRET'),{code:1}));
  const packet={schema:1,id:'a'.repeat(32),at:new Date(now).toISOString(),host:'windows',runtime:'native',version:'0.4.17',services:[{service:'contextq',agent:'codex',state:'warning',reason:'telemetry_delivery_failed',metrics:{native_export_process_failed:3,native_export_attempts:50,native_export_retry_seconds:14,native_export_recovery_age_seconds:3600},nativeFailure:value}],incidents:[]};
  validateMonitor(packet);
  const spans=monitorExport(packet).otlp.resourceSpans[0].scopeSpans[0].spans;
  const row={id:spans[0].spanId,traceId:spans[0].traceId,startTime:packet.at,tags:['host:windows','agent:codex','service:contextq','state:warning','device:one'],statusMessage:'telemetry_delivery_failed',metadata:Object.fromEntries(spans[0].attributes.map(a=>[ 'attributes.'+a.key, a.value.stringValue??a.value.intValue??a.value.doubleValue??a.value.boolValue]))};
  const result=overview({health:[row]},now+300000);
  const service=result.hosts.find(h=>h.id==='windows/native').services[0];
  assert.deepEqual(service.nativeFailure,value);assert.match(service.reason,/на момент снимка/);assert.match(service.reason,/exit 1/);
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  for(const edit of [v=>v.raw='SECRET',v=>v.nodeCode='SECRET',v=>v.signal='SECRET',v=>v.stderrCapturedBytes=-1,v=>v.exitCode=-1,v=>v.sdkPhase='SECRET']) {
    const invalid=structuredClone(packet);edit(invalid.services[0].nativeFailure);assert.throws(()=>validateMonitor(invalid));
  }
  const old=structuredClone(packet);delete old.services[0].nativeFailure;validateMonitor(old);
  const stale=overview({health:[row]},now+700000);assert.equal(stale.hosts.find(h=>h.id==='windows/native').services[0].nativeFailure,null);
});

test('FD2/FD3 delayed retry and recovery seconds never claim a current future countdown',()=>{
  const at=Date.parse('2026-10-13T00:00:00Z');
  const text=nativeExportExplanation({native_export_process_failed:3,native_export_retry_seconds:14,native_export_recovery_age_seconds:60},at);
  assert.match(text,/на момент снимка: 14 сек/);assert.match(text,/на момент снимка: 60 сек/);
  assert.match(text,/07:00:00/);assert.match(text,/не текущий countdown/);
  assert.doesNotMatch(text,/попытка через/);
  assert.doesNotMatch(nativeExportExplanation({native_export_process_failed:1}),/NaN|undefined/);
});
