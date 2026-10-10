import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { connectionFor, bin, automaticConfigured } from './install.js';
import { selectPython } from './headroom.js';
import { home } from './core.js';

export const sample = () => Array.from({ length: 35 }, (_, i) => `Diagnostic item ${i}: global agent integration uses one compressor and preserves the original when unavailable.`).join('\n') + '\nERROR ECONNREFUSED db.internal:5432';
export async function runChild(command, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native verification timed out')); }, 25000);
    child.stdout.on('data', value => {
      bytes += value.length;
      if (bytes > 2000000) { child.kill(); reject(new Error('Native verification output limit')); }
      else output += value.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (code) reject(new Error('Native verification process failed')); else resolve(output); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const hermesRegistrationScript = String.raw`
import importlib.util
import json
import sys

plugin_path, settings = sys.argv[1], json.load(sys.stdin)
class Context:
    def __init__(self):
        self.hooks = {}
        self.tools = {}
    def get_config(self, key, default=None):
        return settings.get(key, default)
    def register_hook(self, name, handler):
        self.hooks[name] = handler
    def register_tool(self, **value):
        self.tools[value['name']] = value

spec = importlib.util.spec_from_file_location('agent_context_configured_plugin', plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ctx = Context()
module.register(ctx)
tool = ctx.tools.get('agent_context_retrieve', {})
print(json.dumps({
    'hooks': sorted(ctx.hooks),
    'retrievalTool': tool.get('name'),
    'retrievalHandlerCallable': callable(tool.get('handler')),
}))
`;
async function verifyHermes() {
  const configFile = path.join(home(), '.hermes', 'config.yaml');
  const plugin = path.join(home(), '.hermes', 'plugins', 'agent-context', '__init__.py');
  const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  const settings = config?.plugins?.entries?.['agent-context']?.settings;
  if (!automaticConfigured('hermes', path.dirname(configFile)) || !fs.existsSync(plugin)) {
    throw new Error('Native Hermes verification requires the configured plugin adapter');
  }
  const python = await selectPython();
  const raw = await runChild(python[0], [...python.slice(1), '-c', hermesRegistrationScript, plugin], JSON.stringify(settings));
  const report = { agent: 'hermes', ...JSON.parse(raw), proof: 'configured_native_plugin_registration_not_model_session' };
  report.passed = report.hooks.join(',') === 'post_llm_call,pre_llm_call,transform_tool_result' && report.retrievalTool === 'agent_context_retrieve' && report.retrievalHandlerCallable;
  return report;
}
export async function verify(agent) {
  if (agent === 'hermes') return verifyHermes();
  const connection = connectionFor(agent);
  if (connection?.command !== process.execPath || connection?.args?.[0] !== bin() || connection?.args?.[1] !== 'mcp' || connection?.args?.[2] !== agent) throw new Error('Native verification requires the installed adapter');
  const args = { context: sample(), query: 'Summarize the observations and preserve the exact ERROR line.', session_id: `verify-${crypto.randomUUID()}` };
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'compress_context', arguments: args } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'compress_context', arguments: args } }
  ];
  const raw = await runChild(connection.command, connection.args, messages.map(value => JSON.stringify(value)).join('\n') + '\n', connection.env);
  const replies = raw.trim().split('\n').map(line => JSON.parse(line));
  const result = JSON.parse(replies.find(value => value.id === 3).result.content[0].text);
  const repeat = JSON.parse(replies.find(value => value.id === 4).result.content[0].text);
  const { compressed_text, ...metadata } = result;
  const report = { agent, ...metadata, criticalRetained: compressed_text.includes('ERROR ECONNREFUSED db.internal:5432'), repeatSkipped: repeat.skipped === 'already_seen', proof: 'configured_native_stdio_not_model_session' };
  if (agent === 'claude') {
    const response = { stdout: sample(), stderr: 'stderr must remain unchanged', exitCode: 7 };
    const input = { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: `hook-verify-${crypto.randomUUID()}`, tool_response: response };
    const output = JSON.parse(await runChild(process.execPath, [bin(), 'hook', 'claude'], JSON.stringify(input)));
    const changed = output.hookSpecificOutput?.updatedToolOutput;
    report.hook = { replaced: Boolean(changed), stderrPreserved: changed?.stderr === response.stderr, exitCodePreserved: changed?.exitCode === response.exitCode, criticalRetained: changed?.stdout?.includes('ERROR ECONNREFUSED db.internal:5432') || false, inputChars: response.stdout.length, outputChars: changed?.stdout?.length || response.stdout.length, warning: output.systemMessage || null };
  }
  report.passed = !result.skipped && report.criticalRetained && report.repeatSkipped && (!report.hook || ['replaced', 'stderrPreserved', 'exitCodePreserved', 'criticalRetained'].every(key => report.hook[key]));
  return report;
}
