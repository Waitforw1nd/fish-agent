import crypto from 'node:crypto';
import { safeEqual } from './util.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (![N, r, p].every(Number.isInteger) || N > 1 << 20 || r > 32 || p > 16) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N, r, p, maxmem: 128 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function encrypt(key, plaintext, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(key, sealed, aad = '') {
  if (!sealed || !sealed.iv || !sealed.tag || !sealed.ct) throw new Error('invalid ciphertext');
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  const ct = Buffer.from(sealed.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptText(key, plaintext, aad = '') {
  return JSON.stringify(encrypt(key, plaintext, aad));
}

export function decryptText(key, sealedText, aad = '') {
  let parsed;
  try { parsed = JSON.parse(sealedText); } catch { throw new Error('invalid sealed text'); }
  return decrypt(key, parsed, aad).toString('utf8');
}

export class KeyVault {
  constructor(db, masterKey) {
    this.db = db;
    this.masterKey = masterKey;
    this.cache = new Map();
  }

  ensureTenantKey(tenantId) {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const row = this.db.prepare('SELECT wrapped_dek, key_version FROM tenant_keys WHERE tenant_id = ?').get(tenantId);
    if (row) {
      const key = decrypt(this.masterKey, JSON.parse(row.wrapped_dek), `tenant-dek:${tenantId}:v${row.key_version}`);
      this.cache.set(tenantId, key);
      return key;
    }
    const dek = crypto.randomBytes(32);
    const sealed = JSON.stringify(encrypt(this.masterKey, dek, `tenant-dek:${tenantId}:v1`));
    this.db.prepare('INSERT INTO tenant_keys (tenant_id, wrapped_dek, key_version, created_at) VALUES (?, ?, 1, ?)')
      .run(tenantId, sealed, Date.now());
    this.cache.set(tenantId, dek);
    return dek;
  }

  drop(tenantId) {
    this.cache.delete(tenantId);
  }
}

export class TenantSecrets {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
  }

  aad(tenantId, name) {
    return `tenant-secret:${tenantId}:${name}`;
  }

  set(tenantId, name, value) {
    const key = this.vault.ensureTenantKey(tenantId);
    const sealed = encrypt(key, String(value), this.aad(tenantId, name));
    this.db.prepare(`
      INSERT INTO tenant_secrets (tenant_id, name, iv, tag, ciphertext, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, name) DO UPDATE SET
        iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
    `).run(tenantId, name, sealed.iv, sealed.tag, sealed.ct, Date.now());
  }

  get(tenantId, name, fallback = null) {
    const row = this.db.prepare('SELECT iv, tag, ciphertext FROM tenant_secrets WHERE tenant_id = ? AND name = ?')
      .get(tenantId, name);
    if (!row) return fallback;
    const key = this.vault.ensureTenantKey(tenantId);
    return decrypt(key, { iv: row.iv, tag: row.tag, ct: row.ciphertext }, this.aad(tenantId, name)).toString('utf8');
  }

  has(tenantId, name) {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM tenant_secrets WHERE tenant_id = ? AND name = ?').get(tenantId, name));
  }

  delete(tenantId, name) {
    this.db.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ? AND name = ?').run(tenantId, name);
  }

  deleteAll(tenantId) {
    this.db.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ?').run(tenantId);
  }
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function verifySessionHash(token, hash) {
  return safeEqual(hashSessionToken(token), hash);
}
