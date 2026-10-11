import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compress, atomicWrite, root } from '../src/core.js';
import { claudeHook } from '../src/hooks.js';
import { install, rollback, doctor, codexConfig, bin, instructions, stripHooks } from '../src/install.js';
import { parse as toml } from 'smol-toml';
import YAML from 'yaml';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-test-'));
process.env.AGENT_CONTEXT_HOME = sandbox;
delete process.env.SUPERCOMPRESS_API_KEY;
const credentials = { present: true, key: 'sc_synthetic_test_key_not_real' };
const context = 'Background observations '.repeat(120) + '\nERROR ECONNREFUSED db.internal:5432';
const query = 'Preserve exact errors';
const input = session => ({ context, query, session, agent: 'Codex' });
const success = async () => ({ ok: true, json: async () => ({ mode: 'neural-keep', compressed_text: 'Observations\nERROR ECONNREFUSED db.internal:5432', original_tokens: 800, kept_tokens: 20 }) });

test('Neural selector, original query and single output; duplicate is not billed again', async () => {
  let calls = 0;
  const fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.supercompress.dev/api/v1/compress');
    const body = JSON.parse(options.body);
    assert.equal(body.ccr, undefined);
    assert.equal(body.mode, 'neural');
    assert.equal(body.query, query);
    assert.equal(body.context, context);
    assert.equal(options.headers['X-API-Key'], credentials.key);
    return success();
  };
  assert.equal((await compress(input('duplicate'), { fetch, credentials })).skipped, null);
  assert.deepEqual((await compress(input('duplicate'), { fetch, credentials })).compressed_text, '');
  assert.equal(calls, 1);
});
for (const status of [409, 429, 503, 504]) test(`HTTP ${status} is one attempt and retains context`, async () => {
  let calls = 0;
  const result = await compress(input(`http-${status}`), { credentials, fetch: async () => { calls++; return { ok: false, status }; } });
  assert.equal(calls, 1);
  assert.equal(result.skipped, `http_${status}`);
  assert.equal(result.compressed_text, context);
});
test('timeout retains context', async () => {
  const fetch = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' }))));
  const result = await compress(input('timeout'), { credentials, fetch, timeoutMs: 10 });
  assert.equal(result.skipped, 'timeout');
  assert.equal(result.compressed_text, context);
});
test('lost error rejects HTTP200 and does not mark input as seen', async () => {
  const result = await compress(input('quality'), { credentials, fetch: async () => ({ ok: true, json: async () => ({ mode: 'neural-keep', compressed_text: 'all good' }) }) });
  assert.equal(result.skipped, 'lost_critical_evidence');
  assert.equal(result.compressed_text, context);
  assert.equal((await compress(input('quality'), { credentials, fetch: success })).skipped, null);
});
test('no-gain, empty result and conflicting key retain original', async () => {
  for (const [text, reason] of [[context, 'no_gain'], ['', 'invalid_response']]) {
    const result = await compress(input(reason), { credentials, fetch: async () => ({ ok: true, json: async () => ({ mode: 'neural-keep', compressed_text: text }) }) });
    assert.equal(result.skipped, reason);
    assert.equal(result.compressed_text, context);
  }
  assert.equal((await compress(input('conflict'), { credentials: { ...credentials, conflict: true } })).skipped, 'key_conflict');
});
test('concurrent session preserves original instead of parallel API request', async () => {
  let release;
  const pending = compress(input('concurrent'), { credentials, fetch: () => new Promise(resolve => { release = () => resolve(success()); }) });
  const second = await compress(input('concurrent'), { credentials, fetch: success });
  assert.equal(second.skipped, 'session_busy');
  release();
  await pending;
});
test('state and telemetry contain no context, query or API key', () => {
  const log = fs.readFileSync(path.join(root(), 'events.jsonl'), 'utf8');
  for (const privateValue of [context, query, credentials.key, 'db.internal']) assert.ok(!log.includes(privateValue));
  for (const name of fs.readdirSync(path.join(root(), 'state')).filter(name => name.endsWith('.json'))) {
    const state = fs.readFileSync(path.join(root(), 'state', name), 'utf8');
    assert.ok(!state.includes('ERROR')); assert.ok(!state.includes(query));
  }
});
test('Claude replaces stdout only, preserves stderr and fields, never compresses user query', async () => {
  const original = { stdout: context, stderr: 'stderr unchanged', exitCode: 7 };
  const value = await claudeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'claude-1', tool_response: original }, async () => ({ mode: 'neural-keep', compressed_text: 'short', skipped: null }));
  assert.deepEqual(value.hookSpecificOutput.updatedToolOutput, { ...original, stdout: 'short' });
  assert.deepEqual(await claudeHook({ hook_event_name: 'UserPromptSubmit', prompt: context }, () => { throw new Error('must not call'); }), {});
  assert.deepEqual(await claudeHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp_supercompress_compress_context' }, () => { throw new Error('recursion'); }), {});
});
test('Claude failure does not replace output', async () => {
  const value = await claudeHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'claude-2', tool_response: { stdout: context } }, async () => ({ skipped: 'timeout' }));
  assert.ok(value.systemMessage.includes('original output kept'));
  assert.equal(value.hookSpecificOutput, undefined);
});

test('install all adapters preserves unrelated config and rollback restores exact bytes', () => {
  const codex = path.join(sandbox, '.codex', 'config.toml');
  const codexHooks = path.join(sandbox, '.codex', 'hooks.json');
  const claude = path.join(sandbox, '.claude.json');
  const claudeHooks = path.join(sandbox, '.claude', 'settings.json');
  const hermes = path.join(sandbox, '.hermes', 'config.yaml');
  atomicWrite(codex, '# owner comment\nmodel="existing"\n[mcp_servers.other]\ncommand="keep"\n[mcp_servers.supercompress]\ncommand="old"\n[mcp_servers.supercompress.env]\nOLD="keep in backup"\n');
  atomicWrite(codexHooks, JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'node /old/supercompress/post.js' }, { command: 'echo supercompress is a word' }] }] } }));
  atomicWrite(claude, JSON.stringify({ projects: { '/Project': { allowed: true }, '/project': { allowed: false } }, mcpServers: { other: { command: 'keep' } } }));
  atomicWrite(claudeHooks, JSON.stringify({ permissions: { allow: ['Bash(echo:*)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node /old/supercompress/pre.js' }] }] } }));
  atomicWrite(hermes, '# owner comment\nmodel: existing\nmcp_servers:\n  other:\n    command: keep\n');
  atomicWrite(path.join(sandbox, '.supercompress', 'config.json'), JSON.stringify({ api_key: credentials.key }));
  const files = [codex, codexHooks, claude, claudeHooks, hermes];
  const before = files.map(file => fs.readFileSync(file));
  const report = install(['codex', 'claude', 'hermes']);
  assert.equal(report.installed.length, 3);
  assert.ok(fs.readFileSync(codex, 'utf8').includes('# owner comment'));
  assert.equal(toml(fs.readFileSync(codex, 'utf8')).mcp_servers.other.command, 'keep');
  assert.equal(JSON.parse(fs.readFileSync(claude)).projects['/project'].allowed, false);
  assert.equal(JSON.parse(fs.readFileSync(claude)).projects['/Project'].allowed, true);
  assert.equal(YAML.parse(fs.readFileSync(hermes, 'utf8')).mcp_servers.other.command, 'keep');
  assert.ok(fs.readFileSync(hermes, 'utf8').includes('# owner comment'));
  assert.equal(doctor().healthy, true, JSON.stringify(doctor()));
  assert.equal(install(['codex', 'claude', 'hermes']).transaction, null);
  assert.equal(rollback().status, 'rolled_back');
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});
test('rollback refuses later edits before modifying any file', () => {
  install(['codex', 'claude', 'hermes']);
  const file = path.join(sandbox, '.codex', 'config.toml');
  fs.appendFileSync(file, '\n# later owner edit\n');
  const other = fs.readFileSync(path.join(sandbox, '.claude.json'));
  assert.throws(() => rollback(), /config drift/);
  assert.deepEqual(fs.readFileSync(path.join(sandbox, '.claude.json')), other);
});
test('ambiguous TOML refuses instead of overwriting unrelated configuration', () => {
  assert.throws(() => codexConfig('mcp_servers = { supercompress = { command="old" }, other = { command="keep" } }\n'), /TOML|Redefinition|already|Unsupported/i);
});
test('Hermes existing plugin is preserved outside active plugins and rollback restores it', () => {
  const plugin = path.join(sandbox, '.hermes', 'plugins', 'supercompress', '__init__.py');
  atomicWrite(plugin, '# legacy plugin preserved');
  const config = path.join(sandbox, '.hermes', 'config.yaml');
  atomicWrite(config, YAML.stringify({ hooks: { post_tool_call: [{ command: 'node /agent-hooks/supercompress/post.js' }, { command: 'keep unrelated hook' }] }, mcp_servers: {} }));
  const before = fs.readFileSync(config);
  const report = install(['hermes']);
  assert.equal(report.legacyPluginsPreserved, 1);
  assert.ok(!fs.existsSync(plugin));
  assert.deepEqual(YAML.parse(fs.readFileSync(config, 'utf8')).hooks.post_tool_call, [{ command: 'keep unrelated hook' }]);
  rollback();
  assert.equal(fs.readFileSync(plugin, 'utf8'), '# legacy plugin preserved');
  assert.deepEqual(fs.readFileSync(config), before);
});
test('global instructions replace only the old compression section', () => {
  const before = '# Other policy\nKeep this.\n\n# SuperCompress (always on)\nRead stale inbox.\n\n# Last policy\nKeep this too.\n';
  const after = instructions(before, 'claude');
  assert.ok(after.includes('Keep this.'));
  assert.ok(after.includes('Keep this too.'));
  assert.ok(!after.includes('Read stale inbox'));
  assert.ok(after.includes('Do not recompress'));
  assert.equal(instructions(after, 'claude'), after);
});

test('Hermes removes only its obsolete global instruction block and rollback restores exact bytes', () => {
  const file = path.join(sandbox, '.hermes', 'AGENTS.md');
  const before = '# Private policy\r\nKeep exactly.\r\n<!-- agent-context:start -->\r\nObsolete rule\r\n<!-- agent-context:end -->\r\n# SuperCompress user note\r\nKeep too.\r\n';
  atomicWrite(file, before);
  install(['hermes']);
  assert.equal(fs.readFileSync(file, 'utf8'), before.replace(/<!-- agent-context:start -->[\s\S]*?<!-- agent-context:end -->/, ''));
  rollback();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Hermes installation creates no unused global instructions and preserves persona config', () => {
  const file = path.join(sandbox, '.hermes', 'AGENTS.md');
  fs.unlinkSync(file);
  const soul = path.join(sandbox, '.hermes', 'SOUL.md');
  atomicWrite(soul, 'Private personality\r\n');
  const config = path.join(sandbox, '.hermes', 'config.yaml');
  atomicWrite(config, YAML.stringify({ agent: { system_prompt: 'Keep private prompt' }, personalities: { selected: 'Keep personality' } }));
  const before = fs.readFileSync(config);
  install(['hermes']);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(soul, 'utf8'), 'Private personality\r\n');
  const installed = YAML.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(installed.agent.system_prompt, 'Keep private prompt');
  assert.equal(installed.personalities.selected, 'Keep personality');
  rollback();
  assert.deepEqual(fs.readFileSync(config), before);
});
test('owned hook detection is independent of installation directory name', () => {
  const command = '"/usr/local/bin/node" "/tmp/agent-context-011-review/bin/agent-context.js" hook claude';
  const value = stripHooks({ hooks: { PostToolUse: [{ hooks: [{ command }, { command: 'echo agent-context is a word' }] }] } });
  assert.deepEqual(value.hooks.PostToolUse[0].hooks, [{ command: 'echo agent-context is a word' }]);
});
test('doctor resolves a symlinked home before checking project overrides', () => {
  const alias = `${sandbox}-alias`, cwd = process.cwd();
  fs.symlinkSync(sandbox, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const previous = process.env.AGENT_CONTEXT_HOME;
  try {
    process.env.AGENT_CONTEXT_HOME = alias;
    process.chdir(sandbox);
    assert.deepEqual(doctor().projectOverrides, []);
  } finally { process.env.AGENT_CONTEXT_HOME = previous; process.chdir(cwd); }
});
test('doctor distinguishes global home config from project overrides', () => {
  const cwd = process.cwd();
  try {
    process.chdir(sandbox);
    assert.deepEqual(doctor().projectOverrides, []);
    const project = path.join(sandbox, 'project');
    atomicWrite(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { supercompress: { command: 'old' } } }));
    process.chdir(project);
    assert.deepEqual(doctor().projectOverrides, ['.mcp.json']);
  } finally { process.chdir(cwd); }
});
test('concurrent installer/rollback are refused without touching configuration', () => {
  const lock = path.join(root(), 'install.lock');
  fs.mkdirSync(lock);
  try {
    const before = fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'));
    assert.throws(() => install(['codex']), /transaction busy/);
    assert.throws(() => rollback(), /transaction busy/);
    assert.deepEqual(fs.readFileSync(path.join(sandbox, '.codex', 'config.toml')), before);
    assert.ok(doctor().issues.includes('installation_lock_present'));
  } finally { fs.rmdirSync(lock); }
});
test('native MCP JSONL initializes, lists tools and returns safe missing-key fallback', async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-mcp-'));
  const child = spawn(process.execPath, [path.resolve('bin/agent-context.js'), 'mcp', 'hermes'], { env: { ...process.env, AGENT_CONTEXT_HOME: isolated, SUPERCOMPRESS_API_KEY: '' }, windowsHide: true });
  let raw = '', errors = '';
  child.stdout.on('data', value => { raw += value; });
  child.stderr.on('data', value => { errors += value; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'compress_context', arguments: { context, query } } }
  ];
  child.stdin.end(messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  await done;
  assert.equal(errors, '');
  const responses = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.serverInfo.name, 'agent-context');
  assert.equal(responses[1].result.tools[0].name, 'compress_context');
  const policy = responses[1].result.tools[0].description;
  for (const rule of ['Never compress the user query', 'retain original context', 'already_seen means no new digest', 'unrelated global inbox', 'total token savings without measurements']) assert.ok(policy.includes(rule), rule);
  const result = JSON.parse(responses[2].result.content[0].text);
  assert.equal(result.skipped, 'missing_key');
  assert.equal(result.compressed_text, context);
});
test('native MCP handles split Content-Length framing', async () => {
  const child = spawn(process.execPath, [path.resolve('bin/agent-context.js'), 'mcp', 'codex'], { env: { ...process.env, AGENT_CONTEXT_HOME: sandbox, SUPERCOMPRESS_API_KEY: '' }, windowsHide: true });
  const chunks = [];
  child.stdout.on('data', value => chunks.push(value));
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
  child.stdin.write('Content-Le');
  await new Promise(resolve => setTimeout(resolve, 20));
  child.stdin.end(Buffer.concat([Buffer.from(`ngth: ${body.length}\r\n\r\n`), body]));
  await done;
  const response = Buffer.concat(chunks), split = response.indexOf('\r\n\r\n');
  const length = Number(/Content-Length: (\d+)/.exec(response.subarray(0, split).toString())[1]);
  assert.equal(response.subarray(split + 4).length, length);
  assert.equal(JSON.parse(response.subarray(split + 4)).id, 9);
});
test.after(() => { /* Test state retained in OS scratch for evidence, never added to package. */ });
