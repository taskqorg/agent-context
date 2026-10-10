import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { connectionFor, bin, doctor } from './install.js';
import { compress, home, root } from './core.js';
import { serviceHealth } from './service.js';

const names = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' };

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
// Automatic mode: proxy compresses requests; the legacy MCP adapter is disabled or removed.
async function verifyAutomatic(agent) {
  const configured = doctor().agents[agent] === 'configured';
  const service = await serviceHealth(agent) ? 'ready' : 'unavailable';
  const result = await compress({ context: sample(), query: 'Summarize the observations and preserve the exact ERROR line.', session: `verify-${crypto.randomUUID()}`, agent: names[agent] });
  const { compressed_text, ...metadata } = result;
  const report = { agent, mode: 'automatic', configured, service, ...metadata, criticalRetained: compressed_text.includes('ERROR ECONNREFUSED db.internal:5432'), retrieval: 'not_applicable' };
  // Hermes has no retrieval MCP; Codex and Claude expose headroom_retrieve.
  const entry = agent === 'codex' ? parseToml(fs.readFileSync(path.join(home(), '.codex', 'config.toml'), 'utf8')).mcp_servers?.headroom
    : agent === 'claude' ? JSON.parse(fs.readFileSync(path.join(home(), '.claude.json'), 'utf8')).mcpServers?.headroom : null;
  if (agent !== 'hermes') {
    report.retrieval = 'unavailable';
    if (entry?.command && Array.isArray(entry.args)) {
      try {
        const raw = await runChild(entry.command, entry.args, [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-context-verify', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' }
        ].map(value => JSON.stringify(value)).join('\n') + '\n', entry.env);
        const tools = raw.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(value => value.id === 2)?.result?.tools || [];
        if (tools.some(tool => tool.name === 'headroom_retrieve')) report.retrieval = 'ready';
      } catch {}
    }
  }
  report.passed = configured && service === 'ready' && !result.skipped && report.criticalRetained && report.retrieval !== 'unavailable';
  report.proof = 'owned_service_bridge_and_retrieval_not_model_session';
  return report;
}
export async function verify(agent) {
  if (!names[agent]) throw new Error('Choose codex, claude or hermes');
  let automatic = [];
  try { automatic = JSON.parse(fs.readFileSync(path.join(root(), 'integration.json'), 'utf8')).agents || []; } catch {}
  if (automatic.includes(agent)) return verifyAutomatic(agent);
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
