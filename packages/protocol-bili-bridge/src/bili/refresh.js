import crypto from 'node:crypto';
import { AuthRequiredError, BiliApiError, BridgeError } from '../errors.js';
import { Mutex } from '../store/file-lock.js';

// B 站 web 端 cookie 刷新使用的 RSA 公钥（bilibili-API-collect 文档固定值）。
export const COOKIE_REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

export function correspondPath(timestamp, publicKey = COOKIE_REFRESH_PUBLIC_KEY) {
  const ts = Math.trunc(Number(timestamp));
  if (!Number.isFinite(ts) || ts <= 0) throw new BridgeError('correspondPath 需要有效的秒级时间戳', { kind: 'INPUT', code: 400 });
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(`refresh_${ts}`, 'utf8')
  ).toString('hex');
}

export function extractRefreshCsrf(html) {
  const text = String(html ?? '');
  // 官方页面把 refresh_csrf 放在 <div id="1-name">…</div> 的纯文本里。
  const div = text.match(/<div[^>]*id=["']?1-name["']?[^>]*>([^<]+)<\/div>/i);
  if (div) {
    const value = div[1].trim();
    if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  }
  // 兼容旧版/代理改写后的赋值形态。
  const match = text.match(/refresh_csrf\s*[=:]\s*["']?([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

/**
 * 四步 cookie 保活：cookie/info → correspondPath → refresh_csrf 页面 → refresh → confirm。
 * 进程内 Mutex + 跨进程 FileLock 双重互斥；新旧 cookies 由 SecretStore 原子覆盖。
 */
export class CookieRefresher {
  constructor({ api, auth, jar, lock = null, now = Date.now, logger = null, publicKey = COOKIE_REFRESH_PUBLIC_KEY }) {
    if (!api || !auth || !jar) throw new TypeError('CookieRefresher 需要 api/auth/jar');
    this.api = api;
    this.auth = auth;
    this.jar = jar;
    this.lock = lock;
    this.now = now;
    this.logger = logger;
    this.publicKey = publicKey;
    this.mutex = new Mutex();
    this.lastCheckAt = 0;
    this.lastRefreshAt = 0;
    this.lastError = '';
    this.refreshCount = 0;
    this.lastCheck = null;
  }

  async check() {
    this.auth.assertLoggedIn();
    try {
      const payload = await this.api.request({
        method: 'GET',
        service: 'passport',
        path: '/x/passport-login/web/cookie/info',
        params: { csrf: this.api.csrf() },
        signed: false,
        allowedCodes: [0],
        retries: 1
      });
      const data = payload?.data || {};
      const result = {
        needed: Boolean(data.refresh),
        timestamp: Number(data.timestamp) || null,
        checkedAt: this.now()
      };
      this.lastCheckAt = result.checkedAt;
      this.lastCheck = result;
      this.lastError = '';
      return result;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.logger?.warn?.('检查 cookie 刷新状态失败', error);
      throw error;
    }
  }

  /** 手动 force 仍需要 cookie/info 的 timestamp，不能凭空生成 correspondPath。 */
  async refresh({ force = false } = {}) {
    this.auth.assertLoggedIn();
    return this.mutex.run(async () => {
      const run = async () => this.#refreshLocked({ force });
      return this.lock ? this.lock.withLock(run) : run();
    });
  }

  async #refreshLocked({ force }) {
    const info = await this.check();
    if (!info.needed && !force) {
      return { refreshed: false, reason: 'not_needed', checkedAt: info.checkedAt };
    }
    if (!info.timestamp) {
      throw new BiliApiError('cookie/info 未返回时间戳，无法生成 correspondPath', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: 'B 站 cookie 保活接口返回异常'
      });
    }
    const oldJct = this.api.csrf();
    const session = this.auth.session;
    const oldRefreshToken = String(session?.refreshToken || '');
    if (!oldRefreshToken) {
      throw new AuthRequiredError('缺少 refresh_token，无法保活，请重新扫码登录');
    }

    // 步骤 2：RSA 加密 refresh_<timestamp>，得到 correspondPath。
    let pathToken;
    try {
      pathToken = correspondPath(info.timestamp, this.publicKey);
    } catch (error) {
      throw new BridgeError('生成 correspondPath 失败', { kind: 'INTERNAL', code: 500, retcode: 1500, cause: error });
    }

    // 步骤 3：访问对应页面，读出 refresh_csrf。
    let page;
    try {
      page = await this.api.fetchText({
        method: 'GET',
        service: 'web',
        path: `/correspond/1/${pathToken}`,
        referer: 'https://www.bilibili.com/',
        retries: 1
      });
    } catch (error) {
      throw new BiliApiError('获取 refresh_csrf 页面失败', {
        kind: error?.kind || 'HTTP',
        code: error?.code || 502,
        retcode: 1403,
        wording: 'B 站 cookie 保活页面不可用，请稍后重试或重新登录',
        cause: error
      });
    }
    const refreshCsrf = extractRefreshCsrf(page.text);
    if (!refreshCsrf) {
      throw new BiliApiError('refresh_csrf 页面中没有找到校验值', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: 'B 站 cookie 保活页面结构变化，请检查桥接版本'
      });
    }

    // 步骤 4a：refresh，B 站通过 Set-Cookie 下发新凭据。
    const refreshPayload = await this.api.request({
      method: 'POST',
      service: 'passport',
      path: '/x/passport-login/web/cookie/refresh',
      form: {
        csrf: oldJct,
        refresh_csrf: refreshCsrf,
        source: 'main_web',
        refresh_token: oldRefreshToken
      },
      referer: 'https://www.bilibili.com/',
      signed: false,
      allowedCodes: [0],
      retries: 0
    });
    const refreshStatus = refreshPayload?.data?.status;
    if (refreshStatus !== undefined && Number(refreshStatus) !== 0) {
      throw new BiliApiError(`B 站 cookie 刷新失败（status=${refreshStatus}）`, {
        kind: 'API', code: 502, retcode: 1502, wording: 'B 站 cookie 刷新失败，请重新扫码登录'
      });
    }
    const newSessdata = this.jar.get('SESSDATA');
    const newJct = this.jar.get('bili_jct');
    if (!newSessdata || !newJct) {
      throw new BiliApiError('cookie 刷新响应没有下发新的登录凭据', {
        kind: 'PROTOCOL', code: 502, retcode: 1502, wording: 'B 站 cookie 刷新失败，请重新扫码登录'
      });
    }

    // 步骤 4b：confirm 使用**旧** refresh_token 让旧 cookie 立即失效；失败则新 cookie 也可能作废。
    const nextRefreshToken = String(refreshPayload?.data?.refresh_token || oldRefreshToken);
    try {
      const confirmPayload = await this.api.request({
        method: 'POST',
        service: 'passport',
        path: '/x/passport-login/web/confirm/refresh',
        form: { csrf: newJct, refresh_token: oldRefreshToken },
        referer: 'https://www.bilibili.com/',
        signed: false,
        allowedCodes: [0],
        retries: 0
      });
      const confirmStatus = confirmPayload?.data?.status;
      if (confirmStatus !== undefined && Number(confirmStatus) !== 0) {
        throw new BiliApiError(`B 站 cookie confirm 失败（status=${confirmStatus}）`, {
          kind: 'API', code: 502, retcode: 1502, wording: 'B 站 cookie 保活确认失败，请重新扫码登录'
        });
      }
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      await this.auth.updateSessionAfterRefresh({ refreshToken: nextRefreshToken }).catch(() => {});
      throw new BridgeError('cookie 已刷新但 confirm 失败，旧登录态可能已失效，请重新扫码', {
        kind: 'AUTH', code: 401, retcode: 1401,
        wording: 'B 站 cookie 保活确认失败，请重新扫码登录',
        cause: error
      });
    }

    await this.auth.updateSessionAfterRefresh({ refreshToken: nextRefreshToken });
    this.lastRefreshAt = this.now();
    this.refreshCount += 1;
    this.lastError = '';
    this.logger?.info?.('B 站 cookie 保活完成', { at: this.lastRefreshAt });
    return {
      refreshed: true,
      at: this.lastRefreshAt,
      usedForce: Boolean(force),
      refreshCount: this.refreshCount
    };
  }

  snapshot() {
    return {
      lastCheckAt: this.lastCheckAt || null,
      lastCheck: this.lastCheck,
      lastRefreshAt: this.lastRefreshAt || null,
      refreshCount: this.refreshCount,
      lastError: this.lastError || null
    };
  }
}
