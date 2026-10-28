import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readPackage(directory) {
  const url = new URL(`../${directory}/package.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

assert(major >= 24, `Node.js 24 or newer is required; current version is ${process.version}.`);

const rootScripts = readPackage('.').scripts;
for (const script of ['dev', 'start', 'test', 'test:all', 'check', 'llbot:check', 'llbot:test', 'llbot:build']) {
  assert(rootScripts[script], `Missing root script: ${script}`);
}

const requiredScripts = new Map([
  ['packages/protocol-bili-bridge', ['test']],
  ['packages/cloud-manager', ['start', 'test']],
  ['packages/qq-agent-core', ['test', 'test:all']],
  ['packages/protocol-qq-llbot', ['check', 'test', 'build']],
]);

for (const [directory, scripts] of requiredScripts) {
  const manifest = readPackage(directory);
  for (const script of scripts) {
    assert(manifest.scripts?.[script], `Missing ${directory} script: ${script}`);
  }
}

const syntaxCheck = spawnSync(
  process.execPath,
  ['--check', fileURLToPath(new URL('./run-tests.mjs', import.meta.url))],
  { cwd: root, stdio: 'inherit' },
);
if (syntaxCheck.error) {
  throw syntaxCheck.error;
}
assert(syntaxCheck.status === 0, 'Syntax check failed for scripts/run-tests.mjs.');

console.log(`Root orchestration check passed on Node.js ${process.version}.`);
