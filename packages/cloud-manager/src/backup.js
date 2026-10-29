import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decrypt, encrypt } from './crypto.js';
import { ensureDir, assertSafeRelativePath, now, id } from './util.js';

const MAGIC = Buffer.from('FISHBK1\n');
const FORMAT = 'fish-backup/1';
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', 'logs', 'log', 'temp', 'tmp', 'cache', 'caches', 'backups', '__pycache__']);
const EXCLUDED_SUFFIX = ['.log', '.pid', '.sock', '.lock', '.tmp', '.exe', '.dll', '.node', '.so', '.dylib', '.pak'];

function fail(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function collectFiles(root, config) {
  const files = [];
  let total = 0;
  const visit = (dir, relative) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      throw fail(500, 'BACKUP_READ_FAILED', `无法读取目录 ${relative || '.'}: ${error.message}`);
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_SEGMENTS.has(entry.name.toLowerCase())) continue;
        visit(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXCLUDED_SUFFIX.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) continue;
      const stat = fs.statSync(abs);
      if (stat.size > config.backupMaxFileBytes) {
        throw fail(413, 'BACKUP_FILE_TOO_LARGE', `文件 ${rel} 超过备份单文件上限`);
      }
      total += stat.size;
      if (total > config.backupMaxTotalBytes) throw fail(413, 'BACKUP_TOO_LARGE', '租户数据超过备份总量上限');
      files.push({ rel, abs, size: stat.size, mode: stat.mode & 0o777 });
    }
  };
  visit(root, '');
  return files;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function isManagedExtensionPath(relative) {
  const value = relative.toLowerCase();
  return value === 'admin-extensions' || value.startsWith('admin-extensions/')
    || value === 'data/blocked-extensions.json' || value.startsWith('data/blocked-extensions.json/');
}

function preserveManagedExtensions(currentRoot, staging) {
  for (const relative of ['admin-extensions', 'data/blocked-extensions.json']) {
    const source = path.join(currentRoot, ...relative.split('/'));
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (relative === 'admin-extensions' ? !stat.isDirectory() : !stat.isFile())) {
      throw fail(409, 'INVALID_EXTENSION_PATH', '管理员扩展目录或屏蔽列表不是普通文件');
    }
    const target = path.join(staging, ...relative.split('/'));
    ensureDir(path.dirname(target), 0o700);
    fs.cpSync(source, target, {
      recursive: stat.isDirectory(),
      filter: (entry) => !fs.lstatSync(entry).isSymbolicLink()
    });
  }
}

export class BackupService {
  constructor({ config, db, tenants, hosting, secrets, vault, qq, bili, agent, logger }) {
    this.config = config;
    this.db = db;
    this.tenants = tenants;
    this.hosting = hosting;
    this.secrets = secrets;
    this.vault = vault;
    this.qq = qq;
    this.bili = bili;
    this.agent = agent;
    this.logger = logger;
  }

  exportState(tenantId) {
    const tenant = this.tenants.row(tenantId);
    if (!tenant) throw fail(404, 'TENANT_NOT_FOUND', '租户不存在');
    const key = this.db.prepare('SELECT * FROM tenant_keys WHERE tenant_id = ?').get(tenantId) || null;
    const secretRows = rows(this.db, `SELECT name, iv, tag, ciphertext FROM tenant_secrets WHERE tenant_id = ?
      AND (name LIKE 'qq.%' OR name LIKE 'bili.%' OR name LIKE 'agent.%')`, tenantId);
    const qq = this.db.prepare('SELECT * FROM qq_accounts WHERE tenant_id = ?').get(tenantId) || null;
    const bili = this.db.prepare('SELECT * FROM bili_config WHERE tenant_id = ?').get(tenantId) || null;
    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        planId: tenant.plan_id
      },
      tenantKey: key ? { wrappedDek: key.wrapped_dek, keyVersion: key.key_version } : null,
      secrets: secretRows,
      qq: qq ? {
        driver: qq.driver,
        uin: qq.uin,
        expectedUin: qq.expected_uin,
        nickname: qq.nickname,
        state: qq.state,
        webuiPort: qq.webui_port,
        ob11Port: qq.ob11_port,
        httpPort: qq.http_port,
        authSource: qq.auth_source
      } : null,
      bili: bili ? { config: safeJson(bili.config_json), controlPort: bili.control_port } : null
    };
  }

  async create(tenantId, { actor = null } = {}) {
    const tenant = this.tenants.row(tenantId);
    if (!tenant) throw fail(404, 'TENANT_NOT_FOUND', '租户不存在');
    const state = this.exportState(tenantId);
    const files = collectFiles(tenant.data_dir, this.config);
    const fileEntries = [];
    const chunks = [];
    for (const file of files) {
      const data = fs.readFileSync(file.abs);
      fileEntries.push({ path: file.rel, size: data.length, sha256: sha256Buffer(data), mode: file.mode });
      chunks.push(data);
    }
    const header = {
      format: FORMAT,
      tenantId,
      createdAt: now(),
      state,
      files: fileEntries
    };
    const headerBuffer = Buffer.from(JSON.stringify(header));
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(headerBuffer.length, 0);
    const inner = Buffer.concat([MAGIC, lengthBuffer, headerBuffer, ...chunks]);
    const compressed = zlib.gzipSync(inner, { level: 6 });
    const sealed = encrypt(this.config.masterKey, compressed, `backup:${tenantId}:v1`);
    const backupId = id('bak');
    const outer = Buffer.from(JSON.stringify({
      format: FORMAT,
      tenantId,
      createdAt: header.createdAt,
      id: backupId,
      encryption: 'aes-256-gcm',
      iv: sealed.iv,
      tag: sealed.tag,
      data: sealed.ct
    }));
    const dir = path.join(this.config.backupDir, tenantId);
    ensureDir(dir, 0o700);
    const filePath = path.join(dir, `${backupId}.fmbackup`);
    fs.writeFileSync(filePath, outer, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
    const digest = sha256Buffer(outer);
    this.db.prepare(`
      INSERT INTO backups (id, tenant_id, file_path, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(backupId, tenantId, filePath, digest, outer.length, header.createdAt);
    this.logger?.info?.('tenant backup created', { tenantId, backupId, size: outer.length, files: files.length });
    return {
      id: backupId,
      tenantId,
      createdAt: header.createdAt,
      sha256: digest,
      sizeBytes: outer.length,
      fileCount: files.length
    };
  }

  list(tenantId) {
    return rows(this.db, 'SELECT id, tenant_id, sha256, size_bytes, created_at FROM backups WHERE tenant_id = ? ORDER BY created_at DESC', tenantId)
      .map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at
      }));
  }

  readArchive(tenantId, backupId) {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ? AND tenant_id = ?').get(backupId, tenantId);
    if (!row) throw fail(404, 'BACKUP_NOT_FOUND', '备份不存在');
    if (!fs.existsSync(row.file_path)) throw fail(404, 'BACKUP_FILE_MISSING', '备份文件已丢失');
    const outer = fs.readFileSync(row.file_path);
    if (sha256Buffer(outer) !== row.sha256) throw fail(409, 'BACKUP_HASH_MISMATCH', '备份文件哈希校验失败');
    let parsed;
    try { parsed = JSON.parse(outer.toString('utf8')); } catch { throw fail(409, 'BACKUP_INVALID', '备份格式无效'); }
    if (parsed.format !== FORMAT || parsed.tenantId !== tenantId) throw fail(409, 'BACKUP_INVALID', '备份格式或租户不匹配');
    let compressed;
    try {
      compressed = decrypt(this.config.masterKey, { iv: parsed.iv, tag: parsed.tag, ct: parsed.data }, `backup:${tenantId}:v1`);
    } catch {
      throw fail(409, 'BACKUP_DECRYPT_FAILED', '备份解密失败（主密钥不匹配或文件损坏）');
    }
    let inner;
    try {
      inner = zlib.gunzipSync(compressed, { maxOutputLength: this.config.backupMaxTotalBytes + 32 * 1024 * 1024 });
    } catch {
      throw fail(409, 'BACKUP_INVALID', '备份解压失败');
    }
    if (!inner.subarray(0, MAGIC.length).equals(MAGIC)) throw fail(409, 'BACKUP_INVALID', '备份魔数不匹配');
    const headerLength = inner.readUInt32BE(MAGIC.length);
    if (headerLength <= 0 || headerLength > 16 * 1024 * 1024) throw fail(409, 'BACKUP_INVALID', '备份头长度非法');
    const headerStart = MAGIC.length + 4;
    let header;
    try { header = JSON.parse(inner.subarray(headerStart, headerStart + headerLength).toString('utf8')); } catch { throw fail(409, 'BACKUP_INVALID', '备份头解析失败'); }
    if (header.format !== FORMAT || header.tenantId !== tenantId) throw fail(409, 'BACKUP_INVALID', '备份格式或租户不匹配');
    if (!Array.isArray(header.files) || header.files.length > 200_000) throw fail(409, 'BACKUP_INVALID', '备份文件清单非法');
    const contentStart = headerStart + headerLength;
    const files = [];
    let offset = contentStart;
    let total = 0;
    const seen = new Set();
    for (const entry of header.files) {
      const rel = assertSafeRelativePath(entry.path);
      if (seen.has(rel)) throw fail(409, 'BACKUP_INVALID', `备份包含重复路径 ${rel}`);
      seen.add(rel);
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > this.config.backupMaxFileBytes) throw fail(409, 'BACKUP_INVALID', `备份文件大小非法 ${rel}`);
      total += size;
      if (total > this.config.backupMaxTotalBytes) throw fail(409, 'BACKUP_INVALID', '备份文件总量超限');
      if (offset + size > inner.length) throw fail(409, 'BACKUP_INVALID', '备份内容截断');
      const data = inner.subarray(offset, offset + size);
      offset += size;
      if (sha256Buffer(data) !== entry.sha256) throw fail(409, 'BACKUP_HASH_MISMATCH', `备份文件哈希不匹配 ${rel}`);
      files.push({ path: rel, data, mode: Number(entry.mode) & 0o777 || 0o600 });
    }
    if (offset !== inner.length) throw fail(409, 'BACKUP_INVALID', '备份尾部含未知数据');
    return { header, files };
  }

  async restore(tenantId, backupId, { actor = null, restart = null } = {}) {
    const restore = () => {
      const tenant = this.tenants.row(tenantId);
      if (!tenant) throw fail(404, 'TENANT_NOT_FOUND', '租户不存在');
      const run = () => this.restoreUnlocked(tenantId, backupId, { actor, restart });
      return this.extensionService?.agentSettings
        ? this.extensionService.agentSettings.locked(tenant, run)
        : run();
    };
    if (this.extensionService) {
      return this.extensionService.withLock(`tenant:${tenantId}`, restore);
    }
    return restore();
  }

  async restoreUnlocked(tenantId, backupId, { actor = null, restart = null } = {}) {
    const tenant = this.tenants.row(tenantId);
    if (!tenant) throw fail(404, 'TENANT_NOT_FOUND', '租户不存在');
    const archive = this.readArchive(tenantId, backupId);
    const wasRunning = restart === null
      ? this.agent.supervisor.status(tenantId, 'agent').state === 'running'
      : Boolean(restart);
    const staging = `${tenant.data_dir}.restore-${Date.now()}`;
    const rollbackDir = `${tenant.data_dir}.rollback-${Date.now()}`;
    const snapshot = this.snapshotRuntime(tenantId);
    let movedOld = false;
    let swapped = false;
    try {
      ensureDir(staging, 0o700);
      for (const file of archive.files) {
        if (actor?.role !== 'admin' && isManagedExtensionPath(file.path)) continue;
        const target = path.join(staging, ...file.path.split('/'));
        ensureDir(path.dirname(target), 0o700);
        fs.writeFileSync(target, file.data, { mode: file.mode });
      }
      await this.hosting.stop(tenant, { reason: 'restore' });
      if (actor?.role !== 'admin') preserveManagedExtensions(tenant.data_dir, staging);
      try {
        if (fs.existsSync(tenant.data_dir)) {
          fs.renameSync(tenant.data_dir, rollbackDir);
          movedOld = true;
        }
        fs.renameSync(staging, tenant.data_dir);
        swapped = true;
      } catch (error) {
        if (movedOld && !fs.existsSync(tenant.data_dir)) {
          try { fs.renameSync(rollbackDir, tenant.data_dir); } catch { /* ignore */ }
        }
        throw error;
      }
      this.importState(tenant, archive.header.state);
      this.db.prepare('UPDATE port_leases SET released_at = ? WHERE tenant_id = ? AND released_at IS NULL').run(now(), tenantId);
      this.vault.drop(tenantId);
      await this.reallocatePortsAndRewrite(tenant);
      if (wasRunning) {
        const started = await this.hosting.start(tenant);
        const health = await this.agent.health(tenant);
        if (!health.ok) throw fail(502, 'RESTORE_HEALTH_FAILED', `恢复后宿主健康检查失败: ${health.error || started.agent?.lastError || 'unknown'}`);
      }
      if (movedOld) {
        try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch { /* keep for manual recovery */ }
      }
      this.logger?.info?.('tenant restored', { tenantId, backupId });
      return { ok: true, tenantId, backupId, restoredAt: now(), restarted: wasRunning };
    } catch (error) {
      try { await this.hosting.stop(tenant, { reason: 'restore-rollback' }); } catch { /* ignore */ }
      try {
        if (swapped && fs.existsSync(tenant.data_dir)) fs.rmSync(tenant.data_dir, { recursive: true, force: true });
        if (movedOld && fs.existsSync(rollbackDir)) fs.renameSync(rollbackDir, tenant.data_dir);
      } catch (rollbackError) {
        this.logger?.error?.('restore file rollback failed', { tenantId, error: rollbackError.message });
      }
      try { this.restoreSnapshot(tenantId, snapshot); } catch (rollbackError) {
        this.logger?.error?.('restore db rollback failed', { tenantId, error: rollbackError.message });
      }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  snapshotRuntime(tenantId) {
    return {
      tenantKey: this.db.prepare('SELECT * FROM tenant_keys WHERE tenant_id = ?').get(tenantId) || null,
      secrets: rows(this.db, 'SELECT * FROM tenant_secrets WHERE tenant_id = ?', tenantId),
      qq: this.db.prepare('SELECT * FROM qq_accounts WHERE tenant_id = ?').get(tenantId) || null,
      bili: this.db.prepare('SELECT * FROM bili_config WHERE tenant_id = ?').get(tenantId) || null,
      leases: rows(this.db, 'SELECT * FROM port_leases WHERE tenant_id = ? AND released_at IS NULL', tenantId),
      agentPort: this.tenants.row(tenantId)?.agent_port ?? null
    };
  }

  restoreSnapshot(tenantId, snapshot) {
    this.vault.drop(tenantId);
    this.db.prepare('DELETE FROM tenant_keys WHERE tenant_id = ?').run(tenantId);
    this.db.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ?').run(tenantId);
    this.db.prepare('DELETE FROM qq_accounts WHERE tenant_id = ?').run(tenantId);
    this.db.prepare('DELETE FROM bili_config WHERE tenant_id = ?').run(tenantId);
    this.db.prepare('UPDATE port_leases SET released_at = ? WHERE tenant_id = ? AND released_at IS NULL').run(now(), tenantId);
    if (snapshot.tenantKey) {
      this.db.prepare('INSERT INTO tenant_keys (tenant_id, wrapped_dek, key_version, created_at) VALUES (?, ?, ?, ?)')
        .run(tenantId, snapshot.tenantKey.wrapped_dek, snapshot.tenantKey.key_version, snapshot.tenantKey.created_at);
    }
    for (const row of snapshot.secrets) {
      this.db.prepare('INSERT INTO tenant_secrets (tenant_id, name, iv, tag, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tenantId, row.name, row.iv, row.tag, row.ciphertext, row.updated_at);
    }
    if (snapshot.qq) {
      const r = snapshot.qq;
      this.db.prepare(`INSERT INTO qq_accounts (tenant_id, driver, uin, expected_uin, nickname, state, webui_port,
        ob11_port, http_port, auth_source, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tenantId, r.driver, r.uin, r.expected_uin, r.nickname, 'prepared', r.webui_port, r.ob11_port,
          r.http_port, r.auth_source, r.last_error, now());
    }
    if (snapshot.bili) {
      this.db.prepare('INSERT INTO bili_config (tenant_id, config_json, control_port, updated_at) VALUES (?, ?, ?, ?)')
        .run(tenantId, snapshot.bili.config_json, snapshot.bili.control_port, now());
    }
    for (const lease of snapshot.leases) {
      this.db.prepare(`INSERT OR IGNORE INTO port_leases (id, tenant_id, purpose, host, port, created_at, released_at, meta)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(lease.id, tenantId, lease.purpose, lease.host, lease.port, now(), lease.meta);
    }
    this.db.prepare('UPDATE tenants SET agent_port = ?, updated_at = ? WHERE id = ?').run(snapshot.agentPort, now(), tenantId);
  }

  importState(tenant, state) {
    if (!state || state.tenant?.id !== tenant.id) throw fail(409, 'BACKUP_TENANT_MISMATCH', '备份状态与当前租户不匹配');
    this.db.prepare('DELETE FROM qq_accounts WHERE tenant_id = ?').run(tenant.id);
    this.db.prepare('DELETE FROM bili_config WHERE tenant_id = ?').run(tenant.id);
    const backupKey = state.tenantKey;
    if (!backupKey) throw fail(409, 'BACKUP_INVALID', '备份缺少租户密钥');
    let backupDek;
    try {
      backupDek = decrypt(this.config.masterKey, JSON.parse(backupKey.wrappedDek), `tenant-dek:${tenant.id}:v${backupKey.keyVersion || 1}`);
    } catch {
      throw fail(409, 'BACKUP_DECRYPT_FAILED', '租户密钥解密失败');
    }
    this.db.prepare(`DELETE FROM tenant_secrets WHERE tenant_id = ?
      AND (name LIKE 'qq.%' OR name LIKE 'bili.%' OR name LIKE 'agent.%')`).run(tenant.id);
    for (const row of state.secrets || []) {
      let plain;
      try {
        plain = decrypt(backupDek, { iv: row.iv, tag: row.tag, ct: row.ciphertext }, `tenant-secret:${tenant.id}:${row.name}`).toString('utf8');
      } catch {
        throw fail(409, 'BACKUP_DECRYPT_FAILED', `备份密钥解密失败: ${row.name}`);
      }
      this.secrets.set(tenant.id, row.name, plain);
    }
    if (state.qq) {
      this.db.prepare(`INSERT INTO qq_accounts (tenant_id, driver, uin, expected_uin, nickname, state, webui_port,
        ob11_port, http_port, auth_source, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?)`)
        .run(tenant.id, state.qq.driver, state.qq.uin, state.qq.expectedUin, state.qq.nickname, 'prepared', state.qq.authSource, now());
    }
    if (state.bili) {
      this.db.prepare('INSERT INTO bili_config (tenant_id, config_json, control_port, updated_at) VALUES (?, ?, NULL, ?)')
        .run(tenant.id, JSON.stringify(state.bili.config || {}), now());
    }
  }

  async reallocatePortsAndRewrite(tenant) {
    const qqRow = this.qq.account(tenant.id);
    if (qqRow) {
      await this.qq.prepare(tenant, { driver: qqRow.driver, uin: qqRow.expected_uin, expectedUin: qqRow.expected_uin });
    }
    const biliRow = this.bili.row(tenant.id);
    if (biliRow) {
      const prepared = await this.bili.ensurePrepared(tenant);
      await this.bili.writeBridgeConfig(tenant, prepared);
    }
    await this.agent.ensure(tenant);
    this.tenants.onAgentPort?.(tenant.id, this.agent.port(tenant));
  }
}
