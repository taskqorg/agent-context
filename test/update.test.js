import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sha, root, version } from '../src/core.js';
import { seedRuntime, launcher, update, rollbackUpdate, updateStatus, compatibleUpdate, enableUpdates } from '../src/update.js';
import { install, rollback } from '../src/install.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-update-'));
process.env.AGENT_CONTEXT_HOME = home;
delete process.env.SUPERCOMPRESS_API_KEY;
const initial = seedRuntime();
const pointer = () => JSON.parse(fs.readFileSync(path.join(root(), 'active.json')));
const restore = () => {
  fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify(initial));
  fs.writeFileSync(path.join(root(), 'updates.json'), JSON.stringify({ enabled: true, lastAttempt: 0 }));
  fs.writeFileSync(path.join(root(), 'update-policy.json'), JSON.stringify({ enabled: true }));
};
function fixture({ badDigest = false, qualified = true, next = '0.1.7' } = {}) {
  const bytes = Buffer.from('synthetic package archive');
  const recipe = Buffer.from(JSON.stringify({ schema: 1, version: next, launcherSchema: 1, adapterContract: 1, platforms: [process.platform], clients: qualified ? ['codex', 'claude', 'hermes'] : ['codex'], archive: 'candidate.tgz', sha256: sha(bytes) }));
  const asset = (name, data) => ({ name, state: 'uploaded', digest: `sha256:${sha(data)}`, size: data.length, browser_download_url: `https://github.com/taskqorg/agent-context/releases/download/v${next}/${name}` });
  const release = { tag_name: `v${next}`, draft: false, prerelease: false, assets: [asset('recipe.json', recipe), asset('candidate.tgz', bytes)] };
  if (badDigest) release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
  let calls = 0;
  return {
    calls: () => calls,
    fetcher: async url => { calls++; return new Response(url.endsWith('latest') ? JSON.stringify(release) : url.endsWith('recipe.json') ? recipe : bytes); },
    preparer: async (archive, stage, expected) => {
      assert.equal(fs.readFileSync(archive).toString(), bytes.toString());
      const dir = path.join(stage, 'package'); fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'src'));
      const files = { 'bin/agent-context.js': `console.log(JSON.stringify({version:'${expected}'}));`, 'src/update.js': 'export {};\n' };
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@alexkirs/agent-context', version: expected, type: 'module' }));
      fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify({ version: expected, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])) }));
      return dir;
    }
  };
}
test('stable launcher follows atomic upgrade and rollback without changing agent configs', async () => {
  restore();
  const run = () => spawnSync(process.execPath, [launcher(), '--version'], { env: process.env, windowsHide: true, encoding: 'utf8' });
  assert.equal(JSON.parse(run().stdout).version, version);
  const oldDir = pointer().dir;
  const result = await update(fixture());
  assert.equal(result.status, 'updated'); assert.equal(JSON.parse(run().stdout).version, '0.1.7');
  assert.ok(fs.existsSync(oldDir)); assert.equal(pointer().previous.dir, oldDir);
  assert.equal((await rollbackUpdate()).version, version);
  assert.equal(JSON.parse(run().stdout).version, version);
  assert.equal(updateStatus().enabled, false);
  const f = fixture(); assert.equal((await update({ ...f, automatic: true })).status, 'not_due'); assert.equal(f.calls(), 0);
});
test('launcher resolves home aliases; no stable release is an idle state', async () => {
  restore();
  const alias = `${home}-alias`; fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawnSync(process.execPath, [path.join(alias, '.agent-context', 'launcher.mjs'), '--version'], { env: { ...process.env, AGENT_CONTEXT_HOME: alias }, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).version, version);
  assert.equal((await update({ fetcher: async () => new Response('', { status: 404 }) })).status, 'no_stable_release');
  assert.equal(updateStatus().status, 'no_stable_release');
});
test('tampered archive/qualification never reaches installation or switches active runtime', async () => {
  for (const options of [{ badDigest: true }, { qualified: false }]) {
    restore(); const before = pointer(); let prepared = false;
    const result = await update({ ...fixture(options), preparer: async () => { prepared = true; } });
    assert.equal(result.status, 'failed'); assert.equal(prepared, false); assert.deepEqual(pointer(), before);
  }
});
test('failed self-test and network failure retain working runtime and throttle automatic retries', async () => {
  for (const options of [{ ...fixture(), preparer: async () => { throw new Error('secret raw error must not appear'); } }, { fetcher: async () => { throw new Error('private network exception'); } }]) {
    restore(); const before = pointer(); const result = await update(options);
    assert.equal(result.status, 'failed'); assert.deepEqual(pointer(), before);
    assert.ok(!result.reason.includes('secret') && !result.reason.includes('private'));
    const f = fixture(); assert.equal((await update({ ...f, automatic: true })).status, 'not_due'); assert.equal(f.calls(), 0);
  }
});
test('one updater owns the transition and configuration transactions prevent switching', async () => {
  restore(); const lock = path.join(root(), 'install.lock'); fs.mkdirSync(lock);
  const f = fixture(); assert.equal((await update(f)).status, 'busy'); assert.equal(f.calls(), 0); fs.rmdirSync(lock);
  const before = pointer(); const installLock = path.join(root(), 'install.lock'); fs.mkdirSync(installLock);
  try { assert.equal((await update(fixture())).status, 'busy'); assert.deepEqual(pointer(), before); }
  finally { fs.rmdirSync(installLock); }
});
test('explicit disable during staging survives status writes and cancels activation', async () => {
  restore(); const before = pointer(), f = fixture();
  const result = await update({ ...f, preparer: async (...args) => { enableUpdates(false); return f.preparer(...args); } });
  assert.equal(result.status, 'disabled_before_activation'); assert.deepEqual(pointer(), before); assert.equal(updateStatus().enabled, false);
});
test('update owns the same transaction lock as configuration install and rollback', async () => {
  restore(); const f = fixture();
  const result = await update({ ...f, preparer: async (...args) => {
    assert.throws(() => install(['codex']), /Configuration transaction busy/);
    assert.throws(() => rollback(), /Configuration transaction busy/);
    return f.preparer(...args);
  } });
  assert.equal(result.status, 'updated');
});
test('launcher refuses corrupted runtime instead of executing modified code', async () => {
  restore(); await update(fixture());
  fs.writeFileSync(path.join(pointer().dir, 'bin/agent-context.js'), 'console.log("INTEGRITY_BYPASS_SYNTHETIC_FIXTURE");');
  const child = spawnSync(process.execPath, [launcher(), '--version'], { env: process.env, windowsHide: true, encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.ok(child.stderr.includes('Agent Context integrity failed')); assert.equal(child.stdout, '');
});
test('runtime drift detected before final switch; incompatible minor requires migration', async () => {
  restore(); const f = fixture();
  const result = await update({ ...f, preparer: async (...args) => { const dir = await f.preparer(...args); fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify({ ...initial, marker: 'external-change' })); return dir; } });
  assert.equal(result.status, 'failed'); assert.equal(pointer().marker, 'external-change');
  restore(); const before = pointer(); assert.equal((await update(fixture({ next: '0.2.0' }))).status, 'migration_required'); assert.deepEqual(pointer(), before);
  assert.equal(compatibleUpdate('0.1.3', '0.1.4'), true);
  for (const next of ['0.1.2', '0.2.0', '1.1.4', '0.1.4-rc.1']) assert.equal(compatibleUpdate('0.1.3', next), false);
});
test('rollback refuses modified previous code; symlink pointers cannot escape managed versions', async () => {
  restore(); await update(fixture());
  const previous = pointer().previous;
  const file = path.join(previous.dir, 'src/core.js'), before = fs.readFileSync(file);
  fs.appendFileSync(file, '\n// external edit');
  try { await assert.rejects(rollbackUpdate(), /package integrity/); assert.equal(pointer().version, '0.1.7'); }
  finally { fs.writeFileSync(file, before); }
  restore(); const alias = path.join(root(), 'versions', 'outside'); fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify({ version, dir: alias }));
  await assert.rejects(update(fixture()), /runtime path/);
  restore();
});
test('recovery CLI restores a valid previous runtime without loading corrupted active code', async () => {
  restore(); await update(fixture());
  fs.writeFileSync(path.join(pointer().dir, 'bin/agent-context.js'), 'throw new Error("broken active runtime");');
  const child = spawnSync(process.execPath, [path.resolve('bin/agent-context.js'), 'update', 'rollback'], { env: process.env, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'rolled_back'); assert.equal(pointer().version, version);
  assert.equal(updateStatus().enabled, false);
});
