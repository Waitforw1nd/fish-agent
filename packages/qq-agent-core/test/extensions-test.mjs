// 真实扩展加载与行为测试：anti-ban-guard / trpg-dice-hook / bili-watcher / bili-agent-pack。
// 全部在临时数据目录运行，不联网、不触碰真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ext-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
process.env.ANTI_BAN_GUARD_STATE_FILE = path.join(tmp, 'anti-ban-state.json');
process.env.BILI_WATCH_STATE_FILE = path.join(tmp, 'bili-watch-state.json');
process.env.BILI_WATCH_PLAN_FILE = path.join(tmp, 'bili-watch-plan.json');
process.env.QQ_AGENT_HOT_RELOAD = '0';
delete process.env.QQ_AGENT_EXTENSIONS_ALLOW;

const { loadPlugins } = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const { updateConfig } = await import('../src/config.js');
const { getTool } = await import('../src/tool-registry.js');
const dice = await import('../plugins/trpg-dice-hook/index.js');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}\n      ${error?.message ?? error}`); }
};
const provider = (cap) => {
  const list = skillManager.getCapabilityProviders(cap, {});
  assert.ok(list.length, `没有可用的 ${cap} 提供者`);
  return list[0].fn;
};

console.log('\n=== 加载 ===');
const loaded = await loadPlugins({
  roots: { skills: path.join(ROOT, 'skills'), plugins: path.join(ROOT, 'plugins') },
  log: () => {}
});
await check('四个扩展都加载成功', async () => {
  const ids = new Set(loaded.loaded.map((r) => r.id));
  for (const id of ['anti-ban-guard', 'trpg-dice-hook', 'bili-watcher', 'bili-agent-pack']) {
    assert.ok(ids.has(id), `缺少 ${id}`);
  }
  assert.equal(loaded.failed.length, 0, `加载失败：${loaded.failed.map((f) => `${f.id}:${f.error}`).join('; ')}`);
});

console.log('\n=== anti-ban-guard ===');
updateConfig({
  skills: {
    'anti-ban-guard': {
      enabled: true,
      nightSilence: false,
      warmupDays: 0,
      maxPerMinute: 10,
      maxPerHour: 120,
      breakerCooldownMs: 1000,
      sensitiveAction: 'block',
      sensitivePatterns: '代开发票'
    }
  }
});

await check('敏感内容被 send.guard 拦截', async () => {
  const guard = provider('send.guard');
  const r = await guard({ chatKey: 'group:sensitive', text: '需要代开发票吗', now: Date.now() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'sensitive-content');
});

await check('兼容 guard(chatKey, text) 调用姿势', async () => {
  const guard = provider('send.guard');
  const r = await guard('group:sig', '代开发票');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'sensitive-content');
});

await check('sensitiveAction=warn 时放行', async () => {
  updateConfig({ skills: { 'anti-ban-guard': { sensitiveAction: 'warn' } } });
  const guard = provider('send.guard');
  const r = await guard({ chatKey: 'group:warn', text: '代开发票', now: Date.now() });
  assert.equal(r, true);
  updateConfig({ skills: { 'anti-ban-guard': { sensitiveAction: 'block' } } });
});

await check('夜间静默拦截普通发言，但 @ 可豁免', async () => {
  updateConfig({ skills: { 'anti-ban-guard': { nightSilence: true, nightStart: '00:00', nightEnd: '23:59', allowAtNight: true } } });
  const guard = provider('send.guard');
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const denied = await guard({ chatKey: 'group:night1', text: '晚安', now: noon.getTime() });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'night-silence');
  const allowed = await guard({ chatKey: 'group:night2', text: '在吗', atUserId: 12345, now: noon.getTime() });
  assert.equal(allowed, true);
  updateConfig({ skills: { 'anti-ban-guard': { nightSilence: false } } });
});

await check('频率超限触发熔断并拒绝后续发送', async () => {
  updateConfig({ skills: { 'anti-ban-guard': { warmupDays: 0, maxPerMinute: 2, maxPerHour: 100, breakerCooldownMs: 5000 } } });
  const guard = provider('send.guard');
  const now = Date.now();
  assert.equal(await guard({ chatKey: 'group:rate', text: '1', now }), true);
  assert.equal(await guard({ chatKey: 'group:rate', text: '2', now }), true);
  const r = await guard({ chatKey: 'group:rate', text: '3', now });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate-limit');
  const open = await guard({ chatKey: 'group:rate', text: '4', now: now + 1 });
  assert.equal(open.ok, false);
  assert.equal(open.code, 'circuit-open');
});

await check('before-tool 兜底拦截敏感内容', async () => {
  const hook = skillManager.registry.get('anti-ban-guard')?.hooks?.['before-tool'];
  assert.equal(typeof hook, 'function');
  const r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '代开发票' }) });
  assert.equal(r?.block, true);
});

await check('真实 SendGuard 消费 anti-ban 的 send.guard 能力', async () => {
  // 重载插件清掉前面的频率/熔断状态
  skillManager.deactivate('anti-ban-guard');
  skillManager.activate('anti-ban-guard');
  const { SendGuard } = await import('../src/sender.js');
  const guard = new SendGuard({
    onebot: { platformFor: () => 'qq' },
    getProviders: () => skillManager.getCapabilityProviders('send.guard', {}),
    getConfigFn: () => ({ send: { guard: { enabled: true } } }),
    now: () => Date.now()
  });
  await assert.rejects(
    () => guard.beforeSend({ chatKey: 'group:guard-e2e', kind: 'group', id: '1', action: 'text', text: '代开发票' }),
    /send\.guard 拦截|敏感内容/
  );
  const ok = await guard.beforeSend({ chatKey: 'group:guard-e2e', kind: 'group', id: '1', action: 'text', text: '正常消息' });
  assert.equal(ok.platform, 'qq');
  assert.equal(ok.text, '正常消息');
});

console.log('\n=== trpg-dice-hook ===');
await check('message.command 命中 .r 1d20', async () => {
  const r = await provider('message.command')({ text: '.r 1d20', chatKey: 'group:1', kind: 'group' });
  assert.equal(r.handled, true);
  assert.match(r.replies[0], /1d20/);
  assert.match(r.replies[0], /🎲/);
});

await check('skillManager.runMessageCommands 统一入口可用', async () => {
  const r = await skillManager.runMessageCommands({ text: '.r 2d6+1', chatKey: 'group:1', kind: 'group' });
  assert.equal(r.handled, true);
  assert.equal(r.skillId, 'trpg-dice-hook');
  assert.match(r.replies[0], /2d6\+1/);
});

await check('非命令交给 LLM（handled:false）', async () => {
  const r = await provider('message.command')({ text: '今天吃什么', chatKey: 'group:1' });
  assert.equal(r.handled, false);
});

await check('非法公式被拦截并返回用法', async () => {
  const r = await provider('message.command')({ text: '.r 1d', chatKey: 'group:1' });
  assert.equal(r.handled, true);
  assert.match(r.replies[0], /用法/);
});

await check('确定性骰子结果与加减项', async () => {
  const parsed = dice.parseDiceCommand('.r 3d6+2-1', { config: { maxDice: 100, maxSides: 10000, maxTerms: 20, maxRepeat: 10 } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.expression, '3d6+2-1');
  const seq = [1, 2, 3];
  const text = dice.rollDice(parsed, { rng: () => seq.shift() });
  assert.match(text, /3d6\[1,2,3\] \+ 2 - 1 = 7/);
});

await check('超过 maxDice 被拒绝', async () => {
  const r = await provider('message.command')({ text: '.r 101d6', chatKey: 'group:1' });
  assert.equal(r.handled, true);
  assert.match(r.replies[0], /上限/);
});

await check('重复掷骰 3#1d20', async () => {
  const parsed = dice.parseDiceCommand('.r 3#1d20', { config: { maxDice: 100, maxSides: 10000, maxTerms: 20, maxRepeat: 10 } });
  assert.equal(parsed.repeat, 3);
  assert.match(dice.rollDice(parsed, { rng: () => 7 }), /3#1d20/);
});

console.log('\n=== bili-watcher ===');
updateConfig({
  skills: {
    'bili-watcher': {
      enabled: true,
      watchAt: true, watchComment: true, watchUpVideo: true, watchPrivate: true, watchLive: true,
      subscriptions: '',
      dedupeWindowMs: 7 * 24 * 3600 * 1000,
      maxSeen: 5000
    }
  }
});

await check('订阅计划写入 plan 文件', async () => {
  const plan = provider('bili.watch-plan')();
  assert.ok(fs.existsSync(plan.planFile));
  const disk = JSON.parse(fs.readFileSync(plan.planFile, 'utf8'));
  assert.equal(disk.version, 1);
  assert.ok(disk.types.comment);
});

await check('事件首次通过、第二次按去重拒绝', async () => {
  const filter = provider('bili.watch-filter');
  const now = Date.now();
  const first = await filter({ type: 'comment', videoId: 'BV1test', eventId: 'c-1', now });
  assert.equal(first.allow, true);
  assert.equal(first.duplicate, false);
  const second = await filter({ type: 'comment', videoId: 'BV1test', eventId: 'c-1', now });
  assert.equal(second.allow, false);
  assert.equal(second.duplicate, true);
});

await check('重启（deactivate/activate）后去重状态仍生效', async () => {
  skillManager.deactivate('bili-watcher');
  skillManager.activate('bili-watcher');
  const filter = provider('bili.watch-filter');
  const r = await filter({ type: 'comment', videoId: 'BV1test', eventId: 'c-1', now: Date.now() });
  assert.equal(r.duplicate, true);
});

await check('关闭类型开关后拒绝该类型', async () => {
  updateConfig({ skills: { 'bili-watcher': { watchLive: false } } });
  const r = await provider('bili.watch-filter')({ type: 'live', roomId: '999', eventId: 'live-1' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'type-disabled');
  updateConfig({ skills: { 'bili-watcher': { watchLive: true } } });
});

await check('订阅目标不匹配时拒绝', async () => {
  updateConfig({ skills: { 'bili-watcher': { subscriptions: 'comment:BV2only' } } });
  const r = await provider('bili.watch-filter')({ type: 'comment', videoId: 'BV1test', eventId: 'c-2' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'target-mismatch');
  updateConfig({ skills: { 'bili-watcher': { subscriptions: '' } } });
});

await check('parseSubscriptions 支持注释与中文冒号', async () => {
  const { parseSubscriptions } = await import('../plugins/bili-watcher/index.js');
  const targets = parseSubscriptions('# 注释\nup:123\nlive：456\nbad-line\n');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].type, 'up-video');
  assert.equal(targets[1].type, 'live');
});

console.log('\n=== bili-agent-pack ===');
const fakeBiliCtx = {
  chatKey: 'group:9001',
  kind: 'group',
  chatId: '9001',
  selfId: '888',
  onebot: {
    channel: 'bili',
    async call(action, params) { return { ok: true, action, params, title: '测试视频' }; }
  }
};

updateConfig({
  skills: {
    'anti-ban-guard': { nightSilence: false, sensitivePatterns: '违禁词', sensitiveAction: 'block' },
    'bili-agent-pack': { enabled: true }
  }
});
// 前面的频率熔断测试会留下全局 breaker；重载插件来清空进程内计数（不改配置/状态文件）
skillManager.deactivate('anti-ban-guard');
skillManager.activate('anti-ban-guard');

await check('注册 4 个 B 站工具', async () => {
  const ids = skillManager.registry.get('bili-agent-pack')?.toolIds || [];
  for (const id of ['bili_get_video_context', 'bili_inspect_user', 'bili_reply_comment', 'bili_like']) {
    assert.ok(ids.some((x) => x.endsWith(`__${id}`)), `缺少工具 ${id}`);
  }
});

await check('读取类工具路由到 B 站 custom action', async () => {
  const tool = getTool('bili-agent-pack__bili_get_video_context');
  const r = await tool.execute(fakeBiliCtx, { bvid: 'BV1test', includeSubtitles: true });
  assert.equal(r.isError, undefined);
  assert.match(r.content, /bili_get_video_context/);
  assert.match(r.content, /测试视频/);
});

await check('桥接返回 {ok:false} 时工具报错，不伪装成功', async () => {
  const tool = getTool('bili-agent-pack__bili_get_video_context');
  const r = await tool.execute({
    ...fakeBiliCtx,
    onebot: { channel: 'bili', async call() { return { ok: false, error: '该视频没有可用字幕' }; } }
  }, { bvid: 'BV1test' });
  assert.equal(r.isError, true);
  assert.match(r.content, /没有可用字幕/);
});

await check('非 B 站会话拒绝把 B 站动作发到 QQ', async () => {
  const tool = getTool('bili-agent-pack__bili_get_video_context');
  const r = await tool.execute({
    ...fakeBiliCtx,
    onebot: { channel: 'qq', async call() { throw new Error('不应调用'); } }
  }, { bvid: 'BV1test' });
  assert.equal(r.isError, true);
  assert.match(r.content, /不是 B 站通道/);
});

await check('回复评论未确认时拒绝', async () => {
  const tool = getTool('bili-agent-pack__bili_reply_comment');
  const r = await tool.execute(fakeBiliCtx, { text: '你好', bvid: 'BV1test', confirm: false });
  assert.equal(r.isError, true);
  assert.match(r.content, /confirm=true/);
});

await check('回复评论经过 send.guard：敏感内容被拦截', async () => {
  const tool = getTool('bili-agent-pack__bili_reply_comment');
  const r = await tool.execute(fakeBiliCtx, { text: '违禁词', bvid: 'BV1test', confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.content, /敏感内容/);
});

await check('正常回复评论成功路由', async () => {
  const tool = getTool('bili-agent-pack__bili_reply_comment');
  const r = await tool.execute(fakeBiliCtx, { text: '好视频', bvid: 'BV1test', confirm: true });
  assert.equal(r.isError, undefined, r.content);
  assert.match(r.content, /已提交回复/);
});

await check('点赞需要 confirm 并可成功路由', async () => {
  const tool = getTool('bili-agent-pack__bili_like');
  const denied = await tool.execute(fakeBiliCtx, { bvid: 'BV1test', confirm: false });
  assert.equal(denied.isError, true);
  const ok = await tool.execute(fakeBiliCtx, { bvid: 'BV1test', confirm: true, action: 'like' });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /bili_like/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n扩展加载与行为：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
