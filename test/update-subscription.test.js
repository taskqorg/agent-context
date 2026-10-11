import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseNotifications } from '../src/release-notifications.js';
import { subscribeUpdates, updateSummary } from '../src/update-subscription.js';
import { monitorExport, validateMonitor } from '../src/monitor-protocol.js';

process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'contextq-subscription-'));
const root = path.join(process.env.AGENT_CONTEXT_HOME, '.agent-context'); fs.mkdirSync(root);
test('long poll wakes on a verified release, coalesces checks and removes aborted listeners', async () => {
  let next = '0.2.6', now = 0, calls = 0;
  const feed = releaseNotifications({ check: async () => { calls++; return next; }, now: () => now, waitMs: 100 });
  assert.deepEqual(await (await feed.watch(null)).json(), { version: next });
  const pending = feed.watch(next); next = '0.2.7'; now = 11000;
  await Promise.all([feed.refresh(), feed.refresh()]);
  assert.deepEqual(await (await pending).json(), { version: next }); assert.equal(calls, 2);
  const controller = new AbortController(); const stopped = feed.watch(next, controller.signal);
  controller.abort(); await stopped;
  now += 11000; next = '0.2.8'; await feed.refresh();
});
test('failed signature/source checks never publish a new notification', async () => {
  let invalid = false, now = 0;
  const feed = releaseNotifications({ check: async () => { if (invalid) throw new Error('signature'); return '0.2.6'; }, now: () => now, waitMs: 1 });
  assert.equal((await (await feed.watch(null)).json()).version, '0.2.6');
  invalid = true; now += 11000; await feed.refresh();
  assert.equal((await (await feed.watch(null)).json()).version, '0.2.6');
});
test('notification triggers the secure updater; disconnected subscription still checks automatically and respects disable', async () => {
  for (const scenario of ['new', 'offline', 'invalid', 'disabled']) {
    const controller = new AbortController(), applied = [];
    await subscribeUpdates({ signal: controller.signal, gateway: 'https://gateway.invalid', status: () => ({ managed: true, enabled: scenario !== 'disabled' }),
      apply: async options => { applied.push(options); },
      request: async () => scenario === 'offline' ? new Response('', { status: 503 }) : Response.json({ version: scenario === 'invalid' ? 'https://evil.invalid/code' : '0.2.6' }),
      wait: async () => controller.abort()
    });
    assert.equal(applied.length, scenario === 'new' ? 2 : scenario === 'disabled' ? 0 : 1);
    if (scenario === 'new') assert.deepEqual(applied[1], { automatic: true, notifiedVersion: '0.2.6' });
  }
});
test('update telemetry accepts only allowlisted metadata and exports versions without reasons or secrets', () => {
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ version: '0.2.6', dir: root }));
  fs.writeFileSync(path.join(root, 'updates.json'), JSON.stringify({ enabled: true, status: 'failed', reason: 'PRIVATE', availableVersion: '0.2.7', lastAttempt: 1234 }));
  const updater = updateSummary(); assert.equal(JSON.stringify(updater).includes('PRIVATE'), false);
  const packet = { schema: 1, id: 'a'.repeat(32), at: new Date().toISOString(), host: 'mac', runtime: 'native', version: '0.2.6', updater, services: [{ service: 'updater', agent: 'none', state: 'error', reason: 'update_failed', metrics: {} }], incidents: [] };
  const exported = monitorExport(packet); assert.equal(JSON.stringify(exported).includes('PRIVATE'), false);
  assert.ok(JSON.stringify(exported).includes('agent_context.update.installed'));
  assert.throws(() => validateMonitor({ ...packet, updater: { ...updater, secret: 'PRIVATE' } }));
});
