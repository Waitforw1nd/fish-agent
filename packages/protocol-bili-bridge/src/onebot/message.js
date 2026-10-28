import { BridgeError } from '../errors.js';

const CQ_ESCAPE = [
  ['&', '&amp;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  [',', '&#44;']
];

export function escapeCqText(text) {
  let value = String(text ?? '');
  for (const [char, encoded] of CQ_ESCAPE) value = value.split(char).join(encoded);
  return value;
}

export function unescapeCqText(text) {
  return String(text ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#93;/g, ']')
    .replace(/&#91;/g, '[')
    .replace(/&amp;/g, '&');
}

function parseCqAttributes(raw) {
  const data = {};
  for (const part of String(raw || '').split(',')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    data[part.slice(0, eq)] = unescapeCqText(part.slice(eq + 1));
  }
  return data;
}

export function parseCqString(text) {
  const value = String(text ?? '');
  if (!value.includes('[CQ:')) return [{ type: 'text', data: { text: value } }];
  const segments = [];
  const regex = /\[CQ:([A-Za-z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let match;
  while ((match = regex.exec(value))) {
    if (match.index > last) segments.push({ type: 'text', data: { text: unescapeCqText(value.slice(last, match.index)) } });
    segments.push({ type: match[1], data: parseCqAttributes(match[2]) });
    last = regex.lastIndex;
  }
  if (last < value.length) segments.push({ type: 'text', data: { text: unescapeCqText(value.slice(last)) } });
  return segments;
}

export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    if (message.length > 200) throw new BridgeError('消息段过多', { kind: 'INPUT', code: 400, retcode: 1400, wording: '消息段过多' });
    return message.map((segment) => {
      const type = String(segment?.type || '');
      if (!type) throw new BridgeError('消息段缺少 type', { kind: 'INPUT', code: 400, retcode: 1400 });
      return { type, data: { ...(segment?.data || {}) } };
    });
  }
  if (typeof message === 'string') return parseCqString(message);
  if (message == null) return [];
  throw new BridgeError('message 必须是字符串或消息段数组', { kind: 'INPUT', code: 400, retcode: 1400 });
}

export function segmentsToCq(segments) {
  return (segments || []).map((segment) => {
    if (segment.type === 'text') return escapeCqText(segment.data?.text ?? '');
    const attrs = Object.entries(segment.data || {})
      .map(([key, value]) => `${key}=${escapeCqText(value)}`)
      .join(',');
    return `[CQ:${segment.type}${attrs ? `,${attrs}` : ''}]`;
  }).join('');
}

export function textSegments(text) {
  const value = String(text ?? '');
  return value ? [{ type: 'text', data: { text: value } }] : [];
}

export function messagePreview(segments, limit = 120) {
  const parts = (segments || []).map((segment) => {
    if (segment.type === 'text') return String(segment.data?.text ?? '');
    if (segment.type === 'at') return `@${segment.data?.name || segment.data?.qq || ''}`;
    if (segment.type === 'image') return '[图片]';
    if (segment.type === 'face') return '[表情]';
    if (segment.type === 'reply') return '[引用]';
    return `[${segment.type}]`;
  });
  return Array.from(parts.join('')).slice(0, limit).join('');
}

/**
 * 出站消息段 → 各平台可发送的纯文本；私信图片由发送服务单独处理，
 * 遇到不支持的段直接失败，绝不静默丢弃。
 */
export function renderOutboundSegments(segments, {
  selfId = '',
  selfName = '',
  resolveUser = null,
  allowReply = true,
  allowAt = true
} = {}) {
  const ats = [];
  const parts = [];
  let replyMessageId = null;
  for (const segment of segments) {
    if (segment.type === 'text') {
      // 上游 QQ-agent 在 array 模式下仍调用 escapeCqText；出站到 B 站前要还原，
      // 否则含 & 或 [] 的正文会以实体形式发出去。
      parts.push(unescapeCqText(segment.data?.text ?? ''));
    } else if (segment.type === 'at' && allowAt) {
      const qq = String(segment.data?.qq ?? '');
      if (!/^\d+$/.test(qq)) {
        throw new BridgeError('@ 目标必须是数字 ID', { kind: 'INPUT', code: 400, retcode: 1400, wording: '@ 目标无效' });
      }
      let name = '';
      let mid = '';
      if (selfId && qq === String(selfId)) {
        name = selfName || String(segment.data?.name || '');
      } else if (resolveUser) {
        const record = resolveUser(qq);
        if (!record) {
          throw new BridgeError(`@ 的用户 ${qq} 不在 B 站映射中`, {
            kind: 'INPUT', code: 400, retcode: 1400,
            wording: `无法 @ 用户 ${qq}：该 ID 没有对应的 B 站账号`
          });
        }
        mid = String(record.native?.mid || '');
        name = String(record.name || '');
        const claimed = String(segment.data?.name || '');
        if (name && claimed && claimed !== name) {
          throw new BridgeError('@ 昵称与映射不一致', {
            kind: 'INPUT', code: 400, retcode: 1400,
            wording: `@ 昵称“${claimed}”与该用户的 B 站昵称“${name}”不一致`
          });
        }
        if (!name) name = claimed;
        if (!mid) {
          throw new BridgeError('@ 用户缺少 mid', { kind: 'INPUT', code: 400, retcode: 1400, wording: '@ 用户映射缺少 mid' });
        }
      } else {
        throw new BridgeError('当前通道不支持 @ 用户', { kind: 'INPUT', code: 400, retcode: 1400, wording: '当前 B 站通道不支持 @' });
      }
      if (!name) {
        throw new BridgeError('@ 用户缺少昵称', { kind: 'INPUT', code: 400, retcode: 1400, wording: '无法确定被 @ 用户的昵称' });
      }
      parts.push(`@${name} `);
      if (mid) ats.push({ mid, name });
      else if (selfId && qq === String(selfId)) ats.push({ mid: '', name, self: true });
    } else if (segment.type === 'reply' && allowReply) {
      const id = String(segment.data?.id ?? '');
      if (!/^-?[1-9]\d*$/.test(id)) {
        throw new BridgeError('引用消息 ID 无效', { kind: 'INPUT', code: 400, retcode: 1400, wording: '引用消息 ID 无效' });
      }
      replyMessageId = Number(id);
    } else if (segment.type === 'reply') {
      // 直播弹幕不支持引用：忽略该段但让桥接在返回值里记录 warning。
      continue;
    } else {
      const label = segment.type === 'image' ? '图片' : (segment.type === 'face' ? '表情' : segment.type);
      throw new BridgeError(`B 站通道不支持发送${label}`, {
        kind: 'UNSUPPORTED',
        code: 400,
        retcode: 1404,
        wording: `B 站${segment.type === 'image' ? '评论/弹幕' : '通道'}不支持发送${label}`
      });
    }
  }
  return { text: parts.join(''), ats, replyMessageId };
}

export function buildGroupEvent({
  selfId,
  groupId,
  userId,
  senderName = '',
  segments,
  messageId,
  time = Math.floor(Date.now() / 1000)
} = {}) {
  const gid = Number(groupId);
  const uid = Number(userId);
  if (!Number.isSafeInteger(gid) || !Number.isSafeInteger(uid)) {
    throw new BridgeError('OneBot 群事件 ID 必须是安全整数', { kind: 'PROTOCOL', code: 500, retcode: 1500 });
  }
  if (!Number.isSafeInteger(Number(messageId))) {
    throw new BridgeError('OneBot message_id 必须是安全整数', { kind: 'PROTOCOL', code: 500, retcode: 1500 });
  }
  return {
    time: Number(time) || Math.floor(Date.now() / 1000),
    self_id: Number(selfId),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: Number(messageId),
    group_id: gid,
    user_id: uid,
    message: segments,
    raw_message: segmentsToCq(segments),
    font: 0,
    sender: {
      user_id: uid,
      nickname: String(senderName || uid),
      card: String(senderName || ''),
      role: 'member'
    },
    message_format: 'array'
  };
}

export function buildPrivateEvent({
  selfId,
  userId,
  senderName = '',
  segments,
  messageId,
  time = Math.floor(Date.now() / 1000)
} = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid)) {
    throw new BridgeError('OneBot 私聊 ID 必须是安全整数', { kind: 'PROTOCOL', code: 500, retcode: 1500 });
  }
  if (!Number.isSafeInteger(Number(messageId))) {
    throw new BridgeError('OneBot message_id 必须是安全整数', { kind: 'PROTOCOL', code: 500, retcode: 1500 });
  }
  return {
    time: Number(time) || Math.floor(Date.now() / 1000),
    self_id: Number(selfId),
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Number(messageId),
    user_id: uid,
    message: segments,
    raw_message: segmentsToCq(segments),
    font: 0,
    sender: {
      user_id: uid,
      nickname: String(senderName || uid),
      card: '',
      role: 'member'
    },
    message_format: 'array'
  };
}

export function buildLifecycleEvent({ selfId, time = Math.floor(Date.now() / 1000) } = {}) {
  return {
    time,
    self_id: Number(selfId),
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: 'connect',
    interval: 5000
  };
}

export function buildHeartbeatEvent({ selfId, intervalMs = 30_000, status = true, time = Math.floor(Date.now() / 1000) } = {}) {
  return {
    time,
    self_id: Number(selfId),
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: Boolean(status), good: Boolean(status) },
    interval: Number(intervalMs)
  };
}

export function buildGetMsgPayload(record) {
  if (!record) return null;
  return {
    message_id: record.message_id,
    real_id: record.message_id,
    message_type: record.group_id != null ? 'group' : 'private',
    group_id: record.group_id ?? undefined,
    user_id: record.user_id ?? undefined,
    time: record.time,
    sender: { user_id: record.user_id ?? 0, nickname: '' },
    message: record.message,
    raw_message: record.raw_message,
    message_format: 'array'
  };
}
