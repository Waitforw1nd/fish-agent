/**
 * SendGuard / SendQueue 统一出口测试（node test/send-guard-test.mjs）。
 *
 * 重点不是"发得出去"，而是：
 *   · 白名单/号段/能力校验在发送层仍然生效（防提醒、工具、主动发言绕过）；
 *   · B站评论合并成一条、15 秒级低頻、超长拒绝而不是拆成刷屏；
 *   · QQ 行为保持不变（多条消息仍逐条、无 B站等待）；
 *   · send.guard 能力提供者可拒绝/改写，且异常时 fail-closed；
 *   · 现有去重与限频不被新守卫破坏。
 */
import assert from 'node:assert/strict';
import { SendQueue, SendGuard } from '../src/sender.js';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { BILI_VIRTUAL_ID_START } from '../src/config.js';

const BILI_GROUP = BILI_VIRTUAL_ID_START + 100;
const BILI_USER = BILI_VIRTUAL_ID_START + 200;
const BILI_LIVE_GROUP = BILI_VIRTUAL_ID_START + 300;

// 全局运行配置：把真人化间隔压到 1~2ms，限频放宽；guard 的具体节流由每个
// 用例注入 getConfigFn 控制，避免测试真的等 15 秒。
const runtimeConfig = structuredClone(DEFAULT_CONFIG);
runtimeConfig.send = {
  ...runtimeConfig.send,
  minGapMs: 1,
  maxGapMs: 2,
  byLengthMs: 0,
  maxPerMinute: 1000,
  maxPerHour: 10000,
  hardSplitAt: 4000,
  dedupeWindowMs: 8000
};
runtimeConfig.allow = { groups: [], private: [] };
runtimeConfig.allowAllWhenEmpty = true;
setRuntimeConfig(runtimeConfig);

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

function makeOneBot() {
  const sends = [];
  const onebot = {
    sends,
    platformFor(kind, id) {
      if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话类型：${kind}`);
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`非法目标 ID：${id}`);
      return n >= BILI_VIRTUAL_ID_START ? 'bili' : 'qq';
    },
    assertAction(platform, action) {
      if (platform !== 'bili') return;
      const unsupported = new Set([
        'send_poke', 'friend_poke', 'group_poke',
        'send_group_forward_msg', 'send_private_forward_msg', 'get_forward_msg'
      ]);
      if (unsupported.has(action)) throw new Error(`B站通道不支持动作 ${action}（已拒绝）`);
    },
    async sendText(kind, id, text, options) {
      sends.push({ action: 'text', kind, id: String(id), text, options });
      return { message_id: sends.length };
    },
    async sendImage(kind, id, file, options) {
      sends.push({ action: 'image', kind, id: String(id), file, options });
      return { message_id: sends.length };
    },
    async sendSticker(kind, id, file, options) {
      sends.push({ action: 'sticker', kind, id: String(id), file, options });
      return { message_id: sends.length };
    },
    async sendSegments(kind, id, segments) {
      sends.push({ action: 'segments', kind, id: String(id), segments });
      return { message_id: sends.length };
    },
    async sendPoke(kind, id, targetUserId) {
      sends.push({ action: 'poke', kind, id: String(id), targetUserId });
      return { message_id: null };
    },
    async call(action, params) {
      sends.push({ action: 'call', call: action, params });
      return {};
    }
  };
  return onebot;
}

function makeQueue({
  onebot = makeOneBot(),
  isAllowed = null,
  guardBili = {},
  guardEnabled = true,
  providers = null
} = {}) {
  const guardCfg = {
    enabled: guardEnabled,
    bili: { ...DEFAULT_CONFIG.send.guard.bili, ...guardBili }
  };
  const guard = new SendGuard({
    onebot,
    isAllowed,
    getConfigFn: () => ({ send: { guard: guardCfg } }),
    getProviders: providers ? () => providers : undefined,
    log: () => {}
  });
  const appended = [];
  const queue = new SendQueue({
    onebot,
    store: { appendSelf(chatKey, entry) { appended.push({ chatKey, entry }); } },
    guard,
    log: () => {}
  });
  return { queue, guard, onebot, appended };
}

console.log('\n== 平台默认值 ==');

await test('B站评论默认 ≥15 秒且带抖动；私信/直播独立间隔', () => {
  assert.ok(DEFAULT_CONFIG.send.guard.bili.commentMinGapMs >= 15000);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.commentJitterMs > 0);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.dmMinGapMs > 0);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.liveMinGapMs > 0);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.maxTextChars > 0);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.dmMaxTextBytes > 0);
  assert.ok(DEFAULT_CONFIG.send.guard.bili.liveMaxTextChars > 0);
});

console.log('\n== 白名单 / 号段 / 能力 ==');

await test('白名单在发送层生效（提醒/工具绕过也会被拒）', async () => {
  let allow = false;
  const { queue, onebot } = makeQueue({ isAllowed: () => allow });
  await assert.rejects(async () => queue.sendTextBatch('group:456', ['hi']), /不在白名单内/);
  assert.equal(onebot.sends.length, 0);
  allow = true;
  await queue.sendTextBatch('group:456', ['hi']);
  assert.equal(onebot.sends.length, 1);
});

await test('guard.enabled=false 仍保留白名单/号段/能力闸', async () => {
  const { queue, onebot } = makeQueue({
    guardEnabled: false,
    isAllowed: () => false
  });
  await assert.rejects(async () => queue.sendTextBatch('group:456', ['hi']), /不在白名单内/);
  assert.equal(onebot.sends.length, 0);

  const { queue: q2, onebot: ob2 } = makeQueue({ guardEnabled: false });
  await assert.rejects(async () => q2.poke(`group:${BILI_GROUP}`, BILI_USER), /不支持动作/);
  assert.equal(ob2.sends.length, 0);
});

await test('号段外 ID 在发送层被拒绝，不会落到默认 QQ', async () => {
  const onebot = makeOneBot();
  const guard = new SendGuard({
    onebot,
    getConfigFn: () => ({ send: { guard: DEFAULT_CONFIG.send.guard } })
  });
  // 纯 OneBotClient 桩没有 platformFor 时默认 qq；这里显式造一个拒绝的桩。
  const rejecting = {
    ...onebot,
    platformFor() { throw new Error('目标 ID 不在任何已配置通道的号段内'); }
  };
  const q = new SendQueue({
    onebot: rejecting,
    store: { appendSelf() {} },
    guard: new SendGuard({ onebot: rejecting, getConfigFn: () => ({ send: { guard: DEFAULT_CONFIG.send.guard } }) })
  });
  await assert.rejects(async () => q.sendTextBatch('group:456', ['hi']), /号段内/);
  assert.equal(onebot.sends.length, 0);
  assert.ok(guard);
});

console.log('\n== B站：评论合并、低頻、长度 ==');

await test('B站群多条文本合并成一条评论（不拆成刷屏）', async () => {
  const { queue, onebot } = makeQueue({ guardBili: { commentMinGapMs: 0, commentJitterMs: 0 } });
  const result = await queue.sendTextBatch(`group:${BILI_GROUP}`, ['第一句', '第二句']);
  assert.equal(onebot.sends.length, 1);
  assert.equal(onebot.sends[0].text, '第一句\n第二句');
  assert.equal(result.sent.length, 1);
});

await test('B站评论最小间隔带抖动（用 60ms 配置验证真实等待）', async () => {
  const { queue, onebot } = makeQueue({ guardBili: { commentMinGapMs: 60, commentJitterMs: 0 } });
  await queue.sendTextBatch(`group:${BILI_GROUP}`, ['第一条']);
  const started = Date.now();
  await queue.sendTextBatch(`group:${BILI_GROUP}`, ['第二条']);
  const elapsed = Date.now() - started;
  assert.equal(onebot.sends.length, 2);
  assert.ok(elapsed >= 45, `第二条应等待约 60ms，实际 ${elapsed}ms`);
});

await test('B站私信独立低頻队列（与评论互不影响）', async () => {
  const { queue, onebot } = makeQueue({
    guardBili: { commentMinGapMs: 500, commentJitterMs: 0, dmMinGapMs: 40 }
  });
  await queue.sendTextBatch(`private:${BILI_USER}`, ['私信一']);
  const started = Date.now();
  await queue.sendTextBatch(`private:${BILI_USER}`, ['私信二']);
  assert.ok(Date.now() - started >= 30, '私信应按自己的间隔等待');
  assert.equal(onebot.sends.length, 2);
});

await test('B站直播 surface 使用独立间隔', async () => {
  const { queue, onebot } = makeQueue({
    guardBili: { commentMinGapMs: 500, commentJitterMs: 0, liveMinGapMs: 40 }
  });
  await queue.sendTextBatch(`group:${BILI_LIVE_GROUP}`, ['直播一'], { surface: 'live' });
  const started = Date.now();
  await queue.sendTextBatch(`group:${BILI_LIVE_GROUP}`, ['直播二'], { surface: 'live' });
  assert.ok(Date.now() - started >= 30);
  assert.equal(onebot.sends.length, 2);
});

await test('B站超长消息直接拒绝，不拆分成多条评论', async () => {
  const { queue, onebot } = makeQueue({ guardBili: { maxTextChars: 10 } });
  await assert.rejects(
    () => queue.sendTextBatch(`group:${BILI_GROUP}`, ['x'.repeat(11)]),
    /最多 10 字/
  );
  assert.equal(onebot.sends.length, 0);
  await assert.rejects(
    () => queue.sendTextBatch(`group:${BILI_GROUP}`, ['123456', '789012']),
    /最多 10 字/
  );
  assert.equal(onebot.sends.length, 0);
});

await test('B站私信按 UTF-8 字节上限拒绝（中文 3 字节/字）', async () => {
  const { queue, onebot } = makeQueue({ guardBili: { maxTextChars: 1000, dmMaxTextBytes: 10 } });
  await assert.rejects(
    () => queue.sendTextBatch(`private:${BILI_USER}`, ['你好世界']),
    /最多 10 字节/
  );
  assert.equal(onebot.sends.length, 0);
});

await test('B站 poke / 视频段被拒绝且不产生发送', async () => {
  const { queue, onebot } = makeQueue();
  await assert.rejects(async () => queue.poke(`group:${BILI_GROUP}`, BILI_USER), /不支持动作/);
  await assert.rejects(
    async () => queue.sendMedia(`group:${BILI_GROUP}`, [{ type: 'video', data: { file: 'x.mp4' } }]),
    /不支持消息段/
  );
  assert.equal(onebot.sends.length, 0);
});

console.log('\n== QQ 行为保持 ==');

await test('QQ 多条文本仍逐条发送，不合并、不受 B站间隔影响', async () => {
  const { queue, onebot } = makeQueue({ guardBili: { commentMinGapMs: 500 } });
  const started = Date.now();
  await queue.sendTextBatch('group:456', ['甲', '乙']);
  assert.equal(onebot.sends.length, 2);
  assert.deepEqual(onebot.sends.map((s) => s.text), ['甲', '乙']);
  assert.ok(Date.now() - started < 300, 'QQ 不应等待 B站评论间隔');
});

await test('QQ 长文本仍按 hardSplitAt 切分', async () => {
  const oldHard = runtimeConfig.send.hardSplitAt;
  runtimeConfig.send.hardSplitAt = 10;
  try {
    const { queue, onebot } = makeQueue();
    await queue.sendTextBatch('group:456', ['0123456789ABCDEFGHIJ']);
    assert.ok(onebot.sends.length >= 2, `应切分，实际 ${onebot.sends.length} 条`);
  } finally {
    runtimeConfig.send.hardSplitAt = oldHard;
  }
});

console.log('\n== send.guard 提供者 ==');

await test('提供者 allow:false 会拒绝且不发送', async () => {
  const provider = { skillId: 'anti-ban-test', fn: async () => ({ allow: false, reason: '敏感内容' }) };
  const { queue, onebot } = makeQueue({ providers: [provider] });
  await assert.rejects(async () => queue.sendTextBatch('group:456', ['测试']), /send\.guard 拦截.*敏感内容/);
  assert.equal(onebot.sends.length, 0);
});

await test('anti-ban-guard 的 {ok:false,block:true} 契约同样拒绝（不能静默放行）', async () => {
  const provider = {
    skillId: 'anti-ban-guard',
    fn: async () => ({ ok: false, block: true, code: 'night-silence', reason: '夜间静默中' })
  };
  const { queue, onebot } = makeQueue({ providers: [provider] });
  await assert.rejects(async () => queue.sendTextBatch('group:456', ['晚安']), /send\.guard 拦截.*夜间静默/);
  assert.equal(onebot.sends.length, 0);
});

await test('守卫上下文携带 atUserId / replyToMessageId（夜间静默豁免依据）', async () => {
  let seen = null;
  const provider = {
    skillId: 'capture',
    fn: async (ctx) => { seen = ctx; return true; }
  };
  const { queue } = makeQueue({ providers: [provider] });
  await queue.sendTextBatch('group:456', ['有人找我'], { atUserId: '777', replyToMessageId: '99' });
  assert.equal(seen.atUserId, '777');
  assert.equal(seen.replyToMessageId, '99');
  assert.equal(seen.chatKey, 'group:456');
});

await test('提供者可改写文本（敏感词替换）并进入去重指纹', async () => {
  const provider = { skillId: 'anti-ban-test', fn: async () => ({ text: '已安全改写' }) };
  const { queue, onebot } = makeQueue({ providers: [provider] });
  await queue.sendTextBatch('group:456', ['原始内容']);
  assert.equal(onebot.sends[0].text, '已安全改写');
});

await test('提供者抛错 = fail-closed（不会退化成无守卫）', async () => {
  const provider = { skillId: 'broken-test', fn: async () => { throw new Error('策略服务不可用'); } };
  const { queue, onebot } = makeQueue({ providers: [provider] });
  await assert.rejects(async () => queue.sendTextBatch('group:456', ['测试']), /send\.guard 拦截.*策略服务不可用/);
  assert.equal(onebot.sends.length, 0);
});

console.log('\n== 现有去重 / 限频保持 ==');

await test('相同文本窗口内只发一次', async () => {
  const { queue, onebot } = makeQueue();
  await queue.sendTextBatch('group:456', ['重复内容']);
  const second = await queue.sendTextBatch('group:456', ['重复内容']);
  assert.equal(onebot.sends.length, 1);
  assert.equal(second.sent[0].deduped, true);
});

await test('分钟限频仍生效（超限拒绝）', async () => {
  const oldMinute = runtimeConfig.send.maxPerMinute;
  runtimeConfig.send.maxPerMinute = 1;
  try {
    const { queue, onebot } = makeQueue();
    await queue.sendTextBatch('group:456', ['第一条']);
    await assert.rejects(async () => queue.sendTextBatch('group:456', ['第二条']), /发送频率超限/);
    assert.equal(onebot.sends.length, 1);
  } finally {
    runtimeConfig.send.maxPerMinute = oldMinute;
  }
});

console.log('\n== 图片 / 表情 / 媒体留档 ==');

await test('B站图片走 image 段并留档（不经过 QQ）', async () => {
  const { queue, onebot, appended } = makeQueue();
  await queue.sendImage(`group:${BILI_GROUP}`, { url: 'https://example.com/a.png' }, { note: '测试图' });
  assert.equal(onebot.sends.length, 1);
  assert.equal(onebot.sends[0].action, 'image');
  assert.equal(onebot.sends[0].kind, 'group');
  assert.ok(appended.some((a) => a.entry.text.includes('测试图')));
});

await test('QQ 表情发送仍可用', async () => {
  const { queue, onebot } = makeQueue();
  await queue.sendSticker('group:456', { id: 'st1', url: 'https://example.com/s.png', desc: '滑稽' });
  assert.equal(onebot.sends.length, 1);
  assert.equal(onebot.sends[0].action, 'sticker');
});

console.log('\n' + '='.repeat(64));
if (failed) {
  console.log(`SendGuard：${failed} 项失败`);
  process.exitCode = 1;
} else {
  console.log('SendGuard：全部通过');
}
