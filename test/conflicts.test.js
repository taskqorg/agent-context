import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressionWarnings } from '../src/conflicts.js';

test('compression inventory warns on active competing hooks/plugins without exporting commands or changing files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-conflicts-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const file = path.join(home, '.claude/settings.json');
  const text = JSON.stringify({ enabledPlugins: { 'langfuse@observability': true, 'context-compress@test': true, 'supercompress@old': false },
    hooks: { PostToolUse: [{ hooks: [{ command: 'rtk rewrite --secret private-fixture' }] }] } });
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    headroom: { command: 'node', args: ['/home/test/.agent-context/launcher.mjs', 'retrieval', 'claude'] },
    supercompress: { enabled: false }, other: { command: 'normal-tool' } } }));
  const warnings = compressionWarnings(home, home);
  assert.deepEqual(warnings.map(x => x.kind).sort(), ['hook', 'plugin']);
  assert.ok(!JSON.stringify(warnings).includes('private-fixture'));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  fs.rmSync(home, { recursive: true });
});
