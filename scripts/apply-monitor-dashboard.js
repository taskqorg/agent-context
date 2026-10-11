import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const definition = JSON.parse(fs.readFileSync(new URL('../dashboards/serviceq.json', import.meta.url)));
const config = JSON.parse(fs.readFileSync(process.env.AGENT_CONTEXT_LANGFUSE_CONFIG || path.join(os.homedir(), '.codex/langfuse.json')));
const env = { ...process.env, LANGFUSE_PUBLIC_KEY: config.public_key, LANGFUSE_SECRET_KEY: config.secret_key, LANGFUSE_HOST: config.base_url };
function api(resource, action, args = [], body) {
  let output;
  try { output = execFileSync('npx', ['--yes', 'langfuse-cli', 'api', resource, action, ...args, ...(body ? ['--body-json', JSON.stringify(body)] : []), '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }); } catch (error) { throw new Error('Dashboard API failed: ' + (JSON.parse(error.stdout || '{}').body?.message || 'request failed')); }
  const result = JSON.parse(output);
  if (result.status >= 300) throw new Error('Dashboard API rejected request: ' + result.status);
  return result.body;
}
const dashboards = api('unstable-dashboards', 'list', ['--limit', '100']);
const widgets = api('unstable-dashboard-widgets', 'list', ['--limit', '100']);
// Fail rather than duplicate names when this project's catalog outgrows one page.
if (dashboards.meta.totalPages > 1 || widgets.meta.totalPages > 1) throw new Error('Dashboard catalog requires pagination');
const dashboard = dashboards.data.find(d => d.name === definition.name) || api('unstable-dashboards', 'create', [], { name: definition.name, description: definition.description });
const existing = api('unstable-dashboards', 'get', [dashboard.id]);
for (const [index, spec] of definition.widgets.entries()) {
  const widget = widgets.data.find(w => w.name === spec.name) || api('unstable-dashboard-widgets', 'create', [], spec);
  if (widgets.data.some(w => w.id === widget.id)) api('unstable-dashboard-widgets', 'update', [widget.id], spec);
  if (!(existing.definition?.widgets || existing.definition?.placements || []).some(p => p.widgetId === widget.id)) {
    api('unstable-dashboards', 'add-placement', [dashboard.id], { id: 'serviceq-' + index, type: 'widget', widgetId: widget.id, x: index % 2 * 6, y: Math.floor(index / 2) * 6, width: 6, height: 6 });
  }
}
console.log(JSON.stringify({ dashboardId: dashboard.id, url: config.base_url + '/project/tight-hermes/dashboards/' + dashboard.id }));
