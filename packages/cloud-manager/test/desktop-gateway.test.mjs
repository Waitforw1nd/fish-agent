import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startManager, loginAdmin, request, waitFor } from './helpers.mjs';
import { sha256 } from '../src/util.js';
import { DesktopGateway } from '../src/desktop/gateway.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.js';
import { LedgerBillingProvider } from '../src/billing/provider.js';
const require=createRequire(import.meta.url);const {WebSocket,WebSocketServer}=require('ws');

async function prepare(t) {
  const env=await startManager();t.after(()=>env.stop());const {manager}=env;const admin=await loginAdmin(manager);const base=`http://127.0.0.1:${manager.config.panelPort}`;
  const first=await admin.createTenant({name:'Desktop One',slug:'desktop-one',planId:'starter'});const second=await admin.createTenant({name:'Desktop Two',slug:'desktop-two',planId:'starter'});assert.equal(first.status,201,first.text);assert.equal(second.status,201,second.text);
  const a=first.json.tenant.id,b=second.json.tenant.id;
  for(const id of [a,b]) {const r=await admin.call(`/api/tenants/${id}/entries/desktop`,{method:'PUT',body:{enabled:true}});assert.equal(r.status,200,r.text);}
  return {manager,admin,base,a,b};
}
async function code(admin,id){const r=await admin.call(`/api/tenants/${id}/desktop/pairing-codes`,{method:'POST'});assert.equal(r.status,201,r.text);return r.json.code;}
async function pair(base,code){return request(base,{method:'POST',path:'/desktop/v1/pair',body:{code,deviceName:'test',os:'win32'}});}
const deadline = (promise, label) => { let timer; return Promise.race([promise,new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('socket timeout: '+label)),3000); })]).finally(()=>clearTimeout(timer)); };
function connect(base,token,extra={}){return new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/desktop/v1/ws',{headers:{Authorization:`Bearer ${token}`,...extra}});ws.once('open',()=>resolve(ws));ws.once('unexpected-response',(_r,res)=>{res.resume();reject(Object.assign(new Error('upgrade rejected'),{status:res.statusCode}));});ws.once('error',reject);});}

test('pairing code creation requires session and CSRF, and failed claims consume the IP budget',async t=>{
  const {manager,admin,base,a}=await prepare(t);const route=`/api/tenants/${a}/desktop/pairing-codes`;
  assert.equal((await request(base,{method:'POST',path:route})).status,401);
  assert.equal((await admin.call(route,{method:'POST',csrf:false,headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM desktop_pairing_codes').get().n,0);
  const valid=await code(admin,a);
  for(let i=0;i<10;i++)assert.equal((await pair(base,'22222222')).status,401);
  assert.equal((await pair(base,valid)).status,429);
  assert.equal(manager.db.prepare('SELECT used_at FROM desktop_pairing_codes WHERE code_hash=?').get(sha256(valid)).used_at,null);
});

test('revocation while upstream handshake is pending prevents a new desktop socket',async t=>{
  const {manager,admin,base,a}=await prepare(t);const result=await pair(base,await code(admin,a));
  const upstream=http.createServer();let reached,upstreamSocket;const incoming=new Promise(r=>{reached=r;});
  upstream.on('upgrade',(_req,socket)=>{upstreamSocket=socket;socket.on('error',()=>{});reached();});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstreamSocket?.destroy();upstream.close(r);}));
  manager.db.prepare('UPDATE tenants SET agent_port=? WHERE id=?').run(upstream.address().port,a);
  const status=manager.supervisor.status.bind(manager.supervisor);manager.supervisor.status=(id,kind)=>id===a&&kind==='agent'?{state:'running'}:status(id,kind);t.after(()=>{manager.supervisor.status=status;});
  const pending=connect(base,result.json.deviceToken);const rejected=assert.rejects(pending);await deadline(incoming,'upstream handshake');
  assert.equal((await admin.call(`/api/tenants/${a}/desktop/devices/${result.json.deviceId}`,{method:'DELETE'})).status,200);
  await deadline(rejected,'revoked handshake');await assert.rejects(connect(base,result.json.deviceToken),e=>e.status===401);
});

test('pairing codes are single-use, expire, and device tokens stay tenant-bound and hashed',async t=>{
  const {manager,admin,base,a,b}=await prepare(t);const pairCode=await code(admin,a);const result=await pair(base,pairCode);assert.equal(result.status,200,result.text);const {deviceToken,deviceId}=result.json;
  assert.match(deviceToken,/^fdt_/);assert.equal((await pair(base,pairCode)).status,401);
  const stored=manager.db.prepare('SELECT * FROM desktop_devices WHERE id=?').get(deviceId);assert.equal(stored.tenant_id,a);assert.equal(stored.token_hash,sha256(deviceToken));assert.ok(!JSON.stringify(stored).includes(deviceToken));
  const listed=await admin.call(`/api/tenants/${a}/desktop/devices`);assert.equal(listed.status,200);assert.ok(!listed.text.includes(deviceToken));assert.ok(!listed.text.includes(stored.token_hash));
  const foreign=await admin.call(`/api/tenants/${b}/desktop/devices/${deviceId}`,{method:'DELETE'});assert.equal(foreign.status,404);assert.equal(manager.desktopDevices.authenticate(deviceToken).tenant.id,a);
  const expired=await code(admin,a);manager.db.prepare('UPDATE desktop_pairing_codes SET expires_at=? WHERE code_hash=?').run(Date.now()-1,sha256(expired));assert.equal((await pair(base,expired)).status,401);
  assert.equal((await request(base,{method:'GET',path:'/desktop/v1/pair'})).status,404);assert.equal((await request(base,{method:'POST',path:'/desktop/v1/pair?x=1',body:{code:expired}})).status,404);
  const tenant=manager.tenants.row(a);const conf=await manager.agent.writeConfig(tenant);assert.equal(conf.channels.desktop.enabled,true);assert.equal(conf.channels.qq.enabled,false);assert.equal(conf.channels.bili.enabled,false);
  for (const value of [null, [], 1, 'code']) assert.throws(() => manager.desktopDevices.pair(value), e => e.status === 400);
});

test('seat hard limit rejects additional device without consuming pairing code',async t=>{
  const {manager,admin,base,a}=await prepare(t);manager.billingProvider.setEntitlements(a,[{meter:'desktop.device.seats',window:'concurrent',limit:1,mode:'hard'}]);const one=await pair(base,await code(admin,a));assert.equal(one.status,200,one.text);const next=await code(admin,a);const denied=await pair(base,next);assert.equal(denied.status,403,denied.text);assert.equal(denied.json.code,'SEAT_LIMIT');assert.equal(manager.db.prepare('SELECT used_at FROM desktop_pairing_codes WHERE code_hash=?').get(sha256(next)).used_at,null); for(const mode of ['off','soft']) { manager.billingProvider.setEntitlements(a,[{meter:'desktop.device.seats',window:'concurrent',limit:1,mode}]); const deniedAgain=await pair(base,next);assert.equal(deniedAgain.status,403);assert.equal(deniedAgain.json.code,'SEAT_LIMIT');assert.equal(manager.db.prepare('SELECT used_at FROM desktop_pairing_codes WHERE code_hash=?').get(sha256(next)).used_at,null); }
});

test('overlapping sockets for one device count online time once and terminal failures retain the end time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const events = []; let failOnce = false;
  const gateway = new DesktopGateway({ devices: {}, agentRuntime: {}, billingProvider: { recordMeter(event) { if (failOnce) { failOnce = false; throw new Error('DB busy'); } events.push(event); } } });
  t.after(() => gateway.closeAll());
  const first = gateway.startOnline('tenant-a', 'device-one');
  t.mock.timers.tick(1000);
  const second = gateway.startOnline('tenant-a', 'device-one');
  assert.equal(first, second);
  t.mock.timers.tick(1000); gateway.endOnline(first);
  t.mock.timers.tick(1000); failOnce = true; gateway.endOnline(second);
  assert.equal(events.length, 0); assert.equal(gateway.onlineMeters.size, 1);
  t.mock.timers.tick(10000); gateway.flushMeters(); gateway.flushMeters();
  assert.equal(events.length, 1); assert.equal(events[0].quantity, 3); assert.equal(events[0].occurredAt, 103000);
  assert.equal(gateway.onlineMeters.size, 0);
});

test('online meter retries the same interval after an ambiguous provider failure', t => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES('u','u','x',1)").run();
  db.prepare("INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,created_at,expires_at,updated_at,data_dir) VALUES('a','a','a','trial','u',1,9999999999999,1,'x')").run();
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const ledger = new LedgerBillingProvider({ db }); let first = true; const attempts = [];
  const gateway = new DesktopGateway({ devices: {}, agentRuntime: {}, billingProvider: { recordMeter(event) {
    attempts.push(event); const result = ledger.recordMeter(event);
    if (first) { first = false; throw new Error('response lost after commit'); }
    return result;
  } } });
  t.after(() => { gateway.closeAll(); db.close(); });
  const meter = gateway.startOnline('a', 'device-one');
  t.mock.timers.tick(1000); gateway.flushMeters();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meter_events').get().n, 1);
  t.mock.timers.tick(2000);
  const connection = { close: () => { gateway.connections.delete(connection); gateway.endOnline(meter); } };
  gateway.connections.add(connection);
  gateway.closeAll();
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  assert.equal(gateway.onlineMeters.size, 0);
  const rows = db.prepare('SELECT quantity, occurred_at FROM meter_events ORDER BY occurred_at').all();
  assert.deepEqual(rows.map(row => [row.quantity, row.occurred_at]), [[1, 101000], [2, 103000]]);
  const normal = gateway.startOnline('a', 'device-two');
  t.mock.timers.tick(2000); gateway.endOnline(normal);
  assert.equal(db.prepare('SELECT SUM(quantity) n FROM meter_events').get().n, 5);
});

test('shutdown flushes the final online interval after retrying an already committed interval', t => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrate(db);
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES('u','u','x',1)").run();
  db.prepare("INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,created_at,expires_at,updated_at,data_dir) VALUES('a','a','a','trial','u',1,9999999999999,1,'x')").run();
  t.mock.timers.enable({apis:['Date'],now:100000});
  const ledger=new LedgerBillingProvider({db}), attempts=[]; let failures=2;
  const gateway=new DesktopGateway({devices:{},agentRuntime:{},billingProvider:{recordMeter(event){
    attempts.push(event);const result=ledger.recordMeter(event);
    if(failures-->0)throw new Error('response lost after commit');return result;
  }}});
  t.after(()=>{gateway.closeAll();db.close();});
  const meter=gateway.startOnline('a','device-one');
  t.mock.timers.tick(1000);gateway.flushMeters();
  t.mock.timers.tick(2000);gateway.endOnline(meter);
  gateway.closeAll();
  assert.equal(attempts[0].idempotencyKey,attempts[1].idempotencyKey);
  assert.equal(attempts[1].idempotencyKey,attempts[2].idempotencyKey);
  assert.deepEqual(db.prepare('SELECT quantity, occurred_at FROM meter_events ORDER BY occurred_at').all().map(x=>[x.quantity,x.occurred_at]),[[1,101000],[2,103000]]);
  assert.equal(gateway.onlineMeters.size,0);
});

test('gateway overrides untrusted headers, rejects forgery and origin, meters online time, and revokes immediately',async t=>{
  const {manager,admin,base,a,b}=await prepare(t);const result=await pair(base,await code(admin,a));assert.equal(result.status,200,result.text);const {deviceToken,deviceId,desktopUserId}=result.json;
  let headers;const agent=http.createServer();const wss=new WebSocketServer({server:agent});wss.on('connection',(ws,req)=>{headers=req.headers;ws.on('message',data=>{
    if (String(data) === 'policy-close') ws.close(1008, 'private upstream diagnostics');
    else if (String(data) === 'unknown-close') ws.close(4999, 'private upstream diagnostics');
    else ws.send(data.toString());
  });});await new Promise(r=>agent.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{for(const ws of wss.clients)ws.terminate();wss.close(()=>agent.close(r));}));
  manager.db.prepare('UPDATE tenants SET agent_port=? WHERE id=?').run(agent.address().port,a);const status=manager.supervisor.status.bind(manager.supervisor);manager.supervisor.status=(tenant,kind)=>tenant===a&&kind==='agent'?{state:'running'}:status(tenant,kind);t.after(()=>{manager.supervisor.status=status;});
  await assert.rejects(connect(base,'fdt_invalid'),e=>e.status===401);await assert.rejects(connect(base,deviceToken,{Origin:'https://evil.example'}),e=>e.status===403);
  const ws=await connect(base,deviceToken,{'x-console-token':'evil','x-fish-device-id':'other','x-fish-desktop-user':'123'});t.after(()=>ws.terminate());assert.equal(headers['x-fish-device-id'],deviceId);assert.equal(headers['x-fish-desktop-user'],String(desktopUserId));assert.notEqual(headers['x-console-token'],'evil');
  for (const [message, expected] of [['policy-close', 1008], ['unknown-close', 1011]]) {
    const peer = await connect(base, deviceToken);
    const closed = new Promise(resolve => peer.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    peer.send(message);
    assert.deepEqual(await deadline(closed, message), { code: expected, reason: 'CONNECTION_CLOSED' });
  }
  const authenticate = manager.desktopDevices.authenticate.bind(manager.desktopDevices);
  for (const [source, expected, code] of [['DEVICE_USER_FORBIDDEN','USER_FORBIDDEN',4003],['TENANT_INACTIVE','TENANT_INACTIVE',4003],['TOKEN_REVOKED','TOKEN_REVOKED',4001],['INTERNAL_PRIVATE','CONNECTION_CLOSED',1011]]) {
    const peer=await connect(base,deviceToken); const closedPermission=new Promise(r=>peer.once('close',(c,reason)=>r({code:c,reason:String(reason)})));
    manager.desktopDevices.authenticate=()=>{throw Object.assign(new Error('private fixture'),{code:source});}; peer.send('test');
    assert.deepEqual(await deadline(closedPermission,source),{code,reason:expected}); manager.desktopDevices.authenticate=authenticate;
  }
  const echo=new Promise(r=>ws.once('message',v=>r(v.toString())));ws.send('hello');assert.equal(await deadline(echo,'echo'),'hello');await new Promise(r=>setTimeout(r,25));const closed=new Promise(r=>ws.once('close',(c)=>r(c)));const revoked=await admin.call(`/api/tenants/${a}/desktop/devices/${deviceId}`,{method:'DELETE'});assert.equal(revoked.status,200,revoked.text);assert.equal(await deadline(closed,'revocation'),4001);await assert.rejects(connect(base,deviceToken),e=>e.status===401);
  const online=manager.billingProvider.usage({tenantId:a,meter:'desktop.device.online.seconds'});assert.equal(online.length,1);assert.ok(online[0].quantity>0);assert.equal(manager.billingProvider.usage({tenantId:b,meter:'desktop.device.online.seconds'}).length,0);
  const second=await pair(base,await code(admin,a));assert.equal(second.status,200,second.text);const live=await connect(base,second.json.deviceToken);const closed2=new Promise(r=>live.once('close',(c,reason)=>r({code:c,reason:String(reason)}))); manager.supervisor.status=status;const disabled=await admin.call(`/api/tenants/${a}/entries/desktop`,{method:'PUT',body:{enabled:false}});assert.equal(disabled.status,200,disabled.text);assert.deepEqual(await deadline(closed2,'disable'),{code:4003,reason:'ENTRY_DISABLED'});await assert.rejects(connect(base,second.json.deviceToken),e=>e.status===403);
});





