import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork,execFileSync} from 'node:child_process';
import {root,home,version} from './core.js';
import {launcher} from './update.js';
import {atomicSecretWrite} from './private-file.js';
import {startProxy} from './run.js';
import {profileIdentity} from './telemetry.js';
import {recordIncident} from './incidents.js';

// R6: standard TCP piping preserves HTTP/SSE/WebSocket bytes and backpressure.
export function tcpFront(resolve) {
  return net.createServer(socket=>{
    const worker=resolve();
    if(!worker) {socket.destroy();return;}
    worker.sockets.add(socket);
    const upstream=net.connect(worker.port,'127.0.0.1');
    socket.pipe(upstream);upstream.pipe(socket);
    socket.once('close',()=>{worker.sockets.delete(socket);upstream.destroy();});
    socket.on('error',()=>upstream.destroy());
    upstream.once('close',()=>socket.destroy());
    upstream.on('error',()=>{recordIncident({component:'proxy',operation:'worker_connection',category:'request_failed',agent:'unknown'});socket.destroy();});
  });
}

function killTree(child,force) {
  if(child.exitCode!==null||child.signalCode!==null) return;
  try {
    if(process.platform==='win32') {
      if(force) execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:10000});
      else child.kill('SIGTERM');
    }else process.kill(-child.pid,force?'SIGKILL':'SIGTERM');
  }catch {recordIncident({component:'proxy',operation:'worker_stop',category:'process_exit',agent:'unknown'});}
}

export async function serveProxyWorker(agent) {
  if(!process.send) throw new Error('Proxy worker requires its managed supervisor');
  let proxy,closing=false,deadline;
  const stop=()=>{if(!closing){
    closing=true;proxy?.stop().catch(()=>recordIncident({component:'proxy',operation:'worker_stop',category:'process_exit',agent:agent==='claude'?'claude-code':agent}));
    deadline=setTimeout(()=>{
      recordIncident({component:'proxy',operation:'worker_orphan_forced',category:'process_exit',agent:agent==='claude'?'claude-code':agent});
      killTree({pid:process.pid,exitCode:null,signalCode:null},true);
    },30000);deadline.unref();
  }};
  const message=value=>{if(value?.kind==='stop')stop();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('disconnect',stop);
  process.on('message',message);
  try {
    const identity=profileIdentity(),integration=JSON.parse(fs.readFileSync(path.join(root(),'integration.json')));
    proxy=await startProxy(undefined,{AGENT_CONTEXT_PROXY_PORT:'0',AGENT_CONTEXT_AGENT:agent==='claude'?'claude-code':agent,
      AGENT_CONTEXT_HOST:identity.host,AGENT_CONTEXT_RUNTIME:identity.runtime,AGENT_CONTEXT_LANGFUSE:integration.telemetry?'1':'0',
      AGENT_CONTEXT_LANGFUSE_CONFIG:path.join(home(),'.codex/langfuse.json'),AGENT_CONTEXT_CONTROL_KEY:process.env.AGENT_CONTEXT_FRONT_CONTROL});
    const health=await fetch(proxy.url+'/agent-context/health').then(r=>r.json());
    if(closing||!process.connected) {await proxy.stop();return;}
    process.send({kind:'ready',version,url:proxy.url,health,controlKey:proxy.controlKey});
    await new Promise(resolve=>{if(proxy.child.exitCode!==null)resolve();else proxy.child.once('close',resolve);});
  }finally {
    await proxy?.stop();clearTimeout(deadline);process.off('SIGTERM',stop);process.off('SIGINT',stop);process.off('disconnect',stop);process.off('message',message);if(process.connected)process.disconnect();
  }
}

export async function serveFront(agent,port,{retireMs=15*60000,graceMs=30000,pollMs=1000,start}={}) {
  const owner=crypto.randomUUID(),controlKey=crypto.randomBytes(32).toString('hex');
  start ||= ({controlKey})=>fork(launcher(),['proxy','worker',agent],{stdio:['ignore','ignore','ignore','ipc'],detached:true,windowsHide:true,env:{...process.env,AGENT_CONTEXT_FRONT_CONTROL:controlKey}});
  let active,retiring,staging=false,stopping=false,lastFailure=0,failures=0,rejectedVersion=null;
  const workers=new Set();
  const desired=()=>JSON.parse(fs.readFileSync(path.join(root(),'active.json'))).version;
  const describe=w=>w?{version:w.version,pid:w.child.pid,connections:w.sockets.size,retireAt:w.retireAt||null}:null;
  const front=tcpFront(()=>stopping?null:active);
  const stateFile=path.join(root(),'services',agent+'.json');
  const save=()=>{if(front.listening)atomicSecretWrite(stateFile,JSON.stringify({agent,port,owner,childPid:process.pid,pid:process.pid,controlKey,managementPort:management.address().port,version:active?.version,frontVersion:version}));};
  const stopWorker=(w,forced=false)=>{
    if(w.stopping) return;w.stopping=true;
    if(forced) recordIncident({component:'proxy',operation:'retirement_deadline',category:'process_exit',agent:agent==='claude'?'claude-code':agent});
    if(w.child.connected) w.child.send({kind:'stop'},()=>{});else killTree(w.child,false);
    w.killTimer=setTimeout(()=>{
      if(w.child.exitCode===null&&w.child.signalCode===null) {
        recordIncident({component:'proxy',operation:'retirement_forced',category:'process_exit',agent:agent==='claude'?'claude-code':agent});
        killTree(w.child,true);
      }
    },graceMs);w.killTimer.unref();
  };
  const stage=async()=>{
    if(staging||retiring||workers.size>=2||stopping) return;
    staging=true;
    let child;
    try {child=start({controlKey});} catch {
      staging=false;lastFailure=Date.now();failures++;
      recordIncident({component:'proxy',operation:'worker_spawn',category:'startup_failed',agent:'unknown'});return;
    }
    const w={child,sockets:new Set()};workers.add(w);
    let exited=false;
    const finish=async()=>{
      if(exited)return;exited=true;
      clearTimeout(w.killTimer);
      for(const socket of w.sockets) socket.destroy();
      if(retiring===w) retiring=null;
      if(active===w) {
        if(!stopping&&!w.stopping) recordIncident({component:'proxy',operation:'active_worker_exit',category:'process_exit',agent:agent==='claude'?'claude-code':agent});
        active=!stopping?retiring&&!retiring.stopping?retiring:null:null;
        if(active) {rejectedVersion=w.version;retiring=null;active.retireAt=null;save();}
      }
      if(w.health) try {
        let health;
        // A killed backend can reset an in-flight health read before its port closes.
        for(let attempt=0;attempt<3;attempt++) try {
          health=await fetch(`http://127.0.0.1:${w.port}/agent-context/health`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());break;
        }catch(error) {
          if(error.cause?.code==='ECONNREFUSED'||attempt===2) throw error;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(health.owner!==w.health.owner||health.pid!==w.health.pid) throw new Error('Backend ownership changed');
        {
          recordIncident({component:'proxy',operation:'orphan_backend',category:'process_exit',agent:'unknown'});
          if(process.platform==='win32') execFileSync('taskkill.exe',['/PID',String(health.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:10000});
          else process.kill(-child.pid,'SIGKILL');
        }
      }catch(error) {
        if(error.cause?.code!=='ECONNREFUSED'&&error.code!=='ESRCH') {
          w.cleanupFailed=true;failures++;recordIncident({component:'proxy',operation:'orphan_cleanup_unverified',category:'runtime_integrity',agent:'unknown'});return;
        }
      }
      workers.delete(w);
    };
    const finishSafely=()=>finish().catch(()=>recordIncident({component:'proxy',operation:'worker_cleanup',category:'process_exit',agent:'unknown'}));
    child.once('exit',finishSafely);child.once('error',finishSafely);
    try {
      const message=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Worker readiness timeout')),180000);
        const done=value=>{clearTimeout(timer);resolve(value);};
        child.once('message',done);child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('Worker exited before ready'));});
      });
      const url=new URL(message.url);
      if(message.kind!=='ready'||url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.username||url.password||!/^[0-9]+$/.test(url.port)||!/^\d+\.\d+\.\d+$/.test(message.version)) throw new Error('Invalid worker readiness');
      const health=await fetch(url.origin+'/agent-context/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if(health.owner!==message.health.owner||health.pid!==message.health.pid||health.version!==message.version) throw new Error('Worker identity mismatch');
      Object.assign(w,{port:Number(url.port),version:message.version,health,controlKey:message.controlKey});
      if(stopping) {stopWorker(w);return;}
      if(active) {retiring=active;retiring.retireAt=Date.now()+retireMs;}
      active=w;failures=0;save();
    }catch {
      killTree(child,true);lastFailure=Date.now();failures++;
      recordIncident({component:'proxy',operation:'worker_stage',category:'startup_failed',agent:agent==='claude'?'claude-code':agent});
    }finally {staging=false;}
  };
  const management=http.createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/agent-context/health') {
      let health=active?.health||{},targetVersion,backendHealthy=false;
      const worker=active;
      try {targetVersion=desired();} catch {recordIncident({component:'proxy',operation:'reconcile',category:'configuration_drift',agent:'unknown'});}
      if(worker) try {health=await fetch(`http://127.0.0.1:${worker.port}/agent-context/health`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());backendHealthy=active===worker&&health.owner===worker.health.owner&&health.pid===worker.health.pid;worker.healthFailed=false;} catch {
        if(active===worker&&!worker.stopping&&!worker.healthFailed) recordIncident({component:'proxy',operation:'worker_health',category:'timeout',agent:agent==='claude'?'claude-code':agent});
        worker.healthFailed=true;
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify({...health,owner,pid:process.pid,active:[...workers].reduce((n,w)=>n+w.sockets.size,0),version:active?.version||version,frontVersion:version,front_protocol:1,backendHealthy,targetVersion,activeWorker:describe(active),retiringWorker:describe(retiring),staging,stageFailures:failures,rejectedVersion,workerSlots:workers.size}));return;
    }
    const supplied=Buffer.from(String(req.headers['x-agent-context-control']||'')),expected=Buffer.from(controlKey);
    if(req.method!=='POST'||supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)) {res.writeHead(403);res.end();return;}
    if(req.url!=='/agent-context/shutdown') {res.writeHead(403);res.end();return;}
    if([...workers].some(w=>w.sockets.size)) {res.writeHead(409);res.end();return;}
    stopping=true;res.end('{}');front.close();management.close();for(const w of workers) stopWorker(w);
  });
  await new Promise((resolve,reject)=>{management.once('error',reject);management.listen(0,'127.0.0.1',resolve);});
  await stage();
  if(!active) {management.close();throw new Error('Initial proxy worker failed');}
  try {await new Promise((resolve,reject)=>{front.once('error',reject);front.listen(port,'127.0.0.1',resolve);});}
  catch(error) {stopping=true;management.close();for(const w of workers) killTree(w.child,true);throw error;}
  port=front.address().port;
  save();
  const tick=async()=>{
    if(retiring&&Date.now()>=retiring.retireAt) stopWorker(retiring,retiring.sockets.size>0);
    try {if(!active||active.version!==desired()&&desired()!==rejectedVersion) {
      if(Date.now()-lastFailure>=Math.min(60000,1000*2**Math.min(failures,6))) await stage();
    }}catch {recordIncident({component:'proxy',operation:'reconcile',category:'configuration_drift',agent:'unknown'});}
  };
  const timer=setInterval(()=>tick().catch(()=>recordIncident({component:'proxy',operation:'supervisor',category:'process_exit',agent:'unknown'})),pollMs);
  const stop=()=>{stopping=true;front.close();management.close();for(const w of workers) stopWorker(w);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try {await new Promise(resolve=>front.once('close',resolve));}
  finally {clearInterval(timer);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
