import test from 'node:test';
import assert from 'node:assert/strict';
import { compressSupercompress } from '../src/supercompress.js';

test('stateless provider replays content and preserves the query without MCP deduplication', async () => {
  const input = { context: 'large context '.repeat(400), query: 'Keep this exact question?', session: 'replay', agent: 'headroom' };
  let calls = 0;
  const options = { credentials: { present: true, key: 'test' }, fetch: async (_, request) => {
    calls++;
    assert.equal(JSON.parse(request.body).query, input.query);
    return { ok: true, json: async () => ({ compressed_text: 'short answer' }) };
  } };
  for (let i = 0; i < 2; i++) assert.equal((await compressSupercompress(input, options)).compressed_text, 'short answer');
  assert.equal(calls, 2);
  const failed = await compressSupercompress(input, { ...options, fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal(failed.compressed_text, input.context);
  assert.equal(failed.skipped, 'http_503');
});
