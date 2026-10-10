import crypto from 'node:crypto';
import { compress, version } from './core.js';

export function serve(agent) {
  const policy = 'Use once for new bulky context when useful. Never compress the user query or credentials, authentication files, or other secrets. Prefer returned compressed_text; on skipped/failure retain original context; already_seen means no new digest. Do not read an unrelated global inbox or replay session history. Supply a stable session_id for deduplication. This tool does not intercept every model request; do not claim total token savings without measurements. Keep normal agent login; run agent-context doctor for configuration checks.'
    + (agent === 'claude' ? ' Bash stdout is already handled by the Agent Context hook; do not recompress it through MCP.' : '');
  const session = crypto.randomUUID();
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  const send = (object, framed) => {
    const raw = Buffer.from(JSON.stringify(object));
    process.stdout.write(framed ? Buffer.concat([Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`), raw]) : Buffer.concat([raw, Buffer.from('\n')]));
  };
  async function handle(message, framed) {
    if (!Object.hasOwn(message, 'id')) return;
    let result;
    try {
      if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-context', version } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: [{ name: 'compress_context', description: policy, inputSchema: { type: 'object', properties: { context: { type: 'string' }, query: { type: 'string' }, session_id: { type: 'string' } }, required: ['context', 'query'], additionalProperties: false } }] };
      else if (message.method === 'tools/call') {
        if (message.params?.name !== 'compress_context') throw new Error('Unknown tool');
        const args = message.params.arguments || {};
        const value = await compress({ context: args.context, query: args.query, session: args.session_id || session, agent });
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }, framed);
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, result }, framed);
    } catch {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid tool request; keep original context' } }, framed);
    }
  }
  function drain() {
    while (buffer.length) {
      let raw, framed = false;
      if (buffer.length < 15 && 'content-length:'.startsWith(buffer.toString().toLowerCase())) return;
      if (buffer.subarray(0, 15).toString().toLowerCase().startsWith('content-length:')) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > 2000000) { process.stdin.destroy(); return; }
        if (buffer.length < end + 4 + length) return;
        raw = buffer.subarray(end + 4, end + 4 + length).toString();
        buffer = buffer.subarray(end + 4 + length);
        framed = true;
      } else {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        raw = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
      }
      if (!raw.trim()) continue;
      try { const msg = JSON.parse(raw); chain = chain.then(() => handle(msg, framed)); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, framed); }
    }
  }
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 2000000) { process.stdin.destroy(); return; }
    drain();
  });
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); });
}
