import { id, now, truncate } from './util.js';

export class AuditLog {
  constructor(db) {
    this.db = db;
  }

  record({ actorUserId = null, tenantId = null, action, detail = null, ip = null }) {
    this.db.prepare(`
      INSERT INTO audit_log (id, actor_user_id, tenant_id, action, detail, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id('aud'), actorUserId, tenantId, String(action), detail === null ? null : truncate(JSON.stringify(detail), 4000), ip, now());
  }

  list(tenantId, limit = 100) {
    return this.db.prepare(`
      SELECT id, actor_user_id, tenant_id, action, detail, ip, created_at
      FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(tenantId, Math.max(1, Math.min(500, Number(limit) || 100)));
  }
}
