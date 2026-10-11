import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sha, root, version } from '../src/core.js';
import { seedRuntime, launcher, update, rollbackUpdate, updateStatus, compatibleUpdate, UPDATE_CHECK_INTERVAL_MS, enableUpdates, verifyRecipeSignature } from '../src/update.js';
import crypto from 'node:crypto';
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
const signing = crypto.generateKeyPairSync('ed25519');
const testPublicKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
const nextPatch = version.split('.').map((part, index) => index === 2 ? Number(part) + 1 : part).join('.');
function fixture({ badDigest = false, qualified = true, next = nextPatch, extra = {} } = {}) {
  const bytes = Buffer.from('synthetic package archive');
  const recipe = Buffer.from(JSON.stringify({ schema: 1, version: next, launcherSchema: 1, adapterContract: 1, platforms: [process.platform], clients: qualified ? ['codex', 'claude', 'hermes'] : ['codex'], archive: 'candidate.tgz', sha256: sha(bytes), ...extra }));
  const asset = (name, data) => ({ name, state: 'uploaded', digest: `sha256:${sha(data)}`, size: data.length, browser_download_url: `https://github.com/taskqorg/agent-context/releases/download/v${next}/${name}` });
  const signature = Buffer.from(crypto.sign(null, recipe, signing.privateKey).toString('base64'));
  const release = { tag_name: `v${next}`, draft: false, prerelease: false, assets: [asset('recipe.json', recipe), asset('recipe.json.sig', signature), asset('candidate.tgz', bytes)] };
  if (badDigest) release.assets[2].digest = `sha256:${'0'.repeat(64)}`;
  let calls = 0;
  return {
    calls: () => calls,
    publicKey: testPublicKey,
    fetcher: async url => { calls++; return new Response(url.endsWith('latest') ? JSON.stringify(release) : url.endsWith('recipe.json') ? recipe : url.endsWith('recipe.json.sig') ? signature : bytes); },
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
  assert.equal(result.status, 'updated'); assert.equal(JSON.parse(run().stdout).version, nextPatch);
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
test('migration accepts the reviewed hardened legacy bootstrap but refuses unknown edits and damaged old code', () => {
  const dir = path.join(root(), 'versions', 'legacy-bootstrap');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const files = { 'bin/agent-context.js': 'console.log("legacy");', 'src/update.js': 'export function seedRuntime(){throw new Error("launcher drift")}\n' };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@alexkirs/agent-context', version: '0.1.3', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify({ version: '0.1.3', files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha(value)])) }));
  const bootstrap = fs.readFileSync(new URL('./fixtures/legacy-launcher.txt', import.meta.url));
  const legacy = { version: '0.1.3', dir };
  const select = text => { fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify(legacy)); fs.writeFileSync(launcher(), text); };
  const originalBootstrap = fs.readFileSync(launcher());
  try {
    select(Buffer.concat([bootstrap, Buffer.from('// unknown edit\n')]));
    assert.throws(() => seedRuntime({ migrate: true })); assert.equal(pointer().version, '0.1.3');
    select(bootstrap); fs.appendFileSync(path.join(dir, 'bin/agent-context.js'), '// damaged');
    assert.throws(() => seedRuntime({ migrate: true }), /package integrity/); assert.equal(pointer().version, '0.1.3');
    fs.writeFileSync(path.join(dir, 'bin/agent-context.js'), files['bin/agent-context.js']);
    if (version.split('.')[1] !== '1') assert.throws(() => seedRuntime(), /requires migration/);
    const migrated = seedRuntime({ migrate: true });
    assert.equal(migrated.version, version); assert.equal(migrated.previous.version, '0.1.3');
    assert.notEqual(fs.readFileSync(launcher(), 'utf8'), bootstrap.toString());
  } finally { restore(); fs.writeFileSync(launcher(), originalBootstrap); }
});
test('gateway rollback cannot select a previous package without a collector while device routing remains', async () => {
  restore();
  const previous = { version: '0.1.3', dir: path.join(root(), 'versions', 'legacy-bootstrap') };
  fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify({ ...initial, previous }));
  fs.writeFileSync(path.join(root(), 'enrollment.json'), '{}');
  const before = pointer();
  try {
    await assert.rejects(rollbackUpdate(), /credential routing restoration/);
    assert.deepEqual(pointer(), before);
  } finally { fs.rmSync(path.join(root(), 'enrollment.json')); restore(); }
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
  const nextMinor = version.split('.').map((part, index) => index === 1 ? Number(part) + 1 : index === 2 ? 0 : part).join('.');
  restore(); const before = pointer(); assert.equal((await update(fixture({ next: nextMinor }))).status, 'migration_required'); assert.deepEqual(pointer(), before);
  assert.equal(compatibleUpdate('0.1.3', '0.1.4'), true);
  for (const next of ['0.1.2', '0.2.0', '1.1.4', '0.1.4-rc.1']) assert.equal(compatibleUpdate('0.1.3', next), false);
});
test('rollback refuses modified previous code; symlink pointers cannot escape managed versions', async () => {
  restore(); await update(fixture());
  const previous = pointer().previous;
  const file = path.join(previous.dir, 'src/core.js'), before = fs.readFileSync(file);
  fs.appendFileSync(file, '\n// external edit');
  try { await assert.rejects(rollbackUpdate(), /package integrity/); assert.equal(pointer().version, nextPatch); }
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
test('kill switch and staged rollout keep the active runtime; failures back off from 1h', async () => {
  restore();
  const before = pointer();
  const paused = fixture({ extra: { paused: true } });
  assert.equal((await update(paused)).status, 'paused'); assert.deepEqual(pointer(), before);
  restore();
  const staged = fixture({ extra: { rolloutPercent: 0 } });
  assert.equal((await update(staged)).status, 'staged_wait'); assert.deepEqual(pointer(), before);
  restore();
  await update({ fetcher: async () => { throw new Error('offline'); } });
  const state = JSON.parse(fs.readFileSync(path.join(root(), 'updates.json')));
  assert.equal(state.failures, 1);
  assert.ok(Math.abs(Date.now() - state.lastAttempt - (UPDATE_CHECK_INTERVAL_MS - 3600000)) < 60000, 'next automatic try in ~1h');
});
test('automatic checks wait one hour and preserve escalating network retry backoff', async () => {
  restore();
  try {
    fs.writeFileSync(path.join(root(), 'updates.json'), JSON.stringify({ enabled: true, lastAttempt: Date.now() - 59 * 60000 }));
    const early = fixture();
    assert.equal((await update({ ...early, automatic: true })).status, 'not_due');
    assert.equal(early.calls(), 0);
    fs.writeFileSync(path.join(root(), 'updates.json'), JSON.stringify({ enabled: true, lastAttempt: Date.now() - 61 * 60000 }));
    assert.equal((await update({ automatic: true, fetcher: async () => new Response('', { status: 404 }) })).status, 'no_stable_release');
    restore();
    for (const wait of [3600000, 6 * 3600000, 86400000]) {
      assert.equal((await update({ fetcher: async () => { throw new Error('offline'); } })).status, 'failed');
      const state = updateStatus();
      assert.ok(Math.abs(state.lastAttempt + UPDATE_CHECK_INTERVAL_MS - Date.now() - wait) < 60000);
      const blocked = fixture();
      assert.equal((await update({ ...blocked, automatic: true })).status, 'not_due');
      assert.equal(blocked.calls(), 0);
    }
  } finally { restore(); }
});
test('installed launcher starts an hourly updater only after it is due', async () => {
  restore();
  const dir = path.join(root(), 'versions', 'hourly-launcher-fixture');
  const marker = path.join(root(), 'hourly-updater-started');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const files = { 'bin/agent-context.js': `import fs from 'node:fs'; if(process.argv[2]==='update')fs.writeFileSync(${JSON.stringify(marker)},'started');`, 'src/update.js': 'export {};\n' };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@alexkirs/agent-context', version, type: 'module' }));
  fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify({ version, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])) }));
  try {
    fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify({ version, dir }));
    for (const minutes of [59, 61]) {
      fs.writeFileSync(path.join(root(), 'updates.json'), JSON.stringify({ enabled: true, lastAttempt: Date.now() - minutes * 60000 }));
      const child = spawnSync(process.execPath, [launcher(), 'mcp'], { env: process.env, windowsHide: true, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      if (minutes === 59) assert.equal(fs.existsSync(marker), false);
      else {
        for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(fs.readFileSync(marker, 'utf8'), 'started');
      }
    }
  } finally { restore(); }
});
test('release signature verification accepts only the matching Ed25519 key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const bytes = Buffer.from('{"schema":1}');
  const signature = crypto.sign(null, bytes, privateKey);
  assert.equal(verifyRecipeSignature(bytes, signature, pem), true);
  assert.equal(verifyRecipeSignature(Buffer.from('{"schema":2}'), signature, pem), false);
  assert.equal(verifyRecipeSignature(bytes, Buffer.alloc(0), pem), false);
});
test('release signed with a different key is refused before download', async () => {
  restore();
  const before = pointer();
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const result = await update({ ...fixture(), publicKey: other });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'Update refused: recipe signature'); assert.deepEqual(pointer(), before);
});
test('new release notification bypasses hourly wait once, but failed retries retain backoff and disable wins', async () => {
  restore();
  fs.writeFileSync(path.join(root(), 'updates.json'), JSON.stringify({ enabled: true, lastAttempt: Date.now(), status: 'current' }));
  const f = fixture();
  assert.equal((await update({ ...f, automatic: true, notifiedVersion: nextPatch })).status, 'updated');
  restore();
  const offline = { automatic: true, notifiedVersion: nextPatch, fetcher: async () => { throw new Error('offline'); } };
  assert.equal((await update(offline)).status, 'failed');
  assert.equal((await update(offline)).status, 'not_due');
  enableUpdates(false);
  assert.equal((await update({ ...fixture(), automatic: true, notifiedVersion: '9.9.9' })).status, 'not_due');
  restore();
});
test('an older latest stable release never requests a downgrade or migration', async () => {
  restore(); const before = pointer();
  assert.equal((await update(fixture({ next: '0.1.18' }))).status, 'current');
  assert.deepEqual(pointer(), before); assert.equal(updateStatus().availableVersion, '0.1.18');
});
test('monitor supervisor reloads a verified new runtime without restarting agent processes', () => {
  restore();
  const marker = path.join(root(), 'monitor-reloaded');
  const make = (name, code) => {
    const dir = path.join(root(), 'versions', name); fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.mkdirSync(path.join(dir, 'src'));
    const files = { 'bin/agent-context.js': code, 'src/update.js': 'export {};\n' };
    for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), contents);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@alexkirs/agent-context', version, type: 'module' }));
    fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify({ version, files: Object.fromEntries(Object.entries(files).map(([file, contents]) => [file, sha(contents)])) }));
    return { dir, version };
  };
  const next = make('monitor-next', `import fs from 'node:fs';if(process.argv[3]!=='worker')process.exit(9);fs.writeFileSync(${JSON.stringify(marker)},'reloaded');`);
  const old = make('monitor-old', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root(), 'active.json'))},${JSON.stringify(JSON.stringify(next))});process.exit(75);`);
  try {
    fs.writeFileSync(path.join(root(), 'active.json'), JSON.stringify(old));
    const child = spawnSync(process.execPath, [launcher(), 'monitor', 'serve'], { env: process.env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(fs.readFileSync(marker, 'utf8'), 'reloaded');
  } finally { restore(); }
});
