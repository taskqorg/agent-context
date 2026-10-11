// Anonymous incident relay: validates allowlisted packets, counts per fingerprint in a Durable Object,
// and opens/updates one GitHub issue per fingerprint once enough machines report it.
// Secrets live only here: GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM).

const REPO = 'taskqorg/agent-context';
const COMPONENTS = ['core', 'installer', 'updater', 'proxy', 'compressor', 'telemetry', 'agent-adapter'];
const AGENTS = ['codex', 'claude-code', 'hermes', 'headroom', 'unknown'];
const MACHINE_THRESHOLD = 3; // unique machines before a public issue appears
const ISSUE_REFRESH_MS = 3600000; // body counters refresh at most hourly

export function validPacket(p) {
  return p && p.schema === 1 && p.product === 'agent-context'
    && /^[a-f0-9]{24}$/.test(p.fingerprint) && /^[a-f0-9-]{36}$/.test(p.event_id) && /^[a-f0-9-]{36}$/.test(p.machine_id)
    && COMPONENTS.includes(p.component) && /^[a-z_]{1,40}$/.test(p.operation) && /^[a-z0-9_]{1,40}$/.test(p.category)
    && AGENTS.includes(p.agent) && ['darwin', 'linux', 'win32'].includes(p.environment?.os) && ['native', 'wsl'].includes(p.environment?.topology)
    && /^\d+\.\d+\.\d+$/.test(p.versions?.package || '') && Number.isSafeInteger(p.occurrences_observed_locally ?? 1);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/incidents') return new Response('not found', { status: 404 });
    if (env.KILL_SWITCH === '1') return new Response('paused', { status: 503 });
    const text = await request.text();
    if (text.length > 8192) return new Response('too large', { status: 413 });
    let packet;
    try { packet = JSON.parse(text); } catch { return new Response('bad json', { status: 400 }); }
    if (!validPacket(packet)) return new Response('invalid packet', { status: 422 });
    const stub = env.INCIDENTS.get(env.INCIDENTS.idFromName(packet.fingerprint));
    return stub.fetch('https://do/report', { method: 'POST', body: JSON.stringify(packet) });
  },
};

export class Incident {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const p = await request.json();
    const machine = await hash(p.machine_id); // store only a hash of the anonymous machine id
    const record = (await this.state.storage.get('record')) || { fingerprint: p.fingerprint, component: p.component, operation: p.operation,
      category: p.category, agent: p.agent, first_seen: new Date().toISOString(), occurrences: 0, machines: {}, versions: {}, platforms: {}, issue: null, refreshed: 0 };
    const last = record.machines[machine];
    // Per-machine rate limit and idempotency: one accepted report per machine per hour.
    if (last && Date.now() - last.at < 3600000) return Response.json({ status: 'duplicate' });
    const delta = Math.max(1, (p.occurrences_observed_locally || 1) - (last?.occurrences || 0));
    record.occurrences += delta;
    record.machines[machine] = { at: Date.now(), occurrences: p.occurrences_observed_locally || 1 };
    record.versions[p.versions.package] = (record.versions[p.versions.package] || 0) + delta;
    const platform = `${p.environment.os}/${p.environment.topology}`;
    record.platforms[platform] = (record.platforms[platform] || 0) + delta;
    record.last_seen = new Date().toISOString();
    const machines = Object.keys(record.machines).length;
    if (machines >= MACHINE_THRESHOLD && Date.now() - record.refreshed > ISSUE_REFRESH_MS && this.env.GITHUB_APP_PRIVATE_KEY) {
      try {
        record.issue = await upsertIssue(this.env, record, machines);
        record.refreshed = Date.now();
      } catch { /* counters persist; next report retries */ }
    }
    await this.state.storage.put('record', record);
    return Response.json({ status: 'accepted', machines, issue: record.issue });
  }
}

async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function issueBody(record, machines) {
  const rows = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return `<!-- incident-v2:${record.fingerprint} -->
Automated incident aggregate. Intake only, no execution authority. No logs, prompts, paths or credentials are collected.

- Component: \`${record.component}\` · operation: \`${record.operation}\` · category: \`${record.category}\` · agent: \`${record.agent}\`
- Unique machines: **${machines}** · occurrences: **${record.occurrences}**
- First seen: ${record.first_seen} · last seen: ${record.last_seen}

| Version | Occurrences |
|---|---|
${rows(record.versions)}

| Platform | Occurrences |
|---|---|
${rows(record.platforms)}
`;
}

async function upsertIssue(env, record, machines) {
  const token = await installationToken(env);
  const api = (path, init = {}) => fetch(`https://api.github.com${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-context-relay', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
    .then(async r => { if (!r.ok) throw new Error(`GitHub ${r.status}`); return r.json(); });
  const body = issueBody(record, machines);
  if (record.issue) {
    await api(`/repos/${REPO}/issues/${record.issue.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    return record.issue;
  }
  const created = await api(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({
    title: `[incident] ${record.component}: ${record.category} (${record.agent})`, body, labels: ['incident', `fp:${record.fingerprint.slice(0, 12)}`] }) });
  return { number: created.number, url: created.html_url };
}

async function installationToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = value => btoa(typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))}`;
  const der = Uint8Array.from(atob(env.GITHUB_APP_PRIVATE_KEY.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const jwt = `${unsigned}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))}`;
  const response = await fetch(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-context-relay' } });
  if (!response.ok) throw new Error(`token ${response.status}`);
  return (await response.json()).token;
}
