import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serviceHealth, ensureService, servicePort, stopService } from '../src/service.js';
import { root, version } from '../src/core.js';
import { proxyIdentity } from '../src/run.js';
test('Windows redirector requires matching ready and health identity with a live child', () => {
  const ready = { owner: 'owned', pid: 20 }, health = { owner: 'owned', pid: 20 };
  const child = { pid: 10, exitCode: null, signalCode: null };
  assert.equal(proxyIdentity(ready, health, 'owned', child, 'win32'), true);
  assert.equal(proxyIdentity(ready, health, 'owned', child, 'linux'), false);
  assert.equal(proxyIdentity(ready, { ...health, pid: 30 }, 'owned', child, 'win32'), false);
  assert.equal(proxyIdentity(ready, { ...health, owner: 'foreign' }, 'owned', child, 'win32'), false);
  assert.equal(proxyIdentity(ready, health, 'owned', { ...child, exitCode: 0 }, 'win32'), false);
});
test('removal sends shutdown only to the matching owned idle service and waits for its exit', async () => {
  const owner = '12345678-1234-1234-1234-123456789abc';
  const file = path.join(root(), 'services/claude.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ agent: 'claude', port: servicePort('claude'), owner, childPid: 2147483646, pid: 2147483647, controlKey: 'synthetic-control' }));
  const original = globalThis.fetch; let stopped = false;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') { assert.ok(url.endsWith('/agent-context/shutdown')); assert.equal(options.headers['x-agent-context-control'], 'synthetic-control'); stopped = true; return new Response('{}'); }
    if (stopped) throw new Error('fixture listener closed');
    return new Response(JSON.stringify({ owner, pid: 2147483646, active: 0 }));
  };
  try { await stopService('claude'); assert.equal(stopped, true); }
  finally { globalThis.fetch = original; fs.unlinkSync(file); }
});
test('unmatched live process is preserved and in-progress removal blocks new startup', async () => {
  const file = path.join(root(), 'services/hermes.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ agent: 'hermes', port: servicePort('hermes'), owner: '12345678-1234-1234-1234-123456789abc', pid: process.pid, childPid: process.pid }));
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ owner: 'foreign', pid: process.pid }));
  try {
    await assert.rejects(stopService('hermes'), /identity unknown/);
    fs.writeFileSync(path.join(root(), 'uninstalling.json'), '{}');
    await assert.rejects(ensureService('hermes'), /removal in progress/);
  } finally { globalThis.fetch = original; fs.unlinkSync(file); fs.rmSync(path.join(root(), 'uninstalling.json'), { force: true }); }
});
process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-service-'));
test('Windows and WSL listener ports do not overlap', () => {
  const agents = ['codex', 'claude', 'hermes'];
  assert.equal(new Set(agents.flatMap(agent => [servicePort(agent, 'win32'), servicePort(agent, 'linux')])).size, 6);
});
test('owned health requires stored owner and child identity; a busy different version is preserved', async () => {
  const owner = '12345678-1234-1234-1234-123456789abc';
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ owner, pid: 42, active: 1 }));
  try {
    fs.mkdirSync(path.join(root(), 'services'), { recursive: true });
    const file = path.join(root(), 'services/codex.json');
    fs.writeFileSync(file, JSON.stringify({ agent: 'codex', port: servicePort('codex'), owner, childPid: 99, version: '0.1.5' }));
    assert.equal(await serviceHealth('codex'), null);
    fs.writeFileSync(file, JSON.stringify({ agent: 'codex', port: servicePort('codex'), owner, childPid: 42, version: '0.1.5' }));
    const deferred = await ensureService('codex');
    assert.equal(deferred.updateDeferred, true);
    assert.equal(deferred.status, 'update_pending');
    assert.equal(deferred.targetVersion, version);
    fs.writeFileSync(file, JSON.stringify({ agent: 'codex', port: servicePort('codex'), owner, childPid: 42, version }));
    globalThis.fetch = async () => new Response(JSON.stringify({ owner, pid: 42, active: 1, compressor: 'scaledown' }));
    assert.equal((await ensureService('codex')).status, 'update_pending');
    globalThis.fetch = async () => new Response(JSON.stringify({ owner, pid: 42, active: 1, compressor: 'local-tools' }));
    assert.equal((await ensureService('codex')).status, 'ready');
    assert.equal(await serviceHealth('claude'), null);
  } finally { globalThis.fetch = prior; }
});
