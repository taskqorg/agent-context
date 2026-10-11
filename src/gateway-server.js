import fs from 'node:fs';
import http from 'node:http';
import { createGateway } from './gateway.js';

// TLS is terminated by the existing reverse proxy; this listener never binds publicly.
export async function serveGateway(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const port = config.port ?? 18880;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Unsupported gateway port');
  if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) throw new Error('Unsupported gateway config permissions; require 0600');
  const gateway = createGateway(config);
  const server = http.createServer(async (req, res) => {
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const request = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await gateway.handle(request, req.socket.remoteAddress);
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503); res.end('{"error":"gateway_unavailable"}'); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
