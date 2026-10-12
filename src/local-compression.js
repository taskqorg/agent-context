import { execFile } from 'node:child_process';
import { prepareHeadroom, pythonEnvironment } from './headroom.js';
import { providerSettings } from './providers.js';

// Probe/legacy callers only; the automatic proxy runs TextCrusher in-process.
async function runLocal(input) {
  const runtime = await prepareHeadroom();
  return new Promise((resolve, reject) => {
    const child = execFile(runtime.python, ['-m', 'agent_context_headroom.plain'], {
      timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: pythonEnvironment({ ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HEADROOM_OFFLINE: '1', HEADROOM_STATELESS: 'true' }),
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function compressLocal({ context, query }, { run = runLocal } = {}) {
  if (typeof context !== 'string' || typeof query !== 'string' || !query.trim()) throw new Error('context and nonempty query must be strings');
  const started = Date.now();
  const result = (text, skipped) => ({ compressed_text: text, skipped, compressor: providerSettings().provider, elapsed_ms: Date.now() - started, input_chars: context.length, output_chars: text.length });
  if (!context.trim()) return result(context, 'empty');
  if (context.length > 100000) return result(context, 'too_large');
  try {
    const { compressed_text: text, outcome } = await run({ context, query });
    if (outcome && outcome !== 'compressed') return result(context, outcome);
    if (typeof text !== 'string' || !text.trim()) return result(context, 'invalid_response');
    if (context.split(/\r?\n/).some(line => /^(ERROR|FATAL|Traceback)\b/.test(line) && !text.includes(line))) return result(context, 'lost_critical_evidence');
    return text.length < context.length ? result(text, null) : result(context, 'no_gain');
  } catch { return result(context, 'local_compressor_unavailable'); }
}
