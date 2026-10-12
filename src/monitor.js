import {flushNativeEvents} from './native-tools.js';
import {nativeExportStats} from './native-export.js';
import { providers } from './providers.js';
import fs from 'node:fs';
import path from 'node:path';
import { root, home, version, tryLock } from './core.js';
import { atomicSecretWrite } from './private-file.js';
import { langfuseConfig, profileIdentity, telemetryStatus, refreshTelemetryDelivery } from './telemetry.js';
import { serviceHealth } from './service.js';
import { incidents } from './incidents.js';
import { updateSummary } from './update-subscription.js';
import { enrollment } from './enrollment.js';
import { monitorExport, validateMonitor, newMonitorId, codexWsMetrics } from './monitor-protocol.js';

export const MONITOR_INTERVAL_MS = 300000;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => atomicSecretWrite(file, JSON.stringify(value));
export function queueStats(directory, now = Date.now()) {
  let count = 0, bytes = 0, oldest = now;
  const walk = (dir, depth) => {
    if (depth > 3 || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Invalid queue directory');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json')) { const stat = fs.statSync(file); count++; bytes += stat.size; oldest = Math.min(oldest, stat.mtimeMs); }
      else if (entry.isSymbolicLink()) throw new Error('Invalid queue entry');
    }
  };
  try { walk(directory, 0); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { queue_batches: count, queue_bytes: bytes, queue_oldest_seconds: Math.max(0, Math.round((now - oldest) / 1000)) };
}
export function reportHealth(file, maxAgeSeconds, kind, now = Date.now()) {
  try {
    if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid report');
    const report = read(file), at = kind === 'serverq' ? report.at * 1000 : Date.parse(report.checkedAt);
    if (!Number.isFinite(at) || at > now + 60000 || now - at > maxAgeSeconds * 1000) return { state: 'unknown', reason: 'stale_report' };
    if (kind === 'serverq') {
      const checks = Object.values(report.results || {});
      if (!checks.length || checks.some(check => !['ok', 'warn', 'unknown'].includes(check.status))) return { state: 'unknown', reason: 'invalid_report' };
      return { state: checks.some(c => c.status === 'unknown') ? 'unknown' : checks.some(c => c.status === 'warn') ? 'warning' : 'ok', reason: 'automated_checks_only' };
    }
    return ['ok', 'warning', 'error', 'unknown'].includes(report.state) ? { state: report.state, reason: 'status_snapshot' } : { state: 'unknown', reason: 'invalid_report' };
  } catch { return { state: 'unknown', reason: 'report_unavailable' }; }
}
export async function headroomStats(state, request = fetch) {
  if (!Number.isInteger(state?.port) || state.port < 1 || state.port > 65535) return null;
  try {
    const response = await request(`http://127.0.0.1:${state.port}/stats`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    // Export only numeric aggregates; /stats also contains private request metadata.
    const ws = (await response.json()).codex_ws;
    const values = { ...ws, frame_elapsed_average_ms: ws?.frame_elapsed_ms?.average, frame_elapsed_max_ms: ws?.frame_elapsed_ms?.max };
    if (codexWsMetrics.some(key => !Number.isFinite(values[key]) || values[key] < 0 || values[key] > Number.MAX_SAFE_INTEGER)) return null;
    return Object.fromEntries(codexWsMetrics.map(key => ['codex_ws_' + key, values[key]]));
  } catch { return null; }
}
export async function collectMonitor({ health = serviceHealth, stats = headroomStats, now = Date.now() } = {}) {
  await flushNativeEvents();
  let settings = {}; try { settings = read(path.join(root(), 'monitor-config.json')); } catch {}
  let installed = [], telemetryEnabled = false;
  try { const config = read(path.join(root(), 'integration.json')); installed = config.agents || []; telemetryEnabled = config.telemetry === true; } catch {}
  const services = [];
  const telemetry = telemetryStatus(installed);
  for (const agent of installed.filter(a => ['codex', 'claude', 'hermes'].includes(a))) {
    const state = await health(agent);
    let metrics = {}, queueReadable = true;
    try { metrics = queueStats(path.join(root(), 'telemetry-outbox', enrollment()?.device || 'local', agent === 'claude' ? 'claude-code' : agent), now); } catch { queueReadable = false; }
    if(agent==='codex') try {
      const pending=nativeExportStats();
      metrics.queue_batches=(metrics.queue_batches||0)+pending.queue_batches;
      metrics.queue_bytes=(metrics.queue_bytes||0)+pending.queue_bytes;
      metrics.queue_oldest_seconds=Math.max(metrics.queue_oldest_seconds||0,pending.queue_oldest_seconds);
    }catch {queueReadable=false;}
    const outcomes = state?.compression?.outcomes || state?.compression?.supercompress_outcomes;
    for (const key of ['input_chars', 'output_chars']) if (Number.isFinite(state?.compression?.tool_context?.[key])) metrics[key] = state.compression.tool_context[key];
    if (outcomes) {
      metrics.compressed = outcomes.compressed || 0;
      const normal = new Set(['compressed', 'retrieval', 'content_type', 'ineligible', 'no_gain', 'empty', 'too_large', 'request_budget', 'passthrough']);
      metrics.passthrough = Object.entries(outcomes).filter(([key]) => key !== 'compressed').reduce((n, [, v]) => n + v, 0);
      metrics.compression_failed = Object.entries(outcomes).filter(([key]) => !normal.has(key)).reduce((n, [, v]) => n + v, 0);
    }
    for (const key of ['compressed', 'passthrough']) if (Number.isFinite(state?.compression?.tool_context?.[key])) metrics[key] = state.compression.tool_context[key];
    for (const [key, target] of Object.entries({ calls: 'compression_calls', total_ms: 'compression_total_ms', max_ms: 'compression_max_ms' })) if (Number.isFinite(state?.compression?.latency?.[key])) metrics[target] = state.compression.latency[key];
    if (Number.isFinite(state?.compression?.last_attempt_at)) metrics.last_compression_age_seconds = Math.max(0, Math.round(now / 1000 - state.compression.last_attempt_at));
    for(const key of ['native_rtk_calls','native_rtk_input_estimate','native_rtk_output_estimate','native_rtk_nonzero_exits']) if(Number.isFinite(state?.compression?.native_tools?.[key])) metrics[key]=state.compression.native_tools[key];
    const native = agent === 'codex' && providers.includes(state?.compressor) ? await stats(state) : undefined;
    const statsMissing = native === null;
    Object.assign(metrics, native);
    if (state) metrics.active_connections = state.active || 0;
    if(state?.front_protocol===1) {metrics.retiring_connections=state.retiringWorker?.connections||0;metrics.retiring_seconds=state.retiringWorker?Math.max(0,(state.retiringWorker.retireAt-now)/1000):0;metrics.stage_failures=state.stageFailures||0;metrics.worker_slots=state.workerSlots||0;}
    if(Number.isFinite(state?.collector?.failures)) metrics.telemetry_send_failures=state.collector.failures;
    const deliveryFailed=Boolean(state?.collector?.lastError);
    const workerFailed=Boolean(state?.rejectedVersion||state?.stageFailures);
    const rotating=Boolean(state?.retiringWorker);
    const exporterMissing = telemetryEnabled && ['missing', 'installed_hooks_disabled_or_unconfigured'].includes(telemetry.nativeExporters[agent]);
    const deliveryUnverified = telemetryEnabled && telemetry.deliveryByAgent[agent]?.status !== 'delivered';
    const telemetryMissing = telemetryEnabled && state?.telemetry === false;
    services.push({ service: 'contextq', agent: agent === 'claude' ? 'claude-code' : agent, state: !state || state.backendHealthy===false ? 'error' : !queueReadable || deliveryFailed || statsMissing || telemetryMissing || exporterMissing || deliveryUnverified || metrics.queue_oldest_seconds > 600 || workerFailed || rotating ? 'warning' : 'ok', reason: !state || state.backendHealthy===false ? 'proxy_unavailable' : !queueReadable ? 'queue_unreadable' : deliveryFailed?'telemetry_delivery_failed':statsMissing ? 'native_stats_unavailable' : telemetryMissing ? 'compression_telemetry_disabled' : exporterMissing ? 'native_exporter_missing' : metrics.queue_oldest_seconds > 600 ? 'delivery_backlog' : deliveryUnverified ? 'telemetry_delivery_unverified' : workerFailed?'worker_update_failed':rotating?'worker_retiring':'proxy_health_not_agent_liveness', metrics, ...(state?.version ? { version: state.version } : {}), ...(state?.retiringWorker?{retiringVersion:state.retiringWorker.version}:{}), ...(state?.targetVersion?{targetVersion:state.targetVersion}:{}) });
  }
  for (const service of ['serverq', 'taskq']) {
    const spec = settings[service];
    const file = spec?.report || (service === 'serverq' ? path.join(home(), '.serverq/report.json') : path.join(home(), '.taskq/status.json'));
    const maxAge = spec?.maxAgeSeconds ?? (service === 'serverq' ? 7200 : 600);
    const status = Number.isInteger(maxAge) && maxAge >= 60 && maxAge <= 86400 ? reportHealth(file, maxAge, service, now) : { state: 'unknown', reason: 'invalid_report_policy' };
    services.push({ service, agent: 'none', ...status, metrics: {} });
  }
  if (settings.hostHealthReport) {
    try {
      const file = settings.hostHealthReport;
      if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid host report');
      const sample = read(file).last_sample;
      const fresh = Number.isFinite(sample?.at) && sample.at * 1000 <= now + 60000 && now - sample.at * 1000 <= 900000;
      for (const service of ['hermes-gateway', 'langfuse']) {
        const ok = service === 'hermes-gateway' ? sample?.services?.['hermes-gateway.service']?.ActiveState === 'active' : sample?.endpoints?.langfuse?.ok === true;
        services.push({ service, agent: 'none', state: fresh ? ok ? 'ok' : 'error' : 'unknown', reason: fresh ? ok ? 'endpoint_reachable' : 'endpoint_unavailable' : 'stale_report', metrics: {} });
      }
    } catch {
      for (const service of ['hermes-gateway', 'langfuse']) services.push({ service, agent: 'none', state: 'unknown', reason: 'report_unavailable', metrics: {} });
    }
  }
  const device = enrollment();
  if (device) {
    let reachable = false; try { reachable = (await fetch(device.gateway + '/v1/info', { redirect: 'error', signal: AbortSignal.timeout(3000) })).ok; } catch {}
    services.push({ service: 'gateway', agent: 'none', state: reachable ? 'ok' : 'error', reason: reachable ? 'endpoint_reachable' : 'endpoint_unavailable', metrics: {} });
  }
  const updater = updateSummary();
  services.push({ service: 'updater', agent: 'none', state: !updater.enabled || updater.status === 'migration_required' ? 'warning' : updater.status === 'failed' ? 'error' : updater.subscription === 'connected' ? 'ok' : 'unknown', reason: !updater.enabled ? 'updates_disabled' : updater.status === 'migration_required' ? 'update_migration_required' : updater.status === 'failed' ? 'update_failed' : updater.subscription === 'connected' ? 'release_subscription_connected' : 'release_subscription_unavailable', metrics: {} });
  const recent = incidents().filter(i => Date.parse(i.last_seen) >= now - 7 * 86400000 && Date.parse(i.last_seen) <= now).slice(0, 100).map(i => ({ fingerprint: i.fingerprint, component: i.component, category: i.category, agent: i.agent, occurrences: i.occurrences, at: i.last_seen }));
  return validateMonitor({ schema: 1, id: newMonitorId(), at: new Date(now).toISOString(), ...profileIdentity(), version, updater, services, incidents: recent }, now);
}
export async function sendMonitor(packet, config, request = fetch, identity = {}) {
  if (!config) return false;
  const headers = { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4', Authorization: 'Basic ' + Buffer.from(config.public_key + ':' + config.secret_key).toString('base64') };
  const deadline = Date.now() + 40000;
  const post = (url, body) => { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Monitor delivery deadline'); return request(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, remaining)) }); };
  if (config.gateway) return (await post(config.base_url + '/v1/monitor', packet)).ok;
  const exported = monitorExport(packet, { user: config.user_id, ...identity });
  const response = await post(config.base_url + '/api/public/otel/v1/traces', exported.otlp);
  if (!response.ok || Number((await response.json()).partialSuccess?.rejectedSpans) > 0) return false;
  for (const score of exported.scores) if (!(await post(config.base_url + '/api/public/scores', score)).ok) return false;
  return true;
}
export async function monitorTick({ force = false, collect = collectMonitor, config = langfuseConfig(), send = sendMonitor, now = Date.now() } = {}) {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(root(), 'uninstalling.json'))) return { status: 'uninstalling' };
  const release = tryLock(path.join(root(), 'monitor.lock'), 600000);
  if (!release) return { status: 'busy' };
  try {
    const stateFile = path.join(root(), 'monitor-state.json');
    let state = {}; try { state = read(stateFile); } catch {}
    if (!force && now - (state.lastAttempt || 0) < MONITOR_INTERVAL_MS) return { status: 'not_due' };
    if (config) await refreshTelemetryDelivery(now);
    const directory = path.join(root(), 'monitor-outbox'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const queued = queueStats(directory, now);
    if (queued.queue_batches < 1000 && queued.queue_bytes <= 20 * 1024 * 1024) {
      const packet = await collect(); write(path.join(directory, packet.id + '.json'), packet);
    }
    let delivered = 0;
    for (const file of fs.readdirSync(directory).filter(f => /^[a-f0-9]{32}\.json$/.test(f)).sort((a, b) => fs.lstatSync(path.join(directory, a)).mtimeMs - fs.lstatSync(path.join(directory, b)).mtimeMs).slice(0, 8)) {
      const target = path.join(directory, file);
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Invalid monitor queue');
      const snapshot = read(target);
      // Retention is seven days; expired snapshots must not block fresh delivery.
      if (Date.parse(snapshot.at) < now - 7 * 86400000) { fs.unlinkSync(target); continue; }
      let accepted = false;
      try { accepted = await send(snapshot, config); } catch {}
      if (!accepted) break;
      fs.unlinkSync(target); delivered++;
    }
    const remaining = queueStats(directory, now);
    const report = { lastAttempt: now, status: remaining.queue_batches ? 'queued' : config?.gateway ? 'accepted_by_gateway' : 'delivered', delivered, ...remaining, ...(delivered ? { lastDeliveredAt: new Date(now).toISOString() } : { lastDeliveredAt: state.lastDeliveredAt }) };
    write(stateFile, report); return report;
  } finally { release(); }
}
export function startMonitoring() {
  const run = () => monitorTick().catch(() => {});
  const timer = setInterval(run, MONITOR_INTERVAL_MS); timer.unref(); run();
  return () => clearInterval(timer);
}
