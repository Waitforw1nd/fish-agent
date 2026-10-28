import { AuthRequiredError, BiliApiError, BridgeError } from '../errors.js';
import { BILI_SESSION_COOKIES, CookieJar } from './cookie-jar.js';

export const QR_STATES = Object.freeze({
  PENDING: 'pending',
  SCANNED: 'scanned',
  SUCCESS: 'success',
  EXPIRED: 'expired'
});

export const QR_STATE_WORDING = Object.freeze({
  pending: '等待扫码',
  scanned: '已扫码，请在手机上确认登录',
  success: '登录成功',
  expired: '二维码已过期，请重新生成'
});

const POLL_CODE_STATE = new Map([
  [86101, QR_STATES.PENDING],
  [86090, QR_STATES.SCANNED],
  [0, QR_STATES.SUCCESS],
  [86038, QR_STATES.EXPIRED]
]);

const QR_TTL_MS = 180_000;

function applyCookies(jar, cookies, now) {
  const saved = CookieJar.fromJSON(cookies, { now });
  for (const cookie of saved.toJSON().cookies) {
    jar.set(cookie.name, cookie.value, {
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      hostOnly: cookie.hostOnly
    });
  }
}

/**
 * 扫码登录状态机：pending（未扫）/ scanned（已扫待确认）/ success / expired。
 * Cookie 与 refresh_token 只进 SecretStore 密文；status 只返回账号公开信息。
 */
export class BiliAuth {
  constructor({ api, jar, secrets, now = Date.now, logger = null, onLogin = null, onLogout = null }) {
    if (!api || !jar) throw new TypeError('BiliAuth 需要 api 和 jar');
    this.api = api;
    this.jar = jar;
    this.secrets = secrets;
    this.now = now;
    this.logger = logger;
    this.onLogin = onLogin;
    this.onLogout = onLogout;
    this.session = null;
    this.qr = null;
    this.profile = null;
    this.lastError = '';
    this.valid = null;
    this.loaded = false;
  }

  get loggedIn() {
    if (this.valid === false) return false;
    return Boolean(this.jar.get('SESSDATA'));
  }

  async load() {
    if (this.loaded) return this;
    if (this.secrets) {
      const saved = await this.secrets.load('session');
      if (saved?.cookies) {
        applyCookies(this.jar, saved.cookies, this.now());
        this.session = saved;
        this.profile = saved.mid ? { mid: String(saved.mid), uname: saved.uname || '', avatar: saved.avatar || '' } : null;
      }
      const qr = await this.secrets.load('qr');
      if (qr?.qrcodeKey) {
        this.qr = { ...qr };
        if (this.qr.state !== QR_STATES.SUCCESS && this.qr.expiresAt && this.qr.expiresAt <= this.now()) {
          this.qr.state = QR_STATES.EXPIRED;
        }
      }
    }
    this.loaded = true;
    return this;
  }

  async generateQr() {
    const payload = await this.api.request({
      method: 'GET',
      service: 'passport',
      path: '/x/passport-login/web/qrcode/generate',
      params: { source: 'main-fe-header' },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const url = String(payload?.data?.url || '');
    const qrcodeKey = String(payload?.data?.qrcode_key || '');
    if (!url || !qrcodeKey) {
      throw new BiliApiError('B 站没有返回二维码', { kind: 'PROTOCOL', code: 502, retcode: 1502, wording: '二维码生成失败，请稍后重试' });
    }
    this.qr = {
      qrcodeKey,
      url,
      state: QR_STATES.PENDING,
      createdAt: this.now(),
      expiresAt: this.now() + QR_TTL_MS,
      scannedAt: null,
      polls: 0,
      message: QR_STATE_WORDING.pending
    };
    await this.#saveQr();
    return this.qrState();
  }

  async #saveQr() {
    if (!this.secrets || !this.qr) return;
    try { await this.secrets.save('qr', this.qr); } catch (error) {
      this.logger?.warn?.('持久化二维码状态失败', error);
    }
  }

  qrState() {
    if (!this.qr) return null;
    return {
      qrcodeKey: this.qr.qrcodeKey,
      url: this.qr.url,
      state: this.qr.state,
      createdAt: this.qr.createdAt,
      expiresAt: this.qr.expiresAt,
      scannedAt: this.qr.scannedAt || null,
      polls: this.qr.polls || 0,
      message: this.qr.message || QR_STATE_WORDING[this.qr.state] || ''
    };
  }

  async pollQr(qrcodeKey) {
    const key = String(qrcodeKey || this.qr?.qrcodeKey || '');
    if (!key) throw new BridgeError('缺少 qrcode_key', { kind: 'INPUT', code: 400, retcode: 1400, wording: '缺少二维码 key' });
    if (!this.qr || this.qr.qrcodeKey !== key) {
      this.qr = {
        qrcodeKey: key,
        url: '',
        state: QR_STATES.PENDING,
        createdAt: this.now(),
        expiresAt: this.now() + QR_TTL_MS,
        scannedAt: null,
        polls: 0,
        message: QR_STATE_WORDING.pending
      };
    }
    if (this.qr.state === QR_STATES.SUCCESS) return this.qrState();
    if (this.qr.expiresAt && this.qr.expiresAt <= this.now() && this.qr.state !== QR_STATES.EXPIRED) {
      this.qr.state = QR_STATES.EXPIRED;
      this.qr.message = QR_STATE_WORDING.expired;
      await this.#saveQr();
      return this.qrState();
    }

    const payload = await this.api.request({
      method: 'GET',
      service: 'passport',
      path: '/x/passport-login/web/qrcode/poll',
      params: { qrcode_key: key, source: 'main-fe-header' },
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    const code = Number(payload?.data?.code);
    const state = POLL_CODE_STATE.get(code);
    this.qr.polls = (this.qr.polls || 0) + 1;
    if (!state) {
      this.qr.message = String(payload?.data?.message || payload?.message || `未知扫码状态 ${code}`);
      this.lastError = this.qr.message;
      await this.#saveQr();
      return this.qrState();
    }
    this.qr.state = state;
    this.qr.message = QR_STATE_WORDING[state];
    if (state === QR_STATES.SCANNED && !this.qr.scannedAt) this.qr.scannedAt = this.now();

    if (state === QR_STATES.EXPIRED) {
      await this.#saveQr();
      return this.qrState();
    }
    if (state === QR_STATES.PENDING || state === QR_STATES.SCANNED) {
      await this.#saveQr();
      return this.qrState();
    }

    // success：B 站可能通过 Set-Cookie 或 crossDomain 跳转 query 下发凭据，两条都要收。
    const redirect = String(payload?.data?.url || '');
    if (redirect) this.jar.setFromRedirectUrl(redirect);
    if (!this.jar.get('SESSDATA')) {
      this.qr.state = QR_STATES.EXPIRED;
      this.qr.message = '登录回调缺少 SESSDATA，请重新生成二维码';
      this.lastError = this.qr.message;
      await this.#saveQr();
      throw new BiliApiError(this.qr.message, {
        kind: 'AUTH', code: 401, retcode: 1401, wording: '扫码成功但未拿到登录凭据，请重新扫码'
      });
    }
    const refreshToken = String(payload?.data?.refresh_token || '');
    let profile = null;
    try {
      profile = await this.getSelfInfo({ refresh: true });
    } catch (error) {
      this.logger?.warn?.('扫码成功但读取账号信息失败', error);
    }
    const mid = profile?.mid || this.jar.get('DedeUserID') || '';
    this.session = {
      version: 1,
      mid: String(mid || ''),
      uname: profile?.uname || '',
      avatar: profile?.avatar || '',
      cookies: this.jar.toJSON(),
      refreshToken,
      loginAt: this.now(),
      refreshedAt: null
    };
    this.profile = { mid: String(mid || ''), uname: profile?.uname || '', avatar: profile?.avatar || '' };
    // nav 明确返回未登录时不能因为拿到了 SESSDATA 就假装成功；网络失败则保留乐观登录态。
    this.valid = profile?.loggedIn === false ? false : true;
    await this.#saveSession();
    await this.#saveQr();
    this.lastError = '';
    if (this.onLogin) {
      try { await this.onLogin(this.account()); } catch (error) { this.logger?.warn?.('onLogin 回调失败', error); }
    }
    return this.qrState();
  }

  async #saveSession() {
    if (this.secrets && this.session) await this.secrets.save('session', this.session);
  }

  async getSelfInfo({ refresh = false } = {}) {
    if (this.profile && !refresh) return { ...this.profile, loggedIn: this.loggedIn };
    if (!this.loggedIn) return { loggedIn: false, mid: null, uname: '', avatar: '' };
    const payload = await this.api.request({
      method: 'GET',
      service: 'api',
      path: '/x/web-interface/nav',
      signed: false,
      allowedCodes: [0, -101],
      retries: 1
    });
    const data = payload?.data || {};
    if (Number(payload?.code) === -101 || !data.isLogin || !data.mid) {
      this.valid = false;
      return { loggedIn: false, mid: null, uname: '', avatar: '' };
    }
    this.valid = true;
    this.profile = {
      mid: String(data.mid),
      uname: String(data.uname || ''),
      avatar: String(data.face || '')
    };
    if (this.session) {
      this.session.mid = this.profile.mid;
      this.session.uname = this.profile.uname;
      this.session.avatar = this.profile.avatar;
    }
    return { ...this.profile, loggedIn: true };
  }

  async ensureSession() {
    await this.load();
    if (!this.loggedIn) return { loggedIn: false };
    try {
      const info = await this.getSelfInfo({ refresh: true });
      if (info.loggedIn) return info;
      this.logger?.warn?.('本地 SESSDATA 已失效');
      this.lastError = '登录状态已失效，请重新扫码';
      return { loggedIn: false, mid: null, uname: '', avatar: '' };
    } catch (error) {
      // 网络暂时不可用不代表 cookie 失效：保留本地登录态，等接口恢复。
      this.logger?.warn?.('校验登录状态失败（保留本地 cookie）', error);
      this.lastError = String(error?.message ?? error);
      return { loggedIn: true, ...(this.profile || {}), stale: true };
    }
  }

  account() {
    const mid = this.session?.mid || this.profile?.mid || this.jar.get('DedeUserID') || '';
    return {
      loggedIn: this.loggedIn,
      mid: mid ? String(mid) : null,
      name: this.profile?.uname || this.session?.uname || '',
      avatar: this.profile?.avatar || this.session?.avatar || ''
    };
  }

  async updateSessionAfterRefresh({ refreshToken } = {}) {
    this.valid = true;
    if (!this.session) {
      this.session = {
        version: 1,
        mid: String(this.jar.get('DedeUserID') || ''),
        uname: this.profile?.uname || '',
        avatar: this.profile?.avatar || '',
        cookies: this.jar.toJSON(),
        refreshToken: refreshToken || '',
        loginAt: this.now(),
        refreshedAt: this.now()
      };
    } else {
      this.session.cookies = this.jar.toJSON();
      this.session.refreshedAt = this.now();
      if (refreshToken) this.session.refreshToken = refreshToken;
    }
    await this.#saveSession();
    return this.session;
  }

  async logout() {
    this.jar.clear();
    this.session = null;
    this.profile = null;
    this.qr = null;
    this.valid = null;
    this.lastError = '';
    if (this.secrets) {
      await this.secrets.delete('session').catch(() => {});
      await this.secrets.delete('qr').catch(() => {});
    }
    if (this.onLogout) {
      try { await this.onLogout(); } catch (error) { this.logger?.warn?.('onLogout 回调失败', error); }
    }
    return true;
  }

  assertLoggedIn() {
    if (!this.loggedIn) throw new AuthRequiredError();
    if (!this.jar.get('bili_jct')) throw new AuthRequiredError('缺少 bili_jct，请重新扫码登录');
    return true;
  }

  status() {
    const qr = this.qrState();
    if (qr) {
      // 例行 status/日志不携带二维码 key 或登录 URL；只有 /admin/login/qr 接口按需返回。
      delete qr.qrcodeKey;
      delete qr.url;
    }
    return {
      loggedIn: this.loggedIn,
      account: this.account(),
      qr,
      loginAt: this.session?.loginAt || null,
      refreshedAt: this.session?.refreshedAt || null,
      hasRefreshToken: Boolean(this.session?.refreshToken),
      cookies: this.jar.publicSnapshot().filter((item) => BILI_SESSION_COOKIES.includes(item.name)),
      lastError: this.lastError || null
    };
  }
}
