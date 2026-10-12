import test from 'node:test';
import assert from 'node:assert/strict';
import { overview,nativeExportExplanation,reportFilters } from '../src/serviceq-overview.js';
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

test('R9 RTK estimates stay separate, replay uses event/device identity and command exit is not compression failure', () => {
  const native = (id, extra = {}) => ({ ...row({ name: 'agent-context.native-tool', metadata: meta({ 'compression.id': '11111111-1111-4111-8111-111111111111', 'compression.strategy': 'rtk-native', 'compression.token_source': 'rtk_estimate', 'compression.input_tokens': 100, 'compression.output_tokens': 10, 'compression.exit_code': 7, ...extra }) }), id, sessionId: 'native-session' });
  const result = overview({ nativeTools: [native('first'), native('replay'), { ...native('root'), id: 't-root' }, native('second', { 'compression.id': '22222222-2222-4222-8222-222222222222', 'compression.output_tokens': 150, 'compression.origin': 'qualification', tool_call_id: 'call-2' })], compression: [row({ metadata: meta({ 'compression.outcome': 'compressed', 'compression.input_chars': 1000, 'compression.output_chars': 500 }) })] }, now);
  const a = result.hosts.find(h => h.id === 'windows/native').agents[0];
  assert.equal(a.compression.input, 1000);
  assert.deepEqual([a.nativeRtk.calls, a.nativeRtk.samples, a.nativeRtk.input, a.nativeRtk.output], [2, 2, 200, 160]);
  assert.deepEqual([a.nativeRtk.reduced, a.nativeRtk.expanded, a.nativeRtk.nonzeroExits], [1, 1, 2]);
  assert.deepEqual([a.nativeRtk.sessionLinks, a.nativeRtk.callLinks, a.nativeRtk.stableIds], [2, 1, 2]);
  assert.deepEqual(a.nativeRtk.origins, { production: 0, qualification: 1, unknown: 1 });
  assert.equal(a.nativeRtk.timeBasis, 'delivery'); assert.equal(a.nativeRtk.includesWrapperOverhead, false);
  assert.equal(result.issues.length, 0); assert.ok(result.gaps.some(g => g.title.includes('RTK')));
});

test('R9 missing native sizes, unknown units and private metadata never become zero measurements or production', () => {
  const sample = row({ name: 'agent-context.native-tool', metadata: { ...meta({ 'compression.input_tokens': 80, 'compression.output_tokens': 4, 'compression.origin': 'SECRET', 'compression.strategy': 'rtk-native', 'compression.token_source': 'future' }), raw_command: 'SECRET' } });
  const result = overview({ nativeTools: [sample, { ...sample, id: 'different-span', metadata: {} }, { ...sample, startTime: 'invalid' }] }, now);
  const r = result.hosts.find(h => h.id === 'windows/native').agents[0].nativeRtk;
  assert.equal(r.calls, 2); assert.equal(r.samples, 0); assert.equal(r.input, null); assert.equal(r.output, null);
  assert.equal(r.unknown, 2); assert.equal(r.exitSamples, 0); assert.equal(r.origins.unknown, 2);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(overview({}, now).hosts[0].agents.length, 0);
});

test('R9 host/agent/session filters share the report reader without inventing links', () => {
  const params = new URLSearchParams('period=86400&host=windows/native&agent=codex&session=wanted');
  const filters = reportFilters(params), a = { ...row(), sessionId: 'wanted' }, b = { ...row(), sessionId: 'other' };
  const result = overview({ activity: [a, b, row({ host: 'mac' })], nativeTools: [row()] }, now, 86400, filters);
  assert.equal(result.hosts.length, 1); assert.equal(result.hosts[0].agents[0].activity.calls, 1);
  assert.equal(result.hosts[0].agents[0].nativeRtk, null); assert.deepEqual(result.filters, filters);
  for (const query of ['host=bad', 'agent=future', 'session=%3Cscript%3E', 'raw=SECRET']) assert.throws(() => reportFilters(new URLSearchParams(query)), /Invalid report filter/);
});

test('R9 model usage preserves overlapping units, partial samples and missing reported cost without private IO', () => {
  const a = { ...row(), model: 'model-one', usageDetails: { input: 100, input_cached_tokens: 80, output: 10, output_reasoning_tokens: 4, raw: 'SECRET' }, costDetails: { total: 0.02 }, input: 'SECRET', output: 'SECRET' };
  const b = { ...row(), model: 'model-one', usageDetails: { output: 0 } };
  const result = overview({ activity: [a, b, { ...row(), model: '__proto__' }] }, now);
  const m = result.hosts.find(h => h.id === 'windows/native').agents[0].activity.models;
  assert.deepEqual(m['model-one'].usage, { input: 100, output: 10, input_cached_tokens: 80, output_reasoning_tokens: 4 });
  assert.equal(m['model-one'].usageSamples.input, 1); assert.equal(m['model-one'].usageSamples.output, 2);
  assert.equal(m['model-one'].reportedCost, 0.02); assert.equal(m['model-one'].costSamples, 1);
  assert.equal(m.__proto__.reportedCost, null); assert.equal(Object.getPrototypeOf(m), Object.prototype);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
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
    row({ metadata: meta({ 'compression.outcome': 'passthrough', 'compression.input_chars': 40, 'compression.output_chars': 40 }) }),
    row({ level: 'ERROR', reason: 'SECRET', metadata: { ...meta({ 'compression.outcome': 'timeout' }), private_key: 'SECRET' } }),
    row({ metadata: {} })
  ] }, now);
  const c = result.hosts.find(h => h.id === 'windows/native').agents[0].compression;
  assert.equal(c.compressed, 1); assert.equal(c.passthrough, 1); assert.equal(c.failed, 1); assert.equal(c.sizeSamples, 2);
  assert.equal(result.unattributed, 0); assert.equal(c.unknown, 1); assert.equal(result.issues.length, 1);
  assert.ok(result.gaps.some(g => g.title.includes('результат компрессии')));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('known compression failures at DEFAULT level are visible; unknown outcomes remain observation gaps', () => {
  const failures = ['neural_unavailable', 'bridge_unavailable', 'bridge_failed', 'missing_current_query', 'timeout', 'missing_key', 'key_conflict', 'request_failed', 'invalid_response', 'fallback'];
  const result = overview({ compression: [
    ...failures.map(outcome => row({ metadata: meta({ 'compression.outcome': outcome }) })),
    row({ metadata: meta({ 'compression.outcome': 'future_or_SECRET' }) }),
    row({ metadata: meta({ 'compression.outcome': 'no_gain' }) })
  ] }, now);
  const c = result.hosts.find(h => h.id === 'windows/native').agents[0].compression;
  assert.equal(c.failed, failures.length); assert.equal(c.passthrough, 1); assert.equal(c.unknown, 1);
  assert.equal(result.issues.length, 1); assert.equal(result.issues[0].traceId, 'abcdef1234567890');
  assert.equal(result.unattributed, 0);
  assert.ok(c.outcomes['Файл компрессора недоступен']);
  assert.ok(result.gaps.some(g => g.traceId === 'abcdef1234567890' && g.detail.includes('неизвестным')));
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
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

test('native WebSocket counters retain separate units and missing measurements remain null', () => {
  const result = overview({ health: [row({ metadata: meta({ 'monitor.codex_ws_frames_attempted_total': 5, 'monitor.codex_ws_frames_failed_total': 0, 'monitor.codex_ws_frame_bytes_before_sum': 12000, 'monitor.codex_ws_frame_elapsed_max_ms': 500 }) })] }, now);
  const agent = result.hosts.find(h => h.id === 'windows/native').agents[0];
  assert.equal(agent.proxy[0].metrics.codex_ws_frames_attempted_total, 5);
  assert.equal(agent.proxy[0].metrics.codex_ws_frames_failed_total, 0);
  assert.equal(agent.proxy[0].metrics.codex_ws_frames_compressed_total, null);
  assert.equal(agent.compression, null);
  assert.equal(agent.activity, null);
  const missing = overview({ health: [row({ state: 'warning', reason: 'native_stats_unavailable' })] }, now);
  assert.ok([...missing.issues, ...missing.gaps].some(i => i.detail.includes('счётчики Headroom недоступны')));
});

test('FD2/FD3 diagnostics preserve concurrent causes and separate recovery proof',()=>{
 const text=nativeExportExplanation({native_export_timeout:2,native_export_concurrency_limit:1,native_export_attempts:5,native_export_retry_seconds:20,native_export_recovery_age_seconds:60});
 assert.match(text,/не завершился/);assert.match(text,/параллельных/);assert.match(text,/20 сек/);assert.match(text,/не Langfuse readback/);
 assert.equal(nativeExportExplanation({}), '');
});
