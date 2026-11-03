// Reproduce the independent review with local fixtures. No production credentials
// are read; each invoked suite owns its temporary tenant and process cleanup.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
const reviewId = process.env.FISH_REVIEW_ID || 'review';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reviewId)) throw new Error('FISH_REVIEW_ID must be a safe log filename prefix');
if (!['--all', '--chains'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/review-validation.mjs --all|--chains');
}
const npmCli = process.env.npm_execpath || process.env.NPM_CLI
  || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const commands = mode === '--all'
  ? [{ label: 'npm run test:all', args: [npmCli, 'run', 'test:all'] }]
  : [
    { label: 'QQ OneBot + official events/OpenID + Bili drafts + four-entry meters', args: [
      '--test', 'packages/cloud-manager/test/v1-qq-integration.test.mjs',
      'packages/cloud-manager/test/review-official-lifecycle.test.mjs',
      'packages/cloud-manager/test/bili-explore-integration.test.mjs',
      'packages/cloud-manager/test/v1-billing-integration.test.mjs'
    ] },
    { label: 'Desktop pairing/chat/reconnect/replay/revoke/metering', args: [
      'packages/desktop-pet/scripts/acceptance-cloud.mjs', '--check'
    ] }
  ];
if (mode === '--all' && !existsSync(npmCli)) throw new Error('Set NPM_CLI to the installed npm-cli.js path');
const logPath = path.join(root, 'docs/evidence', mode === '--all'
  ? `${reviewId}-test-all-2026-11-03.txt` : `${reviewId}-simulated-chains-2026-11-03.txt`);
const output = createWriteStream(logPath, { encoding: 'utf8' });
const write = text => { output.write(text); process.stdout.write(text); };
write(`Independent review ${reviewId}; local fixtures only. UTC timestamps. Node ${process.version}\n`);
write('Only the temporary desktop password line is redacted; test output and failures are retained.\n');
try {
  for (const { label, args } of commands) {
    write(`\nStarted: ${new Date().toISOString()}\nCheck: ${label}\nCommand: ${process.execPath} ${args.join(' ')}\n`);
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    write(`Child PID: ${child.pid}\n`);
    const readers = [child.stdout, child.stderr].map(async stream => {
      stream.setEncoding('utf8');
      let pending = '';
      for await (const chunk of stream) {
        pending += chunk;
        let at;
        while ((at = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, at + 1); pending = pending.slice(at + 1);
          write(line.replace(/^(Temporary password:)[^\r\n]*/, '$1 [redacted]'));
        }
      }
      if (pending) write(pending.replace(/^(Temporary password:)[^\r\n]*/, '$1 [redacted]'));
    });
    const [code, signal] = await once(child, 'exit');
    await Promise.all(readers);
    write(`Completed: ${new Date().toISOString()}\nExit: ${code}; signal: ${signal || 'none'}\n`);
    if (code !== 0 || signal) { process.exitCode = code || 1; break; }
  }
} finally {
  output.end();
  await once(output, 'finish');
}
