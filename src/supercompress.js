import { keyStatus, sha, version } from './core.js';
import { recordIncident } from './incidents.js';

// Stateless provider: replay must return content, never the MCP already_seen sentinel.
export async function compressSupercompress({ context, query, session, agent }, options = {}) {
  const started = Date.now();
  const fallback = skipped => {
    // Normal outcomes are metrics in events.jsonl, not incidents.
    if (!['empty', 'too_large', 'no_gain'].includes(skipped)) recordIncident({ component: 'compressor', operation: 'compress', category: skipped, agent: ['codex', 'claude-code', 'hermes', 'headroom'].includes(agent) ? agent : 'unknown' });
    return { compressed_text: context, skipped, elapsed_ms: Date.now() - started };
  };
  if (typeof context !== 'string' || typeof query !== 'string' || !query.trim()) throw new Error('context and nonempty query must be strings');
  if (!context.trim()) return fallback('empty');
  if (context.length > 100000) return fallback('too_large');
  const credentials = options.credentials || keyStatus();
  if (credentials.conflict) return fallback('key_conflict');
  if (!credentials.present) return fallback(credentials.error || 'missing_key');
  const requestId = sha(`${version}\0${agent}\0${session}\0${context}\0${query}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await (options.fetch || fetch)(credentials.gateway ? credentials.gateway + '/v1/compress' : 'https://www.supercompress.dev/api/v1/compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(credentials.gateway ? { Authorization: 'Bearer ' + credentials.key } : { 'X-API-Key': credentials.key }), 'Idempotency-Key': requestId },
      body: JSON.stringify({ context, query, ccr: true, mode: 'compiler', coding_agent: agent, source: 'agent-context', session_id: sha(session), request_id: requestId }),
      signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) return fallback(`http_${response.status}`);
    const body = await response.json();
    const text = body.compressed_text ?? body.compressed_context ?? body.compressed;
    if (typeof text !== 'string' || !text.trim()) return fallback('invalid_response');
    const critical = context.split(/\r?\n/).filter(line => /^(ERROR|FATAL|Traceback)\b/.test(line));
    if (critical.some(line => !text.includes(line))) return fallback('lost_critical_evidence');
    if (text.length >= context.length) return fallback('no_gain');
    const input = body.original_tokens;
    const output = body.kept_tokens ?? body.compressed_tokens;
    const result = { compressed_text: text, skipped: null, elapsed_ms: Date.now() - started, input_chars: context.length, output_chars: text.length };
    if (Number.isFinite(input) && Number.isFinite(output)) Object.assign(result, { original_tokens: input, kept_tokens: output });
    return result;
  } catch (error) { return fallback(error.name === 'AbortError' ? 'timeout' : 'request_failed'); }
  finally { clearTimeout(timer); }
}
