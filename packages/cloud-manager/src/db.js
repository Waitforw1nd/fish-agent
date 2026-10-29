import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.js';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data_dir TEXT NOT NULL,
        agent_port INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_owner ON tenants(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_tenants_expiry ON tenants(expires_at);

      CREATE TABLE IF NOT EXISTS memberships (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

      CREATE TABLE IF NOT EXISTS tenant_keys (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        wrapped_dek TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_secrets (
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE IF NOT EXISTS port_leases (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        released_at INTEGER,
        meta TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_port_leases_active_port
        ON port_leases(port) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_port_leases_tenant ON port_leases(tenant_id, purpose);

      CREATE TABLE IF NOT EXISTS qq_accounts (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        driver TEXT NOT NULL,
        uin TEXT,
        expected_uin TEXT,
        nickname TEXT,
        state TEXT NOT NULL DEFAULT 'unprepared',
        webui_port INTEGER,
        ob11_port INTEGER,
        http_port INTEGER,
        auth_source TEXT,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bili_config (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL,
        control_port INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_relay_keys_tenant ON relay_keys(tenant_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_keys_active
        ON relay_keys(tenant_id) WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS wallets (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        balance_micros INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        amount_micros INTEGER NOT NULL,
        kind TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_tx_tenant ON wallet_transactions(tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL REFERENCES relay_keys(id),
        model TEXT NOT NULL,
        estimated_micros INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'released', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        settled_at INTEGER,
        actual_micros INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cached_tokens INTEGER,
        upstream_status INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON reservations(status, expires_at);

      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key_id TEXT,
        reservation_id TEXT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        upstream_status INTEGER,
        request_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_tenant_created ON ledger(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_model ON ledger(tenant_id, model);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        tenant_id TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS process_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        exit_code INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_process_runs_tenant ON process_runs(tenant_id, started_at);

      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backups_tenant ON backups(tenant_id, created_at);
    `
  },
  {
    version: 2,
    sql: `ALTER TABLE tenants ADD COLUMN default_model TEXT;`
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS tenant_relay_custom (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        request_id TEXT,
        model TEXT NOT NULL,
        status INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        source TEXT NOT NULL CHECK (source IN ('platform', 'custom')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_logs_tenant_created ON relay_logs(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_relay_logs_filters ON relay_logs(tenant_id, model, status, created_at);

      CREATE TABLE IF NOT EXISTS recharges (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        confirmed_by_user_id TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_recharges_tenant_created ON recharges(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recharges_pending ON recharges(status, created_at);
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE ledger ADD COLUMN platform TEXT;
      ALTER TABLE ledger ADD COLUMN chat_key TEXT;
      ALTER TABLE ledger ADD COLUMN run_id TEXT;
      ALTER TABLE ledger ADD COLUMN vision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ledger ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'unknown';
      CREATE INDEX idx_ledger_attribution ON ledger(tenant_id, platform, chat_key, created_at);
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE qq_runtimes (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL, driver TEXT NOT NULL, generation INTEGER NOT NULL,
        container_id TEXT, network_id TEXT, image TEXT, desired_state TEXT NOT NULL,
        state TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 6,
    sql: `ALTER TABLE qq_runtimes ADD COLUMN image_id TEXT;
          ALTER TABLE qq_runtimes ADD COLUMN spec_json TEXT;`
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS qq_accounts (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        driver TEXT NOT NULL, uin TEXT, expected_uin TEXT, nickname TEXT,
        state TEXT NOT NULL DEFAULT 'unprepared', webui_port INTEGER, ob11_port INTEGER,
        http_port INTEGER, auth_source TEXT, last_error TEXT, updated_at INTEGER NOT NULL
      );
      ALTER TABLE qq_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE qq_accounts ADD COLUMN effective_profile_id TEXT;
      ALTER TABLE qq_accounts ADD COLUMN effective_runtime_id TEXT;
      CREATE TABLE qq_profiles (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        driver TEXT NOT NULL, expected_uin TEXT NOT NULL, directory TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (tenant_id, driver, expected_uin)
      );
      CREATE TABLE qq_operations (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
        phase TEXT NOT NULL, source_driver TEXT, target_driver TEXT NOT NULL,
        expected_uin TEXT NOT NULL, expected_revision INTEGER NOT NULL,
        source_json TEXT, target_json TEXT, runtime_generation INTEGER, qr_generation INTEGER NOT NULL DEFAULT 0,
        agent_was_running INTEGER NOT NULL DEFAULT 0, error_json TEXT, rollback_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (tenant_id, idempotency_key)
      );
      CREATE UNIQUE INDEX qq_operations_one_active ON qq_operations(tenant_id)
        WHERE status IN ('running', 'needs_attention');
      CREATE TABLE qq_account_claims (
        uin TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        operation_id TEXT, runtime_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX qq_profiles_tenant ON qq_profiles(tenant_id);
    `
  },
  {
    version: 8,
    sql: `ALTER TABLE qq_accounts ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE qq_accounts ADD COLUMN runtime_secret_namespace TEXT;`
  }
];

export function openDatabase(dbPath) {
  ensureDir(path.dirname(dbPath), 0o700);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }
}

export function immediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

let savepointSeq = 0;
export function transaction(db, fn) {
  const name = `sp_${process.pid}_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}`); } catch { /* ignore */ }
    try { db.exec(`RELEASE ${name}`); } catch { /* ignore */ }
    throw error;
  }
}

export function checkDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    return row?.integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
