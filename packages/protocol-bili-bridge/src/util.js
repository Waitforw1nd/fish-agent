import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 严格把整数/十进制字符串转 BigInt；浮点、指数、空值一律 null。 */
export function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    return BigInt(value);
  }
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

/** 仅当值可无损放进 IEEE-754 安全整数时返回 number，否则 null。 */
export function toSafeNumber(value) {
  const big = toBigInt(value);
  if (big == null) return null;
  if (big > BigInt(MAX_SAFE_INTEGER) || big < BigInt(-MAX_SAFE_INTEGER)) return null;
  return Number(big);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) return clone(override);
  const out = { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

export function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

// WBI 要求 RFC 3986：encodeURIComponent 不转义 !'()*，必须补上。
export function encodeComponent(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function sanitizeWbiValue(value) {
  return String(value).replace(/[!'()*]/g, '');
}

/** 按键名排序后拼 query（WBI 签名与普通请求共用）。 */
export function encodeQuery(params = {}) {
  const keys = Object.keys(params).filter((key) => params[key] !== undefined && params[key] !== null).sort();
  return keys.map((key) => `${encodeComponent(key)}=${encodeComponent(params[key])}`).join('&');
}

export function toForm(params = {}) {
  return encodeQuery(params);
}

export function parseQuery(text) {
  const out = {};
  const raw = String(text ?? '');
  const index = raw.indexOf('?');
  const qs = index >= 0 ? raw.slice(index + 1) : raw;
  if (!qs) return out;
  for (const [key, value] of new URLSearchParams(qs)) out[key] = value;
  return out;
}

export function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(typeof text === 'string' ? text : Buffer.from(text)).digest('hex');
}

export function hashToOffset(key, size) {
  const digest = crypto.createHash('sha256').update(String(key), 'utf8').digest();
  const value = digest.readBigUInt64BE(0);
  return Number(value % BigInt(size));
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** 按 UTF-8 字节上限截断，不切坏代理对；截断时补一个省略号（若留得下）。 */
export function truncateUtf8Bytes(text, maxBytes) {
  const value = String(text ?? '');
  if (byteLength(value) <= maxBytes) return value;
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  let used = 0;
  let out = '';
  for (const ch of value) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (used + len > budget) break;
    out += ch;
    used += len;
  }
  return budget > 0 ? out + ellipsis : '';
}

/** 按 Unicode 码点截断（中文字符在 B 站评论/弹幕里按字符计数）。 */
export function truncateChars(text, maxChars) {
  const value = String(text ?? '');
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  if (maxChars <= 1) return '…';
  return chars.slice(0, maxChars - 1).join('') + '…';
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function pickFirst(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value;
  return undefined;
}

export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function safeJsonStringify(value, fallback = '') {
  try { return JSON.stringify(value); } catch { return fallback; }
}

const SECRET_KEY_RE = /(sessdata|sessData|bili_jct|biliJct|refresh_token|refreshToken|access_key|accessKey|access_token|accessToken|dedeuserid__ckmd5|csrf_token|csrfToken|csrf|cookie|authorization|password|secret|qrcode_?key|qrcodeKey)/i;

/** 深拷贝并抹掉敏感字段；用于任何对外 status/log 输出。 */
export function redactSecrets(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return '[buffer]';
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = item == null || item === '' ? '' : '[redacted]';
    } else if (/^(token|key|voucher|qrcode_key|qrcodeKey)$/i.test(key)) {
      out[key] = item ? '[redacted]' : '';
    } else {
      out[key] = redactSecrets(item, seen);
    }
  }
  return out;
}

/** 抹掉日志字符串里的 Cookie/令牌形态文本。 */
export function redactText(text) {
  return String(text ?? '')
    .replace(/((?:SESSDATA|bili_jct|refresh_token|access_key|DedeUserID__ckMd5|qrcode_key)=)[^&;\s"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/("(?:SESSDATA|bili_jct|refresh_token|access_key|password|token)"\s*:\s*")[^"]+/gi, '$1[redacted]');
}

export function formatError(error) {
  if (!error) return 'unknown';
  const name = error.name || 'Error';
  const code = error.apiCode != null ? `/${error.apiCode}` : '';
  return `${name}${code}: ${error.message || String(error)}`;
}

/** 可重复的伪随机数（测试和抖动）；返回 [0,1)。 */
export function seededRandom(seed = 1) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}
