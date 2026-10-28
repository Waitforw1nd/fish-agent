import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { BiliApiError, BridgeError } from '../errors.js';
import { sha256 } from '../util.js';

export const OP_HEARTBEAT = 2;
export const OP_HEARTBEAT_REPLY = 3;
export const OP_NOTIFICATION = 5;
export const OP_AUTH = 7;
export const OP_AUTH_REPLY = 8;

export const HEADER_SIZE = 16;
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

/** 构造一个 16 字节头的 B 站直播包。 */
export function buildPacket({ operation, body = Buffer.alloc(0), version = 0, sequence = 1 }) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(HEADER_SIZE + payload.length, 0);
  header.writeUInt16BE(HEADER_SIZE, 4);
  header.writeUInt16BE(version, 6);
  header.writeUInt32BE(operation, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, payload]);
}

/**
 * 解析单个 WS 帧：一个帧里可能串多个包（甚至压缩包内再套多个包）。
 * 支持 version 0/1（明文/人气值）与 2/3（zlib/brotli）。
 */
export function parsePacketBuffer(buffer, { maxDecompressedBytes = MAX_DECOMPRESSED_BYTES, depth = 0 } = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (depth > 4) throw new BridgeError('直播包嵌套过深', { kind: 'PROTOCOL', code: 502, retcode: 1502 });
  const packets = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= data.length) {
    const packetLength = data.readUInt32BE(offset);
    const headerLength = data.readUInt16BE(offset + 4);
    const version = data.readUInt16BE(offset + 6);
    const operation = data.readUInt32BE(offset + 8);
    const sequence = data.readUInt32BE(offset + 12);
    if (packetLength < HEADER_SIZE || headerLength < HEADER_SIZE || packetLength > data.length - offset) {
      throw new BridgeError('直播包长度非法', { kind: 'PROTOCOL', code: 502, retcode: 1502 });
    }
    const body = data.subarray(offset + headerLength, offset + packetLength);
    if (version === 0) {
      packets.push({ version, operation, sequence, body });
    } else if (version === 1) {
      const popularity = body.length >= 4 ? body.readUInt32BE(0) : 0;
      packets.push({ version, operation, sequence, body, popularity });
    } else if (version === 2) {
      let inflated;
      try {
        inflated = zlib.inflateSync(body, { maxOutputLength: maxDecompressedBytes });
      } catch (error) {
        throw new BridgeError('zlib 直播包解压失败', { kind: 'PROTOCOL', code: 502, retcode: 1502, cause: error });
      }
      packets.push(...parsePacketBuffer(inflated, { maxDecompressedBytes, depth: depth + 1 }));
    } else if (version === 3) {
      let inflated;
      try {
        inflated = zlib.brotliDecompressSync(body, { maxOutputLength: maxDecompressedBytes });
      } catch (error) {
        throw new BridgeError('brotli 直播包解压失败', { kind: 'PROTOCOL', code: 502, retcode: 1502, cause: error });
      }
      packets.push(...parsePacketBuffer(inflated, { maxDecompressedBytes, depth: depth + 1 }));
    } else {
      throw new BridgeError(`未知的直播包协议版本 ${version}`, { kind: 'PROTOCOL', code: 502, retcode: 1502 });
    }
    offset += packetLength;
  }
  return packets;
}

function liveEventId(parts) {
  return sha256(parts.join('|')).slice(0, 24);
}

/** 把 B 站直播 cmd 归一化成桥接事件；高流量/无关事件返回 null。 */
export function normalizeLiveEvent(cmd, data, { roomId = '', selfMid = '', selfName = '', now = Date.now } = {}) {
  const base = String(cmd || '').split(':')[0];
  const timestamp = Math.floor(now / 1000);
  if (base === 'DANMU_MSG') {
    const info = Array.isArray(data?.info) ? data.info : [];
    const meta = Array.isArray(info[0]) ? info[0] : [];
    const user = Array.isArray(info[2]) ? info[2] : [];
    const text = String(info[1] ?? '');
    const uid = String(user[0] ?? '');
    const uname = String(user[1] ?? '');
    const medal = Array.isArray(info[3]) && info[3].length
      ? { level: Number(info[3][0]) || 0, name: String(info[3][1] || '') }
      : null;
    const atSelf = Boolean(selfName && text.includes(`@${selfName}`))
      || Boolean(selfMid && meta?.[15]?.user?.uid != null && String(meta[15].user.uid) === String(selfMid));
    return {
      kind: 'danmaku',
      roomId: String(roomId),
      uid,
      uname,
      text,
      timestamp: Number(meta[4]) || timestamp,
      atSelf,
      eventId: liveEventId(['danmaku', roomId, uid, meta[5] ?? '', meta[4] ?? '', text]),
      medal,
      isAdmin: Number(user[2]) === 1,
      rawCmd: String(cmd)
    };
  }
  if (base === 'SEND_GIFT') {
    const gift = data?.data || {};
    return {
      kind: 'gift',
      roomId: String(roomId),
      uid: String(gift.uid ?? ''),
      uname: String(gift.uname ?? ''),
      giftName: String(gift.giftName ?? ''),
      num: Number(gift.num) || 1,
      price: Number(gift.price) || 0,
      coinType: String(gift.coin_type || ''),
      totalCoin: Number(gift.total_coin) || 0,
      action: String(gift.action || ''),
      guardLevel: Number(gift.guard_level) || 0,
      timestamp: Number(gift.timestamp) || timestamp,
      eventId: liveEventId(['gift', roomId, gift.uid, gift.timestamp, gift.giftName, gift.num, gift.action]),
      rawCmd: String(cmd)
    };
  }
  if (base === 'SUPER_CHAT_MESSAGE') {
    const sc = data?.data || {};
    return {
      kind: 'super_chat',
      roomId: String(roomId),
      uid: String(sc.uid ?? ''),
      uname: String(sc.user_info?.uname || ''),
      text: String(sc.message || ''),
      price: Number(sc.price) || 0,
      duration: Number(sc.time) || 0,
      startTime: Number(sc.start_time) || 0,
      endTime: Number(sc.end_time) || 0,
      guardLevel: Number(sc.guard_level) || 0,
      timestamp: Number(sc.start_time) || timestamp,
      eventId: liveEventId(['sc', roomId, sc.id, sc.uid, sc.start_time, sc.message]),
      rawCmd: String(cmd)
    };
  }
  if (base === 'GUARD_BUY') {
    const guard = data?.data || {};
    return {
      kind: 'guard',
      roomId: String(roomId),
      uid: String(guard.uid ?? ''),
      uname: String(guard.username ?? ''),
      giftName: String(guard.gift_name || ''),
      num: Number(guard.num) || 1,
      price: Number(guard.price) || 0,
      guardLevel: Number(guard.guard_level) || 0,
      startTime: Number(guard.start_time) || 0,
      endTime: Number(guard.end_time) || 0,
      timestamp: timestamp,
      eventId: liveEventId(['guard', roomId, guard.uid, guard.gift_name, guard.start_time]),
      rawCmd: String(cmd)
    };
  }
  if (base === 'LIVE' || base === 'PREPARING' || base === 'ROOM_REAL_TIME_MESSAGE_UPDATE') {
    return {
      kind: 'room_status',
      roomId: String(roomId),
      status: base === 'LIVE' ? 'live' : (base === 'PREPARING' ? 'preparing' : 'update'),
      timestamp,
      eventId: liveEventId(['room', roomId, base, timestamp]),
      rawCmd: String(cmd)
    };
  }
  return null;
}

export class LiveService {
  constructor({
    api,
    jar,
    now = Date.now,
    logger = null,
    wsProtocol = 'wss',
    WebSocketImpl = WebSocket,
    heartbeatIntervalMs = 30_000,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 30_000,
    authTimeoutMs = 15_000,
    maxDecompressedBytes = MAX_DECOMPRESSED_BYTES
  }) {
    if (!api || !jar) throw new TypeError('LiveService 需要 api 和 jar');
    this.api = api;
    this.jar = jar;
    this.now = now;
    this.logger = logger;
    this.wsProtocol = wsProtocol === 'ws' ? 'ws' : 'wss';
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.authTimeoutMs = authTimeoutMs;
    this.maxDecompressedBytes = maxDecompressedBytes;
    this.clients = new Map();
  }

  async resolveRoom(roomId) {
    if (!roomId) throw new BridgeError('缺少直播间 ID', { kind: 'INPUT', code: 400, retcode: 1400, wording: '缺少直播间 ID' });
    const payload = await this.api.request({
      method: 'GET',
      service: 'live',
      path: '/room/v1/Room/room_init',
      params: { id: String(roomId) },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    return {
      roomId: String(data.room_id ?? roomId),
      shortId: String(data.short_id ?? ''),
      ownerMid: String(data.uid ?? ''),
      liveStatus: Number(data.live_status) || 0
    };
  }

  async info(roomId) {
    const init = await this.resolveRoom(roomId);
    let title = '';
    let cover = '';
    try {
      const payload = await this.api.request({
        method: 'GET',
        service: 'live',
        path: '/xlive/web-room/v1/index/getInfoByRoom',
        params: { room_id: init.roomId },
        signed: false,
        allowedCodes: [0],
        retries: 1
      });
      const room = payload?.data?.room_info || {};
      title = String(room.title || '');
      cover = String(room.cover || room.keyframe || '');
      if (room.live_status != null) init.liveStatus = Number(room.live_status) || 0;
      if (room.uid) init.ownerMid = String(room.uid);
    } catch (error) {
      this.logger?.debug?.('读取直播间详情失败（使用 room_init）', error);
    }
    return { ...init, title, cover };
  }

  async danmuInfo(roomId) {
    const payload = await this.api.request({
      method: 'GET',
      service: 'live',
      path: '/xlive/web-room/v1/index/getDanmuInfo',
      params: { id: String(roomId), type: 0 },
      signed: true,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    const hosts = (Array.isArray(data.host_list) ? data.host_list : []).map((host) => ({
      host: String(host?.host || ''),
      wssPort: Number(host?.wss_port) || 443,
      wsPort: Number(host?.ws_port) || 2244
    })).filter((host) => host.host);
    if (!data.token || !hosts.length) {
      throw new BiliApiError('B 站直播没有返回弹幕服务器或 token', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: '直播弹幕服务不可用'
      });
    }
    return { token: String(data.token), hosts };
  }

  async sendDanmaku({ roomId, text } = {}) {
    this.api.requireLogin({ csrf: true });
    const init = await this.resolveRoom(roomId);
    const message = String(text ?? '').trim();
    if (!message) throw new BridgeError('弹幕内容为空', { kind: 'INPUT', code: 400, retcode: 1400, wording: '弹幕内容不能为空' });
    if (Array.from(message).length > 20) {
      throw new BridgeError('弹幕超过 B 站 20 字限制', {
        kind: 'INPUT', code: 400, retcode: 1400, wording: '直播弹幕不能超过 20 字'
      });
    }
    await this.api.request({
      method: 'POST',
      service: 'live',
      path: '/msg/send',
      form: {
        color: 16777215,
        fontsize: 25,
        mode: 1,
        msg: message,
        plat: 1,
        rnd: Math.floor(this.now() / 1000),
        roomid: init.roomId,
        bubble: 0,
        csrf: this.api.csrf(),
        csrf_token: this.api.csrf()
      },
      referer: `https://live.bilibili.com/${init.roomId}`,
      signed: false,
      allowedCodes: [0],
      retries: 0
    });
    return { ok: true, roomId: init.roomId, text: message };
  }

  createClient({
    roomId,
    canonicalRoomId = '',
    ownerMid = '',
    title = '',
    selfMid = '',
    selfName = '',
    filter = {},
    heartbeatIntervalMs = this.heartbeatIntervalMs,
    reconnectMinMs = this.reconnectMinMs,
    reconnectMaxMs = this.reconnectMaxMs,
    authTimeoutMs = this.authTimeoutMs
  } = {}) {
    const client = new LiveDanmakuClient({
      live: this,
      roomId,
      canonicalRoomId,
      ownerMid,
      title,
      selfMid,
      selfName,
      filter,
      heartbeatIntervalMs,
      reconnectMinMs,
      reconnectMaxMs,
      authTimeoutMs,
      wsProtocol: this.wsProtocol,
      WebSocketImpl: this.WebSocketImpl,
      now: this.now,
      logger: this.logger,
      maxDecompressedBytes: this.maxDecompressedBytes
    });
    this.clients.set(String(roomId), client);
    client.once('stop', () => this.clients.delete(String(roomId)));
    return client;
  }

  async stopAll() {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }

  snapshot() {
    return {
      clients: [...this.clients.values()].map((client) => client.stats())
    };
  }
}

export class LiveDanmakuClient extends EventEmitter {
  constructor({
    live,
    roomId,
    canonicalRoomId = '',
    ownerMid = '',
    title = '',
    selfMid = '',
    selfName = '',
    filter = {},
    heartbeatIntervalMs = 30_000,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 30_000,
    authTimeoutMs = 15_000,
    wsProtocol = 'wss',
    WebSocketImpl = WebSocket,
    now = Date.now,
    logger = null,
    maxDecompressedBytes = MAX_DECOMPRESSED_BYTES
  }) {
    super();
    if (!live) throw new TypeError('LiveDanmakuClient 需要 live service');
    this.live = live;
    this.roomId = String(roomId);
    this.canonicalRoomId = String(canonicalRoomId || roomId);
    this.ownerMid = String(ownerMid || '');
    this.title = title;
    this.selfMid = String(selfMid || '');
    this.selfName = String(selfName || '');
    this.filter = {
      danmaku: filter.danmaku || 'mentions',
      keywords: Array.isArray(filter.keywords) ? filter.keywords : [],
      gifts: filter.gifts !== false,
      superChat: filter.superChat !== false,
      guard: filter.guard !== false
    };
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.authTimeoutMs = authTimeoutMs;
    this.wsProtocol = wsProtocol === 'ws' ? 'ws' : 'wss';
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.logger = logger;
    this.maxDecompressedBytes = maxDecompressedBytes;
    this.socket = null;
    this.heartbeatTimer = null;
    this.authTimer = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.connected = false;
    this.authenticated = false;
    this.host = '';
    this.popularity = 0;
    this.failures = 0;
    this.reconnects = 0;
    this.events = 0;
    this.packets = 0;
    this.lastError = '';
    this.lastPacketAt = 0;
    this.startedAt = 0;
    this.generation = 0;
  }

  async start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.startedAt = this.now();
    this.#connect();
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.#clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, 'bridge stop'); } catch { /* ignore */ }
      try { socket.terminate?.(); } catch { /* ignore */ }
    }
    this.connected = false;
    this.authenticated = false;
    this.emit('stop');
  }

  #clearTimers() {
    for (const key of ['heartbeatTimer', 'authTimer', 'reconnectTimer']) {
      if (this[key]) {
        clearTimeout(this[key]);
        clearInterval(this[key]);
        this[key] = null;
      }
    }
  }

  #backoff() {
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.failures, 5));
    return base + Math.floor(Math.random() * Math.min(500, base / 4));
  }

  #scheduleReconnect(reason, immediate = false) {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.failures += 1;
    this.lastError = String(reason || 'live connection lost');
    const delay = immediate ? 0 : this.#backoff();
    this.logger?.warn?.('直播连接断开，准备重连', { roomId: this.roomId, delay, reason: this.lastError });
    this.emit('status', this.stats());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    (async () => {
      let info;
      try {
        info = await this.live.danmuInfo(this.canonicalRoomId);
      } catch (error) {
        this.logger?.warn?.('获取直播弹幕服务器失败', error);
        this.#scheduleReconnect(`danmu info: ${error?.message || error}`);
        return;
      }
      if (this.stopped || generation !== this.generation) return;
      const hosts = info.hosts;
      const host = hosts[this.reconnects % hosts.length];
      const port = this.wsProtocol === 'wss' ? host.wssPort : host.wsPort;
      const url = `${this.wsProtocol}://${host.host}:${port}/sub`;
      this.host = url;
      let socket;
      try {
        socket = new this.WebSocketImpl(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
          }
        });
      } catch (error) {
        this.#scheduleReconnect(`ws create: ${error?.message || error}`);
        return;
      }
      this.socket = socket;
      this.reconnects += 1;
      socket.on?.('open', () => {
        if (this.stopped || generation !== this.generation) return;
        this.connected = true;
        this.authenticated = false;
        const authBody = JSON.stringify({
          uid: /^\d+$/.test(this.selfMid) ? Number(this.selfMid) : 0,
          roomid: Number(this.canonicalRoomId),
          protover: 3,
          platform: 'web',
          type: 2,
          key: info.token,
          buvid: this.live.jar.get('buvid3') || ''
        });
        socket.send(buildPacket({ operation: OP_AUTH, body: authBody, version: 0 }));
        this.authTimer = setTimeout(() => {
          if (!this.authenticated && !this.stopped) {
            this.#drop(`auth timeout`);
          }
        }, this.authTimeoutMs);
        this.authTimer.unref?.();
        this.emit('status', this.stats());
      });
      socket.on?.('message', (data) => {
        if (this.stopped || generation !== this.generation) return;
        this.#onMessage(data);
      });
      socket.on?.('error', (error) => {
        if (this.stopped || generation !== this.generation) return;
        this.lastError = String(error?.message || error);
      });
      socket.on?.('close', (code) => {
        if (this.stopped || generation !== this.generation) return;
        this.connected = false;
        this.authenticated = false;
        this.#clearTimers();
        this.#scheduleReconnect(`close ${code}`);
      });
    })();
  }

  #drop(reason) {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.#clearTimers();
    try { socket?.close(4000, 'reconnect'); } catch { /* ignore */ }
    this.#scheduleReconnect(reason, true);
  }

  #onMessage(data) {
    let buffer;
    try {
      if (Buffer.isBuffer(data)) buffer = data;
      else if (Array.isArray(data)) buffer = Buffer.concat(data.map((item) => Buffer.from(item)));
      else buffer = Buffer.from(data);
    } catch (error) {
      this.lastError = `invalid ws payload: ${error?.message || error}`;
      return;
    }
    this.packets += 1;
    this.lastPacketAt = this.now();
    let packets;
    try {
      packets = parsePacketBuffer(buffer, { maxDecompressedBytes: this.maxDecompressedBytes });
    } catch (error) {
      this.lastError = String(error?.message || error);
      this.logger?.warn?.('直播包解析失败', error);
      this.#drop('packet parse error');
      return;
    }
    for (const packet of packets) {
      if (packet.operation === OP_AUTH_REPLY) {
        this.#onAuthReply(packet);
      } else if (packet.operation === OP_HEARTBEAT_REPLY) {
        if (packet.popularity != null) this.popularity = packet.popularity;
        this.emit('popularity', this.popularity);
      } else if (packet.operation === OP_NOTIFICATION) {
        this.#onNotification(packet);
      }
    }
  }

  #onAuthReply(packet) {
    let code = 0;
    try {
      const parsed = JSON.parse(packet.body.toString('utf8'));
      code = Number(parsed?.code) || 0;
    } catch { code = 0; }
    if (code !== 0) {
      this.lastError = `auth failed (${code})`;
      this.#drop('auth failed');
      return;
    }
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    this.authenticated = true;
    this.failures = 0;
    this.lastError = '';
    this.#startHeartbeat();
    this.emit('ready', this.stats());
    this.emit('status', this.stats());
  }

  #startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const send = () => {
      if (this.stopped || !this.authenticated || !this.socket) return;
      // 官方 web 客户端心跳体就是字符串 [object Object]；服务端不解析内容。
      const body = '[object Object]';
      try { this.socket.send(buildPacket({ operation: OP_HEARTBEAT, body, version: 0 })); } catch (error) {
        this.lastError = String(error?.message || error);
      }
    };
    this.heartbeatTimer = setInterval(send, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  #onNotification(packet) {
    let payload;
    try {
      payload = JSON.parse(packet.body.toString('utf8'));
    } catch {
      this.lastError = 'notification is not JSON';
      return;
    }
    const cmd = String(payload?.cmd || '');
    const event = normalizeLiveEvent(cmd, payload, {
      roomId: this.canonicalRoomId,
      selfMid: this.selfMid,
      selfName: this.selfName,
      now: this.now
    });
    if (!event) return;
    if (!this.#passesFilter(event)) return;
    this.events += 1;
    this.emit('event', event);
  }

  #passesFilter(event) {
    if (event.kind === 'danmaku') {
      if (this.filter.danmaku === 'off') return false;
      if (this.filter.danmaku === 'all') return true;
      if (event.atSelf) return true;
      const text = event.text.toLowerCase();
      return this.filter.keywords.some((keyword) => keyword && text.includes(String(keyword).toLowerCase()));
    }
    if (event.kind === 'gift') return this.filter.gifts;
    if (event.kind === 'super_chat') return this.filter.superChat;
    if (event.kind === 'guard') return this.filter.guard;
    return true;
  }

  stats() {
    return {
      roomId: this.roomId,
      canonicalRoomId: this.canonicalRoomId,
      title: this.title,
      connected: this.connected,
      authenticated: this.authenticated,
      host: this.host,
      popularity: this.popularity,
      reconnects: this.reconnects,
      failures: this.failures,
      events: this.events,
      packets: this.packets,
      lastPacketAt: this.lastPacketAt || null,
      lastError: this.lastError || null,
      startedAt: this.startedAt || null,
      filter: this.filter
    };
  }
}
