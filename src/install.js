import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import YAML from 'yaml';
import { atomicWrite, home, root, sha, keyStatus, version } from './core.js';
import { launcher, seedRuntime, updateStatus } from './update.js';

export const bin = launcher;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const agentNames = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' };
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const ownedCommand = hook => /(?:supercompress(?:-proxy)?[\\/]|(?:agent-context\.js|launcher\.mjs)["']?\s+(?:hook|mcp)\b)/i.test(`${hook.command || ''} ${hook.commandWindows || ''}`);
export function stripHooks(value) {
  for (const [event, rules] of Object.entries(value.hooks || {})) {
    if (!Array.isArray(rules)) throw new Error(`Unsupported hook shape: ${event}`);
    value.hooks[event] = rules.map(rule => ({ ...rule, hooks: rule.hooks.filter(hook => !ownedCommand(hook)) })).filter(rule => rule.hooks.length);
  }
  return value;
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function treeHash(dir) {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsupported legacy plugin symlink; preserve and reconcile it first');
  const rows = [];
  function visit(current, prefix = '') {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file), relative = `${prefix}${name}`;
      if (stat.isSymbolicLink()) throw new Error('Unsupported legacy plugin symlink; preserve and reconcile it first');
      if (stat.isDirectory()) visit(file, `${relative}/`);
      else if (stat.isFile()) rows.push([relative, sha(fs.readFileSync(file))]);
      else throw new Error('Unsupported legacy plugin file type');
    }
  }
  visit(dir);
  return sha(JSON.stringify(rows));
}
export function instructions(raw, agent) {
  const withoutOld = raw.split(/(?=^# )/m).filter(section => !/^# SuperCompress\b/.test(section)).join('')
    .replace(/<!-- agent-context:start -->[\s\S]*?<!-- agent-context:end -->\s*/g, '').trimEnd();
  const rule = agent === 'claude'
    ? 'Bash stdout is already handled by the Agent Context hook. Do not recompress it through MCP. Use compress_context only for other new bulky context.'
    : 'Use MCP compress_context once for new bulky context when useful. This does not intercept or replace every model request; do not claim total token savings without measurements.';
  return `${withoutOld}\n\n<!-- agent-context:start -->\n# Agent Context\n${rule}\nNever compress the user query. Prefer the returned new context; do not read an unrelated global inbox or replay session history. On skipped/failure retain original context; already_seen means no new digest. Keep normal agent login. Run agent-context doctor for configuration checks.\n<!-- agent-context:end -->\n`;
}
function objectAt(file) { const raw = read(file); return raw ? JSON.parse(raw) : {}; }
function entry(agent) { return { command: process.execPath, args: [bin(), 'mcp', agent], env: { SUPERCOMPRESS_AGENT_NAME: agentNames[agent] } }; }
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, semantic(value[key])]));
  return value;
}
export function codexConfig(raw) {
  const original = parseToml(raw);
  const desired = structuredClone(original);
  desired.mcp_servers ||= {};
  desired.mcp_servers.supercompress = entry('codex');
  // Preserve all other TOML bytes. Refuse inline/ambiguous layouts instead of reserializing the user's config.
  const after = raw.split(/(?=^\s*\[)/m).filter(section => {
    const header = /^\s*\[([^\]\r\n]+)\]/.exec(section);
    if (!header) return true;
    const parts = header[1].split('.').map(part => part.trim().replace(/^['"]|['"]$/g, ''));
    return !(parts[0] === 'mcp_servers' && parts[1] === 'supercompress');
  }).join('').trimEnd() + '\n\n' + stringifyToml({ mcp_servers: { supercompress: entry('codex') } });
  if (JSON.stringify(semantic(parseToml(after))) !== JSON.stringify(semantic(desired))) throw new Error('Unsupported Codex TOML layout; no configuration changed');
  return after;
}

export function planInstall(agents) {
  const changes = [];
  const moves = [];
  const add = (file, after) => { if (read(file) !== after) changes.push({ file, after }); };
  const installed = [], absent = [];
  for (const agent of new Set(agents)) {
    if (!Object.hasOwn(agentNames, agent)) throw new Error(`Unknown agent: ${agent}`);
    const agentDir = path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`);
    if (!fs.existsSync(agentDir)) { absent.push(agent); continue; }
    if (agent === 'codex') {
      add(path.join(agentDir, 'config.toml'), codexConfig(read(path.join(agentDir, 'config.toml'))));
      const hooksFile = path.join(agentDir, 'hooks.json');
      if (fs.existsSync(hooksFile)) add(hooksFile, json(stripHooks(objectAt(hooksFile))));
    } else if (agent === 'claude') {
      const mcpFile = path.join(home(), '.claude.json');
      const mcp = objectAt(mcpFile);
      mcp.mcpServers ||= {};
      mcp.mcpServers.supercompress = entry(agent);
      add(mcpFile, json(mcp));
      const hooksFile = path.join(agentDir, 'settings.json');
      const settings = stripHooks(objectAt(hooksFile));
      settings.hooks ||= {};
      settings.hooks.PostToolUse ||= [];
      const command = `"${process.execPath}" "${bin()}" hook claude`;
      settings.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 360 }] });
      add(hooksFile, json(settings));
    } else {
      const file = path.join(agentDir, 'config.yaml');
      const raw = read(file);
      const doc = YAML.parseDocument(raw);
      if (doc.errors.length) throw new Error('Invalid Hermes YAML; no configuration changed');
      const hooks = doc.get('hooks')?.toJSON?.() || {};
      for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list)) {
          if (/supercompress/i.test(JSON.stringify(list))) throw new Error('Unsupported Hermes legacy hook shape; preserve and reconcile it first');
          continue;
        }
        doc.setIn(['hooks', event], list.filter(hook => !ownedCommand(hook)));
      }
      const plugin = path.join(agentDir, 'plugins', 'supercompress');
      if (fs.existsSync(plugin)) moves.push({ from: plugin, hash: treeHash(plugin) });
      doc.setIn(['mcp_servers', 'supercompress'], { ...entry(agent), enabled: true, timeout: 30, connect_timeout: 15 });
      add(file, doc.toString());
    }
    const instructionFile = path.join(agentDir, agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
    add(instructionFile, instructions(read(instructionFile), agent));
    installed.push(agent);
  }
  return { changes, moves, installed, absent };
}

function transaction(operation) {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const lock = path.join(root(), 'install.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Configuration transaction busy; inspect existing installation before retrying'); throw error; }
  try { return operation(); }
  finally { fs.rmdirSync(lock); }
}
export const install = agents => transaction(() => applyInstall(agents));
function applyInstall(agents) {
  seedRuntime();
  const plan = planInstall(agents);
  if (!plan.changes.length && !plan.moves.length) return { ...plan, changes: [], transaction: null };
  const id = `${Date.now()}-${process.pid}`;
  const dir = path.join(root(), 'backups', id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal = { recipe: version, id, status: 'prepared', files: [], moves: plan.moves.map((move, index) => ({ ...move, to: path.join(dir, `legacy-plugin-${index}`) })) };
  for (const [index, change] of plan.changes.entries()) {
    const before = fs.existsSync(change.file) ? fs.readFileSync(change.file) : null;
    const backup = before === null ? null : path.join(dir, `${index}.before`);
    if (backup) fs.writeFileSync(backup, before, { mode: 0o600 });
    journal.files.push({ file: change.file, backup, beforeHash: before === null ? null : sha(before), afterHash: sha(change.after) });
  }
  const journalFile = path.join(dir, 'journal.json');
  atomicWrite(journalFile, json(journal));
  // Check the full plan before changing anything, then recheck each file immediately before writing.
  function unchanged(item) { return (fs.existsSync(item.file) ? sha(fs.readFileSync(item.file)) : null) === item.beforeHash; }
  if (!journal.files.every(unchanged)) throw new Error('Configuration changed during planning; installation stopped');
  const written = [];
  const moved = [];
  try {
    for (const move of journal.moves) {
      if (treeHash(move.from) !== move.hash) throw new Error('Configuration changed during plugin migration');
      fs.renameSync(move.from, move.to);
      moved.push(move);
    }
    for (const [index, change] of plan.changes.entries()) {
      if (!unchanged(journal.files[index])) throw new Error('Configuration changed during installation');
      atomicWrite(change.file, change.after);
      written.push(journal.files[index]);
    }
    journal.status = 'installed';
    atomicWrite(journalFile, json(journal));
    atomicWrite(path.join(root(), 'latest-install.json'), json({ id, dir }));
  } catch (error) {
    for (const item of written.reverse()) {
      if (sha(fs.readFileSync(item.file)) !== item.afterHash) continue;
      if (item.backup) atomicWrite(item.file, fs.readFileSync(item.backup));
      else fs.unlinkSync(item.file);
    }
    for (const move of moved.reverse()) if (!fs.existsSync(move.from) && treeHash(move.to) === move.hash) fs.renameSync(move.to, move.from);
    throw error;
  }
  return { installed: plan.installed, absent: plan.absent, changed: plan.changes.map(change => change.file), legacyPluginsPreserved: journal.moves.length, transaction: id, reloadRequired: true };
}

export const rollback = () => transaction(applyRollback);
function applyRollback() {
  const pointer = JSON.parse(read(path.join(root(), 'latest-install.json')));
  const journalFile = path.join(pointer.dir, 'journal.json');
  const journal = JSON.parse(read(journalFile));
  if (journal.status === 'rolled_back') return { transaction: journal.id, status: 'already_rolled_back' };
  for (const item of journal.files) {
    if (!fs.existsSync(item.file) || sha(fs.readFileSync(item.file)) !== item.afterHash) throw new Error(`Rollback refused: config drift at ${item.file}; preserve and reconcile it first`);
    if (item.backup && sha(fs.readFileSync(item.backup)) !== item.beforeHash) throw new Error('Rollback refused: backup integrity mismatch');
  }
  for (const move of journal.moves || []) {
    if (fs.existsSync(move.from) || !fs.existsSync(move.to) || treeHash(move.to) !== move.hash) throw new Error('Rollback refused: legacy plugin drift; preserve and reconcile it first');
  }
  for (const item of journal.files) {
    if (item.backup) atomicWrite(item.file, fs.readFileSync(item.backup));
    else fs.unlinkSync(item.file);
  }
  for (const move of journal.moves || []) fs.renameSync(move.to, move.from);
  journal.status = 'rolled_back';
  atomicWrite(journalFile, json(journal));
  return { transaction: journal.id, status: 'rolled_back', reloadRequired: true };
}

export function connectionFor(agent) {
  const dir = path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`);
  if (agent === 'codex') return parseToml(read(path.join(dir, 'config.toml'))).mcp_servers?.supercompress;
  if (agent === 'claude') return objectAt(path.join(home(), '.claude.json')).mcpServers?.supercompress;
  if (agent === 'hermes') return YAML.parse(read(path.join(dir, 'config.yaml')))?.mcp_servers?.supercompress;
  throw new Error(`Unknown agent: ${agent}`);
}
export function doctor() {
  const credentials = keyStatus();
  const issues = [];
  if (!credentials.present) issues.push(credentials.error || 'missing_key');
  if (credentials.conflict) issues.push('key_conflict');
  const agents = {};
  for (const agent of Object.keys(agentNames)) {
    const dir = path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`);
    if (!fs.existsSync(dir)) { agents[agent] = 'absent'; continue; }
    try {
      const connection = connectionFor(agent);
      agents[agent] = connection?.command === process.execPath && connection?.args?.[0] === bin() && connection?.args?.[1] === 'mcp' && connection?.args?.[2] === agent ? 'configured' : 'not_configured';
      if (agents[agent] !== 'configured') issues.push(`${agent}:not_configured`);
      if (agent !== 'hermes') {
        const hooksFile = path.join(dir, agent === 'claude' ? 'settings.json' : 'hooks.json');
        const hooks = objectAt(hooksFile).hooks || {};
        const list = Object.values(hooks).flatMap(rules => rules.flatMap(rule => rule.hooks));
        if (list.some(hook => ownedCommand(hook) && !`${hook.command} ${hook.commandWindows}`.includes(bin()))) issues.push(`${agent}:legacy_hook`);
        if (agent === 'claude' && list.filter(hook => `${hook.command}`.includes(bin())).length !== 1) issues.push('claude:hook_count');
      } else if (fs.existsSync(path.join(dir, 'plugins', 'supercompress')) || /supercompress/i.test(JSON.stringify(YAML.parse(read(path.join(dir, 'config.yaml')))?.hooks || {}))) issues.push('hermes:legacy_plugin_or_hook');
    } catch { agents[agent] = 'invalid_config'; issues.push(`${agent}:invalid_config`); }
  }
  const stateDir = path.join(root(), 'state');
  const locks = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter(name => name.endsWith('.lock')).length : 0;
  if (locks) issues.push('session_locks_present');
  if (fs.existsSync(path.join(root(), 'install.lock'))) issues.push('installation_lock_present');
  // Project overrides are reported, never rewritten by global installation.
  const canonical = file => {
    const resolved = fs.realpathSync(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const isUserHome = canonical(process.cwd()) === canonical(home());
  const overrides = (isUserHome ? [] : ['.mcp.json', '.codex/config.toml', '.claude/settings.local.json', '.claude/settings.json']).filter(name => {
    const file = path.join(process.cwd(), name);
    return fs.existsSync(file) && /supercompress|agent-context/i.test(read(file));
  });
  if (overrides.length) issues.push('project_compression_override');
  let integrity = 'missing';
  try {
    const manifest = JSON.parse(read(path.join(packageRoot, 'integrity.json')));
    integrity = Object.entries(manifest.files).every(([file, digest]) => sha(fs.readFileSync(path.join(packageRoot, file))) === digest) ? 'verified' : 'modified';
  } catch {}
  if (integrity !== 'verified') issues.push(`recipe_integrity:${integrity}`);
  return { version, node: process.version, platform: process.platform, integrity, agents, updates: updateStatus(), keyPresent: credentials.present, keyConflict: credentials.conflict, locks, projectOverrides: overrides, issues, healthy: !issues.length, runtimeProof: 'not_run' };
}
