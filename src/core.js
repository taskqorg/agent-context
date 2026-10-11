import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compressSupercompress } from './supercompress.js';
import { enrollment } from './enrollment.js';

export const version = '0.2.11';
export const home = () => process.env.AGENT_CONTEXT_HOME || os.homedir();
export const root = () => path.join(home(), '.agent-context');
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
// Directory lock with owner PID; a lock whose owner died or outlived staleMs is reclaimed once.
// ponytail: PID check is per host; a lock shared across hosts relies on staleMs only.
export function tryLock(lock, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) return null;
      let owner = {};
      try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
      const at = Number.isFinite(owner.at) ? owner.at : fs.statSync(lock).mtimeMs;
      // No owner yet: either legacy or mid-acquire; give a fresh one a 10s grace.
      let alive = Number.isInteger(owner.pid) && owner.pid > 0 ? true : Date.now() - at < 10000;
      if (Number.isInteger(owner.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); } catch (probe) { alive = probe.code === 'EPERM'; }
      if (alive && Date.now() - at < staleMs) return null;
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  return null;
}
export function acquireTransaction() {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const release = tryLock(path.join(root(), 'install.lock'), 30 * 60000);
  if (!release) {
    const busy = new Error('Configuration transaction busy; inspect existing installation before retrying');
    busy.code = 'AGENT_CONTEXT_BUSY'; throw busy;
  }
  return release;
}
export function keyStatus() {
  const device = enrollment();
  if (device) return { present: true, conflict: false, key: device.token, gateway: device.gateway };
  if (fs.existsSync(path.join(root(), 'enrollment.json'))) return { present: false, conflict: false, error: 'invalid_device_config' };
  let fileKey = '';
  try { fileKey = JSON.parse(fs.readFileSync(path.join(home(), '.supercompress', 'config.json'), 'utf8')).api_key || ''; }
  catch (error) { if (error.code !== 'ENOENT') return { present: false, conflict: false, error: 'invalid_key_config' }; }
  const envKey = process.env.SUPERCOMPRESS_API_KEY || '';
  const conflict = Boolean(envKey && fileKey && envKey !== fileKey);
  return { present: Boolean(envKey || fileKey), conflict, key: envKey || fileKey };
}
function audit(event) {
  try {
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    const file = path.join(root(), 'events.jsonl');
    // Bounded metadata only; raw context, query, response and keys never enter this log.
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), recipe: version, ...event })}\n`, { mode: 0o600 });
  } catch { /* Telemetry must not block an agent. */ }
}

export async function compress({ context, query, session, agent, source = 'mcp' }, options = {}) {
  if (typeof context !== 'string' || typeof query !== 'string' || !query.trim()) throw new Error('context and nonempty query must be strings');
  if (typeof session !== 'string' || !session || typeof agent !== 'string' || !agent) throw new Error('agent and session are required');
  const started = Date.now();
  const fallback = reason => {
    audit({ agent, source, status: reason, elapsed_ms: Date.now() - started, input_chars: context.length });
    return { compressed_text: context, skipped: reason, elapsed_ms: Date.now() - started };
  };
  if (!context.trim()) return fallback('empty');
  if (context.length > 100000) return fallback('too_large');
  const credentials = options.credentials || keyStatus();
  if (credentials.conflict) return fallback('key_conflict');
  if (!credentials.present) return fallback(credentials.error || 'missing_key');
  const stateFile = path.join(root(), 'state', `${sha(`${agent}\0${session}`)}.json`);
  const lock = `${stateFile}.lock`;
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); }
  catch { return fallback('state_unavailable'); }
  let release;
  try { release = tryLock(lock, 60000); } catch { return fallback('state_unavailable'); }
  if (!release) return fallback('session_busy');
  try {
    let state = { seen: [] };
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') return fallback('invalid_state'); }
    if (!Array.isArray(state.seen) || state.seen.some(value => typeof value !== 'string')) return fallback('invalid_state');
    const digest = sha(`compiler-ccr\0${context}\0${query}`);
    if (state.seen.includes(digest)) return { compressed_text: '', skipped: 'already_seen', elapsed_ms: 0 };
    const result = await compressSupercompress({ context, query, session, agent }, { ...options, credentials });
    if (result.skipped) return fallback(result.skipped);
    state.seen = [...state.seen.slice(-255), digest];
    atomicWrite(stateFile, JSON.stringify(state));
    audit({ agent, source, status: 'compressed', ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'compressed_text')) });
    return result;
  } finally { release(); }
}
