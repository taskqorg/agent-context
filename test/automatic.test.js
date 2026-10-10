import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import YAML from 'yaml';
import { install, doctor, rollback } from '../src/install.js';
import { diagnose } from '../src/diagnostics.js';
import { agentExecutable } from '../src/executable.js';
import { root } from '../src/core.js';
import { verify } from '../src/verify.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-automatic-'));
process.env.AGENT_CONTEXT_HOME = home;
delete process.env.SUPERCOMPRESS_API_KEY;
for (const agent of ['codex', 'claude', 'hermes']) fs.mkdirSync(path.join(home, '.' + agent));
fs.mkdirSync(path.join(home, '.supercompress')); fs.writeFileSync(path.join(home, '.supercompress/config.json'), JSON.stringify({ api_key: 'sc_owned_synthetic_fixture_not_a_real_key' }));
const codex = path.join(home, '.codex/config.toml');
fs.writeFileSync(codex, '# owner comment\nmodel="existing"\n[mcp_servers.other]\ncommand="keep"\n');
test('automatic setup preserves unrelated settings, routes subscription auth, has no output hook duplication, and rolls back', async () => {
  const before = fs.readFileSync(codex);
  const report = install(['codex', 'claude', 'hermes'], { automatic: true });
  assert.equal(report.installed.length, 3);
  const config = parse(fs.readFileSync(codex, 'utf8'));
  assert.equal(config.model_providers.agent_context.requires_openai_auth, true);
  assert.equal(config.mcp_servers.supercompress.enabled, false);
  assert.equal(config.mcp_servers.other.command, 'keep');
  assert.ok(fs.readFileSync(codex, 'utf8').includes('# owner comment'));
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
  assert.equal(claude.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${process.platform === 'win32' ? 18888 : 18788}`);
  assert.equal(claude.hooks.SessionStart.length, 1); assert.equal(claude.hooks.PostToolUse.length, 0);
  const hermes = YAML.parse(fs.readFileSync(path.join(home, '.hermes/config.yaml'), 'utf8'));
  assert.ok(hermes.plugins.enabled.includes('agent-context'));
  assert.equal(doctor().healthy, true, JSON.stringify(doctor()));
  assert.equal(install(['codex', 'claude', 'hermes'], { automatic: true }).transaction, null);
  fs.unlinkSync(codex);
  // Remove active service selection for this file-repair-only test; no subprocess/service is started.
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ agents: [] }));
  const repaired = await diagnose({ fix: true });
  assert.ok(repaired.repairs.some(x => x.status === 'restored_missing_owned_file'));
  assert.equal(parse(fs.readFileSync(codex, 'utf8')).model_provider, 'agent_context');
  // Restore journal's expected integration bytes before explicit rollback.
  fs.writeFileSync(path.join(root(), 'integration.json'), JSON.stringify({ schema: 1, mode: 'automatic', agents: ['codex', 'claude', 'hermes'], telemetry: false }, null, 2) + '\n');
  assert.equal(rollback().status, 'rolled_back'); assert.deepEqual(fs.readFileSync(codex), before);
});
test('Windows resolves the native Claude executable relative to its shim directory; WSL refuses Windows paths', () => {
  const bin = path.join(home, 'npm/node_modules/@anthropic-ai/claude-code/bin'); fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, 'claude.exe'); fs.writeFileSync(exe, 'synthetic executable');
  assert.equal(agentExecutable('claude', { PATH: path.join(home, 'npm') }, 'win32').command, fs.realpathSync(exe));
  assert.throws(() => agentExecutable('claude', { PATH: '', WSL_DISTRO_NAME: 'Ubuntu', AGENT_CONTEXT_CLAUDE_EXE: '/mnt/c/windows/claude.exe' }, 'linux'), /Unsupported/);
});

test('doctor accepts canonical Node and launcher aliases for the automatic Codex recovery adapter', () => {
  install(['codex'], { automatic: true });
  const node = path.join(home, 'node-alias');
  const launcher = path.join(home, 'launcher-alias.mjs');
  fs.symlinkSync(process.execPath, node, process.platform === 'win32' ? 'file' : 'file');
  fs.symlinkSync(path.join(root(), 'launcher.mjs'), launcher, process.platform === 'win32' ? 'file' : 'file');
  const config = parse(fs.readFileSync(codex, 'utf8'));
  config.mcp_servers.headroom.command = node;
  config.mcp_servers.headroom.args[0] = launcher;
  fs.writeFileSync(codex, stringify(config));
  assert.equal(doctor().agents.codex, 'configured', JSON.stringify(doctor()));
  assert.ok(!doctor().issues.includes('codex:not_configured'), JSON.stringify(doctor()));
  config.model_providers.agent_context.wire_api = 'chat';
  fs.writeFileSync(codex, stringify(config));
  assert.equal(doctor().agents.codex, 'not_configured', JSON.stringify(doctor()));
});

test('doctor accepts a distinct compatible Node runtime configured by the owner', () => {
  install(['codex', 'hermes'], { automatic: true });
  const node = path.join(home, process.platform === 'win32' ? 'configured-node.exe' : 'configured-node');
  fs.copyFileSync(process.execPath, node);
  if (process.platform !== 'win32') fs.chmodSync(node, 0o700);
  const codexConfig = parse(fs.readFileSync(codex, 'utf8'));
  codexConfig.mcp_servers.headroom.command = node;
  fs.writeFileSync(codex, stringify(codexConfig));
  const file = path.join(home, '.hermes', 'config.yaml');
  const hermes = YAML.parse(fs.readFileSync(file, 'utf8'));
  hermes.plugins.entries['agent-context'].settings.node = node;
  fs.writeFileSync(file, YAML.stringify(hermes));
  assert.equal(doctor().agents.codex, 'configured');
  assert.equal(doctor().agents.hermes, 'configured');
});

test('native Hermes verification loads the configured plugin contract without a legacy MCP adapter', async () => {
  install(['hermes'], { automatic: true });
  const config = YAML.parse(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8'));
  assert.equal(config.mcp_servers.supercompress.enabled, false);
  const report = await verify('hermes');
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.proof, 'configured_native_plugin_registration_not_model_session');
  const configuredNode = path.join(home, process.platform === 'win32' ? 'verify-node.exe' : 'verify-node');
  fs.copyFileSync(process.execPath, configuredNode);
  if (process.platform !== 'win32') fs.chmodSync(configuredNode, 0o700);
  const configFile = path.join(home, '.hermes', 'config.yaml');
  const settingsConfig = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  settingsConfig.plugins.entries['agent-context'].settings.node = configuredNode;
  fs.writeFileSync(configFile, YAML.stringify(settingsConfig));
  assert.equal((await verify('hermes')).passed, true);
  for (const patch of [
    c => { c.plugins.enabled = []; },
    c => { c.plugins.entries['agent-context'].settings.node = path.join(home, 'missing-node'); },
    c => { c.plugins.entries['agent-context'].settings.launcher = path.join(home, 'missing-launcher'); },
    c => { c.plugins.entries['agent-context'].settings.proxy_url = 'https://example.com:18790'; },
  ]) {
    const invalid = structuredClone(settingsConfig);
    patch(invalid);
    fs.writeFileSync(configFile, YAML.stringify(invalid));
    assert.equal(doctor().agents.hermes, 'not_configured');
    await assert.rejects(verify('hermes'), /configured plugin adapter/);
  }
  fs.writeFileSync(configFile, YAML.stringify(settingsConfig));
  fs.rmSync(path.join(home, '.hermes', 'plugins', 'agent-context', '__init__.py'));
  await assert.rejects(verify('hermes'), /configured plugin adapter/);
  assert.deepEqual(report.hooks, ['post_llm_call', 'pre_llm_call', 'transform_tool_result']);
  assert.equal(report.retrievalTool, 'agent_context_retrieve');
});
