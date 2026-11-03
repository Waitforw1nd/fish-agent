import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIsolatedChild } from './_isolated-child.mjs';

const harness = new URL('./_harness.mjs', import.meta.url).href;
function run(body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { createChecker } from ${JSON.stringify(harness)}; const c = createChecker('report'); ${body}; c.finish();`],
  { encoding: 'utf8' });
}

test('checker reports skipped checks without counting them as passes', () => {
  const result = run("await c.check('skipped', () => c.skip('skipped', 'fixture')); c.ok('executed')");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /通过 1，失败 0，已知缺陷 0，跳过 1/);
  assert.doesNotMatch(result.stdout, /全部通过 ✅/);
});

test('checker makes known defects and ordinary failures nonzero', () => {
  for (const body of ["await c.known('known', () => { throw new Error('broken'); })", "c.bad('failed', 'broken')"]) {
    const result = run(body);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /全部通过 ✅/);
  }
  const repaired = run("await c.known('known', () => {})");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /通过 1，失败 0，已知缺陷 0，跳过 0/);
});

test('isolated plugin child must succeed even after producing its trace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-child-status-'));
  try {
    const trace = path.join(dir, 'trace.txt');
    const script = path.join(dir, 'case.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(trace)}, 'setup\\nactivate\\n'); process.exit(7);`);
    assert.throws(() => runIsolatedChild(script, { stdio: 'ignore' }), /exited with status 7/);
    assert.equal(fs.readFileSync(trace, 'utf8'), 'setup\nactivate\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
