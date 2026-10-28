import crypto from 'node:crypto';
import { hashPassword, verifyPassword, hashSessionToken } from './crypto.js';
import { id, now, randomToken, safeEqual, parseCookies } from './util.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function deriveCsrf(token) {
  return crypto.createHmac('sha256', Buffer.from(String(token))).update('cloud-manager-csrf-v1').digest('base64url');
}

export class AuthService {
  constructor({ db, config, logger }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.failures = new Map();
  }

  bootstrap() {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0);
    if (count > 0) return null;
    const username = this.config.adminUsername || 'admin';
    const password = this.config.adminPassword || randomToken(18);
    const user = this.createUser({ username, password, role: 'admin' });
    return { user, password, generated: !this.config.adminPassword };
  }

  createUser({ username, password, role = 'user' }) {
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) throw Object.assign(new Error('用户名需为 3-64 位字母、数字或 _ . -'), { status: 400, code: 'INVALID_USERNAME' });
    if (String(password ?? '').length < 8) throw Object.assign(new Error('密码至少 8 位'), { status: 400, code: 'WEAK_PASSWORD' });
    if (!['admin', 'user'].includes(role)) throw Object.assign(new Error('非法角色'), { status: 400, code: 'INVALID_ROLE' });
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    if (existing) throw Object.assign(new Error('用户名已存在'), { status: 409, code: 'USERNAME_TAKEN' });
    const userId = id('usr');
    const ts = now();
    this.db.prepare('INSERT INTO users (id, username, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(userId, name, hashPassword(password), role, ts);
    return { id: userId, username: name, role, createdAt: ts };
  }

  cleanupFailures() {
    const cutoff = now() - this.config.loginWindowMs;
    for (const [key, entry] of this.failures) {
      entry.events = entry.events.filter((ts) => ts > cutoff);
      if (entry.events.length === 0) this.failures.delete(key);
    }
  }

  rateState(username, ip) {
    this.cleanupFailures();
    const key = `${ip || '-'}|${String(username || '').toLowerCase()}`;
    const entry = this.failures.get(key);
    if (!entry) return { allowed: true, remaining: this.config.loginMaxFailures };
    return {
      allowed: entry.events.length < this.config.loginMaxFailures,
      remaining: Math.max(0, this.config.loginMaxFailures - entry.events.length),
      retryAfterMs: this.config.loginWindowMs
    };
  }

  recordFailure(username, ip) {
    const key = `${ip || '-'}|${String(username || '').toLowerCase()}`;
    const entry = this.failures.get(key) || { events: [] };
    entry.events.push(now());
    this.failures.set(key, entry);
  }

  clearFailures(username, ip) {
    this.failures.delete(`${ip || '-'}|${String(username || '').toLowerCase()}`);
  }

  login({ username, password, ip, userAgent }) {
    const name = String(username || '').trim();
    const rate = this.rateState(name, ip);
    if (!rate.allowed) {
      throw Object.assign(new Error('登录尝试过多，请稍后再试'), { status: 429, code: 'LOGIN_RATE_LIMITED', retryAfterMs: rate.retryAfterMs });
    }
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    const passwordOk = row && !row.disabled && verifyPassword(password, row.password_hash);
    if (!passwordOk) {
      this.recordFailure(name, ip);
      throw Object.assign(new Error('用户名或密码错误'), { status: 401, code: 'INVALID_CREDENTIALS' });
    }
    this.clearFailures(name, ip);
    const token = randomToken(32);
    const csrf = deriveCsrf(token);
    const sessionId = id('ses');
    const ts = now();
    const expiresAt = ts + this.config.sessionTtlMs;
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, row.id, hashSessionToken(token), hashSessionToken(csrf), ts, expiresAt, ts, String(ip || '').slice(0, 128), String(userAgent || '').slice(0, 300));
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, row.id);
    return {
      token,
      csrfToken: csrf,
      expiresAt,
      user: { id: row.id, username: row.username, role: row.role },
      sessionId
    };
  }

  logout(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }

  sessionTokenFrom(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[this.config.cookieName] || '';
  }

  resolve(req) {
    const token = this.sessionTokenFrom(req);
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT s.*, u.username, u.role AS user_role, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(hashSessionToken(token));
    if (!row) return null;
    const ts = now();
    if (row.expires_at <= ts || row.disabled) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    if (ts - row.last_seen_at > this.config.sessionTouchMs) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(ts, row.id);
    }
    return {
      token,
      csrfToken: deriveCsrf(token),
      session: row,
      user: { id: row.user_id, username: row.username, role: row.user_role },
      expiresAt: row.expires_at
    };
  }

  require(req) {
    const auth = this.resolve(req);
    if (!auth) throw Object.assign(new Error('请先登录'), { status: 401, code: 'UNAUTHENTICATED' });
    return auth;
  }

  verifyCsrf(req, auth) {
    if (!auth) throw Object.assign(new Error('请先登录'), { status: 401, code: 'UNAUTHENTICATED' });
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())) return;
    const header = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || '';
    if (header && safeEqual(hashSessionToken(header), auth.session.csrf_hash)) return;
    if (this.hasSameOriginEvidence(req)) return;
    throw Object.assign(new Error('CSRF 校验失败，请刷新页面重试'), { status: 403, code: 'CSRF_FAILED' });
  }

  hasSameOriginEvidence(req) {
    const requestHost = String(req.headers.host || '').toLowerCase();
    if (!requestHost) return false;
    const matches = (raw) => {
      try {
        const parsed = new URL(raw);
        if (parsed.host.toLowerCase() !== requestHost) return false;
        return parsed.protocol === `${this.config.publicScheme}:` || (!this.config.cookieSecure && parsed.protocol === 'http:');
      } catch {
        return false;
      }
    };
    const origin = String(req.headers.origin || '').trim();
    if (origin) return matches(origin);
    const referer = String(req.headers.referer || '').trim();
    if (referer) return matches(referer);
    return String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'same-origin';
  }

  cookieHeader(token, { clear = false } = {}) {
    if (!token) return null;
    const parts = [
      `${this.config.cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (this.config.cookieSecure) parts.push('Secure');
    const domain = this.config.cookieDomain || (this.config.baseDomain !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(this.config.baseDomain) ? this.config.baseDomain : '');
    if (domain) parts.push(`Domain=${domain}`);
    if (clear) parts.push('Max-Age=0');
    else parts.push(`Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}`);
    return parts.join('; ');
  }

  isSameOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return true;
    if (this.config.devAllowAnyOrigin) return true;
    try {
      const parsed = new URL(origin);
      const requestHost = String(req.headers.host || '').toLowerCase();
      if (parsed.host.toLowerCase() !== requestHost) return false;
      if (parsed.protocol === `${this.config.publicScheme}:`) return true;
      return !this.config.cookieSecure && parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  sweepSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    this.cleanupFailures();
  }
}
