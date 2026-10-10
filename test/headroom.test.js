import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareHeadroom } from '../src/headroom.js';
import { startProxy, runAgent } from '../src/run.js';

test('owned proxy startup rejects a missing executable without hanging; invalid agents do not start it', async () => {
  await assert.rejects(startProxy({ python: path.join(os.tmpdir(), 'agent-context-nonexistent-python') }), /startup failed/);
  await assert.rejects(runAgent('unsupported', []), /Usage:/);
});

test('Headroom preparation marks only verified runtime ready and releases failure lock', async () => {
  const previous = process.env.AGENT_CONTEXT_HOME;
  process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-prepare-test-'));
  const work = process.env.AGENT_CONTEXT_HOME;
  try {
    await assert.rejects(prepareHeadroom(async (_exe, args) => {
      if (args.includes('pip')) throw new Error('offline');
      return { stdout: '' };
    }), /offline/);
    const recipeDir = path.join(work, '.agent-context', 'headroom', fs.readdirSync(path.join(work, '.agent-context', 'headroom'))[0]);
    assert.equal(fs.existsSync(path.join(recipeDir, 'ready.json')), false);
    assert.equal(fs.existsSync(path.join(recipeDir, 'prepare.lock')), false);
    const calls = [];
    const runtime = await prepareHeadroom(async (exe, args) => {
      calls.push(args);
      if (args.includes('pip')) {
        fs.writeFileSync(exe, '');
        fs.writeFileSync(path.join(path.dirname(exe), process.platform === 'win32' ? 'headroom.exe' : 'headroom'), '');
      }
      if (args.includes('venv')) fs.mkdirSync(path.join(args.at(-1), process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
      return { stdout: '' };
    });
    assert.equal(runtime.reused, false);
    assert.ok(calls.some(args => args.some(arg => arg.includes('r.discover()'))));
    assert.equal((await prepareHeadroom(async () => { throw new Error('unexpected reinstall'); })).reused, true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_HOME; else process.env.AGENT_CONTEXT_HOME = previous;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('package integrity rejects modified Python adapter', async () => {
  const { checkPackage } = await import('../src/update.js');
  const source = new URL('../', import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-integrity-test-'));
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('integrity.json', source)));
    for (const file of ['package.json', 'integrity.json', ...Object.keys(manifest.files)]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(new URL(file, source), path.join(dir, file));
    }
    checkPackage(dir, manifest.version);
    fs.appendFileSync(path.join(dir, 'integrations/headroom/agent_context_headroom/__init__.py'), '\n# altered\n');
    assert.throws(() => checkPackage(dir, manifest.version), /package integrity/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
