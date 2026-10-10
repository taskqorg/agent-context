import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import YAML from 'yaml';
import { root, home, sha, atomicWrite, acquireTransaction } from './core.js';
import { serviceHealth, stopService } from './service.js';
import { treeHash } from './install.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fail = message => { throw new Error(`Uninstall refused: ${message}`); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const execute = promisify(execFile);

async function removeGlobalPackage() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { timeout: 30000, windowsHide: true, shell: process.platform === 'win32' };
  let prefix;
  try { prefix = (await execute(npm, ['root', '-g'], options)).stdout.trim(); }
  catch { fail('npm unavailable; remove the global package after restoring npm'); }
  if (!path.isAbsolute(prefix)) fail('invalid global npm root');
  // NVM's global root may pass through its normal runtime-directory symlink.
  if (fs.existsSync(prefix)) prefix = fs.realpathSync(prefix);
  const dir = path.join(prefix, '@alexkirs', 'agent-context');
  if (!fs.existsSync(dir)) return 'absent';
  safePath(dir, new Set([path.resolve(dir)]));
  if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).name !== '@alexkirs/agent-context') fail('global package identity mismatch');
  try { await execute(npm, ['uninstall', '-g', '--ignore-scripts', '@alexkirs/agent-context'], options); }
  catch { fail('global npm removal failed; local recovery data retained'); }
  if (fs.existsSync(dir)) fail('global package still present');
  return 'removed';
}

// Reverse only the installer delta; owner edits to other keys survive.
export function undo(before, after, current) {
  if (equal(before, after) || equal(before, current)) return current;
  if (equal(after, current)) return before;
  if (object(after) && object(current) && (before === undefined || object(before))) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after)])) {
      const value = undo(before?.[key], after[key], current[key]);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return before === undefined && !Object.keys(result).length ? undefined : result;
  }
  if (Array.isArray(before || []) && Array.isArray(after) && Array.isArray(current)) {
    const removed = [...(before || [])], added = [];
    for (const item of after) {
      const index = removed.findIndex(value => equal(value, item));
      if (index < 0) added.push(item); else removed.splice(index, 1);
    }
    const result = [...current];
    for (const item of added) {
      const index = result.findIndex(value => equal(value, item));
      if (index >= 0) result.splice(index, 1);
    }
    for (const item of removed) if (!result.some(value => equal(value, item))) result.push(item);
    return before === undefined && !result.length ? undefined : result;
  }
  // An owner already removed our value; do not recreate a prior registration.
  if (current === undefined) return undefined;
  fail('an installed value was edited; reconcile it before removal');
}

function safePath(file, allowed) {
  const target = path.resolve(file);
  if (!allowed.has(target)) fail('journal target outside installed files');
  let current = target;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('symlink target');
    if (current === path.resolve(home())) break;
    current = path.dirname(current);
  }
  return target;
}

function reverseFile(file, before, after, current) {
  if (current === null || current.equals(before || Buffer.alloc(0))) return current;
  if (current.equals(after)) return before;
  const text = current.toString('utf8');
  if (/\.(?:json|toml|yaml)$/.test(file)) {
    const decode = value => value === null ? undefined : file.endsWith('.toml') ? parse(value.toString()) : file.endsWith('.yaml') ? YAML.parse(value.toString()) : JSON.parse(value.toString());
    const result = undo(decode(before), decode(after), decode(current));
    if (result === undefined) return null;
    // shortcut: drifted TOML/YAML is normalized; owner values and full-line comments survive.
    const comments = file.endsWith('.json') ? '' : text.split(/\r?\n/).filter(line => /^\s*#/.test(line)).join('\n');
    const value = file.endsWith('.toml') ? stringify(result) : file.endsWith('.yaml') ? YAML.stringify(result) : JSON.stringify(result, null, 2) + '\n';
    return Buffer.from((comments ? comments + '\n' : '') + value);
  }
  if (file.endsWith('.md')) {
    const marker = /<!-- agent-context:start -->[\s\S]*?<!-- agent-context:end -->/;
    const installed = after.toString().match(marker)?.[0];
    const original = before?.toString().match(marker)?.[0] || '';
    if (installed && text.includes(installed) && after.toString().replace(marker, '').trim() === (before?.toString() || '').replace(marker, '').trim()) {
      return Buffer.from(text.replace(installed, original));
    }
  }
  fail('installed file was edited; reconcile it before removal');
}

export function removalPlan() {
  const allowed = new Set(['.codex/config.toml', '.codex/hooks.json', '.codex/AGENTS.md', '.claude.json', '.claude/settings.json', '.claude/CLAUDE.md', '.hermes/config.yaml', '.hermes/AGENTS.md', '.hermes/plugins/agent-context/plugin.yaml', '.hermes/plugins/agent-context/__init__.py'].map(file => path.resolve(home(), file)));
  allowed.add(path.join(root(), 'integration.json'));
  safePath(root(), new Set([path.resolve(root())]));
  const base = path.join(root(), 'backups');
  const files = new Map(), moves = [];
  for (const name of (fs.existsSync(base) ? fs.readdirSync(base) : []).sort().reverse()) {
    const dir = path.join(base, name), journalFile = path.join(dir, 'journal.json');
    if (!fs.existsSync(journalFile)) continue;
    safePath(journalFile, new Set([journalFile]));
    const journal = JSON.parse(fs.readFileSync(journalFile));
    if (journal.status === 'rolled_back') continue;
    if (journal.status !== 'installed') fail('incomplete installation journal');
    for (const item of journal.files) {
      const file = safePath(item.file, allowed);
      if (file.startsWith(root() + path.sep)) continue;
      const backup = name => {
        if (!name) return null;
        if (path.dirname(path.resolve(name)) !== dir) fail('backup outside journal');
        safePath(name, new Set([path.resolve(name)]));
        return fs.readFileSync(name);
      };
      const before = backup(item.backup), after = backup(item.afterBackup);
      if ((before === null ? null : sha(before)) !== item.beforeHash || after && sha(after) !== item.afterHash) fail('backup integrity mismatch');
      const entry = files.get(file) || { file, initial: fs.existsSync(file) ? fs.readFileSync(file) : null };
      const current = files.has(file) ? entry.after : entry.initial;
      if (!after && current && sha(current) !== item.afterHash) fail('legacy journal has no delta for edited config');
      entry.after = reverseFile(file, before, after || current || Buffer.alloc(0), current);
      files.set(file, entry);
    }
    for (const move of journal.moves || []) {
      const from = safePath(move.from, new Set([path.join(home(), '.hermes/plugins/supercompress')]));
      if (path.dirname(path.resolve(move.to)) !== dir || fs.existsSync(from) || treeHash(move.to) !== move.hash) fail('migrated plugin drift');
      moves.push({ from, to: move.to, hash: move.hash });
    }
  }
  for (const entry of files.values()) {
    if (entry.after?.includes(Buffer.from(root())) || entry.after?.toString().includes('model_provider = "agent_context"')) fail('modified owned reference remains');
  }
  for (const file of allowed) {
    if (file.startsWith(root() + path.sep) || files.has(file) || !fs.existsSync(file)) continue;
    safePath(file, allowed);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(root()) || /model_provider\s*=\s*["']agent_context["']/.test(text) || text.includes('<!-- agent-context:start -->')) fail('owned registration has no restoration journal');
  }
  return { changes: [...files.values()].filter(item => !equal(item.initial, item.after)), moves };
}

export async function uninstall({ dryRun = false, removeGlobal = removeGlobalPackage } = {}) {
  if (!fs.existsSync(root())) return { status: 'already_removed', globalPackage: dryRun ? 'not_checked' : await removeGlobal() };
  const release = acquireTransaction();
  let removed = false;
  try {
    const { changes, moves } = removalPlan();
    const services = [];
    for (const agent of ['codex', 'claude', 'hermes']) {
      if (fs.existsSync(path.join(root(), 'services', agent + '.json.lock'))) fail('service startup in progress; wait for it to finish');
      const state = await serviceHealth(agent);
      if (state?.active) fail(`busy ${agent} service; close its active agent sessions first`);
      if (state) services.push(agent);
    }
    if (dryRun) return { status: 'preview', restore: changes.map(item => item.file), restoreMigratedPlugins: moves.map(item => item.from), stopServices: services, removeData: root(), sharedCredentials: 'preserved' };
    atomicWrite(path.join(root(), 'uninstalling.json'), '{}');
    for (const agent of ['codex', 'claude', 'hermes']) await stopService(agent);
    for (const item of changes) {
      const current = fs.existsSync(item.file) ? fs.readFileSync(item.file) : null;
      if (!equal(current, item.initial)) fail('configuration changed during removal');
    }
    const written = [], moved = [];
    let globalPackage;
    try {
      for (const item of changes) {
        const current = fs.existsSync(item.file) ? fs.readFileSync(item.file) : null;
        if (!equal(current, item.initial)) fail('configuration changed during removal');
        if (item.after === null) fs.rmSync(item.file, { force: true }); else atomicWrite(item.file, item.after);
        written.push(item);
      }
      for (const move of moves) {
        if (fs.existsSync(move.from) || treeHash(move.to) !== move.hash) fail('plugin changed during removal');
        fs.renameSync(move.to, move.from);
        moved.push(move);
      }
      globalPackage = await removeGlobal();
    } catch (error) {
      for (const move of moved.reverse()) fs.renameSync(move.from, move.to);
      for (const item of written.reverse()) {
        const current = fs.existsSync(item.file) ? fs.readFileSync(item.file) : null;
        if (!equal(current, item.after)) continue;
        if (item.initial === null) fs.rmSync(item.file, { force: true }); else atomicWrite(item.file, item.initial);
      }
      throw error;
    }
    const plugin = path.join(home(), '.hermes/plugins/agent-context');
    // Python may have generated bytecode for our removed bootstrap.
    if (fs.existsSync(plugin) && !fs.existsSync(path.join(plugin, '__init__.py'))) {
      fs.rmSync(path.join(plugin, '__pycache__'), { recursive: true, force: true });
      if (!fs.readdirSync(plugin).length) fs.rmdirSync(plugin);
    }
    release();
    fs.rmSync(root(), { recursive: true });
    removed = true;
    return { status: 'removed', restored: changes.map(item => item.file), globalPackage, sharedCredentials: 'preserved', reloadRequired: true };
  } finally {
    if (!removed && fs.existsSync(path.join(root(), 'install.lock'))) release();
    if (!removed) fs.rmSync(path.join(root(), 'uninstalling.json'), { force: true });
  }
}
