import fs from 'node:fs';
import path from 'node:path';
import { root, home, sha, atomicWrite, acquireTransaction } from './core.js';
import { doctor } from './install.js';
import { checkPackage, rollbackUpdate, updateStatus } from './update.js';
import { ensureService, serviceHealth } from './service.js';
import { incidents, recordIncident } from './incidents.js';
import { compressionWarnings } from './conflicts.js';

export async function diagnose({ fix = false, live = false } = {}) {
  const actions = [];
  if (fix) {
    const state = updateStatus();
    if (state.managed) {
      try { const value = JSON.parse(fs.readFileSync(path.join(root(), 'active.json'))); checkPackage(value.dir, value.version); }
      catch {
        recordIncident({ component: 'updater', operation: 'integrity', category: 'runtime_integrity' });
        actions.push(await rollbackUpdate());
      }
    }
    const release = acquireTransaction();
    try {
      const pointerFile = path.join(root(), 'latest-install.json');
      if (fs.existsSync(pointerFile)) {
        const pointer = JSON.parse(fs.readFileSync(pointerFile));
        const base = path.resolve(root(), 'backups');
        const dir = path.resolve(pointer.dir);
        if (path.dirname(dir) !== base || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsupported repair journal');
        const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json')));
        const allowed = [path.join(home(), '.codex'), path.join(home(), '.claude'), path.join(home(), '.hermes'), root()];
        const pending = [];
        for (const item of journal.files || []) {
          if (fs.existsSync(item.file)) continue;
          const file = path.resolve(item.file);
          if (file !== path.join(home(), '.claude.json') && !allowed.some(prefix => file.startsWith(path.resolve(prefix) + path.sep))) throw new Error('Unsupported repair target');
          const backup = path.resolve(item.afterBackup || '');
          if (path.dirname(backup) !== dir || fs.lstatSync(backup).isSymbolicLink()) throw new Error('Unsupported repair backup');
          const bytes = fs.readFileSync(backup);
          if (sha(bytes) !== item.afterHash) throw new Error('Unsupported modified repair backup');
          let parent = path.dirname(file);
          while (parent !== path.dirname(parent)) {
            if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Unsupported symlink repair target');
            if (parent === path.resolve(home())) break;
            parent = path.dirname(parent);
          }
          pending.push({ file, bytes });
        }
        for (const { file, bytes } of pending) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          // Exclusive creation preserves a file the owner may have recreated after diagnosis.
          fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
          actions.push({ status: 'restored_missing_owned_file' });
        }
      }
    } finally { release(); }
  }
  const config = doctor();
  for (const issue of config.issues) recordIncident({ component: 'installer', operation: 'doctor', category: issue.startsWith('recipe_integrity') ? 'runtime_integrity' : issue === 'missing_key' || issue === 'key_conflict' ? issue : 'configuration_drift' });
  let installed = [];
  try { installed = JSON.parse(fs.readFileSync(path.join(root(), 'integration.json'))).agents; } catch {}
  const services = {};
  const warnings = compressionWarnings();
  for (const agent of installed || []) {
    if (fix) {
      try { actions.push({ agent, ...(await ensureService(agent)) }); }
      catch { actions.push({ agent, status: 'unresolved' }); }
    }
    if (live || fix) {
      const state = await serviceHealth(agent);
      services[agent] = state ? 'ready' : 'unavailable';
      if (state?.telemetry === false) warnings.push({ code: 'compression_telemetry_disabled', agent });
    }
  }
  return { ...config, warnings, services, incidents: incidents(), repairs: actions,
    healthy: config.healthy && Object.values(services).every(value => value === 'ready'),
    runtimeProof: live || fix ? 'owned_health_only_not_model_proof' : 'not_run' };
}
