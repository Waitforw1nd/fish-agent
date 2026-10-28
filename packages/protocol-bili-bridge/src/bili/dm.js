import crypto from 'node:crypto';
import { BridgeError } from '../errors.js';
import { byteLength } from '../util.js';

export const DM_TEXT_LIMIT_BYTES = 2000;

export function compareSeqno(a, b) {
  const left = BigInt(String(a || '0'));
  const right = BigInt(String(b || '0'));
  return left === right ? 0 : (left > right ? 1 : -1);
}

export function parseDmContent(content) {
  let data = content;
  if (typeof content === 'string') {
    try { data = JSON.parse(content); } catch { return { text: content, imageUrl: '', contentType: 'text' }; }
  }
  if (!data || typeof data !== 'object') return { text: String(data ?? ''), imageUrl: '', contentType: 'text' };
  if (typeof data.content === 'string') return { text: data.content, imageUrl: '', contentType: 'text' };
  if (typeof data.url === 'string') return { text: '[图片]', imageUrl: data.url, contentType: 'image' };
  if (typeof data.title === 'string') return { text: data.title, imageUrl: '', contentType: 'card' };
  return { text: JSON.stringify(data).slice(0, 500), imageUrl: '', contentType: 'unknown' };
}

export function normalizeDmMessage(message, { selfUid = '' } = {}) {
  const parsed = parseDmContent(message?.content);
  const msgType = Number(message?.msg_type) || 1;
  return {
    seqno: String(message?.msg_seqno ?? ''),
    msgKeyPresent: Boolean(message?.msg_key),
    mid: String(message?.sender_uid ?? message?.sender_id ?? ''),
    receiverId: String(message?.receiver_id ?? ''),
    self: String(message?.sender_uid ?? '') === String(selfUid || ''),
    timestamp: Number(message?.timestamp) || 0,
    msgType,
    msgStatus: Number(message?.msg_status) || 0,
    text: parsed.text,
    imageUrl: parsed.imageUrl,
    contentType: parsed.contentType
  };
}

export class DmService {
  constructor({ api, jar, selfUid = '', now = Date.now, logger = null, textLimitBytes = DM_TEXT_LIMIT_BYTES }) {
    if (!api || !jar) throw new TypeError('DmService 需要 api 和 jar');
    this.api = api;
    this.jar = jar;
    this.selfUid = String(selfUid || '');
    this.now = now;
    this.logger = logger;
    this.textLimitBytes = textLimitBytes;
    this.nameCache = new Map();
  }

  get uid() {
    return String(this.selfUid || this.jar.get('DedeUserID') || '');
  }

  async sessions() {
    this.api.requireLogin();
    const payload = await this.api.request({
      method: 'GET',
      service: 'vc',
      path: '/session_svr/v1/session_svr/get_sessions',
      params: { session_type: 1, group_id: 0, build: 0, mobi_app: 'web' },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const list = payload?.data?.session_list;
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
      talkerId: String(item?.talker_id ?? ''),
      sessionType: Number(item?.session_type) || 1,
      ackSeqno: String(item?.ack_seqno ?? ''),
      maxSeqno: String(item?.max_seqno ?? ''),
      unread: Number(item?.unread_count) || 0,
      updateTime: Number(item?.session_ts ?? item?.update_time) || 0,
      systemMsgType: Number(item?.system_msg_type) || 0,
      accountName: String(item?.account_info?.name || ''),
      lastMsg: item?.last_msg ? normalizeDmMessage(item.last_msg, { selfUid: this.uid }) : null
    })).filter((item) => item.talkerId && item.systemMsgType === 0);
  }

  async messages({ talkerId, size = 20, beginSeqno = '', endSeqno = '' } = {}) {
    this.api.requireLogin();
    if (!talkerId) throw new BridgeError('缺少私信会话 talker_id', { kind: 'INPUT', code: 400, retcode: 1400 });
    const params = {
      talker_id: String(talkerId),
      session_type: 1,
      size: Math.min(100, Math.max(1, Number(size) || 20)),
      build: 0,
      mobi_app: 'web'
    };
    if (beginSeqno) params.begin_seqno = String(beginSeqno);
    if (endSeqno) params.end_seqno = String(endSeqno);
    const payload = await this.api.request({
      method: 'GET',
      service: 'vc',
      path: '/svr_sync/v1/svr_sync/fetch_session_msgs',
      params,
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const raw = payload?.data?.messages;
    const messages = (Array.isArray(raw) ? raw : [])
      .map((item) => normalizeDmMessage(item, { selfUid: this.uid }))
      .filter((item) => item.seqno)
      .sort((a, b) => compareSeqno(a.seqno, b.seqno));
    const data = payload?.data || {};
    const maxSeqno = String(data.max_seqno ?? (messages.length ? messages[messages.length - 1].seqno : ''));
    return {
      talkerId: String(talkerId),
      messages,
      maxSeqno,
      minSeqno: String(data.min_seqno ?? (messages.length ? messages[0].seqno : '')),
      hasMore: Boolean(data.has_more)
    };
  }

  async ack({ talkerId, seqno } = {}) {
    this.api.requireLogin({ csrf: true });
    if (!talkerId || !seqno) throw new BridgeError('缺少私信 ack 参数', { kind: 'INPUT', code: 400, retcode: 1400 });
    const payload = await this.api.request({
      method: 'POST',
      service: 'vc',
      path: '/session_svr/v1/session_svr/update_ack',
      form: {
        talker_id: String(talkerId),
        session_type: 1,
        ack_seqno: String(seqno),
        csrf: this.api.csrf(),
        csrf_token: this.api.csrf()
      },
      referer: 'https://message.bilibili.com/',
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    return { ok: true, ackSeqno: String(seqno), data: payload?.data ?? null };
  }

  validateText(text) {
    const value = String(text ?? '');
    if (!value.trim()) {
      throw new BridgeError('私信内容为空', { kind: 'INPUT', code: 400, retcode: 1400, wording: '私信内容不能为空' });
    }
    const bytes = byteLength(value);
    if (bytes > this.textLimitBytes) {
      throw new BridgeError(`私信超过 B 站 ${this.textLimitBytes} 字节限制`, {
        kind: 'INPUT',
        code: 400,
        retcode: 1400,
        wording: `私信超过 ${this.textLimitBytes} 字节限制（当前 ${bytes} 字节），请缩短后再发`
      });
    }
    return value;
  }

  async uploadImage(file) {
    this.api.requireLogin({ csrf: true });
    const match = /^(?:base64:\/\/|data:image\/(?:png|jpeg|gif);base64,)([A-Za-z0-9+/]+={0,2})$/i.exec(String(file || ''));
    if (!match || match[1].length > 7_000_000) throw new BridgeError('图片须为不超过 5 MiB 的 base64:// 数据', { kind: 'INPUT', code: 400, retcode: 1400 });
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== match[1]) throw new BridgeError('图片数据无效或过大', { kind: 'INPUT', code: 400, retcode: 1400 });
    const type = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
      : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpeg'
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'gif' : '';
    if (!type) throw new BridgeError('仅支持 PNG、JPEG 或 GIF 图片', { kind: 'INPUT', code: 400, retcode: 1400 });
    const multipart = new FormData();
    multipart.set('file_up', new Blob([bytes], { type: `image/${type}` }), `image.${type === 'jpeg' ? 'jpg' : type}`);
    multipart.set('category', 'daily');
    multipart.set('csrf', this.api.csrf());
    const payload = await this.api.request({ method: 'POST', service: 'api', path: '/x/dynamic/feed/draw/upload_bfs', multipart, allowedCodes: [0], retries: 0 });
    const data = payload?.data || {};
    let url;
    try { url = new URL(data.image_url); } catch { throw new BridgeError('图片上传响应缺少地址', { kind: 'PROTOCOL', code: 502 }); }
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)(hdslb\.com|biliimg\.com)$/.test(url.hostname)) throw new BridgeError('图片上传返回了无效地址', { kind: 'PROTOCOL', code: 502 });
    return { url: url.toString(), width: Number(data.image_width) || 0, height: Number(data.image_height) || 0, imageType: type, size: bytes.length / 1024, original: 1 };
  }

  async send({ receiverId, text, image = null } = {}) {
    this.api.requireLogin({ csrf: true });
    if (!/^\d+$/.test(String(receiverId || ''))) {
      throw new BridgeError('缺少有效的私信接收者 mid', { kind: 'INPUT', code: 400, retcode: 1400 });
    }
    const message = image ? image : { content: this.validateText(text) };
    const timestamp = Math.floor(this.now() / 1000);
    const devId = crypto.randomUUID();
    const payload = await this.api.request({
      method: 'POST',
      service: 'vc',
      path: '/web_im/v1/web_im/send_msg',
      params: {
        w_sender_uid: this.uid,
        w_receiver_id: String(receiverId),
        w_dev_id: devId
      },
      form: {
        'msg[sender_uid]': this.uid,
        'msg[receiver_id]': String(receiverId),
        'msg[receiver_type]': 1,
        'msg[msg_type]': image ? 2 : 1,
        'msg[msg_status]': 0,
        'msg[dev_id]': devId,
        'msg[timestamp]': timestamp,
        'msg[new_face_version]': 1,
        'msg[content]': JSON.stringify(message),
        build: 0,
        mobi_app: 'web',
        csrf: this.api.csrf(),
        csrf_token: this.api.csrf()
      },
      referer: 'https://message.bilibili.com/',
      signed: true,
      allowedCodes: [0],
      retries: 0
    });
    const data = payload?.data || {};
    return {
      sent: true,
      receiverId: String(receiverId),
      seqno: data.msg_seqno != null ? String(data.msg_seqno) : '',
      hasMsgKey: Boolean(data.msg_key),
      timestamp
    };
  }

  async profile(talkerId) {
    const id = String(talkerId || '');
    if (!id) return { mid: id, name: '' };
    if (this.nameCache.has(id)) return this.nameCache.get(id);
    const record = { mid: id, name: '' };
    try {
      const payload = await this.api.request({
        method: 'GET',
        service: 'api',
        path: '/x/web-interface/card',
        params: { mid: id, photo: 'false' },
        signed: false,
        allowedCodes: [0],
        retries: 1
      });
      record.name = String(payload?.data?.card?.name || '');
    } catch (error) {
      this.logger?.debug?.('读取私信用户资料失败', { mid: id, error: error?.message });
    }
    this.nameCache.set(id, record);
    if (this.nameCache.size > 500) {
      const first = this.nameCache.keys().next().value;
      this.nameCache.delete(first);
    }
    return record;
  }

  snapshot() {
    return {
      selfUid: this.uid || null,
      textLimitBytes: this.textLimitBytes,
      cachedProfiles: this.nameCache.size
    };
  }
}
