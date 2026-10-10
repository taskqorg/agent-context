import { compressSupercompress } from '../src/supercompress.js';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 500000) throw new Error('Input too large');
}
const result = await compressSupercompress(JSON.parse(input));
process.stdout.write(JSON.stringify(result));
