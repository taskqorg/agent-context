import { compressSupercompress } from '../src/supercompress.js';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 500000) throw new Error('Input too large');
}
const { timeout_ms: timeoutMs, ...request } = JSON.parse(input);
const result = await compressSupercompress(request, { timeoutMs: Math.min(10000, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000) });
process.stdout.write(JSON.stringify(result));
