import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { FakeBili } from './support/fake-bili.mjs';
import { FakeDanmaku } from './support/fake-danmaku.mjs';
import { tempDir, makeConfig, postAction, adminRequest, waitFor, sleep } from './support/helpers.mjs';
import { BiliBridge } from '../src/bridge.js';
import { isBiliVirtualId } from '../src/mapping/ids.js';

async function connectWs(bridge) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.server.port}/?access_token=test-onebot-token`);
  const events = [];
  ws.on('message', (data) => {
    try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, events, close: () => ws.close() };
}

async function qrLogin(bridge) {
  const created = await adminRequest(bridge, 'POST', '/admin/login/qr');
  const key = created.json.data.qrcodeKey;
  for (let i = 0; i < 4; i += 1) {
    const polled = await adminRequest(bridge, 'GET', `/admin/login/qr?key=${encodeURIComponent(key)}`);
    if (polled.json.data.state === 'success') return polled.json.data;
  }
  throw new Error('扫码登录未完成');
}

test('端到端：扫码→订阅→评论/私信/UP/直播事件→OneBot WS→HTTP action 回复→fake B 站', async (t) => {
  const danmaku = await FakeDanmaku.start({ autoEvents: [] });
  const fake = await FakeBili.start({ wsPort: danmaku.port });
  const dataDir = await tempDir();
  const config = makeConfig({
    fake,
    dataDir,
    overrides: {
      watch: { videos: [], ups: [], liveRooms: [] },
      live: {
        wsProtocol: 'ws',
        heartbeatIntervalMs: 50,
        reconnectMinMs: 60,
        reconnectMaxMs: 400,
        authTimeoutMs: 2000,
        outboundMinIntervalMs: 30,
        outboundJitterMs: 0,
        filter: { danmaku: 'mentions', keywords: [], gifts: true, superChat: true, guard: true }
      }
    }
  });
  const bridge = new BiliBridge({ config, refreshPublicKey: fake.publicKey });
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await danmaku.close().catch(() => {});
    await fake.close().catch(() => {});
  });

  await bridge.start();
  await qrLogin(bridge);
  await waitFor(() => bridge.selfId > 0 && bridge.auth.loggedIn, { label: 'login complete' });
  const client = await connectWs(bridge);
  t.after(() => client.close());
  await waitFor(() => client.events.some((event) => event.meta_event_type === 'lifecycle'), { label: 'lifecycle' });

  await adminRequest(bridge, 'PUT', '/admin/watches', {
    videos: ['BV1xx411c7mD'],
    ups: ['20002'],
    liveRooms: ['9001']
  });
  await adminRequest(bridge, 'PUT', '/admin/subscriptions', { at: true, up: true, dm: true, live: true });
  await waitFor(() => bridge.liveClients.get('9001')?.client.authenticated, { timeout: 5000, label: 'live authenticated' });
  await bridge.scheduler.stop();

  // 视频评论：先建基线，再加新评论
  await bridge.commentWatcher.poll();
  fake.addComment('170001', { rpid: '1890000000000000501', mid: '20002', uname: '观众A', message: '端到端评论', ctime: 1_700_000_800 });
  await bridge.commentWatcher.poll();
  const commentEvent = await waitFor(() => client.events.find((event) => (
    event.post_type === 'message'
    && event.message.some((segment) => segment.type === 'text' && segment.data.text === '端到端评论')
  )), { timeout: 3000, label: 'comment event' });
  assert.ok(Number.isSafeInteger(commentEvent.message_id));
  const videoGroup = await bridge.mapping.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001' });
  assert.equal(commentEvent.group_id, videoGroup.id);

  const commentReply = await postAction(bridge, 'send_group_msg', {
    group_id: videoGroup.id,
    message: [
      { type: 'reply', data: { id: String(commentEvent.message_id) } },
      { type: 'text', data: { text: '端到端回复' } }
    ]
  });
  assert.equal(commentReply.json.status, 'ok');
  const added = fake.last('/x/v2/reply/add');
  assert.equal(added.form.message, '端到端回复');
  assert.equal(added.form.root, '1890000000000000501');
  assert.equal(added.form.parent, '1890000000000000501');

  // 私信：基线 → 新消息 → 回复
  fake.addDmSession('20002', { name: '观众A' });
  fake.addDmMessage('20002', { text: '历史私信', seqno: '1780000000000000201', timestamp: 1_700_000_801 });
  await bridge.dmWatcher.poll();
  fake.addDmMessage('20002', { text: '端到端私信', seqno: '1780000000000000202', timestamp: 1_700_000_802 });
  await bridge.dmWatcher.poll();
  const privateEvent = await waitFor(() => client.events.find((event) => (
    event.post_type === 'message'
    && event.message_type === 'private'
    && event.message.some((segment) => segment.type === 'text' && segment.data.text === '端到端私信')
  )), { timeout: 3000, label: 'private event' });
  assert.ok(Number.isSafeInteger(privateEvent.message_id));
  const dmReply = await postAction(bridge, 'send_private_msg', {
    user_id: privateEvent.user_id,
    message: [{ type: 'text', data: { text: '端到端私信回复' } }]
  });
  assert.equal(dmReply.json.status, 'ok');
  assert.equal(fake.dmSends.at(-1).text, '端到端私信回复');

  // UP 新视频
  await bridge.upWatcher.poll();
  fake.addUpVideo('20002', { bvid: 'BV1e2e0000001', aid: 190001, title: '端到端新视频', created: 1_700_000_803, author: '观众A' });
  fake.addVideo({ bvid: 'BV1e2e0000001', aid: 190001, title: '端到端新视频', owner: { mid: '20002', name: '观众A' } });
  await bridge.upWatcher.poll();
  const upEvent = await waitFor(() => client.events.find((event) => (
    event.post_type === 'message'
    && event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('端到端新视频'))
  )), { timeout: 3000, label: 'up event' });
  assert.ok(Number.isSafeInteger(upEvent.message_id));

  // 直播事件 → 回复弹幕
  await waitFor(() => danmaku.connections >= 1, { label: 'danmaku connection' });
  danmaku.sendEvents([{
    cmd: 'DANMU_MSG',
    info: [
      [0, 25, 0, 0, 1_700_000_804, 456],
      '@测试UP主 端到端直播',
      [Number('20003'), '观众B', 0, 0],
      []
    ]
  }], { encoding: 'brotli' });
  const liveEvent = await waitFor(() => client.events.find((event) => (
    event.post_type === 'message'
    && event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('端到端直播'))
  )), { timeout: 3000, label: 'live event' });
  assert.ok(Number.isSafeInteger(liveEvent.message_id));
  const liveGroup = await bridge.mapping.groupForLive({ roomId: '9001' });
  const liveReply = await postAction(bridge, 'send_group_msg', {
    group_id: liveGroup.id,
    message: [{ type: 'text', data: { text: '端到端弹幕' } }]
  });
  assert.equal(liveReply.json.status, 'ok');
  assert.equal(fake.liveSent.at(-1).text, '端到端弹幕');

  // msgfeed @：基线 → 新回复
  await bridge.replyWatcher.poll();
  fake.addMsgfeedReply({ atSelf: true, message: '@测试UP主 端到端@', rpid: '1890000000000000502', ctime: 1_700_000_805 });
  await bridge.replyWatcher.poll();
  const atEvent = await waitFor(() => client.events.find((event) => (
    event.post_type === 'message'
    && event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('端到端@'))
  )), { timeout: 3000, label: 'at event' });
  assert.ok(Number.isSafeInteger(atEvent.message_id));

  for (const group of bridge.mapping.groups()) assert.ok(isBiliVirtualId(group.id), `group ${group.id}`);
  for (const user of bridge.mapping.users()) assert.ok(isBiliVirtualId(user.id), `user ${user.id}`);
  for (const event of client.events.filter((item) => item.post_type === 'message')) {
    for (const id of [event.self_id, event.group_id, event.user_id, event.message_id].filter((id) => id != null)) {
      assert.ok(isBiliVirtualId(id), `event id ${id} 不在 B 站号段`);
    }
  }

  const status = await adminRequest(bridge, 'GET', '/admin/status');
  assert.equal(status.json.data.bili.loggedIn, true);
  const groups = await postAction(bridge, 'get_group_list');
  assert.ok(groups.json.data.length >= 3);
  await sleep(20);
});
