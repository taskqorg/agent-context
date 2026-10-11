import fs from 'node:fs';
import path from 'node:path';
import { root, home, version, tryLock } from './core.js';
import { atomicSecretWrite } from './private-file.js';
import { langfuseConfig, profileIdentity } from './telemetry.js';
import { serviceHealth } from './service.js';
import { incidents } from './incidents.js';
import { updateSummary } from './update-subscription.js';
import { enrollment } from './enrollment.js';
import { monitorExport, validateMonitor, newMonitorId } from './monitor-protocol.js';

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
export async function collectMonitor({ health = serviceHealth, now = Date.now() } = {}) {
  let settings = {}; try { settings = read(path.join(root(), 'monitor-config.json')); } catch {}
  let installed = []; try { installed = read(path.join(root(), 'integration.json')).agents || []; } catch {}
  const services = [];
  for (const agent of installed.filter(a => ['codex', 'claude', 'hermes'].includes(a))) {
    const state = await health(agent);
    let metrics = {}, queueReadable = true;
    try { metrics = queueStats(path.join(root(), 'telemetry-outbox', enrollment()?.device || 'local', agent === 'claude' ? 'claude-code' : agent), now); } catch { queueReadable = false; }
    const outcomes = state?.compression?.supercompress_outcomes;
    for (const key of ['input_chars', 'output_chars']) if (Number.isFinite(state?.compression?.tool_context?.[key])) metrics[key] = state.compression.tool_context[key];
    if (outcomes) {
      metrics.compressed = outcomes.compressed || 0;
      const normal = new Set(['compressed', 'retrieval', 'content_type', 'ineligible', 'no_gain', 'empty', 'too_large', 'request_budget']);
      metrics.passthrough = Object.entries(outcomes).filter(([key]) => key !== 'compressed').reduce((n, [, v]) => n + v, 0);
      metrics.compression_failed = Object.entries(outcomes).filter(([key]) => !normal.has(key)).reduce((n, [, v]) => n + v, 0);
    }
    if (state) metrics.active_connections = state.active || 0;
    services.push({ service: 'contextq', agent: agent === 'claude' ? 'claude-code' : agent, state: !state ? 'error' : !queueReadable || state.telemetry === false || metrics.queue_oldest_seconds > 600 ? 'warning' : 'ok', reason: !state ? 'proxy_unavailable' : !queueReadable ? 'queue_unreadable' : state.telemetry === false ? 'compression_telemetry_disabled' : metrics.queue_oldest_seconds > 600 ? 'delivery_backlog' : 'proxy_health_not_agent_liveness', metrics, ...(state?.version ? { version: state.version } : {}) });
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
  const headers = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(config.public_key + ':' + config.secret_key).toString('base64') };
  const deadline = Date.now() + 40000;
  const post = (url, body) => { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Monitor delivery deadline'); return request(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, remaining)) }); };
  if (config.gateway) return (await post(config.base_url + '/v1/monitor', packet)).ok;
  const exported = monitorExport(packet, identity);
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
