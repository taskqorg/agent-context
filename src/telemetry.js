import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import YAML from 'yaml';
import { home, root, atomicWrite, version } from './core.js';
import { prepareHeadroom, pythonEnvironment } from './headroom.js';
import { agentExecutable } from './executable.js';

export function executionIdentity(env = process.env, platform = process.platform) {
  const host = env.AGENT_CONTEXT_HOST || (platform === 'darwin' ? 'mac' : platform === 'win32' || env.WSL_DISTRO_NAME ? 'windows' : 'linux');
  const runtime = env.WSL_DISTRO_NAME ? 'wsl' : 'native';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(host)) throw new Error('Unsupported telemetry host');
  return { host, runtime };
}

export function profileIdentity(env = process.env) {
  let host;
  try { host = JSON.parse(fs.readFileSync(path.join(root(), 'integration.json'))).host; } catch {}
  return executionIdentity({ ...env, AGENT_CONTEXT_HOST: env.AGENT_CONTEXT_HOST || host });
}

// Credentials stay inside this process; public reports contain only status fields.
export function langfuseConfig(env = process.env) {
  try {
    let value;
    if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) value = { public_key: env.LANGFUSE_PUBLIC_KEY, secret_key: env.LANGFUSE_SECRET_KEY, base_url: env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST };
    else {
      const file = env.AGENT_CONTEXT_LANGFUSE_CONFIG || path.join(home(), '.codex/langfuse.json');
      if (fs.existsSync(file)) value = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        let values = { ...env };
        const file = path.join(home(), '.hermes/.env');
        if (fs.existsSync(file)) {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const match = /^\s*(?:export\s+)?(HERMES_LANGFUSE_(?:PUBLIC_KEY|SECRET_KEY|BASE_URL))\s*=\s*(.*?)\s*$/.exec(line);
            if (match && !values[match[1]]) {
              const raw = match[2];
              if (/^"[^"\r\n]*"$|^'[^'\r\n]*'$/.test(raw)) values[match[1]] = raw.slice(1, -1);
              else if (/^[^\s'"#$\\]+$/.test(raw)) values[match[1]] = raw;
            }
          }
        }
        value = { public_key: values.HERMES_LANGFUSE_PUBLIC_KEY, secret_key: values.HERMES_LANGFUSE_SECRET_KEY, base_url: values.HERMES_LANGFUSE_BASE_URL };
      }
    }
    if (value.enabled === false || !['public_key', 'secret_key', 'base_url'].every(key => typeof value[key] === 'string' && value[key].trim())) return null;
    const url = new URL(value.base_url);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return null;
    return { ...value, base_url: value.base_url.replace(/\/$/, '') };
  } catch { return null; }
}

export function nativeExporter(agent) {
  try {
    if (agent === 'codex') {
      const config = parse(fs.readFileSync(path.join(home(), '.codex/config.toml'), 'utf8'));
      if (config.plugins?.['tracing@codex-observability-plugin']?.enabled !== true) return 'missing';
      return config.features?.hooks === true ? 'configured_trust_and_delivery_unverified' : 'installed_hooks_disabled_or_unconfigured';
    }
    if (agent === 'claude') {
      const config = JSON.parse(fs.readFileSync(path.join(home(), '.claude/settings.json')));
      return config.enabledPlugins?.['langfuse-observability@langfuse-observability'] === true ? 'configured_delivery_unverified' : 'missing';
    }
    const config = YAML.parse(fs.readFileSync(path.join(home(), '.hermes/config.yaml'), 'utf8'));
    return (config.plugins?.enabled || []).some(name => ['observability/langfuse', 'tight-langfuse'].includes(name)) ? 'configured_delivery_unverified' : 'missing';
  } catch { return 'missing'; }
}

export async function prepareCodexExporter(agents, execute = promisify(execFile)) {
  if (!agents.includes('codex') || !langfuseConfig()) return { status: 'not_requested_or_credentials_missing' };
  if (nativeExporter('codex') !== 'missing') return { status: 'already_configured_trust_and_delivery_unverified' };
  try {
    const executable = agentExecutable('codex');
    const options = { env: { ...process.env, CODEX_HOME: path.join(home(), '.codex') }, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true };
    await execute(executable.command, [...executable.args, 'plugin', 'marketplace', 'add', 'langfuse/codex-observability-plugin'], options);
    await execute(executable.command, [...executable.args, 'plugin', 'add', 'tracing@codex-observability-plugin'], options);
    return { status: 'installed_by_native_agent', trust: 'native_review_required', ownership: 'native_plugin_preserved_by_package_uninstall' };
  } catch { return { status: 'native_install_unresolved', trust: 'unmodified' }; }
}

export function telemetryStatus(agents) {
  let delivery = { status: 'unverified' };
  try { delivery = JSON.parse(fs.readFileSync(path.join(root(), 'telemetry-delivery.json'))); } catch {}
  const config = langfuseConfig();
  const identity = profileIdentity();
  if (delivery.status === 'delivered' && (delivery.destination !== destination(config) || delivery.host !== identity.host || delivery.runtime !== identity.runtime || delivery.version !== version || Date.now() - Date.parse(delivery.checkedAt) > 86400000 || !Number.isFinite(Date.parse(delivery.checkedAt)))) delivery = { status: 'stale_verification', checkedAt: delivery.checkedAt };
  return { ...identity, credentials: config ? 'configured' : 'missing_or_invalid',
    nativeExporters: Object.fromEntries(agents.map(agent => [agent, nativeExporter(agent)])), delivery };
}

const destination = config => config ? crypto.createHash('sha256').update(config.base_url + '\0' + config.public_key + '\0' + config.secret_key).digest('hex') : null;

// This explicit command writes one small synthetic trace, then verifies ingestion by ID.
async function exportProbe(config, probe) {
  const runtime = await prepareHeadroom();
  const result = await promisify(execFile)(runtime.python, ['-m', 'agent_context_headroom.observability', JSON.stringify(probe)], {
    timeout: 15000, maxBuffer: 65536, env: pythonEnvironment({ ...process.env, LANGFUSE_PUBLIC_KEY: config.public_key,
      LANGFUSE_SECRET_KEY: config.secret_key, LANGFUSE_BASE_URL: config.base_url }) });
  return JSON.parse(result.stdout).status;
}

export async function verifyTelemetry(agent = 'codex', request = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), send = exportProbe) {
  if (!['codex', 'claude', 'hermes'].includes(agent)) throw new Error('Choose codex, claude or hermes');
  const config = langfuseConfig();
  const checkedAt = new Date().toISOString();
  const save = report => { atomicWrite(path.join(root(), 'telemetry-delivery.json'), JSON.stringify({ ...report, checkedAt, version, destination: destination(config) })); return { ...report, checkedAt }; };
  if (!config) return save({ status: 'missing_or_invalid_credentials' });
  const id = crypto.randomBytes(16).toString('hex');
  const sessionId = 'agent-context-qualification-' + id;
  const { host, runtime } = profileIdentity();
  const tags = [`agent:${agent === 'claude' ? 'claude-code' : agent}`, `host:${host}`, `runtime:${runtime}`, 'component:delivery-check'];
  const headers = { Authorization: 'Basic ' + Buffer.from(config.public_key + ':' + config.secret_key).toString('base64'), 'Content-Type': 'application/json' };
  const url = config.base_url + '/api/public';
  try {
    if (await send(config, { id, sessionId, tags, version, host, runtime }) !== 'accepted') return save({ status: 'ingestion_rejected' });
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await pause(1000);
      const result = await request(url + '/v2/observations?traceId=' + id + '&fields=core,basic,trace_context&limit=10', { headers, signal: AbortSignal.timeout(3000) });
      if (!result.ok) { if (result.status === 404) continue; return save({ status: 'readback_failed', httpStatus: result.status }); }
      const observations = await result.json();
      if (observations.data?.some(span => span.traceId === id && span.sessionId === sessionId && span.environment === 'qualification' && tags.every(tag => span.tags?.includes(tag)))) return save({ status: 'delivered', traceId: id, host, runtime, proof: 'synthetic_otlp_ingestion_only_not_native_exporter' });
    }
    return save({ status: 'accepted_not_observed', traceId: id });
  } catch { return save({ status: 'transport_failed' }); }
}
