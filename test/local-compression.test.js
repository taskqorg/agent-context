import test from 'node:test';
import assert from 'node:assert/strict';
import { compressLocal } from '../src/local-compression.js';

test('local stateless provider needs no credentials, never fetches, and preserves replay', async () => {
  const input = { context: 'large context '.repeat(400), query: 'Keep this exact question?' };
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('compression cannot use a remote API');
  try {
    const options = { run: async value => { calls++; assert.deepEqual(value, input); return { compressed_text: 'short answer' }; } };
    for (let i = 0; i < 2; i++) assert.equal((await compressLocal(input, options)).compressed_text, 'short answer');
    assert.equal(calls, 2);
    const failed = await compressLocal(input, { run: async () => { throw new Error('private failure'); } });
    assert.equal(failed.compressed_text, input.context);
    assert.equal(failed.skipped, 'local_compressor_unavailable');
  } finally { globalThis.fetch = original; }
});
