import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install } from '../src/install.js';
import { rollbackUpdate } from '../src/update.js';
import { root, version } from '../src/core.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-migration-'));
process.env.AGENT_CONTEXT_HOME = home;
test('migration from a verified legacy bootstrap upgrades code and restores matching config on package rollback', { skip: !fs.existsSync(new URL('../.git', import.meta.url)) }, async () => {
  const old = path.join(home, 'legacy'); fs.mkdirSync(old);
  // A file, not stdin: bsdtar may stop reading at the end-of-archive marker, and the piped padding then fails with EPIPE.
  // Relative name: GNU tar reads "C:\..." as a remote host.
  execFileSync('git', ['archive', '-o', path.join(home, 'source.tar'), 'HEAD']); execFileSync('tar', ['-xf', 'source.tar', '-C', 'legacy'], { cwd: home });
  for (const name of ['smol-toml', 'yaml']) fs.cpSync(new URL('../node_modules/' + name, import.meta.url), path.join(old, 'node_modules', name), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  const config = path.join(home, '.codex/config.toml'); fs.writeFileSync(config, '# owner comment\nmodel="existing"\n');
  execFileSync(process.execPath, [path.join(old, 'bin/agent-context.js'), 'install', 'codex'], { env: process.env, stdio: 'ignore' });
  const before = fs.readFileSync(config);
  const legacyVersion = JSON.parse(fs.readFileSync(path.join(old, 'package.json'))).version;
  if (legacyVersion === version) return; // A release checkout already includes the new bootstrap.
  if (legacyVersion.split('.').slice(0, 2).join('.') !== version.split('.').slice(0, 2).join('.')) assert.throws(() => install(['codex'], { automatic: true }), /requires migration/);
  install(['codex'], { automatic: true, migrate: true });
  const pointer = JSON.parse(fs.readFileSync(path.join(root(), 'active.json')));
  assert.equal(pointer.version, version); assert.equal(pointer.previous.version, legacyVersion);
  assert.match(fs.readFileSync(config, 'utf8'), /model_provider = "agent_context"/);
  const routed = fs.readFileSync(config);
  const result = await rollbackUpdate();
  assert.equal(result.version, legacyVersion);
  // A previous version that already speaks automatic mode keeps the routed config; older ones get it restored.
  const legacyAutomatic = fs.existsSync(path.join(old, 'src/automatic.js'));
  assert.deepEqual(fs.readFileSync(config), legacyAutomatic ? routed : before);
});
