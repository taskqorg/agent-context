// Anonymous incident relay: validates allowlisted packets, counts per fingerprint in a Durable Object,
// and opens/updates one GitHub issue per fingerprint once enough machines report it.
// Secrets live only here: GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM), SOURCE_SALT.

const REPO = 'taskqorg/agentq';
const COMPONENTS = ['core', 'installer', 'updater', 'proxy', 'compressor', 'telemetry', 'agent-adapter'];
const AGENTS = ['codex', 'claude-code', 'hermes', 'headroom', 'unknown'];
const MACHINE_THRESHOLD = 3; // unique machines before a public issue appears
const ISSUE_REFRESH_MS = 3600000; // body counters refresh at most hourly
const MAX_DELTA = 100; // one report cannot inflate occurrences beyond this
const MAX_SOURCES = 1000; // bounded per-fingerprint state; oldest entries are evicted
const MAX_NEW_ISSUES_PER_DAY = 10; // global cap, so forged fingerprints cannot flood the repository
// Threshold counts distinct network sources (salted IP hash), not client-chosen machine ids (Sybil-resistant).
// Configure a Cloudflare rate-limiting rule on /v1/incidents as the outer per-IP limit.

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
    const source = await hash(`${env.SOURCE_SALT || ''}\0${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
    const stub = env.INCIDENTS.get(env.INCIDENTS.idFromName(packet.fingerprint));
    return stub.fetch('https://do/report', { method: 'POST', body: JSON.stringify({ packet, source }) });
  },
};

export class Incident {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const { packet: p, source } = await request.json();
    const machine = await hash(p.machine_id); // store only a hash of the anonymous machine id
    const record = (await this.state.storage.get('record')) || { fingerprint: p.fingerprint, component: p.component, operation: p.operation,
      category: p.category, agent: p.agent, first_seen: new Date().toISOString(), occurrences: 0, machines: {}, sources: {}, versions: {}, platforms: {}, issue: null, refreshed: 0 };
    record.sources ||= {};
    const last = record.machines[machine];
    // Per-machine and per-source rate limit and idempotency: one accepted report per hour.
    if ((last && Date.now() - last.at < 3600000) || Date.now() - (record.sources[source] || 0) < 3600000) return Response.json({ status: 'duplicate' });
    const delta = Math.min(MAX_DELTA, Math.max(1, (p.occurrences_observed_locally || 1) - (last?.occurrences || 0)));
    record.occurrences += delta;
    record.machines[machine] = { at: Date.now(), occurrences: p.occurrences_observed_locally || 1 };
    record.sources[source] = Date.now();
    for (const key of ['machines', 'sources']) {
      const entries = Object.entries(record[key]);
      if (entries.length > MAX_SOURCES) record[key] = Object.fromEntries(entries.sort((a, b) => (b[1].at ?? b[1]) - (a[1].at ?? a[1])).slice(0, MAX_SOURCES));
    }
    record.versions[p.versions.package] = (record.versions[p.versions.package] || 0) + delta;
    const platform = `${p.environment.os}/${p.environment.topology}`;
    record.platforms[platform] = (record.platforms[platform] || 0) + delta;
    record.last_seen = new Date().toISOString();
    const machines = Object.keys(record.sources).length;
    if (machines >= MACHINE_THRESHOLD && Date.now() - record.refreshed > ISSUE_REFRESH_MS && this.env.GITHUB_APP_PRIVATE_KEY) {
      try {
        if (!record.issue && !await this.allowNewIssue()) throw new Error('daily issue budget');
        record.issue = await upsertIssue(this.env, record, machines);
        record.refreshed = Date.now();
      } catch { /* counters persist; next report retries */ }
    }
    await this.state.storage.put('record', record);
    return Response.json({ status: 'accepted', machines, issue: record.issue });
  }
}

Incident.prototype.allowNewIssue = async function () {
  // One global budget object; Durable Objects serialize its updates.
  const budget = this.env.INCIDENTS.get(this.env.INCIDENTS.idFromName('global-issue-budget'));
  return (await (await budget.fetch('https://do/budget', { method: 'POST' })).json()).allowed;
};
const handleReport = Incident.prototype.fetch;
Incident.prototype.fetch = async function (request) {
  if (new URL(request.url).pathname !== '/budget') return handleReport.call(this, request);
  const day = new Date().toISOString().slice(0, 10);
  const budget = (await this.state.storage.get('budget')) || { day, used: 0 };
  if (budget.day !== day) Object.assign(budget, { day, used: 0 });
  const allowed = budget.used < MAX_NEW_ISSUES_PER_DAY;
  if (allowed) budget.used++;
  await this.state.storage.put('budget', budget);
  return Response.json({ allowed });
};

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
