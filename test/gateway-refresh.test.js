import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/gateway.js';
import { connectGateway } from '../src/enrollment.js';
import { verifyTelemetry } from '../src/telemetry.js';

test('Device Flow transfers refresh credentials only to private gateway state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-refresh-client-'));
  const before = process.env.AGENT_CONTEXT_HOME;
  process.env.AGENT_CONTEXT_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.AGENT_CONTEXT_HOME; else process.env.AGENT_CONTEXT_HOME = before; fs.rmSync(dir, { recursive: true, force: true }); });
  const announcements = [];
  const report = await connectGateway('https://gateway.invalid', { pause: async () => {}, announce: text => announcements.push(text), request: async (url, options) => {
    if (url.endsWith('/v1/info')) return Response.json({ clientId: 'client', organization: 'org' });
    if (url.endsWith('/device/code')) return Response.json({ verification_uri: 'https://github.com/login/device', device_code: 'private', user_code: 'ABCD-EFGH', expires_in: 900, interval: 5 });
    if (url.endsWith('/oauth/access_token')) return Response.json({ access_token: 'gh_access', refresh_token: 'gh_refresh', expires_in: 28800, refresh_token_expires_in: 15897600 });
    assert.equal(options.headers.Authorization, 'Bearer gh_access');
    assert.deepEqual(JSON.parse(options.body), { refresh_token: 'gh_refresh', expires_in: 28800, refresh_token_expires_in: 15897600 });
    return Response.json({ device: 'a'.repeat(32), token: 'acd_' + 'b'.repeat(64), user: 'employee' });
  } });
  const saved = fs.readFileSync(path.join(dir, '.agent-context/enrollment.json'), 'utf8');
  for (const output of [saved, JSON.stringify(report), announcements.join('')]) assert.doesNotMatch(output, /gh_access|gh_refresh/);
});

test('gateway rotates once concurrently, persists across restart and fails closed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-refresh-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { stateDir: dir, clientId: 'client', organization: 'org', langfuse: { base_url: 'https://langfuse.invalid', public_key: 'pk-lf-' + 'p'.repeat(20), secret_key: 'sk-lf-' + 's'.repeat(20) }, supercompressKey: 'sc_' + 'c'.repeat(30) };
  let now = 1000, rotations = 0, mode = 'ok', active = true;
  const request = async (url, options) => {
    if (url.endsWith('/oauth/access_token')) {
      rotations++;
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, 'client');
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.client_secret, undefined);
      assert.equal(options.redirect, 'error');
      await new Promise(resolve => setImmediate(resolve));
      if (mode === 'offline') throw new Error('offline');
      if (mode === 'invalid') return Response.json({ error: 'bad_refresh_token' });
      if (mode === 'malformed') return Response.json({ access_token: 'gh_new', refresh_token: 'gh_next', expires_in: -1, refresh_token_expires_in: 10000 });
      return Response.json({ access_token: 'gh_new', refresh_token: 'gh_next', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (url.endsWith('/user')) return Response.json({ login: mode === 'wronguser' ? 'other' : 'employee' });
    if (url.includes('/memberships/')) return Response.json({ state: active ? 'active' : 'pending' });
    throw new Error('unexpected route');
  };
  const make = () => createGateway(config, { request, now: () => now });
  let gateway = make();
  const call = (route, token, body = {}) => gateway.handle(new Request('https://gateway.invalid' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }));
  const original = { refresh_token: 'gh_oldrefresh', expires_in: 120, refresh_token_expires_in: 15897600 };
  assert.equal((await call('/v1/enroll', 'gh_old', { ...original, expires_in: '120' })).status, 400);
  const device = await (await call('/v1/enroll', 'gh_old', original)).json();
  now += 60001;
  assert.deepEqual((await Promise.all([call('/unused', device.token), call('/unused', device.token)])).map(r => r.status), [404, 404]);
  assert.equal(rotations, 1);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'devices.json')));
  const record = Object.values(stored)[0];
  assert.equal(record.githubToken, 'gh_new');
  assert.equal(record.githubRefreshToken, 'gh_next');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'devices.json')).mode & 0o777, 0o600);
  gateway = make();
  assert.equal((await call('/unused', device.token)).status, 404);
  assert.equal(rotations, 1);
  now += 28800000;
  const stateFile = path.join(dir, 'devices.json');
  const stateBytes = fs.readFileSync(stateFile);
  fs.rmSync(stateFile);
  fs.mkdirSync(stateFile);
  assert.equal((await call('/unused', device.token)).status, 503);
  fs.rmdirSync(stateFile);
  fs.writeFileSync(stateFile, stateBytes, { mode: 0o600 });
  assert.equal((await call('/unused', device.token)).status, 404);
  now += 28800000;
  for (mode of ['offline', 'invalid', 'malformed', 'wronguser']) {
    const response = await call('/unused', device.token);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /gh_new|gh_next|gh_oldrefresh/);
    assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'devices.json'))))[0].githubRefreshToken, 'gh_next');
  }
  mode = 'ok'; active = false;
  assert.equal((await call('/unused', device.token)).status, 401);
  now += 15897600001;
  const count = rotations;
  assert.equal((await call('/unused', device.token)).status, 503);
  assert.equal(rotations, count);
});


test('gateway delivery verification waits for queued trace registration but rejects authentication failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-readback-'));
  const before = process.env.AGENT_CONTEXT_HOME;
  process.env.AGENT_CONTEXT_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.AGENT_CONTEXT_HOME; else process.env.AGENT_CONTEXT_HOME = before; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, '.agent-context'));
  fs.writeFileSync(path.join(dir, '.agent-context/enrollment.json'), JSON.stringify({ gateway: 'https://gateway.invalid', device: 'a'.repeat(32), token: 'acd_' + 'b'.repeat(64), user: 'employee' }));
  let reads = 0, trace;
  const send = async (config, probe) => { trace = probe; return 'accepted'; };
  const report = await verifyTelemetry('codex', async () => {
    if (++reads < 3) return Response.json({ error: 'trace_access_denied' }, { status: 403 });
    return Response.json({ data: [{ traceId: trace.id, sessionId: trace.sessionId, environment: 'qualification', tags: trace.tags }] });
  }, async () => {}, send);
  assert.equal(report.status, 'delivered');
  assert.equal(reads, 3);
  const denied = await verifyTelemetry('codex', async () => Response.json({}, { status: 401 }), async () => {}, send);
  assert.equal(denied.status, 'readback_failed');
  assert.equal(denied.httpStatus, 401);
  const missing = await verifyTelemetry('codex', async () => Response.json({}, { status: 403 }), async () => {}, send);
  assert.equal(missing.status, 'accepted_not_observed');
});
