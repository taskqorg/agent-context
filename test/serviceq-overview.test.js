import test from 'node:test';
import assert from 'node:assert/strict';
import { overview } from '../src/serviceq-overview.js';
const now = Date.parse('2026-10-11T13:30:00Z');
function row({ at = now - 60000, name = 'service.health.contextq.codex', host = 'windows', runtime = 'native', device = 'one', service = 'contextq', state = 'ok', agent = 'codex', reason = 'proxy_health_not_agent_liveness', metadata = {}, level = 'DEFAULT' } = {}) {
  return { id: 'span', traceId: 'abcdef1234567890', startTime: new Date(at).toISOString(), name, statusMessage: reason, level, tags: [`host:${host}`, `runtime:${runtime}`, `device:${device}`, `service:${service}`, `state:${state}`, `agent:${agent}`], metadata };
}
const meta = object => Object.fromEntries(Object.entries(object).map(([key, value]) => ['attributes.agent_context.' + key, value]));
test('overview uses latest device identity and snapshot, never old WSL labels or older installed agents', () => {
  const result = overview({ health: [row({ at: now - 500000 }), row({ runtime: 'wsl', at: now - 60000 }), row({ agent: 'hermes', at: now - 500000 })] }, now);
  assert.equal(result.hosts.find(h => h.id === 'windows/native').services.length, 0);
  const wsl = result.hosts.find(h => h.id === 'windows/wsl');
  assert.equal(wsl.fresh, true); assert.equal(wsl.agents.length, 1); assert.equal(wsl.agents[0].name, 'Codex');
});
test('absence and stale healthy samples remain unknown; missing reports are gaps, not errors', () => {
  const result = overview({ health: [row({ host: 'mac', at: now - 700000 }), row({ device: 'two', service: 'taskq', state: 'unknown', reason: 'report_unavailable' })] }, now);
  assert.equal(result.hosts.find(h => h.id === 'mac/native').fresh, false);
  assert.equal(result.hosts.find(h => h.id === 'mac/native').services[0].state, 'unknown');
  assert.equal(result.issues.length, 0);
  assert.ok(result.gaps.some(g => g.detail.includes('Подключить источник')));
});
test('compression skips and failures are disjoint; missing outcome never becomes a false error; no private metadata escapes', () => {
  const result = overview({ compression: [
    row({ metadata: meta({ 'compression.outcome': 'compressed', 'compression.input_chars': 100, 'compression.output_chars': 50 }) }),
    row({ metadata: meta({ 'compression.outcome': 'ineligible', 'compression.input_chars': 40, 'compression.output_chars': 40 }) }),
    row({ level: 'ERROR', reason: 'SECRET', metadata: { ...meta({ 'compression.outcome': 'timeout' }), private_key: 'SECRET' } }),
    row({ metadata: {} })
  ] }, now);
  const c = result.hosts.find(h => h.id === 'windows/native').agents[0].compression;
  assert.equal(c.compressed, 1); assert.equal(c.passthrough, 1); assert.equal(c.failed, 1); assert.equal(c.sizeSamples, 2);
  assert.equal(result.unattributed, 1); assert.equal(result.issues.length, 1);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('model activity needs explicit host and agent, counts sessions, and history is not a current issue', () => {
  const a = row(); a.sessionId = 'same';
  const b = row(); b.sessionId = 'same';
  const result = overview({ activity: [a, b, { startTime: a.startTime, tags: [] }], incidents: [row({ reason: 'http_503', metadata: meta({ 'incident.occurrences': 4 }) })] }, now);
  const activity = result.hosts.find(h => h.id === 'windows/native').agents[0].activity;
  assert.equal(activity.calls, 2); assert.equal(activity.sessions, 1);
  assert.equal(result.incidents[0].title, 'Ответ сервиса 503'); assert.equal(result.issues.length, 0);
  assert.equal(result.unattributed, 1);
});
test('synthetic root observations and replayed incident IDs do not inflate counts', () => {
  const incident = row({ reason: 'timeout' });
  const result = overview({ incidents: [incident, { ...incident }, { ...incident, id: 't-root' }], compression: [row({ id: 'unused', metadata: meta({ 'compression.outcome': 'compressed' }) }), { ...row(), id: 't-root', metadata: meta({ 'compression.outcome': 'compressed' }) }] }, now);
  assert.equal(result.incidents.length, 1);
  assert.equal(result.hosts.find(h => h.id === 'windows/native').agents[0].compression.compressed, 1);
});
test('overview distinguishes selected package, monitor and old proxy, and sanitizes updater status', () => {
  const result = overview({ health: [row({ service: 'updater', agent: 'none', reason: 'release_subscription_connected', metadata: meta({ 'update.installed': '0.2.6', 'update.available': '0.2.7', 'update.monitor': '0.2.6', 'update.status': 'downloaded', 'update.subscription': 'connected', 'update.enabled': 'true', 'update.reason': 'SECRET' }) }), row({ metadata: meta({ 'proxy.version': '0.1.20' }) })] }, now);
  const h = result.hosts.find(h => h.id === 'windows/native');
  assert.equal(h.update.installed, '0.2.6'); assert.equal(h.update.status, 'downloaded');
  assert.equal(h.services.find(s => s.service === 'contextq').proxyVersion, '0.1.20');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
test('Langfuse boolean updater flags and legacy strings agree; absent flags remain unknown', () => {
  for (const [flag, expected] of [[true, true], ['true', true], [false, false], ['false', false], [undefined, null]]) {
    const result = overview({ health: [row({ service: 'updater', agent: 'none', metadata: meta({ 'update.enabled': flag }) })] }, now);
    assert.equal(result.hosts.find(h => h.id === 'windows/native').update.enabled, expected);
  }
});
