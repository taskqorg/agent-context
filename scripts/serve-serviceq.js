import fs from 'node:fs';
import http from 'node:http';
import { overview } from '../src/serviceq-overview.js';
const config = JSON.parse(fs.readFileSync(process.env.AGENT_CONTEXT_LANGFUSE_CONFIG));
const credentials = config.langfuse || config;
const base = new URL(credentials.base_url);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || !/^pk-lf-/.test(credentials.public_key) || !/^sk-lf-/.test(credentials.secret_key)) throw new Error('Invalid Langfuse configuration');
const auth = 'Basic ' + Buffer.from(credentials.public_key + ':' + credentials.secret_key).toString('base64');
const assets = new Map([['/serviceq', ['serviceq.html', 'text/html']], ['/serviceq/', ['serviceq.html', 'text/html']], ['/serviceq/app.js', ['serviceq-ui.js', 'text/javascript']], ['/serviceq/style.css', ['serviceq.css', 'text/css']]].map(([route, [file, type]]) => [route, { body: fs.readFileSync(new URL('../src/' + file, import.meta.url)), type }]));
async function observations(query, from, to, cap = 10000) {
  let cursor, rows = []; const deadline = Date.now() + 45000;
  do {
    const url = new URL('/api/public/v2/observations', base);
    for (const [key, value] of Object.entries({ ...query, fields: 'core,basic,trace_context,metadata', fromStartTime: new Date(from).toISOString(), toStartTime: new Date(to).toISOString(), limit: 1000, ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, value);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Langfuse read deadline');
    const response = await fetch(url, { headers: { Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(Math.min(12000, remaining)) });
    if (!response.ok) throw new Error('Langfuse read failed');
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('Invalid Langfuse response');
    rows.push(...body.data); cursor = body.meta?.cursor || body.meta?.nextCursor;
  } while (cursor && rows.length < cap);
  return { rows, truncated: Boolean(cursor) };
}
const cache = new Map();
async function data(period) {
  const previous = cache.get(period);
  if (previous && Date.now() - previous.at < 30000) return previous.promise;
  const now = Date.now(), from = now - period * 1000;
  const promise = Promise.all([
    observations({ filter: JSON.stringify([{ type: 'string', column: 'name', operator: 'starts with', value: 'service.health.' }]) }, now - 86400000, now),
    observations({ name: 'agent-context.compression' }, from, now),
    observations({ type: 'GENERATION' }, from, now),
    observations({ name: 'service.incident' }, now - 86400000, now)
  ]).then(results => {
    const keys = ['health', 'compression', 'activity', 'incidents'];
    return overview({ ...Object.fromEntries(results.map((r, i) => [keys[i], r.rows])), truncated: results.flatMap((r, i) => r.truncated ? [keys[i]] : []) }, now, period);
  }).catch(error => { cache.delete(period); throw error; });
  cache.set(period, { at: now, promise }); return promise;
}
// This loopback service must stay behind the existing Langfuse UI access guard, never /api/public.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const asset = assets.get(url.pathname);
  if (asset) { res.setHeader('Content-Type', asset.type + '; charset=utf-8'); res.end(asset.body); return; }
  if (url.pathname !== '/serviceq/data') { res.writeHead(404).end(); return; }
  const period = Number(url.searchParams.get('period') || 1800);
  if (![1800, 7200, 86400].includes(period)) { res.writeHead(400).end(); return; }
  try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await data(period))); }
  catch { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Не удалось получить данные из Langfuse. Состояние системы не подтверждено.' })); }
});
server.listen(18881, '127.0.0.1', () => console.log('ServiceQ overview listening on loopback port 18881'));
