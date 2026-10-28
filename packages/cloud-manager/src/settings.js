import { decryptText, encryptText } from './crypto.js';
import { now } from './util.js';

export class SettingsStore {
  constructor(db, masterKey) {
    this.db = db;
    this.masterKey = masterKey;
  }

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value_enc FROM settings WHERE key = ?').get(String(key));
    if (!row) return fallback;
    try {
      return JSON.parse(decryptText(this.masterKey, row.value_enc, `setting:${key}`));
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    const sealed = encryptText(this.masterKey, JSON.stringify(value), `setting:${key}`);
    this.db.prepare(`
      INSERT INTO settings (key, value_enc, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at
    `).run(String(key), sealed, now());
  }

  has(key) {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM settings WHERE key = ?').get(String(key)));
  }

  delete(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(String(key));
  }
}
