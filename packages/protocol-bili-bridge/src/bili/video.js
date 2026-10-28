import { BiliApiError, BridgeError } from '../errors.js';
import { truncateChars } from '../util.js';

export function extractBvidFromText(text) {
  const match = String(text || '').match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : '';
}

const SHORT_LINK_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'www.bilibili.com', 'bilibili.com', 'm.bilibili.com']);

export function normalizeImageUrl(url, { forceHttps = true } = {}) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return forceHttps ? value.replace(/^http:\/\//i, 'https://') : value;
}

function normalizeSubtitleUrl(url, { forceHttps = true } = {}) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (forceHttps && value.startsWith('http://')) return `https://${value.slice('http://'.length)}`;
  return value;
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatSubtitleEntries(entries, maxChars = 6000) {
  const lines = [];
  for (const entry of entries || []) {
    const text = String(entry.content ?? entry.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`[${formatTimestamp(entry.from ?? entry.start)}] ${text}`);
  }
  return truncateChars(lines.join('\n'), maxChars);
}

export function normalizeSubtitleList(data, { forceHttps = true } = {}) {
  const raw = data?.subtitle?.subtitles;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const lan = String(item?.lan || '');
    return {
      id: String(item?.id ?? item?.id_str ?? ''),
      lan,
      label: String(item?.lan_doc || lan),
      isAi: /^ai-/i.test(lan) || Number(item?.type) === 1,
      url: normalizeSubtitleUrl(item?.subtitle_url, { forceHttps }),
      author: String(item?.author?.name || '')
    };
  }).filter((item) => item.url);
}

/**
 * 视频详情 / 分 P / 播放器字幕 / 封面。所有错误都带可读 wording；
 * “无字幕”“需登录”“地址过期”分别返回明确原因，不编造字幕内容。
 */
export class VideoService {
  constructor({ api, now = Date.now, logger = null, maxCoverBytes = 5 * 1024 * 1024, maxSubtitleBytes = 4 * 1024 * 1024, forceHttps = true }) {
    if (!api) throw new TypeError('VideoService 需要 api');
    this.api = api;
    this.now = now;
    this.logger = logger;
    this.maxCoverBytes = maxCoverBytes;
    this.maxSubtitleBytes = maxSubtitleBytes;
    this.forceHttps = forceHttps;
  }

  async resolveBvid(url) {
    let text = String(url || '').trim();
    if (text && !/^https?:\/\//i.test(text)) text = `https://${text}`;
    const direct = extractBvidFromText(text);
    if (direct) return direct;
    let parsed;
    try { parsed = new URL(text); } catch {
      throw new BridgeError('视频链接无效', { kind: 'INPUT', code: 400, retcode: 1400, wording: '视频链接无效，请提供 BV 号' });
    }
    if (!SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new BridgeError('不支持的视频链接域名', { kind: 'INPUT', code: 400, retcode: 1400, wording: '仅支持 b23.tv / bilibili.com 视频链接' });
    }
    const finalUrl = await this.api.resolveFinalUrl(parsed.toString());
    let finalHost = '';
    try { finalHost = new URL(finalUrl).hostname.toLowerCase(); } catch { /* ignore */ }
    if (finalHost && !SHORT_LINK_HOSTS.has(finalHost)) {
      throw new BridgeError('短链跳转到了非 B 站域名', { kind: 'INPUT', code: 400, retcode: 1400, wording: '短链跳转域名不受支持' });
    }
    const bvid = extractBvidFromText(finalUrl);
    if (!bvid) {
      throw new BridgeError('短链未指向视频', { kind: 'INPUT', code: 400, retcode: 1400, wording: '短链未解析出 BV 号，请提供 BV 号' });
    }
    return bvid;
  }

  async view({ bvid, aid } = {}) {
    if (!bvid && !aid) throw new BridgeError('需要 bvid 或 aid', { kind: 'INPUT', code: 400, retcode: 1400, wording: '缺少视频 ID' });
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/web-interface/view',
      params: bvid ? { bvid: String(bvid) } : { aid: String(aid) },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const data = payload?.data || {};
    if (!data.bvid || !data.aid) {
      throw new BiliApiError('B 站视频详情缺少 bvid/aid', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: '视频详情不可用'
      });
    }
    return {
      bvid: String(data.bvid),
      aid: String(data.aid),
      title: String(data.title || ''),
      desc: String(data.desc || ''),
      cover: normalizeImageUrl(data.pic, { forceHttps: this.forceHttps }),
      duration: Number(data.duration) || 0,
      pubdate: Number(data.pubdate) || 0,
      ctime: Number(data.ctime) || 0,
      videos: Number(data.videos) || 0,
      tname: String(data.tname || ''),
      owner: {
        mid: String(data.owner?.mid ?? ''),
        name: String(data.owner?.name || ''),
        face: normalizeImageUrl(data.owner?.face, { forceHttps: this.forceHttps })
      },
      pages: (Array.isArray(data.pages) ? data.pages : []).map((page) => ({
        cid: String(page?.cid ?? ''),
        page: Number(page?.page) || 0,
        part: String(page?.part || ''),
        duration: Number(page?.duration) || 0
      })),
      stat: {
        view: Number(data.stat?.view) || 0,
        danmaku: Number(data.stat?.danmaku) || 0,
        reply: Number(data.stat?.reply) || 0,
        like: Number(data.stat?.like) || 0,
        coin: Number(data.stat?.coin) || 0,
        favorite: Number(data.stat?.favorite) || 0,
        share: Number(data.stat?.share) || 0
      }
    };
  }

  async player({ bvid, aid, cid } = {}) {
    let resolvedCid = cid ? String(cid) : '';
    let resolvedAid = aid ? String(aid) : '';
    let resolvedBvid = bvid ? String(bvid) : '';
    if (!resolvedCid || !resolvedAid || !resolvedBvid) {
      const detail = await this.view({ bvid: resolvedBvid || undefined, aid: resolvedAid || undefined });
      resolvedCid = resolvedCid || detail.pages[0]?.cid || '';
      resolvedAid = detail.aid;
      resolvedBvid = detail.bvid;
      if (!resolvedCid) {
        throw new BiliApiError('视频没有可播放分 P', { kind: 'PROTOCOL', code: 404, retcode: 1404, wording: '视频没有可播放的分 P' });
      }
    }
    const params = { aid: resolvedAid, cid: resolvedCid };
    if (resolvedBvid) params.bvid = resolvedBvid;
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/player/wbi/v2',
      params,
      signed: true,
      allowedCodes: [0],
      retries: 1
    });
    return { data: payload?.data || {}, aid: resolvedAid, bvid: resolvedBvid, cid: resolvedCid };
  }

  async subtitles({ bvid, aid, cid } = {}) {
    let player;
    try {
      player = await this.player({ bvid, aid, cid });
    } catch (error) {
      if (error instanceof BiliApiError && error.kind === 'AUTH') {
        return {
          available: false,
          reason: 'LOGIN_REQUIRED',
          wording: '该视频字幕需要登录后查看',
          list: [],
          aid: aid ? String(aid) : '',
          cid: cid ? String(cid) : ''
        };
      }
      throw error;
    }
    const list = normalizeSubtitleList(player.data, { forceHttps: this.forceHttps });
    return {
      available: list.length > 0,
      reason: list.length ? null : 'NO_SUBTITLE',
      wording: list.length ? '' : '该视频没有可用字幕',
      list,
      aid: player.aid,
      bvid: player.bvid,
      cid: player.cid
    };
  }

  async downloadSubtitle(url) {
    const absolute = normalizeSubtitleUrl(url, { forceHttps: this.forceHttps });
    if (!absolute) {
      return { ok: false, reason: 'INVALID_URL', wording: '字幕地址为空' };
    }
    let result;
    try {
      result = await this.api.fetchBuffer({
        method: 'GET',
        path: absolute,
        service: 'api',
        referer: 'https://www.bilibili.com/',
        maxBytes: this.maxSubtitleBytes,
        retries: 1
      });
    } catch (error) {
      if (error instanceof BiliApiError && error.kind === 'EXPIRED') {
        return { ok: false, reason: 'EXPIRED', wording: '字幕地址已过期或需要登录，请重新获取' };
      }
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(result.data.toString('utf8'));
    } catch {
      return { ok: false, reason: 'INVALID', wording: '字幕内容不是有效的 JSON' };
    }
    const body = Array.isArray(payload?.body) ? payload.body : null;
    if (!body) {
      return { ok: false, reason: 'INVALID', wording: '字幕内容缺少 body 字段' };
    }
    const entries = body.slice(0, 20_000).map((item) => ({
      from: Number(item?.from) || 0,
      to: Number(item?.to) || 0,
      content: String(item?.content || '')
    })).filter((item) => item.content);
    return { ok: true, entries, text: formatSubtitleEntries(entries), count: entries.length };
  }

  async cover(url) {
    const absolute = normalizeImageUrl(url, { forceHttps: this.forceHttps });
    if (!absolute) throw new BridgeError('封面地址为空', { kind: 'INPUT', code: 400, retcode: 1400 });
    const result = await this.api.fetchBuffer({
      method: 'GET',
      path: absolute,
      service: 'api',
      referer: 'https://www.bilibili.com/',
      maxBytes: this.maxCoverBytes,
      retries: 1
    });
    if (!/^image\//i.test(result.contentType)) {
      throw new BiliApiError('封面返回的不是图片', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: 'B 站封面格式异常'
      });
    }
    return { data: result.data, contentType: result.contentType, url: absolute };
  }

  async inspectUser({ mid, includeVideos = false, includeDynamics = false } = {}) {
    if (!mid || !/^\d+$/.test(String(mid))) {
      throw new BridgeError('缺少有效的用户 mid', { kind: 'INPUT', code: 400, retcode: 1400, wording: '需要数字 mid' });
    }
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/web-interface/card',
      params: { mid: String(mid), photo: 'true' },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const card = payload?.data?.card || {};
    const result = {
      mid: String(card.mid ?? mid),
      name: String(card.name || ''),
      face: normalizeImageUrl(card.face, { forceHttps: this.forceHttps }),
      sign: String(card.sign || ''),
      fans: Number(payload?.data?.fans) || Number(card.fans) || 0,
      level: Number(card.level_info?.current_level) || 0,
      official: String(card.official_verify?.title || card.official_title || ''),
      archiveCount: Number(payload?.data?.archive_count) || 0
    };
    if (includeVideos) {
      try {
        const space = await this.api.request({
          method: 'GET',
          service: 'api',
          path: '/x/space/wbi/arc/search',
          params: { mid: String(mid), ps: 5, pn: 1, order: 'pubdate', index: 0, keyword: '', platform: 'web' },
          signed: true,
          allowedCodes: [0],
          retries: 1
        });
        const list = space?.data?.list?.vlist;
        result.videos = (Array.isArray(list) ? list : []).slice(0, 5).map((item) => ({
          bvid: String(item?.bvid || ''),
          aid: String(item?.aid || ''),
          title: String(item?.title || ''),
          cover: normalizeImageUrl(item?.pic, { forceHttps: this.forceHttps }),
          created: Number(item?.created) || 0,
          duration: String(item?.length || ''),
          play: Number(item?.play) || 0
        })).filter((item) => item.bvid);
      } catch (error) {
        result.videos = [];
        result.videosError = String(error?.wording || error?.message || error);
      }
    }
    if (includeDynamics) {
      try {
        const feed = await this.api.request({ method: 'GET', service: 'api', path: '/x/polymer/web-dynamic/v1/feed/space', params: { host_mid: String(mid) }, allowedCodes: [0], retries: 1 });
        if (!Array.isArray(feed?.data?.items)) throw new Error('动态接口返回结构异常');
        result.dynamics = feed.data.items.slice(0, 5).map((item) => ({ id: String(item.id_str || ''), text: truncateChars(item.modules?.module_dynamic?.desc?.text || '', 500), publishedAt: Number(item.modules?.module_author?.pub_ts) || 0, type: String(item.type || '') })).filter((item) => item.id);
        result.dynamicsStatus = result.dynamics.length ? 'available' : 'empty';
      } catch (error) {
        result.dynamics = [];
        result.dynamicsStatus = [-101, -403, 4101131].includes(Number(error?.apiCode)) ? 'restricted' : 'failed';
        result.dynamicsError = String(error?.wording || error?.message || error);
      }
    }
    return result;
  }

  async likeVideo({ bvid, aid, like = 1 } = {}) {
    this.api.requireLogin({ csrf: true });
    let resolvedAid = aid ? String(aid) : '';
    let resolvedBvid = bvid ? String(bvid) : '';
    if (!resolvedAid) {
      const detail = await this.view({ bvid: resolvedBvid });
      resolvedAid = detail.aid;
      resolvedBvid = detail.bvid;
    }
    const value = Number(like) === 0 ? 0 : 1;
    await this.api.request({
      method: 'POST',
      service: 'api',
      path: '/x/web-interface/archive/like',
      form: { aid: resolvedAid, like: value, csrf: this.api.csrf() },
      signed: false,
      allowedCodes: [0],
      retries: 0
    });
    return { ok: true, aid: resolvedAid, bvid: resolvedBvid, like: value };
  }

  /**
   * 给 Skill 的视频上下文：详情 + 分 P + 字幕列表，默认尝试下载一个 AI/中文字幕。
   * 返回结构化结果，字幕缺失/过期不抛错，保证模型能如实说明。
   */
  async context({ bvid, aid, cid, includeSubtitles = true, download = true, maxSubtitleChars = 6000 } = {}) {
    const detail = await this.view({ bvid, aid });
    let resolvedCid = cid ? String(cid) : (detail.pages[0]?.cid || '');
    let list = [];
    let subtitleError = null;
    if (includeSubtitles) {
      try {
        const player = await this.player({ bvid: detail.bvid, aid: detail.aid, cid: resolvedCid });
        resolvedCid = player.cid;
        list = normalizeSubtitleList(player.data, { forceHttps: this.forceHttps });
      } catch (error) {
        // 视频详情可匿名拿到；字幕播放器要求登录时仍应返回视频上下文，并明确原因。
        if (error instanceof BiliApiError && error.kind === 'AUTH') {
          subtitleError = { reason: 'LOGIN_REQUIRED', wording: '该视频字幕需要登录后查看' };
        } else {
          throw error;
        }
      }
    }
    const candidates = list.filter((item) => item.isAi);
    const chosen = candidates.find((item) => /^ai-zh/i.test(item.lan)) || candidates[0]
      || list.find((item) => /^zh/i.test(item.lan)) || list[0] || null;
    let subtitle = !includeSubtitles
      ? { available: null, reason: 'SKIPPED', list: [], downloaded: null }
      : subtitleError
        ? { available: false, reason: subtitleError.reason, wording: subtitleError.wording, list: [], downloaded: null }
        : { available: list.length > 0, reason: list.length ? null : 'NO_SUBTITLE', list, downloaded: null };
    if (includeSubtitles && download && chosen) {
      try {
        const downloaded = await this.downloadSubtitle(chosen.url);
        subtitle.downloaded = downloaded.ok
          ? {
            lan: chosen.lan,
            label: chosen.label,
            isAi: chosen.isAi,
            count: downloaded.count,
            text: truncateChars(downloaded.text, maxSubtitleChars)
          }
          : { lan: chosen.lan, label: chosen.label, error: downloaded.reason, wording: downloaded.wording };
      } catch (error) {
        subtitle.downloaded = { lan: chosen.lan, label: chosen.label, error: 'FETCH_FAILED', wording: String(error?.wording || error?.message || error) };
      }
    }
    return {
      ok: true,
      ...detail,
      cid: resolvedCid,
      subtitle,
      subtitleText: subtitle.downloaded?.text || ''
    };
  }
}
