import { hashPassword } from './crypto.js';
import { immediateTransaction } from './db.js';

function userError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class UsersService {
  constructor(db) {
    this.db = db;
  }

  byId(userId) {
    return this.db.prepare('SELECT id, username, role, disabled, created_at, last_login_at FROM users WHERE id = ?')
      .get(userId) || null;
  }

  byUsername(username) {
    const name = String(username || '').trim();
    if (!name) return null;
    return this.db.prepare('SELECT id, username, role, disabled, created_at, last_login_at FROM users WHERE username = ?')
      .get(name) || null;
  }

  list() {
    return this.db.prepare(`
      SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM tenants t WHERE t.owner_user_id = u.id) AS tenantCount
      FROM users u ORDER BY u.created_at ASC
    `).all();
  }

  update(userId, changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw userError(400, 'INVALID_BODY', '请求体必须是对象');
    }
    if (changes.role !== undefined && !['admin', 'user'].includes(changes.role)) {
      throw userError(400, 'INVALID_ROLE', '非法角色');
    }
    if (changes.disabled !== undefined && typeof changes.disabled !== 'boolean') {
      throw userError(400, 'INVALID_DISABLED', 'disabled 必须是布尔值');
    }
    let passwordHash;
    if (changes.password !== undefined) {
      if (typeof changes.password !== 'string' || changes.password.length < 8) {
        throw userError(400, 'WEAK_PASSWORD', '密码至少 8 位');
      }
      passwordHash = hashPassword(changes.password);
    }
    return immediateTransaction(this.db, () => {
      const current = this.byId(userId);
      if (!current) throw userError(404, 'USER_NOT_FOUND', '用户不存在');
      const role = changes.role ?? current.role;
      const disabled = changes.disabled === undefined ? Boolean(current.disabled) : changes.disabled;
      if (current.role === 'admin' && !current.disabled && (role !== 'admin' || disabled)) {
        const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n);
        if (count <= 1) throw userError(409, 'LAST_ACTIVE_ADMIN', '不能禁用或降级最后一个活跃管理员');
      }
      this.db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(role, disabled ? 1 : 0, userId);
      if (passwordHash) this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
      if (disabled || passwordHash) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return this.byId(userId);
    });
  }
}
