import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerSettings, selectProvider } from '../src/providers.js';

test('provider selection persists without claiming the running proxy changed', () => {
  const previous = process.env.AGENT_CONTEXT_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-provider-'));
  process.env.AGENT_CONTEXT_HOME = dir;
  try {
    assert.equal(providerSettings({}).provider, 'local-tools');
    const result = selectProvider('scaledown');
    assert.equal(result.restartRequired, true);
    assert.equal(result.runningProvider, 'not_checked');
    assert.equal(providerSettings({}).provider, 'scaledown');
    assert.equal(providerSettings({ AGENT_CONTEXT_COMPRESSOR: 'supercompress' }).provider, 'supercompress');
    assert.throws(() => selectProvider('unknown'));
    fs.writeFileSync(path.join(dir, '.agent-context/compression.json'), '{"timeout_seconds":0}');
    assert.throws(() => providerSettings({}));
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_HOME; else process.env.AGENT_CONTEXT_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
