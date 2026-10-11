import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, home, atomicWrite, version } from './core.js';
import { launcher } from './update.js';
import { startProxy } from './run.js';
import { recordIncident } from './incidents.js';

export const servicePort = (agent, platform = process.platform) => {
  const port = ({ codex: 18787, claude: 18788, hermes: 18790 })[agent];
  // Windows and WSL can share loopback forwarding; keep their listeners distinct.
  return port && port + (platform === 'win32' ? 100 : 0);
};
const stateFile = agent => path.join(root(), 'services', agent + '.json');
export async function serviceHealth(agent) {
  const port = servicePort(agent);
  if (!port) throw new Error('Choose codex, claude or hermes');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(agent), 'utf8'));
    if (state.agent !== agent || state.port !== port || !/^[a-f0-9-]{36}$/.test(state.owner)) return null;
    const result = await fetch(`http://127.0.0.1:${port}/agent-context/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
    return result.owner === state.owner && result.pid === state.childPid ? { ...state, ...result } : null;
  } catch { return null; }
}
export async function ensureService(agent) {
  if (!servicePort(agent)) throw new Error('Choose codex, claude or hermes');
  if (fs.existsSync(path.join(root(), 'uninstalling.json'))) throw new Error('Uninstall refused: removal in progress');
  const healthy = await serviceHealth(agent);
  if (healthy && (healthy.version === version || healthy.active)) return { status: 'ready', url: `http://127.0.0.1:${healthy.port}`, version: healthy.version, updateDeferred: healthy.version !== version };
  fs.mkdirSync(path.dirname(stateFile(agent)), { recursive: true, mode: 0o700 });
  const lock = stateFile(agent) + '.lock';
  let acquired = false;
  try {
    try { fs.mkdirSync(lock); acquired = true; } catch { /* Another startup owns this lock; observe only. */ }
    if (acquired) {
      if (healthy) {
        const stopped = await fetch(`http://127.0.0.1:${healthy.port}/agent-context/shutdown`, { method: 'POST', headers: { 'x-agent-context-control': healthy.controlKey }, signal: AbortSignal.timeout(2000) });
        if (!stopped.ok) throw new Error('Proxy update deferred; active service preserved');
        for (let i = 0; i < 50 && await serviceHealth(agent); i++) await new Promise(resolve => setTimeout(resolve, 100));
        if (await serviceHealth(agent)) throw new Error('Proxy update deferred; service still running');
      }
      if (fs.existsSync(path.join(root(), 'uninstalling.json'))) throw new Error('Uninstall refused: removal in progress');
      const child = spawn(process.execPath, [launcher(), 'proxy', 'serve', agent], { env: process.env, stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => {}); child.unref();
    }
    for (let i = 0; i < 150; i++) {
      const state = await serviceHealth(agent);
      if (state) return { status: 'ready', url: `http://127.0.0.1:${state.port}`, version: state.version };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    recordIncident({ component: 'proxy', operation: 'ensure', category: 'startup_failed', agent: agent === 'claude' ? 'claude-code' : agent });
    throw new Error('Proxy startup failed; inspect doctor');
  } finally { if (acquired) fs.rmdirSync(lock); }
}
export async function stopService(agent) {
  if (!fs.existsSync(stateFile(agent))) return;
  const state = await serviceHealth(agent);
  if (!state) {
    const saved = JSON.parse(fs.readFileSync(stateFile(agent), 'utf8'));
    for (const pid of [saved.pid, saved.childPid]) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Uninstall refused: invalid service identity');
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      throw new Error('Uninstall refused: service identity unknown; inspect doctor');
    }
    return;
  }
  if (state.active) throw new Error(`Uninstall refused: busy ${agent} service; close its active agent sessions first`);
  const response = await fetch(`http://127.0.0.1:${state.port}/agent-context/shutdown`, { method: 'POST', headers: { 'x-agent-context-control': state.controlKey }, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Uninstall refused: service did not acknowledge shutdown');
  for (let i = 0; i < 50; i++) {
    let running = false;
    for (const pid of [state.pid, state.childPid]) {
      try { process.kill(pid, 0); running = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!running && !await serviceHealth(agent)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Uninstall refused: service still running');
}
export async function serveService(agent) {
  const port = servicePort(agent);
  if (!port) throw new Error('Choose codex, claude or hermes');
  if (fs.existsSync(path.join(root(), 'uninstalling.json'))) throw new Error('Uninstall refused: removal in progress');
  let proxy, stopping = false;
  const stop = () => { stopping = true; proxy?.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
      try {
        let telemetry = false;
        try { telemetry = JSON.parse(fs.readFileSync(path.join(root(), 'integration.json'))).telemetry; } catch {}
        proxy = await startProxy(undefined, { AGENT_CONTEXT_PROXY_PORT: String(port), AGENT_CONTEXT_AGENT: agent === 'claude' ? 'claude-code' : agent,
          AGENT_CONTEXT_LANGFUSE: telemetry ? '1' : '0', AGENT_CONTEXT_STAGE: process.env.AGENT_CONTEXT_STAGE || 'production',
          AGENT_CONTEXT_LANGFUSE_CONFIG: path.join(home(), '.codex', 'langfuse.json') });
        const ready = JSON.parse(fs.readFileSync(path.join(proxy.dir, 'ready.json'), 'utf8'));
        atomicWrite(stateFile(agent), JSON.stringify({ agent, port, owner: ready.owner, childPid: ready.pid, controlKey: proxy.controlKey, pid: process.pid, version, recipe: proxy.runtime.recipe }));
        const code = await new Promise(resolve => proxy.child.once('close', resolve));
        if (stopping || code === 0) break;
        recordIncident({ component: 'proxy', operation: 'serve', category: 'process_exit', agent: agent === 'claude' ? 'claude-code' : agent });
      } catch {
        recordIncident({ component: 'proxy', operation: 'serve', category: 'startup_failed', agent: agent === 'claude' ? 'claude-code' : agent });
      } finally { await proxy?.stop(); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
export async function lifecycle(agent, env = process.env) {
  const result = await ensureService(agent);
  // Delivery is bounded and detached from the user's model request.
  const child = spawn(process.execPath, [launcher(), 'incidents', 'report'], { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {}); child.unref();
  // Launchers such as Claude Desktop set their own ANTHROPIC_BASE_URL over settings.json env; that session bypasses the proxy.
  return proxyBypassed(agent, result.url, env) ? { ...result, bypassed: true } : result;
}
export const proxyBypassed = (agent, url, env = process.env) => agent === 'claude' && env.ANTHROPIC_BASE_URL !== url;
