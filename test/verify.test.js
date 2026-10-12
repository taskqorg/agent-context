import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verify } from '../src/verify.js';
import { proxyBypassed } from '../src/service.js';

test('automatic verify reports instead of throwing when the legacy adapter was removed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-verify-'));
  process.env.AGENT_CONTEXT_HOME = home;
  delete process.env.SUPERCOMPRESS_API_KEY;
  fs.mkdirSync(path.join(home, '.hermes'));
  fs.mkdirSync(path.join(home, '.agent-context'));
  fs.writeFileSync(path.join(home, '.agent-context/integration.json'), JSON.stringify({ schema: 1, mode: 'automatic', agents: ['hermes'] }));
  const report = await verify('hermes');
  assert.equal(report.mode, 'automatic');
  assert.equal(report.service, 'unavailable');
  assert.equal(report.skipped, 'service_unavailable');
  assert.equal(report.passed, false);
});

test('Claude session with a launcher-overridden base URL is reported as bypassed', () => {
  const url = 'http://127.0.0.1:18788';
  assert.equal(proxyBypassed('claude', url, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), true);
  assert.equal(proxyBypassed('claude', url, {}), true);
  assert.equal(proxyBypassed('claude', url, { ANTHROPIC_BASE_URL: url }), false);
  assert.equal(proxyBypassed('codex', url, {}), false);
});
