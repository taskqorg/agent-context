import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from '../src/core.js';
import { collectMonitor, headroomStats, monitorTick, queueStats, reportHealth, sendMonitor } from '../src/monitor.js';
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
  assert.equal(await sendMonitor(packet(), { base_url: 'https://lf.invalid', public_key: 'synthetic', secret_key: 'synthetic' }, async (url, options) => { assert.equal(options.headers['x-langfuse-ingestion-version'],'4'); calls++; return Response.json({ partialSuccess: { rejectedSpans: 1 } }); }), false);
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
  snapshot.services[0].metrics.codex_ws_frames_attempted_total = 5;
  assert.equal((await call('/v1/monitor', snapshot, 'Bearer ' + device.token)).status, 200);
  assert.equal((await call('/v1/monitor', snapshot, 'Bearer ' + device.token)).status, 200);
  const queue = path.join(dir, 'monitor-outbox'); assert.equal(queueStats(queue).queue_batches, 1);
  await gateway.flushMonitor(); assert.equal(queueStats(queue).queue_batches, 1);
  offline = false; await gateway.flushMonitor(); assert.equal(queueStats(queue).queue_batches, 0);
  assert.ok(exported.length > 1);
  assert.equal(JSON.stringify(exported).includes(device.token), false);
  assert.ok(JSON.stringify(exported).includes('user:employee'));
  assert.ok(JSON.stringify(exported).includes('codex_ws_frames_attempted_total'));
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

test('local-only health accepts disabled optional telemetry and counts structural compression', async () => {
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'], telemetry: false }));
  const packet = await collectMonitor({ health: async () => ({ active: 0, telemetry: false, compression: {
    outcomes: { compressed: 2, fallback: 1 }, tool_context: { compressed: 7, passthrough: 4, input_chars: 5000, output_chars: 2000 },
  } }) });
  const service = packet.services.find(s => s.service === 'contextq');
  assert.equal(service.state, 'ok');
  assert.equal(service.metrics.compressed, 7);
  assert.equal(service.metrics.compression_failed, 1);
});


test('telemetry-enabled monitor exposes exporter gaps and router latency without claiming agent liveness', async () => {
  const now = Date.now();
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'], telemetry: true }));
  const snapshot = await collectMonitor({ now, health: async () => ({ telemetry: true, compression: {
    outcomes: { passthrough: 2 }, latency: { calls: 2, total_ms: 20, max_ms: 15 }, last_attempt_at: now / 1000 - 30,
  } }) });
  const service = snapshot.services.find(s => s.service === 'contextq');
  assert.equal(service.reason, 'native_exporter_missing');
  assert.equal(service.state, 'warning');
  assert.equal(service.metrics.compression_failed, 0);
  assert.equal(service.metrics.compression_calls, 2);
  assert.equal(service.metrics.compression_total_ms, 20);
  assert.equal(service.metrics.compression_max_ms, 15);
  assert.equal(service.metrics.last_compression_age_seconds, 30);
  const exported = monitorExport(snapshot);
  assert.ok(exported.scores.every(s => s.name.endsWith('.health')));
  assert.equal(exported.otlp.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(a => a.key === 'agent_context.monitor.compression_max_ms').value.doubleValue, 15);
});

const wsStats = () => ({ frames_attempted_total: 5, frames_compressed_total: 1, frames_failed_total: 0, frame_bytes_before_sum: 12000, frame_bytes_after_sum: 9000, frame_tokens_saved_sum: 800, frame_elapsed_ms: { average: 100, max: 500 } });
test('native stats exports only allowlisted aggregates; absent and invalid measurements never become zero', async () => {
  const state = { port: 12345 };
  const request = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/stats'); assert.equal(options.redirect, 'error');
    return Response.json({ codex_ws: { ...wsStats(), secret: 'PRIVATE' }, config: { key: 'PRIVATE' }, recent_requests: ['PRIVATE'] });
  };
  const metrics = await headroomStats(state, request);
  assert.equal(metrics.codex_ws_frames_attempted_total, 5);
  assert.equal(metrics.codex_ws_frames_failed_total, 0);
  assert.equal(metrics.codex_ws_frame_elapsed_max_ms, 500);
  assert.equal(JSON.stringify(metrics).includes('PRIVATE'), false);
  for (const fetcher of [async () => new Response('', { status: 503 }), async () => { throw new Error('timeout'); }, async () => Response.json({}), ...[-1, '5', null, Number.MAX_SAFE_INTEGER + 1].map(value => async () => Response.json({ codex_ws: { ...wsStats(), frames_attempted_total: value } }))]) {
    assert.equal(await headroomStats(state, fetcher), null);
  }
  assert.equal(await headroomStats({ port: 'https://external.invalid' }, () => { throw new Error('must not fetch'); }), null);
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'], telemetry: false }));
  const health = async () => ({ ...state, active: 0, compressor: 'headroom-local' });
  const packet = await collectMonitor({ health, stats: s => headroomStats(s, request) });
  assert.equal(packet.services[0].metrics.codex_ws_frames_attempted_total, 5);
  assert.ok(monitorExport(packet).scores.every(s => s.name.endsWith('.health')));
  const missing = await collectMonitor({ health, stats: async () => null });
  assert.equal(missing.services[0].reason, 'native_stats_unavailable');
  assert.equal(missing.services[0].state, 'warning');
  assert.equal(missing.services[0].metrics.codex_ws_frames_attempted_total, undefined);
  await collectMonitor({ health: async () => ({ active: 0 }), stats: async () => { throw new Error('legacy proxy must not use new endpoint'); } });
});
