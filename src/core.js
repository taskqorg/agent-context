import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compressSupercompress } from './supercompress.js';

export const version = '0.1.12';
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
export function acquireTransaction() {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const lock = path.join(root(), 'install.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const busy = new Error('Configuration transaction busy; inspect existing installation before retrying');
    busy.code = 'AGENT_CONTEXT_BUSY'; throw busy;
  }
  return () => fs.rmdirSync(lock);
}
export function keyStatus() {
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
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { return fallback(error.code === 'EEXIST' ? 'session_busy' : 'state_unavailable'); }
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
  } finally { fs.rmdirSync(lock); }
}
