import { BridgeError } from '../errors.js';
import { encodeQuery, md5, sanitizeWbiValue } from '../util.js';

// B 站 web 端固定混淆表（bilibili-API-collect 文档）。64 项，取前 32 位为 mixin key。
export const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]);

export function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey ?? ''}${subKey ?? ''}`;
  if (raw.length < 32) throw new BridgeError('WBI 密钥长度不足', { kind: 'WBI', code: 500, retcode: 1500 });
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/**
 * 计算 WBI 签名。返回的是“签名后实际要发送的参数”（字符串化、已过滤禁用字符），
 * 直接交给 encodeQuery 就能得到与签名一致的 query。
 */
export function signWbi(params, { imgKey, subKey, wts } = {}) {
  const timestamp = Number.isFinite(Number(wts)) ? Math.trunc(Number(wts)) : Math.floor(Date.now() / 1000);
  const filtered = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    filtered[key] = sanitizeWbiValue(value);
  }
  filtered.wts = String(timestamp);
  const mixinKey = getMixinKey(imgKey, subKey);
  const query = encodeQuery(filtered);
  return { ...filtered, w_rid: md5(query + mixinKey) };
}

export function signWbiQuery(params, options) {
  return encodeQuery(signWbi(params, options));
}

export function extractWbiKeys(payload) {
  const imgUrl = payload?.data?.wbi_img?.img_url ?? payload?.wbi_img?.img_url;
  const subUrl = payload?.data?.wbi_img?.sub_url ?? payload?.wbi_img?.sub_url;
  const pick = (url) => {
    const clean = String(url || '').split(/[?#]/)[0];
    const base = clean.slice(clean.lastIndexOf('/') + 1);
    return base.replace(/\.(?:png|jpe?g|webp)$/i, '');
  };
  const imgKey = pick(imgUrl);
  const subKey = pick(subUrl);
  if (!imgKey || !subKey) {
    throw new BridgeError('B 站 nav 没有返回可用的 WBI 密钥', {
      kind: 'WBI', code: 502, retcode: 1502, retryable: true
    });
  }
  return { imgKey, subKey, imgUrl, subUrl };
}

/**
 * WBI 密钥缓存与签名服务。
 * request 由 BiliApi 注入（{service,path,signed:false,allowedCodes}），避免和 API 客户端循环依赖。
 */
export class WbiSigner {
  constructor({ request, now = Date.now, ttlMs = 4 * 60 * 60 * 1000, logger = null, keys = null }) {
    if (typeof request !== 'function') throw new TypeError('WbiSigner 需要 request 函数');
    this.request = request;
    this.now = now;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.keys = keys ? { ...keys } : null;
    this.fetchedAt = keys ? this.now() : 0;
    this.refreshes = 0;
    this.inflight = null;
  }

  hasFreshKeys() {
    return Boolean(this.keys?.imgKey && this.keys?.subKey) && this.now() - this.fetchedAt < this.ttlMs;
  }

  async getKeys({ force = false } = {}) {
    if (!force && this.hasFreshKeys()) return this.keys;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const payload = await this.request({
          method: 'GET',
          service: 'api',
          path: '/x/web-interface/nav',
          signed: false,
          allowedCodes: [-101, 0],
          retries: 1
        });
        this.keys = extractWbiKeys(payload);
        this.fetchedAt = this.now();
        this.refreshes += 1;
        this.logger?.debug?.('WBI 密钥已刷新', { imgKey: this.keys.imgKey.slice(0, 4) });
        return this.keys;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  invalidate() {
    this.fetchedAt = 0;
  }

  async sign(params, options = {}) {
    const keys = await this.getKeys({ force: Boolean(options.force) });
    return signWbi(params, {
      imgKey: keys.imgKey,
      subKey: keys.subKey,
      wts: options.wts ?? Math.floor(this.now() / 1000)
    });
  }

  async signQuery(params, options = {}) {
    return encodeQuery(await this.sign(params, options));
  }

  snapshot() {
    return {
      hasKeys: Boolean(this.keys?.imgKey && this.keys?.subKey),
      fetchedAt: this.fetchedAt || null,
      refreshes: this.refreshes
    };
  }
}
