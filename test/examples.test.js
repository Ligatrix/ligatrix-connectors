import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('examples/run.mjs normalises every sample payload', () => {
  const out = execFileSync(process.execPath, ['examples/run.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /GitHub signature valid: true/);
  for (const heading of ['GitHub issue', 'GitHub issue comment', 'CRM deal', 'CRM contact', 'Helpdesk ticket',
    'Generic webhook (form submission)', 'CSV orders (3 imported, 1 rejected)']) {
    assert.ok(out.includes(`## ${heading}\n`), heading);
  }
  assert.match(out, /First delivery: processed\. Second delivery: duplicate\./);
});
