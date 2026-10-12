import fs from 'node:fs';
import path from 'node:path';
import { root, atomicWrite } from './core.js';

export const providers = ['local-tools', 'headroom-local', 'supercompress', 'scaledown'];
export function providerSettings(env = process.env) {
  const file = path.join(root(), 'compression.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const provider = env.AGENT_CONTEXT_COMPRESSOR || saved.provider || 'local-tools';
  const timeout_seconds = saved.timeout_seconds ?? 10;
  if (!providers.includes(provider) || !Number.isFinite(timeout_seconds) || timeout_seconds < 0.1 || timeout_seconds > 30) throw new Error('Invalid compressor settings');
  return { provider, timeout_seconds };
}
export function selectProvider(provider) {
  if (!providers.includes(provider)) throw new Error(`Choose ${providers.join(', ')}`);
  atomicWrite(path.join(root(), 'compression.json'), JSON.stringify({ schema: 1, provider, timeout_seconds: 10 }));
  return { configuredProvider: provider, runningProvider: 'not_checked', restartRequired: true };
}
