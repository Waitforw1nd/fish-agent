// 发送队列：所有对协议端的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
// - 统一 send.guard 出口：号段/白名单/能力校验 + B站低频节流 + Skill 守卫
import fs from 'node:fs';
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { skillManager } from './skills/manager.js';
import { assertSegmentsForPlatform, normalizePlatform } from './channel-router.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;
const DEFAULT_BILI_GUARD = DEFAULT_CONFIG.send.guard.bili;

/**
 * 本地路径 → OneBot 能识别的 file URI。
 *
 * 为什么要转换而不是直接传路径：裸 Windows 路径（反斜杠 + 盘符）在 OneBot
 * 各实现里支持不一致，而 `file:///C:/a/b.png` 是规范里明确的形式。
 * 空格/中文要编码（协议端会 decodeURIComponent），`#` `?` 在 URI 里是分隔符，
 * 必须手动转义 —— encodeURI 不处理它们。
 */
export function toFileUri(input) {
  // ⚠️ 本函数刻意不使用任何正则转义（用 String.fromCharCode(92) 取反斜杠、
  // 用 split/join 代替路径分隔符替换）。原因：这段代码最初是用脚本批量写入的，
  // 多层转义把 `\/` 吃成了 `/`，写出了一个非法的正则字面量，
  // 而 `node --check` 的结果被 shell 的 `&&` 链掩盖成"通过" ——
  // 结果整个 sender.js 加载即崩，比原本要修的 bug 严重得多。
  // 零反斜杠写法让"写错字符"这件事根本不可能发生。
  const BS = String.fromCharCode(92);                    // 反斜杠字符本身
  let s = String(input || '').trim().split(BS).join('/');
  if (!s) return '';
  if (s.slice(0, 7).toLowerCase() === 'file://') return s;   // 已是 URI → 幂等
  const unc = s.startsWith('//');                        // UNC：\\server\share
  // 去掉前导斜杠（逐个 split 掉，避免再用正则转义）
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  // encodeURI 会处理空格/中文，但不转义 `#` `?` —— 它们在 URI 里是分隔符，必须手动转
  const encoded = encodeURI(body).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return unc ? 'file://' + encoded : 'file:///' + encoded;
}

function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeSurface(surface, kind) {
  const s = String(surface || '').trim().toLowerCase();
  if (s === 'live' || s === 'danmaku' || s === '直播间') return 'live';
  if (s === 'dm' || s === 'private' || s === '私信' || kind === 'private') return 'dm';
  return 'comment';
}

/**
 * 统一发送守卫（send.guard）。
 *
 * 所有 SendQueue 出口（文字/图片/表情/媒体/poke/提醒/主动发言）都必须先过
 * `beforeSend`。它做三件事，且**顺序不可换**：
 *   1. 目标号段 → 平台（router.platformFor），未知/未启用号段直接抛错；
 *      这一条永远生效，即使 guard.enabled=false，也不能停掉跨平台防误发。
 *   2. 白名单（app 注入的 isAllowed 回调）—— 与 ingest 同口径，堵住
 *      "工具/提醒/管理接口绕过白名单直接发"的旁路。
 *   3. Skill 提供者（能力名 send.guard）+ B站平台节流/长度。
 *
 * 提供者返回 { allow:false, reason } 或抛错都视为拒绝；返回 { text, delayMs }
 * 可改写文案/追加等待（例如敏感词替换、账号预热延迟）。失败一律 fail-closed。
 */
export class SendGuard {
  constructor({
    onebot,
    isAllowed = null,
    getProviders = null,
    getConfigFn = getConfig,
    log = null,
    now = () => Date.now()
  } = {}) {
    this.onebot = onebot;
    this.isAllowed = typeof isAllowed === 'function' ? isAllowed : null;
    this.getConfigFn = typeof getConfigFn === 'function' ? getConfigFn : getConfig;
    this.getProviders = typeof getProviders === 'function'
      ? getProviders
      : (ctx) => skillManager.getCapabilityProviders('send.guard', ctx);
    this.log = typeof log === 'function' ? log : null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.lastSentAt = new Map();   // chatKey -> ts（B站最小间隔）
    this.biliTimes = new Map();    // chatKey -> [ts]（B站分钟/小时限频）
  }

  /** 目标 ID 的平台。没有 router 的旧测试桩（纯 OneBotClient）默认 qq。 */
  platformFor(kind, id) {
    if (this.onebot && typeof this.onebot.platformFor === 'function') {
      return this.onebot.platformFor(kind, id);
    }
    return 'qq';
  }

  /**
   * 号段 + 白名单校验。返回平台。
   * ⚠️ 白名单拒绝是发送层最后一道闸：任何发送路径（含提醒/主动发言）都不能跳过。
   */
  assertTarget(kind, id) {
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话类型：${kind}`);
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new Error(`非法目标 ID：${id}（必须是小于 2^53 的正整数）`);
    }
    const platform = this.platformFor(kind, id);
    if (this.isAllowed && !this.isAllowed(kind, String(id))) {
      throw new Error(`目标 ${kind === 'group' ? '群' : '私聊'} ${id} 不在白名单内，已拒绝发送`);
    }
    return platform;
  }

  /** 平台能力校验：QQ 全放行；B站只认声明的动作（含 extraActions）。 */
  assertAction(platform, action) {
    if (this.onebot && typeof this.onebot.assertAction === 'function') {
      this.onebot.assertAction(platform, action);
      return;
    }
    if (platform !== 'bili') return;
    const biliOnly = new Set([
      'send_poke', 'friend_poke', 'group_poke',
      'send_group_forward_msg', 'send_private_forward_msg', 'get_forward_msg',
      'get_image', 'get_record', 'fetch_custom_face_detail'
    ]);
    if (biliOnly.has(action)) throw new Error(`B站通道不支持动作 ${action}（已拒绝）`);
  }

  assertSegments(platform, segments) {
    // 有 router 时交给它的完整校验（含 @ 目标与平台一致性）；纯 OneBotClient
    // 桩只做静态段类型/号段检查，保持旧测试可独立运行。
    if (this.onebot && typeof this.onebot.assertSegments === 'function') {
      this.onebot.assertSegments(platform, segments);
      return;
    }
    assertSegmentsForPlatform(platform, segments);
  }

  #guardConfig() {
    return this.getConfigFn()?.send?.guard || {};
  }

  #biliConfig() {
    return { ...DEFAULT_BILI_GUARD, ...(this.#guardConfig().bili || {}) };
  }

  #onebotAction(kind, action) {
    if (action === 'poke') return kind === 'private' ? 'friend_poke' : 'group_poke';
    if (action === 'text' || action === 'image' || action === 'sticker' || action === 'media') {
      return kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    }
    return action;
  }

  /** B站单条文本上限；QQ 返回 0（不限制）。 */
  textLimit(platform) {
    if (platform !== 'bili') return 0;
    const limit = Number(this.#biliConfig().maxTextChars);
    return Number.isFinite(limit) && limit > 0 ? limit : 1000;
  }

  #checkBiliRate(chatKey, surface, limits) {
    const now = this.now();
    const list = (this.biliTimes.get(chatKey) || []).filter((ts) => now - ts < 3600000);
    const minute = list.filter((ts) => now - ts < 60000).length;
    const perMinute = surface === 'dm'
      ? limits.dmMaxPerMinute
      : surface === 'live' ? limits.liveMaxPerMinute : limits.maxPerMinute;
    const perHour = surface === 'dm'
      ? limits.dmMaxPerHour
      : surface === 'live' ? limits.liveMaxPerHour : limits.maxPerHour;
    const surfaceName = surface === 'dm' ? '私信' : surface === 'live' ? '直播' : '评论';
    const minuteCap = Number(perMinute);
    const hourCap = Number(perHour);
    if (minuteCap > 0 && minute >= minuteCap) {
      throw new Error(`B站${surfaceName}发送频率超限（每分钟最多 ${minuteCap} 条），请等一会再发`);
    }
    if (hourCap > 0 && list.length >= hourCap) {
      throw new Error(`B站${surfaceName}发送频率超限（每小时最多 ${hourCap} 条）`);
    }
    list.push(now);
    this.biliTimes.set(chatKey, list);
  }

  /**
   * 统一发送前检查。
   * @returns {Promise<{platform:string,text:string,segments:Array|null,delayMs:number,surface:string}>}
   */
  async beforeSend({
    chatKey,
    kind,
    id,
    action = 'text',
    platform = null,
    text = '',
    segments = null,
    sticker = null,
    targetUserId = null,
    surface = null,
    options = {}
  } = {}) {
    const idPlatform = this.assertTarget(kind, id);
    const requested = platform ? normalizePlatform(platform) : idPlatform;
    if (requested !== idPlatform) {
      throw new Error(
        `显式 platform=${requested} 与目标 ${kind}:${id} 所属平台（${idPlatform}）冲突，已拒绝发送`
      );
    }
    const onebotAction = this.#onebotAction(kind, action);
    this.assertAction(requested, onebotAction);
    if (segments) this.assertSegments(requested, segments);
    const surfaceName = normalizeSurface(surface, kind);
    const guardCfg = this.#guardConfig();
    if (guardCfg.enabled === false) {
      return { platform: requested, text, segments, delayMs: 0, surface: surfaceName };
    }

    let finalText = String(text ?? '');
    let finalSegments = segments;
    let delayMs = 0;
    const opts = options && typeof options === 'object' ? options : {};
    const ctx = {
      chatKey,
      kind,
      id: String(id),
      chatId: String(id),
      platform: requested,
      action,
      onebotAction,
      text: finalText,
      segments: finalSegments,
      sticker,
      targetUserId,
      // anti-ban-guard 用这两个字段判断夜间静默豁免（被 @ / 引用 = 有人找）
      atUserId: opts.atUserId ?? null,
      replyToMessageId: opts.replyToMessageId ?? null,
      urgent: opts.urgent === true,
      proactive: opts.proactive === true,
      surface: surfaceName,
      options: opts
    };
    for (const provider of this.getProviders(ctx) || []) {
      try {
        const verdict = await provider.fn?.(ctx);
        if (verdict === false) throw new Error('send.guard 拒绝发送');
        if (verdict && typeof verdict === 'object') {
          // 兼容两种守卫返回契约：
          //   sender 原生：{ allow:false, reason }
          //   anti-ban-guard：{ ok:false, block:true, code, reason, retryAfterMs }
          // 只认 allow 会让 anti-ban 的夜间静默/敏感内容/熔断变成"静默放行"。
          const blocked = verdict.allow === false || verdict.ok === false || verdict.block === true;
          if (blocked) throw new Error(String(verdict.reason || 'send.guard 拒绝发送'));
          if (verdict.text !== undefined) finalText = String(verdict.text ?? '');
          if (verdict.segments !== undefined) finalSegments = verdict.segments;
          const extra = Number(verdict.delayMs);
          if (Number.isFinite(extra) && extra > 0) delayMs = Math.max(delayMs, extra);
        }
      } catch (error) {
        // 提供者抛错同样拒绝（fail-closed）：守卫坏了不能退化成"没有守卫"。
        throw new Error(`send.guard 拦截（${provider.skillId || 'unknown'}）：${error?.message ?? error}`);
      }
    }
    if (finalSegments) this.assertSegments(requested, finalSegments);

    if (requested === 'bili') {
      const limits = this.#biliConfig();
      const minGap = surfaceName === 'dm'
        ? positiveMs(limits.dmMinGapMs, 6000)
        : surfaceName === 'live' ? positiveMs(limits.liveMinGapMs, 3000)
          : positiveMs(limits.commentMinGapMs, 15000);
      const jitter = surfaceName === 'comment' ? positiveMs(limits.commentJitterMs, 0) : 0;
      const last = this.lastSentAt.get(chatKey) || 0;
      const targetAt = last + minGap + (jitter > 0 ? randInt(0, jitter) : 0);
      delayMs = Math.max(delayMs, Math.max(0, targetAt - this.now()));

      const maxChars = surfaceName === 'live'
        ? Math.max(1, Number(limits.liveMaxTextChars) || 20)
        : this.textLimit(requested);
      const length = finalText ? finalText.length : 0;
      if (length > maxChars) {
        const where = surfaceName === 'live' ? '直播弹幕' : '单条消息';
        throw new Error(
          `B站${where}最多 ${maxChars} 字，当前 ${length} 字：已拒绝发送`
          + '（不会把一条回复拆成多条刷屏）'
        );
      }
      if (surfaceName === 'dm') {
        const maxBytes = Math.max(1, Number(limits.dmMaxTextBytes) || 2000);
        const bytes = Buffer.byteLength(finalText || '', 'utf8');
        if (bytes > maxBytes) {
          throw new Error(`B站私信最多 ${maxBytes} 字节，当前 ${bytes} 字节：已拒绝发送（不做截断/拆分）`);
        }
      }
      this.#checkBiliRate(chatKey, surfaceName, limits);
    }

    return { platform: requested, text: finalText, segments: finalSegments, delayMs, surface: surfaceName };
  }

  /** 发送成功后记录时间（B站最小间隔的基准）。 */
  noteSent(chatKey, at = null) {
    this.lastSentAt.set(String(chatKey), Number(at) || this.now());
  }
}

export class SendQueue {
  constructor({ onebot, store, onSent = null, log = null, isAllowed = null, guard = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    // 回退/降级这类"行为变了但没报错"的事必须留痕，否则排查时看不到曾经降级过
    this.log = typeof log === 'function' ? log : null;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.recentSent = new Map();  // "chatKey::text" -> ts（发送去重窗口）
    // 统一出口：所有 send* / poke 都先过 guard。测试可直接注入 guard。
    this.guard = guard || new SendGuard({ onebot, isAllowed, log });
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour || DEFAULT_MAX_PER_HOUR} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。
   *
   * 背景（重复消息的根因之一）：模型在一次会话里可能重复调用 send_message
   * 传入相同内容（尤其是内联工具调用解析 + 原生 tool_calls 并存时），
   * 或 OneBot 超时看似失败但实际已发出、上层重试再发一遍。
   * 这里在真正发出前做一道内容指纹去重：窗口期内 identical 文本直接跳过。
   */
  #dedupeWindow() {
    const raw = getConfig().send?.dedupeWindowMs;
    // 0 是明确的关闭值，不能用 `|| 8000` 把它误当默认值。
    if (raw === null || raw === undefined || raw === '') return 8000;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 8000;
  }

  /**
   * 只读判断：窗口期内是否已发出过相同内容。
   * ⚠️ 绝不在发送前记账 —— 发送失败（OneBot 报错/限频）的消息必须允许重试，
   * 提前记账会把合法重试误判为重复、导致消息静默丢失。
   */
  #isDuplicate(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return false;
    const last = this.recentSent.get(`${chatKey}::${String(text)}`);
    return Boolean(last && Date.now() - last < win);
  }

  /** 发送成功后记账（去重指纹）。 */
  #markSent(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return;
    const now = Date.now();
    this.recentSent.set(`${chatKey}::${String(text)}`, now);
    // 顺手清理过期条目，避免 Map 无限增长
    if (this.recentSent.size > 500) {
      for (const [k, t] of this.recentSent) {
        if (now - t > win) this.recentSent.delete(k);
      }
    }
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  #dedupedResult(text) {
    return { text, messageId: null, at: formatClockTime(Date.now()), deduped: true };
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId, surface }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   *
   * B站特殊处理（与 QQ 的切分逻辑不同）：
   *   · 评论（group）把一批文本合并成**一条**评论，绝不拆成多条刷屏；
   *   · 私信保持独立气泡，但受 guard 的 DM 低频限制；
   *   · 超过平台上限直接拒绝，不截断、不拆分。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    // 先过号段/白名单/能力：跨平台误发必须在处理内容之前被挡住。
    const platform = this.guard.assertTarget(kind, id);
    this.guard.assertAction(platform, kind === 'private' ? 'send_private_msg' : 'send_group_msg');

    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const plainList = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      plainList.push(plain);
    }
    if (!plainList.length) throw new Error('消息内容为空');

    const parts = [];
    if (platform === 'bili') {
      // 评论：合并成一条；私信：保留独立消息。长度由 SendGuard 在拿到
      // send.guard 提供者的改写结果后再校验（避免"提供者本可缩短，却先被拒"）。
      parts.push(...(kind === 'group' ? [plainList.join('\n')] : plainList));
    } else {
      for (const plain of plainList) {
        if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
        else parts.push(plain);
      }
    }

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        // 去重先判一次：已经发过的内容不再走 guard 的等待/提供者副作用。
        if (this.#isDuplicate(chatKey, text)) {
          console.warn(`[sender] 跳过重复消息（${this.#dedupeWindow()}ms 内已发过相同内容）：${String(text).slice(0, 30)}`);
          return this.#dedupedResult(text);
        }
        const prepared = await this.guard.beforeSend({
          chatKey, kind, id, action: 'text', platform, text, surface: options.surface, options
        });
        const finalText = String(prepared.text ?? text);
        if (!finalText.trim()) throw new Error('send.guard 过滤后消息为空');
        if (finalText !== text && this.#isDuplicate(chatKey, finalText)) {
          console.warn(`[sender] 跳过重复消息（guard 改写后与窗口内已发内容相同）：${finalText.slice(0, 30)}`);
          return this.#dedupedResult(finalText);
        }
        const gap = this.#gap(finalText, isLast) + (prepared.delayMs || 0);
        if (gap > 0) await sleep(gap);
        const data = await this.onebot.sendText(kind, id, finalText, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        this.#markSent(chatKey, finalText);   // 只有 OneBot 成功返回后才记入去重窗口
        this.guard.noteSent(chatKey);
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: finalText, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text: finalText, messageId: data?.message_id ?? null });
        return { text: finalText, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason) });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const platform = this.guard.assertTarget(kind, id);
    this.guard.assertAction(platform, kind === 'private' ? 'send_private_msg' : 'send_group_msg');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      const prepared = await this.guard.beforeSend({
        chatKey, kind, id, action: 'sticker', platform, sticker, surface: options.surface, options
      });
      // 表情本质是 image 段：B站允许，但不允许 QQ 自定义表情动作（上面已校验）。
      this.guard.assertSegments(platform, [{ type: 'image', data: { file: String(sticker?.url || '') } }]);
      const extraWait = (prepared.delayMs || 0) + randInt(600, 1500); // 发表情前真人式的短暂停顿
      await sleep(extraWait);
      // ── 发送回退链（修"表情包经常发送失败"）────────────────────────────
      // 表情库里的 url 有三种形态，稳定性天差地别：
      //   1. file:/// 本地转存（收藏功能写入，永久有效）—— 最优先
      //   2. http(s) QQ 图床直链 —— rkey/时效大约 1 小时，过期后 403/404，
      //      这是"经常失败"的主力（老库存里 60/66 条都是这种）
      //   3. 空地址 —— 直接报错给模型
      // 失败自愈：http 直链失败时，用 OneBot get_image（拿协议端本地缓存）
      // 重发一次；再不行转成 base64 内联发（体积上限 15MB，超限明确报错）。
      const sendVia = (ref) => this.onebot.sendSticker(kind, id, ref, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      let data;
      const primary = String(sticker.url || '').trim();
      if (!primary) throw new Error(`表情 ${sticker.id} 没有可发送的图片地址`);
      const media = platform === 'qq' ? getConfig().channels?.qq?.media : null;
      if (media?.mode === 'inline-base64') {
        const { inlineImage } = await import('./container-media.js');
        data = await sendVia(await inlineImage(primary, media.maxImageBytes));
      } else try {
        data = await sendVia(primary);
      } catch (firstError) {
        if (primary.toLowerCase().startsWith('file:///')) {
          // 本地文件：读出来转 base64 内联再试一次 —— 协议端不同机 / 路径权限 /
          // file:/// 解析差异都可能拒收本地形态，而 base64 是最通用的兜底
          //（sendImage 早有同款回退；这里曾经直接 throw，本地收藏因此"永远发不出去"）。
          const { localStickerPath } = await import('./sticker-manager.js');
          const p = localStickerPath(primary);
          let buf = null;
          try { buf = p ? fs.readFileSync(p) : null; } catch { buf = null; }
          if (!buf?.length) throw firstError;
          try {
            this.log?.(`[sender] 本地表情发送失败（${firstError?.message ?? firstError}），转 base64 重发`);
            data = await sendVia(`base64://${buf.toString('base64')}`);
          } catch (retryError) {
            throw new Error(`本地表情两种形态都发不出去：file=${firstError?.message ?? firstError}；base64=${retryError?.message ?? retryError}`);
          }
        } else {
        // 回退 1：get_image 按文件名/URL 拿协议端本地缓存，绕开过期直链。
        // 这是 QQ 协议端能力：B站通道不能拿 B站文件键去查 QQ 的图片缓存，
        // 否则等于把 B站资源标识送进另一条协议端。B站直接走回退 2。
        if (platform !== 'bili') {
          try {
            const fileKey = sticker.md5 || sticker.resId || sticker.id || '';
            const ret = await this.onebot.call('get_image', { file: fileKey });
            const cached = ret?.file || ret?.filename || '';
            if (cached) {
              this.log?.(`[sender] 表情直链发送失败（${firstError?.message ?? firstError}），改用协议端缓存重试`);
              data = await sendVia(cached);
            }
          } catch { /* 继续走回退 2 */ }
        }
        // 回退 2：下载直链转 base64 内联（此刻直链可能恰好还有效；或已被
        // image-compat 等场景缓存过）。上限 15MB，防超大图拖垮发送。
        if (!data) {
          const { safeFetchBinary } = await import('./safe-fetch.js');
          const { buffer } = await safeFetchBinary(primary, 15 * 1024 * 1024);
          if (!buffer?.length) throw firstError;
          this.log?.(`[sender] 表情直链发送失败，已下载 ${Math.round(buffer.length / 1024)}KB 转 base64 发送`);
          data = await sendVia(`base64://${buffer.toString('base64')}`);
        }
        }
      }
      this.guard.noteSent(chatKey);
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发一张图片（独立气泡）。
   *
   * 和 sendSticker 一样走完整发送管道：限频 → 去重 → guard → 发送 → 留档。
   * 这三步一个都不能省：
   *   · 限频：图比文字更容易刷屏，必须和文字共享同一套配额
   *   · 去重：模型可能对同一个 URL 连发两次（实测过），按 URL 指纹挡掉
   *   · 留档：不留档的话，下一次运行不知道自己发过图，可能重复发
   *
   * @param {object} img { url } 或 { dataUrl } 或 { file }
   * @param {object} options { note, replyToMessageId, atUserId, surface }
   */
  sendImage(chatKey, img, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const platform = this.guard.assertTarget(kind, id);
    this.guard.assertAction(platform, kind === 'private' ? 'send_private_msg' : 'send_group_msg');
    const chain = this.#chain(chatKey);
    const url = String(img?.url ?? '').trim();
    const dataUrl = String(img?.dataUrl ?? '').trim();
    // ── 本地文件路径优先（修过一个真实故障）──────────────────────────────
    // 原来只会传 `url` 或 `dataUrl`。而 `dataUrl` 是 base64 内联进 HTTP body 的：
    // 一张 1.9MB 的图 → base64 后 2.5MB 要 POST 给协议端，协议端再解码、再上传腾讯，
    // 15 秒超时窗口经常走不完 → 表现为「图画出来了但发不出去」。
    //
    // 图本来就已经落盘了（生成/下载后都有本地路径），所以传路径让**协议端自己读磁盘**：
    // body 从 2.5MB 降到约 100 字节，等于把传输量去掉三个数量级。
    // 前端不因此变小：协议端读的是同一个文件系统的同一个文件。
    //
    // ⚠️ 前提是协议端与本进程同机（本项目默认 127.0.0.1）。不同机时协议端读不到该
    // 路径 —— 所以下面保留 dataUrl 作回退，file 失败后自动改用 base64 再试一次。
    const file = String(img?.file ?? '').trim();
    if (!url && !dataUrl && !file) return Promise.reject(new Error('图片地址为空'));

    const ref = file ? toFileUri(file) : (url || dataUrl);
    // 去重键优先用 URL；dataUrl 太长不适合当键，用长度 + 前 64 字符做指纹
    const dedupeKey = url || file || `data:${dataUrl.length}:${dataUrl.slice(0, 64)}`;
    return chain(async () => {
      if (this.#isDuplicate(chatKey, `__img__${dedupeKey}`)) {
        throw new Error('这张图刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      const prepared = await this.guard.beforeSend({
        chatKey, kind, id, action: 'image', platform, text: '', surface: options.surface, options
      });
      this.guard.assertSegments(platform, [{ type: 'image', data: { file: ref } }]);
      await sleep((prepared.delayMs || 0) + randInt(500, 1300));   // 发图前真人式的短暂停顿

      let data;
      const media = platform === 'qq' ? getConfig().channels?.qq?.media : null;
      if (media?.mode === 'inline-base64') {
        const { inlineImage } = await import('./container-media.js');
        const inline = await inlineImage(dataUrl || file || url, media.maxImageBytes);
        data = await this.onebot.sendImage(kind, id, inline, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
      } else try {
        data = await this.onebot.sendImage(kind, id, ref, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
      } catch (error) {
        // file:// 失败 → 回退 base64（协议端不同机、路径不可读、权限不足等）。
        // 只在**有 dataUrl 备份**且**确实是 local 路径**时才回退，避免无意义重试。
        if (!file || !dataUrl) throw error;
        this.log?.(`本地路径发送失败（${error?.message ?? error}），回退 base64 重试一次`);
        data = await this.onebot.sendImage(kind, id, dataUrl, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
      }
      this.#markSent(chatKey, `__img__${dedupeKey}`);   // 发图同样：成功后才记账
      this.guard.noteSent(chatKey);
      const ts = Date.now();
      const note = options.note ? `:${String(options.note).slice(0, 40)}` : '';
      this.store.appendSelf(chatKey, { text: `[图片${note}]`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[图片${note}]`, messageId: data?.message_id ?? null, kind: 'image' });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发送一批媒体段（视频 / 一次多图）—— 走完整发送管道：串行 → 限频 → 去重 → guard → 留档。
   *
   * 为什么需要它：`sendImage` 一次只能发一张（一图一气泡），而"抖音图文帖一次 9 张"
   * 或"转发一段视频"没法用单图 API 表达。media-download 这类插件下载完拿到的是
   * 本地路径数组，必须能一次性成段发出去。
   *
   * ⚠️ 插件**不得**绕过本方法直接调 `onebot.sendSegments` —— 那样会跳过限频与留档，
   * 表现为"媒体把文字配额吃光后突然发不出话"和"下一次运行忘了自己发过，重复发"。
   * 所以 provider 拿到的依赖里应该带 `sender`，用 ctx 传进来的这个对象发送。
   *
   * @param {Array} segments OneBot 段数组，如 [{type:'video',data:{file:'/x.mp4'}}]
   * @param {object} options { label, dedupeKey, replyToMessageId, atUserId, surface }
   */
  sendMedia(chatKey, segments, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const platform = this.guard.assertTarget(kind, id);
    this.guard.assertAction(platform, kind === 'private' ? 'send_private_msg' : 'send_group_msg');
    const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && s.type);
    if (!segs.length) return Promise.reject(new Error('媒体段为空'));
    this.guard.assertSegments(platform, segs);
    const label = String(options.label || '[媒体]');
    // 去重键优先用本地文件路径（同一份文件重复发说明是重试/重复触发）
    const dedupeKey = String(options.dedupeKey
      || segs.map((s) => s?.data?.file).filter(Boolean).join('|')
      || label);
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (this.#isDuplicate(chatKey, `__media__${dedupeKey}`)) {
        throw new Error('这份媒体刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      const prepared = await this.guard.beforeSend({
        chatKey, kind, id, action: 'media', platform, segments: segs, surface: options.surface, options
      });
      let finalSegments = prepared.segments || segs;
      const media = platform === 'qq' ? getConfig().channels?.qq?.media : null;
      if (media?.mode === 'inline-base64') {
        const { inlineImage } = await import('./container-media.js');
        finalSegments = await Promise.all(finalSegments.map(async segment => {
          if (segment.type === 'image') return { ...segment, data: { ...segment.data, file: await inlineImage(segment.data?.file, media.maxImageBytes) } };
          if (['video', 'record', 'file'].includes(segment.type)) throw new Error('容器通道暂不支持此媒体类型');
          return segment;
        }));
      }
      await sleep((prepared.delayMs || 0) + randInt(800, 1800));   // 视频/多图体积大，停顿比文字长一点
      const data = await this.onebot.sendSegments(kind, id, finalSegments);
      this.#markSent(chatKey, `__media__${dedupeKey}`);   // 成功后才记账
      this.guard.noteSent(chatKey);
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null, kind: 'media' });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const platform = this.guard.assertTarget(kind, id);
    this.guard.assertAction(platform, kind === 'private' ? 'friend_poke' : 'group_poke');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 拍一拍同样占发送配额 —— 曾经不调 #checkRate，模型连发 poke
      // 可以绕过 maxPerMinute/maxPerHour 刷屏
      this.#checkRate(chatKey);
      const prepared = await this.guard.beforeSend({
        chatKey, kind, id, action: 'poke', platform, targetUserId
      });
      await sleep((prepared.delayMs || 0) + randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      this.guard.noteSent(chatKey);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
