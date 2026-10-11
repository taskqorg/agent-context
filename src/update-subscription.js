import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, root, version } from './core.js';
import { enrollment, gatewayURL } from './enrollment.js';
import { update, updateStatus } from './update.js';

export const releaseGateway = 'https://langfuse.ufobe.com/api/public/agent-context';
const stateFile = () => path.join(root(), 'update-subscription.json');
const save = value => atomicWrite(stateFile(), JSON.stringify(value));
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  if (signal.aborted) done();
});
export function updateSummary() {
  const state = updateStatus();
  let subscription = {}; try { subscription = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch {}
  const semver = value => /^\d+\.\d+\.\d+$/.test(value || '') ? value : undefined;
  return Object.fromEntries(Object.entries({
    enabled: state.enabled === true,
    installed: semver(state.activeVersion), available: semver(state.availableVersion), monitor: version,
    status: ['ready', 'checking', 'current', 'migration_required', 'paused', 'staged_wait', 'downloading', 'testing', 'downloaded', 'updated', 'failed', 'rolled_back', 'no_stable_release', 'disabled_before_activation'].includes(state.status) ? state.status : 'unknown',
    subscription: ['connected', 'reconnecting', 'disabled'].includes(subscription.status) ? subscription.status : 'unknown',
    ...(Number.isFinite(state.lastAttempt) ? { checkedAt: state.lastAttempt } : {})
  }).filter(([, value]) => value !== undefined));
}
export async function subscribeUpdates({ signal, request = fetch, apply = update, status = updateStatus, gateway = enrollment()?.gateway || releaseGateway, wait = pause } = {}) {
  gateway = gatewayURL(gateway);
  let since = null;
  while (!signal.aborted && fs.existsSync(root()) && !fs.existsSync(path.join(root(), 'uninstalling.json'))) {
    try {
      if (!status().managed || !status().enabled) {
        save({ status: 'disabled' }); await wait(60000, signal); continue;
      }
      // Hourly fallback runs even if the subscription route is offline.
      await apply({ automatic: true });
      const response = await request(gateway + '/v1/releases/watch' + (since ? '?since=' + encodeURIComponent(since) : ''), { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]) });
      if (!response.ok) throw new Error('Subscription unavailable');
      const body = await response.json();
      if (body.version !== null && !/^\d+\.\d+\.\d+$/.test(body.version || '')) throw new Error('Invalid release notification');
      save({ status: 'connected', at: Date.now() });
      if (body.version && body.version !== since) await apply({ automatic: true, notifiedVersion: body.version });
      since = body.version;
      // Avoid spinning if an intermediary returns immediately without holding the poll.
      await wait(1000, signal);
    } catch {
      if (!signal.aborted) { save({ status: 'reconnecting' }); await wait(30000, signal); }
    }
  }
}
