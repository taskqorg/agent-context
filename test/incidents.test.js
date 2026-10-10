import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordIncident, incidents, reportIncidents, incidentPolicy } from '../src/incidents.js';
import { root } from '../src/core.js';
process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-incidents-'));
const event = { component: 'compressor', operation: 'compress', category: 'timeout', agent: 'codex' };
test('one safe packet aggregates repeat failures; rejects free text and never removes another writer lock', () => {
  const a = recordIncident({ ...event, secret: 'private value' });
  const b = recordIncident(event);
  assert.equal(a.event_id, b.event_id); assert.equal(b.occurrences, 2);
  assert.ok(!JSON.stringify(incidents()).includes('private value'));
  assert.equal(recordIncident({ ...event, category: 'secret-path-/private' }), null);
  const lock = path.join(root(), 'incidents/write.lock'); fs.mkdirSync(lock);
  assert.equal(recordIncident(event), null); assert.ok(fs.existsSync(lock)); fs.rmdirSync(lock);
});
test('reporting is opt-in until disclosed setup; unknown create is reconciled and not retried blindly', async () => {
  let calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    if (args[1] === 'list') return { stdout: '[]' };
    throw new Error('unknown create outcome containing secret');
  };
  assert.equal((await reportIncidents(run)).status, 'disabled'); assert.equal(calls.length, 0);
  incidentPolicy(true);
  await reportIncidents(run); await reportIncidents(run);
  assert.equal(calls.filter(x => x[1] === 'create').length, 1);
  assert.ok(!JSON.stringify(incidents()).includes('containing secret'));
  const item = incidents()[0];
  recordIncident({ component: 'installer', operation: 'doctor', category: 'missing_key' });
  calls = [];
  const recovered = await reportIncidents(async (_cmd, args) => {
    calls.push(args);
    return { stdout: JSON.stringify([{ number: 42, state: 'OPEN', body: `incident-v1:${item.fingerprint} event:${item.event_id}`, url: 'https://github.com/taskqorg/agent-context/issues/42' }]) };
  });
  assert.equal(recovered.results[0].status, 'reported'); assert.equal(calls.length, 1);
  const file = path.join(root(), 'incidents', item.fingerprint + '.json');
  const saved = JSON.parse(fs.readFileSync(file)); saved.last_reported = '2020-01-01T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(saved));
  await reportIncidents(async () => { throw new Error('no new event must not deliver'); });
  assert.equal(JSON.parse(fs.readFileSync(file)).state, 'reported');
});
test('report lock and offline transport preserve local queue without exposing errors', async () => {
  const lock = path.join(root(), 'incidents/report.lock');
  fs.mkdirSync(lock);
  assert.equal((await reportIncidents(() => { throw new Error('must not call'); })).status, 'busy');
  assert.ok(fs.existsSync(lock)); fs.rmdirSync(lock);
  recordIncident({ ...event, category: 'request_failed' });
  const result = await reportIncidents(async () => { throw new Error('private offline details'); });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(incidents().some(item => item.category === 'request_failed' && item.state === 'queued'));
});
