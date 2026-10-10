#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { compress, version, atomicWrite, home, root } from '../src/core.js';
import { claudeHook } from '../src/hooks.js';
import { serve } from '../src/mcp.js';
import { install, rollback, doctor } from '../src/install.js';
import { verify } from '../src/verify.js';

const [command, ...args] = process.argv.slice(2);
const names = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' };
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
try {
  if (command === 'mcp') {
    if (!names[args[0]]) throw new Error('Choose codex, claude or hermes');
    serve(names[args[0]]);
  } else if (command === 'hook' && args[0] === 'claude') {
    const input = fs.readFileSync(0, 'utf8');
    try { output(await claudeHook(JSON.parse(input))); }
    catch { output({ systemMessage: 'Agent Context hook failed; original output kept.' }); }
  } else if (command === 'install') output(install(args.length ? args : Object.keys(names)));
  else if (command === 'set-key') {
    const key = fs.readFileSync(0, 'utf8').trim();
    if (!/^sc_[A-Za-z0-9_]{20,}$/.test(key)) throw new Error('Invalid key');
    const file = path.join(home(), '.supercompress', 'config.json');
    let config = {};
    if (fs.existsSync(file)) {
      const before = fs.readFileSync(file);
      config = JSON.parse(before.toString());
      atomicWrite(path.join(root(), 'backups', `key-${Date.now()}.before`), before);
    }
    config.api_key = key;
    atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
    output({ keySaved: true, environmentNotModified: true });
  }
  else if (command === 'rollback') output(rollback());
  else if (command === 'doctor') { const report = doctor(); output(report); if (!report.healthy) process.exitCode = 1; }
  else if (command === 'verify') { const report = await verify(args[0]); output(report); if (!report.passed) process.exitCode = 1; }
  else if (command === 'probe') {
    if (!names[args[0]]) throw new Error('Choose codex, claude or hermes');
    const context = Array.from({ length: 30 }, (_, i) => `Diagnostic row ${i}: integration verified with synthetic context; preserve failures and next actions.`).join('\n') + '\nERROR ECONNREFUSED db.internal:5432';
    const result = await compress({ context, query: 'Summarize the observations and preserve the exact ERROR line.', session: `probe-${crypto.randomUUID()}`, agent: names[args[0]] });
    const { compressed_text, ...metadata } = result;
    output({ ...metadata, criticalRetained: compressed_text.includes('ERROR ECONNREFUSED db.internal:5432'), proof: 'direct_core_api_only' });
    if (result.skipped) process.exitCode = 1;
  } else if (command === '--version') output({ version });
  else throw new Error('Usage: agent-context install [codex claude hermes] | doctor | rollback | set-key < stdin | probe <agent> | verify <agent> | mcp <agent> | hook claude');
} catch (error) {
  // Configuration parser errors may contain private values; report only known safe messages.
  const safe = /^(Unknown agent|Choose |Usage:|Rollback refused|Unsupported |Hermes legacy|Configuration (changed|transaction))/.test(error.message);
  process.stderr.write(`${safe ? error.message : 'Agent Context operation failed; inspect local configuration privately'}\n`);
  process.exitCode = 1;
}
