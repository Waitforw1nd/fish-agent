// 展示层纯函数：不触碰 DOM，不读取全局状态，便于 node:test 覆盖。

const DAY_MS = 86_400_000;
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value).trim();
  if (!text) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value, { timeZone } = {}) {
  const date = parseDate(value);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(timeZone ? { timeZone } : {})
    }).format(date);
  } catch {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}

export function formatDateTime(value, { timeZone } = {}) {
  const date = parseDate(value);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timeZone ? { timeZone } : {})
    }).format(date);
  } catch {
    return `${formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
}

export function formatClock(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

export function formatRelative(value, now = Date.now()) {
  const date = parseDate(value);
  if (!date) return '—';
  const diff = now - date.getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 45_000) return '刚刚';
  if (abs < 3_600_000) return `${Math.max(1, Math.round(abs / 60_000))} 分钟${suffix}`;
  if (abs < DAY_MS) return `${Math.max(1, Math.round(abs / 3_600_000))} 小时${suffix}`;
  if (abs < 30 * DAY_MS) return `${Math.max(1, Math.round(abs / DAY_MS))} 天${suffix}`;
  return formatDate(date);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.max(0, Math.round(ms));
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return seconds > 0 && minutes < 10 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${minutes} 分钟`;
  return `${seconds} 秒`;
}

export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatNumber(value, maximumFractionDigits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(num);
}

export function formatTokens(value, { compact = true } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (!compact) return formatNumber(num);
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${trimZero(num / 1e9)}B`;
  if (abs >= 1e6) return `${trimZero(num / 1e6)}M`;
  if (abs >= 1e4) return `${trimZero(num / 1e3)}K`;
  return formatNumber(Math.round(num));
}

function trimZero(value) {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

export function formatMicros(value, currency = 'CNY') {
  if (value === null || value === undefined || value === '') return '—';
  const micros = Number(value);
  if (!Number.isFinite(micros)) return '—';
  const symbol = CURRENCY_SYMBOL[String(currency).toUpperCase()] || `${currency} `;
  const sign = micros < 0 ? '-' : '';
  const abs = Math.round(Math.abs(micros));
  if (abs > 0 && abs < 100) return `${sign}<${symbol}0.0001`;
  const whole = Math.floor(abs / 1_000_000);
  const remainder = abs % 1_000_000;
  const frac = String(remainder).padStart(6, '0').slice(0, 4).replace(/0+$/, '');
  const wholeText = new Intl.NumberFormat('zh-CN').format(whole);
  if (!frac) return `${sign}${symbol}${wholeText}.00`;
  const padded = frac.length === 1 ? `${frac}0` : frac;
  return `${sign}${symbol}${wholeText}.${padded}`;
}

export function formatPercent(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const ratio = Math.max(0, Math.min(1, num));
  return `${(ratio * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function percentRatio(used, limit) {
  const u = Number(used);
  const l = Number(limit);
  if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return 0;
  return Math.max(0, Math.min(1, u / l));
}

export function expiryInfo(expiresAt, now = Date.now()) {
  const date = parseDate(expiresAt);
  if (!date) return { state: 'none', days: null, msLeft: null, label: '未设置到期时间' };
  const diff = date.getTime() - now;
  if (diff <= 0) {
    return { state: 'expired', days: 0, msLeft: diff, label: '已到期' };
  }
  const days = Math.ceil(diff / DAY_MS);
  if (days <= 3) {
    return { state: 'soon', days, msLeft: diff, label: `剩 ${days} 天` };
  }
  return { state: 'ok', days, msLeft: diff, label: `${formatDate(date)} 到期` };
}

export function maskSecret(value, { visible = 4, mask = '•' } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[•*x]{4,}$/i.test(raw)) return raw;
  if (/[•]{2,}|\*{2,}/.test(raw)) return raw;
  const prefixMatch = /^(sk|pk|ak|key|rk)[-_]/i.exec(raw);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const body = raw.slice(prefix.length);
  const keep = Math.min(visible, Math.max(0, body.length - 1));
  if (body.length <= keep + 2) return `${prefix}${mask.repeat(Math.max(6, body.length))}`;
  return `${prefix}${mask.repeat(6)}${body.slice(-keep)}`;
}

/**
 * 错误信息可能被后端原样回显；展示前统一清理常见秘密，宁可过度打码。
 * 不用于“验证是否泄漏”的断言，只用于避免把秘密渲染到界面/日志。
 */
export function redactText(value, { maxLength = 600 } = {}) {
  let text = String(value ?? '');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, (match) => maskSecret(match));
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••');
  const secretName = '(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|token|password|passwd|secret|cookie|sessdata|bili_jct|dedeuserid)';
  text = text.replace(
    new RegExp(`(${secretName})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`, 'gi'),
    (_match, key, separator) => `${key}${separator}••••`
  );
  text = text.replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\n\r]+/gi, '$1: ••••');
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
}

export function safeImageSrc(raw, { origin } = {}) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || /[\u0000-\u001f\\]/.test(text)) return null;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(text)) return text;
  if (/^[A-Za-z0-9+/=\r\n]{64,}$/.test(text)) {
    const compact = text.replace(/\s+/g, '');
    if (compact.length >= 64) return `data:image/png;base64,${compact}`;
  }
  let url;
  try {
    url = new URL(text, origin || (typeof location !== 'undefined' ? location.origin : 'http://localhost'));
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return text;
  if (url.protocol === 'http:' && origin && url.origin === origin) return text;
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  return null;
}

export function safeLink(raw, { origin } = {}) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || /[\u0000-\u001f\\]/.test(text)) return null;
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  try {
    const url = new URL(text, origin || (typeof location !== 'undefined' ? location.origin : 'http://localhost'));
    if (url.protocol === 'https:' || url.protocol === 'http:') return text;
  } catch {
    return null;
  }
  return null;
}

export function initials(name) {
  const text = String(name ?? '').trim();
  if (!text) return 'F';
  const first = Array.from(text)[0] || 'F';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

export function statusTone(value) {
  const text = String(value ?? '').toLowerCase();
  if (['ok', 'online', 'running', 'active', 'connected', 'logged_in', 'loggedin', 'confirmed', 'success', 'healthy', 'ready'].includes(text)) return 'ok';
  if (['warn', 'warning', 'waiting', 'waiting_login', 'starting', 'preparing', 'pending', 'scanned', 'soon', 'expiring'].includes(text)) return 'warn';
  if (['error', 'failed', 'invalid', 'offline', 'expired', 'danger', 'blocked', 'quota_exceeded'].includes(text)) return 'danger';
  if (['info', 'info_scan', 'waiting_confirm'].includes(text)) return 'info';
  return 'neutral';
}

export function truncate(text, max = 120) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
