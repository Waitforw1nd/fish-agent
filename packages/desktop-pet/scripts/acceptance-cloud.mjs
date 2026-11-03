import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { makeConfig, Client, request, waitFor } from '../../cloud-manager/test/helpers.mjs';
import { CloudManager } from '../../cloud-manager/src/app.js';
import { REPO_ROOT } from '../../cloud-manager/src/config.js';
import { pairDevice, PetConnection } from '../src/client.js';
const { WebSocket } = createRequire(new URL('../../cloud-manager/test/helpers.mjs', import.meta.url))('ws');

const check = process.argv.includes('--check');
const password = crypto.randomBytes(18).toString('base64url');
let manager, model, configState, tenantId;
let cleaning = false;
const clients = new Set();
const startedPids = new Set();

function expect(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: HTTP ${response.status} ${response.text}`);
  return response.json;
}
async function localModel() {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-fixture-key') { res.writeHead(401).end(); return; }
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] })); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); calls++;
      const lastUser = body.messages.findLastIndex(m => m.role === 'user');
      const done = body.messages.slice(lastUser + 1).some(m => m.role === 'tool' && m.name === 'send_message');
      const name = done ? 'finish' : 'send_message';
      const args = done ? { reason: 'done' } : { messages: [`本地验收模型回复：你好！(${calls})`] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `local-${calls}`, model: 'deepseek-chat', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { base: `http://127.0.0.1:${server.address().port}`, get calls() { return calls; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function runCheck(base, admin) {
  async function pair(name) {
    const code = expect(await admin.call(`/api/tenants/${tenantId}/desktop/pairing-codes`, { method: 'POST' }), 201, 'create code');
    assert.equal(code.host, base);
    const device = await pairDevice({ host: base, code: code.code, deviceName: name, os: 'win32' });
    assert.equal(device.wsUrl, base.replace('http:', 'ws:') + '/desktop/v1/ws');
    return device;
  }
  function client(device, state = {}) {
    let saved; const statuses = [], fault = {dropAck:false,dropped:0};
    // Test-only transport fault: the real gateway/agent still process the input,
    // but this client loses its ACK. No production network behavior is replaced.
    class CheckSocket extends WebSocket {
      emit(name,...args) {
        if(name==='message'&&fault.dropAck){let frame;try{frame=JSON.parse(String(args[0]));}catch{}if(frame?.op==='msg.ack'){fault.dropped++;return true;}}
        return super.emit(name,...args);
      }
    }
    const connection = new PetConnection({ credentials: device, WebSocket:CheckSocket, state, save: value => { saved = structuredClone(value); }, random: () => 0 });
    clients.add(connection); connection.on('status', status => statuses.push(status));
    connection.connect();
    return { connection, statuses, fault, get saved() { return saved; } };
  }
  const device = await pair('acceptance one'), device2 = await pair('acceptance two');
  const first = client(device), second = client(device2);
  await waitFor(() => first.connection.ready && second.connection.ready && !first.connection.recovering && !second.connection.recovering, { label: 'both clients ready' });
  assert.equal(first.connection.capabilities.size,3);assert.ok(first.connection.epoch);
  for (let i = 1; i <= 3; i++) {
    const input = `你好 ${i}`, id = first.connection.sendText(input);
    await waitFor(() => first.connection.messages.find(m => m.id === id && m.sendState === 'accepted'), { timeoutMs: 15000, label: `message ack ${i}` });
    const reply = await waitFor(() => first.connection.messages.filter(m => m.role === 'assistant')[i - 1], { timeoutMs: 20000, label: `model reply ${i}` });
    assert.match(JSON.stringify(reply.segments), /本地验收模型回复/);
    await waitFor(() => second.connection.messages.find(m => m.role === 'user' && JSON.stringify(m.segments).includes(input)), { label: `second device echo ${i}` });
  }
  assert.ok(model.calls >= 3);
  const otherId = second.connection.sendText('第二台设备发来的消息');
  await waitFor(() => second.connection.messages.find(m => m.id === otherId && m.sendState === 'accepted'), { timeoutMs: 15000, label: 'second device ack' });
  await waitFor(() => first.connection.messages.find(m => m.role === 'user' && JSON.stringify(m.segments).includes('第二台设备发来的消息')), { label: 'first device echo' });
  await waitFor(() => first.connection.messages.filter(m => m.role === 'assistant').length === 4, { timeoutMs: 20000, label: 'second device reply' });
  const before = first.connection.snapshot(), connectedCount = first.statuses.filter(x => x === 'connected').length;
  for (const c of [...manager.desktopGateway.connections]) if (c.deviceId === device.deviceId) c.close(1012);
  await waitFor(() => first.connection.currentStatus==='disconnected', { label:'injected disconnect' });
  const queuedId=first.connection.sendText('断线期间排队，只发送一次');
  await waitFor(() => first.statuses.filter(x => x === 'connected').length > connectedCount && first.connection.ready && first.connection.messages.find(m=>m.id===queuedId&&m.sendState==='accepted'), { timeoutMs: 15000, label: 'automatic reconnect and queued send' });
  await waitFor(() => first.connection.messages.filter(m=>m.role==='assistant').length===5,{timeoutMs:20000,label:'queued reply'});
  assert.deepEqual(first.connection.messages.filter(m => m.role === 'assistant').slice(0,4), before.messages.filter(m => m.role === 'assistant'));
  assert.ok(first.saved); // The check only saves snapshots in memory, never as credentials on disk.
  const offlineState=first.connection.snapshot();
  first.connection.stop();
  const offlineId=second.connection.sendText('第一台离线时的用户消息');
  await waitFor(()=>second.connection.messages.find(m=>m.id===offlineId&&m.sendState==='accepted')&&second.connection.messages.filter(m=>m.role==='assistant').length===6,{timeoutMs:20000,label:'other device while offline'});
  const replay = client(device, offlineState);
  await waitFor(() => replay.connection.ready && replay.connection.seq === second.connection.seq && !replay.connection.recovering, { timeoutMs: 12000, label: 'output and input replay' });
  assert.equal(replay.connection.messages.filter(m=>m.role==='user'&&JSON.stringify(m.segments).includes('第一台离线')).length,1);
  replay.fault.dropAck=true;const ambiguousId=replay.connection.sendText('模拟确认丢失，不重复调用模型');
  await waitFor(()=>replay.fault.dropped===1&&replay.connection.messages.filter(m=>m.role==='assistant').length===7&&model.calls===14,{timeoutMs:20000,label:'ACK loss after real processing'});
  const ambiguousState=replay.connection.snapshot();assert.equal(ambiguousState.pending[0].id,ambiguousId);
  replay.connection.stop();const callsBefore=model.calls;
  const recovered=client(device,ambiguousState);
  await waitFor(()=>!recovered.connection.recovering&&recovered.connection.messages.find(m=>m.id===ambiguousId&&m.sendState==='accepted'),{timeoutMs:12000,label:'durable receipt query after restart'});
  assert.equal(recovered.connection.pending.length,0);assert.equal(model.calls,callsBefore);
  assert.equal(recovered.connection.messages.filter(m=>m.role==='user').length,7);
  const allHistory=client(device,{seq:0,inputSeq:0,pending:[],messages:[]});
  await waitFor(()=>allHistory.connection.ready&&!allHistory.connection.recovering&&allHistory.connection.seq===recovered.connection.seq,{timeoutMs:12000,label:'full retained history from zero'});
  assert.equal(allHistory.connection.messages.filter(m=>m.role==='user').length,7);
  assert.equal(allHistory.connection.messages.filter(m=>m.role==='assistant').length,7);
  await waitFor(()=>manager.billingProvider.usage({tenantId,meter:'desktop.message.out'})[0]?.quantity===7,{timeoutMs:10000,label:'all desktop meters'});
  const ledger=manager.db.prepare('SELECT * FROM ledger WHERE tenant_id=?').all(tenantId);
  assert.equal(ledger.length,14);assert.ok(ledger.every(row=>row.entry==='desktop'&&row.platform==='desktop'));
  assert.equal(manager.billingProvider.usage({tenantId,meter:'desktop.message.in'})[0].quantity,7);
  assert.equal(manager.billingProvider.usage({tenantId,meter:'desktop.llm.tokens'})[0].quantity,350);
  expect(await admin.call(`/api/tenants/${tenantId}/desktop/devices/${device.deviceId}`, { method: 'DELETE' }), 200, 'revoke');
  await waitFor(() => recovered.connection.currentStatus === 'revoked' && recovered.connection.stopped && allHistory.connection.stopped, { label: 'revoked clients stopped' });
  assert.equal(recovered.connection.timer, null);second.connection.stop();manager.desktopGateway.flushMeters();
  const usage=expect(await admin.call(`/api/tenants/${tenantId}/billing/entries/desktop/usage`),200,'desktop usage');
  assert.ok(usage.usage.some(row=>row.meter==='desktop.device.online.seconds'&&row.quantity>0));
  console.log('CHECK PASS: client pair, three ack/replies, two-device echo, reconnect/replay, revoke');
  console.log('RECOVERY PASS: queued resend, offline input history, lost ACK restart receipt, no duplicate model call');
  console.log('METER PASS: desktop in=7 out=7 ledger=14 tokens=350; online seconds and usage API verified');
}
async function cleanup() {
  if (cleaning) return; cleaning = true;
  for (const client of clients) client.stop();
  try { await manager?.stop(); } finally {
    await model?.close();
    if (configState) {
      if (manager && !manager.stopped) throw new Error('Manager did not stop; temporary data retained: ' + configState.dataDir);
      for(const pid of startedPids) assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH',`started process ${pid} must exit`);
      console.log('Processes stopped: '+[...startedPids].join(', '));
      await configState.releasePorts();
      const dir = path.resolve(configState.dataDir), parent = path.resolve(os.tmpdir());
      if (path.dirname(dir) !== parent || !path.basename(dir).startsWith('fish-cloud-test-')) throw new Error('Refusing unsafe cleanup: ' + dir);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('Temporary data removed: ' + dir);
    }
  }
}
try {
  model = await localModel();
  configState = await makeConfig({ adminPassword: password, baseDomain: '127.0.0.1', publicOrigin: 'http://127.0.0.1', agentEntry: path.join(REPO_ROOT, 'packages', 'qq-agent-core', 'modules', 'headless', 'server.js') });
  manager = new CloudManager({ config: configState.config }); await manager.start();
  const base = `http://127.0.0.1:${manager.config.panelPort}`;
  const panel = await request(base); if (panel.status !== 200 || !panel.text.includes('<html')) throw new Error('Panel assets unavailable');
  const panelScript = await request(base, { path: '/app.js' }); if (panelScript.status !== 200 || !panelScript.text.includes('createApi')) throw new Error('Panel script unavailable');
  const admin = new Client(base); expect(await admin.login('admin', password), 200, 'admin login');
  expect(await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: model.base, apiKey: 'local-fixture-key' } }), 200, 'configure model');
  const tenant = expect(await admin.createTenant({ name: '桌宠本地验收', slug: 'desktop-acceptance', planId: 'starter' }), 201, 'create tenant'); tenantId = tenant.tenant.id;
  expect(await admin.call(`/api/tenants/${tenantId}/entries/desktop`, { method: 'PUT', body: { enabled: true } }), 200, 'enable desktop');
  expect(await admin.startTenant(tenantId), 200, 'start tenant');
  const agentPid=manager.supervisor.status(tenantId,'agent').pid;if(agentPid)startedPids.add(agentPid);
  assert.equal(manager.supervisor.status(tenantId, 'qq').state, 'stopped');
  console.log(`PID: ${process.pid}\nPanel: ${base}/#/tenants/${tenantId}/hosting\nServer URL: ${base}\nTemporary admin: admin\nTemporary password: ${password}\nTemporary data: ${configState.dataDir}`);
  if (check) await runCheck(base, admin);
  else {
    console.log('Commands: status, disconnect, quit (or Ctrl+C). disconnect closes active desktop connections.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    await new Promise(resolve => {
      rl.on('line', line => {
        switch (line.trim().toLowerCase()) {
          case 'status': console.log(`Desktop connections: ${manager.desktopGateway.connections.size}; model calls: ${model.calls}`); break;
          case 'disconnect': { const connections = [...manager.desktopGateway.connections]; for (const c of connections) c.close(1012); console.log(`Disconnected ${connections.length} connection(s).`); break; }
          case 'quit': rl.close(); break;
          default: console.log('Commands: status, disconnect, quit');
        }
      });
      rl.on('close', resolve);
      process.once('SIGINT', () => rl.close()); process.once('SIGTERM', () => rl.close());
    });
  }
} catch (error) { console.error(error.stack || error); process.exitCode = 1; }
finally { try { await cleanup(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; } }

