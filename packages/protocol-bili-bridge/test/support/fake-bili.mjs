import http from 'node:http';
import crypto from 'node:crypto';
import { signWbi } from '../../src/bili/wbi.js';

const WBI_IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const WBI_SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonBody(text, contentType) {
  if (!text) return {};
  if (String(contentType || '').includes('application/json')) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function bigRpid(counter) {
  return String(1_890_000_000_000_000_000n + BigInt(counter));
}

/**
 * fake B 站：所有基址都是本机随机端口，HTTP 行为按真实响应结构实现，
 * 并会实际校验 WBI 签名、CSRF、cookie 刷新四步与 RSA correspondPath。
 */
export class FakeBili {
  constructor({ wsPort = 0 } = {}) {
    this.wsPort = wsPort;
    this.server = null;
    this.port = 0;
    this.requests = [];
    this.wbiKeys = { imgKey: WBI_IMG_KEY, subKey: WBI_SUB_KEY };
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    this.publicKey = publicKey.export({ type: 'spki', format: 'pem' });
    this.privateKey = privateKey;
    this.loggedIn = false;
    this.session = {
      sessdata: 'sess-initial',
      jct: 'jct-initial',
      mid: '10086',
      uname: '测试UP主',
      ckMd5: 'ckmd5-initial',
      sid: 'sid-initial',
      refreshToken: 'refresh-initial'
    };
    this.account = { mid: '10086', uname: '测试UP主', face: '/face.jpg' };
    this.qrStatuses = ['pending', 'scanned', 'success'];
    this.qrIndex = 0;
    this.qrKey = 'qr-key-1';
    this.refreshNeeded = true;
    this.refreshTimestamp = 1_700_000_000_000;
    this.refreshCsrf = 'refresh-csrf-abc';
    this.refreshIteration = 0;
    this.confirmCount = 0;
    this.refreshCalls = 0;
    this.lastCorrespondPath = '';
    this.riskMode = false;
    this.commentCounter = 0;
    this.msgfeedCounter = 0;
    this.dmSeqCounter = 1_780_000_000_000_000_000n;
    this.dmSessions = new Map();
    this.dmMessages = new Map();
    this.dmSends = [];
    this.videos = new Map();
    this.videosByAid = new Map();
    this.videoComments = new Map();
    this.msgfeedItems = [];
    this.msgfeedAtItems = [];
    this.msgfeedUnread = { reply: 0, at: 0, like: 0, sysMsg: 0 };
    this.upVideos = new Map();
    this.liveRooms = new Map();
    this.liveSent = [];
    this.videoLikes = [];
    this.commentActions = [];
    this.userCards = new Map();
    this.subtitles = new Map();
    this.failures = [];
    this.coverBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    this.setDefaults();
  }

  setDefaults() {
    this.addVideo({
      bvid: 'BV1xx411c7mD',
      aid: 170001,
      title: '测试视频标题',
      desc: '测试视频简介',
      owner: { mid: '10086', name: '测试UP主' },
      pages: [{ cid: '3001001', page: 1, part: 'P1', duration: 120 }]
    });
    this.addLiveRoom({ roomId: '9001', uid: '10086', title: '测试直播间', liveStatus: 1 });
    this.userCards.set('20002', { mid: '20002', name: '观众A', sign: '签名A', fans: 12, level: 3 });
    this.userCards.set('20003', { mid: '20003', name: '观众B', sign: '签名B', fans: 34, level: 4 });
  }

  static async start(options = {}) {
    const fake = new FakeBili(options);
    await fake.listen();
    return fake;
  }

  async listen() {
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#send(res, { code: 500, message: String(error?.message || error) }, 500);
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.#refreshSubtitleUrls();
  }

  #refreshSubtitleUrls() {
    for (const list of this.subtitles.values()) {
      for (const item of list) {
        item.subtitle_url = `http://127.0.0.1:${this.port}/subtitle/${item.id}.json`;
      }
    }
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  base(service = 'api') {
    if (service === 'ws') return `ws://127.0.0.1:${this.wsPort}`;
    return `http://127.0.0.1:${this.port}`;
  }

  endpoints() {
    const base = `http://127.0.0.1:${this.port}`;
    return {
      passport: base,
      api: base,
      web: base,
      live: base,
      vc: base,
      subtitle: base
    };
  }

  #cookie(req, name) {
    return parseCookies(req.headers.cookie)[name] || '';
  }

  #authOk(req) {
    return this.loggedIn && this.#cookie(req, 'SESSDATA') === this.session.sessdata;
  }

  #csrfOk(req, value) {
    if (!this.#authOk(req)) return false;
    return String(value || this.#cookie(req, 'bili_jct')) === this.session.jct;
  }

  #wbiOk(url) {
    const query = Object.fromEntries(url.searchParams);
    if (!query.w_rid || !query.wts) return false;
    const { w_rid: rid, ...rest } = query;
    const expected = signWbi(rest, {
      imgKey: this.wbiKeys.imgKey,
      subKey: this.wbiKeys.subKey,
      wts: Number(rest.wts)
    });
    return expected.w_rid === rid;
  }

  #sessionCookies(values, extra = {}) {
    return [
      `SESSDATA=${values.sessdata}; Path=/; HttpOnly; SameSite=Lax`,
      `bili_jct=${values.jct}; Path=/; SameSite=Lax`,
      `DedeUserID=${values.mid}; Path=/; SameSite=Lax`,
      `DedeUserID__ckMd5=${values.ckMd5}; Path=/; SameSite=Lax`,
      `sid=${values.sid}; Path=/; SameSite=Lax`,
      ...Object.entries(extra).map(([key, value]) => `${key}=${value}; Path=/; SameSite=Lax`)
    ];
  }

  #send(res, payload, status = 200, headers = {}) {
    const body = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...headers
    });
    res.end(body);
  }

  #sendText(res, text, status = 200, contentType = 'text/html; charset=utf-8') {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store'
    });
    res.end(text);
  }

  #sendBytes(res, data, contentType) {
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length,
      'cache-control': 'no-store'
    });
    res.end(data);
  }

  #fail(url) {
    const path = url.pathname;
    const hit = this.failures.find((item) => item.path === path && item.times > 0);
    if (!hit) return null;
    hit.times -= 1;
    return hit;
  }

  async #handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const text = await readBody(req);
    const form = jsonBody(text, req.headers['content-type']);
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form,
      at: Date.now(),
      auth: this.#authOk(req)
    };
    this.requests.push(record);
    const failure = this.#fail(url);
    if (failure) {
      return this.#send(res, { code: failure.code, message: failure.message || 'fake failure', data: failure.data ?? null }, failure.status || 200);
    }
    return this.#route(req, res, url, form, record);
  }

  async #route(req, res, url, form, record) {
    const path = url.pathname;
    const method = req.method;
    const query = Object.fromEntries(url.searchParams);

    if (path === '/x/frontend/finger/spi') {
      return this.#send(res, { code: 0, data: { b_3: 'BUVID3FAKEFINGERPRINT00000001infoc', b_4: 'BUVID4FAKEFINGERPRINT00000002infoc' } });
    }
    if (path === '/x/passport-login/web/qrcode/generate') {
      this.qrIndex = 0;
      return this.#send(res, { code: 0, data: { url: `https://fake.bili/passport/qr?qrcode_key=${this.qrKey}`, qrcode_key: this.qrKey } });
    }
    if (path === '/x/passport-login/web/qrcode/poll') {
      const key = String(query.qrcode_key || '');
      if (key !== this.qrKey) return this.#send(res, { code: 0, data: { code: 86038, message: '二维码已失效' } });
      const status = this.qrStatuses[Math.min(this.qrIndex, this.qrStatuses.length - 1)];
      this.qrIndex += 1;
      if (status === 'pending') return this.#send(res, { code: 0, data: { code: 86101, message: '未扫码' } });
      if (status === 'scanned') return this.#send(res, { code: 0, data: { code: 86090, message: '已扫码未确认' } });
      if (status === 'expired') return this.#send(res, { code: 0, data: { code: 86038, message: '二维码已过期' } });
      this.loggedIn = true;
      const headers = { 'set-cookie': this.#sessionCookies(this.session) };
      // 测试环境只用 Set-Cookie（host-only），redirect query 的解析由 CookieJar 单测覆盖。
      return this.#send(res, {
        code: 0,
        data: { code: 0, message: '', url: 'https://passport.biligame.com/crossDomain', refresh_token: this.session.refreshToken }
      }, 200, headers);
    }
    if (path === '/x/passport-login/web/cookie/info') {
      if (!this.#csrfOk(req, query.csrf)) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      return this.#send(res, { code: 0, data: { refresh: this.refreshNeeded, timestamp: this.refreshTimestamp } });
    }
    if (path.startsWith('/correspond/1/')) {
      const hex = path.slice('/correspond/1/'.length);
      try {
        const plain = crypto.privateDecrypt(
          {
            key: this.privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
          },
          Buffer.from(hex, 'hex')
        ).toString('utf8');
        if (plain !== `refresh_${this.refreshTimestamp}`) return this.#sendText(res, 'expired', 403);
        this.lastCorrespondPath = hex;
        return this.#sendText(res, `<html><body><div id="1-name">${this.refreshCsrf}</div></body></html>`);
      } catch {
        return this.#sendText(res, 'bad token', 403);
      }
    }
    if (path === '/x/passport-login/web/cookie/refresh') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '未登录' });
      if (String(form.csrf || '') !== this.session.jct) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      if (String(form.refresh_csrf || '') !== this.refreshCsrf) return this.#send(res, { code: -111, message: 'refresh_csrf 校验失败' });
      if (String(form.refresh_token || '') !== this.session.refreshToken) return this.#send(res, { code: -400, message: 'refresh_token 无效' });
      this.refreshCalls += 1;
      this.refreshIteration += 1;
      this.confirmOldRefreshToken = this.session.refreshToken;
      this.session = {
        ...this.session,
        sessdata: `sess-refreshed-${this.refreshIteration}`,
        jct: `jct-refreshed-${this.refreshIteration}`,
        ckMd5: `ckmd5-refreshed-${this.refreshIteration}`,
        sid: `sid-refreshed-${this.refreshIteration}`,
        refreshToken: `refresh-rotated-${this.refreshIteration}`
      };
      return this.#send(res, {
        code: 0,
        data: { status: 0, message: '0', refresh_token: this.session.refreshToken }
      }, 200, { 'set-cookie': this.#sessionCookies(this.session) });
    }
    if (path === '/x/passport-login/web/confirm/refresh') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '未登录' });
      if (String(form.csrf || '') !== this.session.jct) return this.#send(res, { code: -111, message: 'confirm csrf 校验失败' });
      if (String(form.refresh_token || '') !== this.confirmOldRefreshToken) return this.#send(res, { code: -400, message: 'confirm 必须使用旧 refresh_token' });
      this.confirmCount += 1;
      return this.#send(res, { code: 0, data: { status: 0, message: '0' } });
    }
    if (path === '/x/web-interface/nav') {
      const logged = this.#authOk(req);
      const wbi_img = {
        img_url: `https://i0.hdslb.com/bfs/wbi/${this.wbiKeys.imgKey}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${this.wbiKeys.subKey}.png`
      };
      if (!logged) return this.#send(res, { code: -101, message: '账号未登录', data: { wbi_img, isLogin: false } });
      return this.#send(res, {
        code: 0,
        data: { isLogin: true, mid: Number(this.account.mid), uname: this.account.uname, face: this.account.face, wbi_img }
      });
    }
    if (path === '/x/web-interface/view') {
      const bvid = query.bvid || '';
      const aid = query.aid || '';
      const detail = this.videos.get(bvid) || this.videosByAid.get(String(aid));
      if (!detail) return this.#send(res, { code: -404, message: '啥都木有' });
      return this.#send(res, { code: 0, data: detail });
    }
    if (path === '/x/player/wbi/v2') {
      if (!this.#wbiOk(url)) return this.#send(res, { code: -403, message: 'wbi 签名错误' });
      const aid = String(query.aid || '');
      const list = this.subtitles.get(aid) || [];
      return this.#send(res, { code: 0, data: { subtitle: { subtitles: list } } });
    }
    if (path.startsWith('/subtitle/')) {
      const id = path.slice('/subtitle/'.length).replace(/\.json$/, '');
      return this.#send(res, { body: [{ from: 0, to: 2.5, content: `字幕内容 ${id}` }, { from: 2.5, to: 5, content: '第二句字幕' }] });
    }
    if (path === '/cover.jpg') {
      return this.#sendBytes(res, this.coverBytes, 'image/jpeg');
    }
    if (path === '/x/web-interface/card') {
      const mid = String(query.mid || '');
      const card = this.userCards.get(mid) || { mid, name: `用户${mid}`, sign: '', fans: 0, level: 1 };
      return this.#send(res, {
        code: 0,
        data: {
          card: {
            mid: Number(card.mid),
            name: card.name,
            face: '',
            sign: card.sign,
            level_info: { current_level: card.level }
          },
          fans: card.fans,
          archive_count: 1
        }
      });
    }
    if (path === '/x/v2/reply/wbi/main') {
      if (!this.#wbiOk(url)) return this.#send(res, { code: -403, message: 'wbi 签名错误' });
      const oid = String(query.oid || '');
      const replies = this.videoComments.get(oid) || [];
      return this.#send(res, {
        code: 0,
        data: {
          replies,
          top_replies: [],
          cursor: { is_end: true, pagination_reply: { next_offset: '' } }
        }
      });
    }
    if (path === '/x/v2/reply/add') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      if (String(form.csrf || '') !== this.session.jct) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      if (this.riskMode) {
        return this.#send(res, { code: -352, message: '风控校验失败', data: { v_voucher: 'voucher-test-1' } });
      }
      const message = String(form.message || '');
      if (!message.trim()) return this.#send(res, { code: 12051, message: '评论内容为空' });
      if (message.includes('badword')) return this.#send(res, { code: 12016, message: '评论内容包含敏感信息' });
      if (message.includes('duplicate')) return this.#send(res, { code: 12051, message: '重复评论，请勿刷屏' });
      const oid = String(form.oid || '');
      this.commentCounter += 1;
      const rpid = bigRpid(this.commentCounter);
      const added = {
        rpid,
        rpid_str: rpid,
        oid: Number(oid),
        root: Number(form.root || 0),
        parent: Number(form.parent || 0),
        member: { mid: Number(this.session.mid), uname: this.account.uname, avatar: '' },
        content: { message, members: [], at_name_to_mid: form.at_name_to_mid ? JSON.parse(form.at_name_to_mid) : {} },
        ctime: 1_700_000_000 + this.commentCounter,
        like: 0,
        rcount: 0
      };
      const list = this.videoComments.get(oid) || [];
      list.push(added);
      this.videoComments.set(oid, list);
      return this.#send(res, { code: 0, data: { rpid, rpid_str: rpid } });
    }
    if (path === '/x/web-interface/archive/like') {
      if (!this.#csrfOk(req, form.csrf)) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      this.videoLikes.push({ aid: String(form.aid || ''), like: Number(form.like) || 0 });
      return this.#send(res, { code: 0, data: {} });
    }
    if (path === '/x/v2/reply/action') {
      if (!this.#csrfOk(req, form.csrf)) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      this.commentActions.push({ oid: String(form.oid || ''), rpid: String(form.rpid || ''), action: Number(form.action) || 0 });
      return this.#send(res, { code: 0, data: {} });
    }
    if (path === '/x/gaia-vgate/v1/register') {
      return this.#send(res, { code: 0, data: { type: 'geetest', token: 'gaia-token', geetest: { gt: 'gt', challenge: 'challenge' } } });
    }
    if (path === '/x/msgfeed/unread') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      return this.#send(res, {
        code: 0,
        data: {
          reply: this.msgfeedUnread.reply,
          at: this.msgfeedUnread.at,
          like: this.msgfeedUnread.like,
          sys_msg: this.msgfeedUnread.sysMsg
        }
      });
    }
    if (path === '/x/msgfeed/at') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      const items = this.msgfeedAtItems.slice(0, 20);
      const response = {
        code: 0,
        data: {
          items,
          cursor: { is_end: true, id: this.msgfeedAtItems[0]?.id || 0, time: this.msgfeedAtItems[0]?.reply_time || 0 }
        }
      };
      this.msgfeedUnread.at = 0;
      return this.#send(res, response);
    }
    if (path === '/x/msgfeed/reply') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      const items = this.msgfeedItems.slice(0, 20);
      const response = {
        code: 0,
        data: {
          items,
          cursor: { is_end: true, id: this.msgfeedItems[0]?.id || 0, time: this.msgfeedItems[0]?.replies?.[0]?.ctime || 0 }
        }
      };
      this.msgfeedUnread = { reply: 0, at: 0, like: 0, sysMsg: 0 };
      return this.#send(res, response);
    }
    if (path === '/x/space/wbi/arc/search') {
      if (!this.#wbiOk(url)) return this.#send(res, { code: -403, message: 'wbi 签名错误' });
      const mid = String(query.mid || '');
      return this.#send(res, { code: 0, data: { list: { vlist: this.upVideos.get(mid) || [] } } });
    }
    if (path === '/session_svr/v1/session_svr/get_sessions') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      const session_list = [...this.dmSessions.values()].map((session) => {
        const messages = this.dmMessages.get(session.talkerId) || [];
        const maxSeqno = messages.length ? messages[messages.length - 1].msg_seqno : session.maxSeqno || '0';
        return {
          talker_id: Number(session.talkerId),
          session_type: 1,
          ack_seqno: session.ackSeqno || '0',
          max_seqno: maxSeqno,
          unread_count: session.unread ?? 0,
          update_time: session.updateTime || 1_700_000_000,
          system_msg_type: session.systemMsgType || 0,
          last_msg: messages[messages.length - 1] || null
        };
      });
      return this.#send(res, { code: 0, data: { session_list } });
    }
    if (path === '/svr_sync/v1/svr_sync/fetch_session_msgs') {
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      const talkerId = String(query.talker_id || '');
      const size = Math.min(100, Number(query.size) || 20);
      const messages = (this.dmMessages.get(talkerId) || []).slice(-size);
      const maxSeqno = messages.length ? messages[messages.length - 1].msg_seqno : '0';
      const minSeqno = messages.length ? messages[0].msg_seqno : '0';
      return this.#send(res, { code: 0, data: { messages, has_more: false, max_seqno: maxSeqno, min_seqno: minSeqno } });
    }
    if (path === '/session_svr/v1/session_svr/update_ack') {
      if (!this.#csrfOk(req, form.csrf)) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      const talkerId = String(form.talker_id || '');
      const session = this.dmSessions.get(talkerId);
      if (session) {
        session.ackSeqno = String(form.ack_seqno || '');
        session.unread = 0;
      }
      return this.#send(res, { code: 0, data: {} });
    }
    if (path === '/web_im/v1/web_im/send_msg') {
      if (!this.#wbiOk(url)) return this.#send(res, { code: -403, message: 'wbi 签名错误' });
      if (!this.#authOk(req)) return this.#send(res, { code: -101, message: '账号未登录' });
      if (String(form.csrf || '') !== this.session.jct) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      const receiver = String(form['msg[receiver_id]'] || '');
      let content = {};
      try { content = JSON.parse(String(form['msg[content]'] || '{}')); } catch { content = {}; }
      const text = String(content.content || '');
      if (Buffer.byteLength(text, 'utf8') > 2000) return this.#send(res, { code: 21000, message: '消息过长' });
      this.dmSeqCounter += 1n;
      const seqno = String(this.dmSeqCounter);
      const message = {
        sender_uid: Number(this.session.mid),
        receiver_id: Number(receiver),
        msg_type: 1,
        content: JSON.stringify({ content: text }),
        msg_seqno: seqno,
        timestamp: 1_700_000_100,
        msg_key: '123456789012345678901234567890'
      };
      const list = this.dmMessages.get(receiver) || [];
      list.push(message);
      this.dmMessages.set(receiver, list);
      const session = this.dmSessions.get(receiver);
      if (session) {
        session.maxSeqno = seqno;
        session.updateTime = 1_700_000_100;
      }
      this.dmSends.push({ receiver, text, seqno });
      return this.#send(res, { code: 0, data: { msg_key: message.msg_key, msg_seqno: seqno } });
    }
    if (path === '/room/v1/Room/room_init') {
      const requested = String(query.id || '');
      const room = this.liveRooms.get(requested) || [...this.liveRooms.values()].find((item) => item.shortId === requested);
      if (!room) return this.#send(res, { code: 60004, message: '直播间不存在' });
      return this.#send(res, { code: 0, data: { room_id: Number(room.roomId), short_id: Number(room.shortId || 0), uid: Number(room.uid), live_status: room.liveStatus ?? 1 } });
    }
    if (path === '/xlive/web-room/v1/index/getInfoByRoom') {
      const room = this.liveRooms.get(String(query.room_id || ''));
      if (!room) return this.#send(res, { code: 60004, message: '直播间不存在' });
      return this.#send(res, {
        code: 0,
        data: {
          room_info: {
            room_id: Number(room.roomId),
            short_id: Number(room.shortId || 0),
            uid: Number(room.uid),
            title: room.title,
            cover: '/cover.jpg',
            live_status: room.liveStatus ?? 1
          }
        }
      });
    }
    if (path === '/xlive/web-room/v1/index/getDanmuInfo') {
      if (!this.#wbiOk(url)) return this.#send(res, { code: -403, message: 'wbi 签名错误' });
      return this.#send(res, {
        code: 0,
        data: {
          token: 'danmu-token-1',
          host_list: [{ host: '127.0.0.1', wss_port: this.wsPort || 443, ws_port: this.wsPort || 2244 }]
        }
      });
    }
    if (path === '/msg/send') {
      if (!this.#csrfOk(req, form.csrf)) return this.#send(res, { code: -111, message: 'csrf 校验失败' });
      const text = String(form.msg || '');
      if (Array.from(text).length > 20) return this.#send(res, { code: 1003212, message: '弹幕过长' });
      this.liveSent.push({ roomId: String(form.roomid || ''), text });
      return this.#send(res, { code: 0, data: { dm_v2: {} } });
    }
    this.#send(res, { code: -404, message: `fake 未实现: ${method} ${path}`, data: null });
  }

  // ── 场景构造 ──────────────────────────────────────────────────────────
  addVideo({ bvid, aid, title, desc = '', owner = { mid: '10086', name: '测试UP主' }, pages = [{ cid: '3001001', page: 1, part: 'P1', duration: 120 }], duration = 120 } = {}) {
    const detail = {
      bvid,
      aid: Number(aid),
      title: title || bvid,
      desc,
      pic: '/cover.jpg',
      duration,
      pubdate: 1_700_000_000,
      ctime: 1_700_000_000,
      videos: pages.length,
      tname: '测试分区',
      owner: { mid: Number(owner.mid), name: owner.name, face: '' },
      pages: pages.map((page) => ({ cid: Number(page.cid), page: page.page, part: page.part, duration: page.duration })),
      stat: { view: 1000, danmaku: 10, reply: 3, like: 50, coin: 5, favorite: 6, share: 7 }
    };
    this.videos.set(String(bvid), detail);
    this.videosByAid.set(String(aid), detail);
    if (!this.videoComments.has(String(aid))) this.videoComments.set(String(aid), []);
    this.subtitles.set(String(aid), [{
      id: 'sub-ai-1',
      lan: 'ai-zh',
      lan_doc: '中文（AI生成）',
      subtitle_url: `http://127.0.0.1:${this.port || 1}/subtitle/sub-ai-1.json`,
      author: { name: 'AI' },
      type: 1
    }]);
    return detail;
  }

  addSubtitle(aid, { lan = 'zh-CN', label = '中文', id = 'sub-zh-1', isAi = false } = {}) {
    const list = this.subtitles.get(String(aid)) || [];
    list.push({
      id,
      lan,
      lan_doc: label,
      subtitle_url: `http://127.0.0.1:${this.port || 1}/subtitle/${id}.json`,
      author: { name: '字幕君' },
      type: isAi ? 1 : 0
    });
    this.subtitles.set(String(aid), list);
  }

  addComment(oid, {
    rpid = null,
    mid = '20002',
    uname = '观众A',
    message = '一条评论',
    root = '0',
    parent = '0',
    ctime = 1_700_000_000,
    replies = [],
    members = [],
    atNameToMid = {}
  } = {}) {
    this.commentCounter += 1;
    const id = String(rpid || bigRpid(this.commentCounter));
    const comment = {
      rpid: id,
      rpid_str: id,
      oid: Number(oid),
      root: Number(root),
      parent: Number(parent),
      member: { mid: Number(mid), uname, avatar: '' },
      content: { message, members, at_name_to_mid: atNameToMid },
      ctime,
      like: 0,
      rcount: replies.length,
      replies
    };
    const list = this.videoComments.get(String(oid)) || [];
    list.push(comment);
    this.videoComments.set(String(oid), list);
    return comment;
  }

  addMsgfeedReply({
    bvid = 'BV1xx411c7mD',
    oid = 170001,
    rpid = null,
    mid = '20002',
    uname = '观众A',
    message = '@测试UP主 来回复',
    atSelf = false,
    context = '',
    title = '测试视频标题',
    ctime = 1_700_000_100
  } = {}) {
    this.msgfeedCounter += 1;
    const id = String(rpid || bigRpid(1_000_000 + this.msgfeedCounter));
    const selfMid = this.account.mid;
    const item = {
      id: 10_000 + this.msgfeedCounter,
      user: { mid: Number(mid), nickname: uname, avatar: '', fans: 0, follow: false },
      item: {
        subject_id: Number(oid),
        root_id: 0,
        source_id: id, // 真实接口是 num；测试用字符串保留超精度
        target_id: 0,
        type: 'reply',
        business_id: 1,
        business: '视频',
        title,
        desc: '',
        uri: `https://www.bilibili.com/video/${bvid}`,
        native_uri: `bilibili://video/${bvid}`,
        source_content: message,
        target_reply_content: context,
        root_reply_content: context,
        at_details: atSelf ? [{ mid: Number(selfMid), nickname: this.account.uname, avatar: '', follow: false }] : [],
        topic_details: [],
        message: ''
      },
      counts: 1,
      is_multi: 0,
      reply_time: ctime
    };
    this.msgfeedItems.unshift(item);
    this.msgfeedUnread.reply += 1;
    if (atSelf) this.msgfeedUnread.at += 1;
    return item;
  }

  addMsgfeedAt({
    bvid = 'BV1xx411c7mD',
    oid = 170001,
    rpid = null,
    mid = '20003',
    uname = '观众B',
    message = '@测试UP主 看看这个',
    title = '测试视频标题',
    ctime = 1_700_000_110
  } = {}) {
    this.msgfeedCounter += 1;
    const id = String(rpid || bigRpid(1_000_000 + this.msgfeedCounter));
    const selfMid = this.account.mid;
    const item = {
      id: 20_000 + this.msgfeedCounter,
      user: { mid: Number(mid), nickname: uname, avatar: '', fans: 0, follow: false },
      item: {
        subject_id: Number(oid),
        root_id: 0,
        source_id: id,
        target_id: 0,
        type: 'at',
        business_id: 1,
        business: '视频',
        title,
        desc: '',
        uri: `https://www.bilibili.com/video/${bvid}`,
        native_uri: `bilibili://video/${bvid}`,
        source_content: message,
        target_reply_content: '',
        root_reply_content: '',
        at_details: [{ mid: Number(selfMid), nickname: this.account.uname, avatar: '', follow: false }],
        topic_details: [],
        message: ''
      },
      counts: 1,
      is_multi: 0,
      reply_time: ctime
    };
    this.msgfeedAtItems.unshift(item);
    this.msgfeedUnread.at += 1;
    return item;
  }

  addUpVideo(mid, {
    bvid,
    aid,
    title,
    created = 1_700_000_200,
    author = '测试UP主',
    description = '新视频简介'
  } = {}) {
    const entry = {
      bvid,
      aid: Number(aid),
      title,
      pic: '/cover.jpg',
      created,
      author,
      description,
      mid: String(mid)
    };
    const list = this.upVideos.get(String(mid)) || [];
    list.unshift(entry);
    this.upVideos.set(String(mid), list);
    return entry;
  }

  addDmSession(talkerId, { name = '观众A', unread = 0, systemMsgType = 0 } = {}) {
    this.dmSessions.set(String(talkerId), {
      talkerId: String(talkerId),
      ackSeqno: '0',
      maxSeqno: '0',
      unread,
      updateTime: 1_700_000_000,
      systemMsgType,
      name
    });
    if (!this.userCards.has(String(talkerId))) {
      this.userCards.set(String(talkerId), { mid: String(talkerId), name, sign: '', fans: 0, level: 2 });
    }
  }

  addDmMessage(talkerId, { from = 'them', text = '你好', seqno = null, timestamp = 1_700_000_050 } = {}) {
    this.dmSeqCounter += 1n;
    const sender = from === 'me' ? this.account.mid : String(talkerId);
    const receiver = from === 'me' ? String(talkerId) : this.account.mid;
    const message = {
      sender_uid: Number(sender),
      receiver_id: Number(receiver),
      msg_type: 1,
      content: JSON.stringify({ content: text }),
      msg_seqno: String(seqno || this.dmSeqCounter),
      timestamp,
      msg_key: '987654321098765432109876543210'
    };
    const list = this.dmMessages.get(String(talkerId)) || [];
    list.push(message);
    this.dmMessages.set(String(talkerId), list);
    const session = this.dmSessions.get(String(talkerId));
    if (session) {
      session.maxSeqno = message.msg_seqno;
      session.unread = (session.unread || 0) + (from === 'me' ? 0 : 1);
      session.updateTime = timestamp;
    }
    return message;
  }

  addLiveRoom({ roomId, uid = '10086', shortId = '', title = '测试直播间', liveStatus = 1 } = {}) {
    this.liveRooms.set(String(roomId), {
      roomId: String(roomId),
      shortId: String(shortId),
      uid: String(uid),
      title,
      liveStatus
    });
  }

  addUserCard({ mid, name, sign = '', fans = 0, level = 1 }) {
    this.userCards.set(String(mid), { mid: String(mid), name, sign, fans, level });
  }

  failNext(path, { code = -500, message = 'fake failure', data = null, times = 1, status = 200 } = {}) {
    this.failures.push({ path, code, message, data, times, status });
  }

  clearRequests() {
    this.requests = [];
  }

  requestsTo(path) {
    return this.requests.filter((item) => item.path === path);
  }

  count(path) {
    return this.requestsTo(path).length;
  }

  last(path) {
    const list = this.requestsTo(path);
    return list[list.length - 1] || null;
  }

  /** 让测试直接把 fake 会话塞进桥接 cookie jar（跳过扫码）。 */
  applyCookiesTo(jar) {
    const domain = '127.0.0.1';
    jar.set('SESSDATA', this.session.sessdata, { domain, path: '/', hostOnly: true });
    jar.set('bili_jct', this.session.jct, { domain, path: '/', hostOnly: true });
    jar.set('DedeUserID', this.session.mid, { domain, path: '/', hostOnly: true });
    jar.set('DedeUserID__ckMd5', this.session.ckMd5, { domain, path: '/', hostOnly: true });
    jar.set('sid', this.session.sid, { domain, path: '/', hostOnly: true });
    jar.set('buvid3', 'BUVID3FAKEFINGERPRINT00000001infoc', { domain, path: '/', hostOnly: true });
    jar.set('buvid4', 'BUVID4FAKEFINGERPRINT00000002infoc', { domain, path: '/', hostOnly: true });
    this.loggedIn = true;
  }
}
