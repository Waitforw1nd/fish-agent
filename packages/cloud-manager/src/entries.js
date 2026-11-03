import { httpError } from './contracts/http.js';
import { getPlan } from './plans.js';
import { ENTRY_TYPES } from './entry-types.js';
import { transaction } from './db.js';

export { ENTRY_TYPES } from './entry-types.js';

// Persist only explicit choices; older tenants retain their prepared channels.
export class TenantEntryService {
  constructor({ db, tenants }) { this.db = db; this.tenants = tenants; }
  row(tenantId, entry) {
    return this.db.prepare('SELECT * FROM tenant_entries WHERE tenant_id=? AND entry=?').get(tenantId, entry);
  }
  enabled(tenantId, entry) {
    if (entry === 'qq_protocol' || entry === 'qq_official') {
      const account = this.db.prepare('SELECT driver FROM qq_accounts WHERE tenant_id=?').get(tenantId);
      if (!account || (entry === 'qq_official') !== (account.driver === 'qqbot')) return false;
      const row = this.row(tenantId, entry);
      return row ? Boolean(row.enabled) : true;
    }
    const row = this.row(tenantId, entry);
    if (row) return Boolean(row.enabled);
    if (entry === 'desktop') return false;
    if (entry === 'bili') {
      const bili = this.db.prepare('SELECT config_json FROM bili_config WHERE tenant_id=?').get(tenantId);
      try { return Boolean(bili && JSON.parse(bili.config_json).enabled); } catch { return false; }
    }
    return false;
  }
  list(tenantId) {
    return Object.fromEntries(ENTRY_TYPES.map(entry => [entry, { enabled: this.enabled(tenantId, entry) }]));
  }
  setEnabled(tenant, entry, enabled) {
    if (!ENTRY_TYPES.includes(entry) || typeof enabled !== 'boolean') throw httpError(400, 'INVALID_ENTRY', '接入方式或启停参数无效');
    const allowed = getPlan(tenant.plan_id)?.entries || ENTRY_TYPES;
    if (enabled && !allowed.includes(entry)) throw httpError(403, 'ENTRY_NOT_IN_PLAN', '当前套餐未开放此入口');
    if (enabled && entry.startsWith('qq_')) {
      const account = this.db.prepare('SELECT driver FROM qq_accounts WHERE tenant_id=?').get(tenant.id);
      if (!account || (entry === 'qq_official') !== (account.driver === 'qqbot')) {
        throw httpError(409, 'QQ_ENTRY_NOT_PREPARED', '请先在 QQ 配置中选择并准备对应的接入方式');
      }
    }
    const write = this.db.prepare('INSERT INTO tenant_entries(tenant_id,entry,enabled,updated_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id,entry) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at');
    transaction(this.db, () => {
      write.run(tenant.id, entry, Number(enabled), Date.now());
      if (enabled && entry.startsWith('qq_')) write.run(tenant.id, entry === 'qq_official' ? 'qq_protocol' : 'qq_official', 0, Date.now());
    });
    return this.list(tenant.id);
  }
}
