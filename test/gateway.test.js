import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway, gatewayTraceId } from '../src/gateway.js';
import { connectGateway, enrollment, deviceCredentials, gatewayURL } from '../src/enrollment.js';
import { keyStatus } from '../src/core.js';
import { compressSupercompress } from '../src/supercompress.js';
import { langfuseConfig } from '../src/telemetry.js';
import { automaticPlan } from '../src/automatic.js';
import { serveGateway } from '../src/gateway-server.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-gateway-'));
process.env.AGENT_CONTEXT_HOME = path.join(directory, 'client');
const config = { organization: 'testorg', clientId: 'testclient', stateDir: path.join(directory, 'server'), langfuse: { public_key: 'pk-lf-' + 'p'.repeat(20), secret_key: 'sk-lf-' + 's'.repeat(20), base_url: 'https://langfuse.invalid' }, supercompressKey: 'sc_' + 'c'.repeat(30) };
let member = true, now = 1000;
const calls = [];
const provider = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.redirect, 'error');
  if (url === 'https://api.github.com/user') return Response.json({ login: 'employee' });
  if (url.includes('/memberships/')) return Response.json({ state: member ? 'active' : 'pending' });
  if (url.includes('supercompress')) return Response.json({ compressed_text: 'short', secret_debug: config.supercompressKey });
  if (url.endsWith('/otel/v1/traces')) return Response.json({});
  if (url.includes('/v2/observations')) return Response.json({ data: [] });
  throw new Error('unexpected destination');
};
const gateway = createGateway(config, { request: provider, now: () => now });
const call = (route, { token, body, method = 'POST' } = {}) => gateway.handle(new Request('https://gateway.invalid' + route, { method, headers: { ...(token ? { Authorization: token } : {}), 'Content-Type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) }));
let device;

test('gateway refuses invalid listener ports before starting a service', async () => {
  const file = path.join(directory, 'config.json');
  for (const port of [0, -1, 65536, '18880']) {
    fs.writeFileSync(file, JSON.stringify({ ...config, port }), { mode: 0o600 });
    await assert.rejects(serveGateway(file), /Unsupported gateway port/);
  }
});

test('enrollment rejects nonmembers and returns only scoped device access to members', async () => {
  member = false;
  assert.equal((await call('/v1/enroll', { token: 'Bearer gh_fake' })).status, 403);
  member = true;
  const response = await call('/v1/enroll', { token: 'Bearer gh_fake' });
  device = await response.json();
  assert.equal(response.status, 200);
  assert.ok(/^acd_[a-f0-9]{64}$/.test(device.token));
  const stored = fs.readFileSync(path.join(config.stateDir, 'devices.json'), 'utf8');
  assert.equal(stored.includes(device.token), false);
  assert.equal(fs.statSync(path.join(config.stateDir, 'devices.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(device).includes(config.langfuse.secret_key), false);
});

test('chat onboarding emits only the public browser code and stores device token privately', async () => {
  const announcements = [];
  let polls = 0;
  const request = async (url, options = {}) => {
    if (url === 'https://gateway.invalid/v1/info') return Response.json({ organization: config.organization, clientId: config.clientId });
    if (url.endsWith('/device/code')) return Response.json({ verification_uri: 'https://github.com/login/device', device_code: 'private-code', user_code: 'ABCD-EFGH', interval: 5, expires_in: 900 });
    if (url.endsWith('/oauth/access_token')) return Response.json(++polls === 1 ? { error: 'slow_down' } : { access_token: 'gh_fake' });
    return gateway.handle(new Request(url, options));
  };
  const report = await connectGateway('https://gateway.invalid', { request, pause: async () => {}, announce: value => announcements.push(value) });
  assert.equal(report.status, 'connected');
  assert.equal(announcements.join('').includes('private-code'), false);
  assert.equal(JSON.stringify(report).includes(enrollment().token), false);
  assert.equal(fs.statSync(path.join(process.env.AGENT_CONTEXT_HOME, '.agent-context/enrollment.json')).mode & 0o777, 0o600);
  assert.equal(keyStatus().gateway, 'https://gateway.invalid');
  assert.equal(langfuseConfig().gateway, true);
  assert.throws(() => gatewayURL('http://gateway.invalid'));
  assert.throws(() => gatewayURL('https://user:secret@gateway.invalid'));
});

test('compression uses device credentials, preserves the query and falls back during outage', async () => {
  const input = { context: 'synthetic result '.repeat(400), query: 'Keep my question exactly?', agent: 'codex', session: 'session' };
  const result = await compressSupercompress(input, { fetch: (url, options) => gateway.handle(new Request(url, options)) });
  assert.equal(result.compressed_text, 'short');
  const paid = calls.find(call => call.url.includes('supercompress'));
  assert.equal(JSON.parse(paid.options.body).query, input.query);
  assert.equal(JSON.parse(paid.options.body).session_id.includes('session'), false);
  const fallback = await compressSupercompress(input, { fetch: async () => { throw new Error('offline'); } });
  assert.equal(fallback.compressed_text, input.context);
});

test('telemetry binds employee/device identity, readback is device scoped, and arbitrary APIs are denied', async () => {
  const traceId = 'a'.repeat(32);
  const body = { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId: 'b'.repeat(16), attributes: [{ key: 'langfuse.user.id', value: { stringValue: 'forged' } }, { key: 'langfuse.trace.tags', value: { arrayValue: { values: [{ stringValue: 'agent:codex' }, { stringValue: 'user:forged' }] } } }] }] }] }] };
  const credentials = deviceCredentials({ ...device, device: device.device });
  const token = 'Basic ' + Buffer.from(credentials.public_key + ':' + credentials.secret_key).toString('base64');
  assert.equal((await call('/api/public/otel/v1/traces', { token, body })).status, 200);
  const forwarded = JSON.parse(calls.find(call => call.url.endsWith('/otel/v1/traces')).options.body);
  const attrs = forwarded.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.equal(forwarded.resourceSpans[0].scopeSpans[0].spans[0].traceId, gatewayTraceId(device.device, traceId));
  assert.equal(attrs.find(attr => attr.key === 'langfuse.user.id').value.stringValue, 'employee');
  assert.equal(attrs.find(attr => attr.key === 'agent_context.device').value.stringValue, device.device);
  assert.equal((await call('/api/public/v2/observations?traceId=' + traceId, { token, method: 'GET' })).status, 200);
  assert.equal((await call('/api/public/v2/observations?traceId=' + 'c'.repeat(32), { token, method: 'GET' })).status, 403);
  assert.equal((await call('/api/public/projects', { token, method: 'GET' })).status, 404);
  assert.equal((await call('/api/public/otel/v1/traces', { body })).status, 401);
});

test('installed native exporters route through local outboxes without service master keys', () => {
  const home = process.env.AGENT_CONTEXT_HOME;
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.supercompress]\ncommand="fixture"\n');
  const plan = automaticPlan({ changes: [], installed: ['codex'], moves: [] });
  const value = JSON.parse(plan.changes.find(item => item.file.endsWith('/langfuse.json')).after);
  assert.equal(value.base_url, 'http://127.0.0.1:18787');
  assert.equal(value.secret_key, deviceCredentials().secret_key);
  assert.equal(JSON.stringify(plan).includes(config.langfuse.secret_key), false);
  fs.writeFileSync(path.join(home, '.codex/langfuse.json'), '{"enabled":false}');
  assert.equal(langfuseConfig(), null);
  fs.rmSync(path.join(home, '.codex/langfuse.json'));
  const enrollmentFile = path.join(home, '.agent-context/enrollment.json');
  const bytes = fs.readFileSync(enrollmentFile);
  fs.writeFileSync(enrollmentFile, '{}');
  assert.equal(keyStatus().present, false);
  assert.equal(langfuseConfig(), null);
  fs.writeFileSync(enrollmentFile, bytes);
});

test('team gate and partially rejected ingestion fail closed', async () => {
  const stateDir = path.join(directory, 'team-server');
  let active = false;
  const instance = createGateway({ ...config, team: 'agents', stateDir }, { request: async (url, options) => {
    if (url === 'https://api.github.com/user') return Response.json({ login: 'employee' });
    if (url.includes('/teams/agents/memberships/employee')) return Response.json({ state: active ? 'active' : 'pending' });
    if (url.endsWith('/otel/v1/traces')) return Response.json({ partialSuccess: { rejectedSpans: 1 } });
    throw new Error('unexpected provider');
  } });
  const enroll = () => instance.handle(new Request('https://gateway.invalid/v1/enroll', { method: 'POST', headers: { Authorization: 'Bearer gh_fake' } }));
  assert.equal((await enroll()).status, 403);
  active = true;
  const access = await (await enroll()).json();
  const response = await instance.handle(new Request('https://gateway.invalid/api/public/otel/v1/traces', { method: 'POST', headers: { Authorization: 'Bearer ' + access.token }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'f'.repeat(32), spanId: 'e'.repeat(16), attributes: [] }] }] }] }) }));
  assert.equal(response.status, 502);
});

test('removing GitHub membership denies existing devices after bounded recheck; explicit revoke is immediate', async () => {
  member = false; now += 60001;
  assert.equal((await call('/v1/compress', { token: 'Bearer ' + device.token })).status, 401);
  member = true;
  assert.equal(gateway.revoke(device.device), true);
  assert.equal((await call('/v1/compress', { token: 'Bearer ' + device.token })).status, 401);
  fs.rmSync(directory, { recursive: true, force: true });
});
