// 发送风控（确定性型插件）
//
// 通过 `send.guard` 能力成为所有出站消息的统一守卫；sender 只要在真正发送前
// 问一次 capability，就能同时获得：敏感内容、夜间静默、账号预热、频率熔断。
// 另提供 before-tool 兜底：即使 sender 还没接 send.guard，LLM 的发送类工具
// 也会先被敏感内容/夜间静默拦一次（频率统计仍只在实际发送点累加，避免双计数）。
//
// 守卫返回约定（兼容 boolean / object 两种消费方式）：
//   放行 → true
//   拦截 → { ok:false, block:true, code, reason, retryAfterMs? }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_SETTINGS = Object.freeze({
  nightSilence: true,
  nightStart: '23:30',
  nightEnd: '07:30',
  allowAtNight: true,
  warmupDays: 3,
  warmupMaxPerMinute: 3,
  warmupMaxPerHour: 20,
  maxPerMinute: 10,
  maxPerHour: 120,
  breakerCooldownMs: 180000,
  sensitiveAction: 'block',
  sensitivePatterns: '代开发票|办理证件|办证|博彩|赌博|洗钱|跑分|刷单|返利|裸聊|约炮|毒品|冰毒|海洛因|枪支|弹药|出售外挂|买卖账号'
});

let configFn = () => ({ ...DEFAULT_SETTINGS });
let logFn = (...args) => console.log('[anti-ban-guard]', ...args);
let runtime = null;
let patternCache = { source: null, regexes: [] };

function dataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const profile = String(process.env.QQ_AGENT_PROFILE || '').trim();
  return path.join(MODULE_ROOT, profile ? `data-${profile}` : 'data');
}

function stateFile() {
  const explicit = String(process.env.ANTI_BAN_GUARD_STATE_FILE || '').trim();
  return explicit ? path.resolve(explicit) : path.join(dataDir(), 'anti-ban-guard-state.json');
}

function readFirstSeen() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const ts = Number(parsed?.firstSeen);
    if (Number.isFinite(ts) && ts > 0 && ts <= Date.now() + DAY_MS) return ts;
  } catch { /* 首次运行 */ }
  return 0;
}

function persistFirstSeen(ts) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ firstSeen: ts, updatedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 持久化失败不影响进程内限频 */ }
}

function ensureRuntime() {
  if (runtime) return runtime;
  const firstSeen = readFirstSeen() || Date.now();
  runtime = { firstSeen, buckets: new Map(), breakerUntil: 0 };
  if (!readFirstSeen()) persistFirstSeen(firstSeen);
  return runtime;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function cfg() {
  let raw = {};
  try { raw = configFn() || {}; } catch { raw = {}; }
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    nightSilence: bool(merged.nightSilence, true),
    nightStart: String(merged.nightStart || '23:30'),
    nightEnd: String(merged.nightEnd || '07:30'),
    allowAtNight: bool(merged.allowAtNight, true),
    warmupDays: num(merged.warmupDays, 3, 0, 30),
    warmupMaxPerMinute: num(merged.warmupMaxPerMinute, 3, 1, 60),
    warmupMaxPerHour: num(merged.warmupMaxPerHour, 20, 1, 600),
    maxPerMinute: num(merged.maxPerMinute, 10, 1, 120),
    maxPerHour: num(merged.maxPerHour, 120, 1, 1200),
    breakerCooldownMs: num(merged.breakerCooldownMs, 180000, 1000, 3600000),
    sensitiveAction: merged.sensitiveAction === 'warn' ? 'warn' : 'block',
    sensitivePatterns: String(merged.sensitivePatterns ?? DEFAULT_SETTINGS.sensitivePatterns)
  };
}

function patternsOf(source) {
  if (patternCache.source === source) return patternCache.regexes;
  const regexes = [];
  for (const line of String(source || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try { regexes.push(new RegExp(text, 'i')); } catch { /* 用户写错的正则跳过，不拖垮发送 */ }
  }
  patternCache = { source, regexes };
  return regexes;
}

function minutesOfDay(now) {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

function parseClock(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function inNightWindow(now, start, end) {
  const s = parseClock(start, 23 * 60 + 30);
  const e = parseClock(end, 7 * 60 + 30);
  if (s === e) return false;
  const cur = minutesOfDay(now);
  return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
}

function msUntilClock(now, clock, fallbackMinutes) {
  const target = parseClock(clock, fallbackMinutes);
  const cur = minutesOfDay(now);
  const diff = target > cur ? target - cur : (24 * 60 - cur) + target;
  return Math.max(1000, diff * 60 * 1000);
}

function normalizeInput(input, extra = {}, extra2 = null) {
  let source = input;
  if (typeof source === 'string') {
    // 兼容三种调用姿势：
    //   guard({ chatKey, text })
    //   guard(chatKey, { text })
    //   guard(chatKey, text, options)
    if (typeof extra === 'string') {
      source = { chatKey: input, text: extra, ...(extra2 && typeof extra2 === 'object' ? extra2 : {}) };
    } else {
      source = { chatKey: input, ...(extra && typeof extra === 'object' ? extra : {}) };
    }
  } else if (source && typeof source === 'object' && typeof extra === 'string') {
    source = { ...source, text: extra, ...(extra2 && typeof extra2 === 'object' ? extra2 : {}) };
  }
  if (!source || typeof source !== 'object') source = {};
  const kind = String(source.kind || source.type || source.action || source.variant || 'text');
  const id = source.chatId ?? source.id ?? '';
  const chatKey = String(source.chatKey || (kind && id ? `${kind}:${id}` : 'global'));
  let text = source.text ?? source.content ?? source.message ?? source.label ?? '';
  if (Array.isArray(text)) text = text.join('\n');
  if (Array.isArray(source.messages)) text = source.messages.join('\n');
  const options = source.options && typeof source.options === 'object' ? source.options : source;
  return {
    chatKey,
    kind,
    text: String(text ?? '').slice(0, 8000),
    atUserId: options.atUserId ?? source.atUserId ?? null,
    replyToMessageId: options.replyToMessageId ?? source.replyToMessageId ?? null,
    urgent: source.urgent === true,
    proactive: source.proactive === true,
    now: Number(source.now) > 0 ? Number(source.now) : Date.now()
  };
}

function deny(code, reason, retryAfterMs = null) {
  const out = { ok: false, block: true, code, reason };
  if (retryAfterMs != null) out.retryAfterMs = Math.max(0, Math.round(retryAfterMs));
  return out;
}

/** 静态策略（敏感内容 + 夜间静默），不碰频率计数。 */
function staticDecision(input, conf, now, firstSeen) {
  const patterns = patternsOf(conf.sensitivePatterns);
  if (patterns.length && input.text) {
    if (patterns.some((re) => re.test(input.text))) {
      if (conf.sensitiveAction === 'warn') {
        logFn('[anti-ban-guard] 内容命中敏感策略（warn 模式，已放行）');
      } else {
        return deny('sensitive-content', '内容命中敏感内容策略，已拦截');
      }
    }
  }
  if (conf.nightSilence && inNightWindow(now, conf.nightStart, conf.nightEnd)) {
    const exempt = conf.allowAtNight && (input.atUserId || input.replyToMessageId || input.urgent);
    if (!exempt) {
      return deny('night-silence', `夜间静默中（${conf.nightStart}–${conf.nightEnd}），暂不发言`, msUntilClock(now, conf.nightEnd, 7 * 60 + 30));
    }
  }
  // warmup 仅用于频率上限，静态策略不读取，保留 firstSeen 参数供未来扩展
  void firstSeen;
  return null;
}

function bucketOf(chatKey) {
  const rt = ensureRuntime();
  if (rt.buckets.size > 5000) rt.buckets.clear();   // 防御异常大量会话导致内存增长
  let bucket = rt.buckets.get(chatKey);
  if (!bucket) {
    bucket = { minute: [], hour: [] };
    rt.buckets.set(chatKey, bucket);
  }
  return bucket;
}

/**
 * 统计并判定一次发送尝试。返回值同 provider：true = 放行，对象 = 拦截。
 * 被拦截的尝试不写入频率桶；熔断触发时写入 breakerUntil。
 */
export function evaluateSendAttempt(input, extra = {}, extra2 = null) {
  const options = extra && typeof extra === 'object' ? extra : (extra2 && typeof extra2 === 'object' ? extra2 : {});
  const conf = { ...cfg(), ...(options.config || {}) };
  const ev = normalizeInput(input, extra, extra2);
  const now = ev.now;
  const rt = ensureRuntime();
  const firstSeen = options.firstSeen ?? rt.firstSeen;

  // 预热期：首次启动后的 warmupDays 天内使用更严格的上限
  const warmupActive = conf.warmupDays > 0 && now - firstSeen < conf.warmupDays * DAY_MS;
  const maxMinute = warmupActive ? Math.min(conf.maxPerMinute, conf.warmupMaxPerMinute) : conf.maxPerMinute;
  const maxHour = warmupActive ? Math.min(conf.maxPerHour, conf.warmupMaxPerHour) : conf.maxPerHour;

  if (rt.breakerUntil > now) {
    return deny('circuit-open', '发送过于频繁，风控熔断中，请稍后再试', rt.breakerUntil - now);
  }

  const staticDeny = staticDecision(ev, conf, now, firstSeen);
  if (staticDeny) return staticDeny;

  const bucket = bucketOf(ev.chatKey);
  bucket.minute = bucket.minute.filter((t) => now - t < 60_000);
  bucket.hour = bucket.hour.filter((t) => now - t < 3_600_000);
  if (bucket.minute.length >= maxMinute) {
    rt.breakerUntil = now + conf.breakerCooldownMs;
    return deny('rate-limit', `发送频率超限（每分钟最多 ${maxMinute} 条），已触发风控熔断`, conf.breakerCooldownMs);
  }
  if (bucket.hour.length >= maxHour) {
    rt.breakerUntil = now + conf.breakerCooldownMs;
    return deny('rate-limit', `发送频率超限（每小时最多 ${maxHour} 条），已触发风控熔断`, conf.breakerCooldownMs);
  }
  bucket.minute.push(now);
  bucket.hour.push(now);
  return true;
}

/** send.guard 能力提供者。 */
export function guard(input, extra, extra2) {
  return evaluateSendAttempt(input, extra, extra2);
}

/** 只做静态检查（tool hook 用：不占用频率额度）。 */
export function staticGuard(input) {
  const ev = normalizeInput(input);
  return staticDecision(ev, cfg(), ev.now, ensureRuntime().firstSeen) || true;
}

const OUTBOUND_TOOL = /(^|__)(send_message|send_to|send_image|send_sticker|send_media|send_poke|bili_reply_comment)$/;

function textFromToolArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const value = args.messages ?? args.text ?? args.content ?? args.message ?? args.comment ?? '';
  if (Array.isArray(value)) return value.join('\n');
  return String(value ?? '');
}

export const providers = {
  'send.guard': (...args) => guard(...args)
};

export const hooks = {
  'before-tool': ({ toolName, argsRaw } = {}) => {
    if (!OUTBOUND_TOOL.test(String(toolName || ''))) return undefined;
    let args = {};
    try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {}); } catch { args = {}; }
    const decision = staticGuard({
      chatKey: '',
      kind: 'tool',
      text: textFromToolArgs(args),
      atUserId: args.atUserId ?? null,
      replyToMessageId: args.replyToMessageId ?? null,
      urgent: false
    });
    if (decision !== true) return { block: true, reason: decision.reason };
    return undefined;
  }
};

export function setup(api) {
  if (typeof api?.config === 'function') configFn = api.config;
  if (typeof api?.log === 'function') logFn = api.log;
}

export function activate() {
  ensureRuntime();
}

export function deactivate() {
  runtime = null;   // 下次 activate/provider 调用时重新从磁盘读 firstSeen
}

// ── 测试辅助（生产代码不依赖） ──
export function resetGuardStateForTest() {
  runtime = null;
  patternCache = { source: null, regexes: [] };
}

export function guardStateForTest() {
  const rt = ensureRuntime();
  return { firstSeen: rt.firstSeen, breakerUntil: rt.breakerUntil, buckets: rt.buckets, stateFile: stateFile() };
}
