import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.js';
import { LedgerBillingProvider } from '../src/billing/provider.js';
import { BillingService } from '../src/billing.js';
import { RelayService } from '../src/relay/server.js';
import http from 'node:http';

function fixture() {
  const db=new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES('u','u','x',1)").run();
  for(const id of ['a','b']) db.prepare("INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,created_at,expires_at,updated_at,data_dir) VALUES(?,?,?,'trial','u',1,9999999999999,1,'x')").run(id,id,id);
  const wallet=new BillingService({db}); const billing=new LedgerBillingProvider({db,wallet}); return {db,wallet,billing};
}
const ev=(tenantId='a')=>({tenantId,idempotencyKey:'event:1',entry:'desktop',meter:'desktop.message.in',quantity:1,unit:'count',occurredAt:Date.now(),source:'agent'});
test('hosting retries a failed initial checkpoint before a queued terminal state', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter();
  const close = attachHostingMeters({ supervisor, billing, intervalMs: 10 });
  const start = Date.now() - 3000;
  db.prepare("INSERT INTO qq_accounts(tenant_id,driver,state,updated_at) VALUES('a','napcat','prepared',0)").run();
  db.exec("CREATE TRIGGER fail_initial BEFORE INSERT ON hosting_meter_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const event = { runId: 'initial-failure', tenantId: 'a', kind: 'agent', state: 'starting', startedAt: start };
  supervisor.emit('run-state', event);
  db.prepare("INSERT INTO tenant_entries(tenant_id,entry,enabled,updated_at) VALUES('a','qq_protocol',0,0)").run();
  supervisor.emit('run-state', { ...event, state: 'stopped', endedAt: start + 1000 });
  db.exec('DROP TRIGGER fail_initial');
  await waitUntil(() => db.prepare('SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(event.runId)?.completed_at != null);
  assert.equal(db.prepare('SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(event.runId).completed_at, start + 1000);
  assert.equal(billing.usage({ tenantId: 'a', meter: 'qq_protocol.hosting.seconds' })[0].quantity, 1);
  close(); db.close();
});
async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for hosting checkpoint'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('real Supervisor preserves the observed exit time when terminal persistence fails', { timeout: 15000 }, async t => {
  const { db, billing } = fixture();
  const { Supervisor } = await import('../src/supervisor.js');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const { once } = await import('node:events');
  const supervisor = new Supervisor({ db, config: { processStopTimeoutMs: 1000, processStartTimeoutMs: 1000, maxCrashRestarts: 0 }, logger: { error() {} } });
  const detach = attachHostingMeters({ supervisor, billing, intervalMs: 20 });
  t.after(async () => { db.exec('DROP TRIGGER IF EXISTS fail_terminal'); detach(); try { await supervisor.shutdown(); } finally { db.close(); } });
  await supervisor.start({ tenantId: 'a', kind: 'bili', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 500)'], cwd: process.cwd(), restart: false });
  const service = supervisor.get('a', 'bili'), runId = service.runId, child = service.child;
  await waitUntil(() => billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' }).length > 0);
  db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON process_runs WHEN NEW.status IN ('stopped','exited','failed','crashed') BEGIN SELECT RAISE(ABORT,'terminal write failure'); END");
  await once(child, 'exit');
  await waitUntil(() => service.runEndedAt != null && db.prepare('SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(runId).completed_at != null);
  const endedAt = service.runEndedAt, saved = db.prepare('SELECT * FROM hosting_meter_checkpoints WHERE run_id=?').get(runId);
  assert.equal(db.prepare('SELECT status FROM process_runs WHERE id=?').get(runId).status, 'running');
  assert.equal(saved.completed_at, endedAt); assert.equal(saved.cursor_at, endedAt);
  const quantity = billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity;
  assert.ok(Math.abs(quantity - (endedAt - service.startedAt) / 1000) < 1e-9);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, quantity);
  db.exec('DROP TRIGGER fail_terminal');
  await supervisor.stop('a', 'bili');
  assert.equal(db.prepare('SELECT stopped_at FROM process_runs WHERE id=?').get(runId).stopped_at, endedAt);
});

test('a real exit with an unconfirmed process group pauses rather than closes the meter', { timeout: 15000 }, async t => {
  const { db, billing } = fixture();
  const { Supervisor } = await import('../src/supervisor.js');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const { once } = await import('node:events');
  const supervisor = new Supervisor({ db, config: { processStopTimeoutMs: 1000, processStartTimeoutMs: 1000, maxCrashRestarts: 0 }, logger: { error() {} } });
  const detach = attachHostingMeters({ supervisor, billing, intervalMs: 20 });
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); detach(); try { await supervisor.shutdown(); } finally { db.close(); } });
  await supervisor.start({ tenantId: 'a', kind: 'bili', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 500)'], cwd: process.cwd(), restart: false });
  const service = supervisor.get('a', 'bili'), runId = service.runId, child = service.child;
  let groupAlive = true;
  supervisor._groupAlive = () => groupAlive;
  const terminate = supervisor._terminate.bind(supervisor);
  supervisor._terminate = async (...args) => { await gate; groupAlive = false; return terminate(...args); };
  try {
    await once(child, 'exit');
    await waitUntil(() => service.exitObserved);
    const cursor = db.prepare('SELECT cursor_at FROM hosting_meter_checkpoints WHERE run_id=?').get(runId).cursor_at;
    await new Promise(resolve => setTimeout(resolve, 80));
    const paused = db.prepare('SELECT cursor_at,completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(runId);
    assert.equal(paused.cursor_at, cursor); assert.equal(paused.completed_at, null); assert.equal(service.runEndedAt, null);
    release();
    await waitUntil(() => db.prepare('SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(runId).completed_at != null);
    assert.ok(service.runEndedAt >= cursor);
  } finally { release(); }
});
test('Supervisor resets exit observations for each restarted run', { timeout: 15000 }, async t => {
  const { db, billing } = fixture();
  const { Supervisor } = await import('../src/supervisor.js');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new Supervisor({ db, config: { processStopTimeoutMs: 1000, processStartTimeoutMs: 1000, maxCrashRestarts: 1, crashBackoffBaseMs: 20, crashBackoffMaxMs: 20 }, logger: { error() {} } });
  const detach = attachHostingMeters({ supervisor, billing, intervalMs: 20 });
  t.after(async () => { detach(); try { await supervisor.shutdown(); } finally { db.close(); } });
  await supervisor.start({ tenantId: 'a', kind: 'bili', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 400)'], cwd: process.cwd(), restart: true });
  const service = supervisor.get('a', 'bili'), firstId = service.runId;
  await waitUntil(() => service.runId !== firstId && service.state === 'running');
  assert.equal(service.runEndedAt, null); assert.equal(service.exitObserved, false);
  assert.equal(supervisor.meterObservation(service.runId).chargeable, true);
  assert.ok(db.prepare('SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id=?').get(firstId).completed_at != null);
});
test('hosting recovery settles only confirmed ends and retains unconfirmed runs', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter();
  const closeFirst = attachHostingMeters({ supervisor, billing, intervalMs: 60000 });
  const start = Date.now() - 5000;
  const insert = db.prepare('INSERT INTO process_runs(id,tenant_id,kind,status,started_at,stopped_at) VALUES(?,?,?,?,?,?)');
  insert.run('confirmed', 'a', 'bili', 'starting', start, null);
  insert.run('unknown', 'b', 'bili', 'starting', start, null);
  supervisor.emit('run-state', { runId: 'confirmed', tenantId: 'a', kind: 'bili', state: 'starting', startedAt: start });
  supervisor.emit('run-state', { runId: 'unknown', tenantId: 'b', kind: 'bili', state: 'starting', startedAt: start });
  db.prepare("UPDATE process_runs SET status='exited', stopped_at=? WHERE id='confirmed'").run(start + 2000);
  const warnings = [];
  const closeSecond = attachHostingMeters({ supervisor: new EventEmitter(), billing, logger: { warn: (...args) => warnings.push(args) } });
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 2);
  assert.equal(billing.usage({ tenantId: 'b', meter: 'bili.hosting.seconds' }).length, 0);
  assert.equal(db.prepare("SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id='unknown'").get().completed_at, null);
  assert.ok(warnings.some(args => args[1]?.runId === 'unknown'));
  const closeThird = attachHostingMeters({ supervisor: new EventEmitter(), billing });
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 2);
  closeFirst(); closeSecond(); closeThird(); db.close();
});
test('hosting meter event and cursor roll back together on persistence failure', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter(), close = attachHostingMeters({ supervisor, billing });
  const start = Date.now() - 5000;
  const event = { runId: 'atomic', tenantId: 'a', kind: 'bili', state: 'starting', startedAt: start };
  supervisor.emit('run-state', event);
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON hosting_meter_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  supervisor.emit('run-state', { ...event, state: 'exited', endedAt: start + 1000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 0);
  assert.equal(db.prepare("SELECT cursor_at FROM hosting_meter_checkpoints WHERE run_id='atomic'").get().cursor_at, start);
  db.exec('DROP TRIGGER fail_checkpoint'); close();
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 1);
  db.close();
});
test('hosting recovery revisits ends confirmed after startup without charging unverified time', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const start = Date.now() - 10000;
  db.prepare('INSERT INTO process_runs(id,tenant_id,kind,status,started_at) VALUES(?,?,?,?,?)').run('late-end', 'a', 'bili', 'starting', start);
  db.prepare('INSERT INTO hosting_meter_checkpoints(run_id,tenant_id,entry,cursor_at,observed_at) VALUES(?,?,?,?,?)').run('late-end', 'a', 'bili', start, start);
  const close = attachHostingMeters({ supervisor: new EventEmitter(), billing, intervalMs: 60000 });
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' }).length, 0);
  db.prepare("UPDATE process_runs SET status='exited', stopped_at=? WHERE id='late-end'").run(start + 3000);
  close();
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 3);
  assert.equal(db.prepare("SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id='late-end'").get().completed_at, start + 3000);
  db.close();
});
test('active hosting checkpoint uses persisted end when terminal event was missed', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter(), start = Date.now() - 10000;
  db.prepare('INSERT INTO process_runs(id,tenant_id,kind,status,started_at) VALUES(?,?,?,?,?)').run('missed-end', 'a', 'bili', 'starting', start);
  const close = attachHostingMeters({ supervisor, billing, intervalMs: 60000 });
  supervisor.emit('run-state', { runId: 'missed-end', tenantId: 'a', kind: 'bili', state: 'starting', startedAt: start });
  db.prepare("UPDATE process_runs SET status='exited', stopped_at=? WHERE id='missed-end'").run(start + 2000);
  close();
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 2);
  assert.equal(db.prepare("SELECT completed_at FROM hosting_meter_checkpoints WHERE run_id='missed-end'").get().completed_at, start + 2000);
  db.close();
});
test('hosting scan database failure leaves cursor untouched and retries', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter(), start = Date.now() - 10000;
  db.prepare('INSERT INTO process_runs(id,tenant_id,kind,status,started_at) VALUES(?,?,?,?,?)').run('scan-fail', 'a', 'bili', 'starting', start);
  let fail = false, notify, scanFailed = false;
  const failed = new Promise(resolve => { notify = resolve; });
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      if (fail && sql.startsWith('SELECT status, stopped_at FROM process_runs')) throw new Error('fixture scan failure');
      return target.prepare(sql);
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  billing.db = proxy;
  const close = attachHostingMeters({ supervisor, billing, intervalMs: 10, logger: { error: () => { scanFailed = true; notify(); } } });
  supervisor.emit('run-state', { runId: 'scan-fail', tenantId: 'a', kind: 'bili', state: 'starting', startedAt: start });
  db.prepare("UPDATE process_runs SET status='exited', stopped_at=? WHERE id='scan-fail'").run(start + 2000);
  fail = true;
  // The production timer is unref'ed, so keep the test alive until it fires.
  const keepAlive = setTimeout(() => notify(), 1000);
  await failed; clearTimeout(keepAlive);
  assert.equal(scanFailed, true);
  assert.equal(db.prepare("SELECT cursor_at FROM hosting_meter_checkpoints WHERE run_id='scan-fail'").get().cursor_at, start);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 0);
  fail = false; close();
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 2);
  db.close();
});
test('tenant-bound batches deduplicate and reject forged server meters atomically',()=>{const {db,billing}=fixture(); assert.deepEqual(billing.recordMeters([ev()],{client:true,tenantId:'a'}),{accepted:1,duplicates:0}); assert.deepEqual(billing.recordMeters([ev()],{client:true,tenantId:'a'}),{accepted:0,duplicates:1}); assert.throws(()=>billing.recordMeters([ev('b')],{client:true,tenantId:'a'})); assert.throws(()=>billing.recordMeters([{...ev(),meter:'desktop.device.seats',source:'gateway',unit:'seats'}],{client:true,tenantId:'a'})); assert.equal(billing.recordMeters([ev('b')],{client:true,tenantId:'b'}).accepted,1); db.close();});
test('client chat and platform attribution cannot contradict the declared entry', () => {
  const { db, billing } = fixture();
  const cases = [
    ['qq_protocol', 'group:123', 'qq'], ['qq_official', 'private:qqbot_user_AbC', 'qqbot'],
    ['bili', 'group:4503599627370500', 'bili'], ['desktop', 'private:7459086882832384', 'desktop']
  ];
  for (const [entry, chatKey, platform] of cases) {
    const event = { ...ev(), entry, meter: `${entry}.message.in`, attrs: { chatKey, platform }, idempotencyKey: entry };
    assert.equal(billing.recordMeters([event], { client: true, tenantId: 'a' }).accepted, 1);
    assert.throws(() => billing.recordMeters([{ ...event, idempotencyKey: `${entry}-bad`, attrs: { chatKey: cases.find(c => c[0] !== entry)[1] } }], { client: true, tenantId: 'a' }), /mismatch/);
    assert.throws(() => billing.recordMeters([{ ...event, idempotencyKey: `${entry}-bad-platform`, attrs: { platform: 'other' } }], { client: true, tenantId: 'a' }), /mismatch/);
    assert.equal(billing.recordMeters([{ ...event, tenantId: 'b' }], { client: true, tenantId: 'b' }).accepted, 1);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 8);
  db.close();
});
test('QQ entry selection rolls back if disabling the other entry fails', async () => {
  const { db } = fixture();
  const { TenantEntryService } = await import('../src/entries.js');
  db.prepare("INSERT INTO qq_accounts(tenant_id,driver,state,updated_at) VALUES('a','napcat','prepared',0)").run();
  db.exec("CREATE TRIGGER fail_other_entry BEFORE INSERT ON tenant_entries WHEN NEW.entry='qq_official' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const entries = new TenantEntryService({ db });
  assert.throws(() => entries.setEnabled({ id: 'a', plan_id: 'starter' }, 'qq_protocol', true));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tenant_entries WHERE tenant_id='a'").get().n, 0);
  db.close();
});
test('seat gauge reads latest value and hard and soft quota modes',()=>{const {db,billing}=fixture(); for(const [i,q] of [2,1].entries()) billing.recordMeter({...ev(),idempotencyKey:`seat:${i}`,meter:'desktop.device.seats',unit:'seats',kind:'gauge',source:'gateway',quantity:q,occurredAt:Date.now()+i}); billing.setEntitlements('a',[{meter:'desktop.device.seats',window:'concurrent',limit:1,mode:'hard'}]); assert.equal(billing.checkEntitlement({tenantId:'a',entry:'desktop',meter:'desktop.device.seats',quantity:1}).allowed,false); billing.setEntitlements('a',[{meter:'desktop.device.seats',window:'concurrent',limit:1,mode:'soft'}]); assert.equal(billing.checkEntitlement({tenantId:'a',entry:'desktop',meter:'desktop.device.seats',quantity:1}).allowed,true); db.close();});
test('settlement atomically records entry and tokens exactly once',()=>{const {db,billing,wallet}=fixture(); db.prepare("INSERT INTO relay_keys(id,tenant_id,key_hash,key_prefix,created_at) VALUES('k','a','hash','sk',1)").run(); wallet.ensureWallet('a',100000); const reservation=wallet.reserve({tenantId:'a',keyId:'k',model:'deepseek-chat',estimatedMicros:10,maxTokens:10}); const args={reservation,usage:{prompt_tokens:4,completion_tokens:3},attribution:{platform:'qqbot',entry:'qq_official'},requestId:'r'}; assert.equal(wallet.settle(args).settled,true); assert.equal(wallet.settle(args).settled,false); assert.equal(db.prepare('SELECT entry FROM ledger').get().entry,'qq_official'); assert.equal(billing.usage({tenantId:'a'})[0].quantity,7); db.close();});

test('hosting lifecycle checkpoints do not duplicate a terminal run', async () => {
  const {db,billing}=fixture(); const {EventEmitter}=await import('node:events'); const {attachHostingMeters}=await import('../src/billing/hosting-meter.js'); const supervisor=new EventEmitter(); const stop=attachHostingMeters({supervisor,billing,intervalMs:60000});
  const startedAt=Date.now()-2500; const event={runId:'run-host',tenantId:'a',kind:'bili',state:'starting',startedAt}; supervisor.emit('run-state',event); supervisor.emit('run-state',{...event,state:'exited',endedAt:startedAt+2000}); supervisor.emit('run-state',{...event,state:'stopped',endedAt:startedAt+2000}); stop();
  assert.equal(billing.usage({tenantId:'a',entry:'bili'})[0].quantity,2); db.close();
});

test('shared agent time is assigned only to the active QQ entry, without multiplying other entries',async()=>{const {db,billing}=fixture();const {EventEmitter}=await import('node:events');const {attachHostingMeters}=await import('../src/billing/hosting-meter.js');const supervisor=new EventEmitter();const close=attachHostingMeters({supervisor,billing,intervalMs:60000});db.prepare("INSERT INTO qq_accounts(tenant_id,driver,state,updated_at) VALUES('a','napcat','prepared',0)").run();const start=Date.now()-3000;const e={runId:'agent-qq',tenantId:'a',kind:'agent',state:'starting',startedAt:start};supervisor.emit('run-state',e);supervisor.emit('run-state',{...e,state:'stopped',endedAt:start+1000});assert.equal(billing.usage({tenantId:'a',meter:'qq_protocol.hosting.seconds'})[0].quantity,1);assert.equal(billing.usage({tenantId:'a',meter:'bili.hosting.seconds'}).length,0);db.prepare("INSERT INTO tenant_entries(tenant_id,entry,enabled,updated_at) VALUES('a','qq_protocol',0,0)").run();const off={...e,runId:'agent-off'};supervisor.emit('run-state',off);supervisor.emit('run-state',{...off,state:'stopped',endedAt:start+1000});assert.equal(billing.usage({tenantId:'a',meter:'qq_protocol.hosting.seconds'})[0].quantity,1);close();db.close();});

test('agent terminal checkpoint survives a QQ entry being disabled mid-run',async()=>{const {db,billing}=fixture();const {EventEmitter}=await import('node:events');const {attachHostingMeters}=await import('../src/billing/hosting-meter.js');const supervisor=new EventEmitter();const close=attachHostingMeters({supervisor,billing,intervalMs:60000});db.prepare("INSERT INTO qq_accounts(tenant_id,driver,state,updated_at) VALUES('a','napcat','prepared',0)").run();const start=Date.now()-3000;const e={runId:'agent-switch',tenantId:'a',kind:'agent',state:'starting',startedAt:start};supervisor.emit('run-state',e);db.prepare("INSERT INTO tenant_entries(tenant_id,entry,enabled,updated_at) VALUES('a','qq_protocol',0,0)").run();supervisor.emit('run-state',{...e,state:'stopped',endedAt:start+1000});assert.equal(billing.usage({tenantId:'a',meter:'qq_protocol.hosting.seconds'})[0].quantity,1);close();db.close();});

test('gauge carries its latest prior state into a new month and reports observed daily values', () => {
  const { db, billing } = fixture();
  const gauge = (key, time, quantity, tenantId='a') => billing.recordMeter({ tenantId,
    idempotencyKey:key, entry:'desktop', meter:'desktop.device.seats', quantity,
    unit:'seats', kind:'gauge', source:'gateway', occurredAt:Date.parse(time) });
  gauge('old-1','2026-01-10T00:00:00Z',2);
  gauge('old-2','2026-01-31T23:00:00Z',3);
  gauge('other','2026-01-31T23:30:00Z',9,'b');
  const from=Date.parse('2026-02-01T00:00:00Z');
  const to=Date.parse('2026-03-01T00:00:00Z');
  const current=billing.usage({tenantId:'a',meter:'desktop.device.seats',from,to});
  assert.equal(current.length,1); assert.equal(current[0].quantity,3);
  assert.deepEqual(billing.usage({tenantId:'a',meter:'desktop.device.seats',from,to,groupBy:'day'}).map(x=>[x.day,x.quantity]),[['2026-02-01',3]]);
  gauge('new-1','2026-02-03T10:00:00Z',4);
  gauge('new-2','2026-02-03T11:00:00Z',1);
  assert.deepEqual(billing.usage({tenantId:'a',meter:'desktop.device.seats',from,to,groupBy:'day'}).map(x=>[x.day,x.quantity]),[['2026-02-01',3],['2026-02-03',1]]);
  assert.equal(billing.usage({tenantId:'a',meter:'desktop.device.seats',from,to})[0].quantity,1);
  db.close();
});

test('invalid date events are rejected and entitlement window replacements are deterministic', () => {
  const { db, billing } = fixture();
  assert.throws(()=>billing.recordMeter({...ev(),occurredAt:8_640_000_000_000_001}),/timestamp/);
  assert.throws(()=>billing.usage({tenantId:'a',from:8_640_000_000_000_001,to:8_640_000_000_000_002}),/range/);
  const meter='desktop.device.seats';
  billing.setEntitlements('a',[{meter,window:'day',limit:8,mode:'soft'}]);
  billing.setEntitlements('a',[{meter,window:'month',limit:4,mode:'hard'}]);
  assert.deepEqual(billing.entitlements('a').entitlements[meter],{window:'month',limit:4,mode:'hard'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_entitlements WHERE tenant_id=? AND meter=?').get('a',meter).n,1);
  assert.throws(()=>billing.setEntitlements('a',[{meter,window:'day',limit:3,mode:'off'},{meter,window:'bad',limit:1,mode:'hard'}]));
  assert.deepEqual(billing.entitlements('a').entitlements[meter],{window:'month',limit:4,mode:'hard'});
  db.close();
});

test('current month entitlement includes the carried-forward gauge', () => {
  const { db, billing }=fixture();
  const date=new Date();const month=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1);
  billing.recordMeter({...ev(),idempotencyKey:'old-seat',meter:'desktop.device.seats',unit:'seats',kind:'gauge',source:'gateway',quantity:2,occurredAt:month-1});
  billing.setEntitlements('a',[{meter:'desktop.device.seats',window:'month',limit:2,mode:'hard'}]);
  const result=billing.checkEntitlement({tenantId:'a',entry:'desktop',meter:'desktop.device.seats',quantity:1});
  assert.equal(result.used,2);assert.equal(result.allowed,false);db.close();
});

test('largest valid date can be recorded and grouped', () => {
  const { db,billing }=fixture();const time=8_640_000_000_000_000;
  billing.recordMeter({...ev(),occurredAt:time});
  const rows=billing.usage({tenantId:'a',from:time,to:time+1,groupBy:'day'});
  assert.equal(rows[0].day,'+275760-09-13');db.close();
});

test('client idempotency keys cannot preempt server seat or token records', () => {
  const { db, billing } = fixture();
  const key = 'device:ddev-known:revoke';
  assert.equal(billing.recordMeters([{ ...ev(), idempotencyKey: key }], { client: true, tenantId: 'a' }).accepted, 1);
  assert.equal(billing.recordMeter({ ...ev(), idempotencyKey: key, meter: 'desktop.device.seats', source: 'gateway', unit: 'seats', kind: 'gauge', quantity: 0 }).duplicate, false);
  assert.equal(billing.recordMeters([{ ...ev(), idempotencyKey: key }], { client: true, tenantId: 'a' }).duplicates, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 2);
  db.close();
});

test('failed terminal hosting checkpoint retries only to the original stop time', async () => {
  const { db, billing } = fixture();
  const { EventEmitter } = await import('node:events');
  const { attachHostingMeters } = await import('../src/billing/hosting-meter.js');
  const supervisor = new EventEmitter();
  const record = billing.recordMeter.bind(billing); let attempts = 0;
  billing.recordMeter = event => { if (++attempts === 1) throw new Error('temporary DB failure'); return record(event); };
  const close = attachHostingMeters({ supervisor, billing, intervalMs: 60000 });
  const startedAt = Date.now() - 60000;
  const event = { runId: 'failed-exit', tenantId: 'a', kind: 'bili', state: 'starting', startedAt };
  supervisor.emit('run-state', event);
  supervisor.emit('run-state', { ...event, state: 'exited', endedAt: startedAt + 2000 });
  close();
  assert.equal(attempts, 2);
  assert.equal(billing.usage({ tenantId: 'a', meter: 'bili.hosting.seconds' })[0].quantity, 2);
  db.close();
});
