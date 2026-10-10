import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareHeadroom } from './headroom.js';
import { root } from './core.js';
import { agentExecutable } from './executable.js';

const source = fileURLToPath(new URL('../', import.meta.url));
export function proxyIdentity(ready, health, owner, child, platform = process.platform) {
  return ready.owner === owner && health.owner === owner && Number.isInteger(ready.pid) && ready.pid > 0 && health.pid === ready.pid
    && child.exitCode === null && child.signalCode === null && (platform === 'win32' || ready.pid === child.pid);
}
export async function runAgent(agent, args) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Usage: agent-context run codex|claude [agent arguments]');
  const proxy = await startProxy(undefined, { AGENT_CONTEXT_AGENT: agent === 'claude' ? 'claude-code' : agent });
  const env = { ...process.env };
  const recovery = { command: proxy.runtime.headroom, args: ['mcp', 'serve', '--proxy-url', proxy.url], env: { HEADROOM_STATELESS: 'true', HEADROOM_OFFLINE: '1' } };
  const agentArgs = agent === 'codex' ? [
    '-c', 'model_provider="agent_context"',
    '-c', 'model_providers.agent_context.name="Agent Context"',
    '-c', `model_providers.agent_context.base_url="${proxy.url}/v1"`,
    '-c', 'model_providers.agent_context.wire_api="responses"',
    '-c', 'model_providers.agent_context.requires_openai_auth=true',
    '-c', 'model_providers.agent_context.supports_websockets=true',
    '-c', 'mcp_servers.supercompress.enabled=false',
    '-c', `mcp_servers.headroom.command=${JSON.stringify(recovery.command)}`,
    '-c', `mcp_servers.headroom.args=${JSON.stringify(recovery.args)}`,
    '-c', 'mcp_servers.headroom.enabled_tools=["headroom_retrieve"]',
    '-c', 'mcp_servers.headroom.env.HEADROOM_STATELESS="true"',
    '-c', 'mcp_servers.headroom.env.HEADROOM_OFFLINE="1"', ...args,
  ] : args;
  if (agent === 'claude') {
    env.ANTHROPIC_BASE_URL = proxy.url;
    const file = path.join(proxy.dir, 'retrieval.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { headroom: recovery } }), { mode: 0o600 });
    agentArgs.unshift('--mcp-config', file);
  }
  const executable = agentExecutable(agent);
  let child;
  const forward = signal => child?.kill(signal);
  try {
    return await new Promise((resolve, reject) => {
      child = spawn(executable.command, [...executable.args, ...agentArgs], { env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
      process.on('SIGINT', forward); process.on('SIGTERM', forward);
    });
  } finally {
    process.off('SIGINT', forward); process.off('SIGTERM', forward);
    await proxy.stop();
  }
}

export async function startProxy(runtime, environment = {}) {
  runtime ||= await prepareHeadroom();
  const cache = path.join(root(), 'proxies');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(cache, 'proxy-'));
  const ready = path.join(dir, 'ready.json');
  const owner = crypto.randomUUID();
  const controlKey = crypto.randomUUID();
  const log = fs.openSync(path.join(dir, 'proxy.log'), 'a', 0o600);
  const child = spawn(runtime.python, ['-m', 'agent_context_headroom.proxy'], {
    env: { ...process.env, AGENT_CONTEXT_PROXY_PORT: '0', ...environment, AGENT_CONTEXT_NODE: process.execPath, AGENT_CONTEXT_BRIDGE: path.join(source, 'bin/headroom-compress.js'), AGENT_CONTEXT_READY_FILE: ready, AGENT_CONTEXT_PROXY_OWNER: owner, AGENT_CONTEXT_CONTROL_KEY: controlKey },
    windowsHide: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let failure, closed = false;
  child.on('close', () => { closed = true; });
  child.on('error', error => { failure = error; });
  let ownedUrl;
  const stop = async () => {
    if (closed || failure || child.exitCode !== null || child.signalCode !== null) return;
    if (ownedUrl) {
      try {
        const response = await fetch(`${ownedUrl}/agent-context/shutdown`, { method: 'POST', headers: { 'x-agent-context-control': controlKey }, signal: AbortSignal.timeout(2000) });
        if (response.status === 409) return;
        if (response.ok) for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 100));
      } catch {}
    }
    if (closed) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null) throw new Error('Headroom proxy startup failed');
      if (fs.existsSync(ready)) {
        const value = JSON.parse(fs.readFileSync(ready, 'utf8'));
        if (value.owner !== owner || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Headroom proxy identity mismatch');
        const url = `http://127.0.0.1:${value.port}`;
        try {
          const health = await fetch(`${url}/agent-context/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
          if (proxyIdentity(value, health, owner, child)) {
            ownedUrl = url;
            return { child, url, runtime, dir, stop, controlKey };
          }
        } catch { /* Wait only for this owned process to bind its socket. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Headroom proxy startup timeout');
  } catch (error) { await stop(); throw error; }
}
