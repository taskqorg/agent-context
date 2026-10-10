import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import YAML from 'yaml';
import { home } from './core.js';

const suspect = /compress|headroom|\brtk\b|context[-_ ]?(prun|optim)|token[-_ ]?optim|llmlingua/i;
export function compressionWarnings(base = home(), cwd = process.cwd()) {
  const warnings = [];
  const add = (agent, scope, source, kind, name) => warnings.push({ code: 'possible_double_compression', agent, scope, source, kind,
    integration: /^[a-zA-Z][a-zA-Z0-9._/-]{0,80}(?:@[a-zA-Z0-9._-]{1,64})?$/.test(name || '') && !/^(sk-|pk-|ghp_)/i.test(name) ? name : 'unknown',
    action: 'Review this integration before combining compression. No third-party plugin was disabled.' });
  const inspect = (file, agent, scope) => {
    if (!fs.existsSync(file)) return;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const config = file.endsWith('.toml') ? parse(text) : file.endsWith('.yaml') ? YAML.parse(text) : JSON.parse(text);
      for (const [name, entry] of Object.entries(config?.mcp_servers || config?.mcpServers || {})) {
        if (entry.enabled === false || entry.disabled === true) continue;
        const args = Array.isArray(entry.args) ? entry.args : [];
        if (['headroom', 'supercompress'].includes(name) && args.some(arg => /agent-context/.test(arg)) && args.some(arg => ['retrieval', 'mcp'].includes(arg))) continue;
        if (suspect.test(name + ' ' + (entry.command || '') + ' ' + args.join(' '))) add(agent, scope, path.basename(file), 'mcp', name);
      }
      const plugins = config?.enabledPlugins || config?.plugins || {};
      for (const [name, value] of Object.entries(plugins)) {
        if ((value === true || value?.enabled === true) && suspect.test(name)) add(agent, scope, path.basename(file), 'plugin', name);
      }
      for (const name of Array.isArray(plugins.enabled) ? plugins.enabled : []) if (name !== 'agent-context' && suspect.test(name)) add(agent, scope, path.basename(file), 'plugin', name);
      for (const [event, rules] of Object.entries(config?.hooks || {})) {
        if (!Array.isArray(rules)) continue;
        for (const rule of rules) for (const hook of rule.hooks || [rule]) {
          const command = `${hook.command || ''} ${hook.commandWindows || ''}`;
          if (!command.includes('agent-context') && suspect.test(command)) add(agent, scope, path.basename(file), 'hook', event);
        }
      }
    } catch { warnings.push({ code: 'compression_inventory_incomplete', agent, scope, source: path.basename(file) }); }
  };
  for (const [agent, files] of Object.entries({ codex: ['.codex/config.toml', '.codex/hooks.json'], claude: ['.claude.json', '.claude/settings.json', '.claude/settings.local.json'], hermes: ['.hermes/config.yaml'] })) {
    for (const file of files) inspect(path.join(base, file), agent, 'user');
  }
  if (path.resolve(base) !== path.resolve(cwd)) for (const [agent, file] of [['codex', '.codex/config.toml'], ['claude', '.claude/settings.json'], ['claude', '.claude/settings.local.json'], ['unknown', '.mcp.json']]) inspect(path.join(cwd, file), agent, 'project');
  return warnings;
}
