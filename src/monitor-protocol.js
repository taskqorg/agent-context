import crypto from 'node:crypto';
import { sha } from './core.js';

export const monitorMetrics = ['active_connections', 'queue_batches', 'queue_bytes', 'queue_oldest_seconds', 'compressed', 'passthrough', 'compression_failed', 'input_chars', 'output_chars', 'last_activity_age_seconds'];
const services = ['contextq', 'serverq', 'taskq', 'gateway', 'hermes-gateway', 'langfuse'];
const reasons = ['queue_unreadable', 'stale_report', 'invalid_report', 'automated_checks_only', 'status_snapshot', 'report_unavailable', 'invalid_report_policy', 'proxy_unavailable', 'compression_telemetry_disabled', 'delivery_backlog', 'proxy_health_not_agent_liveness', 'endpoint_reachable', 'endpoint_unavailable'];
const categories = ['missing_key', 'key_conflict', 'invalid_key_config', 'timeout', 'request_failed', 'invalid_response', 'lost_critical_evidence', 'startup_failed', 'process_exit', 'configuration_drift', 'runtime_integrity', 'update_failed', 'delivery_failed'];
const states = ['ok', 'warning', 'error', 'unknown'];
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function validateMonitor(value, now = Date.now()) {
  if (!exact(value, ['schema', 'id', 'at', 'host', 'runtime', 'version', 'services', 'incidents']) || value.schema !== 1 || !/^[a-f0-9]{32}$/.test(value.id) || !Number.isFinite(Date.parse(value.at)) || Date.parse(value.at) > now + 60000 || Date.parse(value.at) < now - 7 * 86400000 || !label(value.host) || !['native', 'wsl'].includes(value.runtime) || !/^\d+\.\d+\.\d+$/.test(value.version) || !Array.isArray(value.services) || value.services.length > 32 || !Array.isArray(value.incidents) || value.incidents.length > 100) throw new Error('Invalid monitoring snapshot');
  const seen = new Set();
  for (const service of value.services) {
    const key = service.service + ':' + (service.agent || 'none');
    if (!exact(service, ['service', 'agent', 'state', 'reason', 'metrics']) || !services.includes(service.service) || !['none', 'codex', 'claude-code', 'hermes'].includes(service.agent) || !states.includes(service.state) || !reasons.includes(service.reason) || !exact(service.metrics, monitorMetrics) || seen.has(key)) throw new Error('Invalid monitoring service');
    seen.add(key);
    for (const metric of Object.values(service.metrics)) if (!Number.isFinite(metric) || metric < 0 || metric > Number.MAX_SAFE_INTEGER) throw new Error('Invalid monitoring metric');
  }
  for (const item of value.incidents) {
    if (!exact(item, ['fingerprint', 'component', 'category', 'agent', 'occurrences', 'at']) || !/^[a-f0-9]{24}$/.test(item.fingerprint) || !['core', 'installer', 'updater', 'proxy', 'compressor', 'telemetry', 'agent-adapter'].includes(item.component) || !(categories.includes(item.category) || /^http_[45][0-9]{2}$/.test(item.category)) || !['codex', 'claude-code', 'hermes', 'headroom', 'unknown'].includes(item.agent) || !Number.isSafeInteger(item.occurrences) || item.occurrences < 1 || !Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) > now + 60000 || Date.parse(item.at) < now - 7 * 86400000) throw new Error('Invalid monitoring incident');
  }
  return value;
}
const attr = (key, value) => ({ key, value: Array.isArray(value) ? { arrayValue: { values: value.map(stringValue => ({ stringValue })) } } : typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) } });
export function monitorExport(packet, { device = 'local', user, now = Date.now() } = {}) {
  validateMonitor(packet, now);
  const traceId = sha('monitor\0' + device + '\0' + packet.id).slice(0, 32);
  const spans = [], scores = [];
  const baseTags = ['component:monitor', 'host:' + packet.host, 'runtime:' + packet.runtime, 'device:' + device, ...(user ? ['user:' + user] : [])];
  const base = [attr('langfuse.environment', 'production'), attr('langfuse.trace.name', 'Service monitor'), attr('agent_context.version', packet.version), attr('agent_context.host', packet.host), attr('agent_context.runtime', packet.runtime), attr('agent_context.observed_at', packet.at), ...(user ? [attr('langfuse.user.id', user)] : [])];
  const span = (id, at, name, level, reason, tags, values = []) => ({ traceId, spanId: sha(id).slice(0, 16), name, startTimeUnixNano: String(BigInt(Date.parse(at)) * 1000000n), endTimeUnixNano: String(BigInt(Date.parse(at) + 1) * 1000000n), attributes: [...base, attr('langfuse.observation.type', 'span'), attr('langfuse.observation.level', level), attr('langfuse.observation.status_message', reason), attr('langfuse.trace.tags', [...baseTags, ...tags]), ...values] });
  for (const service of packet.services) {
    const key = service.service + '.' + service.agent;
    const tags = ['service:' + service.service, 'agent:' + service.agent, 'state:' + service.state];
    const healthSpan = span(key, packet.at, 'service.health.' + key, service.state === 'error' ? 'ERROR' : service.state === 'ok' ? 'DEFAULT' : 'WARNING', service.reason, tags, Object.entries(service.metrics).map(([k, v]) => attr('agent_context.monitor.' + k, v)));
    healthSpan.traceId = sha(traceId + key).slice(0, 32); spans.push(healthSpan);
    // Delayed snapshots stay historical; replay must not turn a stale health sample into a fresh score.
    if (now - Date.parse(packet.at) <= 600000) for (const [name, value] of Object.entries({ ...service.metrics, ...(service.state === 'unknown' ? {} : { health: service.state === 'ok' ? 1 : 0 }) })) scores.push({ id: sha(traceId + '\0' + key + '\0' + name), traceId: healthSpan.traceId, observationId: sha(key).slice(0, 16), name: key + '.' + name, value, dataType: 'NUMERIC', environment: 'production' });
  }
  for (const item of packet.incidents) {
    // Separate stable incident trace/span IDs make repeat uploads idempotent.
    const id = sha(device + '\0' + item.fingerprint + '\0' + item.occurrences);
    const event = span(id, item.at, 'service.incident', 'ERROR', item.category, ['service:contextq', 'agent:' + item.agent, 'incident:' + item.component], [attr('agent_context.incident.fingerprint', item.fingerprint), attr('agent_context.incident.occurrences', item.occurrences)]);
    event.traceId = id.slice(0, 32); spans.push(event);
  }
  return { otlp: { resourceSpans: [{ resource: { attributes: [attr('service.name', 'contextq-monitor')] }, scopeSpans: [{ scope: { name: 'contextq-monitor' }, spans }] }] }, scores, traceId };
}
export const newMonitorId = () => crypto.randomBytes(16).toString('hex');
