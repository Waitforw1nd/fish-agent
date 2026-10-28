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
    return this.db.prepare('SELECT id, username, role, disabled, created_at, last_login_at FROM users ORDER BY created_at ASC')
      .all();
  }
}
