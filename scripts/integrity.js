import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, version } from '../src/core.js';
import { extraRuntimeFiles } from '../src/update.js';
const dir = fileURLToPath(new URL('../', import.meta.url));
const files = {};
for (const folder of ['bin', 'src']) for (const name of fs.readdirSync(path.join(dir, folder))) {
  const file = `${folder}/${name}`;
  if (fs.statSync(path.join(dir, file)).isFile()) files[file] = sha(fs.readFileSync(path.join(dir, file)));
}
// Stable 0.4.15 rejects this path; its thin entrypoint imports hash-checked src runtime.
for (const file of extraRuntimeFiles) if (file !== 'scripts/serve-serviceq.js') files[file] = sha(fs.readFileSync(path.join(dir, file)));
const manifest = `${JSON.stringify({ version, files }, null, 2)}\n`;
const target = path.join(dir, 'integrity.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== manifest) throw new Error('Recipe integrity mismatch: review and run tests before packaging');
} else fs.writeFileSync(target, manifest);
