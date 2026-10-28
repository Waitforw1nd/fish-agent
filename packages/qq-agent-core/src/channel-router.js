// 双通道（QQ / B站）OneBot 聚合路由。
//
// 设计目标（与养鱼平台的双通道需求对应）：
//   1. 一个 Agent 进程同时持有 QQ 与 B站两个 OneBotClient，事件、状态、self
//      身份统一进入同一个 ingest；sender / stickers / orchestrator 仍只面对
//      一个「看起来像 OneBotClient」的对象。
//   2. 出站按**目标 ID 号段**选通道，而不是按调用顺序或默认通道：
//      QQ 与 B站各占一段互不相交的安全整数（见 config.js 的 BILI_VIRTUAL_ID_START）。
//      落在段外的 ID、落在未启用通道号段的 ID、显式 platform 与号段冲突，全部
//      直接抛错 —— 宁可发不出去，也不能把 B站评论发到同号的 QQ 群。
//   3. 消息 ID（message_id）没有平台隔离，两个桥接完全可能给出相同数字。
//      这里记录「见过的消息 ID → 平台集合」；有歧义时要求显式 platform，
//      绝不猜测（猜错就是把 A 平台的消息当成 B 平台的引用/转发）。
//   4. 自消息回环与重复连接：message_sent / 发送者等于本通道 self 的事件在
//      路由层直接丢掉；connect() 幂等，重复调用不会开第二条 WebSocket。
//
// 不支持的桥接能力（B站没有 poke / 合并转发 / QQ 自定义表情等）必须抛错，
// 不能静默成功或改发到 QQ。

import {
  BILI_VIRTUAL_ID_START,
  BILI_VIRTUAL_ID_END,
  normalizeChannelIdRange
} from './config.js';

export const PLATFORM_QQ = 'qq';
export const PLATFORM_BILI = 'bili';

export const CHANNEL_LABELS = Object.freeze({
  [PLATFORM_QQ]: 'QQ',
  [PLATFORM_BILI]: 'B站'
});

export const DEFAULT_ID_RANGES = Object.freeze({
  [PLATFORM_QQ]: Object.freeze({ start: 1, end: BILI_VIRTUAL_ID_START - 1 }),
  [PLATFORM_BILI]: Object.freeze({ start: BILI_VIRTUAL_ID_START, end: BILI_VIRTUAL_ID_END })
});

// B站桥接明确支持的动作（protocol-bili-bridge 的 OneBot 契约）。
// 未列出的动作默认拒绝；桥接自研 custom action 通过 channels.bili.extraActions 声明。
export const BILI_SUPPORTED_ACTIONS = new Set([
  'send_group_msg',
  'send_private_msg',
  'send_msg',
  'get_msg',
  'get_group_info',
  'get_group_member_info',
  'get_group_member_list',
  'get_group_list',
  'get_login_info',
  'get_status',
  'get_version_info'
]);

// B站评论/私信只允许这些段。视频、语音、文件、合并转发、QQ 表情、卡片等
// 在 B站没有等价物；转发给桥接只会得到一条含糊的 1404，不如在核心层说清楚。
const BILI_SEGMENT_TYPES = new Set(['text', 'at', 'reply', 'image']);

// 有明确目标参数的动作：按参数里的 ID 选通道。
const ACTION_TARGETS = Object.freeze({
  send_group_msg: 'group_id',
  send_group_forward_msg: 'group_id',
  get_group_info: 'group_id',
  get_group_member_info: 'group_id',
  get_group_member_list: 'group_id',
  get_group_honor_info: 'group_id',
  get_group_at_all_remain: 'group_id',
  set_group_ban: 'group_id',
  set_group_kick: 'group_id',
  set_group_leave: 'group_id',
  set_group_whole_ban: 'group_id',
  set_group_card: 'group_id',
  set_group_name: 'group_id',
  group_poke: 'group_id',
  upload_group_file: 'group_id',
  send_private_msg: 'user_id',
  send_private_forward_msg: 'user_id',
  friend_poke: 'user_id',
  get_stranger_info: 'user_id',
  send_like: 'user_id',
  set_friend_remark: 'user_id',
  upload_private_file: 'user_id',
  get_msg: 'message_id',
  get_forward_msg: 'message_id'
});

// 需要跨通道聚合的列表动作：QQ 群 + B站视频/动态/直播虚拟群一起返回。
const AGGREGATE_ACTIONS = new Set(['get_group_list', 'get_friend_list']);

// 没有目标参数、且只有 QQ 协议端能执行的动作。B站-only 部署调用时
// 应得到「QQ 通道未启用」而不是被默认路由到 B站。
const QQ_ONLY_GLOBAL_ACTIONS = new Set([
  'get_image',
  'get_record',
  'fetch_custom_face_detail',
  'add_custom_face',
  'modify_custom_face',
  'delete_custom_face',
  'get_cookies',
  'get_csrf_token',
  'get_credentials',
  'get_online_clients',
  'get_collect_list',
  'set_online_status',
  'get_profile_like',
  'get_unidirectional_friend_list'
]);

const SELF_ACTIONS = new Set(['get_login_info', 'get_status', 'get_version_info']);

const SEND_ACTIONS = new Set([
  'send_group_msg',
  'send_private_msg',
  'send_msg',
  'send_group_forward_msg',
  'send_private_forward_msg'
]);

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;   // 消息 ID → 平台 的记忆窗口
const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;   // 重复事件窗口（桥接重连重放）
const DEFAULT_MESSAGE_CACHE_LIMIT = 5000;

/** 'bilibili' / 'B站' / 'bili' 统一成 'bili'；其余未知平台直接抛错。 */
export function normalizePlatform(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'qq') return PLATFORM_QQ;
  if (raw === 'bili' || raw === 'bilibili' || raw === 'b站') return PLATFORM_BILI;
  throw new Error(`未知通道：${value}（只支持 qq / bili）`);
}

export function labelForPlatform(platform) {
  return CHANNEL_LABELS[platform] || String(platform || '未知通道');
}

/**
 * 校验某个平台能否发送这些消息段。纯函数，供路由层与 SendQueue 共用。
 * 非 B站通道不限制（QQ 协议端能力最全，历史行为不变）。
 */
export function assertSegmentsForPlatform(platform, segments) {
  if (platform !== PLATFORM_BILI) return;
  const list = Array.isArray(segments) ? segments : [];
  for (const seg of list) {
    const type = String(seg?.type ?? '').trim();
    if (!BILI_SEGMENT_TYPES.has(type)) {
      throw new Error(`B站通道不支持消息段「${type || '未知'}」（已拒绝，不会改发到 QQ）`);
    }
    if (type === 'at') {
      const qq = seg?.data?.qq;
      if (qq != null && String(qq) !== 'all') {
        const n = Number(qq);
        if (!Number.isSafeInteger(n) || n < BILI_VIRTUAL_ID_START || n > BILI_VIRTUAL_ID_END) {
          throw new Error(`B站 @ 目标 ${qq} 不在 B站虚拟 ID 号段内，拒绝发送（避免 @ 到 QQ 号）`);
        }
      }
    }
  }
}

function isSafePositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0;
}

function collectArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return data == null ? [] : [data];
}

export class ChannelRouter {
  constructor({
    channels = {},
    createClient = null,
    onEvent = null,
    onStatus = null,
    log = null,
    messageCacheLimit = DEFAULT_MESSAGE_CACHE_LIMIT
  } = {}) {
    this.log = typeof log === 'function' ? log : null;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.createClient = typeof createClient === 'function' ? createClient : null;
    this.messageCacheLimit = Math.max(100, Number(messageCacheLimit) || DEFAULT_MESSAGE_CACHE_LIMIT);
    this.channels = new Map();   // platform -> record
    this.defaultPlatform = PLATFORM_QQ;
    this.#statusListeners = new Set();
    this.#messageIndex = new Map();
    this.#seenEvents = new Map();
    this.#started = false;

    for (const platform of [PLATFORM_QQ, PLATFORM_BILI]) {
      const raw = channels?.[platform];
      // 未出现的通道也保留记录：号段必须始终被占用，否则 B站 ID 会被 QQ 收下。
      const cfg = raw && typeof raw === 'object' ? { ...raw } : null;
      if (!cfg) continue;
      const enabled = cfg.enabled !== false;
      const record = {
        platform,
        enabled,
        config: {
          ...cfg,
          idRange: normalizeChannelIdRange(cfg.idRange, DEFAULT_ID_RANGES[platform], `channels.${platform}.idRange`)
        },
        client: null,
        status: { connected: false, everConnected: false, error: '', selfId: '', nickname: '' }
      };
      // 先入表再创建客户端：客户端若在 connect/构造期间同步广播状态，
      // #handleClientStatus 必须能找到记录。
      this.channels.set(platform, record);
      if (enabled) {
        const client = cfg.client || (this.createClient ? this.createClient(platform, record.config) : null);
        if (!client) {
          throw new Error(`ChannelRouter：${labelForPlatform(platform)} 通道已启用，但没有可用的 OneBot 客户端`);
        }
        record.client = client;
        record.status.selfId = String(client.selfId || record.config.selfUserId || '');
        record.status.nickname = String(client.selfNickname || record.config.selfNickname || '');
        client.onStatus?.((status) => this.#handleClientStatus(platform, status));
      }
    }

    this.#validateRanges();
    this.defaultPlatform = this.#pickDefaultPlatform();
    if (typeof onStatus === 'function') this.onStatus(onStatus);
  }

  #statusListeners;
  #messageIndex;
  #seenEvents;
  #started;

  // ── 通道与配置 ─────────────────────────────────────────────────────────

  #validateRanges() {
    const list = [...this.channels.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ar = a.config.idRange;
        const br = b.config.idRange;
        const overlap = !(ar.end < br.start || br.end < ar.start);
        if (overlap) {
          throw new Error(
            `${labelForPlatform(a.platform)} 与 ${labelForPlatform(b.platform)} 的 ID 号段重叠`
            + `（[${ar.start}, ${ar.end}] / [${br.start}, ${br.end}]）：`
            + '同一 ID 无法安全判定平台，已拒绝路由'
          );
        }
      }
    }
  }

  #pickDefaultPlatform() {
    const qq = this.channels.get(PLATFORM_QQ);
    if (qq?.enabled) return PLATFORM_QQ;
    const first = [...this.channels.values()].find((r) => r.enabled);
    return first?.platform || PLATFORM_QQ;
  }

  isEnabled(platform) {
    return this.channels.get(normalizePlatform(platform))?.enabled === true;
  }

  channel(platform) {
    return this.channels.get(normalizePlatform(platform)) || null;
  }

  /** app 的端口轮询需要遍历所有通道（含未启用，自行过滤）。 */
  channelRecords() {
    return [...this.channels.values()];
  }

  enabledPlatforms() {
    return [...this.channels.values()].filter((r) => r.enabled).map((r) => r.platform);
  }

  #requireEnabled(platform) {
    const record = this.channels.get(platform);
    if (!record) throw new Error(`通道 ${labelForPlatform(platform)} 未配置`);
    if (!record.enabled) {
      throw new Error(`${labelForPlatform(platform)} 通道未启用（已拒绝路由，不会改发到其他平台）`);
    }
    return record;
  }

  #client(platform) {
    const record = this.#requireEnabled(platform);
    if (!record.client) throw new Error(`${labelForPlatform(platform)} 通道没有可用的 OneBot 客户端`);
    return record.client;
  }

  /**
   * 运行期更新通道连接参数（启动时从磁盘重读配置、令牌轮换后同步 URL）。
   * 只改连接参数，不改变号段语义；号段变化会重新校验重叠。
   */
  applyChannelConfig(channels = {}) {
    for (const record of this.channels.values()) {
      const next = channels?.[record.platform];
      if (!next || typeof next !== 'object') continue;
      const prev = record.config;
      record.config = {
        ...prev,
        ...next,
        idRange: normalizeChannelIdRange(
          next.idRange ?? prev.idRange,
          prev.idRange,
          `channels.${record.platform}.idRange`
        )
      };
      record.enabled = next.enabled !== false;
      if (record.enabled && !record.client && this.createClient) {
        const client = this.createClient(record.platform, record.config);
        if (client) {
          record.client = client;
          record.status.selfId = String(client.selfId || record.config.selfUserId || '');
          record.status.nickname = String(client.selfNickname || record.config.selfNickname || '');
          client.onStatus?.((status) => this.#handleClientStatus(record.platform, status));
        }
      } else if (!record.enabled && record.client) {
        try { record.client.close(); } catch { /* ignore */ }
        record.client = null;
        record.status = { connected: false, everConnected: false, error: '', selfId: '', nickname: '' };
      }
      const client = record.client;
      if (client) {
        if (next.wsUrl !== undefined) client.wsUrl = String(next.wsUrl);
        if (next.httpUrl !== undefined) client.httpUrl = String(next.httpUrl).replace(/\/+$/, '');
        if (next.accessToken !== undefined) client.accessToken = String(next.accessToken || '');
        if (next.httpAccessToken !== undefined || next.accessToken !== undefined) {
          client.httpToken = String(next.httpAccessToken || next.accessToken || '');
        }
        if (next.selfUserId !== undefined) client.configuredSelfId = String(next.selfUserId || '');
        if (next.selfNickname !== undefined) client.configuredNickname = String(next.selfNickname || '');
      }
    }
    this.#validateRanges();
    this.defaultPlatform = this.#pickDefaultPlatform();
    return this;
  }

  // ── 状态 / 兼容 OneBotClient 门面 ──────────────────────────────────────

  #handleClientStatus(platform, status = {}) {
    const record = this.channels.get(platform);
    if (!record) return;
    record.status = {
      connected: status.connected === true,
      everConnected: status.connected === true || status.everConnected === true || record.status.everConnected,
      error: String(status.error || ''),
      selfId: String(record.client?.selfId || record.config.selfUserId || ''),
      nickname: String(record.client?.selfNickname || record.config.selfNickname || '')
    };
    this.#emitStatus();
  }

  #emitStatus() {
    const status = this.status();
    for (const fn of this.#statusListeners) {
      try { fn(status); } catch { /* 监听器异常不能影响路由 */ }
    }
  }

  onStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  channelStatus(platform) {
    const record = this.channels.get(normalizePlatform(platform));
    if (!record) return null;
    const selfId = String(record.client?.selfId || record.config.selfUserId || record.status.selfId || '');
    const nickname = String(record.client?.selfNickname || record.config.selfNickname || record.status.nickname || '');
    return {
      platform: record.platform,
      enabled: record.enabled,
      connected: record.status.connected === true,
      everConnected: record.status.everConnected === true,
      error: record.status.error || '',
      selfId,
      nickname,
      self: selfId ? { userId: selfId, nickname } : null
    };
  }

  /**
   * 聚合状态。顶层字段锚定 defaultPlatform（QQ 优先），保持旧 UI / 路由
   * `/api/status` 只读 `onebot.connected/selfId/...` 时的行为不变；
   * 每个通道的明细在 channels 里，B站状态不会覆盖 QQ 的顶层诊断。
   */
  status() {
    const channels = {};
    for (const record of this.channels.values()) {
      channels[record.platform] = this.channelStatus(record.platform);
    }
    const def = this.channelStatus(this.defaultPlatform) || {
      connected: false, everConnected: false, error: '', self: null
    };
    return {
      platform: this.defaultPlatform,
      connected: def.connected,
      everConnected: def.everConnected,
      error: def.error,
      self: def.self,
      channels
    };
  }

  #defaultRecord() {
    return this.channels.get(this.defaultPlatform) || null;
  }

  #qqRecord() {
    return this.channels.get(PLATFORM_QQ) || null;
  }

  get defaultClient() {
    return this.#defaultRecord()?.client || null;
  }

  get connected() {
    return this.#defaultRecord()?.status.connected === true;
  }

  get everConnected() {
    return this.#defaultRecord()?.status.everConnected === true;
  }

  get lastConnectError() {
    return this.#defaultRecord()?.status.error || '';
  }

  get selfInfo() {
    return this.defaultClient?.selfInfo ?? null;
  }

  set selfInfo(value) {
    const client = this.defaultClient;
    if (client) client.selfInfo = value;
  }

  get selfId() {
    return String(this.defaultClient?.selfId || '');
  }

  selfIdFor(platform) {
    const record = this.channels.get(normalizePlatform(platform));
    return String(record?.client?.selfId || record?.config?.selfUserId || '');
  }

  get selfNickname() {
    return String(this.defaultClient?.selfNickname || '');
  }

  selfNicknameFor(platform) {
    const record = this.channels.get(normalizePlatform(platform));
    return String(record?.client?.selfNickname || record?.config?.selfNickname || '');
  }

  // 旧 app.js 会直接写这些字段做 SnowLuma 令牌轮换；它们语义上属于 QQ 通道。
  get wsUrl() { return this.#qqRecord()?.client?.wsUrl || ''; }
  set wsUrl(value) { const c = this.#qqRecord()?.client; if (c) c.wsUrl = String(value); }

  get httpUrl() { return this.#qqRecord()?.client?.httpUrl || ''; }
  set httpUrl(value) {
    const c = this.#qqRecord()?.client;
    if (c) c.httpUrl = String(value).replace(/\/+$/, '');
  }

  get accessToken() { return this.#qqRecord()?.client?.accessToken || ''; }
  set accessToken(value) { const c = this.#qqRecord()?.client; if (c) c.accessToken = String(value || ''); }

  get httpToken() { return this.#qqRecord()?.client?.httpToken || ''; }
  set httpToken(value) { const c = this.#qqRecord()?.client; if (c) c.httpToken = String(value || ''); }

  get tokenCandidates() { return this.#qqRecord()?.client?.tokenCandidates; }
  set tokenCandidates(value) { const c = this.#qqRecord()?.client; if (c) c.tokenCandidates = value; }

  // ── 连接生命周期 ───────────────────────────────────────────────────────

  /** 幂等：重复调用不会创建第二条连接。 */
  async connect() {
    if (this.#started) return this;
    this.#started = true;
    await Promise.all([...this.channels.values()]
      .filter((record) => record.enabled && record.client)
      .map(async (record) => {
        try {
          await record.client.connect();
        } catch (error) {
          this.log?.(`[channel-router] ${labelForPlatform(record.platform)} 连接启动失败：${error?.message ?? error}`);
        }
      }));
    return this;
  }

  /** 默认只重连 defaultPlatform（令牌轮换等旧调用语义），其他通道用 reconnectAll。 */
  async reconnect(platform = this.defaultPlatform) {
    const record = this.channels.get(normalizePlatform(platform));
    if (!record?.enabled || !record.client) return;
    await record.client.reconnect();
  }

  async reconnectAll() {
    await Promise.all([...this.channels.values()]
      .filter((record) => record.enabled && record.client)
      .map((record) => record.client.reconnect().catch((error) => {
        this.log?.(`[channel-router] ${labelForPlatform(record.platform)} 重连失败：${error?.message ?? error}`);
      })));
  }

  close() {
    this.#started = false;
    for (const record of this.channels.values()) {
      try { record.client?.close(); } catch { /* ignore */ }
    }
  }

  // ── 事件入口 ───────────────────────────────────────────────────────────

  /**
   * 单个通道的事件入口。app 只在这里拿到 (event, meta)，meta 带平台与 self，
   * 后续 ingest / @ 判定 / 自消息过滤都按 meta 走。
   * @returns {boolean} 事件是否被交给上层
   */
  dispatch(platform, event) {
    const record = this.channels.get(normalizePlatform(platform));
    if (!record || !record.enabled || !record.client) return false;
    if (!event || typeof event !== 'object') return false;

    // 先记消息归属，再过滤：自消息的 message_id 之后也可能被 get_msg 查询。
    if (event.message_id != null) this.#rememberMessage(record.platform, event.message_id);

    if (this.#isSelfEvent(record, event)) return false;
    if (this.#isDuplicateEvent(record.platform, event)) return false;

    const meta = Object.freeze({
      platform: record.platform,
      channel: record.platform,
      client: record.client,
      selfId: String(record.client.selfId || record.config.selfUserId || ''),
      selfNickname: String(record.client.selfNickname || record.config.selfNickname || '')
    });
    try {
      this.onEvent?.(event, meta);
    } catch (error) {
      this.log?.(`[channel-router] 事件处理失败（${labelForPlatform(record.platform)}）：${error?.message ?? error}`);
    }
    return true;
  }

  /**
   * 自消息过滤。OneBot 语义里 message_sent 一定是机器人自己发出的消息；
   * message 事件的发送者等于本通道 self 时同样丢弃 —— 否则 Agent 会把自己的
   * 发言当成新消息，形成无限回环。
   */
  #isSelfEvent(record, event) {
    const postType = String(event.post_type || '');
    if (postType === 'message_sent') return true;
    if (postType !== 'message' && postType !== 'notice') return false;
    const selfId = String(record.client?.selfId || record.config.selfUserId || '').trim();
    const eventSelfId = String(event.self_id ?? '').trim();
    const senderId = String(event.user_id ?? event.sender?.user_id ?? event.author?.user_id ?? '').trim();
    if (postType === 'message') {
      if (selfId && senderId && senderId === selfId) return true;
      if (!selfId && eventSelfId && senderId && senderId === eventSelfId) return true;
      return false;
    }
    // 自己 poke 自己的 OneBot 回显（send_poke 的 notice）不触发处理。
    if (event.notice_type === 'notify' && event.sub_type === 'poke') {
      return Boolean(selfId && senderId && senderId === selfId);
    }
    return false;
  }

  #isDuplicateEvent(platform, event) {
    const postType = String(event.post_type || '');
    if (!postType || postType === 'meta_event') return false;
    let unique = '';
    if (event.message_id != null) {
      unique = `${postType}:${event.message_type || ''}:${event.group_id ?? event.user_id ?? ''}:${event.message_id}`;
    } else if (event.notice_type) {
      unique = `${postType}:${event.notice_type}:${event.sub_type || ''}:`
        + `${event.group_id ?? ''}:${event.user_id ?? ''}:${event.target_id ?? ''}:${event.time ?? ''}`;
    }
    if (!unique) return false;

    const key = `${platform}:${unique}`;
    const now = Date.now();
    const previous = this.#seenEvents.get(key);
    if (previous && now - previous < EVENT_DEDUPE_TTL_MS) return true;
    this.#seenEvents.set(key, now);
    if (this.#seenEvents.size > 3000) {
      for (const [oldKey, ts] of this.#seenEvents) {
        if (now - ts > EVENT_DEDUPE_TTL_MS || this.#seenEvents.size > 2500) this.#seenEvents.delete(oldKey);
        if (this.#seenEvents.size <= 2500) break;
      }
    }
    return false;
  }

  // ── 目标 / 消息 ID 归属 ────────────────────────────────────────────────

  /**
   * 目标 ID → 通道。ID 必须恰好落在一个号段内；段外、重叠、命中未启用通道
   * 都是硬错误（不回落默认通道）。
   */
  platformFor(kind, id) {
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话类型：${kind}`);
    return this.#platformById(id);
  }

  /** chatKey → 平台（bili-agent-pack 等 Skill 用它判断当前会话是否 B站）。 */
  channelFor(chatKey) {
    const [kind, id] = String(chatKey || '').split(':');
    if (!id) return '';
    try {
      return this.platformFor(kind, id);
    } catch {
      return '';
    }
  }

  isBiliChat(chatKey) {
    return this.channelFor(chatKey) === PLATFORM_BILI;
  }

  #platformById(id) {
    const n = Number(id);
    if (!isSafePositiveInt(n)) {
      throw new Error(`非法目标 ID：${id}（必须是小于 2^53 的正整数）`);
    }
    const matches = [];
    for (const record of this.channels.values()) {
      const range = record.config.idRange;
      if (n >= range.start && n <= range.end) matches.push(record);
    }
    if (matches.length === 0) {
      throw new Error(
        `目标 ID ${id} 不在任何已配置通道的号段内（QQ/B站号段已隔离），`
        + '已拒绝发送/查询，避免跨平台误发'
      );
    }
    if (matches.length > 1) {
      throw new Error(`目标 ID ${id} 同时落在多个通道号段内，配置有误，已拒绝路由`);
    }
    const record = matches[0];
    if (!record.enabled) {
      throw new Error(
        `目标 ID ${id} 属于未启用的 ${labelForPlatform(record.platform)} 通道，`
        + '已拒绝路由（不会改发到其他平台）'
      );
    }
    return record.platform;
  }

  /** 消息 ID → 通道。explicit 优先；否则必须有唯一归属，歧义即抛错。 */
  platformForMessage(messageId, { platform = null } = {}) {
    if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
      throw new Error('缺少 message_id，无法判定消息所属平台');
    }
    if (platform) {
      const explicit = normalizePlatform(platform);
      this.#requireEnabled(explicit);
      return explicit;
    }
    const key = String(messageId);
    const entry = this.#messageIndex.get(key);
    const now = Date.now();
    const seen = [];
    if (entry) {
      for (const [p, ts] of entry) {
        if (now - ts <= MESSAGE_TTL_MS) seen.push(p);
      }
    }
    const enabledSeen = seen.filter((p) => this.isEnabled(p));
    if (enabledSeen.length === 1) return enabledSeen[0];
    if (enabledSeen.length > 1) {
      throw new Error(
        `消息 ${messageId} 同时出现在 ${enabledSeen.map(labelForPlatform).join(' / ')} 的 ID 记录里，`
        + '无法安全判定平台；请显式指定 platform'
      );
    }
    if (seen.length > 0) {
      const known = seen.map(labelForPlatform).join(' / ');
      throw new Error(`消息 ${messageId} 属于未启用的 ${known} 通道，已拒绝查询`);
    }
    const enabled = this.enabledPlatforms();
    if (enabled.length === 1) return enabled[0];
    throw new Error(
      `无法判定消息 ${messageId} 所属平台（重启前/尚未收到的消息没有归属记录）；`
      + '请在调用里显式指定 platform'
    );
  }

  #rememberMessage(platform, messageId) {
    if (messageId === undefined || messageId === null) return;
    const key = String(messageId).trim();
    if (!key || key === 'undefined' || key === 'null') return;
    let entry = this.#messageIndex.get(key);
    if (!entry) {
      entry = new Map();
      this.#messageIndex.set(key, entry);
    }
    entry.delete(platform);
    entry.set(platform, Date.now());
    if (this.#messageIndex.size > this.messageCacheLimit) {
      let drop = Math.max(1, Math.floor(this.messageCacheLimit * 0.1));
      for (const oldKey of this.#messageIndex.keys()) {
        if (drop-- <= 0) break;
        this.#messageIndex.delete(oldKey);
      }
    }
  }

  #rememberResponse(platform, action, data) {
    if (!SEND_ACTIONS.has(action)) return;
    if (data?.message_id != null) this.#rememberMessage(platform, data.message_id);
  }

  // ── 能力表 ─────────────────────────────────────────────────────────────

  /**
   * 能力查询。两种调用方式：
   *   supportsAction('bili', 'send_group_msg')  —— 核心内部使用
   *   supportsAction('bili_get_video_context')   —— 单参数兼容 bili-agent-pack
   * 单参数形式只看 B站能力表（桥接自定义 `bili_*` 动作视为 B站专属命名空间）。
   */
  supportsAction(platform, action) {
    if (action === undefined) {
      const name = String(platform || '').trim();
      const bili = this.channels.get(PLATFORM_BILI);
      if (!bili || !bili.enabled) return false;
      return this.#biliSupports(name);
    }
    const p = normalizePlatform(platform);
    if (p === PLATFORM_QQ) return true;
    const record = this.channels.get(p);
    if (!record) return false;
    return this.#biliSupports(action);
  }

  #biliSupports(action) {
    const name = String(action || '');
    const record = this.channels.get(PLATFORM_BILI);
    if (Array.isArray(record?.config?.extraActions)
      && record.config.extraActions.map((x) => String(x)).includes(name)) {
      return true;
    }
    // bili_* 是桥接自定义动作的保留命名空间：核心不认识它们，但可以安全
    // 判定为 B站动作（永远不会被路由到 QQ）。
    if (/^bili_/i.test(name)) return true;
    return BILI_SUPPORTED_ACTIONS.has(name);
  }

  assertAction(platform, action) {
    const p = normalizePlatform(platform);
    this.#requireEnabled(p);
    if (this.supportsAction(p, action)) return p;
    throw new Error(
      `${labelForPlatform(p)} 通道不支持动作 ${action}`
      + '（能力未声明，已拒绝；不会改发到其他平台）'
    );
  }

  assertSegments(platform, segments) {
    const p = normalizePlatform(platform);
    assertSegmentsForPlatform(p, segments);
    // @ 段里的用户 ID 也必须属于同一平台：B站会话 @ 一个 QQ 号、或 QQ 会话
    // @ 一个 B站虚拟 ID，都是跨平台 ID 混用，必须在出站前拦住。
    for (const seg of Array.isArray(segments) ? segments : []) {
      if (seg?.type !== 'at') continue;
      const qq = seg?.data?.qq;
      if (qq == null || String(qq) === 'all') continue;
      this.#assertUserIdOnPlatform(qq, p, 'at.qq');
    }
  }

  #assertUserIdOnPlatform(userId, platform, label) {
    if (userId === undefined || userId === null || String(userId).trim() === '') return;
    const actual = this.#platformById(userId);
    if (actual !== platform) {
      throw new Error(
        `${label}=${userId} 属于 ${labelForPlatform(actual)} 号段，`
        + `与目标平台 ${labelForPlatform(platform)} 不一致，已拒绝发送`
      );
    }
  }

  /** SendQueue 的统一出站校验入口：号段 + 白名单之外的最后一道跨平台闸。 */
  assertSendTarget(kind, id, action) {
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话类型：${kind}`);
    const platform = this.platformFor(kind, id);
    this.assertAction(platform, action);
    return platform;
  }

  // ── 动作路由 ───────────────────────────────────────────────────────────

  #routeTarget(id, key, action, explicitPlatform) {
    if (id === undefined || id === null || String(id).trim() === '') {
      throw new Error(`动作 ${action} 缺少 ${key}`);
    }
    const actual = this.#platformById(id);
    if (explicitPlatform && explicitPlatform !== actual) {
      throw new Error(
        `显式 platform=${explicitPlatform} 与 ${key}=${id} 所属号段（${labelForPlatform(actual)}）冲突，`
        + '已拒绝路由'
      );
    }
    this.assertAction(actual, action);
    return actual;
  }

  #resolveActionPlatform(action, params, explicitPlatform) {
    const targetKey = ACTION_TARGETS[action];
    if (targetKey === 'message_id') {
      if (explicitPlatform) {
        this.assertAction(explicitPlatform, action);
        return explicitPlatform;
      }
      return this.platformForMessage(params.message_id);
    }
    if (action === 'send_poke') {
      if (params.group_id !== undefined && params.group_id !== null) {
        return this.#routeTarget(params.group_id, 'group_id', action, explicitPlatform);
      }
      if (params.user_id !== undefined && params.user_id !== null) {
        return this.#routeTarget(params.user_id, 'user_id', action, explicitPlatform);
      }
      throw new Error('动作 send_poke 缺少 group_id / user_id');
    }
    if (action === 'send_msg') {
      const messageType = String(params.message_type || '').trim();
      if (messageType === 'group' || (!messageType && params.group_id !== undefined)) {
        return this.#routeTarget(params.group_id, 'group_id', action, explicitPlatform);
      }
      if (messageType === 'private' || (!messageType && params.user_id !== undefined)) {
        return this.#routeTarget(params.user_id, 'user_id', action, explicitPlatform);
      }
      throw new Error('动作 send_msg 缺少 message_type / group_id / user_id');
    }
    if (targetKey) {
      return this.#routeTarget(params[targetKey], targetKey, action, explicitPlatform);
    }
    if (QQ_ONLY_GLOBAL_ACTIONS.has(action)) {
      const platform = explicitPlatform || PLATFORM_QQ;
      if (platform !== PLATFORM_QQ) {
        throw new Error(`动作 ${action} 只支持 QQ 通道，B站通道不支持（已拒绝）`);
      }
      this.#requireEnabled(PLATFORM_QQ);
      return PLATFORM_QQ;
    }
    if (SELF_ACTIONS.has(action)) {
      const platform = explicitPlatform || this.defaultPlatform;
      this.#requireEnabled(platform);
      return platform;
    }
    // bili_* 是 B站桥接的保留命名空间（video context / inspect user / reply /
    // like 等 custom action）。即使参数里没有 group_id/user_id，也必须走 B站，
    // 绝不能因为"未知动作"落回默认 QQ 通道。
    if (/^bili_/i.test(action)) {
      const platform = explicitPlatform || PLATFORM_BILI;
      if (platform !== PLATFORM_BILI) {
        throw new Error(`动作 ${action} 属于 B站命名空间，不能路由到 ${labelForPlatform(platform)}`);
      }
      this.#requireEnabled(PLATFORM_BILI);
      return PLATFORM_BILI;
    }
    // 未登记的自定义 action：只要带了目标参数就按目标号段路由（B站桥接的
    // custom action 常见形态），否则才回落默认通道。这样 extraActions 里
    // 声明的 B站动作不会被误甩到 QQ。
    if (params.group_id !== undefined && params.group_id !== null) {
      return this.#routeTarget(params.group_id, 'group_id', action, explicitPlatform);
    }
    if (params.user_id !== undefined && params.user_id !== null) {
      return this.#routeTarget(params.user_id, 'user_id', action, explicitPlatform);
    }
    // 无目标参数的未知动作：沿用旧行为走默认通道（QQ 优先）。B站 custom action
    // 应通过 extraActions 声明并显式指定 platform，避免被默认甩给 QQ。
    const platform = explicitPlatform || this.defaultPlatform;
    this.#requireEnabled(platform);
    return platform;
  }

  async #callAggregate(action, params, timeoutMs, explicitPlatform) {
    if (explicitPlatform) {
      this.assertAction(explicitPlatform, action);
      const data = await this.#client(explicitPlatform).call(action, params, timeoutMs);
      this.#rememberResponse(explicitPlatform, action, data);
      return data;
    }
    const records = [...this.channels.values()].filter(
      (record) => record.enabled && record.client && this.supportsAction(record.platform, action)
    );
    if (!records.length) {
      throw new Error(`没有已启用的通道支持动作 ${action}`);
    }
    if (records.length === 1) {
      const only = records[0];
      const data = await only.client.call(action, params, timeoutMs);
      this.#rememberResponse(only.platform, action, data);
      return data;
    }
    const settled = await Promise.allSettled(
      records.map((record) => record.client.call(action, params, timeoutMs))
    );
    const merged = [];
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const record = records[i];
      if (result.status === 'fulfilled') {
        merged.push(...collectArray(result.value));
      } else {
        const message = String(result.reason?.message ?? result.reason);
        errors.push(`${labelForPlatform(record.platform)}：${message}`);
        this.log?.(`[channel-router] ${labelForPlatform(record.platform)} ${action} 失败（其余通道结果仍返回）：${message}`);
      }
    }
    if (!merged.length && errors.length === records.length) {
      throw new Error(`所有通道 ${action} 均失败：${errors.join('；')}`);
    }
    return merged;
  }

  /**
   * OneBot HTTP 动作统一入口（与 OneBotClient.call 签名兼容）。
   * options.platform 或 params.__platform 可显式指定平台（会从 params 里剥掉，
   * 不传给协议端）；显式平台与目标号段冲突时抛错，不允许"强行改平台"。
   */
  async call(action, params = {}, timeoutMs = null, options = {}) {
    const actionName = String(action || '').trim();
    if (!actionName) throw new Error('OneBot 动作名为空');
    const cleanParams = params && typeof params === 'object' ? { ...params } : {};
    const inlinePlatform = cleanParams.__platform ?? cleanParams.__channel;
    delete cleanParams.__platform;
    delete cleanParams.__channel;
    const explicitRaw = options?.platform ?? inlinePlatform;
    const explicitPlatform = explicitRaw ? normalizePlatform(explicitRaw) : null;
    if (explicitPlatform) this.#requireEnabled(explicitPlatform);

    if (AGGREGATE_ACTIONS.has(actionName)) {
      return this.#callAggregate(actionName, cleanParams, timeoutMs, explicitPlatform);
    }

    const platform = this.#resolveActionPlatform(actionName, cleanParams, explicitPlatform);
    this.assertAction(platform, actionName);
    if (SEND_ACTIONS.has(actionName) && Array.isArray(cleanParams.message)) {
      this.assertSegments(platform, cleanParams.message);
    }
    const data = await this.#client(platform).call(actionName, cleanParams, timeoutMs);
    this.#rememberResponse(platform, actionName, data);
    return data;
  }

  // ── 发送快捷方法（OneBotClient 兼容） ──────────────────────────────────

  #assertOptionsPlatform(options, platform) {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.platform !== undefined && opts.platform !== null) {
      const requested = normalizePlatform(opts.platform);
      if (requested !== platform) {
        throw new Error(
          `显式 platform=${requested} 与目标 ID 所属平台（${labelForPlatform(platform)}）冲突，已拒绝发送`
        );
      }
    }
    if (opts.atUserId !== undefined && opts.atUserId !== null && String(opts.atUserId).trim() !== '') {
      this.#assertUserIdOnPlatform(opts.atUserId, platform, 'atUserId');
    }
  }

  async sendText(kind, id, text, options = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const platform = this.assertSendTarget(kind, id, action);
    this.#assertOptionsPlatform(options, platform);
    const data = await this.#client(platform).sendText(kind, id, text, options);
    this.#rememberResponse(platform, action, data);
    return data;
  }

  async sendSticker(kind, id, imageRef, options = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const platform = this.assertSendTarget(kind, id, action);
    this.#assertOptionsPlatform(options, platform);
    assertSegmentsForPlatform(platform, [{ type: 'image', data: { file: imageRef } }]);
    const data = await this.#client(platform).sendSticker(kind, id, imageRef, options);
    this.#rememberResponse(platform, action, data);
    return data;
  }

  async sendImage(kind, id, fileRef, options = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const platform = this.assertSendTarget(kind, id, action);
    this.#assertOptionsPlatform(options, platform);
    assertSegmentsForPlatform(platform, [{ type: 'image', data: { file: fileRef } }]);
    const data = await this.#client(platform).sendImage(kind, id, fileRef, options);
    this.#rememberResponse(platform, action, data);
    return data;
  }

  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const platform = this.assertSendTarget(kind, id, action);
    this.assertSegments(platform, segments);
    const data = await this.#client(platform).sendSegments(kind, id, segments);
    this.#rememberResponse(platform, action, data);
    return data;
  }

  async sendPoke(kind, id, targetUserId) {
    const action = kind === 'private' ? 'friend_poke' : 'group_poke';
    const platform = this.assertSendTarget(kind, id, action);
    if (targetUserId !== undefined && targetUserId !== null && String(targetUserId).trim() !== '') {
      this.#assertUserIdOnPlatform(targetUserId, platform, 'poke.target');
    }
    return this.#client(platform).sendPoke(kind, id, targetUserId);
  }

  async getMsg(messageId, options = {}) {
    const platform = this.platformForMessage(messageId, { platform: options?.platform ?? null });
    this.assertAction(platform, 'get_msg');
    return this.#client(platform).getMsg(messageId);
  }

  async getGroupInfo(groupId, options = {}) {
    const platform = this.assertSendTarget('group', groupId, 'get_group_info');
    this.#assertOptionsPlatform(options, platform);
    return this.#client(platform).getGroupInfo(groupId);
  }

  async getGroupMemberInfo(groupId, userId, options = {}) {
    const platform = this.assertSendTarget('group', groupId, 'get_group_member_info');
    this.#assertOptionsPlatform(options, platform);
    // 群与成员必须同平台：orchestrator 的禁言检查会用全局 selfId（QQ）去查
    // B站虚拟群，若不拦住就会把 QQ 号送进 B站桥接。这里明确拒绝而不是猜测。
    this.#assertUserIdOnPlatform(userId, platform, 'user_id');
    return this.#client(platform).getGroupMemberInfo(groupId, userId);
  }

  async getGroupList(options = {}) {
    const explicit = options?.platform ? normalizePlatform(options.platform) : null;
    return this.call('get_group_list', {}, null, explicit ? { platform: explicit } : {});
  }

  async getFriendList(options = {}) {
    const explicit = options?.platform ? normalizePlatform(options.platform) : null;
    return this.call('get_friend_list', {}, null, explicit ? { platform: explicit } : {});
  }
}
