import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { root, home } from './core.js';
import { launcher } from './update.js';
import { servicePort } from './service.js';
import { profileIdentity, langfuseConfig } from './telemetry.js';

import { nativePolicy } from './native-tools.js';
import {codexExporterPath} from './native-export.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const text = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const json = value => JSON.stringify(value, null, 2) + '\n';
export function automaticPlan(plan) {
  const changes = new Map(plan.changes.map(item => [item.file, item.after]));
  const current = file => changes.get(file) ?? text(file);
  const quote = value => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\"'\"'")}'`;
  const hook = agent => ({ type: 'command', command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(launcher())} lifecycle ${agent}`, timeout: 45,
    ...(process.platform === 'win32' ? agent === 'claude' ? { shell: 'powershell' } : { commandWindows: `& ${quote(process.execPath)} ${quote(launcher())} lifecycle ${agent}` } : {}) });
  const checkMcp = entries => {
    for(const name of ['agent_context','context_mode','headroom']) {
      const entry=entries?.[name];
      if(entry && (entry.command!==process.execPath || entry.args?.[0]!==launcher())) throw new Error('Unsupported existing optimization MCP; preserve its configuration');
    }
  };
  const telemetry = langfuseConfig();
  if (telemetry && !telemetry.gateway) {
    const file = path.join(home(), '.codex/langfuse.json');
    changes.set(file, json({ ...JSON.parse(current(file) || '{}'), ...telemetry }));
  }
  changes.set(path.join(root(), 'compression.json'), json({ schema: 1, provider: 'local-tools', timeout_seconds: 10 }));
  const identity = profileIdentity();
  const stage = ['production', 'development', 'qualification'].includes(process.env.AGENT_CONTEXT_STAGE) ? process.env.AGENT_CONTEXT_STAGE : 'production';
  for (const agent of plan.installed) {
    const dir = path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`);
    const url = `http://127.0.0.1:${servicePort(agent)}`;
    const labels = [`agent:${agent === 'claude' ? 'claude-code' : agent}`, `host:${identity.host}`, `runtime:${identity.runtime}`];
    if (agent === 'codex') {
      if (telemetry) {
        const file = path.join(dir, 'langfuse.json');
        const config = JSON.parse(current(file) || '{}');
        const tags = [...(config.tags || []).filter(tag => !/^(agent|host|runtime):/.test(tag)), ...labels];
        changes.set(file, json({ ...config, enabled: config.enabled ?? true, public_key: telemetry.public_key, secret_key: telemetry.secret_key, base_url: url, agent_context_base_url: telemetry.base_url, ...(telemetry.user_id ? { user_id: telemetry.user_id } : {}), environment: stage, tags }));
      }
      const file = path.join(dir, 'config.toml');
      const value = parse(current(file));
      const enableHooks = Boolean(telemetry && value.plugins?.['tracing@codex-observability-plugin']?.enabled === true && value.features?.hooks == null);
      const hadFeatures = Boolean(value.features);
      if (enableHooks) value.features = { ...value.features, hooks: true };
      const queuedExporter=Boolean(telemetry&&fs.existsSync(codexExporterPath()));
      if(queuedExporter) {value.plugins ||= {};value.plugins['tracing@codex-observability-plugin']={...value.plugins['tracing@codex-observability-plugin'],enabled:false};}
      if (value.model_provider && !['openai', 'agent_context'].includes(value.model_provider)) throw new Error('Unsupported custom Codex provider; preserve its routing');
      checkMcp(value.mcp_servers);
      value.model_provider = 'agent_context';
      value.model_providers ||= {};
      value.model_providers.agent_context = { name: 'Agent Context', base_url: url + '/v1', wire_api: 'responses', requires_openai_auth: true, supports_websockets: true };
      delete value.mcp_servers.supercompress;
      delete value.mcp_servers.context_mode;
      value.mcp_servers.agent_context = { command: process.execPath, args: [launcher(), 'tools', 'mcp', agent], enabled_tools: ['index_document', 'search_document', 'get_original'], tools:{...value.mcp_servers.agent_context?.tools,index_document:{...value.mcp_servers.agent_context?.tools?.index_document,approval_mode:value.mcp_servers.agent_context?.tools?.index_document?.approval_mode || 'approve'}}, startup_timeout_sec: 60, tool_timeout_sec: 60 };
      delete value.mcp_servers.headroom;
      let preserved = current(file).split(/(?=^\s*\[)/m).filter(section => {
        const header = /^\s*\[([^\]\r\n]+)\]/.exec(section);
        if (!header) return true;
        const parts = header[1].split('.').map(part => part.trim().replace(/^['"]|['"]$/g, ''));
        return !(parts[0] === 'model_providers' && parts[1] === 'agent_context' || parts[0] === 'mcp_servers' && ['supercompress', 'headroom', 'context_mode', 'agent_context'].includes(parts[1]) || queuedExporter&&parts[0]==='plugins'&&parts[1]==='tracing@codex-observability-plugin');
      }).join('').replace(/^model_provider\s*=.*\r?\n?/m, '');
      if (enableHooks && hadFeatures) preserved = preserved.replace(/^(\s*\[features\][^\r\n]*\r?\n)/m, '$1hooks = true\n');
      const after = 'model_provider = "agent_context"\n' + preserved.trimEnd() + '\n\n' + stringify({ ...(enableHooks && !hadFeatures ? { features: value.features } : {}), model_providers: { agent_context: value.model_providers.agent_context }, mcp_servers: { agent_context: value.mcp_servers.agent_context },...(queuedExporter?{plugins:{'tracing@codex-observability-plugin':value.plugins['tracing@codex-observability-plugin']}}:{}) });
      const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
      if (JSON.stringify(canonical(parse(after))) !== JSON.stringify(canonical(value))) throw new Error('Unsupported automatic Codex TOML layout; no configuration changed');
      changes.set(file, after);
      const hooks = path.join(dir, 'hooks.json');
      const config = JSON.parse(current(hooks) || '{}');
      config.hooks ||= {}; config.hooks.SessionStart ||= [];
      config.hooks.SessionStart = config.hooks.SessionStart.filter(rule => !rule.hooks?.some(item => item.command?.includes(launcher()) && item.command?.includes('lifecycle')));
      config.hooks.SessionStart.push({ hooks: [hook(agent)] });
      if(queuedExporter) {
        config.hooks.Stop=(config.hooks.Stop||[]).map(rule=>({...rule,hooks:rule.hooks.filter(h=>!(h.command?.includes(launcher())&&h.command.includes('native-hook codex')))})).filter(rule=>rule.hooks.length);
        const command=`${process.platform==='win32'?'& ':''}${quote(process.execPath)} ${quote(launcher())} native-hook codex`;
        config.hooks.Stop.push({hooks:[{type:'command',command,timeout:5,statusMessage:'Queueing Codex telemetry',...(process.platform==='win32'?{shell:'powershell',commandWindows:command}:{})}]});
      }
      changes.set(hooks, json(config));
    } else if (agent === 'claude') {
      const file = path.join(dir, 'settings.json');
      const config = JSON.parse(current(file) || '{}');
      config.env ||= {};
      if (config.env.ANTHROPIC_BASE_URL && config.env.ANTHROPIC_BASE_URL !== url) throw new Error('Unsupported existing Claude proxy; preserve its routing');
      config.env.ANTHROPIC_BASE_URL = url;
      if (telemetry) {
        const tags = (config.env.CC_LANGFUSE_TRACE_TAGS || '').split(',').map(tag => tag.trim()).filter(tag => tag && !/^(agent|host|runtime):/.test(tag));
        config.env.CC_LANGFUSE_TRACE_TAGS = [...tags, ...labels].join(',');
        config.env.LANGFUSE_TRACING_ENVIRONMENT = stage;
        config.env.LANGFUSE_FLUSH_AT = '1';
        {
          config.env.LANGFUSE_PUBLIC_KEY = telemetry.public_key;
          config.env.LANGFUSE_SECRET_KEY = telemetry.secret_key;
          config.env.LANGFUSE_BASE_URL = url;
          config.env.LANGFUSE_HOST = config.env.LANGFUSE_BASE_URL;
        }
      }
      config.permissions ||= {};
      for(const key of ['allow','deny']) config.permissions[key]=(config.permissions[key]||[]).filter(value=>!/^mcp__(headroom|supercompress)__/.test(value));
      config.hooks.PostToolUse = (config.hooks.PostToolUse || []).filter(rule => !rule.hooks?.some(item => item.command?.includes(launcher())));
      config.hooks.SessionStart ||= [];
      config.hooks.SessionStart = config.hooks.SessionStart.filter(rule => !rule.hooks?.some(item => item.command?.includes(launcher()) && item.command?.includes('lifecycle')));
      config.hooks.SessionStart.push({ hooks: [hook(agent)] });
      config.hooks.PreToolUse = (config.hooks.PreToolUse || []).filter(rule => !rule.hooks?.some(item => item.command?.includes(launcher())));
      config.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ ...hook(agent), command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(launcher())} tools hook`, timeout: 5 }] });
      changes.set(file, json(config));
      const mcp = path.join(home(), '.claude.json');
      const settings = JSON.parse(current(mcp) || '{}');
      checkMcp(settings.mcpServers);
      delete settings.mcpServers.supercompress;
      delete settings.mcpServers.context_mode;
      settings.mcpServers.agent_context = { command: process.execPath, args: [launcher(), 'tools', 'mcp', agent] };
      delete settings.mcpServers.headroom; changes.set(mcp, json(settings));
    } else {
      const file = path.join(dir, 'config.yaml');
      const doc = YAML.parseDocument(current(file));
      const enabled = doc.getIn(['plugins', 'enabled'])?.toJSON?.() || [];
      if (!Array.isArray(enabled)) throw new Error('Unsupported Hermes plugin list');
      doc.setIn(['plugins', 'enabled'], [...new Set([...enabled, 'agent-context'])]);
      doc.setIn(['plugins', 'entries', 'agent-context', 'settings', 'proxy_url'], url);
      doc.setIn(['plugins', 'entries', 'agent-context', 'settings', 'launcher'], launcher());
      doc.setIn(['plugins', 'entries', 'agent-context', 'settings', 'node'], process.execPath);
      if (telemetry && enabled.includes('observability/langfuse') && !enabled.includes('tight-langfuse')) {
        const tags = doc.getIn(['plugins', 'entries', 'observability/langfuse', 'settings', 'tags'])?.toJSON?.() || [];
        doc.setIn(['plugins', 'entries', 'observability/langfuse', 'settings', 'tags'], [...tags.filter(tag => !/^(agent|host|runtime):/.test(tag)), ...labels]);
        doc.setIn(['plugins', 'entries', 'observability/langfuse', 'settings', 'environment'], stage);
      }
      if (telemetry) {
        const envFile = path.join(dir, '.env');
        const before = current(envFile);
        let after = before.trimEnd();
        for (const [key, value] of Object.entries({ PUBLIC_KEY: telemetry.public_key, SECRET_KEY: telemetry.secret_key, BASE_URL: url })) {
          const line = 'HERMES_LANGFUSE_' + key + '=' + value;
          const pattern = new RegExp('^\\s*(?:export\\s+)?HERMES_LANGFUSE_' + key + '\\s*=.*$', 'm');
          after = pattern.test(after) ? after.replace(pattern, () => line) : after + '\n' + line;
        }
        changes.set(envFile, after.trimStart() + '\n');
      }
      if (telemetry && enabled.includes('tight-langfuse')) {
        const envFile = path.join(dir, '.env');
        // The external observer envelope consumes two levels before request/response content.
        if (!/^\s*(?:export\s+)?HERMES_LANGFUSE_MAX_DEPTH\s*=/m.test(current(envFile))) {
          changes.set(envFile, current(envFile).trimEnd() + '\nHERMES_LANGFUSE_MAX_DEPTH=10\n');
        }
      }
      checkMcp(doc.get('mcp_servers')?.toJSON?.());
      if (!doc.get('mcp_servers')) doc.set('mcp_servers', doc.createNode({}));
      doc.deleteIn(['mcp_servers','supercompress']);
      doc.deleteIn(['mcp_servers','headroom']);
      doc.deleteIn(['mcp_servers','context_mode']);
      doc.setIn(['mcp_servers', 'agent_context'], { command: process.execPath, args: [launcher(), 'tools', 'mcp', agent] });
      changes.set(file, doc.toString());
      const plugin = path.join(dir, 'plugins', 'agent-context');
      changes.set(path.join(plugin, 'plugin.yaml'), text(path.join(source, 'integrations/hermes/agent-context/plugin.yaml')));
      // Stable bootstrap loads only the integrity-checked selected managed package.
      changes.set(path.join(plugin, '__init__.py'), `import importlib.util, json, subprocess\n\ndef register(ctx):\n    node = ctx.get_config('node', '')\n    launcher = ctx.get_config('launcher', '')\n    value = json.loads(subprocess.check_output([node, launcher, 'plugin-path', 'hermes'], timeout=30, text=True))\n    spec = importlib.util.spec_from_file_location('agent_context_managed', value['path'])\n    module = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(module)\n    module.register(ctx)\n`);
    }
    if (agent !== 'hermes') {
      const policy = path.join(dir, agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
      const before = current(policy);
      const block = nativePolicy(launcher(), process.execPath, agent);
      changes.set(policy, /<!-- agent-context:start -->/.test(before) ? before.replace(/<!-- agent-context:start -->[\s\S]*?<!-- agent-context:end -->/, block) : before.trimEnd() + '\n\n' + block + '\n');
    }
  }
  return { ...plan, changes: [...changes].map(([file, after]) => ({ file, after })).filter(item => text(item.file) !== item.after) };
}
