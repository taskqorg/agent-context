// Qualification adapter only. Stock DietCode output is never patched into a success.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
const [dir, variant] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const config = JSON.parse(fs.readFileSync(`${dir}/bundle.json`, 'utf8'));
const stdout = input.tool_response?.stdout;
const command = String(input.tool_input?.command || '');
const row = { variant, session_id: input.session_id, event: input.hook_event_name,
  tool: input.tool_name, response_fields: Object.keys(input.tool_response || {}),
  input_chars: typeof stdout === 'string' ? stdout.length : 0, outcome: 'passthrough' };
const run = (file, args, text, env) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { env, timeout: 12000, maxBuffer: 1024 * 1024 }, (error, out) => {
    if (error) return reject(error); resolve(out);
  });
  child.stdin.on('error', () => {}); child.stdin.end(text);
});
let output = {};
try {
  if (variant === 'dietcode') {
    const key = fs.readFileSync(config.key_source, 'utf8').trim();
    const raw = await run(process.execPath, [config.dietcode_hook], JSON.stringify(input),
      { ...process.env, SCALEDOWN_API_KEY: key, SCALEDOWN_COMPRESS_RATE: 'auto' });
    output = JSON.parse(raw);
    row.vendor_output_fields = Object.keys(output);
    row.outcome = output.hookSpecificOutput?.updatedToolOutput ? 'vendor_replacement' : 'no_supported_replacement';
  } else if (variant === 'cloud' && typeof stdout === 'string' && stdout.length >= 2048) {
    // Full Git/source/JSON/unknown commands bypass the API; no command is executed twice.
    if (!/\bpytest\b|\bnode\s+--test\b/.test(command)) row.outcome = 'protected';
    else {
      const key = fs.readFileSync(config.key_source, 'utf8').trim();
      const raw = await run(config.python, ['-m', 'agent_context_headroom.plain'], JSON.stringify({
        context: stdout, query: 'Preserve every failing test, exact error details, exit evidence and passed/failed counts.',
      }), { ...process.env, PYTHONPATH: config.python_path, AGENT_CONTEXT_HOME: dir,
        AGENT_CONTEXT_COMPRESSOR: 'scaledown', SCALEDOWN_API_KEY: key, SCALEDOWN_COMPRESS_RATE: 'auto' });
      const result = JSON.parse(raw);
      row.outcome = result.outcome;
      if (result.outcome === 'compressed') {
        const hash = crypto.createHash('sha256').update(stdout).digest('hex').slice(0, 16);
        const original = `${dir}/originals/${hash}.txt`;
        fs.mkdirSync(`${dir}/originals`, { recursive: true, mode: 0o700 });
        fs.writeFileSync(original, stdout, { mode: 0o600 });
        if (fs.readFileSync(original, 'utf8') !== stdout) throw new Error('archive_verification_failed');
        const text = `${result.compressed_text}\n[Qualification original: ${original}]`;
        if (text.length < stdout.length) {
          output = { hookSpecificOutput: { hookEventName: 'PostToolUse',
            updatedToolOutput: { ...input.tool_response, stdout: text } } };
          row.output_chars = text.length;
        } else row.outcome = 'no_gain_after_pointer';
      }
    }
  }
} catch { output = {}; row.outcome = 'failed_original_kept'; }
fs.appendFileSync(`${dir}/hook-events.jsonl`, JSON.stringify(row) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(output));
