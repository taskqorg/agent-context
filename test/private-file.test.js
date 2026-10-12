import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { atomicSecretWrite, writeConfig } from '../src/private-file.js';

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
      assert.ok(script.includes('[System.Security.Principal.WindowsIdentity]::GetCurrent().User'));
      assert.equal(script.includes('AGENT_CONTEXT_PROFILE_DIR'), false);
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

test('real Windows secret file grants only owner, SYSTEM and administrators access', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextq-acl-'));
  process.env.AGENT_CONTEXT_HOME = dir;
  const file = path.join(dir, 'private.json');
  try {
    atomicSecretWrite(file, 'synthetic fixture');
    const script = `$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:AGENT_CONTEXT_TEST_FILE
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Wrong owner'}
$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
$allowed=@($owner,'S-1-5-18','S-1-5-32-544')
if(-not $acl.AreAccessRulesProtected){throw 'Inherited access'}
foreach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow'){throw 'Unexpected access'}}
foreach($sid in $allowed){if(-not ($rules | Where-Object {$_.IdentityReference.Value -eq $sid -and $_.FileSystemRights -eq 'FullControl'})){throw 'Missing access'}}
`;
    const environment = { ...process.env, AGENT_CONTEXT_TEST_FILE: file };
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PSMODULEPATH') delete environment[key];
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: environment, windowsHide: true, stdio: 'pipe', timeout: 10000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('Claude settings use protected writes for shared direct credentials as well as device credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextq-claude-private-'));
  process.env.AGENT_CONTEXT_HOME = dir;
  let protectedWrite = false;
  try {
    writeConfig(path.join(dir, '.claude/settings.json'), JSON.stringify({ env: { LANGFUSE_SECRET_KEY: 'synthetic' } }), {
      platform: 'win32', execute: (_, args, options) => {
        protectedWrite = true;
        assert.equal(fs.readFileSync(options.env.AGENT_CONTEXT_PRIVATE_FILE, 'utf8'), '');
        assert.equal(args.join(' ').includes('synthetic'), false);
      },
    });
    assert.equal(protectedWrite, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
