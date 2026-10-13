import fs from 'node:fs';
import http from 'node:http';
import { overview, reportFilters } from './serviceq-overview.js';
import { readServiceq } from './serviceq-reader.js';
const config = JSON.parse(fs.readFileSync(process.env.AGENT_CONTEXT_LANGFUSE_CONFIG));
const credentials = config.langfuse || config;
const base = new URL(credentials.base_url);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || !/^pk-lf-/.test(credentials.public_key) || !/^sk-lf-/.test(credentials.secret_key)) throw new Error('Invalid Langfuse configuration');
const auth = 'Basic ' + Buffer.from(credentials.public_key + ':' + credentials.secret_key).toString('base64');
const assets = new Map([['/serviceq', ['serviceq.html', 'text/html']], ['/serviceq/', ['serviceq.html', 'text/html']], ['/serviceq/app.js', ['serviceq-ui.js', 'text/javascript']], ['/serviceq/style.css', ['serviceq.css', 'text/css']]].map(([route, [file, type]]) => [route, { body: fs.readFileSync(new URL('./' + file, import.meta.url)), type }]));
const cache = new Map();
async function data(period, filters) {
  let previous = cache.get(period);
  if (!previous || Date.now() - previous.at >= 30000) {
    const now = Date.now();
    const promise = readServiceq(base, auth, now, period).then(sources => ({ sources, now })).catch(error => { cache.delete(period); throw error; });
    previous = { at: now, promise }; cache.set(period, previous);
  }
  const { sources, now } = await previous.promise;
  return overview(sources, now, period, filters);
}
function reportOptions(params) {
  const period = Number(params.get('period') || 1800), filters = reportFilters(params);
  if (![1800, 7200, 86400].includes(period)) throw new Error('Invalid report period');
  return { period, filters };
}
if (process.argv.includes('--report')) {
  const params = new URLSearchParams();
  for (const arg of process.argv.slice(2)) {
    if (arg === '--report') continue;
    if (!/^--[^=]+=.+$/.test(arg)) throw new Error('Use --report --period=86400 --host=mac/native --agent=codex --session=ID');
    const at = arg.indexOf('='); params.set(arg.slice(2, at), arg.slice(at + 1));
  }
  const { period, filters } = reportOptions(params);
  console.log(JSON.stringify(await data(period, filters)));
} else {
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
  let options;
  try { options = reportOptions(url.searchParams); }
  catch { res.writeHead(400).end(); return; }
  try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await data(options.period, options.filters))); }
  catch { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Не удалось получить данные из Langfuse. Состояние системы не подтверждено.' })); }
});
server.listen(18881, '127.0.0.1', () => console.log('ServiceQ overview listening on loopback port 18881'));

}
