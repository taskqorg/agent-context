import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import { install } from '../src/install.js';
import { uninstall, undo } from '../src/uninstall.js';
import { root } from '../src/core.js';
import { servicePort } from '../src/service.js';

const noGlobal = async () => 'fixture_not_global';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-remove-'));
  process.env.AGENT_CONTEXT_HOME = home;
  for (const agent of ['codex', 'claude', 'hermes']) fs.mkdirSync(path.join(home, '.' + agent));
  const file = path.join(home, '.codex/config.toml');
  fs.writeFileSync(file, '# owner comment\nmodel="original"\n[mcp_servers.other]\ncommand="keep"\n');
  fs.mkdirSync(path.join(home, '.supercompress')); fs.writeFileSync(path.join(home, '.supercompress/config.json'), '{"api_key":"synthetic_keep"}');
  return { home, file };
}

test('uninstall reverses all installs, preserves original bytes/credentials and deletes managed data', async () => {
  const { home, file } = fixture(), before = fs.readFileSync(file);
  install(['codex']); install(['codex', 'claude', 'hermes'], { automatic: true });
  const preview = await uninstall({ dryRun: true, removeGlobal: noGlobal });
  assert.equal(preview.status, 'preview'); assert.ok(fs.existsSync(root()));
  const result = await uninstall({ removeGlobal: noGlobal });
  assert.equal(result.status, 'removed'); assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(root()), false);
  assert.equal(fs.existsSync(path.join(home, '.claude/settings.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.hermes/plugins/agent-context')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.supercompress/config.json'))).api_key, 'synthetic_keep');
  assert.equal((await uninstall({ removeGlobal: noGlobal })).status, 'already_removed');
});

test('enrolled uninstall restores native credential routing while preserving later unrelated env edits', async () => {
  const { home } = fixture();
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), 'enrollment.json'), JSON.stringify({ gateway: 'https://gateway.invalid', device: 'a'.repeat(32), token: 'acd_' + 'b'.repeat(64), user: 'employee' }));
  const envFile = path.join(home, '.hermes/.env');
  fs.writeFileSync(envFile, 'OWNER=before\nHERMES_LANGFUSE_BASE_URL=https://original.invalid\n');
  install(['codex', 'claude', 'hermes'], { automatic: true });
  fs.appendFileSync(envFile, 'LATER=keep\n');
  await uninstall({ removeGlobal: noGlobal });
  const restored = fs.readFileSync(envFile, 'utf8');
  assert.ok(restored.includes('LATER=keep'));
  assert.ok(restored.includes('HERMES_LANGFUSE_BASE_URL=https://original.invalid'));
  assert.equal(restored.includes('sk-lf-device-'), false);
  assert.equal(fs.existsSync(path.join(home, '.codex/langfuse.json')), false);
});

test('owner changes to other config values, hooks and instructions survive removal', async () => {
  const { home, file } = fixture(); install(['codex', 'claude'], { automatic: true });
  const config = parse(fs.readFileSync(file, 'utf8')); config.model = 'owner_new_model';
  fs.writeFileSync(file, '# new owner comment\n' + stringify(config));
  const settings = path.join(home, '.claude/settings.json'); const s = JSON.parse(fs.readFileSync(settings));
  s.env.OWNER = 'keep'; s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'owner-hook' }] }); fs.writeFileSync(settings, JSON.stringify(s));
  const instructions = path.join(home, '.codex/AGENTS.md'); fs.appendFileSync(instructions, '\nOwner new instruction.\n');
  await uninstall({ removeGlobal: noGlobal });
  const c = parse(fs.readFileSync(file, 'utf8'));
  assert.equal(c.model, 'owner_new_model'); assert.equal(c.model_provider, undefined); assert.equal(c.mcp_servers.other.command, 'keep');
  assert.ok(fs.readFileSync(file, 'utf8').includes('# new owner comment'));
  assert.equal(JSON.parse(fs.readFileSync(settings)).env.OWNER, 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)).hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'owner-hook' }] }]);
  assert.ok(fs.readFileSync(instructions, 'utf8').includes('Owner new instruction.'));
  assert.ok(!fs.readFileSync(instructions, 'utf8').includes('agent-context:start'));
});

test('drift to owned routing refuses before modifying any file or deleting evidence', async () => {
  const { file } = fixture(); install(['codex'], { automatic: true });
  const c = parse(fs.readFileSync(file, 'utf8')); c.model_providers.agent_context.base_url = 'https://owner-routing.example';
  fs.writeFileSync(file, stringify(c)); const before = fs.readFileSync(file);
  await assert.rejects(uninstall({ removeGlobal: noGlobal }), /Uninstall refused/);
  assert.deepEqual(fs.readFileSync(file), before); assert.ok(fs.existsSync(root()));
});

test('busy owned service refuses before configuration change and sends no shutdown', async () => {
  const { file } = fixture(); install(['codex'], { automatic: true }); const before = fs.readFileSync(file);
  fs.mkdirSync(path.join(root(), 'services')); const owner = '12345678-1234-1234-1234-123456789abc';
  fs.writeFileSync(path.join(root(), 'services/codex.json'), JSON.stringify({ agent: 'codex', port: servicePort('codex'), owner, childPid: 42 }));
  const fetch = globalThis.fetch; let shutdown = false;
  globalThis.fetch = async (url, options) => { if (options?.method === 'POST') shutdown = true; return new Response(JSON.stringify({ owner, pid: 42, active: 1 })); };
  try { await assert.rejects(uninstall({ removeGlobal: noGlobal }), /busy codex/); assert.equal(shutdown, false); assert.deepEqual(fs.readFileSync(file), before); }
  finally { globalThis.fetch = fetch; }
});

test('tampered journal path cannot touch arbitrary home files', async () => {
  const { home } = fixture(); install(['codex'], { automatic: true });
  const pointer = JSON.parse(fs.readFileSync(path.join(root(), 'latest-install.json'))), file = path.join(pointer.dir, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(file)); journal.files[0].file = path.join(home, '.profile'); fs.writeFileSync(file, JSON.stringify(journal));
  await assert.rejects(uninstall({ removeGlobal: noGlobal }), /outside installed files/); assert.ok(fs.existsSync(root()));
});

test('failed global removal restores config, plugin migration and retains recovery data', async () => {
  const { home, file } = fixture(); const plugin = path.join(home, '.hermes/plugins/supercompress');
  fs.mkdirSync(plugin, { recursive: true }); fs.writeFileSync(path.join(plugin, 'plugin.py'), 'original');
  install(['codex', 'hermes'], { automatic: true }); const before = fs.readFileSync(file);
  await assert.rejects(uninstall({ removeGlobal: async () => { throw new Error('fixture npm failure'); } }), /fixture npm failure/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(plugin), false); assert.ok(fs.existsSync(root()));
  await uninstall({ removeGlobal: noGlobal }); assert.equal(fs.readFileSync(path.join(plugin, 'plugin.py'), 'utf8'), 'original');
});

test('array inverse preserves later owner additions and removes only installer additions', () => {
  assert.deepEqual(undo(['keep'], ['keep', 'agent-context'], ['keep', 'agent-context', 'new']), ['keep', 'new']);
});
test('failed preparation without registrations can be removed; unjournaled owned registration refuses', async () => {
  const { file } = fixture(); fs.mkdirSync(path.join(root(), 'headroom'), { recursive: true });
  fs.writeFileSync(file, 'model_provider="agent_context"\n');
  await assert.rejects(uninstall({ removeGlobal: noGlobal }), /no restoration journal/);
  fs.writeFileSync(file, 'model="keep"\n');
  assert.equal((await uninstall({ removeGlobal: noGlobal })).status, 'removed'); assert.equal(fs.existsSync(root()), false);
});

test('uninstall refuses active owned native command, then removes completed recovery data',async()=>{
 const {home,file}=fixture();install(['codex'],{automatic:true});const before=fs.readFileSync(file);
 const id=crypto.randomUUID(),dir=path.join(os.tmpdir(),'agent-context-native-'+id);
 fs.mkdirSync(dir,{mode:0o700});const marker={schema:1,id,owner:root(),pid:process.pid,at:Date.now(),completed:false};
 try{
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(marker));
  await assert.rejects(uninstall({removeGlobal:noGlobal}),/native command still running/);
  assert.deepEqual(fs.readFileSync(file),before);
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({...marker,completed:true}));
  assert.ok((await uninstall({dryRun:true,removeGlobal:noGlobal})).removeTemporaryData.includes(dir));
  await uninstall({removeGlobal:noGlobal});assert.equal(fs.existsSync(dir),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(home,{recursive:true,force:true})}
});
