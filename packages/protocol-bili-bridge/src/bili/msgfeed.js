export function normalizeMsgfeedReply(item, { fallbackIndex = 0 } = {}) {
  // 真实 /x/msgfeed/reply：一条通知一个 item，回复者/详情分别在 user、item 两个对象里。
  const user = item?.user || {};
  const detail = item?.item || {};
  const atDetails = Array.isArray(detail.at_details) ? detail.at_details : [];
  const members = atDetails.map((member) => ({
    mid: String(member?.mid ?? ''),
    uname: String(member?.nickname || member?.uname || '')
  })).filter((member) => member.mid);
  const atNameToMid = Object.fromEntries(members.map((member) => [member.uname, member.mid]).filter(([name]) => name));
  const rpid = String(detail.source_id ?? detail.target_id ?? item?.id ?? '');
  return [{
    feedId: String(item?.id ?? `${fallbackIndex}`),
    businessId: String(detail.business_id ?? ''),
    business: String(detail.business || ''),
    type: String(detail.type || 'reply'),
    oid: String(detail.subject_id ?? ''),
    title: String(detail.title || ''),
    uri: String(detail.uri || detail.native_uri || ''),
    sourceContent: String(detail.source_content ?? ''),
    targetContent: String(detail.target_reply_content ?? ''),
    rootContent: String(detail.root_reply_content ?? ''),
    contextContent: String(detail.target_reply_content || detail.root_reply_content || ''),
    replyIndex: 0,
    rpid,
    rootId: String(detail.root_id ?? '0'),
    parentId: String(detail.target_id ?? '0'),
    mid: String(user.mid ?? ''),
    uname: String(user.nickname || ''),
    message: String(detail.source_content ?? detail.message ?? ''),
    ctime: Number(item?.reply_time) || 0,
    like: 0,
    members,
    atNameToMid,
    isVideo: /\/video\//i.test(String(detail.uri || '')) || String(detail.business_id ?? '') === '1'
  }].filter((reply) => reply.rpid);
}

export function replyIsAtSelf(reply, { selfMid = '', selfName = '' } = {}) {
  const mid = String(selfMid || '');
  const name = String(selfName || '');
  if (mid && reply.members.some((member) => member.mid === mid)) return true;
  if (mid && Object.values(reply.atNameToMid).some((value) => String(value) === mid)) return true;
  const text = String(reply.message || '');
  if (name && text.includes(`@${name}`)) return true;
  return false;
}

export class MsgfeedService {
  constructor({ api, now = Date.now, logger = null }) {
    if (!api) throw new TypeError('MsgfeedService 需要 api');
    this.api = api;
    this.now = now;
    this.logger = logger;
  }

  async unread() {
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/msgfeed/unread',
      params: { build: 0, mobi_app: 'web', platform: 'web' },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    const reply = Number(data.reply) || 0;
    const at = Number(data.at) || 0;
    const recvReply = Number(data.recv_reply);
    return {
      reply,
      at,
      like: Number(data.like) || Number(data.recv_like) || 0,
      sysMsg: Number(data.sys_msg) || 0,
      // 新接口把 reply+at 合成 recv_reply；任一字段非零都应触发拉取。
      total: Number.isFinite(recvReply) ? Math.max(recvReply, reply + at) : reply + at
    };
  }

  async #feed(path, { cursorId = '', cursorTime = '', timeKey = 'reply_time' } = {}) {
    const params = { build: 0, mobi_app: 'web', platform: 'web' };
    if (cursorId) params.id = String(cursorId);
    if (cursorTime) params[timeKey] = String(cursorTime);
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path,
      params,
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    const cursor = data.cursor || {};
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      items,
      cursor: {
        id: cursor.id != null ? String(cursor.id) : '',
        time: cursor.time != null ? String(cursor.time) : '',
        isEnd: Boolean(cursor.is_end)
      },
      total: Number(data.total) || items.length
    };
  }

  async replies({ cursorId = '', cursorTime = '' } = {}) {
    return this.#feed('/x/msgfeed/reply', { cursorId, cursorTime, timeKey: 'reply_time' });
  }

  async ats({ cursorId = '', cursorTime = '' } = {}) {
    return this.#feed('/x/msgfeed/at', { cursorId, cursorTime, timeKey: 'at_time' });
  }

  normalizeItems(items, { selfMid = '', selfName = '' } = {}) {
    const out = [];
    items.forEach((item, index) => {
      const replies = normalizeMsgfeedReply(item, { fallbackIndex: index });
      for (const reply of replies) {
        out.push({
          ...reply,
          atSelf: replyIsAtSelf(reply, { selfMid, selfName })
        });
      }
    });
    return out;
  }
}
