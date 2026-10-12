import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { onboardingOptions, onboardingPlan, onboard } from '../src/onboarding.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-onboard-'));
process.env.AGENT_CONTEXT_HOME = work;
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME']) delete process.env[key];
const probe = { python: async () => ['python'], executable: () => { throw new Error('not on PATH'); } };
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test('preview discovers profiles without PATH, reports CLI-only agents and never creates state', async () => {
  fs.mkdirSync(path.join(work, '.codex')); fs.mkdirSync(path.join(work, '.claude'));
  const result = await onboardingPlan(onboardingOptions([]), { ...probe, executable: a => { if (a !== 'hermes') throw new Error('not found'); } });
  assert.deepEqual(result.selected, ['codex', 'claude']);
  assert.equal(result.detected.find(a => a.agent === 'hermes').profilePresent, false);
  assert.equal(result.signInRequired, true);
  assert.equal(result.telemetryRequested, true);
  assert.equal(result.status, 'awaiting_confirmation');
  assert.equal(fs.existsSync(path.join(work, '.agent-context')), false);
});

test('explicit choices, missing prerequisites and nonstandard profiles are handled before login', async () => {
  assert.deepEqual((await onboardingPlan(onboardingOptions(['claude', 'claude']), probe)).selected, ['claude']);
  const absent = await onboardingPlan(onboardingOptions(['hermes']), { ...probe, python: async () => { throw new Error('missing'); } });
  assert.equal(absent.status, 'needs_attention'); assert.equal(absent.issues.length, 2);
  process.env.CODEX_HOME = path.join(work, 'different-codex');
  try { assert.equal((await onboardingPlan(onboardingOptions(['codex']), probe)).status, 'needs_attention'); }
  finally { delete process.env.CODEX_HOME; }
  for (const args of [['--gateway'], ['--gateway', 'https://user:secret@example.invalid'], ['--gateway', 'http://example.invalid'], ['cursor'], ['--unknown']]) assert.throws(() => onboardingOptions(args));
});

test('existing enrollment is reused, respects gateway and is never returned with credentials', async () => {
  fs.mkdirSync(path.join(work, '.agent-context'));
  const secret = 'acd_' + 'a'.repeat(64);
  fs.writeFileSync(path.join(work, '.agent-context/enrollment.json'), JSON.stringify({ gateway: 'https://team.example.invalid', device: 'b'.repeat(32), token: secret, user: 'tester' }));
  const result = await onboardingPlan(onboardingOptions(['codex']), probe);
  assert.equal(result.gateway, 'https://team.example.invalid'); assert.equal(result.signInRequired, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await onboardingPlan(onboardingOptions(['codex', '--login']), probe)).signInRequired, true);
  assert.equal((await onboardingPlan(onboardingOptions(['codex', '--gateway', 'https://other.example.invalid']), probe)).signInRequired, true);
});

const preview = { selected: ['codex', 'claude'], gateway: 'https://team.example.invalid', issues: [], signInRequired: true, telemetryRequested: true, status: 'awaiting_confirmation' };
test('preview and prerequisite failures never start sign-in or configuration', async () => {
  const no = async () => { assert.fail('unexpected mutation'); };
  const deps = { plan: async () => preview, connect: no, step: no };
  assert.equal((await onboard(onboardingOptions([]), deps)).status, 'awaiting_confirmation');
  const failed = { ...preview, status: 'needs_attention', issues: ['Python missing'] };
  assert.equal((await onboard(onboardingOptions(['--yes']), { ...deps, plan: async () => failed })).status, 'needs_attention');
});

test('approved onboarding signs in once, continues all checks and never claims real-agent proof', async () => {
  const calls = [];
  const result = await onboard(onboardingOptions(['--yes', '--no-report']), {
    plan: async () => preview, announce: () => {},
    connect: async url => calls.push(['login', url]),
    step: async args => {
      calls.push(args);
      if (args[0] === 'setup') return { installed: ['codex', 'claude'], monitor: { status: 'installed' }, warnings: [] };
      if (['telemetry', 'monitor'].includes(args[0])) return { status: 'delivered' };
      return { healthy: true };
    },
  });
  assert.deepEqual(calls, [['login', preview.gateway], ['setup', 'codex', 'claude', '--no-report'], ['doctor', '--fix', '--live'], ['telemetry', 'verify', 'codex'], ['telemetry', 'verify', 'claude'], ['monitor', 'tick'], ['doctor', '--live']]);
  assert.equal(result.status, 'ready_for_agent_check');
  assert.equal(result.runtimeProof, 'real_agent_turns_not_run');
});

test('incomplete setup stops and failed delivery never produces a ready result', async () => {
  const deps = { plan: async () => ({ ...preview, signInRequired: false }), announce: () => {}, connect: async () => assert.fail('must reuse login') };
  let calls = 0;
  const stopped = await onboard(onboardingOptions(['--yes']), { ...deps, step: async () => { calls++; return { status: 'needs_attention' }; } });
  assert.equal(calls, 1); assert.equal(stopped.status, 'needs_attention');
  const failed = await onboard(onboardingOptions(['--yes']), { ...deps, step: async args => args[0] === 'setup' ? { installed: preview.selected, monitor: { status: 'installed' } } : args[0] === 'telemetry' ? { status: 'failed' } : { healthy: true } });
  assert.equal(failed.status, 'needs_attention');
});

test('CLI rejects invalid onboarding arguments without creating incident state', () => {
  const isolated = path.join(work, 'invalid-cli'); fs.mkdirSync(isolated);
  assert.throws(() => execFileSync(process.execPath, ['bin/agent-context.js', 'onboard', '--unknown'], { env: { ...process.env, AGENT_CONTEXT_HOME: isolated }, stdio: 'pipe' }));
  assert.deepEqual(fs.readdirSync(isolated), []);
});

test('monitor delivery failure blocks readiness even when per-agent probes pass', async () => {
  const result = await onboard(onboardingOptions(['--yes']), {
    plan: async () => ({ ...preview, signInRequired: false }), announce: () => {},
    step: async args => args[0] === 'setup' ? { installed: preview.selected, monitor: { status: 'installed' } }
      : args[0] === 'telemetry' ? { status: 'delivered' } : { healthy: true, status: 'failed' },
  });
  assert.equal(result.status, 'needs_attention');
});

test('onboarding respects an existing telemetry opt-out without requesting login', async () => {
  const file = path.join(work, '.codex/langfuse.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: false }));
  const result = await onboardingPlan(onboardingOptions(['codex']), probe);
  assert.equal(result.signInRequired, false);
  assert.equal(result.telemetryRequested, true);
  assert.equal(result.status, 'needs_attention');
  assert.ok(result.issues.some(issue => issue.includes('отключена')));
  fs.unlinkSync(file);
});
