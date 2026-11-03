import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const all = args.length === 1 && args[0] === '--all';

if (args.length > 0 && !all) {
  console.error('Usage: node scripts/run-tests.mjs [--all]');
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`Node.js 24 or newer is required; current version is ${process.version}.`);
  process.exit(1);
}

const suites = [
  ['Bilibili bridge', 'packages/protocol-bili-bridge', 'test'],
  ['cloud-manager', 'packages/cloud-manager', 'test'],
  ['cloud-manager panel', 'packages/cloud-manager/panel', 'test'],
  ['QQ-agent', 'packages/qq-agent-core', all ? 'test:all' : 'test'],
  ...(!all ? [['Headless runtime', 'packages/qq-agent-core', 'test:headless'], ['Multi-entry core', 'packages/qq-agent-core', 'test:multi-entry']] : []),
  ['Desktop pet', 'packages/desktop-pet', 'test'],
  ...(all ? [['LLBot type check', 'packages/protocol-qq-llbot', 'check'], ['LLBot unit and WebUI', 'packages/protocol-qq-llbot', 'test']] : []),
];
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npmCli) || !/\.(?:c?js|mjs)$/i.test(npmCli)) {
  console.error('npm CLI entry not found. Run this script through npm.');
  process.exit(1);
}

for (const [name, directory, script] of suites) {
  console.log(`\n==> ${name}: npm run ${script}`);
  const result = spawnSync(process.execPath, [path.resolve(npmCli), '--prefix', directory, 'run', script], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    console.error(`${name} was terminated by ${result.signal}.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
