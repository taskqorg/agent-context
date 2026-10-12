import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {root} from './core.js';
import {launcher} from './update.js';
import {ensureService} from './service.js';
import {recordIncident} from './incidents.js';

export async function reconcileServices({ensure=ensureService}={}) {
  if(fs.existsSync(path.join(root(),'uninstalling.json'))) return;
  let agents;
  try {agents=JSON.parse(fs.readFileSync(path.join(root(),'integration.json'))).agents;} catch {return;}
  for(const agent of new Set(agents||[])) {
    if(!['codex','claude','hermes'].includes(agent)) continue;
    try {await ensure(agent);} catch {
      recordIncident({component:'proxy',operation:'reconcile',category:'startup_failed',agent:agent==='claude'?'claude-code':agent});
    }
  }
}

export async function superviseMonitor({signal, start=()=>spawn(process.execPath,[launcher(),'monitor','worker'],{stdio:'inherit',windowsHide:true}), wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let failures=0;
  while(!signal.aborted&&fs.existsSync(root())&&!fs.existsSync(path.join(root(),'uninstalling.json'))) {
    const began=Date.now();
    const child=start();
    const stop=()=>child.kill();
    signal.addEventListener('abort',stop,{once:true});
    const code=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('exit',n=>resolve(n));});
    signal.removeEventListener('abort',stop);
    if(signal.aborted) break;
    if(code===75) {failures=0;continue;}
    recordIncident({component:'core',operation:'monitor_worker',category:'process_exit',agent:'unknown'});
    failures=Date.now()-began>60000?1:failures+1;
    await wait(Math.min(60000,1000*2**Math.min(failures-1,6)));
  }
}
