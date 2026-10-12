#!/usr/bin/env node
import { prepareNativeTools, nativeMcp, nativeRtk, nativeHook, nativeRun } from '../src/native-tools.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compress, version, atomicWrite, home, root, acquireTransaction } from '../src/core.js';
import { claudeHook } from '../src/hooks.js';
import { serve } from '../src/mcp.js';
import { install, rollback, doctor, agentNames as names } from '../src/install.js';
import { onboard, onboardingOptions } from '../src/onboarding.js';
import { verify } from '../src/verify.js';
import { update, rollbackUpdate, enableUpdates, updateStatus, launcher } from '../src/update.js';
import { pythonEnvironment, prepareHeadroom, qualifyHeadroom } from '../src/headroom.js';
import { runAgent } from '../src/run.js';
import { providers, providerSettings, selectProvider } from '../src/providers.js';
import { servicePort, serviceHealth, ensureService, stopService, serveService, lifecycle } from '../src/service.js';
import { diagnose } from '../src/diagnostics.js';
import { compressionWarnings } from '../src/conflicts.js';
import { incidents, recordIncident, reportIncidents, incidentPolicy, pendingPackets } from '../src/incidents.js';
import { spawn } from 'node:child_process';
import { uninstall } from '../src/uninstall.js';
import { telemetryStatus, verifyTelemetry, prepareNativeExporters, langfuseConfig, telemetryDisabled } from '../src/telemetry.js';
import { credentialInput, saveLangfuse } from '../src/credentials.js';
import { connectGateway, enrollment, teamGateway } from '../src/enrollment.js';
import { serveGateway } from '../src/gateway-server.js';
import { monitorTick, MONITOR_INTERVAL_MS } from '../src/monitor.js';
import { installMonitorService, prepareWindowsMonitor } from '../src/monitor-service.js';
import { atomicSecretWrite } from '../src/private-file.js';

const [command, ...args] = process.argv.slice(2);
const output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const versionsDir = path.join(root(), 'versions');
const inManagedRuntime = fs.existsSync(versionsDir) && fs.realpathSync(fileURLToPath(import.meta.url)).startsWith(fs.realpathSync(versionsDir) + path.sep);
const recovery = command === 'update' && args[0] === 'bootstrap' || command === 'update' && ['rollback', 'disable'].includes(args[0]) || command === 'doctor' && args.includes('--fix');
if (!['install', 'setup', 'onboard', 'headroom', 'provider', 'uninstall', 'connect', 'gateway', 'monitor'].includes(command) && !recovery && !inManagedRuntime && fs.existsSync(path.join(root(), 'active.json'))) {
  await import(pathToFileURL(launcher()).href);
} else try {
  if (command === 'monitor') {
    if (args[0] === 'install' && args.slice(1).every(a => a === '--migrate')) { await prepareWindowsMonitor(); output(installMonitorService({ migrate: args.includes('--migrate') })); }
    else if (args[0] === 'tick' && args.length === 1) output(await monitorTick({ force: true }));
    else if (['serve', 'worker'].includes(args[0]) && args.length === 1) {
      let stopped = false;
      const controller = new AbortController();
      const {superviseMonitor,reconcileServices} = await import('../src/monitor-runtime.js');
      const {processCodexExports} = await import('../src/native-export.js');
      if(args[0]==='serve') {
        const stop=()=>controller.abort();
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
        try {await superviseMonitor({signal:controller.signal});}
        finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
      } else {
      const { subscribeUpdates } = await import('../src/update-subscription.js');
      const subscription = subscribeUpdates({ signal: controller.signal });
      const stop = () => { stopped = true; controller.abort(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      while (!stopped && fs.existsSync(root()) && !fs.existsSync(path.join(root(), 'uninstalling.json'))) {
        if (updateStatus().activeVersion && updateStatus().activeVersion !== version) { stop(); process.exitCode = 75; break; }
        await reconcileServices();
        await processCodexExports();
        try { await monitorTick(); } catch { recordIncident({component:'telemetry',operation:'monitor',category:'delivery_failed',agent:'unknown'}); }
        await new Promise(resolve => { const done = () => { clearTimeout(timer); process.off('SIGTERM', done); process.off('SIGINT', done); resolve(); }; const timer = setTimeout(done, Math.min(MONITOR_INTERVAL_MS, 5000)); process.once('SIGTERM', done); process.once('SIGINT', done); });
      }
      controller.abort(); await subscription;
      }
    } else throw new Error('Usage: agent-context monitor tick|serve');
  } else if (command === 'onboard') {
    const report = await onboard(onboardingOptions(args)); output(report);
    if (report.status === 'needs_attention') process.exitCode = 1;
  } else if (command === 'connect') {
    if (args.length !== 1) throw new Error('Usage: agent-context connect <https://gateway-origin>');
    output(await connectGateway(args[0]));
  } else if (command === 'gateway' && args[0] === 'serve' && args.length === 2) {
    await serveGateway(args[1]);
  } else if (command === 'setup') {
    const selected = args.filter(value => !['--no-report', '--migrate'].includes(value));
    if (selected.some(value => !names[value])) throw new Error('Choose codex, claude or hermes');
    if (!(selected.length ? selected : Object.keys(names)).some(agent => fs.existsSync(path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`)))) throw new Error('Setup requires an installed Codex, Claude Code or Hermes profile');
    const agents = selected.length ? selected : Object.keys(names);
    if (telemetryDisabled()) throw new Error('Setup requires telemetry enabled by the profile owner; existing opt-out preserved');
    if (!langfuseConfig()) await connectGateway(enrollment()?.gateway || teamGateway);
    if (enrollment()) {
      // No native exporter may send device credentials to an older proxy's upstream catch-all.
      for (const agent of agents) {
        const state = await serviceHealth(agent);
        if (state && state.version !== version && state.active) throw new Error('Setup requires closing active old proxy sessions before gateway migration');
      }
      for (const agent of agents) {
        const file = path.join(root(), 'services', agent + '.json');
        if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).version !== version) await stopService(agent);
      }
    }
    const runtime = await prepareHeadroom();
    await prepareNativeTools();
    const exporters = await prepareNativeExporters(selected.length ? selected : Object.keys(names));
    const report = install(selected.length ? selected : Object.keys(names), { automatic: true, migrate: args.includes('--migrate') });
    if (enrollment()) for (const agent of report.installed) await ensureService(agent);
    let monitor; try { await prepareWindowsMonitor(); monitor = installMonitorService({ migrate: args.includes('--migrate') }); } catch { monitor = { status: 'needs_attention', reason: 'Persistent monitor registration failed; run monitor install after reviewing the existing service.' }; }
    const reporting = incidentPolicy(!args.includes('--no-report'));
    report.warnings = compressionWarnings();
    const checks = await diagnose();
    const nextSteps = [];
    if (report.warnings.length) nextSteps.push('Review the listed compression integrations; remove confirmed conflicts before enabling both.');
    if (checks.telemetry.credentials !== 'configured') nextSteps.push('Team telemetry must be connected to complete setup: onboard --yes. Compression remains local.');
    if (checks.telemetry.credentials === 'configured' && Object.values(checks.telemetry.nativeExporters).includes('missing')) nextSteps.push('Install/configure the official native Langfuse exporter for each listed agent; compression spans do not replace model/tool telemetry. Preserve native hook trust review.');
    if (checks.telemetry.credentials === 'configured') nextSteps.push('Run agent-context telemetry verify to check OTLP delivery and readback. This synthetic check does not qualify a native exporter.');
    nextSteps.push('Run doctor --fix --live, then reload agent connections and verify a real tool result. Health checks alone are not compression proof.');
    output({ ...report, runtime, exporters, monitor, reporting, onboarding: { status: checks.healthy && monitor.status === 'installed' && !report.warnings.length ? 'configured' : 'needs_attention', issues: checks.issues, nextSteps }, notice: 'Sanitized incident reporting uses existing GitHub auth; no raw logs. Use incidents disable to opt out. Native hooks may require review/trust; tool approval is unchanged. Official native telemetry plugins remain owned by the agent and are preserved by package uninstall.' });
    if (!checks.healthy || monitor.status !== 'installed') process.exitCode = 1;
  } else if (command === 'telemetry') {
    if (args[0] === 'enqueue' && args.length === 2) {
      const device = enrollment();
      const relative = path.relative(path.join(root(), 'telemetry-outbox'), path.resolve(args[1])).split(path.sep).join('/');
      const pattern = device ? '^' + device.device + '/(codex|claude-code|hermes)/[a-f0-9]{32}\\.json$' : '^local/(codex|claude-code|hermes)/[a-f0-9]{64}/[a-f0-9]{32}\\.json$';
      if ((!device && !langfuseConfig()) || !new RegExp(pattern).test(relative)) throw new Error('Unsupported private outbox target');
      const data = fs.readFileSync(0);
      if (data.length > 4 * 1024 * 1024) throw new Error('Unsupported outbox batch size');
      atomicSecretWrite(path.resolve(args[1]), data);
      output({ status: 'queued' });
    } else if (args[0] === 'verify' && args.length <= 2) {
      if (enrollment()) await ensureService(args[1] || 'codex');
      const report = await verifyTelemetry(args[1]); output(report); if (report.status !== 'delivered') process.exitCode = 1;
    } else if (args[0] === 'status' && args.length === 1) {
      let agents = []; try { agents = JSON.parse(fs.readFileSync(path.join(root(), 'integration.json'))).agents || []; } catch {}
      output(telemetryStatus(agents));
    } else throw new Error('Usage: agent-context telemetry status|verify [codex|claude|hermes]');
  } else if (command === 'uninstall') {
    if (args.some(value => value !== '--dry-run')) throw new Error('Usage: agent-context uninstall [--dry-run]');
    output(await uninstall({ dryRun: args.includes('--dry-run') }));
  } else if (command === 'proxy') {
    if (args[0] === 'serve') await serveService(args[1]);
    else if(args[0]==='worker'&&names[args[1]]) {const {serveProxyWorker}=await import('../src/front-proxy.js');await serveProxyWorker(args[1]);}
    else if (args[0] === 'ensure') output(await ensureService(args[1]));
    else throw new Error('Usage: agent-context proxy ensure|serve <agent>');
  } else if (command === 'lifecycle') {
    const result = await lifecycle(args[0]);
    // The launcher's own requests stay direct, but commands this session runs (claude -p, TaskQ workers) can use the proxy.
    // Drop the launcher's short-lived token so children refresh their own login.
    // Same gate as install: never take over a third-party gateway or its credentials, only the first-party default.
    if (result.bypassed && process.env.CLAUDE_ENV_FILE && process.env.ANTHROPIC_BASE_URL === 'https://api.anthropic.com'
      && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.CLAUDE_CODE_USE_BEDROCK && !process.env.CLAUDE_CODE_USE_VERTEX) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ANTHROPIC_BASE_URL='${result.url}'\nunset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH\n`);
    if (result.bypassed) output({ systemMessage: 'Agent Context: this Claude session bypasses the compression proxy (launcher overrides ANTHROPIC_BASE_URL); its own requests are not compressed. Claude processes it starts (claude -p, TaskQ workers) use the proxy.',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Agent Context proxy is bypassed in this session: its own tool results are NOT compressed and headroom stats do not cover it. Do not claim compression savings for this session. Claude processes started from Bash here are routed through the proxy.' } });
  } else if (command === 'retrieval') {
    // Do not block the MCP handshake on proxy startup. Owner identity is checked (1s); if the port is not
    // our proxy, start ours in the background. Same loopback trust boundary as the agent's base URL.
    if (!servicePort(args[0])) throw new Error('Choose codex, claude or hermes');
    const service = { url: `http://127.0.0.1:${servicePort(args[0])}` };
    if (!await serviceHealth(args[0])) ensureService(args[0]).catch(() => {});
    const runtime = await prepareHeadroom();
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(runtime.headroom, ['mcp', 'serve', '--proxy-url', service.url], { stdio: 'inherit', env: pythonEnvironment({ ...process.env, HEADROOM_STATELESS: 'true', HEADROOM_OFFLINE: '1' }), windowsHide: true });
      child.once('error', reject); child.once('close', code => resolve(code ?? 1));
      process.once('SIGTERM', () => child.kill());
    });
  } else if (command === 'plugin-path' && args[0] === 'hermes') {
    output({ path: fileURLToPath(new URL('../integrations/hermes/agent-context/__init__.py', import.meta.url)) });
  } else if (command === 'incidents') {
    if (args[0] === 'report') output(await reportIncidents());
    else if (args[0] === 'record') { const item = recordIncident(JSON.parse(fs.readFileSync(0, 'utf8'))); if (!item) throw new Error('Unsupported incident fields'); output({ event_id: item.event_id, fingerprint: item.fingerprint }); }
    else if (['enable', 'disable'].includes(args[0])) output(incidentPolicy(args[0] === 'enable', args.includes('--gh') ? 'gh' : 'relay'));
    else if (args[0] === 'show') output(pendingPackets());
    else if (!args.length || args[0] === 'list') output(incidents());
    else throw new Error('Usage: agent-context incidents list|show|report|enable [--gh]|disable');
  } else if (command === 'native-hook' && args[0]==='codex') {
    const {enqueueCodexExport} = await import('../src/native-export.js');
    const input=fs.readFileSync(0,'utf8');
    if(Buffer.byteLength(input)>65536) throw new Error('Native hook payload too large');
    enqueueCodexExport(JSON.parse(input));
    output({ continue: true, suppressOutput: true });
  } else if (command === 'tools') {
    if (args[0] === 'prepare') output(await prepareNativeTools());
    else if (args[0] === 'run') process.exitCode = await nativeRun(args.slice(1));
    else if (args[0] === 'rtk') process.exitCode = await nativeRtk(args.slice(1));
    else if (args[0] === 'mcp' && names[args[1]]) process.exitCode = await nativeMcp(args[1]);
    else if (args[0] === 'hook') output(await nativeHook(JSON.parse(fs.readFileSync(0, 'utf8')), launcher(), process.execPath));
    else throw new Error('Usage: agent-context tools prepare|rtk|mcp <agent>|hook');
  } else if (command === 'provider') {
    if (args[0] === 'select' && args.length === 2) output(selectProvider(args[1]));
    else if (args[0] === 'test' && args.length === 2 && [...providers, 'all'].includes(args[1])) {
      const runtime = await prepareHeadroom();
      process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(runtime.python, ['-m', 'agent_context_headroom.provider_benchmark', '--provider', args[1]],
          { stdio: 'inherit', windowsHide: true, env: pythonEnvironment() });
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
      });
    } else if ((!args.length || args[0] === 'show') && args.length <= 1) {
      const running = {};
      for (const agent of Object.keys(names)) {
        const state = await serviceHealth(agent);
        running[agent] = state ? { version: state.version, provider: state.compressor || 'unknown' } : null;
      }
      output({ configured: providerSettings(), available: providers, running });
    } else throw new Error('Usage: agent-context provider show|select <provider>|test <provider|all>');
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
    else if (args[0] === 'bootstrap' && args.slice(1).every(a => a === '--migrate')) { const { seedRuntime } = await import('../src/update.js'); const release = acquireTransaction(); try { output(seedRuntime({ migrate: args.includes('--migrate') })); } finally { release(); } }
    else if (args[0] === 'status') output(updateStatus());
    else if (!args.length || args[0] === '--automatic') { const report = await update({ automatic: args[0] === '--automatic' }); output(report); if (report.status === 'failed') process.exitCode = 1; }
    else throw new Error('Usage: agent-context update [status|enable|disable|rollback]');
  }
  else if (command === 'set-langfuse') {
    if (args.length) throw new Error('Usage: agent-context set-langfuse (interactive hidden input or private JSON stdin)');
    output(saveLangfuse(await credentialInput('langfuse')));
  }
  else if (command === 'set-key') {
    if (args.length) throw new Error('Usage: agent-context set-key (interactive hidden input or private stdin)');
    const key = (await credentialInput('supercompress')).trim();
    if (!/^sc_[A-Za-z0-9_]{20,}$/.test(key)) throw new Error('Invalid key');
    const file = path.join(home(), '.supercompress', 'config.json');
    let config = {};
    if (fs.existsSync(file)) {
      const before = fs.readFileSync(file);
      config = JSON.parse(before.toString());
      // One previous key copy is enough for recovery; older plaintext copies are removed.
      const backups = path.join(root(), 'backups');
      try { for (const name of fs.readdirSync(backups)) if (/^key-\d+\.before$/.test(name)) fs.rmSync(path.join(backups, name), { force: true }); } catch {}
      atomicSecretWrite(path.join(backups, `key-${Date.now()}.before`), before);
    }
    config.api_key = key;
    atomicSecretWrite(file, `${JSON.stringify(config, null, 2)}\n`);
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
  else throw new Error('Usage: agent-context onboard [codex claude hermes] [--yes] | setup [codex claude hermes] | uninstall [--dry-run] | doctor [--fix --live] | rollback | set-key < stdin | update');
} catch (error) {
  if (!['incidents', '--version', 'uninstall', 'onboard'].includes(command)) recordIncident({ component: command === 'update' ? 'updater' : command === 'proxy' || command === 'lifecycle' ? 'proxy' : 'installer', operation: 'command', category: command === 'update' ? 'update_failed' : 'configuration_drift' });
  // Configuration parser errors may contain private values; report only known safe messages.
  const safe = /^(Setup requires|Headroom requires|Headroom preparation already running|Unknown agent|Choose |Usage:|Update refused|Rollback refused|Uninstall refused|Unsupported |Hermes legacy|Configuration (changed|transaction)|Native verification|GitHub sign-in|Gateway enrollment refused)/.test(error.message);
  process.stderr.write(`${safe ? error.message : 'Agent Context operation failed; inspect local configuration privately'}\n`);
  process.exitCode = 1;
}
