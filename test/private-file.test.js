import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicSecretWrite } from '../src/private-file.js';

test('Windows protects the empty temp file before writing secrets and preserves the original on ACL refusal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-private-'));
  process.env.AGENT_CONTEXT_HOME = dir;
  const file = path.join(dir, 'credentials.json');
  const beforeModules = process.env.PSModulePath;
  process.env.PSModulePath = 'synthetic-modern-module';
  fs.writeFileSync(file, 'original');
  try {
    assert.throws(() => atomicSecretWrite(file, 'private-value', { platform: 'win32', execute: (_exe, args, options) => {
      assert.equal(fs.readFileSync(options.env.AGENT_CONTEXT_PRIVATE_FILE, 'utf8'), '');
      assert.equal(args.join(' ').includes('private-value'), false);
      throw new Error('ACL refused');
    } }), /ACL refused/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['credentials.json']);
    atomicSecretWrite(file, 'private-value', { platform: 'win32', execute: (_exe, args, options) => {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.equal('PSModulePath' in options.env, false);
      assert.equal(process.env.PSModulePath, 'synthetic-modern-module');
      assert.ok(script.includes('$acl.SetAccessRuleProtection($true,$false)'));
      assert.ok(script.includes('S-1-5-18'));
      assert.ok(script.includes('S-1-5-32-544'));
      assert.equal(fs.readFileSync(options.env.AGENT_CONTEXT_PRIVATE_FILE, 'utf8'), '');
    } });
    assert.equal(fs.readFileSync(file, 'utf8'), 'private-value');
    assert.throws(() => atomicSecretWrite(file, 'replacement', { platform: 'win32', exclusive: true, execute: () => {} }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'private-value');
  } finally { if (beforeModules === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = beforeModules; fs.rmSync(dir, { recursive: true, force: true }); }
});
