import test from 'node:test';
import assert from 'node:assert/strict';
import { readServiceq } from '../src/serviceq-reader.js';
const now = Date.parse('2026-10-13T00:00:00Z');
test('R9 reader fetches both compression streams with bounded metadata-only pagination', async () => {
  const requests = [];
  const result = await readServiceq('https://example.invalid', 'Basic private', now, 1800, async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('fields'), url.searchParams.get('type') === 'GENERATION' ? 'core,basic,trace_context,metadata,model,usage' : 'core,basic,trace_context,metadata');
    const native = url.searchParams.get('name') === 'agent-context.native-tool';
    return Response.json({ data: native ? [{ id: url.searchParams.get('cursor') ? 'two' : 'one' }] : [], meta: native && !url.searchParams.has('cursor') ? { nextCursor: 'next' } : {} });
  });
  assert.deepEqual(result.nativeTools.map(r => r.id), ['one', 'two']);
  assert.ok(requests.some(u => u.searchParams.get('name') === 'agent-context.compression'));
  assert.deepEqual(result.truncated, []);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('R9 capped reads explicitly report incomplete native estimates; bad cursors and response failures fail closed', async () => {
  let page = 0;
  const result = await readServiceq('https://example.invalid', 'private', now, 1800, async url => Response.json(url.searchParams.get('name') === 'agent-context.native-tool' ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), meta: { cursor: 'cursor-' + (++page) } } : { data: [], meta: {} }));
  assert.equal(result.nativeTools.length, 10000); assert.deepEqual(result.truncated, ['nativeTools']);
  await assert.rejects(readServiceq('https://example.invalid', 'private', now, 1800, async () => Response.json({ data: [], meta: { cursor: 'same' } })), /Repeated/);
  await assert.rejects(readServiceq('https://example.invalid', 'private', now, 1800, async () => new Response('', { status: 503 })), /read failed/);
});
