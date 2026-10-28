import { compareSeqno } from '../bili/dm.js';
import { BridgeError } from '../errors.js';

const DV_BVID_RE = /BV[0-9A-Za-z]{10}/;

export function extractBvid(text) {
  const match = String(text || '').match(DV_BVID_RE);
  return match ? match[0] : '';
}

export function normalizeVideoWatch(entry) {
  if (!entry) return null;
  if (typeof entry === 'object') {
    const bvid = entry.bvid ? String(entry.bvid) : '';
    const aid = entry.aid != null ? String(entry.aid) : '';
    if (!bvid && !/^\d+$/.test(aid)) return null;
    return { bvid, aid, key: bvid || `av${aid}` };
  }
  const text = String(entry).trim();
  if (!text) return null;
  const bvid = extractBvid(text);
  if (bvid) return { bvid, aid: '', key: bvid };
  const av = text.match(/^av(\d+)$/i);
  if (av) return { bvid: '', aid: av[1], key: `av${av[1]}` };
  if (/^\d+$/.test(text)) return { bvid: '', aid: text, key: `av${text}` };
  return null;
}

/**
 * msgfeed @/回复 watcher：首次只建立基线，绝不把历史回复灌进 Agent；
 * 之后按 rpid 去重，只投递命中自己的回复。游标用于诊断与重启恢复。
 */
export class ReplyWatcher {
  constructor({
    msgfeed,
    mapper,
    pollState,
    dispatch,
    video = null,
    dynamic = null,
    getSelf = () => ({}),
    getSubscriptions = () => ({ at: true }),
    now = Date.now,
    logger = null,
    scope = 'msgfeed'
  }) {
    if (!msgfeed || !mapper || !pollState || !dispatch) throw new TypeError('ReplyWatcher 缺少依赖');
    this.msgfeed = msgfeed;
    this.mapper = mapper;
    this.pollState = pollState;
    this.dispatch = dispatch;
    this.video = video;
    this.dynamic = dynamic;
    this.getSelf = getSelf;
    this.getSubscriptions = getSubscriptions;
    this.now = now;
    this.logger = logger;
    this.scope = scope;
    this.lastError = '';
    this.lastPollAt = 0;
    this.lastEmitted = 0;
    this.lastUnread = null;
  }

  async poll() {
    const cursor = this.pollState.getCursor(this.scope, null);
    const initialized = Boolean(cursor?.initialized);
    const unread = await this.msgfeed.unread();
    this.lastUnread = unread;
    const subscriptions = this.getSubscriptions() || {};
    const self = this.getSelf() || {};

    if (initialized && subscriptions.at === false) {
      this.lastPollAt = this.now();
      return { initialized, skipped: true, reason: 'subscription_off' };
    }
    if (initialized && !cursor?.retryPending && (unread.total ?? (unread.at + unread.reply)) === 0) {
      this.lastPollAt = this.now();
      return { initialized, skipped: true, reason: 'unread_zero' };
    }

    const [replyResult, atResult] = await Promise.allSettled([
      this.msgfeed.replies(),
      typeof this.msgfeed.ats === 'function' ? this.msgfeed.ats() : Promise.resolve({ items: [], cursor: {} })
    ]);
    if (replyResult.status === 'rejected') throw replyResult.reason;
    if (atResult.status === 'rejected') {
      this.logger?.debug?.('msgfeed/at 拉取失败（不影响回复通知）', atResult.reason);
    }
    const replyItems = this.msgfeed.normalizeItems(replyResult.value.items, { selfMid: self.mid, selfName: self.name });
    const atItems = atResult.status === 'fulfilled'
      ? this.msgfeed.normalizeItems(atResult.value.items, { selfMid: self.mid, selfName: self.name })
        .map((item) => ({ ...item, atSelf: true }))
      : [];
    const byRpid = new Map();
    for (const item of [...replyItems, ...atItems]) {
      if (!byRpid.has(item.rpid)) byRpid.set(item.rpid, item);
    }
    const items = [...byRpid.values()].sort((a, b) => a.ctime - b.ctime);
    const limited = items.slice(-200);
    const fresh = initialized
      ? limited.map((item) => item.rpid).filter((id) => !this.pollState.hasSeen(this.scope, id))
      : await this.pollState.claimMany(this.scope, limited.map((item) => item.rpid));

    if (!initialized) {
      // 历史评论也占用全局 rpid，避免随后视频 watcher 把旧评论当新事件补发。
      await this.pollState.claimMany('comment-rpid', limited.map((item) => item.rpid));
      await this.pollState.setCursor(this.scope, {
        initialized: true,
        lastPollAt: this.now(),
        cursor: replyResult.value.cursor,
        atCursor: atResult.status === 'fulfilled' ? atResult.value.cursor : null,
        baselineCount: fresh.length
      });
      this.lastPollAt = this.now();
      return { initialized: false, baseline: fresh.length, emitted: 0 };
    }

    const freshSet = new Set(fresh);
    let emitted = 0;
    let firstError = null;
    for (const item of limited) {
      if (!freshSet.has(item.rpid)) continue;
      const dynamicId = String(item.uri || '').match(/(?:t\.bilibili\.com\/|\/opus\/|following\/detail\/)(\d+)/i)?.[1] || '';
      if (!item.isVideo && !dynamicId) continue;
      try {
        const delivered = await this.pollState.deliverOnce('comment-rpid', item.rpid, async () => {
          const bvid = extractBvid(item.uri);
          const existing = bvid ? this.mapper.resolveGroupByNative('video', { bvid }) : null;
          let aid = existing?.native?.aid || item.oid;
          let title = item.title || existing?.title || '';
          let cover = existing?.cover || '';
          let ownerMid = existing?.ownerMid || '';
          if (bvid && !existing?.native?.aid && this.video) {
            try {
              const detail = await this.video.view({ bvid });
              aid = detail.aid;
              title = detail.title || title;
              cover = detail.cover || '';
              ownerMid = detail.owner?.mid || '';
            } catch (error) {
              this.logger?.debug?.('msgfeed 回复解析视频详情失败，回退 subject_id', { bvid, error: error?.message });
            }
          }
          let group;
          if (dynamicId && !item.isVideo) {
            if (!this.dynamic) throw new Error('动态详情服务不可用');
            const detail = await this.dynamic.detail(dynamicId);
            group = await this.mapper.groupForDynamic({ dynamicId, title: detail.title || title, ownerMid: detail.ownerMid });
            group.commentSubject = { oid: detail.oid, type: detail.type };
          } else {
            group = await this.mapper.groupForVideo({ bvid, aid, title, cover, ownerMid });
          }
          await this.dispatch.comment({
            group,
            reply: {
              rpid: item.rpid,
              oid: item.oid,
              root: item.rootId || '0',
              parent: item.parentId || '0',
              mid: item.mid,
              uname: item.uname,
              message: item.message,
              ctime: item.ctime,
              like: item.like,
              members: item.members,
              atNameToMid: item.atNameToMid
            },
            atSelf: Boolean(item.atSelf),
            source: 'msgfeed',
            sourceContent: item.contextContent,
            title: item.title,
            uri: item.uri
          });
        });
        if (delivered) {
          await this.pollState.claim(this.scope, item.rpid);
          emitted += 1;
        }
      } catch (error) {
        if (!firstError) firstError = error;
        this.logger?.warn?.('投递 msgfeed 回复失败', error);
      }
    }
    this.lastEmitted += emitted;
    this.lastPollAt = this.now();
    this.lastError = firstError ? String(firstError?.wording || firstError?.message || firstError) : '';
    await this.pollState.setCursor(this.scope, {
      initialized: true,
      lastPollAt: this.lastPollAt,
      cursor: replyResult.value.cursor,
      atCursor: atResult.status === 'fulfilled' ? atResult.value.cursor : null,
      retryPending: Boolean(firstError),
      lastEmitted: emitted
    });
    if (firstError) throw firstError;
    return { initialized: true, baseline: 0, emitted };
  }

  status() {
    return {
      lastPollAt: this.lastPollAt || null,
      lastEmitted: this.lastEmitted,
      lastUnread: this.lastUnread,
      lastError: this.lastError || null,
      cursor: this.pollState.getCursor(this.scope, null)
    };
  }
}

/**
 * 已订阅视频的评论 watcher：每轮只拉最新一页，首次建立基线，之后按 rpid 去重投递。
 */
export class CommentWatcher {
  constructor({
    comment,
    video,
    mapper,
    pollState,
    dispatch,
    getWatches = () => ({ videos: [] }),
    getSelf = () => ({}),
    now = Date.now,
    logger = null,
    maxVideosPerPoll = 10,
    detailTtlMs = 10 * 60 * 1000
  }) {
    if (!comment || !mapper || !pollState || !dispatch) throw new TypeError('CommentWatcher 缺少依赖');
    this.comment = comment;
    this.video = video;
    this.mapper = mapper;
    this.pollState = pollState;
    this.dispatch = dispatch;
    this.getWatches = getWatches;
    this.getSelf = getSelf;
    this.now = now;
    this.logger = logger;
    this.maxVideosPerPoll = Math.max(1, Number(maxVideosPerPoll) || 10);
    this.detailTtlMs = detailTtlMs;
    this.details = new Map();
    this.turn = 0;
    this.lastPollAt = 0;
    this.lastEmitted = 0;
    this.lastError = '';
  }

  get #videos() {
    const watches = this.getWatches() || {};
    return (Array.isArray(watches.videos) ? watches.videos : []).map(normalizeVideoWatch).filter(Boolean);
  }

  async #detail(entry) {
    const key = entry.key;
    const cached = this.details.get(key);
    if (cached && this.now() - cached.at < this.detailTtlMs) return cached.detail;
    let detail = null;
    try {
      detail = await this.video.view({ bvid: entry.bvid || undefined, aid: entry.aid || undefined });
    } catch (error) {
      this.logger?.warn?.('读取视频详情失败（仍按 ID 映射群）', { key, error: error?.message });
    }
    this.details.set(key, { at: this.now(), detail });
    return detail;
  }

  async poll() {
    const videos = this.#videos;
    if (!videos.length) {
      this.lastPollAt = this.now();
      return { videos: 0, emitted: 0 };
    }
    const start = this.turn % videos.length;
    const selected = [];
    for (let i = 0; i < Math.min(this.maxVideosPerPoll, videos.length); i += 1) {
      selected.push(videos[(start + i) % videos.length]);
    }
    this.turn = (start + selected.length) % videos.length;
    const self = this.getSelf() || {};
    let emitted = 0;
    let failed = 0;
    let lastError = '';
    for (const entry of selected) {
      try {
        const detail = await this.#detail(entry);
        const group = await this.mapper.groupForVideo({
          bvid: detail?.bvid || entry.bvid,
          aid: detail?.aid || entry.aid,
          title: detail?.title || '',
          cover: detail?.cover || '',
          ownerMid: detail?.owner?.mid || ''
        });
        const cursorKey = `comment:${entry.key}`;
        const cursor = this.pollState.getCursor(cursorKey, null);
        const initialized = Boolean(cursor?.initialized);
        const result = await this.comment.list({
          oid: detail?.aid || entry.aid || undefined,
          bvid: detail?.bvid || entry.bvid || undefined,
          ps: 20,
          offset: ''
        });
        const replies = result.replies.slice().sort((a, b) => a.ctime - b.ctime);
        const fresh = initialized
          ? replies.map((reply) => reply.rpid).filter((id) => !this.pollState.hasSeen(`comment:${entry.key}`, id))
          : await this.pollState.claimMany(`comment:${entry.key}`, replies.map((reply) => reply.rpid));
        if (!initialized) {
          await this.pollState.claimMany('comment-rpid', replies.map((reply) => reply.rpid));
        } else {
          const freshSet = new Set(fresh);
          for (const reply of replies) {
            if (!freshSet.has(reply.rpid)) continue;
            if (String(reply.mid) === String(self.mid || '')) continue;
            const delivered = await this.pollState.deliverOnce('comment-rpid', reply.rpid, () => this.dispatch.comment({
              group,
              reply,
              atSelf: false,
              source: 'video',
              sourceContent: '',
              title: detail?.title || '',
              uri: detail?.bvid ? `https://www.bilibili.com/video/${detail.bvid}` : ''
            }));
            if (delivered) {
              await this.pollState.claim(`comment:${entry.key}`, reply.rpid);
              emitted += 1;
            }
          }
        }
        await this.pollState.setCursor(cursorKey, {
          initialized: true,
          lastPollAt: this.now(),
          lastRpid: replies[replies.length - 1]?.rpid || null,
          nextOffset: result.nextOffset,
          isEnd: result.isEnd,
          baselineCount: initialized ? 0 : fresh.length
        });
        this.lastEmitted += emitted;
      } catch (error) {
        failed += 1;
        lastError = String(error?.wording || error?.message || error);
        this.logger?.warn?.('评论 watcher 单个视频失败', { key: entry.key, error: lastError });
      }
    }
    this.lastPollAt = this.now();
    this.lastError = lastError;
    if (failed && failed === selected.length && emitted === 0) {
      throw new Error(lastError || '评论 watcher 全部失败');
    }
    return { videos: selected.length, emitted, failed };
  }

  status() {
    return {
      videos: this.#videos.length,
      lastPollAt: this.lastPollAt || null,
      lastEmitted: this.lastEmitted,
      lastError: this.lastError || null
    };
  }
}

/**
 * UP 主新视频 watcher：WBI 签名请求空间投稿，首次建立基线；新 BVID 映射成数字虚拟群。
 */
export class UpWatcher {
  constructor({
    api,
    mapper,
    pollState,
    dispatch,
    getWatches = () => ({ ups: [] }),
    getSubscriptions = () => ({ up: true }),
    now = Date.now,
    logger = null,
    maxUpsPerPoll = 5
  }) {
    if (!api || !mapper || !pollState || !dispatch) throw new TypeError('UpWatcher 缺少依赖');
    this.api = api;
    this.mapper = mapper;
    this.pollState = pollState;
    this.dispatch = dispatch;
    this.getWatches = getWatches;
    this.getSubscriptions = getSubscriptions;
    this.now = now;
    this.logger = logger;
    this.maxUpsPerPoll = Math.max(1, Number(maxUpsPerPoll) || 5);
    this.turn = 0;
    this.lastPollAt = 0;
    this.lastEmitted = 0;
    this.lastError = '';
  }

  async poll() {
    const ups = [...new Set((this.getWatches()?.ups || []).map(String).filter((mid) => /^\d+$/.test(mid)))];
    if (!ups.length) {
      this.lastPollAt = this.now();
      return { ups: 0, emitted: 0 };
    }
    const subscriptions = this.getSubscriptions() || {};
    const start = this.turn % ups.length;
    const selected = [];
    for (let i = 0; i < Math.min(this.maxUpsPerPoll, ups.length); i += 1) {
      selected.push(ups[(start + i) % ups.length]);
    }
    this.turn = (start + selected.length) % ups.length;
    let emitted = 0;
    let failed = 0;
    let lastError = '';
    for (const mid of selected) {
      try {
        const payload = await this.api.request({
          method: 'GET',
          service: 'api',
          path: '/x/space/wbi/arc/search',
          params: { mid, ps: 5, pn: 1, order: 'pubdate', index: 0, keyword: '' },
          signed: true,
          allowedCodes: [0],
          retries: 1
        });
        const list = payload?.data?.list?.vlist;
        if (!Array.isArray(list)) throw new BridgeError('UP 主投稿接口返回结构异常', { kind: 'PROTOCOL', code: 502, retcode: 1502 });
        const videos = list
          .map((item) => ({
            bvid: String(item?.bvid || ''),
            aid: String(item?.aid || ''),
            title: String(item?.title || ''),
            cover: String(item?.pic || ''),
            created: Number(item?.created) || 0,
            author: String(item?.author || ''),
            description: String(item?.description || '')
          }))
          .filter((item) => item.bvid)
          .sort((a, b) => a.created - b.created);
        const scope = `up:${mid}`;
        const cursorKey = `up:${mid}`;
        const cursor = this.pollState.getCursor(cursorKey, null);
        const initialized = Boolean(cursor?.initialized);
        const fresh = initialized
          ? videos.map((video) => video.bvid).filter((id) => !this.pollState.hasSeen(scope, id))
          : await this.pollState.claimMany(scope, videos.map((video) => video.bvid));
        if (initialized) {
          const freshSet = new Set(fresh);
          for (const video of videos) {
            if (!freshSet.has(video.bvid)) continue;
            if (subscriptions.up === false) continue;
            const group = await this.mapper.groupForVideo({
              bvid: video.bvid,
              aid: video.aid,
              title: video.title,
              cover: video.cover,
              ownerMid: mid
            });
            await this.dispatch.upVideo({
              group,
              video,
              up: { mid, name: video.author },
              source: 'up'
            });
            await this.pollState.claim(scope, video.bvid);
            emitted += 1;
          }
        }
        await this.pollState.setCursor(cursorKey, {
          initialized: true,
          lastPollAt: this.now(),
          lastBvid: videos[videos.length - 1]?.bvid || null,
          lastCreated: videos[videos.length - 1]?.created || 0,
          baselineCount: initialized ? 0 : fresh.length
        });
      } catch (error) {
        failed += 1;
        lastError = String(error?.wording || error?.message || error);
        this.logger?.warn?.('UP watcher 单个 UP 失败', { mid, error: lastError });
      }
    }
    this.lastPollAt = this.now();
    this.lastEmitted += emitted;
    this.lastError = lastError;
    if (failed && failed === selected.length && emitted === 0) {
      throw new Error(lastError || 'UP watcher 全部失败');
    }
    return { ups: selected.length, emitted, failed, ...(lastError ? { error: lastError } : {}) };
  }

  status() {
    return {
      ups: (this.getWatches()?.ups || []).length,
      lastPollAt: this.lastPollAt || null,
      lastEmitted: this.lastEmitted,
      lastError: this.lastError || null
    };
  }
}

/**
 * 私信 watcher：首次建立基线并清未读，之后按 msg_seqno 游标 + 去重投递；
 * 收到后 update_ack，避免重启后重复消费。
 */
export class DmWatcher {
  constructor({
    dm,
    pollState,
    dispatch,
    getSubscriptions = () => ({ dm: true }),
    getSelf = () => ({}),
    now = Date.now,
    logger = null,
    maxSessionsPerPoll = 20
  }) {
    if (!dm || !pollState || !dispatch) throw new TypeError('DmWatcher 缺少依赖');
    this.dm = dm;
    this.pollState = pollState;
    this.dispatch = dispatch;
    this.getSubscriptions = getSubscriptions;
    this.getSelf = getSelf;
    this.now = now;
    this.logger = logger;
    this.maxSessionsPerPoll = Math.max(1, Number(maxSessionsPerPoll) || 20);
    this.lastPollAt = 0;
    this.lastEmitted = 0;
    this.lastError = '';
    this.lastSessions = 0;
  }

  async poll() {
    if (this.getSubscriptions()?.dm === false) {
      this.lastPollAt = this.now();
      return { skipped: true, reason: 'subscription_off' };
    }
    const sessions = await this.dm.sessions();
    sessions.sort((a, b) => b.updateTime - a.updateTime);
    const selected = sessions.slice(0, this.maxSessionsPerPoll);
    let emitted = 0;
    let failed = 0;
    let lastError = '';
    for (const session of selected) {
      const talkerId = session.talkerId;
      const cursorKey = `dm:${talkerId}`;
      const cursor = this.pollState.getCursor(cursorKey, null);
      const initialized = Boolean(cursor?.initialized);
      try {
        if (initialized && cursor.lastSeqno && compareSeqno(session.maxSeqno, cursor.lastSeqno) <= 0 && session.unread === 0) {
          continue;
        }
        const result = await this.dm.messages({ talkerId, size: 20 });
        const messages = result.messages.slice().sort((a, b) => compareSeqno(a.seqno, b.seqno));
        const fresh = initialized
          ? messages.map((message) => message.seqno).filter((id) => !this.pollState.hasSeen(`dm:${talkerId}`, id))
          : await this.pollState.claimMany(`dm:${talkerId}`, messages.map((message) => message.seqno));
        const freshSet = new Set(fresh);
        if (initialized) {
          const profile = await this.dm.profile(talkerId);
          for (const message of messages) {
            if (!freshSet.has(message.seqno)) continue;
            if (message.self) continue;
            if (message.msgStatus === 1 || message.msgType === 5) continue;
            await this.dispatch.privateMessage({
              user: { mid: message.mid || talkerId, name: profile.name },
              message,
              session,
              source: 'dm'
            });
            await this.pollState.claim(`dm:${talkerId}`, message.seqno);
            emitted += 1;
          }
        }
        await this.pollState.setCursor(cursorKey, {
          initialized: true,
          lastSeqno: result.maxSeqno || session.maxSeqno || '',
          lastAck: result.maxSeqno || session.maxSeqno || '',
          lastPollAt: this.now(),
          baselineCount: initialized ? 0 : fresh.length
        });
        const ackSeqno = result.maxSeqno || session.maxSeqno;
        if (ackSeqno && compareSeqno(ackSeqno, cursor?.lastAck || '0') > 0) {
          try {
            await this.dm.ack({ talkerId, seqno: ackSeqno });
          } catch (error) {
            this.logger?.warn?.('私信 update_ack 失败', { talkerId, error: error?.message });
          }
        }
      } catch (error) {
        failed += 1;
        lastError = String(error?.wording || error?.message || error);
        this.logger?.warn?.('私信 watcher 单个会话失败', { talkerId, error: lastError });
      }
    }
    this.lastSessions = selected.length;
    this.lastPollAt = this.now();
    this.lastEmitted += emitted;
    this.lastError = lastError;
    if (failed && failed === selected.length && emitted === 0) {
      throw new Error(lastError || '私信 watcher 全部失败');
    }
    return { sessions: selected.length, emitted, failed };
  }

  status() {
    return {
      sessions: this.lastSessions,
      lastPollAt: this.lastPollAt || null,
      lastEmitted: this.lastEmitted,
      lastError: this.lastError || null
    };
  }
}
