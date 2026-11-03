import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DesktopChannelClient } from '../modules/headless/desktop-channel.js';
import { MeterClient, entryForChat } from '../src/metering.js';
import { resolveChannels } from '../src/config.js';
import { validateMeter } from '../../cloud-manager/src/billing/provider.js';

const wait = ws => new Promise((resolve, reject) => { ws.once('message', x => resolve(JSON.parse(x))); ws.once('error', reject); });
const open = (url, headers) => new Promise((resolve, reject) => { const ws = new WebSocket(url, { headers }); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
test('desktop authorization, per-user delivery, replay and deduplication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-desktop-')); const server = http.createServer(); const events = [];
  const client = new DesktopChannelClient({ server, token: () => 'secret', onEvent: e => events.push(e), dataDir: dir });
  await client.connect(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `ws://127.0.0.1:${server.address().port}/channels/desktop/ws`;
  const headers = { 'x-console-token': 'secret', 'x-fish-device-id': 'ddev_1', 'x-fish-desktop-user': '7459086882832384' };
  await assert.rejects(open(url, { ...headers, 'x-console-token': 'wrong' }));
  const ws = await open(url, headers); let next = wait(ws); ws.send(JSON.stringify({v:1,op:'hello',d:{deviceId:'ddev_1',resumeSeq:0}})); assert.equal((await next).op,'ready');
  const send = {v:1,op:'msg.send',id:'one',d:{segments:[{type:'text',data:{text:'hello'}}]}};
  next=wait(ws); ws.send(JSON.stringify(send)); const ack=await next; assert.equal(ack.op,'msg.ack');
  next=wait(ws); ws.send(JSON.stringify(send)); assert.equal((await next).d.messageId,ack.d.messageId); assert.equal(events.length,1);
  next=wait(ws); await client.sendText('private',headers['x-fish-desktop-user'],'reply'); assert.equal((await next).op,'msg.push');
  ws.close(); client.close(); await new Promise(r => server.close(r));
  const server2 = http.createServer(); const client2 = new DesktopChannelClient({server:server2,token:()=> 'secret',onEvent:()=>{},dataDir:dir}); await client2.connect(); await new Promise(r=>server2.listen(0,'127.0.0.1',r));
  const ws2=await open(`ws://127.0.0.1:${server2.address().port}/channels/desktop/ws`,headers); const replay=[]; ws2.on('message',raw=>replay.push(JSON.parse(raw))); next=wait(ws2); ws2.send(JSON.stringify({v:1,op:'hello',d:{resumeSeq:0}})); assert.equal((await next).d.replay.length,0); await until(()=>replay.some(x=>x.op==='msg.push')); assert.equal(replay.filter(x=>x.op==='msg.push').length,1);
  ws2.close(); client2.close(); await new Promise(r=>server2.close(r)); fs.rmSync(dir,{recursive:true,force:true});
});
test('range migration and metering retries retain event identity', async () => {
  const channels=resolveChannels({channels:{bili:{idRange:{start:2**52,end:Number.MAX_SAFE_INTEGER}}}}); assert.equal(channels.bili.idRange.end,7318349394477055); assert.throws(()=>resolveChannels({channels:{desktop:{idRange:{start:1,end:3}}}}));
  assert.equal(entryForChat('private:qqbot_user_abc',null),'qq_official');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-meter-')); const old=process.env.QQ_AGENT_CLOUD; process.env.QQ_AGENT_CLOUD='1'; let attempts=[];
  const api={baseUrl:'http://127.0.0.1:8790/v1',apiKey:'sk-fish-test'}; const m=new MeterClient({api,dataDir:dir,fetchImpl:async (_url,opt)=>{attempts.push(JSON.parse(opt.body));return {ok: attempts.length>1,status:500,json:async()=>({accepted:attempts.at(-1).events.length,duplicates:0})};}});
  m.record('desktop','desktop.message.in',{chatKey:'private:7459086882832384'}); await m.flush(); await m.flush(); assert.equal(attempts[0].events[0].idempotencyKey,attempts[1].events[0].idempotencyKey); assert.equal(m.events.length,0); m.close(); if(old===undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD=old; fs.rmSync(dir,{recursive:true,force:true});
});

test('full meter queue spills durably and replays ambiguous deliveries after restart without loss', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-meter-spill-'));
  const clients = [];
  t.after(() => { for (const client of clients) client.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const previous = process.env.QQ_AGENT_CLOUD;
  process.env.QQ_AGENT_CLOUD = '1';
  t.after(() => { if (previous === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = previous; });
  const accepted = new Set(), requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const { events } = JSON.parse(body); requests.push(events);
    const before = accepted.size;
    for (const event of events) accepted.add(event.idempotencyKey);
    if (requests.length === 1) { req.socket.destroy(); return; } // Accepted, but ACK lost.
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accepted: accepted.size - before, duplicates: events.length - (accepted.size - before) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const api = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-fish-fixture' };
  const first = new MeterClient({ api, dataDir, maxEvents: 2, intervalMs: 60000 });
  clients.push(first);
  for (let i = 1; i <= 5; i++) first.record('desktop', 'desktop.message.in', {}, `message-${i}`);
  assert.equal(first.events.length, 2);
  assert.equal(fs.readdirSync(first.overflowDir).filter(name => name.endsWith('.json')).length, 3);
  first.record('desktop', 'desktop.message.in', { repeated: true }, 'message-3');
  await first.flush();
  assert.equal(accepted.size, 5);
  assert.deepEqual(requests[0].find(event => event.idempotencyKey === 'message-3').attrs, {}, 'spilled retries preserve the original event');
  assert.equal(first.events.length, 2);
  first.close();
  const restarted = new MeterClient({ api, dataDir, maxEvents: 1, intervalMs: 60000 });
  clients.push(restarted);
  assert.equal(restarted.events.length, 2, 'lower memory threshold must not truncate previously persisted events');
  await restarted.flush();
  assert.equal(requests.length, 2);
  const ordered = events => [...events].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
  assert.deepEqual(ordered(requests[1]), ordered(requests[0]), 'all retries keep payload and identity');
  assert.equal(accepted.size, 5);
  assert.equal(restarted.events.length, 0);
  assert.equal(fs.readdirSync(restarted.overflowDir).length, 0);
  restarted.fetch = () => { throw new Error('synchronous fixture failure'); };
  restarted.record('desktop', 'desktop.message.in', {}, 'message-6');
  await restarted.flush(); assert.equal(restarted.pending, null);
  await restarted.flush(); assert.equal(restarted.pending, null);
});

test('corrupt meter spool is preserved instead of overwritten as an empty queue', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-meter-corrupt-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const previous = process.env.QQ_AGENT_CLOUD;
  process.env.QQ_AGENT_CLOUD = '1';
  t.after(() => { if (previous === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = previous; });
  const file = path.join(dataDir, 'meter-spool.json');
  for (const contents of ['{broken', '[null]', '[{"secret":"PRIVATE_FIXTURE"}]', 'PRIVATE_FIXTURE']) {
    fs.writeFileSync(file, contents);
    assert.throws(() => new MeterClient({ api: { baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-fish-fixture' }, dataDir }), error => {
      assert.match(error.message, /original file preserved/);
      assert.doesNotMatch(String(error.stack), /PRIVATE_FIXTURE/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
});

test('meter retries require a complete acknowledgement and sanitize attributes and failure logs', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-meter-ack-'));
  const previous = process.env.QQ_AGENT_CLOUD; process.env.QQ_AGENT_CLOUD = '1';
  const logs = [], attempts = [];
  const client = new MeterClient({ dataDir, api: { baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-fish-fixture' },
    log: line => logs.push(line), intervalMs: 60000,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      const batch = JSON.parse(options.body).events; attempts.push(batch);
      for (const event of batch) validateMeter(event, { client: true, tenantId: 'tenant-fixture' });
      const attempt = attempts.length;
      return { ok: true, json: async () => {
        if (attempt === 1) throw new Error('Unexpected JSON content PRIVATE_FIXTURE');
        if (attempt === 2) return { ok: true };
        if (attempt === 3) return { accepted: 0, duplicates: 0 };
        return { accepted: batch.length, duplicates: 0 };
      } };
    } });
  t.after(() => { client.close(); fs.rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = previous; });
  client.record('desktop', 'desktop.message.in', { messageId: 'm'.repeat(300), chatKey: 'private:7459086882832384', accessToken: 'PRIVATE_FIXTURE', promptTokens: 'PRIVATE_FIXTURE', calls: Infinity }, 'ack-fixture');
  for (let i = 0; i < 3; i++) { await client.flush(); assert.equal(client.events.length, 1); assert.equal(JSON.parse(fs.readFileSync(client.file, 'utf8')).length, 1); }
  await client.flush(); assert.equal(client.events.length, 0);
  assert.equal(attempts.length, 4); assert.deepEqual(attempts[0], attempts[3]);
  assert.deepEqual(attempts[0][0].attrs, { messageId: 'm'.repeat(256), chatKey: 'private:7459086882832384' });
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_FIXTURE/);
});

test('meter spool write failure retains the event in memory until persistence recovers', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-meter-write-'));
  const previous = process.env.QQ_AGENT_CLOUD; process.env.QQ_AGENT_CLOUD = '1';
  const api = { baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-fish-fixture' }, logs = [];
  const client = new MeterClient({ dataDir, api, log: line => logs.push(line), intervalMs: 60000 });
  t.after(() => { client.close(); fs.rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = previous; });
  fs.mkdirSync(client.file);
  client.record('desktop', 'desktop.message.in', {}, 'write-failure');
  assert.equal(client.events.length, 1);
  assert.ok(logs.some(line => line.includes('spool write failed')));
  fs.rmdirSync(client.file);
  client.close();
  const restarted = new MeterClient({ dataDir, api, intervalMs: 60000 });
  assert.equal(restarted.events[0].idempotencyKey, 'write-failure');
  restarted.close();
});

test('corrupt overflow records are retained for repair without blocking valid events', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-meter-quarantine-'));
  const previous = process.env.QQ_AGENT_CLOUD; process.env.QQ_AGENT_CLOUD = '1';
  const delivered = [], logs = [];
  const client = new MeterClient({ dataDir, maxEvents: 1, intervalMs: 60000,
    api: { baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-fish-fixture' }, log: line => logs.push(line),
    fetchImpl: async (_url, options) => {
      const events = JSON.parse(options.body).events; delivered.push(...events);
      for (const event of events) validateMeter(event, { client: true, tenantId: 'tenant-fixture' });
      return { ok: true, json: async () => ({ accepted: events.length, duplicates: 0 }) };
    } });
  t.after(() => { client.close(); fs.rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = previous; });
  client.record('desktop', 'desktop.message.in', {}, 'main');
  client.record('desktop', 'desktop.message.in', {}, 'spill');
  const broken = path.join(client.overflowDir, 'a'.repeat(64) + '.json');
  fs.writeFileSync(broken, 'PRIVATE_FIXTURE');
  const malformed = path.join(client.overflowDir, 'b'.repeat(64) + '.json');
  fs.writeFileSync(malformed, 'null');
  await client.flush();
  assert.deepEqual(delivered.map(e => e.idempotencyKey).sort(), ['main', 'spill']);
  assert.equal(client.events.length, 0);
  assert.equal(fs.readFileSync(broken + '.invalid', 'utf8'), 'PRIVATE_FIXTURE');
  assert.equal(fs.readFileSync(malformed + '.invalid', 'utf8'), 'null');
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_FIXTURE/);
});
test('desktop segments are bounded and replies cannot cross user sessions', () => {
  const client = new DesktopChannelClient({server:http.createServer(),token:()=> 'x',onEvent:()=>{}});
  const a = {seen:new Map([['a','message-a']]),outbox:[]}; const b = {seen:new Map([['b','message-b']]),outbox:[]};
  const reply = [{type:'reply',data:{id:'message-a'}}]; assert.equal(client.validateSegments(a,reply),true); assert.equal(client.validateSegments(b,reply),false);
  assert.equal(client.validateSegments(a,[{type:'face',data:{id:'123'}}]),true);
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47]),Buffer.alloc(30)]).toString('base64');
  assert.equal(client.validateSegments(a,[{type:'image',data:{file:`base64://${png}`}}]),true);
  for (const file of ['file:///etc/passwd','http://127.0.0.1/a','base64://aGVsbG8=']) assert.equal(client.validateSegments(a,[{type:'image',data:{file}}]),false);
  const huge=Buffer.alloc(2*1024*1024+1); huge.set([0x89,0x50,0x4e,0x47]); assert.equal(client.validateSegments(a,[{type:'image',data:{file:`base64://${huge.toString('base64')}`}}]),false);
});
test('relay requests attribute official and desktop sessions', async () => {
  const { chatCompletion } = await import('../src/llm.js'); const requests=[];
  const server=http.createServer(async (req,res)=>{let data='';for await(const chunk of req)data+=chunk;requests.push(JSON.parse(data));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fake',model:'local-test',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const old=process.env.QQ_AGENT_CLOUD;process.env.QQ_AGENT_CLOUD='1';const overrides={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'sk-fish-test',model:'local-test',provider:'openai'};
  try { for(const [platform,chatKey] of [['qq','private:qqbot_user_ABC123'],['desktop','private:7459086882832384']]) await chatCompletion({messages:[{role:'user',content:'hi'}],overrides,skillContext:{platform,chatKey,runId:'test-run'}}); assert.deepEqual(requests.map(x=>x._fish_attribution.platform),['qqbot','desktop']); }
  finally {if(old===undefined)delete process.env.QQ_AGENT_CLOUD;else process.env.QQ_AGENT_CLOUD=old;await new Promise(r=>server.close(r));}
});
test('desktop identifies only the bot itself', async () => {
  const client=new DesktopChannelClient({server:http.createServer(),token:()=> 'x',onEvent:()=>{}});
  assert.equal((await client.call('get_stranger_info',{user_id:client.selfId})).user_id,client.selfId);
  await assert.rejects(client.call('get_stranger_info',{user_id:'7459086882832384'}));
});

async function until(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('desktop condition timed out');
}
async function desktopFixture(t, onEvent = () => {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-review-'));
  const server = http.createServer();
  const client = new DesktopChannelClient({ server, dataDir, token: () => 'test-secret', onEvent });
  await client.connect(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const headers = { 'x-console-token': 'test-secret', 'x-fish-device-id': 'ddev_test', 'x-fish-desktop-user': '7459086882832384' };
  const peers = new Set();
  t.after(async () => { for (const ws of peers) ws.terminate(); client.close(); await new Promise(r => server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const connect = async (hello = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/channels/desktop/ws`, { headers, maxPayload: 3 * 1024 * 1024 });
    peers.add(ws); const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw))); ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    if (hello) { ws.send(JSON.stringify({ v: 1, op: 'hello', d: { resumeSeq: 0 } })); await until(() => messages.some(x => x.op === 'ready')); }
    return { ws, messages };
  };
  return { client, connect, dataDir, id: headers['x-fish-desktop-user'] };
}

test('desktop rejects null and binary frames without crashing the agent', async t => {
  const { connect } = await desktopFixture(t);
  for (const [payload, expected] of [['null', 1008], [Buffer.from('{}'), 1003]]) {
    const { ws } = await connect(); const closed = new Promise(r => ws.once('close', r));
    ws.send(payload); assert.equal(await closed, expected);
  }
  const { ws } = await connect(); assert.equal(ws.readyState, WebSocket.OPEN);
});

test('image replay stays within frame limits and no live message overtakes hello/replay', async t => {
  const { client, connect, id } = await desktopFixture(t);
  const initial = await connect(); initial.ws.terminate();
  const bytes = Buffer.alloc(1300 * 1024); bytes.set([0x89, 0x50, 0x4e, 0x47]);
  const message = [{ type: 'image', data: { file: 'base64://' + bytes.toString('base64') } }];
  await client.call('send_private_msg', { user_id: id, message });
  await client.call('send_private_msg', { user_id: id, message });
  const { ws, messages } = await connect(false);
  await client.sendText('private', id, 'arrived before hello');
  await new Promise(r => setTimeout(r, 25)); assert.deepEqual(messages, []);
  ws.send(JSON.stringify({ v: 1, op: 'hello', d: { resumeSeq: 0 } }));
  await until(() => messages.filter(x => x.op === 'msg.push').length === 3);
  assert.equal(messages[0].op, 'ready');
  assert.deepEqual(messages.filter(x => x.op === 'msg.push').map(x => x.seq), [1, 2, 3]);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('outbox disk failures cannot acknowledge a sent reply or re-ingest an accepted input', async t => {
  let ingested = 0;
  const { client, connect, id } = await desktopFixture(t, () => { ingested++; });
  const { ws, messages } = await connect();
  const persist = client.persist.bind(client); client.persist = () => { throw new Error('disk full'); };
  await assert.rejects(client.sendText('private', id, 'must remain unsent'), /disk full/);
  assert.equal(client.users.get(id).seq, 0); assert.equal(client.users.get(id).outbox.length, 0);
  const input = JSON.stringify({ v: 1, op: 'msg.send', id: 'stable', d: { segments: [{ type: 'text', data: { text: 'once' } }] } });
  ws.send(input); await until(() => messages.some(x => x.d?.code === 'INGEST_FAILED'));
  assert.equal(messages.filter(x => x.op === 'msg.ack').length, 0);
  client.persist = persist; ws.send(input); await until(() => messages.some(x => x.op === 'msg.ack'));
  assert.equal(ingested, 1);
  assert.ok(fs.existsSync(client.file));
});

test('negotiated recovery, durable receipt and input history survive restart and isolate devices', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-recovery-'));
  const servers = [], clients = [], sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); for (const c of clients) c.close(); for (const s of servers) await new Promise(r => s.close(r)); fs.rmSync(dir, {recursive:true,force:true}); });
  let events = 0, release; const gate = new Promise(r => { release = r; });
  async function start(onEvent) { const server=http.createServer(), client=new DesktopChannelClient({server,dataDir:dir,token:()=> 'secret',onEvent}); servers.push(server); clients.push(client); await client.connect(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); return {client,url:`ws://127.0.0.1:${server.address().port}/channels/desktop/ws`}; }
  const headers={ 'x-console-token':'secret','x-fish-device-id':'d1','x-fish-desktop-user':'7459086882832384' };
  async function attach(url, hdr=headers, data={}) { const ws=await open(url,hdr); sockets.push(ws); const frames=[]; ws.on('message',x=>frames.push(JSON.parse(x))); ws.send(JSON.stringify({v:1,op:'hello',d:{capabilities:['recovery.v1','receipt.v1','input-history.v1'],...data}})); await until(()=>frames.some(x=>x.op==='input.replay.end')); return {ws,frames}; }
  const first=await start(async()=>{events++; await gate;}); const a=await attach(first.url); const ready=a.frames.find(x=>x.op==='ready').d; assert.equal(ready.receiptRetention.noTimeGuarantee,true); assert.ok(ready.epoch); assert.equal(ready.replayFrom,1); assert.equal(ready.replayTo,0); assert.equal(ready.inputReplayFrom,1); assert.equal(ready.inputReplayTo,0); assert.equal(a.frames.find(x=>x.op==='replay.end').d.serverSeq,0); assert.equal(a.frames.find(x=>x.op==='input.replay.end').d.epoch,ready.epoch);
  const msg={v:1,op:'msg.send',id:'same',d:{segments:[{type:'text',data:{text:'hello'}}]}}; a.ws.send(JSON.stringify(msg)); await until(()=>events===1);
  const b=await attach(first.url); b.ws.send(JSON.stringify(msg)); await until(()=>b.frames.some(x=>x.d?.code==='IN_PROGRESS')); assert.equal(b.frames.find(x=>x.d?.code==='IN_PROGRESS').d.id,'same'); const querying=await attach(first.url); querying.ws.send(JSON.stringify({v:1,op:'msg.status',id:'same'})); await until(()=>querying.frames.some(x=>x.op==='msg.status')); assert.equal(querying.frames.find(x=>x.op==='msg.status').d.status,'in_progress'); release(); await until(()=>querying.frames.some(x=>x.op==='msg.ack')); await until(()=>b.frames.some(x=>x.op==='msg.ack')); await until(()=>a.frames.some(x=>x.op==='input.push')); const input=a.frames.find(x=>x.op==='input.push'); assert.equal(input.d.deviceId,'d1'); assert.equal(input.d.clientMessageId,'same');
  b.ws.send(JSON.stringify({v:1,op:'msg.status',id:'same'})); await until(()=>b.frames.some(x=>x.op==='msg.status')); assert.equal(b.frames.find(x=>x.op==='msg.status').d.status,'accepted');
  const other=await attach(first.url,{...headers,'x-fish-device-id':'d2'}); other.ws.send(JSON.stringify({v:1,op:'msg.status',id:'same'})); await until(()=>other.frames.some(x=>x.op==='msg.status')); assert.equal(other.frames.find(x=>x.op==='msg.status').d.status,'unknown');
  first.client.close(); await new Promise(r=>servers[0].close(r)); servers.shift(); clients.shift();
  const second=await start(()=>{throw Error('must not re-ingest');}); const c=await attach(second.url,headers,{epoch:ready.epoch}); assert.equal(c.frames[0].d.epoch,ready.epoch); assert.equal(c.frames.find(x=>x.op==='input.push').inputSeq,1); c.ws.send(JSON.stringify({v:1,op:'msg.status',id:'same'})); await until(()=>c.frames.some(x=>x.op==='msg.status')); assert.equal(c.frames.find(x=>x.op==='msg.status').d.status,'accepted');
  const invalid=await open(second.url,headers); sockets.push(invalid); const bad=[]; invalid.on('message',x=>bad.push(JSON.parse(x))); const closed=new Promise(r=>invalid.once('close',r)); invalid.send(JSON.stringify({v:1,op:'hello',d:{capabilities:['recovery.v1'],epoch:'wrong'}})); assert.equal(await closed,1008); assert.equal(bad[0].d.code,'RESUME_INVALID');
});

test('desktop refuses corrupt and non-monotonic persisted state', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-corrupt-recovery-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for (const outbox of [[{op:'msg.push',seq:2},{op:'msg.push',seq:1}],[{op:'msg.push',seq:3}]]) {
    fs.writeFileSync(path.join(dir,'desktop-outbox.json'),JSON.stringify({'7459086882832384':{seq:2,outbox,seen:[]}}));
    assert.throws(()=>new DesktopChannelClient({server:http.createServer(),token:()=>'',onEvent:()=>{},dataDir:dir}),/Cannot read desktop outbox/);
  }
});

test('trimmed replay reports an ordered gap while legacy clients receive no new operations', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-replay-gap-')); const now=Date.now();
  fs.writeFileSync(path.join(dir,'desktop-outbox.json'),JSON.stringify({'7459086882832384':{seq:4,epoch:'epoch-fixture',seen:[],outbox:[3,4].map(seq=>({v:1,op:'msg.push',seq,ts:now,d:{messageId:String(seq),segments:[{type:'text',data:{text:String(seq)}}]}}))}}));
  const server=http.createServer(), client=new DesktopChannelClient({server,dataDir:dir,token:()=> 'secret',onEvent:()=>{}}); await client.connect(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const sockets=[]; t.after(async()=>{for(const ws of sockets)ws.terminate();client.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const url=`ws://127.0.0.1:${server.address().port}/channels/desktop/ws`,headers={'x-console-token':'secret','x-fish-device-id':'d1','x-fish-desktop-user':'7459086882832384'};
  async function connectWith(d) { const ws=await open(url,headers);sockets.push(ws);const frames=[];ws.on('message',x=>frames.push(JSON.parse(x)));ws.send(JSON.stringify({v:1,op:'hello',d}));return frames; }
  const modern=await connectWith({resumeSeq:0,capabilities:['recovery.v1']});await until(()=>modern.some(x=>x.op==='replay.end'));assert.deepEqual(modern.map(x=>x.op),['ready','msg.push','msg.push','replay.end']);assert.deepEqual(modern.filter(x=>x.op==='msg.push').map(x=>x.seq),[3,4]);assert.equal(modern[0].d.hasGap,true);assert.equal(modern[0].d.oldestSeq,3);assert.deepEqual(modern[0].d.capabilities,['recovery.v1']);
  const legacy=await connectWith({resumeSeq:0});await until(()=>legacy.length===3);assert.deepEqual(legacy.map(x=>x.op),['ready','msg.push','msg.push']);
});

test('a later successful write commits previously dirty input and receipt consistently', async t => {
  const { client, connect } = await desktopFixture(t, () => {});
  async function attach() { const peer=await connect(false); peer.ws.send(JSON.stringify({v:1,op:'hello',d:{capabilities:['recovery.v1','receipt.v1','input-history.v1']}})); await until(()=>peer.messages.some(x=>x.op==='input.replay.end')); return peer; }
  const a=await attach(); const persist=client.persist.bind(client);client.persist=()=>{throw Error('disk full');};
  a.ws.send(JSON.stringify({v:1,op:'msg.send',id:'dirty',d:{segments:[{type:'text',data:{text:'test'}}]}}));await until(()=>a.messages.some(x=>x.d?.code==='INGEST_FAILED'));
  a.ws.send(JSON.stringify({v:1,op:'msg.status',id:'dirty'}));await until(()=>a.messages.some(x=>x.op==='msg.status'));assert.equal(a.messages.find(x=>x.op==='msg.status').d.status,'unknown');assert.equal(a.messages.some(x=>x.op==='input.push'),false);
  client.persist=persist;const b=await attach();await until(()=>a.messages.some(x=>x.op==='input.push'));assert.equal(b.messages.filter(x=>x.op==='input.push').length,1);
  b.ws.send(JSON.stringify({v:1,op:'msg.status',id:'dirty'}));await until(()=>b.messages.some(x=>x.op==='msg.status'));assert.equal(b.messages.find(x=>x.op==='msg.status').d.status,'accepted');
});

test('input history size is checked at the exact wire boundary before ingestion', async t => {
  let events=0; const {client,connect,id}=await desktopFixture(t,()=>{events++;}); const {ws,messages}=await connect(false);
  ws.send(JSON.stringify({v:1,op:'hello',d:{capabilities:['input-history.v1']}})); await until(()=>messages.some(x=>x.op==='input.replay.end'));
  const image = n => { const bytes=Buffer.alloc(n);bytes.set([0x89,0x50,0x4e,0x47]);return {type:'image',data:{file:'base64://'+bytes.toString('base64')}}; };
  const segments=[image(1200000),image(1156000),{type:'text',data:{text:''}}]; const clientId='border';
  const {createHash}=await import('node:crypto'); const messageId='desktop-'+createHash('sha256').update(id+':ddev_test:'+clientId).digest('hex');
  const push={v:1,op:'input.push',inputSeq:1,ts:Date.now(),d:{messageId,segments,deviceId:'ddev_test',clientMessageId:clientId}};
  const remaining=3*1024*1024-Buffer.byteLength(JSON.stringify(push));assert.ok(remaining>0&&remaining<10000);segments[2].data.text='x'.repeat(remaining+1);
  const outgoing=()=>JSON.stringify({v:1,op:'msg.send',id:clientId,d:{segments}});assert.ok(Buffer.byteLength(outgoing())<=3*1024*1024); assert.equal(Buffer.byteLength(JSON.stringify(push)),3*1024*1024+1);
  ws.send(outgoing());await until(()=>messages.some(x=>x.d?.code==='INVALID_SEGMENTS'));assert.equal(events,0);assert.equal(client.users.get(id).inputSeq,0);assert.equal(client.users.get(id).seen.size,0);
  segments[2].data.text=segments[2].data.text.slice(1);assert.equal(Buffer.byteLength(JSON.stringify(push)),3*1024*1024);ws.send(outgoing());await until(()=>messages.some(x=>x.op==='msg.ack'));assert.equal(events,1);assert.equal(Buffer.byteLength(JSON.stringify(messages.find(x=>x.op==='input.push'))),3*1024*1024);
});

test('slow input bounds pending request count without disrupting accepted work', async t => {
  let release;const gate=new Promise(r=>{release=r;});let events=0;
  const {client,connect,id}=await desktopFixture(t,async()=>{events++;if(events===1)await gate;});const {ws,messages}=await connect();
  t.after(()=>release());
  const make=n=>JSON.stringify({v:1,op:'msg.send',id:'n'+n,d:{segments:[{type:'text',data:{text:'x'}}]}});
  ws.send(make(0));await until(()=>events===1);
  for(let n=1;n<=100;n++)ws.send(make(n));
  await until(()=>messages.some(x=>x.d?.id==='n100'&&x.d.code==='INGEST_FAILED'));
  assert.equal(client.users.get(id).pending.size,100);assert.equal(events,1);
  release();await until(()=>messages.filter(x=>x.op==='msg.ack').length===100);assert.equal(events,100);assert.equal(client.users.get(id).pending.size,0);assert.equal(client.users.get(id).pendingBytes,0);
});

test('slow input bounds queued bytes across sockets', async t => {
  let release;const gate=new Promise(r=>{release=r;});let events=0;
  const {client,connect,id}=await desktopFixture(t,async()=>{events++;if(events===1)await gate;});const a=await connect(),b=await connect();t.after(()=>release());
  const make=(name,segments)=>JSON.stringify({v:1,op:'msg.send',id:name,d:{segments}});
  a.ws.send(make('first',[{type:'text',data:{text:'x'}}]));await until(()=>events===1);
  const data=Buffer.alloc(2*1024*1024);data.set([0x89,0x50,0x4e,0x47]);const segments=[{type:'image',data:{file:'base64://'+data.toString('base64')}}];
  a.ws.send(make('large1',segments));b.ws.send(make('large2',segments));a.ws.send(make('large3',segments));
  await until(()=>[...a.messages,...b.messages].some(x=>x.d?.code==='INGEST_FAILED'&&x.d?.id?.startsWith('large')));
  assert.equal(events,1);assert.ok(client.users.get(id).pendingBytes<=8*1024*1024);release();await until(()=>client.users.get(id).pending.size===0);assert.equal(events,3);assert.equal(client.users.get(id).pendingBytes,0);
});
