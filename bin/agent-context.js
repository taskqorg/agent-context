#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compress, version, atomicWrite, home, root } from '../src/core.js';
import { claudeHook } from '../src/hooks.js';
import { serve } from '../src/mcp.js';
import { install, rollback, doctor } from '../src/install.js';
import { verify } from '../src/verify.js';
import { update, rollbackUpdate, enableUpdates, updateStatus, launcher } from '../src/update.js';
import { prepareHeadroom, qualifyHeadroom } from '../src/headroom.js';
import { runAgent } from '../src/run.js';
import { ensureService, serveService, lifecycle } from '../src/service.js';
import { diagnose } from '../src/diagnostics.js';
import { compressionWarnings } from '../src/conflicts.js';
import { incidents, recordIncident, reportIncidents, incidentPolicy } from '../src/incidents.js';
import { spawn } from 'node:child_process';
import { uninstall } from '../src/uninstall.js';

const [command, ...args] = process.argv.slice(2);
const names = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' };
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const versionsDir = path.join(root(), 'versions');
const inManagedRuntime = fs.existsSync(versionsDir) && fs.realpathSync(fileURLToPath(import.meta.url)).startsWith(fs.realpathSync(versionsDir) + path.sep);
const recovery = command === 'update' && ['rollback', 'disable'].includes(args[0]) || command === 'doctor' && args.includes('--fix');
if (!['install', 'setup', 'headroom', 'uninstall'].includes(command) && !recovery && !inManagedRuntime && fs.existsSync(path.join(root(), 'active.json'))) {
  await import(pathToFileURL(launcher()).href);
} else try {
  if (command === 'setup') {
    const selected = args.filter(value => value !== '--no-report');
    if (selected.some(value => !names[value])) throw new Error('Choose codex, claude or hermes');
    if (!(selected.length ? selected : Object.keys(names)).some(agent => fs.existsSync(path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`)))) throw new Error('Setup requires an installed Codex, Claude Code or Hermes profile');
    const runtime = await prepareHeadroom();
    const report = install(selected.length ? selected : Object.keys(names), { automatic: true });
    const reporting = incidentPolicy(!args.includes('--no-report'));
    report.warnings = compressionWarnings();
    const checks = doctor();
    const nextSteps = [];
    if (!checks.keyPresent) nextSteps.push('Set the SuperCompress key through private stdin: agent-context set-key. Never paste a key into command arguments.');
    if (checks.keyConflict) nextSteps.push('Reconcile the conflicting inherited SuperCompress environment privately.');
    if (report.warnings.length) nextSteps.push('Review the listed compression integrations; remove confirmed conflicts before enabling both.');
    nextSteps.push('Run doctor --fix --live, then reload agent connections and verify a real tool result. Health checks alone are not compression proof.');
    output({ ...report, runtime, reporting, onboarding: { status: checks.healthy && !report.warnings.length ? 'configured' : 'needs_attention', issues: checks.issues, nextSteps }, notice: 'Sanitized incident reporting uses existing GitHub auth; no raw logs. Use incidents disable to opt out. Native hooks may require review/trust; tool approval is unchanged.' });
    if (!checks.healthy) process.exitCode = 1;
  } else if (command === 'uninstall') {
    if (args.some(value => value !== '--dry-run')) throw new Error('Usage: agent-context uninstall [--dry-run]');
    output(await uninstall({ dryRun: args.includes('--dry-run') }));
  } else if (command === 'proxy') {
    if (args[0] === 'serve') await serveService(args[1]);
    else if (args[0] === 'ensure') output(await ensureService(args[1]));
    else throw new Error('Usage: agent-context proxy ensure|serve <agent>');
  } else if (command === 'lifecycle') {
    const result = await lifecycle(args[0]);
    if (result.bypassed) output({ systemMessage: 'Agent Context: this Claude session bypasses the compression proxy (launcher overrides ANTHROPIC_BASE_URL); tool results are not compressed. Use the claude CLI for compression.',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Agent Context proxy is bypassed in this session: tool results are NOT compressed and headroom stats do not cover it. Do not claim compression savings.' } });
  } else if (command === 'retrieval') {
    const service = await ensureService(args[0]);
    const runtime = await prepareHeadroom();
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(runtime.headroom, ['mcp', 'serve', '--proxy-url', service.url], { stdio: 'inherit', env: { ...process.env, HEADROOM_STATELESS: 'true', HEADROOM_OFFLINE: '1' }, windowsHide: true });
      child.once('error', reject); child.once('close', code => resolve(code ?? 1));
      process.once('SIGTERM', () => child.kill());
    });
  } else if (command === 'plugin-path' && args[0] === 'hermes') {
    output({ path: fileURLToPath(new URL('../integrations/hermes/agent-context/__init__.py', import.meta.url)) });
  } else if (command === 'incidents') {
    if (args[0] === 'report') output(await reportIncidents());
    else if (args[0] === 'record') { const item = recordIncident(JSON.parse(fs.readFileSync(0, 'utf8'))); if (!item) throw new Error('Unsupported incident fields'); output({ event_id: item.event_id, fingerprint: item.fingerprint }); }
    else if (['enable', 'disable'].includes(args[0])) output(incidentPolicy(args[0] === 'enable'));
    else if (!args.length || args[0] === 'list') output(incidents());
    else throw new Error('Usage: agent-context incidents list|report|enable|disable');
  } else if (command === 'run') {
    process.exitCode = await runAgent(args[0], args.slice(1));
  } else if (command === 'mcp') {
    if (!names[args[0]]) throw new Error('Choose codex, claude or hermes');
    serve(names[args[0]]);
  } else if (command === 'hook' && args[0] === 'claude') {
    const input = fs.readFileSync(0, 'utf8');
    try { output(await claudeHook(JSON.parse(input))); }
    catch { output({ systemMessage: 'Agent Context hook failed; original output kept.' }); }
  } else if (command === 'headroom') {
    if (args[0] === 'prepare' && args.length === 1) output(await prepareHeadroom());
    else if (args[0] === 'qualify') output(await qualifyHeadroom(args.slice(1)));
    else throw new Error('Usage: agent-context headroom prepare|qualify');
  } else if (command === 'install') output(install(args.length ? args : Object.keys(names)));
  else if (command === 'update') {
    if (args[0] === 'rollback') output(await rollbackUpdate());
    else if (args[0] === 'enable' || args[0] === 'disable') output(enableUpdates(args[0] === 'enable'));
    else if (args[0] === 'status') output(updateStatus());
    else if (!args.length || args[0] === '--automatic') { const report = await update({ automatic: args[0] === '--automatic' }); output(report); if (report.status === 'failed') process.exitCode = 1; }
    else throw new Error('Usage: agent-context update [status|enable|disable|rollback]');
  }
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
  else if (command === 'doctor') {
    if (args.some(value => !['--fix', '--live'].includes(value))) throw new Error('Usage: agent-context doctor [--fix] [--live]');
    const report = await diagnose({ fix: args.includes('--fix'), live: args.includes('--live') }); output(report); if (!report.healthy) process.exitCode = 1;
  }
  else if (command === 'verify') { const report = await verify(args[0]); output(report); if (!report.passed) process.exitCode = 1; }
  else if (command === 'probe') {
    if (!names[args[0]]) throw new Error('Choose codex, claude or hermes');
    const context = Array.from({ length: 30 }, (_, i) => `Diagnostic row ${i}: integration verified with synthetic context; preserve failures and next actions.`).join('\n') + '\nERROR ECONNREFUSED db.internal:5432';
    const result = await compress({ context, query: 'Summarize the observations and preserve the exact ERROR line.', session: `probe-${crypto.randomUUID()}`, agent: names[args[0]] });
    const { compressed_text, ...metadata } = result;
    output({ ...metadata, criticalRetained: compressed_text.includes('ERROR ECONNREFUSED db.internal:5432'), proof: 'direct_core_api_only' });
    if (result.skipped) process.exitCode = 1;
  } else if (command === '--version') output({ version });
  else throw new Error('Usage: agent-context setup [codex claude hermes] | uninstall [--dry-run] | doctor [--fix --live] | rollback | set-key < stdin | update');
} catch (error) {
  if (!['incidents', '--version', 'uninstall'].includes(command)) recordIncident({ component: command === 'update' ? 'updater' : command === 'proxy' || command === 'lifecycle' ? 'proxy' : 'installer', operation: 'command', category: command === 'update' ? 'update_failed' : 'configuration_drift' });
  // Configuration parser errors may contain private values; report only known safe messages.
  const safe = /^(Setup requires|Headroom requires|Headroom preparation already running|Unknown agent|Choose |Usage:|Update refused|Rollback refused|Uninstall refused|Unsupported |Hermes legacy|Configuration (changed|transaction)|Native verification)/.test(error.message);
  process.stderr.write(`${safe ? error.message : 'Agent Context operation failed; inspect local configuration privately'}\n`);
  process.exitCode = 1;
}
