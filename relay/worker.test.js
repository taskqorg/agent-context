import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Incident, validPacket, issueBody } from './worker.js';

const packet = (machine, occurrences = 1) => ({ schema: 1, observed_at: '2026-10-11T00:00:00.000Z', state: 'observed', product: 'agent-context',
  component: 'proxy', operation: 'ensure', category: 'startup_failed', agent: 'codex', fingerprint: 'a'.repeat(24),
  event_id: '11111111-1111-4111-8111-111111111111', machine_id: machine,
  environment: { os: 'darwin', topology: 'native', project_location: 'unknown', agent: 'codex' },
  versions: { package: '0.1.13', node: 'v22.0.0', adapter: '0.1.13', agent: 'unknown', python: 'unknown', headroom: 'unknown' },
  occurrences_observed_locally: occurrences });

function durable() {
  const stored = new Map();
  const object = new Incident({ storage: { get: async k => stored.get(k), put: async (k, v) => stored.set(k, v) } }, {});
  return { object, stored, env: { INCIDENTS: { idFromName: name => name, get: () => ({ fetch: (_u, init) => object.fetch(new Request('https://do/report', init)) }) } } };
}
const post = (env, body, ip = '198.51.100.1') => worker.fetch(new Request('https://relay/v1/incidents', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);

test('relay rejects free-form or oversized input', async () => {
  const { env } = durable();
  assert.equal((await post(env, { ...packet('m'), secret: 'x', component: 'shell' })).status, 422);
  assert.equal((await post(env, 'x'.repeat(9000))).status, 413);
  assert.equal(validPacket(packet('22222222-2222-4222-8222-222222222222')), true);
});

test('relay counts unique machines, rate-limits repeats and never stores raw machine ids', async () => {
  const { env, stored } = durable();
  const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  for (const [i, id] of ids.entries()) assert.equal((await (await post(env, packet(id, 2), `198.51.100.${i + 1}`)).json()).status, 'accepted');
  assert.equal((await (await post(env, packet(ids[0], 5), '198.51.100.1')).json()).status, 'duplicate');
  // Sybil: fresh machine ids from an already-counted network source do not raise the count.
  assert.equal((await (await post(env, packet('55555555-5555-4555-8555-555555555555', 1e9), '198.51.100.1')).json()).status, 'duplicate');
  const record = stored.get('record');
  assert.equal(Object.keys(record.sources).length, 3);
  assert.equal(record.occurrences, 6);
  assert.equal((await (await post(env, packet('66666666-6666-4666-8666-666666666666', 1e9), '198.51.100.9')).json()).machines, 4);
  assert.equal(stored.get('record').occurrences, 106, 'one report adds at most 100');
  assert.ok(!JSON.stringify(record).includes(ids[0]));
  assert.match(issueBody(record, 3), /Unique machines: \*\*3\*\*/);
});
