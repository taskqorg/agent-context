import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test('final npm version prints only the migration instruction', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../npm-final/package.json', import.meta.url)));
  assert.equal(pkg.scripts, undefined);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../npm-final/agent-context.js', import.meta.url)), 'setup', '--yes'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /agentq onboard --yes/);
  assert.match(run.stderr, /github\.com\/taskqorg\/agentq\/releases\/latest/);
});
