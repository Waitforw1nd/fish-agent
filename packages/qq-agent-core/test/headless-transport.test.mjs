import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-protocol-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
process.env.QQ_AGENT_HOST = '127.0.0.1';
process.env.QQ_AGENT_PORT = '';
process.env.QQ_AGENT_TOKEN = '';
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { OneBotTransport: OneBotClient } = await import('../modules/headless/onebot.js');
const { QQBotClient } = await import('../modules/headless/qqbot.js');
const { BotConnection, validateConnection, CONNECTION_DEFAULTS, connectionConfig } = await import('../modules/headless/connection.js');
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { ChannelRouter } = await import('../src/channel-router.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label = 'condition') {
  for (let i = 0; i < 150; ++i) { if (await fn()) return; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function cleanupServer(t, server, wss) {
  t.after(() => { for (const ws of wss?.clients || []) ws.terminate(); wss?.close(); server.closeAllConnections(); server.close(); });
}
const answer = (ws, p, data, extra = {}) => ws.send(JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data, ...extra }));

test('real OneBot transports reject cross-entry events before archive or message attribution', async t => {
  const server = http.createServer(); const port = await listen(server);
  const wss = new WebSocketServer({ server }); cleanupServer(t, server, wss);
  const peers = new Map();
  wss.on('connection', (ws, req) => {
    peers.set(req.url.slice(1), ws);
    ws.on('message', raw => { const p = JSON.parse(raw); answer(ws, p, { user_id: req.url === '/qq' ? 42 : 4503599627370497, nickname: 'fixture' }); });
  });
  let router;
  const clients = Object.fromEntries(['qq', 'bili'].map(platform => [platform, new OneBotClient({
    wsUrl: `ws://127.0.0.1:${port}/${platform}`, apiTransport: 'ws',
    onEvent: event => router.dispatch(platform, event)
  })]));
  const seen = [];
  const channels = { qq: { enabled: true, client: clients.qq }, bili: { enabled: true, client: clients.bili } };
  router = new ChannelRouter({ channels, onEvent: (event, meta) => seen.push([event, meta.platform]) });
  t.after(() => router.close()); await router.connect(); await wait(() => peers.size === 2);
  const event = { post_type: 'message', message_type: 'private', user_id: 123456, message_id: 789, message: [{ type: 'text', data: { text: 'fixture' } }] };
  peers.get('bili').send(JSON.stringify(event));
  await sleep(100);
  assert.equal(seen.length, 0);
  assert.throws(() => router.platformForMessage(789), /无法判定/);
  peers.get('qq').send(JSON.stringify(event));
  await wait(() => seen.length === 1);
  assert.equal(seen[0][1], 'qq'); assert.equal(router.platformForMessage(789), 'qq');
  peers.get('bili').send(JSON.stringify({ ...event, user_id: 4503599627370516, message_id: 790 }));
  await wait(() => seen.length === 2); assert.equal(seen[1][1], 'bili');
});

test('OneBot forward WS: auth, concurrent echo, errors, timeouts and pending disconnect', async t => {
  const server = http.createServer();
  const port = await listen(server);
  const wss = new WebSocketServer({ server }); cleanupServer(t, server, wss);
  let peer;
  const requests = [];
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer test-onebot'); peer = ws;
    ws.on('message', raw => {
      const p = JSON.parse(raw); requests.push(p);
      if (p.action === 'get_login_info') answer(ws, p, { user_id: 42, nickname: 'fixture' });
      if (p.action === 'first') setTimeout(() => answer(ws, p, 'first'), 30);
      if (p.action === 'second') answer(ws, p, 'second');
      if (p.action === 'failure') answer(ws, p, null, { status: 'ok', retcode: 100 });
    });
  });
  const events = [];
  const client = new OneBotClient({ wsUrl: `ws://127.0.0.1:${port}`, apiTransport: 'ws', accessToken: 'test-onebot', onEvent: e => events.push(e) });
  t.after(() => client.close()); await client.connect();
  await wait(() => client.selfId === '42');
  assert.deepEqual(await Promise.all([client.call('first'), client.call('second')]), ['first', 'second']);
  assert.equal(events.length, 0, 'API responses do not become events');
  await assert.rejects(client.call('failure'), /retcode=100/);
  await assert.rejects(client.call('timeout', {}, 20), /timed out/);
  const pending = assert.rejects(client.call('pending'), /closed/);
  await wait(() => requests.some(p => p.action === 'pending'));
  peer.terminate(); await pending;
  assert.equal(client.pending.size, 0);
  assert.equal(requests.filter(p => p.action === 'pending').length, 1);
});

test('OneBot reverse WS: bearer authentication, Universal role, duplicate rejection and listener cleanup', async t => {
  const server = http.createServer(); const port = await listen(server); cleanupServer(t, server);
  const client = new OneBotClient({ server, mode: 'reverse', accessToken: 'reverse-secret', apiTransport: 'ws' });
  t.after(() => client.close()); await client.connect();
  async function refused(headers, code) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers });
    await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (req, res) => { assert.equal(res.statusCode, code); res.resume(); ws.terminate(); resolve(); });
      ws.on('open', () => reject(new Error('unauthorized connection accepted')));
      ws.on('error', () => {});
    });
  }
  await refused({}, 401);
  await refused({ Authorization: 'Bearer reverse-secret', 'X-Client-Role': 'API' }, 401);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer reverse-secret', 'X-Client-Role': 'Universal' } });
  t.after(() => ws.terminate());
  ws.on('message', raw => { const p = JSON.parse(raw); answer(ws, p, p.action === 'get_login_info' ? { user_id: 43, nickname: 'reverse' } : { message_id: -99 }); });
  await wait(() => client.selfId === '43');
  await refused({ Authorization: 'Bearer reverse-secret' }, 409);
  assert.equal((await client.sendText('group', '123', 'hello')).message_id, -99);
  client.close();
  assert.equal(server.listenerCount('upgrade'), 0);
});

async function officialFixture(t) {
  const server = http.createServer(); const port = await listen(server);
  const wss = new WebSocketServer({ server }); cleanupServer(t, server, wss);
  const state = { peers: [], packets: [], requests: [], tokens: 0, ack: true };
  wss.on('connection', ws => {
    state.peers.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 80 } }));
    ws.on('message', raw => {
      const p = JSON.parse(raw); state.packets.push(p);
      if (p.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', user: { id: 'bot-id', username: 'Official fixture' } } }));
      if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }));
      if (p.op === 1 && state.ack) ws.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (String(url).includes('getAppAccessToken')) {
      state.tokens++; assert.deepEqual(body, { appId: 'app-1', clientSecret: 'secret-1' });
      return Response.json({ access_token: 'token-fixture', expires_in: '120' });
    }
    assert.equal(options.headers.authorization, 'QQBot token-fixture');
    assert.equal(options.headers['X-Union-Appid'], 'app-1');
    state.requests.push({ url, body });
    if (String(url).endsWith('/gateway/bot')) return Response.json({ url: `ws://127.0.0.1:${port}` });
    if (String(url).endsWith('/files')) return Response.json({ file_info: 'image-info' });
    if (String(url).endsWith('/messages') && state.denyProactive && body && body.msg_id === undefined) {
      return Response.json({ code: 40034105, message: 'active message not allowed' });
    }
    return Response.json({ id: `sent-${state.requests.length}` });
  };
  const events = [];
  const client = new QQBotClient({ appId: 'app-1', appSecret: 'secret-1', intents: 1107296256, fetchImpl, reconnectMs: 20, onEvent: e => events.push(e) });
  t.after(() => client.close()); await client.connect(); await wait(() => client.connected);
  const dispatch = (type, data) => state.peers.at(-1).send(JSON.stringify({ op: 0, t: type, s: 3, d: data }));
  return { state, client, events, dispatch };
}
const groupMessage = (id = 'message-alpha') => ({ id, group_openid: 'GROUP_OPENID_ABC', author: { member_openid: 'USER_OPENID_ABC' }, content: '<@!bot-id> hello', timestamp: new Date().toISOString(), attachments: [{ content_type: 'image/png', url: 'https://example.com/test.png' }] });

test('QQBot identify/token reuse, group/C2C normalization, reply binding and media upload', async t => {
  const { state, client, events, dispatch } = await officialFixture(t);
  assert.equal(state.packets[0].op, 2);
  assert.equal(state.packets[0].d.token, 'QQBot token-fixture');
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage());
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage());
  await wait(() => events.length === 1);
  const event = events[0];
  assert.equal(event.group_id, 'qqbot_group_GROUP_OPENID_ABC');
  assert.equal(event.message_id, 'message-alpha');
  assert.equal(event.message[0].data.qq, 'bot-id');
  assert.equal(event.message[1].data.text, 'hello');
  assert.equal(event.message[2].type, 'image');
  const id = event.group_id;
  const count = state.requests.length;
  await assert.rejects(client.sendText('group', 'qqbot_group_OTHER', 'bad', { replyToMessageId: 'message-alpha' }), /本会话|缺少/);
  assert.equal(state.requests.length, count);
  await client.sendText('group', id, 'first', { replyToMessageId: 'message-alpha' });
  await client.sendText('group', id, 'second');
  const replies = state.requests.filter(r => r.url.endsWith('/messages'));
  assert.equal(replies[0].body.msg_id, 'message-alpha');
  assert.deepEqual(replies.map(r => r.body.msg_seq), [1, 2]);
  await client.sendImage('group', id, 'https://example.com/image.png');
  assert.equal(state.requests.at(-2).body.srv_send_msg, false);
  assert.equal(state.requests.at(-1).body.msg_type, 7);
  assert.equal(state.requests.at(-1).body.media.file_info, 'image-info');
  await assert.rejects(client.sendImage('group', id, 'base64://aaa'), /URL/);
  await client.sendText('group', id, 'four'); await client.sendText('group', id, 'five');
  // 单条入站消息的 5 次被动回复用尽后必须拒绝，不回退到主动消息。
  const requestCount = state.requests.length;
  await assert.rejects(client.sendText('group', id, 'six'), /passive reply window/);
  client.anchors.get('message-alpha').receivedAt -= 300001;
  await assert.rejects(client.sendText('group', id, 'expired-fallback'), /passive reply window/);
  await assert.rejects(client.sendText('group', id, 'expired', { replyToMessageId: 'message-alpha' }));
  await assert.rejects(client.sendText('group', 'qqbot_group_BRAND_NEW_GROUP', 'proactive hello'), /passive reply window/);
  assert.equal(state.requests.length, requestCount);
  // 全量模式：GROUP_MESSAGE_CREATE 不带 @ 也投递；mentions 里有机器人时补上 at 段
  dispatch('GROUP_MESSAGE_CREATE', { ...groupMessage('message-full'), content: 'plain talk', attachments: [] });
  await wait(() => events.length === 2);
  assert.equal(events[1].message[0].type, 'text');
  dispatch('GROUP_MESSAGE_CREATE', { ...groupMessage('message-mentioned'), content: '<@!bot-id> hi', attachments: [], mentions: [{ bot: true, member_openid: 'bot-id' }] });
  await wait(() => events.length === 3);
  assert.equal(events[2].message[0].type, 'at');
  dispatch('C2C_MESSAGE_CREATE', { id: 'c2c-id', author: { user_openid: 'C2C_OPENID' }, content: 'private hello', timestamp: new Date().toISOString() });
  await wait(() => events.length === 4);
  assert.equal(events[3].user_id, 'qqbot_user_C2C_OPENID');
  await client.sendText('private', events[3].user_id, 'reply');
  assert.match(state.requests.at(-1).url, /\/v2\/users\/C2C_OPENID\/messages$/);
  // 真实平台行为：AT 事件 content 里的 <@…> 是 member_openid（≠ READY 的 user.id）。
  // 适配器从 AT 事件学习后，全量消息里的 @ 才能正确识别并从正文剥离。
  dispatch('GROUP_AT_MESSAGE_CREATE', { ...groupMessage('message-at2'), content: '<@!MEMBER_BOT_1> 在吗', attachments: [] });
  await wait(() => events.length === 5);
  assert.equal(events[4].message[1].data.text, '在吗');
  dispatch('GROUP_MESSAGE_CREATE', { ...groupMessage('message-full-mentioned'), content: '<@MEMBER_BOT_1> 再看', attachments: [], mentions: [{ bot: true, member_openid: 'MEMBER_BOT_1' }] });
  await wait(() => events.length === 6);
  assert.equal(events[5].message[0].type, 'at');
  assert.equal(events[5].message[1].data.text, '再看');
  assert.equal(state.tokens, 1);
  await assert.rejects(client.sendPoke(), /不支持/);
  await assert.rejects(client.call('get_group_member_list'), /不支持/);
});

test('QQBot gateway reconnect uses Resume; missed heartbeat ACK reconnects; close cancels retries', async t => {
  const { state, client } = await officialFixture(t);
  state.peers.at(-1).send(JSON.stringify({ op: 7, d: null }));
  await wait(() => state.packets.some(p => p.op === 6));
  const resume = state.packets.find(p => p.op === 6);
  assert.equal(resume.d.token, 'token-fixture');
  assert.equal(resume.d.session_id, 'session-1'); assert.equal(resume.d.seq, 1);
  await wait(() => client.connected);
  state.ack = false;
  const before = state.peers.length;
  await wait(() => state.peers.length > before, 'heartbeat timeout reconnect');
  client.close(); const closed = state.peers.length;
  await sleep(150); assert.equal(state.peers.length, closed);
});

test('QQBot concurrent media sends reserve reply slots before upload and count failed API calls', async t => {
  const { client, state, events, dispatch } = await officialFixture(t);
  dispatch('GROUP_AT_MESSAGE_CREATE', groupMessage('limited-images'));
  await wait(() => events.length === 1);
  client.anchors.get('limited-images').seq = 4;
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => client.sendImage('group', events[0].group_id, 'https://example.com/image.png')));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const uploads = state.requests.filter(x => x.url.endsWith('/files'));
  const messages = state.requests.filter(x => x.url.endsWith('/messages'));
  assert.equal(uploads.length, 1); assert.deepEqual(messages.map(x => x.body.msg_seq), [5]);
  const counts = []; client.onApiCall = x => counts.push(x);
  client.fetchImpl = async () => { throw new Error('network unavailable'); };
  await assert.rejects(client.request('/gateway/bot', undefined, 'GET'), /平台连接失败/);
  assert.deepEqual(counts, [{ success: false }]);
});

test('QQBot ignores null gateway packets and bounds OpenIDs to the Relay contract', async t => {
  const { state, client, events, dispatch } = await officialFixture(t);
  state.peers.at(-1).send('null');
  dispatch('GROUP_AT_MESSAGE_CREATE', { ...groupMessage('oversized-id'), group_openid: 'a'.repeat(129) });
  dispatch('GROUP_AT_MESSAGE_CREATE', { ...groupMessage('valid-after-malformed'), group_openid: 'a'.repeat(128) });
  await wait(() => events.length === 1);
  assert.equal(client.connected, true); assert.equal(events[0].group_id, 'qqbot_group_' + 'a'.repeat(128));
});

test('QQBot runtime errors never expose reflected credentials or invalid JSON bodies', async t => {
  const secret = 'fixture-app-secret-only-for-redaction';
  const failures = [
    () => Response.json({ code: secret, message: secret }, { status: 401 }),
    () => new Response(secret, { status: 502 }),
    () => { throw new Error('request headers: QQBot ' + secret); }
  ];
  for (const failure of failures) {
    const client = new QQBotClient({ appId: '12345678', appSecret: secret, onEvent() {},
      fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); return failure(); } });
    t.after(() => client.close());
    const safe = error => { assert.match(error.message, /QQBot/); assert.equal(error.message.includes(secret), false); return true; };
    await assert.rejects(client.token(), safe);
    client.accessToken = secret; client.tokenExpiresAt = Date.now() + 60000;
    await assert.rejects(client.request('/gateway/bot', undefined, 'GET'), safe);
    client.accessToken = ''; await client.connect();
    await wait(() => client.lastConnectError);
    assert.equal(client.lastConnectError.includes(secret), false);
    client.close();
  }
});

test('numeric archive and memory persist; legacy endpoints migrate', () => {
  const key = 'group:12345';
  const store = new ChatStore();
  store.appendIncoming(key, { mid: 'string-mid', senderId: '12345', senderName: 'member', text: 'persist me' });
  const reloaded = new ChatStore(); assert.ok(reloaded.listChats().includes(key));
  assert.equal(reloaded.recent(key, { limit: 1 })[0].mid, 'string-mid');
  const memory = new MemoryStore();
  memory.replaceMember(key, '12345', 'member', ['persisted']);
  assert.ok(new MemoryStore().listChats().includes(key));
  const migrated = connectionConfig({ snowluma: { wsUrl: 'ws://legacy:3001', httpUrl: 'http://legacy:3000', accessToken: 'legacy', autoLaunch: true } });
  assert.equal(migrated.onebot.apiTransport, 'http'); assert.equal(migrated.onebot.accessToken, 'legacy');
  const wsOnly = connectionConfig({ channels: { qq: { enabled: true, apiTransport: 'ws', wsUrl: 'ws://localhost:1234', httpUrl: '' } } });
  assert.equal(wsOnly.onebot.apiTransport, 'ws');
  assert.equal(wsOnly.onebot.httpUrl, '');
  assert.throws(() => connectionConfig({ channels: { qq: { apiTransport: 'invalid' } } }), /transport/);
  const cfg = structuredClone(CONNECTION_DEFAULTS); cfg.enabled = true; cfg.onebot.mode = 'reverse';
  assert.throws(() => validateConnection(cfg), /token/);
});

test('archive discovery retains UTF-8 BOM numeric and official histories', async () => {
  const { encodeStorageId } = await import('../src/storage-identifiers.js');
  const entries = [
    ['group:906670', 'group_906670.json'],
    ['private:qqbot_user_BOM', 'private_qqbot32_' + encodeStorageId('qqbot_user_BOM') + '.json']
  ];
  fs.mkdirSync(path.join(temp, 'messages'), { recursive: true });
  for (const [chatKey, filename] of entries) {
    fs.writeFileSync(path.join(temp, 'messages', filename), '\uFEFF' + JSON.stringify({
      chatKey, nextLocalId: 2, messages: [{ id: 1, text: 'BOM history' }]
    }));
  }
  const reloaded = new ChatStore();
  const chats = reloaded.listChats();
  for (const [key] of entries) {
    assert.ok(chats.includes(key), key);
    assert.equal(reloaded.recent(key, { limit: 1 })[0].text, 'BOM history');
  }
});

test('maximum-length official IDs survive atomic archive writes and reloads', () => {
  const store = new ChatStore();
  const identities = [
    ['group', 'group'], ['group', 'channel'], ['private', 'user'], ['private', 'dm']
  ];
  for (const [kind, type] of identities) {
    const key = `${kind}:qqbot_${type}_${'X'.repeat(128)}`;
    store.appendIncoming(key, { mid: type, text: 'maximum-length history' });
    store.appendSelf(key, { text: 'reply' });
    const reloaded = new ChatStore();
    assert.ok(reloaded.listChats().includes(key));
    assert.deepEqual(reloaded.recent(key, { limit: 2 }).map(entry => entry.text), ['maximum-length history', 'reply']);
  }
  assert.equal(fs.readdirSync(path.join(temp, 'messages')).some(name => name.endsWith('.tmp')), false);
});

test('official storage separates case-folding collisions and preserves unowned legacy memory', async () => {
  const { encodeStorageId, decodeStorageId } = await import('../src/storage-identifiers.js');
  const keys = ['group:qqbot_group_AAG', 'group:qqbot_group_AAa'];
  const members = ['AAG', 'AAa'];
  assert.equal(Buffer.from(keys[0].split(':')[1]).toString('base64url').toLowerCase(), Buffer.from(keys[1].split(':')[1]).toString('base64url').toLowerCase(), 'the old format really collides');
  const history = new ChatStore(), memory = new MemoryStore();
  for (const [i, key] of keys.entries()) {
    history.appendIncoming(key, { mid: 'case-' + i, text: 'history-' + i });
    for (const uid of members) memory.replaceMember(key, uid, uid, [key + ':' + uid]);
  }
  for (const [i, key] of keys.entries()) {
    assert.equal(new ChatStore().recent(key, { limit: 1 })[0].text, 'history-' + i);
    for (const uid of members) assert.equal(new MemoryStore().getMember(key, uid).impressions[0].content, key + ':' + uid);
    const identity = key.split(':')[1]; assert.equal(decodeStorageId(encodeStorageId(identity)), identity);
  }
  const paths = keys.map(key => 'group_qqbot32_' + encodeStorageId(key.split(':')[1]));
  assert.notEqual(paths[0].toLowerCase(), paths[1].toLowerCase());
  assert.ok(('private_qqbot32_' + encodeStorageId('qqbot_user_' + 'X'.repeat(128)) + '.json').length < 255);
  const unknown = 'group:qqbot_group_unowned'; const oldName = 'group_qqbot64_' + Buffer.from(unknown.split(':')[1]).toString('base64url');
  const oldDir = path.join(temp, 'memory', oldName); fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'u64_' + Buffer.from('user').toString('base64url') + '.json');
  fs.writeFileSync(oldFile, JSON.stringify({ userId: 'user', impressions: [{ content: 'unattributed' }] }));
  assert.deepEqual(new MemoryStore().members(unknown), []); assert.ok(fs.existsSync(oldFile));
  for (const encoding of ['sanitized', 'base64']) {
    const key = 'group:qqbot_group_mixed-a';
    const other = 'group:qqbot_group_mixed_a';
    const name = encoding === 'sanitized' ? 'group_qqbot_group_mixed_a' : 'group_qqbot64_' + Buffer.from(key.split(':')[1]).toString('base64url');
    const legacy = path.join(temp, 'memory', name); fs.mkdirSync(legacy, { recursive: true });
    const files = {
      '_meta.json': JSON.stringify({ chatKey: key }),
      'u_first.json': JSON.stringify({ userId: 'first', impressions: [{ content: 'first session' }] }),
      'u_second.json': JSON.stringify({ userId: 'second', impressions: [{ content: 'other session' }] })
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(legacy, file), content);
    const isolated = new MemoryStore();
    assert.deepEqual(isolated.members(key), []); assert.deepEqual(isolated.members(other), []);
    for (const [file, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(legacy, file), 'utf8'), content);
  }
  const desktop = '7459086882832384'; memory.replaceMember('private:' + desktop, desktop, 'desktop', ['numeric memory']);
  assert.equal(new MemoryStore().getMember('private:' + desktop, desktop).impressions[0].content, 'numeric memory');
});

test('Disabled connection blocks API and scheduled sends before transport I/O', async t => {
  const config = structuredClone(CONNECTION_DEFAULTS);
  config.onebot.apiTransport = 'http';
  const connection = new BotConnection({ config, onEvent: () => {} });
  t.after(() => connection.close());
  connection.selfInfo = { user_id: 42, nickname: 'core-refresh-fixture' };
  assert.equal(connection.selfId, '42', 'core delayed identity refresh remains compatible');
  let requests = 0;
  connection.client.call = async () => { requests++; return {}; };
  connection.client.sendText = async () => { requests++; return {}; };
  await assert.rejects(connection.sendText('group', '123', 'scheduled'), /未启用/);
  await assert.rejects(connection.call('get_group_list'), /未启用/);
  assert.equal(requests, 0);
});
