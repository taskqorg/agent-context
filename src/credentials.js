import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { home, atomicWrite } from './core.js';

// Native terminal input stays local; neither key appears in argv, chat or stdout.
export async function credentialInput(kind) {
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  output.isTTY = true;
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  reader.on('SIGINT', () => controller.abort());
  const ask = async (prompt, secret) => {
    process.stdout.write(prompt);
    hidden = secret;
    try { return (await reader.question('', { signal: controller.signal })).trim(); }
    finally { hidden = false; if (secret) process.stdout.write('\n'); }
  };
  try {
    process.stdout.write('Keys are saved only in this local profile. Input is hidden. Do not paste keys into chat.\n');
    if (kind === 'supercompress') return await ask('SuperCompress key: ', true);
    const base_url = await ask('Langfuse server URL: ', false);
    const public_key = await ask('Langfuse public key: ', true);
    const secret_key = await ask('Langfuse secret key: ', true);
    return JSON.stringify({ base_url, public_key, secret_key });
  } finally { reader.close(); output.end(); }
}

export function saveLangfuse(input) {
  let value;
  try { value = JSON.parse(input); } catch { throw new Error('Invalid Langfuse credentials'); }
  if (!value || !/^pk-lf-[A-Za-z0-9_-]{16,}$/.test(value.public_key) || !/^sk-lf-[A-Za-z0-9_-]{16,}$/.test(value.secret_key)) throw new Error('Invalid Langfuse credentials');
  let url;
  try { url = new URL(value.base_url); } catch { throw new Error('Invalid Langfuse credentials'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Langfuse credentials');
  const file = path.join(home(), '.codex/langfuse.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file)); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Unsupported existing Langfuse configuration; preserve it'); }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Unsupported existing Langfuse configuration; preserve it');
  // Explicit credential replacement invalidates delivery; owner metadata/trust remains intact.
  atomicWrite(file, JSON.stringify({ ...current, enabled: true, public_key: value.public_key, secret_key: value.secret_key, base_url: value.base_url.replace(/\/$/, '') }, null, 2) + '\n');
  return { keysSaved: true, delivery: 'unverified', nextSteps: ['agent-context setup', 'agent-context telemetry verify'] };
}
