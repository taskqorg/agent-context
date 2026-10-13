import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {checkPackage} from '../src/update.js';
import {version} from '../src/core.js';

test('R6/R9 candidate manifest remains accepted by the frozen stable 0.4.15 path boundary', () => {
  const previous = JSON.parse(fs.readFileSync(new URL('./fixtures/stable-0.4.15-runtime-paths.json',import.meta.url)));
  const manifest = JSON.parse(fs.readFileSync(new URL('../integrity.json',import.meta.url)));
  for (const file of Object.keys(manifest.files)) assert.ok(/^(bin|src)\/[A-Za-z0-9._-]+$/.test(file)||previous.includes(file),'stable015 rejects '+file);
  assert.ok(manifest.files['src/serviceq-server.js'],'server logic must retain integrity protection');
  checkPackage(fileURLToPath(new URL('../',import.meta.url)), version);
});
