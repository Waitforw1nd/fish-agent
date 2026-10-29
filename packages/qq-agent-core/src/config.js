// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, BILI_VIRTUAL_ID_START, BILI_VIRTUAL_ID_END } from './config-defaults.js';
import { normalizeStoredAgentConfig, mergeAgentConfigPatch } from './config-codec.js';
export { DEFAULT_CONFIG, BILI_VIRTUAL_ID_START, BILI_VIRTUAL_ID_END } from './config-defaults.js';
export { deepMerge, migrateLegacySkills, stripObsoleteFields } from './config-codec.js';
import { sliderToTier } from './tier-slider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
// ── 多实例 PROFILE ─────────────────────────────────────────────────────
// QQ_AGENT_PROFILE=2 时数据目录变成 data-2/、端口整体 +100，
// 这样同一台机器可以跑两个机器人实例（两个 QQ 号）而不互相踩。
// 优先级：QQ_AGENT_DATA_DIR（显式覆盖）> PROFILE 推导 > 默认 data/
//
// ⚠️ 必须在这里就生效（而不是在 UI 或 app.js 里改）：
//   DATA_DIR 是整个进程的根路径，配置、会话、记忆、表情库全挂在它下面。
//   晚一步设置就会有一部分文件写到主实例的目录里，造成两个实例数据互相污染。
import { profileSuffix } from './profile.js';

// ── 双通道号段（QQ / B站）────────────────────────────────────────────────
// B 站桥接没有真实 QQ 号，必须把视频、动态、直播间、私信用户映射成数字 ID。
// 这些虚拟 ID 一旦落进 QQ 号段，出站就可能被发到同号的 QQ 群/好友 —— 这是
// 最危险的跨平台误发。这里把 B 站固定到 [2^52, 2^53-1]：QQ 号/群号远达不到
// 这个量级，而 2^53-1 仍是 Number 精确整数，OneBot 的 Number(id) 不会失真。
// 号段可在 channels.qq.idRange / channels.bili.idRange 覆盖，但两段不得重叠。

// 2026-09-19 起 https：http 版 301 跳转且明文传输可被 MITM 篡改成本展示。
// 证书与内容已实测可达（同一路径，nginx 直接 200）。
export const FIXED_PRICE_REMOTE_URL = 'https://kondius.cn/qq-agent/model-prices.json';
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, `data${profileSuffix()}`);
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ── 双通道配置解析 ───────────────────────────────────────────────────────
// 旧部署只有 snowluma.{wsUrl,httpUrl,accessToken}；新部署写 channels.qq/bili。
// 解析规则：channels.qq 的非空值优先，空值回落到 snowluma，最后才是出厂默认。
// 这样升级不需要迁移配置，也不会让"还写着 snowluma 的租户"突然连不上。
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function safeRangeInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} 必须是 1..${BILI_VIRTUAL_ID_END} 的安全整数，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/** 规范化号段：支持 {start,end} 或 [start,end]；非法/越界直接抛，绝不静默回退。 */
export function normalizeChannelIdRange(raw, fallback, label = 'idRange') {
  let start = raw?.start;
  let end = raw?.end;
  if (Array.isArray(raw)) { [start, end] = raw; }
  const s = safeRangeInt(start, fallback?.start, `${label}.start`);
  const e = safeRangeInt(end, fallback?.end, `${label}.end`);
  if (s > e) throw new Error(`${label} 起始值 ${s} 大于结束值 ${e}`);
  return { start: s, end: e };
}

/**
 * 解析当前生效的双通道配置。返回 { qq, bili }，两项都含 enabled/url/token/idRange。
 *
 * ⚠️ 号段重叠在这里就抛错：重叠意味着同一 ID 可能属于两个平台，路由层无论
 * 怎么选都可能误发。宁可启动失败，也不能带着这个歧义运行。
 */
function normalizeQqMedia(raw) {
  const media = raw.media;
  if (!media && raw.driver !== 'napcat') return null;
  if (!media || media.mode !== 'inline-base64' || media.incomingLocalPaths !== 'deny'
      || !Number.isSafeInteger(media.maxImageBytes) || media.maxImageBytes < 1 || media.maxImageBytes > 5242880) {
    throw new Error('channels.qq.media 配置不合法');
  }
  return { mode: media.mode, maxImageBytes: media.maxImageBytes, incomingLocalPaths: 'deny' };
}

export function resolveChannels(config = getConfig()) {
  const rawChannels = config?.channels && typeof config.channels === 'object' ? config.channels : {};
  const qqRaw = rawChannels.qq && typeof rawChannels.qq === 'object' ? rawChannels.qq : {};
  const biliRaw = rawChannels.bili && typeof rawChannels.bili === 'object' ? rawChannels.bili : {};
  const legacy = config?.snowluma && typeof config.snowluma === 'object' ? config.snowluma : {};
  const qqDefaults = DEFAULT_CONFIG.channels.qq;
  const biliDefaults = DEFAULT_CONFIG.channels.bili;

  const qq = {
    enabled: qqRaw.enabled !== false,
    wsUrl: firstNonEmpty(qqRaw.wsUrl, legacy.wsUrl, DEFAULT_CONFIG.snowluma.wsUrl),
    httpUrl: (qqRaw.apiTransport === 'ws' ? String(qqRaw.httpUrl || '') : firstNonEmpty(qqRaw.httpUrl, legacy.httpUrl, DEFAULT_CONFIG.snowluma.httpUrl)).replace(/\/+$/, ''),
    apiTransport: firstNonEmpty(qqRaw.apiTransport, 'http'),
    accessToken: firstNonEmpty(qqRaw.accessToken, legacy.accessToken),
    // httpAccessToken 留空时 OneBotClient 会沿用 accessToken（与旧实现一致）
    httpAccessToken: firstNonEmpty(qqRaw.httpAccessToken, legacy.httpAccessToken, legacy.accessToken),
    selfUserId: firstNonEmpty(qqRaw.selfUserId),
    selfNickname: firstNonEmpty(qqRaw.selfNickname),
    driver: String(qqRaw.driver || ''),
    generation: qqRaw.generation ?? null,
    media: normalizeQqMedia(qqRaw),
    idRange: normalizeChannelIdRange(qqRaw.idRange, qqDefaults.idRange, 'channels.qq.idRange')
  };

  const extraActions = Array.isArray(biliRaw.extraActions)
    ? biliRaw.extraActions.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  const bili = {
    enabled: biliRaw.enabled === true,
    wsUrl: firstNonEmpty(biliRaw.wsUrl, biliDefaults.wsUrl),
    httpUrl: firstNonEmpty(biliRaw.httpUrl, biliDefaults.httpUrl).replace(/\/+$/, ''),
    accessToken: firstNonEmpty(biliRaw.accessToken),
    httpAccessToken: firstNonEmpty(biliRaw.httpAccessToken, biliRaw.accessToken),
    selfUserId: firstNonEmpty(biliRaw.selfUserId),
    selfNickname: firstNonEmpty(biliRaw.selfNickname),
    extraActions,
    idRange: normalizeChannelIdRange(biliRaw.idRange, biliDefaults.idRange, 'channels.bili.idRange')
  };

  const overlap = !(qq.idRange.end < bili.idRange.start || bili.idRange.end < qq.idRange.start);
  if (overlap) {
    throw new Error(
      `channels.qq.idRange [${qq.idRange.start}, ${qq.idRange.end}] 与 `
      + `channels.bili.idRange [${bili.idRange.start}, ${bili.idRange.end}] 重叠：`
      + '同一 ID 可能属于两个平台，已拒绝启动（请修改配置，确保两段互不相交）'
    );
  }
  return { qq, bili };
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return normalizeStoredAgentConfig(parsed);
  } catch (error) {
    // ⚠️ 配置文件坏了（手改错/磁盘故障）不能静默回落默认值：
    //   曾经直接返回 DEFAULT，随后任何 updateConfig（比如 5 分钟一次的
    //   云端屏蔽名单同步）都会以默认配置为底整体写回 config.json ——
    //   用户的 Key/白名单/人设被静默抹成出厂值。
    //   现在先把坏文件改名备份（原始数据可手工抢救），再回落默认，
    //   并打 error 日志提醒用户。
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${stamp}`);
        console.error(`[config] 配置文件解析失败（${String(error?.message ?? error)}），` +
          `已备份为 config.json.corrupt-${stamp}，本次以默认配置启动。` +
          `请尽快从备份抢救配置，否则下次保存会覆盖全量配置！`);
      }
    } catch (backupError) {
      console.error('[config] 配置文件解析失败且备份失败：', backupError);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = mergeAgentConfigPatch(getConfig(), patch);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的人设：全局 persona 被 personaByChat[id] 的同名字段覆盖。
 *
 * 只允许覆盖 roleText / participation / customRules / systemPromptOverride 四个
 * "说话风格"字段；botName / selfNickname 是账号身份，任何会话都不得单独改 ——
 * 换了会与 @ 判定（isAtMe 用昵称/名字匹配）、存档里"我"的称呼全部对不上。
 * 覆盖值一律做字符串 trim（空串视为"未设置"，回落全局值）。
 *
 * ⚠️ personaUnified = true（"为所有的群聊/私聊使用同一个人设"）时，
 *    personaByChat 的条目**不再生效**（统一人设是用户明确表态，遗留的
 *    分会话条目继续覆盖会让"所有会话共用这一套人设"的 UI 承诺落空，
 *    且统一模式下 UI 隐藏了分会话编辑入口，用户无从发现也无处改）。
 *    开关关掉后条目恢复生效 —— 数据不删，只是不再参与合并。
 */
export function personaForChat(chatKey) {
  const base = getConfig().persona || {};
  const [kind, id] = String(chatKey || '').split(':');
  if (!id) return base;
  // 统一人设模式：一律用全局，不看 personaByChat
  if (getConfig().personaUnified !== false) return base;
  const perChat = getConfig().personaByChat || {};
  // 兼容两种键格式：UI 的隐藏 JSON 以 chatKey（group:123）为键保存，
  // 而这里按 id 段（123）查 —— 只认一种格式时保存成功但永不生效
  // （2026-09-17 用户实测踩中：独立人设存了却一直跟随全局）。
  const raw = perChat[String(id)] ?? perChat[String(chatKey)];
  if (!raw || typeof raw !== 'object') return base;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out = { ...base };
  if (kind === 'group' || kind === 'private') {
    const roleText = pick(raw.roleText);
    const customRules = pick(raw.customRules);
    const systemPromptOverride = pick(raw.systemPromptOverride);
    if (roleText !== undefined) out.roleText = roleText;
    if (customRules !== undefined) out.customRules = customRules;
    if (systemPromptOverride !== undefined) out.systemPromptOverride = systemPromptOverride;
    if (['low', 'medium', 'high'].includes(raw.participation)) out.participation = raw.participation;
  }
  return out;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 *
 * 峰谷切换：peakSchedule.enabled 时，先按当前时间判定落在高峰/低谷时段，
 * 用该时段的 sliderPos 换算出档位**覆盖**全局滑条（在 unifiedTier / 分群设置之前生效）。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  // ── 指令禁言：该群被禁言且未到期 → 强制 1 档（仅艾特）──
  const mutedTier = commandMuteTier(chatKey);
  if (mutedTier !== null) {
    return { ...store, contextTier: 1, randomPercent: 0 };
  }
  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;
  const inPeakNow = peakOn && peakWindowActive(store.peakSchedule);

  // ── 四象限（2026-09-18 改版）──
  //   统一 + 峰谷关：全局滑条（contextSliderPos）
  //   统一 + 峰谷开：全局峰谷双点按时段取高峰/低谷
  //   分群 + 峰谷关：群无单独设置 → 全局滑条；有 → groupSliderPos[群]
  //   分群 + 峰谷开：群无单独峰谷 → 全局双点按时段取；有 → groupPeakPos[群] 按时段取
  // 私聊永远跟随"全局"口径（峰谷开时同样受时段影响）。
  let pos = clampSliderPos(store.contextSliderPos);
  if (peakOn) {
    if (isGroup && store.unifiedTier === false) {
      const gp = store.groupPeakPos?.[id];
      pos = gp
        ? clampSliderPos(inPeakNow ? gp.peak : gp.valley)
        : (inPeakNow ? clampSliderPos(store.peakSchedule.peak?.sliderPos) : clampSliderPos(store.peakSchedule.valley?.sliderPos));
    } else {
      pos = inPeakNow
        ? clampSliderPos(store.peakSchedule.peak?.sliderPos)
        : clampSliderPos(store.peakSchedule.valley?.sliderPos);
    }
  } else if (isGroup && store.unifiedTier === false) {
    const gp = store.groupSliderPos?.[id];
    if (gp !== undefined && gp !== null) pos = clampSliderPos(gp);
  }
  const { tier, randomPercent } = sliderToTier(pos);
  return { ...store, contextSliderPos: pos, contextTier: tier, randomPercent };
}

/**
 * 当前时间是否落在高峰时段内（峰谷判定的第一步，供 storeConfigForChat 复用）。
 */
function peakWindowActive(ps, at = new Date()) {
  const minutes = at.getHours() * 60 + at.getMinutes();
  const s = parseHHMM(ps?.peak?.start);
  const e = parseHHMM(ps?.peak?.end);
  if (s === null || e === null || s === e) return false;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
}

/**
 * 指令禁言：该群是否处于禁言期（响应档位被强制为 1 档）。
 * @returns {number|null} 强制档位（1）；未禁言/已到期返回 null
 */
export function commandMuteTier(chatKey, at = Date.now()) {
  const cm = getConfig().commandMute;
  if (!cm || cm.enabled !== true) return null;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return null;
  const until = Number(cm.active?.[id]);
  if (!Number.isFinite(until)) return null;
  if (until === 0) return 1;              // 0 = 直到手动解除
  if (at < until) return 1;               // 未到解除时间
  return null;                            // 已到期
}

/**
 * 峰谷切换的核心判定：当前时间落在哪个时段。
 * 2026-09-18 四象限改版后的语义：高峰窗口内 = peak.sliderPos，
 * 窗口外一律 = valley.sliderPos（低谷时段不再单独编辑）。
 * 注意：storeConfigForChat 内联了同一判定（分群峰谷 groupPeakPos 也在那里处理）；
 * 修改时段判定口径时两处必须同步改。
 */
export function resolvePeakSliderPos(store, at = new Date()) {
  const ps = store?.peakSchedule;
  if (!ps || ps.enabled !== true) return null;
  if (peakWindowActive(ps, at)) return clampSliderPos(ps.peak?.sliderPos);
  return clampSliderPos(ps.valley?.sliderPos);
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clampSliderPos(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}
