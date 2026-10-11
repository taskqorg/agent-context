import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorServicePlan, installMonitorService, removeMonitorService } from '../src/monitor-service.js';
process.env.AGENT_CONTEXT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'contextq-service-'));
test('persistent services use the stable launcher on every OS, with no service credentials', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = monitorServicePlan(platform);
    const scripts = [plan.text || '', ...plan.start.map(([, args]) => platform === 'win32' ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : args.join(' '))].join('\n');
    assert.ok(scripts.includes('launcher.mjs')); assert.ok(scripts.includes('monitor')); assert.ok(!scripts.includes('monitor-runtime'));
    assert.ok(!scripts.includes('sk-lf-'));
  }
});
test('installer refuses unrelated files and uninstall refuses edited service ownership', () => {
  const platform = 'linux', plan = monitorServicePlan(platform), commands = [], run = (command, args) => commands.push([command, args]);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true }); fs.writeFileSync(plan.file, 'unrelated');
  assert.throws(() => installMonitorService({ platform, run, migrate: true }), /reviewed migration/);
  fs.unlinkSync(plan.file);
  assert.equal(installMonitorService({ platform, run }).status, 'installed');
  assert.equal(commands.length, 2);
  installMonitorService({ platform, run }); assert.equal(commands.length, 2);
  fs.appendFileSync(plan.file, '# changed'); assert.throws(() => removeMonitorService({ run }), /configuration drift/);
  fs.writeFileSync(plan.file, plan.text); removeMonitorService({ run }); assert.equal(fs.existsSync(plan.file), false);
});
