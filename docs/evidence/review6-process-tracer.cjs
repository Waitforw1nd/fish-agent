// Optional audit preload. Records only this run's process ownership; no env,
// credentials, output, network behavior, assertions or exit codes are changed.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { threadId } = require('node:worker_threads');
const dir = process.env.FISH_REVIEW_PROCESS_DIR;
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  const own = { pid: process.pid, parentPid: process.ppid, threadId, startedAt: new Date().toISOString(), executable: process.execPath, entry: process.argv[1] || null };
  const ownFile = path.join(dir, `process-${process.pid}-${threadId}.json`);
  fs.writeFileSync(ownFile, JSON.stringify(own));
  process.on('exit', code => fs.writeFileSync(ownFile, JSON.stringify({ ...own, exitedAt: new Date().toISOString(), code })));
  const spawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = Reflect.apply(spawn, this, args);
    if (child.pid) {
      const record = { pid: child.pid, parentPid: process.pid, startedAt: new Date().toISOString(), command: String(args[0]) };
      const file = path.join(dir, `child-${process.pid}-${child.pid}.json`);
      fs.writeFileSync(file, JSON.stringify(record));
      child.once('exit', (code, signal) => fs.writeFileSync(file, JSON.stringify({ ...record, exitedAt: new Date().toISOString(), code, signal })));
    }
    return child;
  };
  syncBuiltinESMExports();
}
