import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from '../src/core.js';
import { collectMonitor, monitorTick, queueStats, reportHealth, sendMonitor } from '../src/monitor.js';
import { validateMonitor, monitorExport } from '../src/monitor-protocol.js';
import { createGateway } from '../src/gateway.js';
process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'contextq-monitor-'));
const packet = (at = Date.now()) => ({ schema: 1, id: 'a'.repeat(32), at: new Date(at).toISOString(), host: 'fra', runtime: 'native', version: '0.2.3', services: [{ service: 'contextq', agent: 'codex', state: 'ok', reason: 'proxy_health_not_agent_liveness', metrics: { queue_batches: 2 } }], incidents: [] });
test('monitor refuses raw logs, arbitrary reasons, identity fields and invalid counters', () => {
  for (const edit of [p => p.secret = 'no', p => p.services[0].reason = 'raw_error_text', p => p.services[0].metrics.queue_bytes = -1, p => p.services.push(p.services[0]), p => p.at = new Date(Date.now() + 300000).toISOString()]) {
    const p = packet(); edit(p); assert.throws(() => validateMonitor(p));
  }
});
test('old health stays historical, service identities are separate and repeated incidents are idempotent', () => {
  const p = packet(Date.now() - 3600000);
  p.services.push({ service: 'taskq', agent: 'none', state: 'unknown', reason: 'report_unavailable', metrics: {} });
  p.incidents.push({ fingerprint: 'b'.repeat(24), component: 'telemetry', category: 'delivery_failed', agent: 'codex', occurrences: 3, at: p.at });
  const a = monitorExport(p, { device: 'one', user: 'employee' }), b = monitorExport(p, { device: 'one', user: 'employee' });
  assert.equal(a.scores.length, 0); assert.deepEqual(a, b);
  const spans = a.otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.notEqual(spans[0].traceId, spans[1].traceId);
  assert.equal(spans[2].attributes.find(x => x.key === 'langfuse.observation.level').value.stringValue, 'ERROR');
});
test('failed delivery survives restart and fresh unknown state has no healthy score', async () => {
  fs.mkdirSync(root(), { recursive: true });
  const report = await monitorTick({ force: true, collect: async () => packet(), config: {}, send: async () => false });
  assert.equal(report.status, 'queued'); assert.equal(report.queue_batches, 1);
  const next = await monitorTick({ force: true, collect: async () => ({ ...packet(), id: 'c'.repeat(32) }), config: {}, send: async () => true });
  assert.equal(next.delivered, 2); assert.equal(next.queue_batches, 0);
  assert.equal((await monitorTick({ collect: async () => { throw new Error('not due'); } })).status, 'not_due');
  const p = packet(); p.services[0].state = 'unknown'; p.services[0].metrics = {};
  assert.equal(monitorExport(p).scores.length, 0);
});
test('serverq unknown/manual rules and stale reports cannot become green', async () => {
  const file = path.join(process.env.AGENT_CONTEXT_HOME, 'serverq.json');
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() / 1000, results: { disk: { status: 'ok' }, service: { status: 'unknown' } }, manual_rules: ['not_checked'] }));
  assert.equal(reportHealth(file, 7200, 'serverq').state, 'unknown');
  fs.writeFileSync(file, JSON.stringify({ at: 1, results: { disk: { status: 'ok' } } }));
  assert.equal(reportHealth(file, 7200, 'serverq').state, 'unknown');
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'] }));
  const p = await collectMonitor({ health: async () => ({ active: 2, telemetry: true, controlKey: 'must-not-export', compression: { supercompress_outcomes: { compressed: 3, timeout: 1, no_gain: 2 } } }) });
  assert.equal(JSON.stringify(p).includes('must-not-export'), false);
  assert.equal(p.services[0].metrics.passthrough, 3); assert.equal(p.services[0].metrics.compression_failed, 1);
  assert.equal(p.services.find(x => x.service === 'taskq').state, 'unknown');
});
test('partial OTLP rejection retains the packet instead of sending scores', async () => {
  let calls = 0;
  assert.equal(await sendMonitor(packet(), { base_url: 'https://lf.invalid', public_key: 'synthetic', secret_key: 'synthetic' }, async () => { calls++; return Response.json({ partialSuccess: { rejectedSpans: 1 } }); }), false);
  assert.equal(calls, 1);
});
test('gateway binds monitoring to authenticated device, persists failures and later flushes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gateway-'));
  const config = { organization: 'org', clientId: 'client', stateDir: dir, langfuse: { public_key: 'pk-lf-' + 'p'.repeat(20), secret_key: 'sk-lf-' + 's'.repeat(20), base_url: 'https://lf.invalid' }, supercompressKey: 'sc_' + 'c'.repeat(30) };
  let offline = true; const exported = [];
  const request = async (url, options) => {
    if (url.endsWith('/user')) return Response.json({ login: 'employee' });
    if (url.includes('/memberships/')) return Response.json({ state: 'active' });
    if (offline) throw new Error('offline');
    exported.push(JSON.parse(options.body)); return Response.json({});
  };
  const gateway = createGateway(config, { request });
  const call = (route, body, auth) => gateway.handle(new Request('https://gw.invalid' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) }));
  const device = await (await call('/v1/enroll', {}, 'Bearer github')).json();
  assert.equal((await call('/v1/monitor', packet(), '')).status, 401);
  assert.equal((await call('/v1/monitor', { ...packet(), user: 'other' }, 'Bearer ' + device.token)).status, 400);
  const snapshot = packet();
  assert.equal((await call('/v1/monitor', snapshot, 'Bearer ' + device.token)).status, 200);
  assert.equal((await call('/v1/monitor', snapshot, 'Bearer ' + device.token)).status, 200);
  const queue = path.join(dir, 'monitor-outbox'); assert.equal(queueStats(queue).queue_batches, 1);
  await gateway.flushMonitor(); assert.equal(queueStats(queue).queue_batches, 1);
  offline = false; await gateway.flushMonitor(); assert.equal(queueStats(queue).queue_batches, 0);
  assert.ok(exported.length > 1);
  assert.equal(JSON.stringify(exported).includes(device.token), false);
  assert.ok(JSON.stringify(exported).includes('user:employee'));
});

test('full queue still drains; expired head cannot block fresh snapshots', async () => {
  const directory = path.join(root(), 'monitor-outbox');
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 1000; i++) {
    const id = i.toString(16).padStart(32, '0');
    fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ ...packet(), id }));
  }
  const full = await monitorTick({ force: true, collect: async () => { throw new Error('must not collect into full queue'); }, config: {}, send: async () => true });
  assert.equal(full.delivered, 8); assert.equal(full.queue_batches, 992);
  fs.rmSync(directory, { recursive: true }); fs.mkdirSync(directory);
  const expired = path.join(directory, '0'.repeat(32) + '.json');
  fs.writeFileSync(expired, JSON.stringify(packet(Date.now() - 8 * 86400000)));
  fs.utimesSync(expired, 1, 1);
  let sent = 0;
  const result = await monitorTick({ force: true, collect: async () => packet(), config: { gateway: true }, send: async p => { validateMonitor(p); sent++; return true; } });
  assert.equal(sent, 1); assert.equal(result.status, 'accepted_by_gateway'); assert.equal(result.queue_batches, 0);
});
