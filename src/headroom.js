import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, sha, atomicWrite } from './core.js';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
export async function prepareHeadroom(run = execute) {
  const project = path.join(source, 'integrations', 'headroom');
  const files = ['pyproject.toml', 'agent_context_headroom/__init__.py', 'agent_context_headroom/proxy.py', 'agent_context_headroom/observability.py', 'agent_context_headroom/request_context.py'];
  const recipe = sha(files.map(file => fs.readFileSync(path.join(project, file))).join('\0')).slice(0, 16);
  const dir = path.join(root(), 'headroom', recipe);
  const python = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const headroom = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/headroom.exe' : 'bin/headroom');
  const ready = path.join(dir, 'ready.json');
  if (fs.existsSync(ready) && fs.existsSync(python) && fs.existsSync(headroom)) return { python, headroom, recipe, reused: true };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'prepare.lock');
  try { fs.mkdirSync(lock); } catch { throw new Error('Headroom preparation already running'); }
  try {
  const candidates = process.env.AGENT_CONTEXT_PYTHON ? [[process.env.AGENT_CONTEXT_PYTHON]]
    : [...(process.platform === 'win32' ? [['py', '-3.13'], ['py', '-3.12']] : []), ['python3.13'], ['python3.12'], ['python3'], ['python']];
  let interpreter;
  for (const candidate of candidates) {
    try {
      await run(candidate[0], [...candidate.slice(1), '-c', 'import sys; assert (3,11) <= sys.version_info[:2] < (3,14)'], { timeout: 10000, windowsHide: true });
      interpreter = candidate; break;
    } catch { /* Try another installed interpreter; never alter the system Python. */ }
  }
  if (!interpreter) throw new Error('Headroom requires an installed Python 3.11–3.13; set AGENT_CONTEXT_PYTHON to its executable');
  await run(interpreter[0], [...interpreter.slice(1), '-m', 'venv', path.join(dir, 'venv')], { timeout: 60000, windowsHide: true });
  await run(python, ['-m', 'pip', 'install', project], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  await run(python, ['-c', 'import importlib.metadata as m; assert m.version("headroom-ai") == "0.40.0"; from headroom.transforms.compressor_registry import CompressorRegistry; r=CompressorRegistry(); r.discover(); assert r.get("supercompress") is not None'], { timeout: 30000, windowsHide: true });
  atomicWrite(ready, JSON.stringify({ recipe, headroom: '0.40.0' }));
  return { python, headroom, recipe, reused: false };
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export async function qualifyHeadroom(args, run = execute) {
  if (args.some(arg => !['--approve-retrieval-test-tool', '--approve-fixture-test-tool', '--agent', 'codex', 'claude', '--fixture', 'routine', 'error', 'code', '--protocol', 'ws', 'http', '--source', 'shell', 'mcp', 'retrieval'].includes(arg))) throw new Error('Usage: agent-context headroom qualify [--source shell|mcp|retrieval] [--protocol ws|http] [--approve-retrieval-test-tool]');
  const runtime = await prepareHeadroom(run);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-qualification-'));
  const result = await run(runtime.python, [path.join(source, 'scripts', 'headroom-qualify.py'), '--headroom', runtime.headroom, '--cwd', work, ...args], {
    timeout: 170000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, AGENT_CONTEXT_NODE: process.execPath },
  });
  return { ...runtime, evidenceDir: work, result: result.stdout.trim() };
}
