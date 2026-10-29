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
    return this.search({ tenantId, limit });
  }

  search({ tenantId = '', actorUserId = '', action = '', limit = 100 } = {}) {
    const conditions = [];
    const params = [];
    if (tenantId) { conditions.push('a.tenant_id = ?'); params.push(tenantId); }
    if (actorUserId) { conditions.push('a.actor_user_id = ?'); params.push(actorUserId); }
    if (action) { conditions.push('a.action = ?'); params.push(action); }
    params.push(Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100)));
    return this.db.prepare(`
      SELECT a.id, a.actor_user_id, a.tenant_id, a.action, a.detail, a.ip, a.created_at,
        u.username AS actorUsername, t.name AS tenantName
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN tenants t ON t.id = a.tenant_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?
    `).all(...params);
  }
}
