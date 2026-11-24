import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from '../src/index.js';

test('every runtime export is declared in src/index.d.ts, and nothing extra', () => {
  const dts = readFileSync(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  const declared = new Set([...dts.matchAll(/^export (?:function|const|class) (\w+)/gm)].map((m) => m[1]));
  assert.deepEqual([...declared].sort(), Object.keys(api).sort());
});
