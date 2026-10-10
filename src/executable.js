import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function sameFile(actual, expected) {
  if (typeof actual !== 'string' || !actual || typeof expected !== 'string' || !expected) return false;
  try {
    const a = fs.realpathSync(actual), b = fs.realpathSync(expected);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

export function compatibleNode(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || /\.(cmd|ps1|bat)$/i.test(command)) return false;
  try {
    if (!fs.statSync(command).isFile()) return false;
    const result = spawnSync(command, ['--version'], { timeout: 3000, maxBuffer: 1024, encoding: 'utf8', windowsHide: true });
    const version = /^v(\d+)\.\d+\.\d+\s*$/.exec(result.stdout || '');
    return result.status === 0 && Boolean(version) && Number(version[1]) >= 22;
  } catch { return false; }
}


export function agentExecutable(agent, env = process.env, platform = process.platform) {
  if (!['codex', 'claude', 'hermes'].includes(agent)) throw new Error('Choose codex, claude or hermes');
  const explicit = env[`AGENT_CONTEXT_${agent.toUpperCase()}_EXE`];
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = explicit ? [explicit] : dirs.flatMap(dir => platform === 'win32' ? [path.join(dir, agent + '.exe'), path.join(dir, 'node_modules', agent === 'claude' ? '@anthropic-ai/claude-code/bin/claude.exe' : '@openai/codex/bin/codex.js')] : [path.join(dir, agent)]);
  for (const file of candidates) {
    try {
      const resolved = fs.realpathSync(file);
      if (!fs.statSync(resolved).isFile()) continue;
      if (env.WSL_DISTRO_NAME && resolved.startsWith('/mnt/')) continue;
      if (resolved.endsWith('.js')) {
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), '../package.json'), 'utf8'));
        if (pkg.name !== '@openai/codex') continue;
        return { command: process.execPath, args: [resolved] };
      }
      if (/\.(cmd|ps1|bat)$/i.test(resolved)) continue;
      return { command: resolved, args: [] };
    } catch { /* Only existing known native entrypoints qualify. */ }
  }
  throw new Error(`Unsupported ${agent} executable; set AGENT_CONTEXT_${agent.toUpperCase()}_EXE to a native executable`);
}
