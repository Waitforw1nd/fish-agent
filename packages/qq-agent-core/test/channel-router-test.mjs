/**
 * ChannelRouter 双通道路由测试（node test/channel-router-test.mjs）。
 *
 * 覆盖的不是"能发出去"，而是**不能发错**：
 *   · 号段外 / 未启用号段 / 显式平台冲突 → 必须抛错且两侧一次调用都不发生；
 *   · QQ 与 B站 message_id 撞号 → 未显式指定平台时拒绝猜测；
 *   · message_sent / self 发言 → 不进入 ingest（防自回环）；
 *   · 重复事件 → 只交付一次；
 *   · get_group_list 聚合、get_friend_list 跳过 B站；
 *   · 兼容门面（httpUrl/accessToken/selfId/connected/call）不破坏旧调用方。
 */
import assert from 'node:assert/strict';
import {
  ChannelRouter,
  assertSegmentsForPlatform
} from '../src/channel-router.js';
import {
  BILI_VIRTUAL_ID_START,
  resolveChannels
} from '../src/config.js';

const BILI_GROUP = BILI_VIRTUAL_ID_START + 10;
const BILI_USER = BILI_VIRTUAL_ID_START + 20;
const BILI_SELF = String(BILI_VIRTUAL_ID_START + 1);

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        -> ${error?.message ?? error}`);
  }
}

function makeFakeClient(platform, { selfId, nickname = '', responses = {}, calls = [] } = {}) {
  let seq = 5000;
  const listeners = new Set();
  const record = (action, params) => calls.push({ platform, action, params });
  const send = (kind, id, segments, options = {}) => {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    record(action, {
      ...(kind === 'private' ? { user_id: Number(id) } : { group_id: Number(id) }),
      message: segments,
      options
    });
    seq += 1;
    return { message_id: seq };
  };
  const client = {
    platform,
    wsUrl: platform === 'qq' ? 'ws://127.0.0.1:3001' : 'ws://127.0.0.1:3101',
    httpUrl: platform === 'qq' ? 'http://127.0.0.1:3000' : 'http://127.0.0.1:3100',
    accessToken: `${platform}-token`,
    httpToken: `${platform}-token`,
    connected: false,
    everConnected: false,
    lastConnectError: '',
    selfInfo: { user_id: String(selfId), nickname },
    connectCount: 0,
    reconnectCount: 0,
    closeCount: 0,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emitStatus(status = {}) {
      client.connected = status.connected === true;
      if (client.connected) client.everConnected = true;
      if (status.error !== undefined) client.lastConnectError = String(status.error);
      for (const fn of [...listeners]) {
        fn({
          platform,
          connected: client.connected,
          everConnected: client.everConnected,
          error: client.lastConnectError
        });
      }
    },
    async connect() { client.connectCount += 1; client.emitStatus({ connected: true }); },
    async reconnect() { client.reconnectCount += 1; client.emitStatus({ connected: true }); },
    close() { client.closeCount += 1; client.emitStatus({ connected: false }); },
    async call(action, params = {}) {
      record(action, params);
      const handler = responses[action];
      if (handler) return handler(params);
      if (action === 'get_group_list') return [];
      if (action === 'get_friend_list') return [];
      if (action === 'get_msg') return { message: [{ type: 'text', data: { text: 'ok' } }], sender: { user_id: 1, nickname: 'x' } };
      if (action === 'get_group_info') return { group_id: params.group_id, group_name: 'g' };
      if (action === 'get_group_member_info') return { card: 'card', nickname: 'nick' };
      return {};
    },
    sendText(kind, id, text, options) {
      return send(kind, id, [{ type: 'text', data: { text } }], options);
    },
    sendImage(kind, id, file, options) {
      return send(kind, id, [{ type: 'image', data: { file } }], options);
    },
    sendSticker(kind, id, file, options) {
      return send(kind, id, [{ type: 'image', data: { file } }], options);
    },
    sendSegments(kind, id, segments) {
      return send(kind, id, segments);
    },
    sendPoke(kind, id, targetUserId) {
      record(kind === 'private' ? 'friend_poke' : 'group_poke', { target: Number(id), user_id: Number(targetUserId || id) });
      return { message_id: null };
    },
    getMsg(messageId) { return client.call('get_msg', { message_id: Number(messageId) }); },
    getGroupInfo(groupId) { return client.call('get_group_info', { group_id: Number(groupId) }); },
    getGroupMemberInfo(groupId, userId) {
      return client.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
    },
    get selfId() { return String(client.selfInfo?.user_id ?? selfId ?? ''); },
    get selfNickname() { return String(client.selfInfo?.nickname ?? nickname ?? ''); }
  };
  return client;
}

function build({
  biliEnabled = true,
  biliExtraActions = [],
  qqResponses = {},
  biliResponses = {},
  qqRange,
  biliRange
} = {}) {
  const calls = { qq: [], bili: [] };
  const qq = makeFakeClient('qq', {
    selfId: 10001,
    nickname: 'QQBot',
    calls: calls.qq,
    responses: {
      get_group_list: () => [{ group_id: 456, group_name: 'QQ群456' }],
      get_friend_list: () => [{ user_id: 777, nickname: '好友777' }],
      ...qqResponses
    }
  });
  const bili = makeFakeClient('bili', {
    selfId: BILI_SELF,
    nickname: 'BiliBot',
    calls: calls.bili,
    responses: {
      get_group_list: () => [{ group_id: BILI_GROUP, group_name: 'B站视频评论' }],
      ...biliResponses
    }
  });
  const events = [];
  const statuses = [];
  const router = new ChannelRouter({
    channels: {
      qq: {
        enabled: true,
        wsUrl: qq.wsUrl,
        httpUrl: qq.httpUrl,
        accessToken: 'qq-token',
        httpAccessToken: 'qq-token',
        idRange: qqRange || { start: 1, end: BILI_VIRTUAL_ID_START - 1 },
        client: qq
      },
      bili: {
        enabled: biliEnabled,
        wsUrl: bili.wsUrl,
        httpUrl: bili.httpUrl,
        accessToken: 'bili-token',
        httpAccessToken: 'bili-token',
        extraActions: biliExtraActions,
        idRange: biliRange || { start: BILI_VIRTUAL_ID_START, end: Number.MAX_SAFE_INTEGER },
        client: bili
      }
    },
    onEvent: (event, meta) => events.push({ event, meta }),
    onStatus: (status) => statuses.push(status),
    log: () => {}
  });
  return { router, qq, bili, calls, events, statuses };
}

function groupMsg(platform, overrides = {}) {
  const isBili = platform === 'bili';
  const groupId = isBili ? BILI_GROUP : 456;
  const userId = isBili ? BILI_VIRTUAL_ID_START + 30 : 111;
  const selfId = isBili ? Number(BILI_SELF) : 10001;
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: selfId,
    group_id: groupId,
    user_id: userId,
    message_id: isBili ? 9001 : 1001,
    time: 1700000000,
    sender: { user_id: userId, card: '群友', nickname: '群友' },
    message: [{ type: 'text', data: { text: '你好' } }],
    ...overrides
  };
}

console.log('\n== 配置解析：旧 snowluma 兼容与号段隔离 ==');

await test('只有 snowluma 的旧配置 → channels.qq 回落到旧 URL/令牌', () => {
  const resolved = resolveChannels({
    snowluma: {
      wsUrl: 'ws://127.0.0.1:3901',
      httpUrl: 'http://127.0.0.1:3900',
      accessToken: 'legacy-ws',
      httpAccessToken: 'legacy-http'
    }
  });
  assert.equal(resolved.qq.wsUrl, 'ws://127.0.0.1:3901');
  assert.equal(resolved.qq.httpUrl, 'http://127.0.0.1:3900');
  assert.equal(resolved.qq.accessToken, 'legacy-ws');
  assert.equal(resolved.qq.httpAccessToken, 'legacy-http');
  assert.equal(resolved.qq.enabled, true);
  assert.equal(resolved.bili.enabled, false);
});

await test('channels.qq 非空值优先于 snowluma', () => {
  const resolved = resolveChannels({
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'old' },
    channels: {
      qq: { wsUrl: 'ws://127.0.0.1:4901', accessToken: 'new' },
      bili: { enabled: true, wsUrl: 'ws://127.0.0.1:4101', accessToken: '' }
    }
  });
  assert.equal(resolved.qq.wsUrl, 'ws://127.0.0.1:4901');
  assert.equal(resolved.qq.accessToken, 'new');
  assert.equal(resolved.bili.enabled, true);
  assert.equal(resolved.bili.wsUrl, 'ws://127.0.0.1:4101');
});

await test('号段重叠 → resolveChannels 直接抛错（不带着歧义启动）', () => {
  assert.throws(() => resolveChannels({
    channels: {
      qq: { idRange: { start: 1, end: 100 } },
      bili: { idRange: { start: 100, end: 200 } }
    }
  }), /重叠/);
});

await test('B站虚拟 ID 常量在安全整数范围内且与 QQ 不相交', () => {
  assert.ok(Number.isSafeInteger(BILI_VIRTUAL_ID_START));
  assert.ok(BILI_VIRTUAL_ID_START > 0);
  assert.ok(BILI_VIRTUAL_ID_START - 1 < BILI_VIRTUAL_ID_START);
  assert.ok(Number.isSafeInteger(Number.MAX_SAFE_INTEGER));
});

console.log('\n== 事件入口：平台标记、自消息、重复事件 ==');

await test('QQ / B站事件分别带上平台与各自 self 身份', () => {
  const { router, events } = build();
  router.dispatch('qq', groupMsg('qq'));
  router.dispatch('bili', groupMsg('bili'));
  assert.equal(events.length, 2);
  assert.equal(events[0].meta.platform, 'qq');
  assert.equal(events[0].meta.selfId, '10001');
  assert.equal(events[0].meta.selfNickname, 'QQBot');
  assert.equal(events[1].meta.platform, 'bili');
  assert.equal(events[1].meta.selfId, BILI_SELF);
  assert.equal(events[1].meta.selfNickname, 'BiliBot');
});

await test('message_sent 与发送者等于本通道 self 的消息被丢弃（防自回环）', () => {
  const { router, events } = build();
  router.dispatch('qq', groupMsg('qq', { post_type: 'message_sent', message_id: 7001 }));
  router.dispatch('qq', groupMsg('qq', { user_id: 10001, message_id: 7002 }));
  router.dispatch('bili', groupMsg('bili', { user_id: Number(BILI_SELF), message_id: 7003 }));
  assert.equal(events.length, 0);
});

await test('重复事件只交付一次（桥接重连重放去重）', () => {
  const { router, events } = build();
  const event = groupMsg('qq', { message_id: 7100 });
  router.dispatch('qq', event);
  router.dispatch('qq', { ...event });
  assert.equal(events.length, 1);
});

console.log('\n== 出站路由：号段决定平台，绝不按默认通道猜 ==');

await test('QQ 群 / B站虚拟群 / B站私信分别进入对应客户端', async () => {
  const { router, calls } = build();
  await router.call('send_group_msg', { group_id: 456, message: [{ type: 'text', data: { text: 'qq' } }] });
  await router.call('send_group_msg', { group_id: BILI_GROUP, message: [{ type: 'text', data: { text: 'bili' } }] });
  await router.call('send_private_msg', { user_id: BILI_USER, message: [{ type: 'text', data: { text: 'dm' } }] });
  assert.deepEqual(calls.qq.map((c) => c.action), ['send_group_msg']);
  assert.deepEqual(calls.bili.map((c) => c.action), ['send_group_msg', 'send_private_msg']);
});

await test('send_msg 按 message_type 路由', async () => {
  const { router, calls } = build();
  await router.call('send_msg', { message_type: 'group', group_id: BILI_GROUP, message: [] });
  await router.call('send_msg', { message_type: 'private', user_id: 777, message: [] });
  assert.equal(calls.bili.length, 1);
  assert.equal(calls.qq.length, 1);
  assert.equal(calls.bili[0].action, 'send_msg');
});

await test('get_group_info / get_group_member_info / get_msg 按目标平台路由', async () => {
  const { router, calls } = build();
  await router.call('get_group_info', { group_id: BILI_GROUP });
  await router.call('get_group_member_info', { group_id: BILI_GROUP, user_id: BILI_USER });
  // 先让 router 见过 B站消息 ID，再查
  const { router: r2, calls: c2 } = build();
  r2.dispatch('bili', groupMsg('bili', { message_id: 8801 }));
  await r2.getMsg(8801);
  assert.deepEqual(calls.bili.map((c) => c.action), ['get_group_info', 'get_group_member_info']);
  assert.deepEqual(c2.bili.map((c) => c.action), ['get_msg']);
});

await test('号段外 ID → 抛错且两侧都不调用', async () => {
  const { router, calls } = build({ qqRange: { start: 1, end: 1000 }, biliRange: { start: 2000, end: 3000 } });
  await assert.rejects(() => router.call('send_group_msg', { group_id: 1500, message: [] }), /不在任何已配置通道的号段内/);
  await assert.rejects(() => router.call('send_group_msg', { group_id: 0, message: [] }), /非法目标 ID/);
  await assert.rejects(() => router.call('send_group_msg', { group_id: 'abc', message: [] }), /非法目标 ID/);
  assert.equal(calls.qq.length + calls.bili.length, 0);
});

await test('B站通道未启用 → B站号段 ID 被拒绝，不会改发 QQ', async () => {
  const { router, calls } = build({ biliEnabled: false });
  await assert.rejects(
    () => router.call('send_group_msg', { group_id: BILI_GROUP, message: [] }),
    /未启用的 B站 通道/
  );
  assert.equal(calls.qq.length + calls.bili.length, 0);
});

await test('显式 platform 与号段冲突 → 拒绝（不允许强行改平台）', async () => {
  const { router, calls } = build();
  await assert.rejects(
    () => router.call('send_group_msg', { group_id: BILI_GROUP, message: [] }, null, { platform: 'qq' }),
    /冲突/
  );
  assert.equal(calls.qq.length + calls.bili.length, 0);
});

console.log('\n== 能力表：B站不支持的动作必须明确抛错 ==');

await test('B站 poke / 合并转发 / QQ 全局动作被拒绝', async () => {
  const { router, calls } = build();
  await assert.rejects(() => router.sendPoke('group', BILI_GROUP, BILI_USER), /不支持动作/);
  await assert.rejects(
    () => router.call('send_group_forward_msg', { group_id: BILI_GROUP, messages: [] }),
    /不支持动作/
  );
  await assert.rejects(() => router.call('get_image', { file: 'x', __platform: 'bili' }), /只支持 QQ/);
  assert.equal(calls.bili.length, 0);
});

await test('B站消息段白名单：video / face / QQ 号 @ 被拒绝，text/image/reply 放行', async () => {
  assert.throws(() => assertSegmentsForPlatform('bili', [{ type: 'video', data: {} }]), /不支持消息段/);
  assert.throws(() => assertSegmentsForPlatform('bili', [{ type: 'face', data: { id: '1' } }]), /不支持消息段/);
  assert.throws(
    () => assertSegmentsForPlatform('bili', [{ type: 'at', data: { qq: '12345' } }]),
    /不在 B站虚拟 ID 号段内/
  );
  assert.doesNotThrow(() => assertSegmentsForPlatform('bili', [
    { type: 'text', data: { text: 'x' } },
    { type: 'at', data: { qq: String(BILI_USER) } },
    { type: 'reply', data: { id: '1' } },
    { type: 'image', data: { file: 'x' } }
  ]));
  const { router, calls } = build();
  await assert.rejects(
    () => router.sendSegments('group', BILI_GROUP, [{ type: 'video', data: { file: 'x' } }]),
    /不支持消息段/
  );
  assert.equal(calls.bili.length, 0);
});

await test('跨平台用户 ID 混用被拒绝（at / 群成员 / poke 目标）', async () => {
  const { router, calls } = build();
  await assert.rejects(
    () => router.sendText('group', 456, 'hi', { atUserId: BILI_USER }),
    /属于 B站 号段.*与目标平台 QQ 不一致/
  );
  await assert.rejects(
    () => router.getGroupMemberInfo(456, BILI_USER),
    /属于 B站 号段.*与目标平台 QQ 不一致/
  );
  await assert.rejects(
    () => router.sendPoke('group', 456, BILI_USER),
    /属于 B站 号段.*与目标平台 QQ 不一致/
  );
  await assert.rejects(
    () => router.sendSegments('group', 456, [{ type: 'at', data: { qq: String(BILI_USER) } }]),
    /属于 B站 号段.*与目标平台 QQ 不一致/
  );
  assert.equal(calls.qq.length + calls.bili.length, 0);
});

await test('channels.bili.extraActions 可声明 custom action', async () => {
  const { router, calls } = build({ biliExtraActions: ['bili_get_video_context'] });
  await router.call('bili_get_video_context', { group_id: BILI_GROUP });
  assert.equal(calls.bili.length, 1);
  assert.equal(calls.bili[0].action, 'bili_get_video_context');
});

await test('bili_* 命名空间无需参数也走 B站（bili-agent-pack 的 call 形态）', async () => {
  const { router, calls } = build();
  assert.equal(router.supportsAction('bili_inspect_user'), true);
  await router.call('bili_inspect_user', { mid: '12345' });
  assert.equal(calls.bili.length, 1);
  assert.equal(calls.bili[0].action, 'bili_inspect_user');
  await assert.rejects(
    () => router.call('bili_inspect_user', { mid: '12345' }, null, { platform: 'qq' }),
    /不能路由到 QQ/
  );
  assert.equal(calls.qq.length, 0);
});

await test('channelFor / isBiliChat 为 Skill 提供会话平台判断', () => {
  const { router } = build();
  assert.equal(router.channelFor(`group:${BILI_GROUP}`), 'bili');
  assert.equal(router.channelFor('group:456'), 'qq');
  assert.equal(router.channelFor('private:777'), 'qq');
  assert.equal(router.channelFor('group:999999999999999999999'), '');
  assert.equal(router.isBiliChat(`group:${BILI_GROUP}`), true);
  assert.equal(router.isBiliChat('group:456'), false);
  assert.equal(router.isBiliChat('group:not-a-number'), false);
});

await test('B站未启用时 bili_* 动作明确报未启用，不落 QQ', async () => {
  const { router, calls } = build({ biliEnabled: false });
  assert.equal(router.supportsAction('bili_inspect_user'), false);
  await assert.rejects(
    () => router.call('bili_inspect_user', { mid: '1' }),
    /B站 通道未启用/
  );
  assert.equal(calls.qq.length + calls.bili.length, 0);
});

console.log('\n== 消息 ID 撞号：不猜，要求显式平台 ==');

await test('两个平台出现同一 message_id → 未指定平台时拒绝', async () => {
  const { router } = build();
  router.dispatch('qq', groupMsg('qq', { message_id: 4242 }));
  router.dispatch('bili', groupMsg('bili', { message_id: 4242 }));
  await assert.rejects(() => router.getMsg(4242), /同时出现/);
});

await test('显式 platform 可跨过撞号；未知 ID 在双通道下拒绝', async () => {
  const { router, calls } = build();
  router.dispatch('qq', groupMsg('qq', { message_id: 4242 }));
  router.dispatch('bili', groupMsg('bili', { message_id: 4242 }));
  await router.getMsg(4242, { platform: 'bili' });
  assert.equal(calls.bili.length, 1);
  await assert.rejects(() => router.getMsg(999999), /无法判定消息/);
});

await test('只有单通道启用时，未知 message_id 可安全回落该通道', async () => {
  const { router, calls } = build({ biliEnabled: false });
  await router.getMsg(123456);
  assert.equal(calls.qq.length, 1);
  assert.equal(calls.qq[0].action, 'get_msg');
});

await test('发送返回的 message_id 自动登记归属', async () => {
  const { router, calls } = build();
  const data = await router.sendText('group', BILI_GROUP, 'hi');
  await router.getMsg(data.message_id);
  assert.equal(calls.bili[0].action, 'send_group_msg');
  assert.equal(calls.bili[1].action, 'get_msg');
});

console.log('\n== 聚合动作 ==');

await test('get_group_list 合并 QQ + B站；get_friend_list 跳过不支持的 B站', async () => {
  const { router, calls } = build();
  const groups = await router.call('get_group_list');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => String(g.group_id)).sort(), [String(456), String(BILI_GROUP)].sort());
  const friends = await router.call('get_friend_list');
  assert.equal(friends.length, 1);
  assert.equal(friends[0].user_id, 777);
  assert.ok(!calls.bili.some((c) => c.action === 'get_friend_list'));
});

await test('聚合中单通道失败仍返回另一通道结果（可用性优先）', async () => {
  const { router } = build({
    biliResponses: { get_group_list: () => { throw new Error('桥接未登录'); } }
  });
  const groups = await router.call('get_group_list');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].group_id, 456);
});

await test('显式 platform 的聚合只查该通道（B站不支持 get_friend_list 时明确抛错）', async () => {
  const { router } = build();
  await assert.rejects(
    () => router.call('get_friend_list', {}, null, { platform: 'bili' }),
    /不支持动作 get_friend_list/
  );
});

console.log('\n== 兼容门面与连接生命周期 ==');

await test('httpUrl / accessToken / tokenCandidates 写入 QQ 通道（旧 app.js 语义）', () => {
  const { router, qq } = build();
  router.httpUrl = 'http://127.0.0.1:9999/';
  router.accessToken = 'rotated';
  router.httpToken = 'rotated-http';
  router.tokenCandidates = [{ wsToken: 'a', httpToken: 'b' }];
  assert.equal(qq.httpUrl, 'http://127.0.0.1:9999');
  assert.equal(qq.accessToken, 'rotated');
  assert.equal(qq.httpToken, 'rotated-http');
  assert.deepEqual(qq.tokenCandidates, [{ wsToken: 'a', httpToken: 'b' }]);
});

await test('connected / selfId / selfNickname 反映默认通道，connect 幂等', async () => {
  const { router, qq, bili } = build();
  assert.equal(router.connected, false);
  await router.connect();
  await router.connect();
  assert.equal(qq.connectCount, 1);
  assert.equal(bili.connectCount, 1);
  assert.equal(router.connected, true);
  assert.equal(router.selfId, '10001');
  assert.equal(router.selfNickname, 'QQBot');
  router.close();
  assert.equal(qq.closeCount, 1);
  assert.equal(bili.closeCount, 1);
  assert.equal(router.connected, false);
});

await test('状态聚合：任一通道变化都广播，且 QQ/B站明细互不覆盖', async () => {
  const { router, qq, bili, statuses } = build();
  await router.connect();
  qq.emitStatus({ connected: false, error: 'ws 401' });
  bili.emitStatus({ connected: true, error: '' });
  const last = statuses.at(-1);
  assert.equal(last.channels.qq.connected, false);
  assert.equal(last.channels.qq.error, 'ws 401');
  assert.equal(last.channels.bili.connected, true);
  assert.equal(last.connected, false, '顶层诊断应锚定 QQ，不被 B站连接覆盖');
});

await test('B站-only 部署：默认身份回落到 B站', async () => {
  const calls = { qq: [], bili: [] };
  const bili = makeFakeClient('bili', { selfId: BILI_SELF, nickname: 'BiliBot', calls: calls.bili });
  const qqDisabled = makeFakeClient('qq', { selfId: 10001, calls: calls.qq });
  const router = new ChannelRouter({
    channels: {
      qq: { enabled: false, idRange: { start: 1, end: BILI_VIRTUAL_ID_START - 1 }, client: qqDisabled },
      bili: { enabled: true, idRange: { start: BILI_VIRTUAL_ID_START, end: Number.MAX_SAFE_INTEGER }, client: bili }
    },
    log: () => {}
  });
  await router.connect();
  assert.equal(router.defaultPlatform, 'bili');
  assert.equal(router.selfId, BILI_SELF);
  assert.equal(router.connected, true);
  assert.equal(calls.qq.length, 0);
});

await test('号段重叠的 ChannelRouter 构造直接失败', () => {
  const qq = makeFakeClient('qq', { selfId: 1 });
  const bili = makeFakeClient('bili', { selfId: BILI_VIRTUAL_ID_START });
  assert.throws(() => new ChannelRouter({
    channels: {
      qq: { enabled: true, idRange: { start: 1, end: BILI_VIRTUAL_ID_START + 1 }, client: qq },
      bili: { enabled: true, idRange: { start: BILI_VIRTUAL_ID_START, end: Number.MAX_SAFE_INTEGER }, client: bili }
    }
  }), /号段重叠/);
});

console.log('\n' + '='.repeat(64));
if (failed) {
  console.log(`ChannelRouter：${failed} 项失败`);
  process.exitCode = 1;
} else {
  console.log('ChannelRouter：全部通过');
}
