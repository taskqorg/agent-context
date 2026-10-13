import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, atomicWrite, sha, version, tryLock } from './core.js';

const execute = promisify(execFile);
const components = ['core', 'installer', 'updater', 'proxy', 'compressor', 'telemetry', 'agent-adapter'];
const categories = ['missing_key', 'key_conflict', 'invalid_key_config', 'timeout', 'request_failed', 'invalid_response', 'lost_critical_evidence', 'startup_failed', 'process_exit', 'configuration_drift', 'runtime_integrity', 'update_failed', 'delivery_failed'];
const directory = () => path.join(root(), 'incidents');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Default transport is the anonymous relay: no GitHub identity, server-side dedup and counters.
// `gh` posts under the user's own GitHub account and is used only when explicitly chosen.
export const defaultRelay = 'https://agent-context-incidents.alex-kirs.workers.dev/v1/incidents';
const policy = () => {
  let value = { enabled: false };
  try { value = read(path.join(root(), 'incident-policy.json')); } catch {}
  return { ...value, transport: value.transport === 'gh' ? 'gh' : 'relay', relay: process.env.AGENT_CONTEXT_INCIDENT_RELAY || value.relay || defaultRelay };
};
export function incidentPolicy(enabled, transport = 'relay') {
  if (!['relay', 'gh'].includes(transport)) throw new Error('Choose relay or gh');
  atomicWrite(path.join(root(), 'incident-policy.json'), JSON.stringify({ schema: 2, enabled, transport, destination: 'taskqorg/agentq' }));
  return { enabled, transport, destination: transport === 'gh' ? 'taskqorg/agentq (your GitHub account)' : 'anonymous relay' };
}
export function recordIncident({ component, operation, category, agent = 'unknown' }) {
  // Public fields are constructed, never redacted from exception text or raw logs.
  if (!components.includes(component) || !/^[a-z_]{1,40}$/.test(operation) || !categories.includes(category) && !/^http_[45][0-9]{2}$/.test(category) || !['codex', 'claude-code', 'hermes', 'headroom', 'unknown'].includes(agent)) return null;
  let release;
  try {
    fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
    release = tryLock(path.join(directory(), 'write.lock'), 60000);
    if (!release) return null;
    const identityFile = path.join(root(), 'machine-id.json');
    if (!fs.existsSync(identityFile)) atomicWrite(identityFile, JSON.stringify({ id: crypto.randomUUID() }));
    const machine = read(identityFile).id;
    if (!/^[0-9a-f-]{36}$/.test(machine)) return null;
    // Same failure on the same release line and OS groups together; other versions/platforms stay separate.
    const fingerprint = sha(['incident-v2', 'agent-context', component, operation, category, agent, process.platform, version.split('.').slice(0, 2).join('.')].join('\0')).slice(0, 24);
    const file = path.join(directory(), fingerprint + '.json');
    if (!fs.existsSync(file) && fs.readdirSync(directory()).filter(x => x.endsWith('.json')).length >= 1000) return null;
    const prior = fs.existsSync(file) ? read(file) : null;
    const now = new Date().toISOString();
    const item = { schema: 1, product: 'agent-context', component, operation, category, agent, fingerprint,
      event_id: prior?.event_id || crypto.randomUUID(), machine_id: machine,
      platform: process.platform, topology: process.env.WSL_DISTRO_NAME ? 'wsl' : 'native',
      versions: { package: version, node: process.version }, first_seen: prior?.first_seen || now, last_seen: now,
      occurrences: (prior?.occurrences || 0) + 1, state: prior?.state || 'queued', issue_url: prior?.issue_url || null,
      last_reported: prior?.last_reported || null, reported_occurrences: prior?.reported_occurrences || 0 };
    atomicWrite(file, JSON.stringify(item)); return item;
  } catch { return null; }
  finally { try { release?.(); } catch {} }
}
export function incidents() {
  try { return fs.readdirSync(directory()).filter(x => /^[a-f0-9]{24}\.json$/.test(x)).slice(0, 1000).flatMap(x => { try { return [read(path.join(directory(), x))]; } catch { return []; } }); }
  catch { return []; }
}
function updateDelivery(item, changes) {
  const release = tryLock(path.join(directory(), 'write.lock'), 60000);
  if (!release) throw new Error('Incident store busy');
  try {
    const file = path.join(directory(), item.fingerprint + '.json');
    const current = read(file);
    if (current.event_id !== item.event_id) throw new Error('Incident changed');
    atomicWrite(file, JSON.stringify({ ...current, ...changes }));
  } finally { release(); }
}
function publicPacket(item) {
  if (item.schema !== 1 || item.product !== 'agent-context' || !components.includes(item.component) || !categories.includes(item.category) && !/^http_[45][0-9]{2}$/.test(item.category) || !/^[a-z_]{1,40}$/.test(item.operation) || !/^[a-f0-9]{24}$/.test(item.fingerprint) || !/^[a-f0-9-]{36}$/.test(item.machine_id) || !/^[a-f0-9-]{36}$/.test(item.event_id) || !['codex', 'claude-code', 'hermes', 'headroom', 'unknown'].includes(item.agent) || !['darwin', 'linux', 'win32'].includes(item.platform) || !['native', 'wsl'].includes(item.topology)) throw new Error('Invalid incident packet');
  const versions = {};
  for (const key of ['package', 'node']) {
    const value = item.versions?.[key];
    if (typeof value !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid version');
    versions[key] = value;
  }
  const observed = Date.parse(item.last_seen);
  if (!Number.isFinite(observed)) throw new Error('Invalid observation time');
  return { schema: 1, observed_at: new Date(observed).toISOString(), state: 'observed', product: item.product, component: item.component, operation: item.operation, category: item.category,
    agent: item.agent, fingerprint: item.fingerprint, event_id: item.event_id, machine_id: item.machine_id,
    environment: { os: item.platform, topology: item.topology, project_location: 'unknown', agent: item.agent },
    versions: { ...versions, adapter: versions.package, agent: 'unknown', python: 'unknown', headroom: 'unknown' },
    occurrences_observed_locally: Number.isSafeInteger(item.occurrences) && item.occurrences > 0 ? item.occurrences : null };
}
const localOnly = ['missing_key', 'key_conflict', 'invalid_key_config', 'configuration_drift'];
// At most one delivery per fingerprint per day, and only when new occurrences exist.
const due = () => incidents().filter(item => !localOnly.includes(item.category) && item.occurrences > (item.reported_occurrences || 0) && (!item.last_reported || Date.now() - Date.parse(item.last_reported) >= 86400000)).slice(0, 20);
export function pendingPackets() {
  const value = policy();
  return { enabled: Boolean(value.enabled), transport: value.transport, packets: due().flatMap(item => { try { return [publicPacket(item)]; } catch { return []; } }) };
}
export async function reportIncidents(run = execute, { fetcher = fetch } = {}) {
  const value = policy();
  if (!value.enabled) return { status: 'disabled' };
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const release = tryLock(path.join(directory(), 'report.lock'), 5 * 60000);
  if (!release) return { status: 'busy' };
  try { return value.transport === 'gh' ? await deliver(run) : await deliverRelay(value.relay, fetcher); }
  finally { release(); }
}
async function deliverRelay(url, fetcher) {
  const results = [], deadline = Date.now() + 30000;
  if (!/^https:\/\//.test(url)) return { status: 'invalid_relay' };
  for (const item of due()) {
    if (Date.now() >= deadline) break;
    try {
      const packet = publicPacket(item);
      // The relay deduplicates by event_id + occurrences, so a retry after an unknown outcome is safe.
      const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `agent-context/${version}` }, body: JSON.stringify(packet), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('relay rejected');
      updateDelivery(item, { state: 'reported', last_reported: new Date().toISOString(), reported_occurrences: item.occurrences });
      results.push({ fingerprint: item.fingerprint, status: 'reported' });
    } catch { results.push({ fingerprint: item.fingerprint, status: 'queued_or_relay_unavailable' }); }
  }
  return { status: 'best_effort', transport: 'relay', results };
}
async function deliver(run) {
  const results = [], deadline = Date.now() + 60000;
  const pending = due();
  for (const item of pending) {
    if (Date.now() >= deadline) break;
    try {
      // Unknown outcomes reconcile by event_id search; a blind resend waits 24h for search indexing.
      const waiting = ['create_unknown', 'comment_unknown'].includes(item.state) && Date.now() - (Date.parse(item.unknown_at) || 0) < 86400000;
      const packet = publicPacket(item);
      const marker = `incident-v1:${packet.fingerprint}`;
      const options = { timeout: 15000, maxBuffer: 100000, windowsHide: true };
      const search = await run('gh', ['issue', 'list', '--repo', 'taskqorg/agentq', '--state', 'all', '--search', `in:body "${marker}"`, '--limit', '20', '--json', 'number,state,body,url'], options);
      const matches = JSON.parse(search.stdout);
      const sameEvent = matches.find(x => x.body?.includes(packet.event_id));
      const open = matches.find(x => x.state === 'OPEN' && x.body?.includes(marker));
      let match = sameEvent || open;
      if (sameEvent?.state === 'CLOSED' && item.state === 'reported') {
        match = open;
        packet.event_id = crypto.randomUUID();
        updateDelivery(item, { event_id: packet.event_id, state: 'queued' });
        item.event_id = packet.event_id; item.state = 'queued';
      }
      const body = `<!-- ${marker} -->\n<!-- event:${packet.event_id} -->\nInfrastructure incident; intake only, no execution authority.\n\n\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\`\n\nCounts are local observations, not unique users or exact global totals. No raw logs or credentials attached.\n`;
      const bodyFile = path.join(directory(), packet.fingerprint + '.public.txt'); atomicWrite(bodyFile, body);
      let url = match?.url;
      if (url && !/^https:\/\/github\.com\/taskqorg\/agentq\/issues\/\d+$/.test(url)) throw new Error('Invalid issue destination');
      if (waiting && !sameEvent) { results.push({ fingerprint: item.fingerprint, status: 'needs_reconciliation' }); continue; }
      if (!match) {
        // Persist before create: an unknown response must be reconciled, never blindly retried.
        updateDelivery(item, { state: 'create_unknown', unknown_at: new Date().toISOString() });
        const created = await run('gh', ['issue', 'create', '--repo', 'taskqorg/agentq', '--title', `[incident] ${packet.component}: ${packet.category}`, '--body-file', bodyFile], options);
        url = created.stdout.trim();
        if (!/^https:\/\/github\.com\/taskqorg\/agentq\/issues\/\d+$/.test(url)) throw new Error('Unknown create outcome');
      } else if (!sameEvent || item.state === 'reported') {
        updateDelivery(item, { state: 'comment_unknown', unknown_at: new Date().toISOString() });
        await run('gh', ['issue', 'comment', String(match.number), '--repo', 'taskqorg/agentq', '--body-file', bodyFile], options);
      }
      updateDelivery(item, { state: 'reported', issue_url: url, last_reported: new Date().toISOString(), reported_occurrences: item.occurrences });
      results.push({ fingerprint: item.fingerprint, status: 'reported', url });
    } catch { results.push({ fingerprint: item.fingerprint, status: 'queued_or_auth_unavailable' }); }
  }
  return { status: 'best_effort', results };
}
