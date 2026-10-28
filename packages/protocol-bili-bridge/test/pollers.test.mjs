import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBili } from './support/fake-bili.mjs';
import { tempDir, makeConfig, waitFor } from './support/helpers.mjs';
import { BiliBridge } from '../src/bridge.js';
import { commentRootParent, normalizeReply } from '../src/bili/comment.js';
import { normalizeMsgfeedReply, replyIsAtSelf } from '../src/bili/msgfeed.js';

async function setupPoller() {
  const fake = await FakeBili.start();
  const dataDir = await tempDir();
  const config = makeConfig({ fake, dataDir });
  const events = [];
  const bridge = new BiliBridge({
    config,
    dispatcher: (event) => events.push(event),
    refreshPublicKey: fake.publicKey
  });
  try {
    await bridge.init();
    fake.applyCookiesTo(bridge.jar);
    await bridge.auth.getSelfInfo({ refresh: true });
    await bridge.refreshIdentity();
    assert.ok(bridge.selfId > 0);
  } catch (error) {
    await bridge.stop().catch(() => {});
    await fake.close().catch(() => {});
    throw error;
  }
  return {
    fake,
    dataDir,
    config,
    bridge,
    events,
    cleanup: async () => {
      await bridge.stop().catch(() => {});
      await fake.close().catch(() => {});
    }
  };
}

test('评论 root/parent 计算与 msgfeed 归一化', () => {
  assert.deepEqual(commentRootParent(null), { root: '0', parent: '0' });
  assert.deepEqual(commentRootParent({ rpid: '100', root: '0' }), { root: '100', parent: '100' });
  assert.deepEqual(commentRootParent({ rpid: '200', root: '100' }), { root: '100', parent: '200' });

  const normalized = normalizeReply({
    rpid: 1234567890123456789,
    rpid_str: '1234567890123456789',
    oid: 170001,
    root: 0,
    member: { mid: 20002, uname: '观众A' },
    content: {
      message: '@测试UP主 你好',
      members: [{ mid: 10086, uname: '测试UP主' }],
      at_name_to_mid: { 测试UP主: 10086 }
    },
    ctime: 123
  });
  assert.equal(normalized.rpid, '1234567890123456789');
  assert.equal(normalized.atNameToMid['测试UP主'], '10086');

  const item = {
    id: 77,
    user: { mid: 20002, nickname: '观众A', avatar: '', follow: false },
    item: {
      subject_id: 170001,
      root_id: 0,
      source_id: '1890000000000000001',
      target_id: 0,
      type: 'reply',
      business_id: 1,
      business: '视频',
      title: '标题',
      uri: 'https://www.bilibili.com/video/BV1xx411c7mD',
      source_content: '@测试UP主 你好',
      target_reply_content: '原评论',
      root_reply_content: '',
      at_details: [{ mid: 10086, nickname: '测试UP主', avatar: '', follow: false }],
      message: ''
    },
    counts: 1,
    is_multi: 0,
    reply_time: 100
  };
  const messages = normalizeMsgfeedReply(item);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].rpid, '1890000000000000001');
  assert.equal(messages[0].oid, '170001');
  assert.equal(messages[0].message, '@测试UP主 你好');
  assert.equal(messages[0].contextContent, '原评论');
  assert.equal(messages[0].isVideo, true);
  assert.equal(replyIsAtSelf(messages[0], { selfMid: '10086', selfName: '测试UP主' }), true);
  assert.equal(replyIsAtSelf(messages[0], { selfMid: '99999', selfName: '别人' }), false);
});

test('ReplyWatcher：首次基线不回补、投递回复/@、去重与订阅开关', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { fake, bridge, events } = env;

  fake.addMsgfeedReply({ atSelf: true, message: '@测试UP主 历史消息', rpid: '1890000000000000101' });
  const baseline = await bridge.replyWatcher.poll();
  assert.equal(baseline.baseline, 1);
  assert.equal(events.length, 0);
  assert.equal(bridge.pollState.getCursor('msgfeed').initialized, true);

  fake.addMsgfeedReply({ atSelf: true, message: '@测试UP主 新消息', context: '原评论内容', rpid: '1890000000000000102', ctime: 1_700_000_101 });
  const emitted = await bridge.replyWatcher.poll();
  assert.equal(emitted.emitted, 1);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.post_type, 'message');
  assert.equal(event.message_type, 'group');
  assert.ok(Number.isSafeInteger(event.message_id));
  assert.equal(event.self_id, bridge.selfId);
  const at = event.message.find((segment) => segment.type === 'at');
  assert.equal(at.data.qq, String(bridge.selfId));
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('新消息')));
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('[原评论]')));

  const again = await bridge.replyWatcher.poll();
  assert.equal(again.skipped, true);
  assert.equal(events.length, 1);

  fake.addMsgfeedReply({ atSelf: false, message: '普通回复', rpid: '1890000000000000103' });
  const plainPoll = await bridge.replyWatcher.poll();
  assert.equal(plainPoll.emitted, 1);
  assert.equal(events.length, 2);
  assert.ok(events[1].message.some((segment) => segment.type === 'text' && segment.data.text.includes('普通回复')));
  assert.equal(events[1].message.some((segment) => segment.type === 'at'), false);

  fake.addMsgfeedAt({ message: '@测试UP主 独立@', rpid: '1890000000000000105', ctime: 1_700_000_102 });
  const atPoll = await bridge.replyWatcher.poll();
  assert.equal(atPoll.emitted, 1);
  assert.equal(events.length, 3);
  assert.ok(events[2].message.some((segment) => segment.type === 'at' && segment.data.qq === String(bridge.selfId)));
  assert.ok(events[2].message.some((segment) => segment.type === 'text' && segment.data.text.includes('独立@')));

  await bridge.setSubscriptions({ at: false });
  fake.addMsgfeedReply({ atSelf: true, message: '@测试UP主 关闭后', rpid: '1890000000000000104' });
  const off = await bridge.replyWatcher.poll();
  assert.equal(off.skipped, true);
  assert.equal(events.length, 3);
  await bridge.setSubscriptions({ at: true });
});

test('CommentWatcher：首次基线、增量投递、自评过滤与去重', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { fake, bridge, events } = env;
  await bridge.setWatches({ videos: ['BV1xx411c7mD'] });

  fake.addComment('170001', { rpid: '1890000000000000201', message: '历史评论', mid: '20002', uname: '观众A' });
  const baseline = await bridge.commentWatcher.poll();
  assert.equal(baseline.emitted, 0);
  assert.equal(events.length, 0);
  const group = await bridge.mapping.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001' });
  assert.ok(group.id);

  fake.addComment('170001', { rpid: '1890000000000000202', message: '新评论', mid: '20003', uname: '观众B', ctime: 1_700_000_300 });
  const polled = await bridge.commentWatcher.poll();
  assert.equal(polled.emitted, 1);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.group_id, group.id);
  assert.equal(event.sender.nickname, '观众B');
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text === '新评论'));
  assert.ok(Number.isSafeInteger(event.message_id));

  const record = bridge.ring.get(event.message_id);
  assert.equal(record.native.rpid, '1890000000000000202');
  assert.equal(record.native.root, '1890000000000000202');

  await bridge.commentWatcher.poll();
  assert.equal(events.length, 1);

  fake.addComment('170001', { rpid: '1890000000000000203', message: '自评', mid: '10086', uname: '测试UP主', ctime: 1_700_000_301 });
  await bridge.commentWatcher.poll();
  assert.equal(events.length, 1);
});

test('CommentWatcher 展开楼中楼预览并保留真实 root/parent', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { fake, bridge, events } = env;
  await bridge.setWatches({ videos: ['BV1xx411c7mD'] });
  const nested = {
    rpid: '1890000000000000302',
    rpid_str: '1890000000000000302',
    oid: 170001,
    root: 0,
    parent: 0,
    member: { mid: 20003, uname: '观众B', avatar: '' },
    content: { message: '楼中楼', members: [], at_name_to_mid: {} },
    ctime: 1_700_000_400,
    like: 0,
    rcount: 0
  };
  fake.addComment('170001', {
    rpid: '1890000000000000301',
    mid: '20002',
    uname: '观众A',
    message: '主楼',
    ctime: 1_700_000_399,
    replies: [nested]
  });
  await bridge.commentWatcher.poll();
  assert.equal(events.length, 0);

  fake.addComment('170001', {
    rpid: '1890000000000000303',
    mid: '20004',
    uname: '观众C',
    message: '新主楼带楼中楼',
    ctime: 1_700_000_401,
    replies: [{
      rpid: '1890000000000000304',
      rpid_str: '1890000000000000304',
      oid: 170001,
      member: { mid: 20005, uname: '观众D' },
      content: { message: '新楼中楼', members: [], at_name_to_mid: {} },
      ctime: 1_700_000_402,
      like: 0,
      rcount: 0
    }]
  });
  await bridge.commentWatcher.poll();
  const records = events.map((event) => bridge.ring.get(event.message_id)).filter(Boolean);
  const nestedRecord = records.find((record) => record.native.rpid === '1890000000000000304');
  assert.ok(nestedRecord);
  assert.equal(nestedRecord.native.root, '1890000000000000303');
  assert.equal(nestedRecord.native.parent, '1890000000000000303');
  assert.ok(events.length >= 2);
});

test('UpWatcher：首次基线、新视频映射群、去重', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { fake, bridge, events } = env;
  await bridge.setWatches({ ups: ['20002'] });
  fake.addUserCard({ mid: '20002', name: '观众A' });
  fake.upVideos.set('20002', []);

  await bridge.upWatcher.poll();
  assert.equal(events.length, 0);

  fake.addUpVideo('20002', {
    bvid: 'BV1new0000001',
    aid: 180001,
    title: '新视频标题',
    created: 1_700_000_500,
    author: '观众A'
  });
  fake.addVideo({ bvid: 'BV1new0000001', aid: 180001, title: '新视频标题', owner: { mid: '20002', name: '观众A' } });
  const polled = await bridge.upWatcher.poll();
  assert.equal(polled.emitted, 1);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('新视频标题')));
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text.includes('BV1new0000001')));
  const group = await bridge.mapping.groupForVideo({ bvid: 'BV1new0000001' });
  assert.equal(event.group_id, group.id);

  await bridge.upWatcher.poll();
  assert.equal(events.length, 1);
});

test('DmWatcher：基线、增量、safe message_id、ack 与重启不重复', async (t) => {
  const env = await setupPoller();
  const { fake, bridge, events, dataDir, config } = env;
  t.after(async () => {
    await env.cleanup();
  });
  fake.addDmSession('20002', { name: '观众A' });
  fake.addDmSession('844424930131966', { name: 'UP主小助手', systemMsgType: 7 });
  fake.addDmMessage('844424930131966', { text: '系统通知', seqno: '1780000000000000099', timestamp: 1_700_000_599 });
  fake.addDmMessage('20002', { text: '历史私信', seqno: '1780000000000000101', timestamp: 1_700_000_600 });
  const baseline = await bridge.dmWatcher.poll();
  assert.equal(baseline.emitted, 0);
  assert.equal(events.length, 0);
  assert.ok(fake.count('/session_svr/v1/session_svr/update_ack') >= 1);
  assert.equal(fake.requestsTo('/session_svr/v1/session_svr/get_sessions').length >= 1, true);

  fake.addDmMessage('20002', { text: '新私信', seqno: '1780000000000000102', timestamp: 1_700_000_601 });
  const polled = await bridge.dmWatcher.poll();
  assert.equal(polled.emitted, 1);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.message_type, 'private');
  assert.ok(Number.isSafeInteger(event.message_id));
  assert.equal(event.self_id, bridge.selfId);
  assert.equal(event.sender.nickname, '观众A');
  assert.ok(event.message.some((segment) => segment.type === 'text' && segment.data.text === '新私信'));
  const ack = fake.last('/session_svr/v1/session_svr/update_ack');
  assert.equal(ack.form.ack_seqno, '1780000000000000102');

  await bridge.dmWatcher.poll();
  assert.equal(events.length, 1);

  const restarted = new BiliBridge({ config, dispatcher: (item) => events.push(item), refreshPublicKey: fake.publicKey });
  await restarted.init();
  fake.applyCookiesTo(restarted.jar);
  await restarted.auth.getSelfInfo({ refresh: true });
  await restarted.refreshIdentity();
  await restarted.dmWatcher.poll();
  assert.equal(events.length, 1);
  await restarted.stop();

  await bridge.setSubscriptions({ dm: false });
  const skipped = await bridge.dmWatcher.poll();
  assert.equal(skipped.skipped, true);
  assert.equal(events.length, 1);
  await bridge.setSubscriptions({ dm: true });
});


test('评论与 msgfeed 共用 rpid 去重，避免同一条 @ 回复投递两次', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { fake, bridge, events } = env;
  await bridge.setWatches({ videos: ['BV1xx411c7mD'] });
  await bridge.commentWatcher.poll();
  await bridge.replyWatcher.poll();
  const rpid = '1890000000000000401';
  fake.addComment('170001', { rpid, mid: '20002', uname: '观众A', message: '@测试UP主 同一条评论', ctime: 1_700_000_700 });
  fake.addMsgfeedReply({ atSelf: true, message: '@测试UP主 同一条评论', rpid, context: '原评论', ctime: 1_700_000_700 });
  await bridge.replyWatcher.poll();
  assert.equal(events.length, 1);
  await bridge.commentWatcher.poll();
  assert.equal(events.length, 1);
  const record = bridge.ring.get(events[0].message_id);
  assert.equal(record.native.rpid, rpid);
  assert.ok(events[0].message.some((segment) => segment.type === 'at' && segment.data.qq === String(bridge.selfId)));
});

test('动态通知映射到动态群并保留图文评论主体', async (t) => {
  const env = await setupPoller();
  t.after(env.cleanup);
  const { bridge, events } = env;
  const item = { rpid: '777', oid: '999', uri: 'https://t.bilibili.com/90071992547409999', isVideo: false, mid: '20002', uname: 'A', message: '动态回复', ctime: 123 };
  let items = [];
  bridge.replyWatcher.msgfeed = { unread: async () => ({ total: 1 }), replies: async () => ({ items, cursor: {} }), normalizeItems: (value) => value };
  bridge.dynamicService.detail = async () => ({ type: 11, oid: '34567', title: '动态' });
  await bridge.replyWatcher.poll();
  items = [item];
  assert.equal((await bridge.replyWatcher.poll()).emitted, 1);
  const record = bridge.ring.get(events[0].message_id);
  assert.equal(bridge.mapping.resolveGroup(record.group_id).native.dynamicId, '90071992547409999');
  assert.equal(record.native.oid, '34567');
  assert.equal(record.native.type, 11);
});
