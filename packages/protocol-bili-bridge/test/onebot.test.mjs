import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { FakeBili } from './support/fake-bili.mjs';
import { tempDir, makeConfig, postAction, adminRequest, waitFor, sleep } from './support/helpers.mjs';
import { BiliBridge } from '../src/bridge.js';
import { SUPPORTED_ACTIONS } from '../src/onebot/actions.js';
import { BILI_VIRTUAL_ID_START, BILI_VIRTUAL_ID_END } from '../src/mapping/ids.js';

async function setup({ login = false, overrides = {} } = {}) {
  const fake = await FakeBili.start();
  const dataDir = await tempDir();
  const config = makeConfig({ fake, dataDir, overrides });
  const events = [];
  const bridge = new BiliBridge({ config, dispatcher: (event) => events.push(event), refreshPublicKey: fake.publicKey });
  try {
    await bridge.init();
    if (login) fake.applyCookiesTo(bridge.jar);
    await bridge.start();
    if (login) {
      await waitFor(() => bridge.auth.loggedIn && bridge.selfId > 0, { label: 'bridge login' });
      await bridge.scheduler.stop();
    }
  } catch (error) {
    await bridge.stop().catch(() => {});
    await fake.close().catch(() => {});
    throw error;
  }
  return {
    fake,
    bridge,
    config,
    events,
    cleanup: async () => {
      await bridge.stop().catch(() => {});
      await fake.close().catch(() => {});
    }
  };
}

async function wsClient(bridge, { token = 'test-onebot-token', path = '/' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.server.port}${path}?access_token=${token}`);
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

async function adminLogin(bridge) {
  const created = await adminRequest(bridge, 'POST', '/admin/login/qr');
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  const key = created.json.data.qrcodeKey;
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    const polled = await adminRequest(bridge, 'GET', `/admin/login/qr?key=${encodeURIComponent(key)}`);
    assert.equal(polled.status, 200);
    last = polled.json.data;
    if (last.state === 'success') break;
  }
  assert.equal(last.state, 'success');
  return last;
}

test('custom action 名称覆盖 bili-agent-pack 契约', () => {
  for (const name of ['bili_get_video_context', 'bili_inspect_user', 'bili_reply_comment', 'bili_like']) {
    assert.ok(SUPPORTED_ACTIONS.includes(name), `缺少 action ${name}`);
  }
});

test('HTTP action 根路径/路径式、令牌与未知 action', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { bridge } = env;

  const version = await postAction(bridge, 'get_version_info');
  assert.equal(version.status, 200);
  assert.equal(version.json.status, 'ok');
  assert.equal(version.json.retcode, 0);
  assert.equal(version.json.data.protocol_version, 'v11');
  assert.equal(version.json.data.app_name, 'fish-bili-bridge');

  const pathMode = await postAction(bridge, 'get_status', {}, { pathMode: true });
  assert.equal(pathMode.json.status, 'ok');
  assert.equal(pathMode.json.data.online, true);

  const noToken = await postAction(bridge, 'get_version_info', {}, { token: '' });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.status, 'failed');

  const badAction = await postAction(bridge, 'not_an_action');
  assert.equal(badAction.status, 200);
  assert.equal(badAction.json.status, 'failed');
  assert.equal(badAction.json.retcode, 1404);
  assert.match(badAction.json.wording, /不支持/);

  const beforeLogin = await postAction(bridge, 'get_login_info');
  assert.equal(beforeLogin.json.retcode, 1401);
  assert.match(beforeLogin.json.wording, /未登录/);
});

test('WS 鉴权、生命周期与 OneBot 群/私聊事件投递', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const { bridge, fake } = env;

  const unauthorized = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.server.port}/?access_token=wrong-token`);
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve(0));
    ws.on('error', () => {});
  });
  assert.equal(unauthorized, 401);

  const client = await wsClient(bridge);
  t.after(() => client.close());
  const lifecycle = await waitFor(() => client.events.find((event) => event.post_type === 'meta_event'), { label: 'lifecycle' });
  assert.equal(lifecycle.meta_event_type, 'lifecycle');
  assert.equal(lifecycle.self_id, bridge.selfId);

  const group = await bridge.mapping.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001', title: '测试视频标题' });
  const comment = {
    rpid: '1890000000000000123',
    oid: '170001',
    root: '0',
    parent: '0',
    mid: '20002',
    uname: '观众A',
    message: '@测试UP主 你好呀',
    members: [{ mid: '10086', uname: '测试UP主' }],
    atNameToMid: { 测试UP主: '10086' },
    ctime: 1_700_000_500
  };
  const ingested = await bridge.ingestComment({ group, reply: comment, atSelf: true, source: 'msgfeed', sourceContent: '原评论' });
  assert.ok(Number.isSafeInteger(ingested.messageId));

  const event = await waitFor(() => client.events.find((item) => item.post_type === 'message'), { label: 'group event' });
  assert.equal(event.message_type, 'group');
  assert.equal(event.group_id, group.id);
  assert.equal(event.self_id, bridge.selfId);
  assert.ok(Number.isSafeInteger(event.message_id));
  for (const id of [event.self_id, event.group_id, event.user_id, event.message_id]) {
    assert.ok(id >= BILI_VIRTUAL_ID_START && id <= BILI_VIRTUAL_ID_END, `ID ${id} 不在 B 站虚拟号段`);
  }
  assert.equal(event.sender.user_id, bridge.mapping.resolveUser('20002')?.id ?? event.sender.user_id);
  const at = event.message.find((segment) => segment.type === 'at');
  assert.equal(at.data.qq, String(bridge.selfId));
  assert.match(event.raw_message, /\[CQ:at/);
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('你好呀')));

  const fetched = await postAction(bridge, 'get_msg', { message_id: event.message_id });
  assert.equal(fetched.json.status, 'ok');
  assert.equal(fetched.json.data.message_id, event.message_id);
  assert.equal(fetched.json.data.message_type, 'group');

  const groupInfo = await postAction(bridge, 'get_group_info', { group_id: group.id });
  assert.equal(groupInfo.json.data.group_id, group.id);
  assert.equal(groupInfo.json.data.group_name, '测试视频标题');

  const members = await postAction(bridge, 'get_group_member_list', { group_id: group.id });
  assert.ok(Array.isArray(members.json.data));
  assert.ok(members.json.data.some((member) => member.user_id === bridge.selfId));

  const senderMember = await postAction(bridge, 'get_group_member_info', { group_id: group.id, user_id: event.sender.user_id });
  assert.equal(senderMember.json.data.nickname, '观众A');

  const groups = await postAction(bridge, 'get_group_list');
  assert.ok(groups.json.data.some((item) => item.group_id === group.id));

  const friends = await postAction(bridge, 'get_friend_list');
  assert.ok(Array.isArray(friends.json.data));

  const stranger = await postAction(bridge, 'get_stranger_info', { user_id: event.sender.user_id });
  assert.equal(stranger.json.data.user_id, event.sender.user_id);

  // 引用回复：事件 message_id 应还原成 B 站 rpid 的 root/parent。
  fake.clearRequests();
  const reply = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [
      { type: 'reply', data: { id: String(event.message_id) } },
      { type: 'text', data: { text: '收到' } }
    ]
  });
  assert.equal(reply.json.status, 'ok');
  assert.ok(Number.isSafeInteger(reply.json.data.message_id));
  const add = fake.last('/x/v2/reply/add');
  assert.ok(add);
  assert.equal(add.form.root, '1890000000000000123');
  assert.equal(add.form.parent, '1890000000000000123');
  assert.equal(add.form.message, '收到');

  const escaped = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'text', data: { text: 'A&amp;B&#91;1&#93;' } }]
  });
  assert.equal(escaped.json.status, 'ok');
  assert.equal(fake.last('/x/v2/reply/add').form.message, 'A&B[1]');

  fake.clearRequests();
  const badMention = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [
      { type: 'at', data: { qq: String(event.sender.user_id), name: '假名字' } },
      { type: 'text', data: { text: ' 你好' } }
    ]
  });
  assert.equal(badMention.json.status, 'failed');
  assert.match(badMention.json.wording, /昵称.*不一致/);
  assert.equal(fake.count('/x/v2/reply/add'), 0);

  const goodMention = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [
      { type: 'at', data: { qq: String(event.sender.user_id), name: '观众A' } },
      { type: 'text', data: { text: ' 你好' } }
    ]
  });
  assert.equal(goodMention.json.status, 'ok');
  const mentionForm = fake.last('/x/v2/reply/add');
  assert.match(mentionForm.form.message, /^@观众A /);

  const unmappedMention = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [
      { type: 'at', data: { qq: String(2 ** 52 + 299), name: '陌生人' } },
      { type: 'text', data: { text: ' hi' } }
    ]
  });
  assert.equal(unmappedMention.json.status, 'failed');
  assert.match(unmappedMention.json.wording, /没有对应的 B 站账号/);

  const image = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'image', data: { file: 'http://example.com/a.jpg' } }]
  });
  assert.equal(image.json.status, 'failed');
  assert.equal(image.json.retcode, 1404);
  assert.match(image.json.wording, /不支持发送图片/);

  const unknownGroup = await postAction(bridge, 'send_group_msg', { group_id: 910_000_000_000_001, message: [{ type: 'text', data: { text: 'x' } }] });
  assert.equal(unknownGroup.json.status, 'failed');
  assert.equal(unknownGroup.json.retcode, 1404);
});

test('私信发送、2000 字节校验、入站私信与 message_id 安全', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const { bridge, fake } = env;
  const user = await bridge.mapping.userFor({ mid: '20002', name: '观众A' });

  const sent = await postAction(bridge, 'send_private_msg', {
    user_id: user.id,
    message: [{ type: 'text', data: { text: '你好，私信' } }]
  });
  assert.equal(sent.json.status, 'ok');
  assert.ok(Number.isSafeInteger(sent.json.data.message_id));
  assert.equal(fake.dmSends.length, 1);
  assert.equal(fake.dmSends[0].receiver, '20002');
  assert.equal(fake.dmSends[0].text, '你好，私信');

  const tooLong = 'a'.repeat(2001);
  const rejected = await postAction(bridge, 'send_private_msg', {
    user_id: user.id,
    message: [{ type: 'text', data: { text: tooLong } }]
  });
  assert.equal(rejected.json.status, 'failed');
  assert.equal(rejected.json.retcode, 1400);
  assert.match(rejected.json.wording, /2000 字节/);
  assert.equal(fake.dmSends.length, 1);

  const dmMessage = {
    seqno: '1780000000000000001',
    mid: '20002',
    receiverId: '10086',
    self: false,
    timestamp: 1_700_000_600,
    msgType: 1,
    text: '入站私信',
    imageUrl: '',
    contentType: 'text'
  };
  const ingested = await bridge.ingestDm({ user: { mid: '20002', name: '观众A' }, message: dmMessage });
  assert.ok(Number.isSafeInteger(ingested.messageId));

  const fetched = await postAction(bridge, 'get_msg', { message_id: ingested.messageId });
  assert.equal(fetched.json.status, 'ok');
  assert.equal(fetched.json.data.message_type, 'private');
  assert.equal(fetched.json.data.user_id, user.id);
  assert.equal(fetched.json.data.raw_message, '入站私信');
  assert.deepEqual(fetched.json.data.message, [{ type: 'text', data: { text: '入站私信' } }]);

  const selfDm = await bridge.ingestDm({
    user: { mid: '20002', name: '观众A' },
    message: { ...dmMessage, mid: '10086', self: true, seqno: '1780000000000000002' }
  });
  assert.equal(selfDm, null);
});

test('管理 API：健康检查、状态、订阅、映射、消息、登出与秘密不泄露', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { bridge, fake } = env;

  const unauth = await adminRequest(bridge, 'GET', '/admin/status', null, { token: '' });
  assert.equal(unauth.status, 401);
  const bad = await adminRequest(bridge, 'GET', '/admin/status', null, { token: 'wrong-admin' });
  assert.equal(bad.status, 401);
  const queryToken = await fetch(`http://127.0.0.1:${bridge.server.port}/admin/status?admin_token=test-admin-token-123`);
  assert.equal(queryToken.status, 401);

  const health = await adminRequest(bridge, 'GET', '/admin/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.data.tenantId, 'tenant-test');

  const qr = await adminLogin(bridge);
  assert.equal(qr.state, 'success');
  await waitFor(() => bridge.selfId > 0, { label: 'self id' });

  const status = await adminRequest(bridge, 'GET', '/admin/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.data.bili.loggedIn, true);
  assert.equal(status.json.data.subscriptions.at, true);
  const statusText = JSON.stringify(status.json);
  for (const secret of [fake.session.sessdata, fake.session.jct, fake.session.refreshToken, 'test-admin-token-123', 'test-onebot-token']) {
    assert.equal(statusText.includes(secret), false, `status 泄露了 ${secret}`);
  }
  const cookieNames = status.json.data.bili.cookies.map((item) => item.name);
  assert.ok(cookieNames.includes('SESSDATA'));
  assert.ok(status.json.data.bili.cookies.every((item) => !Object.hasOwn(item, 'value')));
  assert.equal(Object.hasOwn(status.json.data.bili.qr || {}, 'qrcodeKey'), false);

  const account = await adminRequest(bridge, 'GET', '/admin/account');
  assert.equal(account.json.data.loggedIn, true);
  assert.equal(JSON.stringify(account.json).includes(fake.session.sessdata), false);

  const subs = await adminRequest(bridge, 'PUT', '/admin/subscriptions', { at: false, dm: false });
  assert.equal(subs.json.data.at, false);
  assert.equal(subs.json.data.dm, false);
  assert.equal(subs.json.data.live, true);

  const watches = await adminRequest(bridge, 'PUT', '/admin/watches', {
    videos: ['BV1xx411c7mD', 'av170001', 'bad'],
    ups: ['10086', 'x'],
    liveRooms: ['9001']
  });
  assert.deepEqual(watches.json.data.videos, ['BV1xx411c7mD', '170001']);
  assert.deepEqual(watches.json.data.ups, ['10086']);
  assert.deepEqual(watches.json.data.liveRooms, ['9001']);

  await bridge.commentWatcher.poll();
  const mapping = await adminRequest(bridge, 'GET', '/admin/mapping');
  assert.ok(mapping.json.data.groups.some((group) => group.native.bvid === 'BV1xx411c7mD'));

  const messages = await adminRequest(bridge, 'GET', '/admin/messages?limit=5');
  assert.ok(Array.isArray(messages.json.data));

  const restarted = new BiliBridge({ config: env.config, refreshPublicKey: fake.publicKey });
  await restarted.init();
  assert.equal(restarted.getSubscriptions().at, false);
  assert.equal(restarted.getSubscriptions().dm, false);
  assert.deepEqual(restarted.getWatches(), { videos: ['BV1xx411c7mD', '170001'], ups: ['10086'], liveRooms: ['9001'] });
  await restarted.stop();

  const login = await postAction(bridge, 'get_login_info');
  assert.equal(login.json.status, 'ok');
  assert.equal(login.json.data.user_id, bridge.selfId);
  assert.ok(bridge.selfId >= BILI_VIRTUAL_ID_START && bridge.selfId <= BILI_VIRTUAL_ID_END);

  const refreshed = await adminRequest(bridge, 'POST', '/admin/refresh', { force: false });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.data.refreshed, true);
  assert.equal(fake.refreshCalls, 1);

  const logout = await adminRequest(bridge, 'POST', '/admin/logout');
  assert.equal(logout.status, 200);
  assert.equal(logout.json.data.loggedIn, false);
  const afterLogout = await postAction(bridge, 'get_login_info');
  assert.equal(afterLogout.json.retcode, 1401);
});

test('管理 API 未配置 admin token 时返回 503', async (t) => {
  const env = await setup({ overrides: { onebot: { host: '127.0.0.1', port: 0, token: 'test-onebot-token', adminToken: '' } } });
  t.after(env.cleanup);
  const response = await fetch(`http://127.0.0.1:${env.bridge.server.port}/admin/status`);
  assert.equal(response.status, 503);
  const json = await response.json();
  assert.equal(json.ok, false);
  assert.match(json.error.wording, /管理 API 未启用/);
});

test('视频上下文、UP 查询、点赞与自定义评论 action', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const { bridge, fake } = env;

  fake.addComment('170001', { rpid: '1890000000000000601', mid: '20002', uname: '观众A', message: '热评候选', ctime: 1_700_000_810 });
  const context = await postAction(bridge, 'bili_get_video_context', {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/?spm=test',
    includeComments: true
  });
  assert.equal(context.json.status, 'ok');
  assert.equal(context.json.data.title, '测试视频标题');
  assert.equal(context.json.data.pages.length, 1);
  assert.equal(context.json.data.subtitle.available, true);
  assert.match(context.json.data.subtitleText, /字幕内容/);
  assert.equal(context.json.data.comments[0].message, '热评候选');

  const noSubtitle = await postAction(bridge, 'bili_get_video_context', {
    bvid: 'BV1xx411c7mD',
    includeSubtitles: false
  });
  assert.equal(noSubtitle.json.status, 'ok');
  assert.equal(noSubtitle.json.data.subtitle.reason, 'SKIPPED');
  assert.equal(noSubtitle.json.data.subtitleText, '');

  fake.addUpVideo('20002', { bvid: 'BV1inspect001', aid: 195001, title: '近期投稿', created: 1_700_000_811, author: '观众A' });
  const user = await postAction(bridge, 'bili_inspect_user', { mid: '20002', includeVideos: true });
  assert.equal(user.json.status, 'ok');
  assert.equal(user.json.data.name, '观众A');
  assert.equal(user.json.data.videos[0].bvid, 'BV1inspect001');

  const like = await postAction(bridge, 'bili_like', { oid: '170001', commentId: '1890000000000000999', action: 'unlike' });
  assert.equal(like.json.status, 'ok');
  assert.equal(like.json.data.action, 0);
  assert.equal(fake.commentActions.at(-1).action, 0);

  const videoLike = await postAction(bridge, 'bili_like', { bvid: 'BV1xx411c7mD', oid: '170001', action: 'like' });
  assert.equal(videoLike.json.status, 'ok');
  assert.equal(videoLike.json.data.like, 1);
  assert.equal(fake.videoLikes.at(-1).aid, '170001');

  const reply = await postAction(bridge, 'bili_reply_comment', {
    text: '自定义 action 评论',
    bvid: 'BV1xx411c7mD',
    oid: '170001',
    rootId: '0',
    parentId: '0'
  });
  assert.equal(reply.json.status, 'ok');
  assert.ok(reply.json.data.rpid);
  assert.equal(fake.videoComments.get('170001').slice(-1)[0].content.message, '自定义 action 评论');

  const noLogin = await setup();
  t.after(noLogin.cleanup);
  const unauthorized = await postAction(noLogin.bridge, 'bili_get_video_context', { bvid: 'BV1xx411c7mD' });
  assert.equal(unauthorized.json.retcode, 1401);
});

test('B 站风控：-352 明确失败、gaia 挑战不进管理响应、清除后可重试', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const { bridge, fake } = env;
  const group = await bridge.mapping.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001', title: '测试视频标题' });

  fake.riskMode = true;
  const blocked = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'text', data: { text: '会被风控' } }]
  });
  assert.equal(blocked.json.status, 'failed');
  assert.equal(blocked.json.retcode, 403);
  assert.match(blocked.json.wording, /人机验证/);
  assert.ok(fake.count('/x/gaia-vgate/v1/register') >= 1);

  const status = await adminRequest(bridge, 'GET', '/admin/status');
  assert.equal(status.json.data.bili.risk.blocked, true);
  const statusText = JSON.stringify(status.json);
  assert.equal(statusText.includes('voucher-test-1'), false);
  assert.equal(statusText.includes('gaia-token'), false);

  const cleared = await adminRequest(bridge, 'POST', '/admin/risk/clear');
  assert.equal(cleared.json.data.cleared, true);
  fake.riskMode = false;
  const retried = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'text', data: { text: '风控解除后重试' } }]
  });
  assert.equal(retried.json.status, 'ok');

  const contentRejected = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'text', data: { text: 'badword' } }]
  });
  assert.equal(contentRejected.json.status, 'failed');
  assert.match(contentRejected.json.wording, /敏感信息/);

  const duplicate = await postAction(bridge, 'send_group_msg', {
    group_id: group.id,
    message: [{ type: 'text', data: { text: 'duplicate' } }]
  });
  assert.equal(duplicate.json.status, 'failed');
  assert.match(duplicate.json.wording, /重复评论/);
});

test('同一桥接实例 stop 后可再次 start 并恢复 OneBot 服务', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { bridge } = env;
  const firstPort = bridge.server.port;
  assert.ok(firstPort > 0);
  await bridge.stop();
  assert.equal(bridge.server, null);
  await bridge.start();
  assert.ok(bridge.server.port > 0);
  const health = await fetch(`http://127.0.0.1:${bridge.server.port}/health`);
  assert.equal(health.status, 200);
  const version = await postAction(bridge, 'get_version_info');
  assert.equal(version.json.status, 'ok');
});

test('dynamic replies use authoritative type and oid, and reject cross-group quotes', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const { bridge } = env;
  const group = await bridge.mapping.groupForDynamic({ dynamicId: '90071992547409999' });
  bridge.dynamicService.detail = async () => ({ oid: '34567', type: 11 });
  let sent;
  bridge.commentService.add = async (args) => { sent = args; return { oid: args.oid, rpid: '333' }; };
  const incoming = await bridge.ingestComment({ group: { ...group, commentSubject: { oid: '34567', type: 11 } }, reply: { mid: '20002', rpid: '222', root: '111', oid: '34567', message: 'hi' } });
  await bridge.sendGroupMessage({ groupId: group.id, message: [{ type: 'reply', data: { id: incoming.messageId } }, { type: 'text', data: { text: 'ok' } }] });
  assert.deepEqual([sent.type, sent.oid, sent.root, sent.parent], [11, '34567', '111', '222']);
  const other = await bridge.mapping.groupForDynamic({ dynamicId: '90071992547409998' });
  await assert.rejects(bridge.sendGroupMessage({ groupId: other.id, message: [{ type: 'reply', data: { id: incoming.messageId } }, { type: 'text', data: { text: 'ok' } }] }), /跨评论区/);
});

test('dispatcher rejection reaches polling caller', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  env.bridge.dispatcher = async () => { throw new Error('dispatch failed'); };
  const group = await env.bridge.mapping.groupForVideo({ aid: '170001' });
  await assert.rejects(env.bridge.ingestComment({ group, reply: { mid: '20002', rpid: '1', message: 'hi' } }), /dispatch failed/);
});

test('cloud watcher lifecycle gates configured subscriptions and polling', async (t) => {
  const env = await setup({ login: true });
  const previous = { file: process.env.BILI_WATCH_LIFECYCLE_FILE, cloud: process.env.QQ_AGENT_CLOUD, dir: process.env.QQ_AGENT_DATA_DIR };
  const dir = await tempDir();
  const lifecycle = path.join(dir, 'bili-watch', 'lifecycle.json');
  process.env.BILI_WATCH_LIFECYCLE_FILE = lifecycle;
  process.env.QQ_AGENT_CLOUD = '1';
  process.env.QQ_AGENT_DATA_DIR = dir;
  const plugin = await import('../../qq-agent-core/plugins/bili-watcher/index.js');
  t.after(async () => { for (const [key, value] of Object.entries({ BILI_WATCH_LIFECYCLE_FILE: previous.file, QQ_AGENT_CLOUD: previous.cloud, QQ_AGENT_DATA_DIR: previous.dir })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await env.cleanup(); });
  const { bridge } = env;
  await bridge.setSubscriptions({ at: true, up: false, dm: true });
  await bridge.setWatches({ videos: ['BV1xx411c7mD'], ups: ['123'] });
  assert.equal(bridge.getSubscriptions().at, true);
  assert.equal(bridge.watcherStatus().reason, 'state_missing');
  assert.equal((await bridge.commentWatcher.poll()).videos, 1);
  plugin.deactivate();
  assert.equal(bridge.getSubscriptions().at, false);
  assert.equal((await bridge.commentWatcher.poll()).videos, 0);
  plugin.activate();
  assert.equal(bridge.getSubscriptions().at, true);
  assert.equal(bridge.getSubscriptions().up, false);
  assert.equal(bridge.getWatches().videos[0], 'BV1xx411c7mD');
  assert.equal((await bridge.commentWatcher.poll()).videos, 1);
  let polls = 0;
  bridge.commentWatcher.poll = async () => { polls++; };
  await bridge.scheduler.trigger('comment');
  assert.equal(polls, 1);
  plugin.deactivate();
  await bridge.scheduler.trigger('comment');
  assert.equal(polls, 1);
  plugin.activate();
  await bridge.scheduler.trigger('comment');
  assert.equal(polls, 2);
  assert.equal(bridge.getSubscriptions().at, true);
  assert.equal(bridge.getSubscriptions().up, false);
  await fs.writeFile(lifecycle, JSON.stringify({ active: true, pid: 2147483647 }));
  assert.equal(bridge.watcherStatus().reason, 'agent_offline');
  assert.equal(bridge.getSubscriptions().at, true);
  await fs.writeFile(lifecycle, '{');
  assert.equal(bridge.watcherStatus().reason, 'state_invalid');
  assert.equal(bridge.getSubscriptions().at, true);
  plugin.deactivate();
  assert.equal(bridge.watcherActive(), false);
  await fs.writeFile(lifecycle, '{');
  assert.equal(bridge.watcherActive(), false);
  await fs.rm(lifecycle);
  assert.equal(bridge.watcherActive(), false);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ skills: { 'bili-watcher': { enabled: false } } }));
  const restarted = new BiliBridge({ config: env.config });
  await restarted.init();
  assert.equal(restarted.watcherActive(), false);
  await fs.writeFile(lifecycle, '{');
  assert.equal(restarted.watcherActive(), false);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ skills: { 'bili-watcher': { enabled: true } } }));
  plugin.activate();
  assert.equal(restarted.watcherActive(), true);
});

test('cloud bridge restart loads current persisted tenant subscriptions', async (t) => {
  const env = await setup({ login: true });
  t.after(env.cleanup);
  const file = path.join(await tempDir(), 'cloud-config.json');
  const old = process.env.BILI_CLOUD_CONFIG_FILE;
  t.after(() => { if (old === undefined) delete process.env.BILI_CLOUD_CONFIG_FILE; else process.env.BILI_CLOUD_CONFIG_FILE = old; });
  await fs.writeFile(file, JSON.stringify({ config: { enabled: true, subscriptions: { mentions: false, upVideos: true, privateMessages: true, liveRoom: false }, upMids: ['42'], videos: ['BV1xx411c7mD'], liveRoomIds: [] } }));
  process.env.BILI_CLOUD_CONFIG_FILE = file;
  const restarted = new BiliBridge({ config: env.config });
  await restarted.init();
  assert.equal(restarted.getSubscriptions().at, false);
  assert.equal(restarted.getSubscriptions().up, true);
  assert.deepEqual(restarted.getWatches().ups, ['42']);
  assert.deepEqual(restarted.getWatches().videos, ['BV1xx411c7mD']);
});
