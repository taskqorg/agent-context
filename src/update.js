import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWrite, root, sha, version, acquireTransaction } from './core.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const repository = 'taskqorg/agent-context';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const launcher = () => path.join(root(), 'launcher.mjs');
const pointerFile = () => path.join(root(), 'active.json');
const stateFile = () => path.join(root(), 'updates.json');
const policyFile = () => path.join(root(), 'update-policy.json');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const fail = reason => { throw new Error(`Update refused: ${reason}`); };
export function checkPackage(dir, expected) {
  const manifest = read(path.join(dir, 'integrity.json'));
  const pkg = read(path.join(dir, 'package.json'));
  if (pkg?.name !== '@alexkirs/agent-context' || pkg.version !== expected || manifest?.version !== expected) fail('package identity');
  for (const [file, digest] of Object.entries(manifest.files || {})) {
    if (!/^(bin|src)\/[A-Za-z0-9._-]+$/.test(file) || !/^[a-f0-9]{64}$/.test(digest) || sha(fs.readFileSync(path.join(dir, file))) !== digest) fail('package integrity');
  }
  if (!manifest.files?.['bin/agent-context.js'] || !manifest.files?.['src/update.js']) fail('missing runtime');
}
function checkedPointer(value, integrity = true) {
  if (!value || !/^\d+\.\d+\.\d+$/.test(value.version)) fail('invalid runtime pointer');
  const dir = path.resolve(value.dir);
  const versions = path.resolve(root(), 'versions');
  if (path.dirname(dir) !== versions || fs.lstatSync(dir).isSymbolicLink()) fail('runtime path');
  if (integrity) checkPackage(dir, value.version);
  return value;
}
export function updateStatus() {
  const active = read(pointerFile());
  return { managed: Boolean(active), activeVersion: active?.version, previousVersion: active?.previous?.version, ...read(stateFile()), ...read(policyFile()) };
}
// The launcher stays fixed across compatible patch updates; active processes keep their imported modules.
const launcherCode = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
const base = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const active = JSON.parse(fs.readFileSync(path.join(base, 'active.json'), 'utf8'));
if (fs.lstatSync(active.dir).isSymbolicLink()) throw new Error('Invalid Agent Context runtime');
const dir = fs.realpathSync(active.dir);
if (path.dirname(dir) !== fs.realpathSync(path.join(base, 'versions'))) throw new Error('Invalid Agent Context runtime');
const bin = path.join(dir, 'bin', 'agent-context.js');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'integrity.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
if (pkg.name !== '@alexkirs/agent-context' || pkg.version !== active.version || manifest.version !== active.version || !manifest.files?.['bin/agent-context.js'] || !manifest.files?.['src/update.js']) throw new Error('Agent Context integrity failed');
for (const [file, digest] of Object.entries(manifest.files)) {
  if (!/^(bin|src)\\/[A-Za-z0-9._-]+$/.test(file) || crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex') !== digest) throw new Error('Agent Context integrity failed');
}
if (['mcp', 'hook'].includes(process.argv[2])) {
  const stateFile = path.join(base, 'updates.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  try { state = { ...state, ...JSON.parse(fs.readFileSync(path.join(base, 'update-policy.json'), 'utf8')) }; } catch {}
  if (state.enabled && Date.now() - (state.lastAttempt || 0) >= 86400000) {
    try {
      const child = spawn(process.execPath, [bin, 'update', '--automatic'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
      child.on('error', () => {}); child.unref();
    } catch {}
  }
}
await import(pathToFileURL(bin).href);
`;
export function seedRuntime() {
  const existing = read(pointerFile());
  if (existing) {
    checkedPointer(existing);
    if (fs.readFileSync(launcher(), 'utf8') !== launcherCode) fail('launcher drift');
    return existing;
  }
  checkPackage(source, version);
  const dir = path.join(root(), 'versions', `${version}-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['bin', 'src', 'scripts', 'test', 'node_modules', 'package.json', 'integrity.json']) fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
  checkPackage(dir, version);
  atomicWrite(launcher(), launcherCode);
  const active = { version, dir, previous: null };
  atomicWrite(pointerFile(), json(active));
  atomicWrite(stateFile(), json({ enabled: true, channel: 'stable', repository, lastAttempt: 0, status: 'ready' }));
  atomicWrite(policyFile(), json({ enabled: true }));
  return active;
}
function lock(operation) {
  let release;
  try { release = acquireTransaction(); }
  catch (error) { if (error.code === 'AGENT_CONTEXT_BUSY') return { status: 'busy' }; throw error; }
  return Promise.resolve().then(operation).finally(release);
}
async function download(url, limit, fetcher) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-context' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail(`HTTP ${response.status}`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) { total += chunk.length; if (total > limit) fail('download limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function releaseAsset(release, name) {
  const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) fail('missing asset digest');
  const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
  if (!asset.browser_download_url.startsWith(prefix) || asset.size > 10000000) fail('asset origin or size');
  return asset;
}
async function assetBytes(asset, fetcher) {
  const bytes = await download(asset.browser_download_url, 10000000, fetcher);
  if (`sha256:${sha(bytes)}` !== asset.digest || bytes.length !== asset.size) fail('archive digest');
  return bytes;
}
export function compatibleUpdate(current, next) {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(current), b = /^(\d+)\.(\d+)\.(\d+)$/.exec(next);
  return Boolean(a && b && a[1] === b[1] && a[2] === b[2] && Number(b[3]) > Number(a[3]));
}
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore', env: { ...process.env, SUPERCOMPRESS_API_KEY: '', AGENT_CONTEXT_HOME: path.join(cwd, 'isolated-home') } });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Update refused: self-test timeout')); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Update refused: installation or self-test failed')); });
  });
}
export async function prepare(archive, stage, expected) {
  // Invoke npm's JS entrypoint directly: no cmd window, shell quoting or package lifecycle scripts.
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'npm'))].filter(Boolean);
  const npm = candidates.map(file => { try { return fs.realpathSync(file); } catch { return ''; } }).find(file => file.endsWith('npm-cli.js'));
  if (!npm) fail('npm entrypoint unavailable');
  await run(process.execPath, [npm, 'install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', archive], stage);
  const dir = path.join(stage, 'node_modules', '@alexkirs', 'agent-context');
  for (const name of ['smol-toml', 'yaml']) fs.cpSync(path.join(stage, 'node_modules', name), path.join(dir, 'node_modules', name), { recursive: true });
  checkPackage(dir, expected);
  await run(process.execPath, ['scripts/integrity.js', '--check'], dir);
  await run(process.execPath, ['--test'], dir);
  return dir;
}
export async function update({ automatic = false, fetcher = fetch, preparer = prepare } = {}) {
  return lock(async () => {
    const active = checkedPointer(read(pointerFile()));
    const state = { ...read(stateFile()), ...read(policyFile()) };
    if (automatic && (!state.enabled || Date.now() - (state.lastAttempt || 0) < 86400000)) return { status: 'not_due' };
    const record = (status, extra = {}) => atomicWrite(stateFile(), json({ ...read(stateFile()), lastAttempt: Date.now(), status, ...extra }));
    record('checking');
    try {
      const release = JSON.parse(await download(`https://api.github.com/repos/${repository}/releases/latest`, 1000000, fetcher));
      if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) fail('unstable release');
      const next = release.tag_name.slice(1);
      if (next === active.version) { record('current'); return { status: 'current', version: next }; }
      if (!compatibleUpdate(active.version, next)) { record('migration_required'); return { status: 'migration_required', version: next }; }
      const recipe = JSON.parse(await assetBytes(releaseAsset(release, 'recipe.json'), fetcher));
      if (recipe.schema !== 1 || recipe.version !== next || recipe.launcherSchema !== 1 || recipe.adapterContract !== 1 || !recipe.platforms?.includes(process.platform) || !['codex', 'claude', 'hermes'].every(agent => recipe.clients?.includes(agent))) fail('release not qualified');
      const asset = releaseAsset(release, recipe.archive);
      if (recipe.sha256 !== asset.digest.slice(7)) fail('qualification digest');
      const bytes = await assetBytes(asset, fetcher);
      const stage = path.join(root(), 'versions', `stage-${crypto.randomUUID()}`);
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
      const archive = path.join(stage, 'candidate.tgz'); fs.writeFileSync(archive, bytes, { mode: 0o600 });
      const prepared = await preparer(archive, stage, next);
      checkPackage(prepared, next);
      const dir = path.join(root(), 'versions', `${next}-${crypto.randomUUID()}`);
      fs.renameSync(prepared, dir);
      if (JSON.stringify(read(pointerFile())) !== JSON.stringify(active)) fail('runtime changed during update');
      if (read(policyFile())?.enabled === false) { record('disabled_before_activation'); return { status: 'disabled_before_activation', activeVersion: active.version }; }
      atomicWrite(pointerFile(), json({ version: next, dir, previous: { version: active.version, dir: active.dir } }));
      record('updated', { activeVersion: next });
      return { status: 'updated', version: next, previous: active.version, reloadRequired: true };
    } catch (error) {
      if (error.message === 'Update refused: HTTP 404') { record('no_stable_release'); return { status: 'no_stable_release', activeVersion: active.version }; }
      const reason = /^Update refused: [A-Za-z0-9 :_-]+$/.test(error.message) ? error.message : 'Update failed; active runtime preserved';
      record('failed', { reason });
      return { status: 'failed', reason, activeVersion: active.version };
    }
  });
}
export async function rollbackUpdate() {
  return lock(() => {
    // Recovery must not execute or require integrity of the faulty selected version.
    const active = checkedPointer(read(pointerFile()), false);
    if (!active.previous) fail('no previous package');
    const previous = checkedPointer(active.previous);
    atomicWrite(pointerFile(), json({ ...previous, previous: null }));
    atomicWrite(stateFile(), json({ ...read(stateFile()), enabled: false, status: 'rolled_back', activeVersion: previous.version }));
    atomicWrite(policyFile(), json({ enabled: false }));
    return { status: 'rolled_back', version: previous.version, automaticUpdates: 'paused', reloadRequired: true };
  });
}
export function enableUpdates(enabled) {
  checkedPointer(read(pointerFile()));
  atomicWrite(policyFile(), json({ enabled }));
  return { enabled };
}
