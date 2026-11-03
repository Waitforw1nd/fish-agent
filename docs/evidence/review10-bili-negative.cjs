// Reproduce the pre-fix watcher gate without modifying or copying product code.
// Success means the child test failed for the expected additional context read.
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const bridge = pathToFileURL(path.join(root, 'packages/protocol-bili-bridge/src/bridge.js')).href;
const test = pathToFileURL(path.join(root, 'packages/protocol-bili-bridge/test/explore.test.mjs')).href;
const source = `import { BiliBridge } from ${JSON.stringify(bridge)};\nBiliBridge.prototype.watcherRevision = () => '';\nawait import(${JSON.stringify(test)});`;
const child = spawnSync(process.execPath, ['--input-type=module', '--test-name-pattern=a watcher disabled and re-enabled', '-e', source], { cwd: root, encoding: 'utf8', env: process.env });
process.stdout.write(child.stdout || '');
process.stderr.write(child.stderr || '');
const output = (child.stdout || '') + (child.stderr || '');
console.log(`Child exit: ${child.status}`);
if (child.error || child.status !== 1 || !output.includes('a watcher disabled and re-enabled') || !output.includes("'feed'") || !output.includes("'context'") || !output.includes('AssertionError')) {
  console.error('Negative control did not reproduce the expected assertion failure.', child.error || '');
  process.exitCode = 1;
} else {
  console.log('Expected failure reproduced: the old gate continued from feed to context.');
  console.log('Outer exit: 0');
}
