import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, sha } from './core.js';

const label = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const failure = (status, error) => Response.json({ error }, { status });
const limitBytes = 4 * 1024 * 1024;
export const gatewayTraceId = (device, nativeId) => sha(device + '\0' + nativeId.toLowerCase()).slice(0, 32);

// One process owns this private state. GitHub membership is rechecked at most 60s after revocation.
export function createGateway(config, { request = fetch, now = Date.now } = {}) {
  if (typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error('Unsupported gateway state directory');
  if (!/^[a-zA-Z0-9-]{1,39}$/.test(config.organization) || !/^[a-zA-Z0-9._-]{1,100}$/.test(config.clientId) || config.team && !/^[a-zA-Z0-9_-]{1,100}$/.test(config.team)) throw new Error('Unsupported gateway GitHub configuration');
  const destination = new URL(config.langfuse?.base_url);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.pathname !== '/' || destination.search || destination.hash || !/^pk-lf-[A-Za-z0-9_-]{16,}$/.test(config.langfuse?.public_key) || !/^sk-lf-[A-Za-z0-9_-]{16,}$/.test(config.langfuse?.secret_key) || !/^sc_[A-Za-z0-9_]{20,}$/.test(config.supercompressKey)) throw new Error('Unsupported gateway service configuration');
  const stateFile = path.join(config.stateDir, 'devices.json');
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.stateDir, 0o700);
  let devices = {};
  try { devices = JSON.parse(fs.readFileSync(stateFile, 'utf8')); fs.chmodSync(stateFile, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const checks = new Map(), rates = new Map(), refreshing = new Map();
  let compressing = 0;
  const save = () => atomicWrite(stateFile, JSON.stringify(devices));
  const rate = (key, max) => {
    const window = Math.floor(now() / 60000);
    const value = rates.get(key);
    if (rates.size > 10000) for (const [id, entry] of rates) if (entry.window !== window) rates.delete(id);
    const entry = value?.window === window ? value : { window, count: 0 };
    rates.set(key, entry);
    return ++entry.count <= max;
  };
  const github = (route, token) => request('https://api.github.com' + route, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-context-gateway' }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  const member = async (token, user) => {
    const response = await github(config.team ? `/orgs/${config.organization}/teams/${config.team}/memberships/${user}` : `/user/memberships/orgs/${config.organization}`, token);
    return response.ok && (await response.json()).state === 'active';
  };
  const tokenFields = body => {
    if (body.expires_in === undefined && body.refresh_token === undefined && body.refresh_token_expires_in === undefined) return {};
    if (typeof body.refresh_token !== 'string' || !/^[a-zA-Z0-9_]{1,512}$/.test(body.refresh_token) || !Number.isInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86400 || !Number.isInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= 0 || body.refresh_token_expires_in > 366 * 86400) throw new Error('invalid_oauth_tokens');
    return { githubRefreshToken: body.refresh_token, githubExpiresAt: now() + body.expires_in * 1000, githubRefreshExpiresAt: now() + body.refresh_token_expires_in * 1000 };
  };
  const refresh = async device => {
    if (!device.githubExpiresAt || device.githubExpiresAt > now() + 60000) return;
    if (refreshing.has(device.id)) return refreshing.get(device.id);
    const pending = (async () => {
      if (!device.githubRefreshToken || device.githubRefreshExpiresAt <= now()) throw new Error('github_reconnect_required');
      const response = await request('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: config.clientId, grant_type: 'refresh_token', refresh_token: device.githubRefreshToken }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new Error('github_refresh_failed');
      const result = await response.json();
      if (result.error || typeof result.access_token !== 'string' || !/^[a-zA-Z0-9_]{1,512}$/.test(result.access_token) || !result.refresh_token) throw new Error('github_refresh_failed');
      const fields = tokenFields(result);
      const identity = await github('/user', result.access_token);
      if (!identity.ok || (await identity.json()).login !== device.user) throw new Error('github_identity_changed');
      const previous = { githubToken: device.githubToken, githubRefreshToken: device.githubRefreshToken, githubExpiresAt: device.githubExpiresAt, githubRefreshExpiresAt: device.githubRefreshExpiresAt };
      Object.assign(device, fields, { githubToken: result.access_token });
      try { save(); } catch (error) { Object.assign(device, previous); throw error; }
    })();
    refreshing.set(device.id, pending);
    try { await pending; } finally { refreshing.delete(device.id); }
  };
  const authenticate = async auth => {
    let token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    let publicKey;
    if (auth?.startsWith('Basic ')) {
      const pair = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      if (pair.length !== 2 || !pair[1].startsWith('sk-lf-device-')) return null;
      publicKey = pair[0]; token = pair[1].slice('sk-lf-device-'.length);
    }
    if (!/^acd_[a-f0-9]{64}$/.test(token)) return null;
    const digest = sha(token), device = devices[digest];
    if (!device || device.revoked || publicKey && publicKey !== 'pk-lf-device-' + device.id) return null;
    await refresh(device);
    if (device.revoked) return null;
    const checked = checks.get(digest);
    if (!checked || now() - checked >= 60000) {
      if (!await member(device.githubToken, device.user)) { checks.delete(digest); return null; }
      checks.set(digest, now());
    }
    return device;
  };
  const auth = 'Basic ' + Buffer.from(config.langfuse.public_key + ':' + config.langfuse.secret_key).toString('base64');
  const lf = (route, options = {}) => request(destination.origin + '/api/public' + route, { ...options, headers: { Authorization: auth, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  const readJSON = async req => {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > limitBytes) throw new Error('body_limit');
    return bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
  };
  return {
    revoke(id) { const device = Object.values(devices).find(value => value.id === id); if (!device) return false; device.revoked = true; save(); return true; },
    async handle(req, peer = 'local') {
      try {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/v1/info') return Response.json({ clientId: config.clientId, organization: config.organization, team: config.team || null });
        if (req.method === 'POST' && url.pathname === '/v1/enroll') {
          if (!rate('enroll:' + peer, 10)) return failure(429, 'rate_limited');
          const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
          if (!token || token.length > 512 || !/^[a-zA-Z0-9_]+$/.test(token)) return failure(401, 'github_auth_required');
          const body = await readJSON(req);
          let fields;
          try { fields = tokenFields(body); } catch { return failure(400, 'invalid_oauth_tokens'); }
          const result = await github('/user', token);
          if (!result.ok) return failure(401, 'github_auth_required');
          const user = (await result.json()).login;
          if (!/^[a-zA-Z0-9-]{1,39}$/.test(user) || !await member(token, user)) return failure(403, 'membership_required');
          if (Object.values(devices).filter(value => value.user === user && !value.revoked).length >= 20) return failure(409, 'device_limit');
          const key = 'acd_' + crypto.randomBytes(32).toString('hex');
          const id = crypto.randomBytes(16).toString('hex');
          devices[sha(key)] = { id, user, githubToken: token, ...fields, revoked: false, traces: {} };
          save();
          return Response.json({ device: id, user, token: key });
        }
        const device = await authenticate(req.headers.get('authorization'));
        if (!device) return failure(401, 'device_access_denied');
        if (req.method === 'POST' && url.pathname === '/v1/compress') {
          if (!rate('compress:' + device.id, 60) || compressing >= 8) return failure(429, 'rate_limited');
          const body = await readJSON(req);
          if (typeof body.context !== 'string' || body.context.length > 100000 || typeof body.query !== 'string' || !body.query.trim() || body.query.length > 100000 || typeof body.session_id !== 'string' || body.session_id.length > 128 || !['codex', 'claude-code', 'hermes', 'headroom', 'Codex', 'Claude Code', 'Hermes'].includes(body.coding_agent)) return failure(400, 'invalid_compression_request');
          const requestId = sha(device.id + '\0' + body.context + '\0' + body.query + '\0' + body.session_id);
          let response;
          compressing++;
          try {
            response = await request('https://www.supercompress.dev/api/v1/compress', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.supercompressKey, 'Idempotency-Key': requestId }, body: JSON.stringify({ context: body.context, query: body.query, session_id: sha(device.id + '\0' + body.session_id), request_id: requestId, ccr: true, mode: 'compiler', coding_agent: body.coding_agent, source: 'agent-context' }), signal: AbortSignal.timeout(10000), redirect: 'error' });
          } finally { compressing--; }
          if (!response.ok) return failure(502, 'compressor_unavailable');
          const result = await response.json();
          return Response.json(Object.fromEntries(['compressed_text', 'compressed_context', 'compressed', 'original_tokens', 'kept_tokens', 'compressed_tokens'].filter(key => typeof result[key] === 'string' || Number.isFinite(result[key])).map(key => [key, result[key]])));
        }
        if (req.method === 'POST' && url.pathname === '/api/public/otel/v1/traces') {
          if (!rate('telemetry:' + device.id, 120)) return failure(429, 'rate_limited');
          const body = await readJSON(req);
          if (!Array.isArray(body.resourceSpans)) return failure(400, 'invalid_otlp');
          const ids = [];
          for (const resource of body.resourceSpans) {
            if (resource.resource?.attributes) resource.resource.attributes = resource.resource.attributes.filter(attr => !['langfuse.user.id', 'user.id', 'langfuse.trace.tags', 'agent_context.device', 'agent_context.user'].includes(attr.key));
            for (const scope of resource.scopeSpans || []) for (const span of scope.spans || []) {
            if (!/^[a-f0-9]{32}$/i.test(span.traceId) || !/^[a-f0-9]{16}$/i.test(span.spanId) || !Array.isArray(span.attributes)) return failure(400, 'invalid_otlp');
            const attrs = span.attributes;
            const tagValue = attrs.find(attr => attr.key === 'langfuse.trace.tags')?.value;
            let tags = tagValue?.arrayValue?.values || [];
            if (tagValue?.stringValue) {
              try { const values = JSON.parse(tagValue.stringValue); if (Array.isArray(values)) tags = values.filter(value => typeof value === 'string').map(stringValue => ({ stringValue })); } catch {}
            }
            const host = attrs.find(attr => attr.key === 'agent_context.host')?.value?.stringValue;
            if (host != null && !label(host)) return failure(400, 'invalid_identity');
            span.attributes = attrs.filter(attr => !['langfuse.user.id', 'user.id', 'langfuse.trace.tags', 'agent_context.device', 'agent_context.user'].includes(attr.key));
            span.attributes.push({ key: 'langfuse.user.id', value: { stringValue: device.user } }, { key: 'agent_context.device', value: { stringValue: device.id } }, { key: 'agent_context.user', value: { stringValue: device.user } }, { key: 'langfuse.trace.tags', value: { arrayValue: { values: [...tags.filter(tag => typeof tag.stringValue === 'string' && !/^(user|device):/.test(tag.stringValue)), { stringValue: 'user:' + device.user }, { stringValue: 'device:' + device.id }] } } });
            ids.push(span.traceId.toLowerCase());
            if (ids.length > 1000) return failure(413, 'span_limit');
            // Namespace trace IDs so a device cannot append to/read another device or legacy trace.
            span.attributes = span.attributes.filter(attr => attr.key !== 'agent_context.native_trace_id');
            span.attributes.push({ key: 'agent_context.native_trace_id', value: { stringValue: span.traceId.toLowerCase() } });
            span.traceId = gatewayTraceId(device.id, span.traceId);
            for (const link of span.links || []) if (/^[a-f0-9]{32}$/i.test(link.traceId)) link.traceId = gatewayTraceId(device.id, link.traceId);
            }
          }
          // Only uploaded native IDs can be read back; the shared project API stays private.
          for (const id of ids) device.traces[id] = now();
          const cutoff = now() - 7 * 86400000;
          for (const [id, time] of Object.entries(device.traces)) if (time < cutoff) delete device.traces[id];
          if (Object.keys(device.traces).length > 10000) device.traces = Object.fromEntries(Object.entries(device.traces).sort((a, b) => b[1] - a[1]).slice(0, 10000));
          save();
          const response = await lf('/otel/v1/traces', { method: 'POST', body: JSON.stringify(body) });
          if (!response.ok) return failure(502, 'telemetry_unavailable');
          const result = await response.json();
          if (Number(result.partialSuccess?.rejectedSpans) > 0) return failure(502, 'telemetry_partially_rejected');
          return Response.json({});
        }
        if (req.method === 'GET' && url.pathname === '/api/public/v2/observations') {
          const id = url.searchParams.get('traceId');
          if (!/^[a-f0-9]{32}$/.test(id) || !device.traces[id] || [...url.searchParams.keys()].some(key => !['traceId', 'fields', 'limit'].includes(key))) return failure(403, 'trace_access_denied');
          if (!rate('readback:' + device.id, 120)) return failure(429, 'rate_limited');
          const storedId = gatewayTraceId(device.id, id);
          const response = await lf('/v2/observations?traceId=' + storedId + '&fields=core,basic,trace_context&limit=100');
          if (!response.ok) return failure(502, 'readback_unavailable');
          const result = await response.json();
          return Response.json({ ...result, data: (result.data || []).filter(row => row.traceId === storedId).map(row => ({ ...row, traceId: id })) });
        }
        return failure(404, 'unsupported_route');
      } catch { return failure(503, 'gateway_unavailable'); }
    }
  };
}
