// Read-only synthetic MCP fixture; no filesystem, subprocess or network access.
import readline from 'node:readline';
const text = Array.from({ length: 160 }, (_, i) => `Record ${i}: Successful routine deployment completed; no action required.`).join('\n')
  + '\nImportant finding: release amber-47 uses port 6543 and has retry limit 2.\n';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'read_fixture', description: 'Return the complete synthetic deployment fixture, read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
  else if (message.method === 'tools/call' && message.params.name === 'read_fixture') result = { content: [{ type: 'text', text }] };
  else if (message.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
