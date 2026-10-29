import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Supervisor } from '../src/supervisor.js';
import { waitFor } from './helpers.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE process_runs (id TEXT PRIMARY KEY, tenant_id TEXT, kind TEXT, pid INTEGER,
    status TEXT, started_at INTEGER, stopped_at INTEGER, exit_code INTEGER, last_error TEXT)`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stop-proof-'));
  const supervisor = new Supervisor({ db, config: { processStopTimeoutMs: 100, maxCrashRestarts: 0 }, logger: { error() {} } });
  t.after(async () => {
    for (const service of supervisor.services.values()) {
      try { service.child?.kill('SIGKILL'); } catch {}
    }
    try { await supervisor.shutdown(); } catch {}
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const start = (kind = 'agent', script = 'setInterval(() => {}, 1000)') => supervisor.start({
    tenantId: 'a', kind, command: process.execPath, args: ['-e', script], cwd, restart: false
  });
  return { db, cwd, supervisor, start };
}

for (const kind of ['qq', 'agent']) {
  test(`${kind}: interrupted database records cannot prove exit without memory`, async t => {
    const { db, supervisor, start } = fixture(t);
    db.prepare('INSERT INTO process_runs (id,tenant_id,kind,pid,status,started_at,stopped_at) VALUES (?,?,?,?,?,?,?)')
      .run('orphan', 'a', kind, 12345, 'interrupted', 1, 2);
    assert.equal(supervisor.status('a', kind).state, 'stop_unconfirmed');
    await assert.rejects(supervisor.stop('a', kind), { code: 'PROCESS_STOP_UNCONFIRMED' });
    await assert.rejects(start(kind), { code: 'PROCESS_STOP_UNCONFIRMED' });
    await assert.rejects(supervisor.stopTenant('a'), AggregateError);
    await assert.rejects(supervisor.shutdown(), AggregateError);
    assert.equal(db.prepare('SELECT status FROM process_runs').get().status, 'interrupted');
  });
}

test('signal termination persists proof before stop resolves and concurrent stops share it', async t => {
  const { db, supervisor, start } = fixture(t);
  await start();
  const child = supervisor.get('a', 'agent').child;
  await Promise.all([supervisor.stop('a', 'agent'), supervisor.stop('a', 'agent')]);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const run = db.prepare('SELECT * FROM process_runs').get();
  assert.equal(run.status, 'stopped');
  assert.ok(run.stopped_at);
  if (child.signalCode) {
    assert.equal(run.exit_code, null);
    assert.match(run.last_error, new RegExp(child.signalCode));
  }
  assert.equal(supervisor.status('a', 'agent').state, 'stopped');
});

test('failed persistence blocks stop success even after actual child exit', async t => {
  const { db, supervisor, start } = fixture(t);
  await start();
  const child = supervisor.get('a', 'agent').child;
  db.exec("CREATE TRIGGER fail_stop BEFORE UPDATE ON process_runs BEGIN SELECT RAISE(FAIL, 'write unavailable'); END");
  await assert.rejects(supervisor.stop('a', 'agent'), { code: 'PROCESS_STOP_UNCONFIRMED' });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(supervisor.status('a', 'agent').state, 'stop_unconfirmed');
  db.exec('DROP TRIGGER fail_stop');
  await supervisor.stop('a', 'agent');
  assert.equal(db.prepare('SELECT status FROM process_runs').get().status, 'stopped');
});

test('spawn failure has a terminal record and does not leave an unkillable child', async t => {
  const { db, supervisor, cwd } = fixture(t);
  await assert.rejects(supervisor.start({ tenantId: 'a', kind: 'agent', command: path.join(cwd, 'missing-command'), cwd }), { code: 'SPAWN_FAILED' });
  assert.equal(db.prepare('SELECT status FROM process_runs').get().status, 'failed');
  await supervisor.stop('a', 'agent');
});

for (const kind of ['qq', 'agent']) {
  test(`Linux ${kind} stops a TERM-resistant descendant before releasing the group`, { skip: process.platform !== 'linux' }, async t => {
    const { db, cwd, supervisor, start } = fixture(t);
    const marker = path.join(cwd, 'descendant');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const parent = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); process.on('SIGTERM', () => {}); child.on('exit', () => process.exit(0)); setInterval(() => {}, 1000)`;
    await start(kind, parent);
    await waitFor(() => fs.existsSync(marker));
    const group = supervisor.get('a', kind).processGroup;
    assert.ok(group);
    await supervisor.stop('a', kind);
    assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
    assert.equal(db.prepare('SELECT status FROM process_runs').get().status, 'stopped');
  });
}
