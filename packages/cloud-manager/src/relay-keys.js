import { id, now, randomToken, sha256 } from './util.js';
import { immediateTransaction } from './db.js';

export class RelayKeyService {
  constructor({ db, secrets, config, logger }) {
    this.db = db;
    this.secrets = secrets;
    this.config = config;
    this.logger = logger;
  }

  issue(tenantId) {
    const key = `${this.config.relayKeyPrefix}${randomToken(24)}`;
    return this.bind(tenantId, key, { generated: true });
  }

  bind(tenantId, rawKey, { generated = false } = {}) {
    const key = String(rawKey ?? '').trim();
    if (key.length < 6 || key.length > 512) {
      throw Object.assign(new Error('Relay Key 长度需在 6-512 个字符之间'), { status: 400, code: 'INVALID_RELAY_KEY' });
    }
    if (/[\u0000-\u001f\u007f\s]/.test(key)) {
      throw Object.assign(new Error('Relay Key 不能包含空白或控制字符'), { status: 400, code: 'INVALID_RELAY_KEY' });
    }
    const keyHash = sha256(key);
    const existing = this.db.prepare('SELECT * FROM relay_keys WHERE key_hash = ?').get(keyHash);
    if (existing && existing.tenant_id !== tenantId) {
      throw Object.assign(new Error('该 Relay Key 已绑定到其他租户'), { status: 409, code: 'RELAY_KEY_IN_USE' });
    }
    const keyPrefix = key.slice(0, Math.min(15, Math.max(6, key.length)));
    const keyId = existing?.id || id('rkey');
    const ts = now();
    immediateTransaction(this.db, () => {
      this.db.prepare(`UPDATE relay_keys SET revoked_at = ?
        WHERE tenant_id = ? AND revoked_at IS NULL AND id != ?`).run(ts, tenantId, keyId);
      if (existing) {
        this.db.prepare(`UPDATE relay_keys SET revoked_at = NULL, key_prefix = ?, created_at = ? WHERE id = ?`)
          .run(keyPrefix, ts, keyId);
      } else {
        this.db.prepare(`
          INSERT INTO relay_keys (id, tenant_id, key_hash, key_prefix, created_at, revoked_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, NULL, NULL)
        `).run(keyId, tenantId, keyHash, keyPrefix, ts);
      }
    });
    this.secrets.set(tenantId, 'relay.key', key);
    return { id: keyId, key, prefix: keyPrefix, createdAt: ts, bound: !generated };
  }

  active(tenantId) {
    return this.db.prepare(`
      SELECT id, tenant_id, key_prefix, created_at, last_used_at
      FROM relay_keys WHERE tenant_id = ? AND revoked_at IS NULL LIMIT 1
    `).get(tenantId) || null;
  }

  plaintext(tenantId) {
    return this.secrets.get(tenantId, 'relay.key', null);
  }

  revoke(tenantId) {
    const ts = now();
    this.db.prepare('UPDATE relay_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL').run(ts, tenantId);
    this.secrets.delete(tenantId, 'relay.key');
  }

  authenticate(rawKey) {
    const key = String(rawKey || '');
    if (!key || key.length < 6 || key.length > 512) return null;
    const row = this.db.prepare(`
      SELECT rk.*, t.status AS tenant_status, t.expires_at, t.plan_id, t.slug, t.name
      FROM relay_keys rk JOIN tenants t ON t.id = rk.tenant_id
      WHERE rk.key_hash = ? AND rk.revoked_at IS NULL
    `).get(sha256(key));
    if (!row) return null;
    if (row.tenant_status !== 'active' || Number(row.expires_at) <= now()) {
      return { error: 'tenant_expired', row };
    }
    if (!row.last_used_at || now() - row.last_used_at > 30_000) {
      this.db.prepare('UPDATE relay_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
    }
    return { row };
  }
}
