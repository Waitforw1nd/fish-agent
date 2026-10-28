// 云端订阅由 BiliService 管理；插件生命周期通过租户数据目录向桥报告运行状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SETTINGS = Object.freeze({
  watchAt: true,
  watchComment: true,
  watchUpVideo: true,
  watchPrivate: true,
  watchLive: true,
  subscriptions: '',
  dedupeWindowMs: 7 * 24 * 3600 * 1000,
  maxSeen: 5000
});

const TYPE_ALIAS = {
  at: 'at',
  mention: 'at',
  reply: 'comment',
  comment: 'comment',
  'up-video': 'up-video',
  upvideo: 'up-video',
  video: 'up-video',
  up: 'up-video',
  private: 'private',
  dm: 'private',
  message: 'private',
  live: 'live',
  room: 'live',
  danmaku: 'live'
};

const FLAG_OF = {
  at: 'watchAt',
  comment: 'watchComment',
  'up-video': 'watchUpVideo',
  private: 'watchPrivate',
  live: 'watchLive'
};

let configFn = () => ({ ...DEFAULT_SETTINGS });
let logFn = (...args) => console.log('[bili-watcher]', ...args);
let state = null;

function dataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const profile = String(process.env.QQ_AGENT_PROFILE || '').trim();
  return path.join(MODULE_ROOT, profile ? `data-${profile}` : 'data');
}

function stateFile() {
  const explicit = String(process.env.BILI_WATCH_STATE_FILE || '').trim();
  return explicit ? path.resolve(explicit) : path.join(dataDir(), 'bili-watch', 'state.json');
}

function planFile() {
  const explicit = String(process.env.BILI_WATCH_PLAN_FILE || '').trim();
  return explicit ? path.resolve(explicit) : path.join(dataDir(), 'bili-watch', 'plan.json');
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

function cfg() {
  let raw = {};
  try { raw = configFn() || {}; } catch { raw = {}; }
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    watchAt: bool(merged.watchAt, true),
    watchComment: bool(merged.watchComment, true),
    watchUpVideo: bool(merged.watchUpVideo, true),
    watchPrivate: bool(merged.watchPrivate, true),
    watchLive: bool(merged.watchLive, true),
    subscriptions: String(merged.subscriptions ?? ''),
    dedupeWindowMs: num(merged.dedupeWindowMs, 7 * 24 * 3600 * 1000, 60000, 30 * 24 * 3600 * 1000),
    maxSeen: num(merged.maxSeen, 5000, 100, 50000)
  };
}

function normalizeType(value) {
  return TYPE_ALIAS[String(value || '').trim().toLowerCase()] || '';
}

/** 解析 "type:id" 订阅行；忽略空行与 # 注释。 */
export function parseSubscriptions(text) {
  const targets = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([a-zA-Z-]+)\s*[:：]\s*([^\s#]+)/.exec(trimmed);
    if (!match) continue;
    const type = normalizeType(match[1]);
    const id = match[2].trim();
    if (!type || !id) continue;
    const key = `${type}:${id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ type, id });
  }
  return targets;
}

function planOf(conf) {
  const types = {
    at: conf.watchAt,
    comment: conf.watchComment,
    'up-video': conf.watchUpVideo,
    private: conf.watchPrivate,
    live: conf.watchLive
  };
  return { version: 1, updatedAt: Date.now(), types, targets: parseSubscriptions(conf.subscriptions) };
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    logFn(`写入 ${path.basename(file)} 失败：${error?.message ?? error}`);
    return false;
  }
}

function loadState() {
  if (state) return state;
  state = { version: 1, seen: {}, updatedAt: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.seen && typeof parsed.seen === 'object') {
      const now = Date.now();
      for (const [key, ts] of Object.entries(parsed.seen)) {
        const at = Number(ts);
        if (key && Number.isFinite(at) && at > 0 && now - at < 30 * 24 * 3600 * 1000) state.seen[key] = at;
      }
    }
  } catch { /* 首次运行 */ }
  return state;
}

function persistState() {
  if (!state) return;
  state.updatedAt = Date.now();
  writeJsonAtomic(stateFile(), state);
}

function pruneSeen(conf, now) {
  const seen = loadState().seen;
  const cutoff = now - conf.dedupeWindowMs;
  for (const [key, ts] of Object.entries(seen)) {
    if (!Number.isFinite(ts) || ts < cutoff) delete seen[key];
  }
  const keys = Object.keys(seen);
  if (keys.length > conf.maxSeen) {
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const key of keys.slice(0, keys.length - conf.maxSeen)) delete seen[key];
  }
}

function eventTypeOf(event) {
  return normalizeType(event?.type ?? event?.eventType ?? event?.kind);
}

function targetIdOf(type, event) {
  const values = type === 'live'
    ? [event?.roomId, event?.room_id, event?.upId, event?.mid]
    : type === 'private'
      ? [event?.userId, event?.user_id, event?.senderId, event?.sender_id]
      : type === 'up-video'
        ? [event?.bvid, event?.videoId, event?.video_id, event?.upId, event?.mid]
        : [event?.bvid, event?.videoId, event?.video_id, event?.upId, event?.mid, event?.commentId, event?.comment_id];
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return '';
}

function targetMatches(type, id, targets) {
  const sameType = targets.filter((t) => t.type === type);
  if (!sameType.length) return true;   // 某类型没配目标 = 该类型全收（开关仍生效）
  if (!id) return false;
  return sameType.some((t) => t.id === '*' || t.id === id);
}

/** 事件去重键：优先平台事件 id，其次稳定字段；没有身份字段时用内容哈希。 */
function eventKey(type, event, targetId) {
  const raw = event?.eventId ?? event?.event_id ?? event?.msgId ?? event?.msg_id
    ?? event?.commentId ?? event?.comment_id ?? event?.seq ?? event?.seqno ?? event?.id;
  if (raw !== undefined && raw !== null && String(raw).trim()) return `${type}:${String(raw).trim()}`;
  const fallback = [
    type, targetId,
    event?.bvid ?? event?.videoId ?? '',
    event?.userId ?? event?.user_id ?? event?.senderId ?? '',
    event?.text ?? event?.content ?? '',
    event?.time ?? event?.ts ?? ''
  ].join('|');
  return `${type}:h:${crypto.createHash('sha1').update(fallback).digest('hex').slice(0, 20)}`;
}

/**
 * 过滤一个 B 站事件（不修改状态）。
 * @returns {{allow:boolean, duplicate:boolean, key:string, type:string, targetId:string, reason?:string, code?:string}}
 */
export function checkEvent(event) {
  const conf = cfg();
  const now = Number(event?.now) > 0 ? Number(event.now) : Date.now();
  const type = eventTypeOf(event);
  if (!type) return { allow: false, duplicate: false, key: '', type: '', targetId: '', code: 'unknown-type', reason: '未知的 B 站事件类型' };
  if (!conf[FLAG_OF[type]]) {
    return { allow: false, duplicate: false, key: '', type, targetId: '', code: 'type-disabled', reason: `订阅开关未开启：${FLAG_OF[type]}` };
  }
  const targetId = targetIdOf(type, event);
  const plan = planOf(conf);
  if (!targetMatches(type, targetId, plan.targets)) {
    return { allow: false, duplicate: false, key: '', type, targetId, code: 'target-mismatch', reason: '事件目标不在订阅列表内' };
  }
  const key = eventKey(type, event, targetId);
  const seenAt = loadState().seen[key];
  if (seenAt && now - seenAt < conf.dedupeWindowMs) {
    return { allow: false, duplicate: true, key, type, targetId, code: 'duplicate', reason: '事件已处理过' };
  }
  return { allow: true, duplicate: false, key, type, targetId };
}

/**
 * 接受事件：过滤通过后写入去重状态（原子落盘）。
 * 重复/未订阅返回 allow:false，调用方应直接丢弃。
 */
export function acceptEvent(event) {
  const result = checkEvent(event);
  if (!result.allow) return result;
  const conf = cfg();
  const now = Number(event?.now) > 0 ? Number(event.now) : Date.now();
  const st = loadState();
  st.seen[result.key] = now;
  pruneSeen(conf, now);
  persistState();
  return result;
}

/** 显式确认一条事件已入库（桥接若先 filter 后 ingest，可在 ingest 成功后调用）。 */
export function commitEvent(eventOrKey) {
  const conf = cfg();
  const now = Date.now();
  const st = loadState();
  const key = typeof eventOrKey === 'string'
    ? eventOrKey
    : (() => {
      const type = eventTypeOf(eventOrKey);
      const targetId = targetIdOf(type, eventOrKey);
      return eventKey(type, eventOrKey, targetId);
    })();
  if (!key) return { ok: false, error: '缺少事件 key' };
  st.seen[key] = now;
  pruneSeen(conf, now);
  persistState();
  return { ok: true, key };
}

function planSnapshot() {
  const conf = cfg();
  return { ...planOf(conf), stateFile: stateFile(), planFile: planFile(), seenCount: Object.keys(loadState().seen).length };
}

export const providers = {
  'bili.watch-filter': (event = {}) => acceptEvent(event),
  'bili.watch-plan': () => {
    const plan = planSnapshot();
    writeJsonAtomic(planFile(), plan);
    return plan;
  }
};

export function setup(api) {
  if (typeof api?.config === 'function') configFn = api.config;
  if (typeof api?.log === 'function') logFn = api.log;
}

function reportLifecycle(active) {
  if (process.env.QQ_AGENT_CLOUD !== '1') return;
  writeJsonAtomic(path.join(dataDir(), 'bili-watch', 'lifecycle.json'), { active, pid: process.pid, updatedAt: Date.now() });
}

export function activate() {
  reportLifecycle(true);
  loadState();
  logFn('B 站 watcher 已启用；订阅目标由云端配置管理');
}

export function deactivate() {
  reportLifecycle(false);
  persistState();
  state = null;   // 下次 activate 从磁盘重载
}

// ── 测试辅助 ──
export function resetWatchStateForTest() {
  state = null;
}
