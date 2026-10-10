import fs from 'node:fs';
import path from 'node:path';

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
