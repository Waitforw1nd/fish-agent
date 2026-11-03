// QQ official gateway adapter. Wire schema is based on tencent-connect/botgo and bot-docs.
import WebSocket from 'ws';
import { OneBotClient } from '../../src/onebot.js';

const safeId = value => {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('QQBot 返回了无效的 ID');
  return id;
};
const remember = (map, key, value, limit = 1000) => {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
};
const publicCode = value => /^-?\d{1,12}$/.test(String(value ?? '')) ? String(value) : 'unknown';
async function platformResponse(fetchImpl, url, options) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'error' }); }
  catch { throw new Error('QQBot 平台连接失败，请检查网络与平台地址'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`QQBot 平台返回了无效 JSON（HTTP ${response.status}）`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('QQBot 平台返回了无效数据');
  return { response, data };
}

export class QQBotClient extends OneBotClient {
  constructor({ appId, appSecret, sandbox = false, intents, onEvent, fetchImpl = fetch, reconnectMs = 3000, apiBase, tokenUrl }) {
    super({ onEvent });
    this.appId = String(appId || '');
    this.appSecret = String(appSecret || '');
    this.intents = intents;
    // Endpoint injection is for local protocol fixtures only; not user-controlled config.
    this.apiBase = apiBase || (sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com');
    this.tokenUrl = tokenUrl || 'https://bots.qq.com/app/getAppAccessToken';
    this.fetchImpl = fetchImpl;
    this.reconnectMs = reconnectMs;
    this.generation = 0;
    this.stopped = true;
    this.anchors = new Map();
    this.messages = new Map();
    this.seen = new Map();
    this.groups = new Map();
    this.friends = new Map();
    // 机器人在群里的 member_openid 与 READY 的 user.id 不是同一套值：
    // GROUP_AT 事件 content 里的 <@…> 用的是 member_openid。收到 AT 事件时
    // 把提及 ID 学进来，供全量消息的 @ 判定与正文清洗使用。
    this.selfMentions = new Set();
  }
  status(connected, error = '') {
    this.connected = connected;
    this.lastConnectError = error;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) { try { fn({ connected, everConnected: this.everConnected, error }); } catch {} }
  }
  async token() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    if (!this.tokenPromise) this.tokenPromise = (async () => {
      if (!this.appId || !this.appSecret) throw new Error('缺少 QQBot AppID / AppSecret');
      const { response, data } = await platformResponse(this.fetchImpl, this.tokenUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192
          || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
        throw new Error(`QQBot 获取凭证失败：HTTP ${response.status}，code=${publicCode(data.code)}`);
      }
      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + Math.max(1, Number(data.expires_in) - 60) * 1000;
      return this.accessToken;
    })().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }
  async request(route, body, method = 'POST') {
    const token = await this.token();
    let success = false;
    try {
      const { response, data } = await platformResponse(this.fetchImpl, `${this.apiBase}${route}`, {
        method, headers: { authorization: `QQBot ${token}`, 'X-Union-Appid': this.appId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
      });
      success = response.ok && (data.code == null || data.code === 0 || data.code === '0');
      if (!success) {
        if (response.status === 401) this.tokenExpiresAt = 0;
        // Never retry message POSTs: the remote result may be unknown.
        throw new Error(`QQBot ${method} ${route} 失败：HTTP ${response.status}，code=${publicCode(data.code)}`);
      }
      return data;
    } finally { try { this.onApiCall?.({ success }); } catch {} }
  }
  async connect() {
    this.stopped = false;
    const generation = ++this.generation;
    void this.open(generation);
  }
  async reconnect() { this.close(); await this.connect(); }
  async open(generation) {
    try {
      await this.token();
      const gateway = await this.request('/gateway/bot', undefined, 'GET');
      if (this.stopped || generation !== this.generation) return;
      let url;
      try { url = new URL(gateway.url); } catch { throw new Error('QQBot 网关地址无效'); }
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password
          || (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('QQBot 网关地址无效');
      const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
      this.socket = ws;
      this.acked = true;
      const current = () => !this.stopped && generation === this.generation && this.socket === ws;
      const send = (op, d) => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d })); };
      const heartbeat = () => {
        if (!this.acked) { ws.terminate(); return; }
        this.acked = false;
        send(1, this.sequence ?? null);
      };
      // Hello + READY must arrive; a TCP connection alone is not ready.
      this.readyTimer = setTimeout(() => { if (current() && !this.connected) ws.terminate(); }, 20000);
      ws.on('message', async raw => {
        if (!current()) return;
        let packet;
        try { packet = JSON.parse(String(raw)); } catch { return; }
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
        if (packet.s !== undefined && packet.s !== null) this.sequence = packet.s;
        if (packet.op === 10) {
          clearInterval(this.heartbeatTimer);
          const interval = Number(packet.d?.heartbeat_interval);
          if (!(interval > 0)) { ws.terminate(); return; }
          this.heartbeatTimer = setInterval(heartbeat, interval);
          try {
            const accessToken = await this.token();
            if (!current()) return;
            if (this.sessionId) send(6, { token: accessToken, session_id: this.sessionId, seq: this.sequence });
            else send(2, { token: `QQBot ${accessToken}`, intents: this.intents, shard: [0, 1], properties: { '$os': process.platform, '$browser': 'qq-agent', '$device': 'qq-agent' } });
          } catch { ws.terminate(); }
        } else if (packet.op === 11) this.acked = true;
        else if (packet.op === 1) send(1, this.sequence ?? null);
        else if (packet.op === 7) ws.close();
        else if (packet.op === 9) {
          if (!packet.d) { this.sessionId = null; this.sequence = null; }
          ws.close();
        } else if (packet.op === 0) {
          if (packet.t === 'READY') {
            if (!packet.d || typeof packet.d.session_id !== 'string') { ws.terminate(); return; }
            this.sessionId = packet.d.session_id;
            this.selfInfo = { user_id: packet.d.user?.id || this.appId, nickname: packet.d.user?.username || 'QQBot' };
            clearTimeout(this.readyTimer);
            this.failures = 0; this.status(true);
          } else if (packet.t === 'RESUMED') { clearTimeout(this.readyTimer); this.failures = 0; this.status(true); }
          else {
            try { this.dispatch(packet.t, packet.d); }
            catch { this.status(this.connected, 'QQBot 事件格式无效'); }
          }
        }
      });
      ws.on('error', () => { if (current()) this.status(false, 'QQBot WebSocket 连接失败，请检查网络、IP 白名单及通道权限'); });
      ws.on('close', code => {
        if (!current()) return;
        clearInterval(this.heartbeatTimer); clearTimeout(this.readyTimer);
        this.socket = null;
        if ([4006, 4007, 4009].includes(code)) { this.sessionId = null; this.sequence = null; }
        if (code === 4004) this.tokenExpiresAt = 0;
        this.status(false, `QQBot 网关已断开（${code}），等待重连`);
        this.retry(generation);
      });
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.status(false, error.message);
      this.retry(generation);
    }
  }
  retry(generation) {
    if (this.stopped || generation !== this.generation) return;
    clearTimeout(this.retryTimer);
    this.failures = (this.failures || 0) + 1;
    this.retryTimer = setTimeout(() => void this.open(generation), Math.min(30000, this.reconnectMs * 2 ** Math.min(4, this.failures - 1)));
  }
  close() {
    this.stopped = true; ++this.generation;
    clearTimeout(this.retryTimer); clearTimeout(this.readyTimer); clearInterval(this.heartbeatTimer);
    this.socket?.terminate(); this.socket = null;
    this.status(false);
  }
  dispatch(type, data) {
    const modes = { GROUP_AT_MESSAGE_CREATE: ['group', 'group', data.group_openid], GROUP_MESSAGE_CREATE: ['group', 'group', data.group_openid], C2C_MESSAGE_CREATE: ['private', 'user', data.author?.user_openid], AT_MESSAGE_CREATE: ['group', 'channel', data.channel_id], MESSAGE_CREATE: ['group', 'channel', data.channel_id], DIRECT_MESSAGE_CREATE: ['private', 'dm', data.guild_id] };
    const mode = modes[type];
    if (!mode) return;
    const [kind, scope, openid] = mode;
    const id = `qqbot_${scope}_${safeId(openid)}`;
    const mid = String(data.id || '');
    if (!mid || this.seen.has(mid)) return;
    remember(this.seen, mid, true, 3000);
    this.failures = 0;
    const userId = safeId(data.author?.member_openid || data.author?.user_openid || data.author?.id);
    const rawContent = String(data.content || '');
    // AT 事件里的 <@…> 提及的就是机器人自己（member_openid 形态），学进集合。
    const mentionIds = [...rawContent.matchAll(/<@!?([A-Za-z0-9_-]+)>/g)].map(m => m[1]);
    if (type.includes('AT_MESSAGE')) for (const m of mentionIds) this.selfMentions.add(m);
    const stripIds = [this.selfId, ...this.selfMentions].filter(Boolean)
      .map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const content = stripIds.length
      ? rawContent.replace(new RegExp(`<@!?(${stripIds.join('|')})>`, 'g'), '').trim()
      : rawContent.trim();
    const segments = [];
    // 全量模式（GROUP_MESSAGE_CREATE）下 @ 机器人不一定走 AT 事件，用 mentions 兜底判定。
    const known = new Set([String(this.selfId || ''), ...[...this.selfMentions].map(String)]);
    const mentionedSelf = (data.mentions || []).some(u => u?.bot
      && [u.id, u.member_openid, u.user_openid].filter(Boolean).map(String).some(x => known.has(x)));
    if (type.includes('AT_MESSAGE') || mentionedSelf) segments.push({ type: 'at', data: { qq: this.selfId } });
    segments.push({ type: 'text', data: { text: content } });
    for (const attachment of data.attachments || []) {
      if (/^image\//.test(attachment.content_type)) segments.push({ type: 'image', data: { url: String(attachment.url).startsWith('//') ? `https:${attachment.url}` : attachment.url } });
    }
    const event = { post_type: 'message', message_type: kind, self_id: this.selfId, user_id: kind === 'private' ? id : userId, group_id: kind === 'group' ? id : undefined, message_id: mid, time: Date.parse(data.timestamp) / 1000 || Date.now() / 1000, sender: { user_id: userId, nickname: data.author?.username || userId }, message: segments };
    // 群/C2C 仅允许绑定未过期入站 msg_id 的被动回复。
    remember(this.anchors, mid, { mid, id, kind, scope, openid: String(openid), receivedAt: Date.now(), seq: 0 });
    remember(this.messages, mid, event);
    remember(kind === 'group' ? this.groups : this.friends, id, id, 500);
    Promise.resolve().then(() => this.onEvent(event)).then(accepted => {
      if (accepted === false) { this.seen.delete(mid); this.status(this.connected, 'QQBot 入站事件处理失败'); }
    }, () => { this.seen.delete(mid); this.status(this.connected, 'QQBot 入站事件处理失败'); });
  }
  parseTarget(kind, id) {
    const match = /^qqbot_(group|user|channel|dm)_([A-Za-z0-9_-]{1,128})$/.exec(String(id));
    if (!match || (kind === 'group') !== ['group', 'channel'].includes(match[1])) throw new Error('QQBot 会话 ID 无效，请使用连接页显示的完整 ID');
    const scope = match[1];
    const openid = match[2];
    const path = scope === 'group' ? `/v2/groups/${openid}` : scope === 'user' ? `/v2/users/${openid}` : scope === 'channel' ? `/channels/${openid}` : `/dms/${openid}`;
    return { scope, openid, path };
  }
  /** 找可用的被动回复锚点；无锚点返回 null，发送方必须拒绝发送。 */
  anchorFor(kind, id, replyToMessageId) {
    let anchor = null;
    if (replyToMessageId) {
      anchor = this.anchors.get(String(replyToMessageId));
      if (!anchor || anchor.id !== id || anchor.kind !== kind) throw new Error('QQBot 引用回复的消息不属于本会话，请检查 replyToMessageId');
    } else {
      anchor = [...this.anchors.values()].reverse().find(a => a.id === id && a.kind === kind) || null;
    }
    if (!anchor) return null;
    const ttl = anchor.scope === 'user' ? 3600000 : 300000;
    // 达到被动回复次数上限时停止发送，不回落到主动消息。
    const cap = anchor.scope === 'user' ? 4 : 5;
    const expired = Date.now() - anchor.receivedAt > ttl;
    const exhausted = ['group', 'user'].includes(anchor.scope) && anchor.seq >= cap;
    if (expired || exhausted) {
      if (replyToMessageId) throw new Error(`QQBot 被动回复${expired ? '窗口已过期' : `次数已达 ${cap} 次上限`}，请等待新的入站消息`);
      return null;
    }
    return anchor;
  }
  /** 发消息并翻译平台错误码（主动消息权限/频控是最常见的两类拦截）。 */
  async postMessage(path, body, mode) {
    try {
      return await this.request(`${path}/messages`, body);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.includes('40034105')) {
        throw new Error(`QQBot ${mode}失败：机器人没有主动消息权限（请让群主在 群设置 → 群机器人 中开启「主动推送消息」）`);
      }
      if (message.includes('40034100')) {
        throw new Error(`QQBot ${mode}失败：主动消息超过频控（认证 60 条/分钟、未认证 30 条/分钟，单群 20 条/分钟、每群每天 1000 条），请稍后重试`);
      }
      throw error;
    }
  }
  target(kind, id, replyToMessageId) {
    const { path } = this.parseTarget(kind, id);
    const anchor = this.anchorFor(kind, id, replyToMessageId);
    if (!anchor) throw new Error('QQBot 缺少本会话的回复上下文，请先向机器人发消息');
    return { anchor, path };
  }
  async sendText(kind, id, text, options = {}) {
    if (options.atUserId) throw new Error('QQBot 此适配器不支持指定 @，请发送普通回复');
    const { path } = this.parseTarget(kind, id);
    const anchor = this.anchorFor(kind, id, options.replyToMessageId);
    // 没有可用锚点时拒绝发送。
    if (!anchor) throw new Error('QQBot passive reply window is unavailable');
    const body = { content: String(text), msg_id: anchor.mid, ...(['group', 'user'].includes(anchor.scope) ? { msg_type: 0, msg_seq: ++anchor.seq } : {}) };
    const data = await this.postMessage(path, body, '被动回复');
    return { message_id: data.id };
  }
  async sendImage(kind, id, url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('QQBot 官方媒体接口需要公网 HTTP(S) 图片 URL，不支持本地文件或 base64');
    const { scope, path } = this.parseTarget(kind, id);
    if (!['group', 'user'].includes(scope)) throw new Error('QQBot 频道图片发送尚不支持');
    if (options.atUserId) throw new Error('QQBot 此适配器不支持指定 @');
    const anchor = this.anchorFor(kind, id, options.replyToMessageId);
    if (!anchor) throw new Error('QQBot passive reply window is unavailable');
    // Reserve before the asynchronous upload, so concurrent images cannot exceed
    // the reply cap or reuse a msg_seq. Uncertain uploads are never retried.
    const seq = ++anchor.seq;
    const uploaded = await this.request(`${path}/files`, { file_type: 1, url, srv_send_msg: false });
    const ttl = scope === 'user' ? 3600000 : 300000;
    if (Date.now() - anchor.receivedAt > ttl) throw new Error('QQBot passive reply window expired during upload');
    const body = { content: ' ', msg_type: 7, media: { file_info: uploaded.file_info }, msg_id: anchor.mid, msg_seq: seq };
    const data = await this.postMessage(path, body, '被动回复');
    return { message_id: data.id };
  }
  sendSticker(...args) { return this.sendImage(...args); }
  sendSegments(kind, id, segments) {
    if (segments.some(s => s.type !== 'text')) throw new Error('QQBot 不支持此消息段组合');
    return this.sendText(kind, id, segments.map(s => s.data.text).join(''));
  }
  async sendPoke() { throw new Error('官方 QQBot 不支持拍一拍'); }
  async getMsg(id) { return this.messages.get(String(id)) || null; }
  async getGroupInfo(id) { return { group_id: id, group_name: this.groups.get(id) || id }; }
  async getGroupMemberInfo(groupId, id) { return { user_id: id, nickname: id }; }
  async call(action, params = {}) {
    if (action === 'get_login_info') return this.selfInfo;
    if (action === 'get_group_list') return [...this.groups].map(([group_id, group_name]) => ({ group_id, group_name }));
    if (action === 'get_friend_list') return [...this.friends].map(([user_id, nickname]) => ({ user_id, nickname }));
    if (action === 'get_group_info') return this.getGroupInfo(params.group_id);
    if (action === 'get_group_member_info') return this.getGroupMemberInfo(params.group_id, params.user_id);
    if (action === 'get_msg') return this.getMsg(params.message_id);
    throw new Error(`官方 QQBot 不支持 OneBot 扩展操作：${action}`);
  }
}
