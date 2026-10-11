import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveLangfuse } from '../src/credentials.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-credential-'));
process.env.AGENT_CONTEXT_HOME = home;
const file = path.join(home, '.codex/langfuse.json');
const credentials = { public_key: 'pk-lf-synthetic_public_key_only', secret_key: 'sk-lf-synthetic_secret_key_only', base_url: 'https://example.invalid' };
test('private onboarding preserves metadata, saves credentials with restricted mode and never returns keys', () => {
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify({ tags: ['owner:keep'], enabled: false }));
  const result = saveLangfuse(JSON.stringify(credentials));
  const config = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(config.tags, ['owner:keep']); assert.equal(config.enabled, true);
  assert.equal(config.secret_key, credentials.secret_key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes(credentials.secret_key), false);
  assert.equal(result.delivery, 'unverified');
});
test('invalid input or existing broken config cannot destroy the owner configuration', () => {
  const before = fs.readFileSync(file);
  for (const value of ['not-json', JSON.stringify({ ...credentials, secret_key: '' }), JSON.stringify({ ...credentials, base_url: 'https://user:password@example.invalid' })]) {
    assert.throws(() => saveLangfuse(value)); assert.deepEqual(fs.readFileSync(file), before);
  }
  fs.writeFileSync(file, '{invalid');
  assert.throws(() => saveLangfuse(JSON.stringify(credentials)), /preserve/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});
