import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/acceptance-cloud.mjs', import.meta.url));
test('isolated cloud check exercises the desktop chain and removes its data', { timeout: 45000 }, async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--check'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CHECK PASS: client pair, three ack\/replies, two-device echo, reconnect\/replay, revoke/);
  const dataDir = /^Temporary data: (.+)\r?$/m.exec(result.output)?.[1];
  assert.ok(dataDir, result.output); assert.ok(path.basename(dataDir).startsWith('fish-cloud-test-'));
  assert.equal(fs.existsSync(dataDir), false);
});
