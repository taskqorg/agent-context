import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryLock } from '../src/core.js';

test('tryLock holds live owners and reclaims dead or legacy locks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-lock-'));
  const lock = path.join(dir, 'x.lock');
  const release = tryLock(lock, 60000);
  assert.ok(release);
  assert.equal(tryLock(lock, 60000), null, 'live owner keeps the lock');
  release();
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const reclaimed = tryLock(lock, 60000);
  assert.ok(reclaimed, 'dead owner is reclaimed'); reclaimed();
  fs.mkdirSync(lock); const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const legacy = tryLock(lock, 60000);
  assert.ok(legacy, 'ownerless legacy lock is reclaimed after grace'); legacy();
  fs.mkdirSync(lock);
  assert.equal(tryLock(lock, 60000), null, 'fresh ownerless lock gets a grace period');
  fs.rmSync(dir, { recursive: true, force: true });
});
