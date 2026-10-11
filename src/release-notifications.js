import { approvedStableVersion } from './update.js';

// Public release metadata only; a notification never authorizes installation.
export function releaseNotifications({ check = approvedStableVersion, now = Date.now, waitMs = 25000 } = {}) {
  let current = null, checkedAt = -Infinity, pending;
  const waiters = new Set();
  const refresh = async () => {
    if (pending) return pending;
    if (now() - checkedAt < 10000) return;
    checkedAt = now();
    pending = (async () => {
      try {
        const next = await check();
        if (next !== current) { current = next; for (const wake of waiters) wake(); }
      } catch { /* Keep the last verified version; clients verify GitHub independently. */ }
    })();
    try { await pending; } finally { pending = null; }
  };
  const watch = async (since, signal) => {
    await refresh();
    if (current === since && !signal?.aborted) {
      if (waiters.size >= 256) return Response.json({ error: 'subscription_limit' }, { status: 503 });
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); signal?.removeEventListener('abort', wake); waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, waitMs);
        waiters.add(wake); signal?.addEventListener('abort', wake, { once: true });
      });
    }
    return Response.json({ version: current });
  };
  return { refresh, watch };
}
