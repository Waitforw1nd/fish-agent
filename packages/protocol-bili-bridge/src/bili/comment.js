import { BridgeError } from '../errors.js';
import { clone } from '../util.js';

export const COMMENT_TYPE_VIDEO = 1;

function normalizeMember(member) {
  return {
    mid: String(member?.mid ?? ''),
    uname: String(member?.uname || ''),
    avatar: String(member?.avatar || member?.face || '')
  };
}

export function normalizeReply(reply, { oid = '' } = {}) {
  const content = reply?.content || {};
  const members = Array.isArray(content.members)
    ? content.members.map(normalizeMember).filter((member) => member.mid)
    : [];
  let atNameToMid = {};
  if (content.at_name_to_mid && typeof content.at_name_to_mid === 'object') {
    atNameToMid = Object.fromEntries(Object.entries(content.at_name_to_mid).map(([name, mid]) => [String(name), String(mid)]));
  }
  return {
    rpid: String(reply?.rpid_str ?? reply?.rpid ?? ''),
    oid: String(reply?.oid ?? oid ?? ''),
    root: String(reply?.root ?? 0),
    parent: String(reply?.parent ?? 0),
    mid: String(reply?.member?.mid ?? reply?.mid ?? ''),
    uname: String(reply?.member?.uname || reply?.uname || ''),
    avatar: String(reply?.member?.avatar || ''),
    message: String(content.message ?? reply?.message ?? ''),
    ctime: Number(reply?.ctime) || 0,
    like: Number(reply?.like) || 0,
    rcount: Number(reply?.rcount) || 0,
    isUp: Boolean(reply?.reply_control?.is_up),
    members,
    atNameToMid
  };
}

/**
 * 计算评论回复的 root/parent：
 *  - 回复主楼：root=主楼 rpid, parent=主楼 rpid
 *  - 回复楼中楼：root=所在主楼, parent=被回复楼层
 *  - 直接发新评论：0/0
 */
export function commentRootParent(target) {
  if (!target) return { root: '0', parent: '0' };
  const rpid = String(target.rpid ?? '');
  if (!rpid) return { root: '0', parent: '0' };
  const root = String(target.root ?? '0');
  if (!root || root === '0') return { root: rpid, parent: rpid };
  return { root, parent: rpid };
}

export function classifyCommentError(error) {
  const code = Number(error?.apiCode ?? error?.code);
  if (code === -101) return { kind: 'LOGIN_REQUIRED', wording: 'B 站账号未登录或登录已失效', retryable: false };
  if (code === -102) return { kind: 'BANNED', wording: 'B 站账号被封停', retryable: false };
  if (code === -111) return { kind: 'CSRF', wording: 'CSRF 校验失败，请重新登录', retryable: false };
  if (code === -509) return { kind: 'RATE_LIMIT', wording: 'B 站请求过于频繁，请稍后再试', retryable: true };
  if (code === 12015) return { kind: 'CAPTCHA', wording: '评论需要验证码，请稍后重试或人工处理', retryable: false };
  if (code === 12016) return { kind: 'CONTENT_REJECTED', wording: '评论内容包含敏感信息，被 B 站拒绝', retryable: false };
  if (code === 12025) return { kind: 'CONTENT_TOO_LONG', wording: '评论字数过多', retryable: false };
  if (code === 12035) return { kind: 'FORBIDDEN', wording: '该账号被 UP 主列入评论黑名单', retryable: false };
  if (code === 12051) return { kind: 'DUPLICATE', wording: '重复评论，请勿刷屏', retryable: false };
  if (code === 12052 || code === 12002) return { kind: 'FORBIDDEN', wording: '评论区已关闭或无评论权限', retryable: false };
  if (code === 12003) return { kind: 'FORBIDDEN', wording: '禁止回复该评论', retryable: false };
  if (code === 12006) return { kind: 'NOT_FOUND', wording: '没有该评论', retryable: false };
  if (code === 12009) return { kind: 'INVALID_SUBJECT', wording: '评论主体 type 不合法', retryable: false };
  if (code === 12019) return { kind: 'RATE_LIMIT', wording: '举报或操作过于频繁', retryable: true };
  if (code === -352 || code === -412) return { kind: 'RISK', wording: 'B 站触发风控，需要完成人机验证', retryable: false };
  return { kind: 'API', wording: String(error?.wording || error?.message || 'B 站评论操作失败'), retryable: Boolean(error?.retryable) };
}

function withClassification(error) {
  const info = classifyCommentError(error);
  if (error && typeof error === 'object') {
    error.classification = info.kind;
    error.wording = error.wording || info.wording;
  }
  return error;
}

export class CommentService {
  constructor({ api, video = null, now = Date.now, logger = null, maxChars = 1000 }) {
    if (!api) throw new TypeError('CommentService 需要 api');
    this.api = api;
    this.video = video;
    this.now = now;
    this.logger = logger;
    this.maxChars = maxChars;
  }

  async #resolveAid({ oid, bvid, aid }) {
    if (oid) return String(oid);
    if (aid) return String(aid);
    if (bvid) {
      if (!this.video) throw new BridgeError('需要视频服务来解析 bvid', { kind: 'CONFIG', code: 500, retcode: 1500 });
      const detail = await this.video.view({ bvid });
      return detail.aid;
    }
    throw new BridgeError('缺少视频 oid/bvid/aid', { kind: 'INPUT', code: 400, retcode: 1400, wording: '缺少视频 ID' });
  }

  async list({ oid, bvid, aid, ps = 20, offset = '', order = 'time' } = {}) {
    const resolvedOid = await this.#resolveAid({ oid, bvid, aid });
    const params = {
      oid: resolvedOid,
      type: COMMENT_TYPE_VIDEO,
      mode: order === 'hot' ? 3 : 2,
      pagination_str: JSON.stringify({ offset: String(offset || '') }),
      plat: 1,
      web_location: 1315875
    };
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/v2/reply/wbi/main',
      params,
      signed: true,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    const seen = new Set();
    const replies = [];
    const collect = (items, parent = null) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const normalized = normalizeReply(item, { oid: resolvedOid });
        if (!normalized.rpid) continue;
        if (parent) {
          const parentRoot = String(parent.root ?? '0');
          normalized.root = parentRoot === '0' ? String(parent.rpid) : parentRoot;
          normalized.parent = String(parent.rpid);
        } else if (normalized.root === '0') {
          normalized.root = normalized.rpid;
          normalized.parent = normalized.rpid;
        }
        if (!seen.has(normalized.rpid)) {
          seen.add(normalized.rpid);
          replies.push(normalized);
        }
        // 主楼可能带楼中楼预览；继续展开一层，root/parent 以真实父级为准。
        collect(item?.replies, normalized);
      }
    };
    collect(data.top_replies);
    collect(data.replies);
    const cursor = data.cursor || {};
    const nextOffset = cursor.pagination_reply?.next_offset
      ?? (cursor.next != null ? String(cursor.next) : null);
    const isEnd = cursor.is_end !== undefined ? Boolean(cursor.is_end) : !nextOffset;
    return {
      oid: resolvedOid,
      replies,
      nextOffset: nextOffset || null,
      isEnd,
      cursor: clone(cursor)
    };
  }

  async add({ oid, bvid, aid, type = COMMENT_TYPE_VIDEO, message, root = '0', parent = '0' } = {}) {
    this.api.requireLogin({ csrf: true });
    if (![1, 11, 17].includes(Number(type))) throw new BridgeError('不支持的评论业务类型', { kind: 'INPUT', code: 400 });
    const resolvedOid = await this.#resolveAid({ oid, bvid, aid });
    if (!/^\d+$/.test(resolvedOid)) throw new BridgeError('评论 OID 无效', { kind: 'INPUT', code: 400 });
    const text = String(message ?? '').trim();
    if (!text) throw new BridgeError('评论内容为空', { kind: 'INPUT', code: 400, retcode: 1400, wording: '评论内容不能为空' });
    if (Array.from(text).length > this.maxChars) {
      throw new BridgeError('评论内容超过 B 站长度限制', {
        kind: 'INPUT', code: 400, retcode: 1400, wording: `评论不能超过 ${this.maxChars} 字`
      });
    }
    if (!/^\d+$/.test(String(root)) || !/^\d+$/.test(String(parent))) {
      throw new BridgeError('root/parent 必须是数字 rpid', { kind: 'INPUT', code: 400, retcode: 1400 });
    }
    const form = {
      oid: resolvedOid,
      type: Number(type),
      message: text,
      root: String(root),
      parent: String(parent),
      plat: 1,
      csrf: this.api.csrf()
    };
    try {
      const payload = await this.api.request({
        method: 'POST',
        service: 'api',
        path: '/x/v2/reply/add',
        form,
        signed: false,
        allowedCodes: [0],
        retries: 0
      });
      const data = payload?.data || {};
      const rpid = String(data.rpid_str ?? data.rpid ?? data.reply?.rpid_str ?? data.reply?.rpid ?? '');
      return { oid: resolvedOid, rpid, root: String(root), parent: String(parent), success: true };
    } catch (error) {
      throw withClassification(error);
    }
  }

  async like({ oid, bvid, aid, rpid, action = 1 } = {}) {
    this.api.requireLogin({ csrf: true });
    const resolvedOid = await this.#resolveAid({ oid, bvid, aid });
    const target = String(rpid ?? '');
    if (!/^\d+$/.test(target)) {
      throw new BridgeError('缺少有效的评论 rpid', { kind: 'INPUT', code: 400, retcode: 1400 });
    }
    const normalizedAction = Number(action) === 0 ? 0 : 1;
    try {
      await this.api.request({
        method: 'POST',
        service: 'api',
        path: '/x/v2/reply/action',
        form: {
          oid: resolvedOid,
          type: COMMENT_TYPE_VIDEO,
          rpid: target,
          action: normalizedAction,
          csrf: this.api.csrf()
        },
        signed: false,
        allowedCodes: [0],
        retries: 0
      });
      return { oid: resolvedOid, rpid: target, action: normalizedAction, success: true };
    } catch (error) {
      throw withClassification(error);
    }
  }
}
