import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const now = () => Date.now();

export function id(prefix = '') {
  const v = crypto.randomUUID();
  return prefix ? `${prefix}_${v}` : v;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isValidSlug(slug) {
  return typeof slug === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)
    && !slug.includes('--');
}

export const RESERVED_SLUGS = new Set([
  'www', 'api', 'panel', 'admin', 'relay', 'app', 'auth', 'login',
  'static', 'assets', 'health', 'status', 'docs', 'support'
]);

export function assertSafeRelativePath(relative) {
  if (typeof relative !== 'string' || !relative) throw new Error('empty path');
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`absolute path rejected: ${relative}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error(`unsafe path rejected: ${relative}`);
  }
  return normalized;
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* best effort on Windows */ }
  return dir;
}

export function writeFilePrivate(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode });
  try { fs.chmodSync(file, mode); } catch { /* best effort on Windows */ }
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonPrivate(file, value, mode = 0o600) {
  writeFilePrivate(file, JSON.stringify(value, null, 2), mode);
}

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(patch);
  if (typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function take(obj, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(obj, key)) out[key] = obj[key];
  return out;
}

export function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function truncate(value, max = 300) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function redactSecrets(input) {
  let text = String(input ?? '');
  text = text.replace(/(data:image\/[a-z+]+;base64,)[A-Za-z0-9+/=]{80,}/gi, '$1[redacted-qr]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted-key]');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  text = text.replace(/((?:token|secret|password|apikey|api_key|cookie|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;}]{4,}/gi, '$1[redacted]');
  text = text.replace(/([?&](?:token|key|password|secret|cookie)=)[^&\s]+/gi, '$1[redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]');
  return text;
}

export function parseCookies(header) {
  const out = {};
  for (const piece of String(header ?? '').split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    const key = piece.slice(0, index).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(piece.slice(index + 1).trim()); } catch { out[key] = piece.slice(index + 1).trim(); }
  }
  return out;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function isLoopbackHost(host) {
  const value = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}
