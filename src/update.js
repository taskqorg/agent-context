import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { atomicWrite, root, home, sha, version, acquireTransaction } from './core.js';

export const extraRuntimeFiles = ['integrations/hermes/agent-context/plugin.yaml', 'integrations/hermes/agent-context/__init__.py', 'integrations/headroom/pyproject.toml', 'integrations/headroom/agent_context_headroom/__init__.py', 'integrations/headroom/agent_context_headroom/proxy.py', 'integrations/headroom/agent_context_headroom/observability.py', 'integrations/headroom/agent_context_headroom/request_context.py', 'integrations/headroom/agent_context_headroom/collector.py', 'scripts/headroom-benchmark.py', 'scripts/headroom-claude.py', 'scripts/headroom-hermes.py', 'scripts/headroom-live.py', 'scripts/headroom-qualify.py', 'scripts/headroom-fixture.js'];
const source = fileURLToPath(new URL('../', import.meta.url));
const repository = 'taskqorg/agent-context';
// Reviewed 0.1.6 bootstrap, also installed over legacy 0.1.3 on Windows.
const hardenedLegacyLauncher = '58010bbde95c55e4c04f3c11ebe26497ef5b024f0d09193625203ce66125d51c';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
// Ed25519 public key (SPKI PEM) for recipe.json.sig; unsigned or mis-signed releases are refused.
// Private key: owner-held (scripts/sign-recipe.js), never in this repository.
export const releasePublicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6fkOsxlO3Eqbsqa3cmZpzAUFTPNr8uOkMyZ9d9Rsyg8=\n-----END PUBLIC KEY-----\n';
export function verifyRecipeSignature(bytes, signature, publicKey = releasePublicKey) {
  if (!publicKey) return true;
  if (!signature?.length) return false;
  try { return crypto.verify(null, bytes, crypto.createPublicKey(publicKey), signature); } catch { return false; }
}
// Staged rollout: stable bucket 0..99 per machine; a release reaches a machine once its bucket < rolloutPercent.
export function rolloutBucket() {
  let id = '';
  try { id = JSON.parse(fs.readFileSync(path.join(root(), 'machine-id.json'), 'utf8')).id || ''; } catch {}
  return parseInt(sha(`rollout\0${id}`).slice(0, 8), 16) % 100;
}
const RETRY_BACKOFF_MS = [3600000, 6 * 3600000, 86400000];
function prune(keep) {
  // Keep active + previous runtime; staging leftovers and older versions only consume disk.
  const versions = path.join(root(), 'versions');
  const kept = new Set(keep.filter(Boolean).map(dir => path.resolve(dir)));
  try { for (const name of fs.readdirSync(versions)) { const dir = path.resolve(versions, name); if (!kept.has(dir)) fs.rmSync(dir, { recursive: true, force: true }); } } catch {}
}
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
    if ((!/^(bin|src)\/[A-Za-z0-9._-]+$/.test(file) && !extraRuntimeFiles.includes(file)) || !/^[a-f0-9]{64}$/.test(digest) || sha(fs.readFileSync(path.join(dir, file))) !== digest) fail('package integrity');
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
  if ((!/^(bin|src)\\/[A-Za-z0-9._-]+$/.test(file) && !${JSON.stringify(extraRuntimeFiles)}.includes(file)) || crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex') !== digest) throw new Error('Agent Context integrity failed');
}
if (['mcp', 'hook', 'lifecycle', 'run', 'retrieval'].includes(process.argv[2])) {
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
export function seedRuntime({ migrate = false } = {}) {
  const existing = read(pointerFile());
  if (existing) {
    checkedPointer(existing);
    if (existing.version === version) {
      if (fs.readFileSync(launcher(), 'utf8') !== launcherCode) fail('launcher drift');
      return existing;
    }
    if (!compatibleUpdate(existing.version, version) && !(migrate === true && version.localeCompare(existing.version, 'en', { numeric: true }) > 0)) fail('local installation requires migration; use reviewed setup --migrate');
    // The verified previous installer knows its own exact bootstrap, including older schemas.
    const module = pathToFileURL(path.join(existing.dir, 'src/update.js')).href;
    if (sha(fs.readFileSync(launcher())) !== hardenedLegacyLauncher) {
      execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(module)}); m.seedRuntime();`], { timeout: 30000, stdio: 'ignore', windowsHide: true });
    }
  }
  checkPackage(source, version);
  const dir = path.join(root(), 'versions', `${version}-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ['bin', 'src', 'scripts', 'test', 'package.json', 'integrity.json', 'integrations']) fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
  for (const name of ['smol-toml', 'yaml']) {
    let dependency = path.dirname(fileURLToPath(import.meta.resolve(name)));
    while (!fs.existsSync(path.join(dependency, 'package.json')) && path.dirname(dependency) !== dependency) dependency = path.dirname(dependency);
    if (read(path.join(dependency, 'package.json'))?.name !== name) fail('dependency identity');
    fs.cpSync(dependency, path.join(dir, 'node_modules', name), { recursive: true });
  }
  checkPackage(dir, version);
  atomicWrite(launcher(), launcherCode);
  const active = { version, dir, previous: existing ? { version: existing.version, dir: existing.dir } : null };
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
async function run(command, args, cwd, { timeout = 120000, environment = {} } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore', env: { ...process.env, SUPERCOMPRESS_API_KEY: '', AGENT_CONTEXT_HOME: path.join(cwd, 'isolated-home'), ...environment } });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Update refused: self-test timeout')); }, timeout);
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
  if (fs.existsSync(path.join(dir, 'src/headroom.js'))) {
    const code = `const {prepareHeadroom,pythonEnvironment}=await import('./src/headroom.js');const r=await prepareHeadroom();const {spawnSync}=await import('node:child_process');for(const folder of ['headroom','hermes']){const x=spawnSync(r.python,['-m','unittest','discover','-s','integrations/'+folder,'-p',folder==='headroom'?'test_adapter.py':'test_plugin.py'],{env:{...pythonEnvironment(),PYTHONPATH:'integrations/headroom'},stdio:'ignore',timeout:30000});if(x.status!==0)process.exit(1);}`;
    await run(process.execPath, ['--input-type=module', '-e', code], dir, { timeout: 240000, environment: { AGENT_CONTEXT_HOME: home(), HEADROOM_STATELESS: 'true', HEADROOM_OFFLINE: '1', AGENT_CONTEXT_LANGFUSE: '0' } });
  }
  return dir;
}
export async function update({ automatic = false, fetcher = fetch, preparer = prepare, publicKey = releasePublicKey } = {}) {
  return lock(async () => {
    const active = checkedPointer(read(pointerFile()));
    const state = { ...read(stateFile()), ...read(policyFile()) };
    if (automatic && (!state.enabled || Date.now() - (state.lastAttempt || 0) < 86400000)) return { status: 'not_due' };
    const record = (status, extra = {}) => atomicWrite(stateFile(), json({ ...read(stateFile()), lastAttempt: Date.now(), status, failures: 0, ...extra }));
    // The fixed launcher retries 24h after lastAttempt; back-date it so failures retry after 1h, 6h, then 24h.
    const failed = (reason) => {
      const failures = (read(stateFile())?.failures || 0) + 1;
      const wait = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1];
      atomicWrite(stateFile(), json({ ...read(stateFile()), lastAttempt: Date.now() - 86400000 + wait, status: 'failed', reason, failures }));
    };
    const failures = read(stateFile())?.failures || 0;
    record('checking', { failures });
    let stage;
    try {
      const release = JSON.parse(await download(`https://api.github.com/repos/${repository}/releases/latest`, 1000000, fetcher));
      if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) fail('unstable release');
      const next = release.tag_name.slice(1);
      if (next === active.version) { record('current'); return { status: 'current', version: next }; }
      if (!compatibleUpdate(active.version, next)) { record('migration_required'); return { status: 'migration_required', version: next }; }
      const recipeBytes = await assetBytes(releaseAsset(release, 'recipe.json'), fetcher);
      if (publicKey) {
        const signature = Buffer.from((await assetBytes(releaseAsset(release, 'recipe.json.sig'), fetcher)).toString('utf8').trim(), 'base64');
        if (!verifyRecipeSignature(recipeBytes, signature, publicKey)) fail('recipe signature');
      }
      const recipe = JSON.parse(recipeBytes);
      // Kill switch and staged rollout are recipe fields, so they are covered by the same digest/signature.
      if (recipe.paused === true) { record('paused', { version: next }); return { status: 'paused', version: next }; }
      const percent = Number.isInteger(recipe.rolloutPercent) ? recipe.rolloutPercent : 100;
      if (rolloutBucket() >= percent) { record('staged_wait', { version: next }); return { status: 'staged_wait', version: next, rolloutPercent: percent }; }
      if (recipe.schema !== 1 || recipe.version !== next || recipe.launcherSchema !== 1 || recipe.adapterContract !== 1 || !recipe.platforms?.includes(process.platform) || !['codex', 'claude', 'hermes'].every(agent => recipe.clients?.includes(agent))) fail('release not qualified');
      const asset = releaseAsset(release, recipe.archive);
      if (recipe.sha256 !== asset.digest.slice(7)) fail('qualification digest');
      const bytes = await assetBytes(asset, fetcher);
      stage = path.join(root(), 'versions', `stage-${crypto.randomUUID()}`);
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
      prune([dir, active.dir]);
      return { status: 'updated', version: next, previous: active.version, reloadRequired: true };
    } catch (error) {
      if (error.message === 'Update refused: HTTP 404') { record('no_stable_release'); return { status: 'no_stable_release', activeVersion: active.version }; }
      const reason = /^Update refused: [A-Za-z0-9 :_-]+$/.test(error.message) ? error.message : 'Update failed; active runtime preserved';
      failed(reason);
      return { status: 'failed', reason, activeVersion: active.version };
    } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
  });
}
export async function rollbackUpdate() {
  return lock(async () => {
    // Recovery must not execute or require integrity of the faulty selected version.
    const active = checkedPointer(read(pointerFile()), false);
    if (!active.previous) fail('no previous package');
    const previous = checkedPointer(active.previous);
    const integration = read(path.join(root(), 'integration.json'));
    const oldManifest = read(path.join(previous.dir, 'integrity.json'));
    if (integration?.mode === 'automatic' && !oldManifest?.files?.['src/automatic.js']) {
      const install = read(path.join(root(), 'latest-install.json'));
      const journal = install && read(path.join(install.dir, 'journal.json'));
      if (journal?.recipe !== active.version) fail('configuration migration rollback needs its original journal');
      const { applyRollback } = await import('./install.js');
      applyRollback();
    }
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
