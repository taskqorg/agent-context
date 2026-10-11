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
const policy = () => { try { return read(path.join(root(), 'incident-policy.json')); } catch { return { enabled: false }; } };
export function incidentPolicy(enabled) {
  atomicWrite(path.join(root(), 'incident-policy.json'), JSON.stringify({ schema: 1, enabled, destination: 'taskqorg/agent-context' }));
  return { enabled, destination: 'taskqorg/agent-context' };
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
    const fingerprint = sha(['incident-v1', 'agent-context', component, operation, category, agent].join('\0')).slice(0, 24);
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
export async function reportIncidents(run = execute) {
  if (!policy().enabled) return { status: 'disabled' };
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const release = tryLock(path.join(directory(), 'report.lock'), 5 * 60000);
  if (!release) return { status: 'busy' };
  try { return await deliver(run); }
  finally { release(); }
}
async function deliver(run) {
  const results = [], deadline = Date.now() + 60000;
  const localOnly = ['missing_key', 'key_conflict', 'invalid_key_config', 'configuration_drift'];
  const pending = incidents().filter(item => !localOnly.includes(item.category) && item.occurrences > (item.reported_occurrences || 0) && (!item.last_reported || Date.now() - Date.parse(item.last_reported) >= 86400000)).slice(0, 20);
  for (const item of pending) {
    if (Date.now() >= deadline) break;
    try {
      if (item.state === 'comment_unknown') { results.push({ fingerprint: item.fingerprint, status: 'needs_reconciliation' }); continue; }
      const packet = publicPacket(item);
      const marker = `incident-v1:${packet.fingerprint}`;
      const options = { timeout: 15000, maxBuffer: 100000, windowsHide: true };
      const search = await run('gh', ['issue', 'list', '--repo', 'taskqorg/agent-context', '--state', 'all', '--search', `in:body "${marker}"`, '--limit', '20', '--json', 'number,state,body,url'], options);
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
      if (url && !/^https:\/\/github\.com\/taskqorg\/agent-context\/issues\/\d+$/.test(url)) throw new Error('Invalid issue destination');
      if (!match) {
        // Persist before create: an unknown response must be reconciled, never blindly retried.
        if (item.state === 'create_unknown') { results.push({ fingerprint: item.fingerprint, status: 'needs_reconciliation' }); continue; }
        updateDelivery(item, { state: 'create_unknown' });
        const created = await run('gh', ['issue', 'create', '--repo', 'taskqorg/agent-context', '--title', `[incident] ${packet.component}: ${packet.category}`, '--body-file', bodyFile], options);
        url = created.stdout.trim();
        if (!/^https:\/\/github\.com\/taskqorg\/agent-context\/issues\/\d+$/.test(url)) throw new Error('Unknown create outcome');
      } else if (!sameEvent || item.state === 'reported') {
        updateDelivery(item, { state: 'comment_unknown' });
        await run('gh', ['issue', 'comment', String(match.number), '--repo', 'taskqorg/agent-context', '--body-file', bodyFile], options);
      }
      updateDelivery(item, { state: 'reported', issue_url: url, last_reported: new Date().toISOString(), reported_occurrences: item.occurrences });
      results.push({ fingerprint: item.fingerprint, status: 'reported', url });
    } catch { results.push({ fingerprint: item.fingerprint, status: 'queued_or_auth_unavailable' }); }
  }
  return { status: 'best_effort', results };
}
