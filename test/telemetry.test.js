import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executionIdentity, profileIdentity, langfuseConfig, telemetryStatus, verifyTelemetry, prepareCodexExporter, prepareNativeExporters, refreshTelemetryDelivery } from '../src/telemetry.js';
import { diagnose } from '../src/diagnostics.js';
import { root } from '../src/core.js';
import { automaticPlan } from '../src/automatic.js';
import {servicePort} from '../src/service.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-telemetry-'));
process.env.AGENT_CONTEXT_HOME = home;
for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_HOST', 'HERMES_LANGFUSE_PUBLIC_KEY', 'HERMES_LANGFUSE_SECRET_KEY', 'AGENT_CONTEXT_LANGFUSE_CONFIG']) delete process.env[name];
fs.mkdirSync(path.join(home, '.codex'));
const file = path.join(home, '.codex/langfuse.json');
const config = { public_key: 'synthetic-public', secret_key: 'synthetic-secret', base_url: 'https://example.invalid' };

test('execution identity uses the running platform, WSL and explicit host; rejects unsafe labels', () => {
  assert.deepEqual(executionIdentity({}, 'darwin'), { host: 'mac', runtime: 'native' });
  assert.deepEqual(executionIdentity({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), { host: 'windows', runtime: 'wsl' });
  assert.deepEqual(executionIdentity({ AGENT_CONTEXT_HOST: 'fra' }, 'linux'), { host: 'fra', runtime: 'native' });
  assert.throws(() => executionIdentity({ AGENT_CONTEXT_HOST: 'private/label' }), /Unsupported/);
});

test('explicit installation host survives service startup without inherited setup variables', () => {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ host: 'fra' }));
  assert.equal(profileIdentity({}).host, 'fra');
  assert.equal(profileIdentity({ AGENT_CONTEXT_HOST: 'mac' }).host, 'mac');
  fs.unlinkSync(path.join(root(), 'integration.json'));
});

test('file presence cannot enable telemetry; disabled and incomplete credentials fail closed', () => {
  fs.writeFileSync(file, '{}'); assert.equal(langfuseConfig(), null);
  fs.writeFileSync(file, JSON.stringify({ ...config, enabled: false })); assert.equal(langfuseConfig(), null);
  fs.writeFileSync(file, JSON.stringify({ ...config, base_url: 'https://user:secret@example.invalid' })); assert.equal(langfuseConfig(), null);
  fs.writeFileSync(file, JSON.stringify(config)); assert.equal(langfuseConfig().base_url, config.base_url);
  const status = JSON.stringify(telemetryStatus(['codex']));
  assert.equal(status.includes('synthetic-secret'), false);
  assert.equal(status.includes('synthetic-public'), false);
});

test('verification checks readback session and tags, and never treats accepted ingestion as delivery', async () => {
  fs.writeFileSync(file, JSON.stringify(config));
  let trace;
  const report = await verifyTelemetry('codex', async (url, options) => {
    assert.ok(url.includes('/v2/observations?traceId=' + trace.id));
    return Response.json({ data: [{ traceId: trace.id, sessionId: trace.sessionId, environment: 'qualification', tags: trace.tags }] });
  }, async () => {}, async (config, probe) => { trace = probe; return 'accepted'; });
  assert.equal(report.status, 'delivered');
  assert.equal(JSON.stringify(report).includes('synthetic-secret'), false);
  assert.equal(telemetryStatus([]).delivery.status, 'delivered');
  fs.writeFileSync(file, JSON.stringify({ ...config, public_key: 'another-project' }));
  assert.equal(telemetryStatus([]).delivery.status, 'stale_verification');
  fs.writeFileSync(file, JSON.stringify(config));
  const unobserved = await verifyTelemetry('codex', async () => Response.json({ data: [] }), async () => {}, async () => 'accepted');
  assert.equal(unobserved.status, 'accepted_not_observed');
  const rejected = await verifyTelemetry('codex', async () => { throw new Error('must not read rejected export'); }, async () => {}, async () => 'rejected');
  assert.equal(rejected.status, 'ingestion_rejected');
});

test('automatic plan preserves owner tags, keys and native approval while adding consistent labels', () => {
  fs.writeFileSync(file, JSON.stringify({ ...config, tags: ['owner:keep', 'host:old'], custom: 'keep' }));
  const codex = path.join(home, '.codex/config.toml');
  const before = 'approval_policy="on-request"\n[mcp_servers.supercompress]\ncommand="fixture"\n';
  fs.writeFileSync(codex, before);
  const plan = automaticPlan({ changes: [], installed: ['codex'], moves: [] });
  const updated = JSON.parse(plan.changes.find(item => item.file === file).after);
  assert.ok(updated.tags.includes('owner:keep'));
  assert.ok(updated.tags.includes('agent:codex'));
  assert.ok(updated.tags.includes('runtime:' + executionIdentity(process.env).runtime));
  assert.equal(updated.tags.includes('host:old'), false);
  assert.equal(updated.custom, 'keep');
  assert.equal(updated.secret_key, config.secret_key);
  assert.ok(plan.changes.find(item => item.file === codex).after.includes('approval_policy="on-request"'));
  assert.equal(fs.readFileSync(codex, 'utf8'), before);
});

test('doctor cannot mark missing native exporter healthy even with valid credentials', async () => {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'], telemetry: true }));
  const report = await diagnose();
  assert.equal(report.healthy, false);
  assert.ok(report.issues.includes('codex:native_exporter_missing'));
  assert.equal(report.telemetry.delivery.status, 'incomplete');
  assert.equal(report.telemetry.deliveryByAgent.codex.status, 'ingestion_rejected');
});

test('Codex exporter setup uses the native CLI in this profile without passing keys or bypassing trust', async () => {
  process.env.AGENT_CONTEXT_CODEX_EXE = process.execPath;
  const calls = [];
  try {
    const result = await prepareCodexExporter(['codex'], async (command, args, options) => {
      calls.push(args);
      assert.equal(options.env.CODEX_HOME, path.join(home, '.codex'));
      assert.equal(args.some(value => value.includes(config.secret_key)), false);
      assert.equal(args.some(value => /trust|approval/.test(value)), false);
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('langfuse/codex-observability-plugin'));
    assert.ok(calls[1].includes('tracing@codex-observability-plugin'));
    assert.equal(result.trust, 'native_review_required');
    assert.equal((await prepareCodexExporter(['codex'], async () => { throw new Error('private output'); })).status, 'native_install_unresolved');
  } finally { delete process.env.AGENT_CONTEXT_CODEX_EXE; }
});

test('setup enables missing native hook feature after official installation, preserves owner flags and explicit disable', () => {
  const file = path.join(home, '.codex/config.toml');
  const plugin = '[plugins."tracing@codex-observability-plugin"]\nenabled=true\n';
  for (const features of ['', '[features]\n# owner feature\nother=true\n', '[features]\nhooks=false\n']) {
    fs.writeFileSync(file, features + plugin + '[mcp_servers.supercompress]\ncommand="fixture"\n');
    const result = automaticPlan({ changes: [], installed: ['codex'], moves: [] }).changes.find(item => item.file === file).after;
    assert.ok(result.includes(features.includes('hooks=false') ? 'hooks=false' : 'hooks = true'));
    if (features.includes('# owner feature')) assert.ok(result.includes('# owner feature'));
  }
});

test('fresh Codex exporter config enables capture; explicit owner disable is preserved', () => {
  process.env.LANGFUSE_PUBLIC_KEY = config.public_key;
  process.env.LANGFUSE_SECRET_KEY = config.secret_key;
  process.env.LANGFUSE_BASE_URL = config.base_url;
  try {
    for (const before of [null, { ...config, tags: ['team:fixture'] }, { ...config, enabled: false }]) {
      if (before) fs.writeFileSync(file, JSON.stringify(before)); else fs.rmSync(file, { force: true });
      const after = JSON.parse(automaticPlan({ changes: [], installed: ['codex'], moves: [] }).changes.find(item => item.file === file).after);
      assert.equal(after.enabled, before?.enabled ?? true);
      assert.ok(after.tags.includes('agent:codex'));
      if (before?.tags) assert.ok(after.tags.includes('team:fixture'));
    }
  } finally {
    for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) delete process.env[name];
    fs.writeFileSync(file, JSON.stringify(config));
  }
});

test('local-only doctor does not require telemetry or compression credentials', async () => {
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex'], telemetry: false }));
  fs.mkdirSync(path.join(process.env.AGENT_CONTEXT_HOME, '.hermes'), { recursive: true });
  const report = await diagnose();
  assert.equal(report.agents.hermes, 'not_selected');
  assert.equal(report.compressionCredentialsRequired, false);
  assert.equal(report.issues.some(issue => /telemetry|native_exporter|native_hooks|missing_key|key_conflict/.test(issue)), false);
});


test('receipts are scoped per agent and stale or future receipts cannot prove delivery', async () => {
  fs.writeFileSync(file, JSON.stringify(config));
  let trace;
  const request = async () => Response.json({ data: [{ traceId: trace.id, sessionId: trace.sessionId, environment: 'qualification', tags: trace.tags }] });
  await verifyTelemetry('codex', request, async () => {}, async (_, probe) => { trace = probe; return 'accepted'; });
  assert.equal(telemetryStatus(['codex', 'claude']).delivery.status, 'incomplete');
  await verifyTelemetry('claude', request, async () => {}, async () => 'rejected');
  assert.equal(telemetryStatus(['codex']).delivery.status, 'delivered');
  const receiptFile = path.join(root(), 'telemetry-delivery/codex.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  for (const changed of [{ checkedAt: new Date(Date.now() - 86400001).toISOString() }, { checkedAt: new Date(Date.now() + 120000).toISOString() }, { version: '0.0.0' }, { host: 'other' }, { destination: 'other' }]) {
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, ...changed }));
    assert.equal(telemetryStatus(['codex']).deliveryByAgent.codex.status, 'stale_verification');
  }
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
});

test('monitor refresh respects daily success and hourly failure backoff', async () => {
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: ['codex', 'claude'] }));
  const calls = [], now = Date.now();
  await refreshTelemetryDelivery(now, async agent => calls.push(agent));
  assert.deepEqual(calls, []);
  await refreshTelemetryDelivery(now + 3600001, async agent => calls.push(agent));
  assert.deepEqual(calls, ['claude']);
  calls.length = 0;
  await refreshTelemetryDelivery(now + 86400001, async agent => calls.push(agent));
  assert.deepEqual(calls, ['codex', 'claude']);
});

test('Claude native installer never puts keys into arguments; missing Hermes exporter is explicit', async () => {
  process.env.AGENT_CONTEXT_CLAUDE_EXE = process.execPath;
  const calls = [];
  try {
    const results = await prepareNativeExporters(['claude', 'hermes'], async (_, args, options) => {
      calls.push(args);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
      assert.equal(args.includes(config.secret_key), false);
    });
    assert.ok(calls[0].includes('langfuse/Claude-Observability-Plugin'));
    assert.ok(calls[1].includes('langfuse-observability@langfuse-observability'));
    assert.equal(results.claude.status, 'installed_by_native_agent');
    assert.equal(results.hermes.status, 'native_install_unresolved');
  } finally { delete process.env.AGENT_CONTEXT_CLAUDE_EXE; }
});

test('Claude direct exporter receives the shared destination without exposing it in command arguments', () => {
  const settings = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: {}, env: { KEEP: 'owner' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const change = automaticPlan({ changes: [], installed: ['claude'], moves: [] }).changes.find(item => item.file === settings);
  const env = JSON.parse(change.after).env;
  assert.equal(env.LANGFUSE_SECRET_KEY, config.secret_key);
  assert.equal(env.LANGFUSE_BASE_URL, `http://127.0.0.1:${servicePort('claude')}`);
  assert.equal(env.KEEP, 'owner');
});

test('Hermes external exporter gets enough capture depth without overriding owner limits', () => {
  const dir = path.join(home, '.hermes');
  fs.mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, '.env');
  for (const exporter of ['tight-langfuse', 'observability/langfuse']) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), `plugins:\n  enabled: [${exporter}]\n`);
    for (const setting of ['', 'export HERMES_LANGFUSE_MAX_DEPTH = 6\n']) {
      fs.writeFileSync(envFile, 'KEEP=owner\n' + setting);
      const plan = automaticPlan({ changes: [], installed: ['hermes'], moves: [] });
      const change = plan.changes.find(item => item.file === envFile);
      if (exporter === 'tight-langfuse' && !setting) {
        assert.ok(change?.after.includes('HERMES_LANGFUSE_MAX_DEPTH=10\n'));
        assert.ok(change.after.includes(`HERMES_LANGFUSE_BASE_URL=http://127.0.0.1:${servicePort('hermes')}`));
        assert.ok(change.after.startsWith('KEEP=owner\n'));
        fs.writeFileSync(envFile, change.after);
        assert.equal(automaticPlan({ changes: [], installed: ['hermes'], moves: [] }).changes.some(item => item.file === envFile), false);
      } else {
        assert.ok(change.after.includes(`HERMES_LANGFUSE_BASE_URL=http://127.0.0.1:${servicePort('hermes')}`));
        assert.ok(change.after.startsWith('KEEP=owner\n'));
        if (setting) assert.ok(change.after.includes(setting));
        else assert.equal(change.after.includes('HERMES_LANGFUSE_MAX_DEPTH'), false);
      }
    }
  }
});


test('direct exporter routing retains upstream and explicit canonical user across repeated setup', () => {
  fs.writeFileSync(file, JSON.stringify({ ...config, user_id: 'employee' }));
  const plan = automaticPlan({ changes: [], installed: ['codex'], moves: [] });
  const updated = JSON.parse(plan.changes.find(item => item.file === file).after);
  assert.equal(updated.base_url, `http://127.0.0.1:${servicePort('codex')}`);
  assert.equal(updated.agent_context_base_url, config.base_url);
  assert.equal(updated.user_id, 'employee');
  fs.writeFileSync(file, plan.changes.find(item => item.file === file).after);
  assert.equal(langfuseConfig().base_url, config.base_url);
  assert.equal(telemetryStatus([]).userIdentity, 'configured');
  assert.equal(automaticPlan({ changes: [], installed: ['codex'], moves: [] }).changes.some(item => item.file === file), false);
});


test('canonical direct identity cannot be an exporter email or malformed tag', () => {
  for (const user_id of ['person@example.invalid', '', 'user:injected', 123]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, user_id }));
    assert.equal(langfuseConfig(), null);
  }
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(telemetryStatus([]).userIdentity, 'missing');
});
