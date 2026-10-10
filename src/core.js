import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const version = '0.1.3';
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
    const requestId = sha(`${version}\0${agent}\0${session}\0${digest}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    try {
      const response = await (options.fetch || fetch)('https://www.supercompress.dev/api/v1/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': credentials.key, 'Idempotency-Key': requestId },
        body: JSON.stringify({ context, query, ccr: true, mode: 'compiler', coding_agent: agent, source: 'agent-context', session_id: sha(session), request_id: requestId }),
        signal: controller.signal
      });
      if (!response.ok) return fallback(`http_${response.status}`);
      const body = await response.json();
      const text = body.compressed_text ?? body.compressed_context ?? body.compressed;
      if (typeof text !== 'string' || !text.trim()) return fallback('invalid_response');
      const critical = context.split(/\r?\n/).filter(line => /^(ERROR|FATAL|Traceback)\b/.test(line));
      if (critical.some(line => !text.includes(line))) return fallback('lost_critical_evidence');
      if (text.length >= context.length) return fallback('no_gain');
      state.seen = [...state.seen.slice(-255), digest];
      atomicWrite(stateFile, JSON.stringify(state));
      const input = body.original_tokens;
      const output = body.kept_tokens ?? body.compressed_tokens;
      const result = { compressed_text: text, skipped: null, elapsed_ms: Date.now() - started, input_chars: context.length, output_chars: text.length };
      if (Number.isFinite(input) && Number.isFinite(output)) Object.assign(result, { original_tokens: input, kept_tokens: output });
      audit({ agent, source, status: 'compressed', ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'compressed_text')) });
      return result;
    } catch (error) { return fallback(error.name === 'AbortError' ? 'timeout' : 'request_failed'); }
    finally { clearTimeout(timer); }
  } finally { fs.rmdirSync(lock); }
}
