import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressSupercompress } from '../src/supercompress.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-neural-'));
process.env.AGENT_CONTEXT_HOME = directory;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('stateless provider replays content and preserves the query without MCP deduplication', async () => {
  const input = { context: 'large context '.repeat(400), query: 'Keep this exact question?', session: 'replay', agent: 'headroom' };
  let calls = 0;
  const options = { credentials: { present: true, key: 'test' }, fetch: async (_, request) => {
    calls++;
    assert.equal(JSON.parse(request.body).query, input.query);
    assert.equal(JSON.parse(request.body).mode, 'neural');
    assert.equal(JSON.parse(request.body).ccr, undefined);
    return { ok: true, json: async () => ({ mode: 'neural-keep', compressed_text: 'short answer' }) };
  } };
  for (let i = 0; i < 2; i++) assert.equal((await compressSupercompress(input, options)).compressed_text, 'short answer');
  assert.equal(calls, 2);
  const failed = await compressSupercompress(input, { ...options, fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal(failed.compressed_text, input.context);
  assert.equal(failed.skipped, 'http_503');
});


test('Neural never accepts compiler, provider fallback or an unidentified engine', async () => {
  const input = { context: 'large context '.repeat(400), query: 'What matters?', session: 'neural-only', agent: 'headroom' };
  for (const metadata of [{ mode: 'compiler' }, { mode: 'neural-keep', neural_keep_fallback: true }, {}]) {
    const result = await compressSupercompress(input, { credentials: { present: true, key: 'test' }, fetch: async () => ({ ok: true, json: async () => ({ compressed_text: 'short', ...metadata }) }) });
    assert.equal(result.skipped, 'neural_unavailable');
    assert.equal(result.compressed_text, input.context);
  }
});
