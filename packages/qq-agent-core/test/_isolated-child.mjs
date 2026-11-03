import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function runIsolatedChild(script, options = {}) {
  const child = spawnSync(process.execPath, [script], { ...options, timeout: 30000 });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `isolated plugin case terminated by ${child.signal}`);
  assert.equal(child.status, 0, `isolated plugin case exited with status ${child.status}`);
}
