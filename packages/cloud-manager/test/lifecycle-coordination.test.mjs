import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, startManager, loginAdmin } from './helpers.mjs';
import { LifecycleLock } from '../src/lifecycle-lock.js';

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for lifecycle operation'); await new Promise(r => setTimeout(r, 10)); }
}
async function waitReady(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for gate')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function setup(t, slug) {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const result = await admin.createTenant({ name: slug, slug, planId: 'starter' });
  return { ...env, admin, id: result.json.tenant.id };
}

test('QQ explicit start and entry disable are serialized', { timeout: 20000 }, async t => {
  const { manager, admin, id } = await setup(t, 'qq-coordination'); const base = `/api/tenants/${id}`;
  assert.equal((await admin.call(`${base}/qq/prepare`, { method: 'POST', body: { driver: 'llbot', uin: '12345' } })).status, 200);
  assert.equal((await admin.call(`${base}/start`, { method: 'POST' })).status, 200);
  let release, entered; const gate = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  t.after(() => release());
  const original = manager.qq.prepareAndStart.bind(manager.qq);
  manager.qq.prepareAndStart = async (...args) => { const result = await original(...args); entered(); await gate; return result; };
  try {
  const start = admin.call(`${base}/qq/start`, { method: 'POST', body: {} }); await waitReady(ready);
  const disable = admin.call(`${base}/entries/qq_protocol`, { method: 'PUT', body: { enabled: false } });
  await waitFor(() => manager.lifecycleLock.queues.get(id)?.count === 2);
  release(); assert.equal((await start).status, 200); assert.equal((await disable).status, 200);
  assert.equal(manager.entries.enabled(id, 'qq_protocol'), false);
  assert.equal(manager.supervisor.status(id, 'qq').state, 'stopped');
  } finally { release(); }
});

test('tenant stop follows an earlier start and remains stopped', { timeout: 20000 }, async t => {
  const { manager, admin, id } = await setup(t, 'tenant-coordination'); const base = `/api/tenants/${id}`;
  let release, entered; const gate = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  t.after(() => release());
  const original = manager.agent.start.bind(manager.agent);
  manager.agent.start = async (...args) => { entered(); await gate; return original(...args); };
  try {
  const start = admin.call(`${base}/start`, { method: 'POST' }); await waitReady(ready);
  const stop = admin.call(`${base}/stop`, { method: 'POST' });
  await waitFor(() => manager.lifecycleLock.queues.get(id)?.count === 2);
  release(); assert.equal((await start).status, 200); assert.equal((await stop).status, 200);
  assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  } finally { release(); }
});

test('incomplete bodies, read-only requests, other tenants and failed operations do not block lifecycle work', { timeout: 20000 }, async t => {
  const { manager, admin, id } = await setup(t, 'coordination-isolation'); const base = `/api/tenants/${id}`;
  const other = (await admin.createTenant({ name: 'Other', slug: 'coordination-other', planId: 'starter' })).json.tenant.id;
  const url = new URL(admin.baseUrl);
  const slow = http.request({ hostname: url.hostname, port: url.port, path: `${base}/entries/desktop`, method: 'PUT',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json', 'content-length': '100' } });
  slow.on('error', () => {}); slow.flushHeaders(); slow.write('{'); t.after(() => slow.destroy());
  assert.equal((await admin.call(`${base}/entries/desktop`, { method: 'PUT', body: { enabled: true } })).status, 200);
  let release, entered; const gate = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  t.after(() => release());
  const original = manager.bili.stop.bind(manager.bili);
  manager.bili.stop = async (...args) => { entered(); await gate; return original(...args); };
  try {
  const blocked = admin.call(`${base}/entries/bili`, { method: 'PUT', body: { enabled: false } }); await waitReady(ready);
  assert.equal((await admin.call(`${base}/entries`)).status, 200);
  assert.equal((await admin.call(`/api/tenants/${other}/entries/desktop`, { method: 'PUT', body: { enabled: true } })).status, 200);
  release(); assert.equal((await blocked).status, 200);
  assert.equal((await admin.call(`${base}/entries/invalid`, { method: 'PUT', body: { enabled: true } })).status, 400);
  assert.equal((await admin.call(`${base}/entries/desktop`, { method: 'PUT', body: { enabled: false } })).status, 200);
  slow.end(' '.repeat(99));
  } finally { release(); slow.destroy(); }
});

test('expiry waits for lifecycle work, while a renewed tenant is not stopped', { timeout: 20000 }, async t => {
  const { manager, admin, id } = await setup(t, 'expiry-coordination'); const base = `/api/tenants/${id}`;
  let release, entered; const gate = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  t.after(() => release());
  const original = manager.agent.start.bind(manager.agent);
  manager.agent.start = async (...args) => { entered(); await gate; return original(...args); };
  try {
  const start = admin.call(`${base}/start`, { method: 'POST' }); await waitReady(ready);
  manager.db.prepare("UPDATE tenants SET status='expired', expires_at=? WHERE id=?").run(Date.now() - 1, id);
  const expired = manager.tenants.onExpired(id);
  await waitFor(() => manager.lifecycleLock.queues.get(id)?.count === 2);
  release(); await start; await expired;
  assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  manager.db.prepare("UPDATE tenants SET status='active', expires_at=? WHERE id=?").run(Date.now() + 60000, id);
  let stops = 0; const stop = manager.hosting.onExpired.bind(manager.hosting);
  manager.hosting.onExpired = async (...args) => { stops++; return stop(...args); };
  await manager.tenants.onExpired(id); assert.equal(stops, 0);
  } finally { release(); }
});

test('active QQ switch rejects entry changes before writing them', async t => {
  const { manager, admin, id } = await setup(t, 'switch-entry-guard');
  const original = manager.qq.hasActiveSwitch.bind(manager.qq);
  manager.qq.hasActiveSwitch = tenantId => tenantId === id || original(tenantId);
  t.after(() => { manager.qq.hasActiveSwitch = original; });
  const result = await admin.call(`/api/tenants/${id}/entries/desktop`, { method: 'PUT', body: { enabled: true } });
  assert.equal(result.status, 409); assert.equal(result.json.code, 'QQ_SWITCH_ACTIVE');
  assert.equal(manager.entries.enabled(id, 'desktop'), false);
});

for (const mode of ['logout', 'disabled']) {
  test(`queued entry change rejects a ${mode} session`, { timeout: 20000 }, async t => {
    const { manager, admin, id } = await setup(t, `queued-${mode}`);
    const queuedClient = await loginAdmin(manager), base = `/api/tenants/${id}`;
    let release, entered; const gate = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
    const stop = manager.bili.stop.bind(manager.bili);
    manager.bili.stop = async (...args) => { entered(); await gate; return stop(...args); };
    try {
      const first = admin.call(`${base}/entries/bili`, { method: 'PUT', body: { enabled: false } });
      await waitReady(ready);
      const queued = queuedClient.call(`${base}/entries/desktop`, { method: 'PUT', body: { enabled: true } });
      await waitFor(() => manager.lifecycleLock.queues.get(id)?.count === 2);
      if (mode === 'logout') assert.equal((await queuedClient.call('/api/auth/logout', { method: 'POST' })).status, 200);
      else manager.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(queuedClient.user.id);
      release(); assert.equal((await first).status, 200);
      const result = await queued;
      assert.equal(result.status, 401, result.text); assert.equal(result.json.code, 'UNAUTHENTICATED');
      assert.equal(manager.entries.enabled(id, 'desktop'), false);
    } finally { release(); }
  });
}

test('lifecycle queue is bounded and mandatory expiry is still admitted', async () => {
  const lock = new LifecycleLock({ maxPending: 1 });
  let release; const gate = new Promise(r => { release = r; });
  const first = lock.run('a', () => gate);
  await assert.rejects(lock.run('a', () => {}, {}), { status: 429, code: 'LIFECYCLE_BUSY' });
  let executed = false; const mandatory = lock.run('a', () => { executed = true; }, { mandatory: true });
  assert.equal(executed, false); release(); await first; await mandatory;
  assert.equal(executed, true); assert.equal(lock.queues.size, 0);
});

const relayChanges = [
  { name: 'custom-put', path: '/relay/custom', options: { method: 'PUT', body: { model: 'new-model' } } },
  { name: 'custom-delete', path: '/relay/custom', options: { method: 'DELETE' } },
  { name: 'key-put', path: '/relay/key', options: { method: 'PUT', body: { key: 'local-replacement-key' } } }
];
for (const change of relayChanges) {
  test(`relay ${change.name} completes before concurrent tenant stop`, { timeout: 20000 }, async t => {
    const { manager, admin, id } = await setup(t, `relay-stop-${change.name}`), base = `/api/tenants/${id}`;
    manager.customUpstreams.allowPrivate=true;
    assert.equal((await admin.call(base + '/relay/custom', {method:'PUT',body:{baseUrl:'http://127.0.0.1:12345',model:'old-model',apiKey:'local-test-key'}})).status, 200);
    assert.equal((await admin.call(base + '/start', {method:'POST'})).status, 200);
    let release, entered; const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{entered=r;});
    const original=manager.agent.stop.bind(manager.agent);let first=true;
    manager.agent.stop=async (...args)=>{const result=await original(...args);if(first){first=false;entered();await gate;}return result;};
    try {
      const update=admin.call(base + change.path, change.options);await waitReady(ready);
      const stop=admin.call(base + '/stop', {method:'POST'});
      await waitFor(()=>manager.lifecycleLock.queues.get(id)?.count===2);
      release();assert.equal((await update).status,200);assert.equal((await stop).status,200);
      assert.equal(manager.supervisor.status(id,'agent').state,'stopped');
    } finally { release(); }
  });
  test(`queued relay ${change.name} rechecks session`, { timeout: 20000 }, async t => {
    const {manager,admin,id}=await setup(t, `relay-auth-${change.name}`), queuedClient=await loginAdmin(manager), base=`/api/tenants/${id}`;
    let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
    const original=manager.bili.stop.bind(manager.bili);
    manager.bili.stop=async (...args)=>{entered();await gate;return original(...args);};
    try {
      const first=admin.call(base+'/entries/bili',{method:'PUT',body:{enabled:false}});await waitReady(ready);
      const queued=queuedClient.call(base+change.path,change.options);await waitFor(()=>manager.lifecycleLock.queues.get(id)?.count===2);
      assert.equal((await queuedClient.call('/api/auth/logout',{method:'POST'})).status,200);
      release();assert.equal((await first).status,200);
      const result=await queued;assert.equal(result.status,401,result.text);assert.equal(result.json.code,'UNAUTHENTICATED');
    } finally {release();}
  });
}

test('queued relay update rechecks tenant owner role', { timeout: 20000 }, async t => {
  const {manager,admin,id,config}=await setup(t,'relay-role-recheck'), base=`/api/tenants/${id}`;
  assert.equal((await admin.call('/api/admin/users',{method:'POST',body:{username:'relayowner',password:'relayowner-password-123',role:'user'}})).status,201);
  const owner=new Client(`http://127.0.0.1:${config.panelPort}`);await owner.login('relayowner','relayowner-password-123');
  manager.db.prepare('INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)').run(owner.user.id,id,'owner',Date.now());
  let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  const original=manager.bili.stop.bind(manager.bili);manager.bili.stop=async (...args)=>{entered();await gate;return original(...args);};
  try {
    const first=admin.call(base+'/entries/bili',{method:'PUT',body:{enabled:false}});await waitReady(ready);
    const queued=owner.call(base+'/relay/key',{method:'PUT',body:{key:'local-role-test-key'}});
    await waitFor(()=>manager.lifecycleLock.queues.get(id)?.count===2);
    manager.db.prepare('UPDATE memberships SET role=? WHERE user_id=? AND tenant_id=?').run('operator',owner.user.id,id);
    release();assert.equal((await first).status,200);
    const result=await queued;assert.equal(result.status,403,result.text);
  } finally {release();}
});
