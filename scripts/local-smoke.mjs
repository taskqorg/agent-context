// Isolated loopback qualification. Never point AGENT_CONTEXT_HOME at a live profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startProxy } from '../src/run.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent context local smoke '));
process.env.AGENT_CONTEXT_HOME = work;
process.env.AGENT_CONTEXT_LANGFUSE = '0';
const rows = Array.from({ length: 120 }, (_, id) => ({ id, status: 'ok', description: 'Routine background job completed successfully.' }));
rows[37] = { id: 37, status: 'failed', error: 'E42 do not retry until snapshot verified' };
const prose = Array.from({ length: 55 }, (_, i) => `Section ${i}: The operations guide describes how the office collects routine reports. Reports are reviewed each week and archived by the designated coordinator.`);
prose[7] = 'For the amber migration the operator must never delete the snapshot before verification. The retention period is 19 days.';
prose[28] = 'The exception is tenant Juniper: its archive stays for 41 days, and approval must come from Mina.';
prose[47] = 'If verification fails, restore snapshot snap-7c9 and do not restart the billing worker.';
const cases = [
  { name: 'json', context: JSON.stringify(rows, null, 2), query: 'Find the failed job and recovery rule', facts: ['E42', '37'] },
  { name: 'prose', context: prose.join('\n'), query: 'State the amber retention rule, the Juniper exception and approver, and the exact failure recovery restrictions.', facts: ['must never delete', '19 days', '41 days', 'Mina', 'snap-7c9', 'do not restart'] },
];
let proxy;
try {
  proxy = await startProxy();
  const evidence = [];
  for (const item of cases) {
    const started = performance.now();
    const response = await fetch(proxy.url + '/v1/compress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: 'Keep all user instructions.' }, { role: 'user', content: item.query }, { role: 'tool', content: item.context }] }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const body = await response.json(), output = body.messages.at(-1).content;
    assert.equal(body.messages[0].content, 'Keep all user instructions.');
    assert.equal(body.messages[1].content, item.query);
    assert.equal(output, item.context, item.name + ' must preserve content in local-tools proxy');
    for (const fact of item.facts) assert.ok(output.includes(fact), item.name + ': missing ' + fact);
    const hashes = [...output.matchAll(/<<ccr:([a-f0-9]+)\b/g)].map(m => m[1]);
    assert.equal(hashes.length, 0, 'proxy must not introduce lossy retrieval markers');
    evidence.push({ fixture: item.name, input_chars: item.context.length, output_chars: output.length, elapsed_ms: Math.round(performance.now() - started), all_facts_retained: true, retrieval: 'exact_passthrough' });
  }
  const health = await fetch(proxy.url + '/agent-context/health').then(r => r.json());
  assert.equal(health.compressor, 'local-tools');
  assert.equal(health.telemetry, false);
  console.log(JSON.stringify({ platform: process.platform, work, compressor: health.compressor, credentials_required: false, evidence, proof: 'isolated_http_proxy_not_real_agent_or_billing' }, null, 2));
} finally { await proxy?.stop(); }
