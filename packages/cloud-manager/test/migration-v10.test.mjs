import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase } from '../src/db.js';
import { BillingService } from '../src/billing.js';
import { TenantEntryService } from '../src/entries.js';

const historical = fs.readFileSync(new URL('./fixtures/schema-v9.sql', import.meta.url), 'utf8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-v10-review-'));
  const file = path.join(dir, 'old.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(historical);
  db.exec(`
    INSERT INTO users(id,username,password_hash,role,created_at) VALUES ('owner','old-user','opaque-password-hash','user',1);
    INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,status,created_at,expires_at,updated_at,data_dir)
      VALUES ('tenant','old-tenant','Old tenant','starter','owner','active',1,9000000000000,2,'old-private-directory');
    INSERT INTO wallets VALUES ('tenant',456789,2);
    INSERT INTO wallet_transactions VALUES ('tx','tenant',123,'recharge','old recharge',2);
    INSERT INTO relay_keys(id,tenant_id,key_hash,key_prefix,created_at) VALUES ('key','tenant','old-key-hash','sk-fish-old',1);
    INSERT INTO reservations(id,tenant_id,key_id,model,estimated_micros,max_tokens,status,created_at,expires_at)
      VALUES ('held','tenant','key','deepseek-chat',15,5,'held',2,9000000000000);
    INSERT INTO ledger(id,tenant_id,model,prompt_tokens,completion_tokens,cost_micros,platform,chat_key,created_at)
      VALUES ('old-qq','tenant','deepseek-chat',10,2,42,'qq','group:123',2),
             ('old-bili','tenant','deepseek-chat',20,3,55,'bili','group:4503599627370496',3),
             ('unassigned','tenant','deepseek-chat',30,4,66,NULL,NULL,4);
    INSERT INTO qq_accounts(tenant_id,driver,uin,state,updated_at) VALUES ('tenant','llbot','123','prepared',2);
    INSERT INTO bili_config(tenant_id,config_json,updated_at) VALUES ('tenant','{"enabled":true,"subscriptions":{"ups":["123"]}}',2);
    INSERT INTO recharges(id,tenant_id,amount_micros,status,created_by_user_id,created_at)
      VALUES ('recharge','tenant',77,'pending','owner',2);
    INSERT INTO settings VALUES ('old-setting','opaque-encrypted-value',2);
    INSERT INTO tenant_secrets VALUES ('tenant','qqbot-app-secret','opaque-iv','opaque-tag','opaque-ciphertext',2);
  `);
  db.prepare('UPDATE ledger SET created_at=?').run(Date.now() - 60000);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file };
}

test('real v9 data upgrades to v10 without changing balances, history, credentials or legacy entry defaults', t => {
  const { db } = fixture(t);
  const tables = ['users','tenants','wallets','wallet_transactions','reservations','recharges','settings','qq_accounts','bili_config','relay_keys','tenant_secrets'];
  const snapshots = tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
  const history = db.prepare('SELECT * FROM ledger ORDER BY id').all();
  const billing = new BillingService({ db });
  const balance = billing.wallet('tenant');
  const usage = billing.usageSummary('tenant');
  assert.equal(usage.totals.costMicros, 163);
  migrate(db); migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  for (const [table, rows] of snapshots) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  assert.deepEqual(db.prepare('SELECT * FROM ledger ORDER BY id').all().map(({ entry, ...row }) => ({ ...row })), history.map(row => ({ ...row })));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger WHERE entry IS NOT NULL').get().n, 0, 'migration must not guess historical attribution');
  assert.deepEqual(billing.wallet('tenant'), balance);
  assert.deepEqual(billing.usageSummary('tenant'), usage);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 0, 'migration must not re-charge/replay historical usage');
  assert.deepEqual(new TenantEntryService({ db }).list('tenant'), {
    qq_protocol: { enabled: true }, qq_official: { enabled: false }, desktop: { enabled: false }, bili: { enabled: true }
  });
  db.prepare("UPDATE qq_accounts SET driver='qqbot' WHERE tenant_id='tenant'").run();
  assert.equal(new TenantEntryService({ db }).enabled('tenant','qq_official'), true);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('failed v10 DDL rolls back completely and can retry after resolving the conflict', t => {
  const { db } = fixture(t);
  db.exec("CREATE TABLE tenant_entries(sentinel TEXT); INSERT INTO tenant_entries VALUES ('preserve');");
  assert.throws(() => migrate(db), /already exists/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='meter_events'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(ledger)').all().some(row => row.name === 'entry'), false);
  assert.equal(db.prepare('SELECT sentinel FROM tenant_entries').get().sentinel, 'preserve');
  assert.equal(db.prepare('SELECT balance_micros FROM wallets').get().balance_micros, 456789);
  db.exec('DROP TABLE tenant_entries'); migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
});

test('existing v10 database gains hosting checkpoints without changing existing data', t => {
  const { db } = fixture(t);
  migrate(db);
  db.exec('DROP TABLE hosting_meter_checkpoints; PRAGMA user_version=10');
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM hosting_meter_checkpoints').get().n, 0);
  assert.equal(db.prepare('SELECT balance_micros FROM wallets').get().balance_micros, 456789);
});

test('newer database versions are refused without downgrading or modifying data', t => {
  const { db, file } = fixture(t);
  db.exec('PRAGMA user_version=12');
  assert.throws(() => openDatabase(file), /newer than supported/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(db.prepare('SELECT balance_micros FROM wallets').get().balance_micros, 456789);
});

test('concurrent v9 startup rechecks schema version under the SQLite write lock', { timeout: 15000 }, async t => {
  const { db, file } = fixture(t);
  const gate = new SharedArrayBuffer(4);
  const state = new Int32Array(gate);
  let ready = 0;
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      (async () => {
        const { migrate } = await import(workerData.module);
        const db = new DatabaseSync(workerData.file);
        db.exec('PRAGMA busy_timeout=5000');
        let first = true;
        const hooked = { exec: sql => db.exec(sql), prepare(sql) {
          const statement = db.prepare(sql);
          if (sql === 'PRAGMA user_version' && first) {
            first = false;
            return { get() { const row = statement.get(); parentPort.postMessage('ready');
              Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000); return row; } };
          }
          return statement;
        } };
        try { migrate(hooked); }
        finally { db.close(); }
        parentPort.postMessage('done');
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { file, gate, module: new URL('../src/db.js', import.meta.url).href } });
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', message => {
      if (message === 'ready' && ++ready === 2) { Atomics.store(state, 0, 1); Atomics.notify(state, 0, 2); }
      if (message === 'done') resolve();
    });
  });
  await Promise.all([run(), run()]);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 3);
});
