import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import { FakeBili } from './support/fake-bili.mjs';
import { FakeDanmaku } from './support/fake-danmaku.mjs';
import { tempDir, makeConfig, waitFor, sleep } from './support/helpers.mjs';
import { BiliBridge } from '../src/bridge.js';
import { buildPacket, parsePacketBuffer, LiveService } from '../src/bili/live.js';
import { BiliApi } from '../src/bili/api.js';
import { CookieJar } from '../src/bili/cookie-jar.js';

const SELF_NAME = '测试UP主';

test('live server list received over HTTP cannot direct production connections to arbitrary hosts', async t => {
  let hosts = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { token: 'fixture', host_list: hosts } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const jar = new CookieJar();
  const api = new BiliApi({ jar, signer: { sign: async params => params },
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init) });
  const live = new LiveService({ api, jar });
  const entry = host => ({ host, wss_port: 443, ws_port: 2244 });
  hosts = ['127.0.0.1', '[::1]', '169.254.169.254', 'bilibili.com.evil.test', 'user@bilibili.com', 'bilibili.com/path'].map(entry);
  await assert.rejects(live.danmuInfo('1'), error => error.kind === 'PROTOCOL');
  hosts.push(entry('broadcastlv.chat.bilibili.com'), { ...entry('broadcast.chat.bilibili.com'), wss_port: 65536 });
  const result = await live.danmuInfo('1');
  assert.deepEqual(result.hosts.map(x => x.host), ['broadcastlv.chat.bilibili.com']);
  api.endpoints.live = `http://127.0.0.1:${server.address().port}`;
  assert.ok((await live.danmuInfo('1')).hosts.some(x => x.host === '127.0.0.1'));
});

function danmakuEvent({ uid = '20002', uname = '观众A', text, timestamp = 1_700_000_700, rnd = 12345 } = {}) {
  return {
    cmd: 'DANMU_MSG',
    info: [
      [0, 25, 0, 0, timestamp, rnd, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      text,
      [Number(uid), uname, 0, 0],
      []
    ]
  };
}

function giftEvent({ uid = '20003', uname = '观众B', giftName = '辣条', num = 2, timestamp = 1_700_000_701 } = {}) {
  return {
    cmd: 'SEND_GIFT',
    data: { uid, uname, giftName, num, price: 100, coin_type: 'gold', total_coin: 200, action: '投喂', timestamp, guard_level: 0 }
  };
}

function superChatEvent({ uid = '20002', uname = '观众A', message = 'SC 内容', price = 30, id = 'sc-1' } = {}) {
  return {
    cmd: 'SUPER_CHAT_MESSAGE',
    data: { id, uid, user_info: { uname }, message, price, time: 60, start_time: 1_700_000_702, end_time: 1_700_000_762, guard_level: 0 }
  };
}

function guardEvent({ uid = '20003', username = '观众B', giftName = '舰长', num = 1, guardLevel = 3 } = {}) {
  return {
    cmd: 'GUARD_BUY',
    data: { uid, username, gift_name: giftName, num, price: 198000, guard_level: guardLevel, start_time: 1_700_000_703, end_time: 1_700_086_503 }
  };
}

async function setupLive({ autoEvents = [], filter = {} } = {}) {
  const danmaku = await FakeDanmaku.start({ autoEvents, autoEncoding: 'brotli' });
  const fake = await FakeBili.start({ wsPort: danmaku.port });
  const dataDir = await tempDir();
  const config = makeConfig({
    fake,
    dataDir,
    overrides: {
      security: { readOnly: false }, // Legacy opt-out must be ignored.
      watch: { videos: [], ups: [], liveRooms: ['9001'] },
      live: {
        wsProtocol: 'ws',
        heartbeatIntervalMs: 40,
        reconnectMinMs: 60,
        reconnectMaxMs: 400,
        authTimeoutMs: 2000,
        outboundMinIntervalMs: 20,
        outboundJitterMs: 0,
        filter: { danmaku: 'mentions', keywords: [], gifts: true, superChat: true, guard: true, ...filter }
      }
    }
  });
  const events = [];
  const bridge = new BiliBridge({
    config,
    dispatcher: (event) => events.push(event),
    refreshPublicKey: fake.publicKey
  });
  try {
    await bridge.init();
    fake.applyCookiesTo(bridge.jar);
    await bridge.start();
    await waitFor(() => bridge.selfId > 0 && bridge.liveClients.has('9001'), { timeout: 5000, label: 'live clients' });
    await bridge.scheduler.stop();
  } catch (error) {
    await bridge.stop().catch(() => {});
    await danmaku.close().catch(() => {});
    await fake.close().catch(() => {});
    throw error;
  }
  return {
    danmaku,
    fake,
    bridge,
    events,
    cleanup: async () => {
      await bridge.stop().catch(() => {});
      await danmaku.close().catch(() => {});
      await fake.close().catch(() => {});
    }
  };
}

test('直播包解析：明文、人气值、zlib/brotli 多子包与损坏包', () => {
  const plain1 = buildPacket({ operation: 5, body: JSON.stringify({ cmd: 'A' }), version: 0 });
  const plain2 = buildPacket({ operation: 5, body: JSON.stringify({ cmd: 'B' }), version: 0 });
  const combined = Buffer.concat([plain1, plain2]);

  const zlibFrame = buildPacket({ operation: 5, body: zlib.deflateSync(combined), version: 2 });
  const zlibParsed = parsePacketBuffer(zlibFrame);
  assert.equal(zlibParsed.length, 2);
  assert.equal(JSON.parse(zlibParsed[0].body.toString()).cmd, 'A');
  assert.equal(JSON.parse(zlibParsed[1].body.toString()).cmd, 'B');

  const brotliFrame = buildPacket({ operation: 5, body: zlib.brotliCompressSync(combined), version: 3 });
  const brotliParsed = parsePacketBuffer(brotliFrame);
  assert.equal(brotliParsed.length, 2);

  const popularityBody = Buffer.alloc(4);
  popularityBody.writeUInt32BE(9988, 0);
  const popularity = parsePacketBuffer(buildPacket({ operation: 3, body: popularityBody, version: 1 }));
  assert.equal(popularity[0].popularity, 9988);

  const malformed = Buffer.alloc(16);
  malformed.writeUInt32BE(1000, 0);
  malformed.writeUInt16BE(16, 4);
  assert.throws(() => parsePacketBuffer(malformed), /长度非法/);
});

test('直播 WS：认证、心跳、brotli 多事件、@ 过滤与礼物/SC/上舰', async (t) => {
  const env = await setupLive({
    autoEvents: [
      danmakuEvent({ text: `@${SELF_NAME} 主播好` }),
      danmakuEvent({ text: '普通弹幕不应进入 Agent', uid: '20003', uname: '观众B' }),
      giftEvent(),
      superChatEvent(),
      guardEvent()
    ]
  });
  t.after(env.cleanup);
  const { danmaku, bridge, events, fake } = env;

  await waitFor(() => danmaku.connections >= 1, { label: 'danmaku connection' });
  await waitFor(() => danmaku.auths.length >= 1, { label: 'auth packet' });
  const auth = danmaku.auths[0];
  assert.equal(auth.roomid, 9001);
  assert.equal(auth.key, 'danmu-token-1');
  assert.equal(auth.protover, 3);
  assert.equal(auth.uid, 10086);
  assert.ok(auth.buvid);

  await waitFor(() => events.filter((event) => event.post_type === 'message').length >= 4, { timeout: 4000, label: 'live events' });
  const messages = events.filter((event) => event.post_type === 'message');
  const danmakuMessage = messages.find((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('主播好')));
  assert.ok(danmakuMessage);
  const at = danmakuMessage.message.find((segment) => segment.type === 'at');
  assert.equal(at.data.qq, String(bridge.selfId));
  assert.equal(messages.some((event) => event.message.some((segment) => segment.type === 'text' && String(segment.data.text).includes('普通弹幕'))), false);
  assert.ok(messages.some((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('[礼物]'))));
  assert.ok(messages.some((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('[醒目留言'))));
  assert.ok(messages.some((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('[大航海]'))));
  for (const event of messages) assert.ok(Number.isSafeInteger(event.message_id));

  await waitFor(() => danmaku.heartbeats >= 1, { timeout: 2000, label: 'heartbeat' });
  assert.ok(danmaku.heartbeats >= 1);

  const before = events.length;
  danmaku.sendEvents([danmakuEvent({ text: `@${SELF_NAME} zlib 弹幕`, rnd: 222 })], { encoding: 'zlib' });
  await waitFor(() => events.length > before, { timeout: 3000, label: 'zlib event' });
  assert.ok(events.slice(before).some((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('zlib 弹幕'))));

  const group = await bridge.mapping.groupForLive({ roomId: '9001' });
  assert.ok(group.id);
  await assert.rejects(bridge.sendGroupMessage({ groupId: group.id, message: [{ type: 'text', data: { text: '主播好' } }] }), e => e.kind === 'READ_ONLY');
  assert.equal(fake.liveSent.length, 0);
});

test('直播断线重连后继续收事件与心跳', async (t) => {
  const env = await setupLive();
  t.after(env.cleanup);
  const { danmaku, bridge, events } = env;
  await waitFor(() => danmaku.connections >= 1, { label: 'first connection' });
  await waitFor(() => bridge.liveClients.get('9001')?.client.authenticated, { label: 'first auth' });

  const before = events.length;
  danmaku.sendEvents([danmakuEvent({ text: `@${SELF_NAME} 重连前` })], { encoding: 'plain' });
  await waitFor(() => events.length > before, { label: 'pre reconnect event' });

  danmaku.dropClients();
  await waitFor(() => danmaku.connections >= 2, { timeout: 5000, label: 'reconnect' });
  await waitFor(() => bridge.liveClients.get('9001')?.client.authenticated, { timeout: 5000, label: 'reconnect auth' });
  await waitFor(() => danmaku.heartbeats >= 2, { timeout: 3000, label: 'heartbeat after reconnect' });

  const afterReconnect = events.length;
  danmaku.sendEvents([danmakuEvent({ text: `@${SELF_NAME} 重连成功`, rnd: 999 })], { encoding: 'brotli' });
  await waitFor(() => events.length > afterReconnect, { timeout: 3000, label: 'post reconnect event' });
  assert.ok(events.slice(afterReconnect).some((event) => event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('重连成功'))));
  await sleep(20);
});
