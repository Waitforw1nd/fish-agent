import path from 'node:path';
import { DEFAULT_PLAN, getPlan, PLANS } from './plans.js';
import { ensureDir, id, isValidSlug, now, RESERVED_SLUGS } from './util.js';

const ROLE_RANK = { viewer: 1, operator: 2, owner: 3 };

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

export class TenantService {
  constructor({ db, config, billing, relayKeys, audit, logger }) {
    this.db = db;
    this.config = config;
    this.billing = billing;
    this.relayKeys = relayKeys;
    this.audit = audit;
    this.logger = logger;
    this.onExpired = null;
  }

  plan(planId) {
    return getPlan(planId);
  }

  publicHost(tenant) {
    return `${tenant.slug}.${this.config.baseDomain}`;
  }

  publicUrl(tenant) {
    const host = this.publicHost(tenant);
    const isDefaultPort = (this.config.publicScheme === 'http' && this.config.panelPort === 80)
      || (this.config.publicScheme === 'https' && this.config.panelPort === 443);
    return `${this.config.publicScheme}://${host}${isDefaultPort ? '' : `:${this.config.panelPort}`}`;
  }

  row(tenantId) {
    return this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || null;
  }

  bySlug(slug) {
    return this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug || '').toLowerCase()) || null;
  }

  membership(userId, tenantId) {
    return this.db.prepare('SELECT * FROM memberships WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId) || null;
  }

  roleFor(user, tenantId) {
    if (!user) return null;
    if (user.role === 'admin') return 'admin';
    return this.membership(user.id, tenantId)?.role || null;
  }

  serialize(tenant, { role = null, includePlan = true } = {}) {
    if (!tenant) return null;
    const plan = getPlan(tenant.plan_id);
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      planId: tenant.plan_id,
      plan: includePlan && plan ? {
        id: plan.id,
        name: plan.name,
        days: plan.days,
        rpm: plan.rpm,
        tpm: plan.tpm,
        maxOutputTokens: plan.maxOutputTokens,
        models: [...plan.models]
      } : undefined,
      status: tenant.status,
      subscriptionStatus: tenant.status,
      active: tenant.status === 'active',
      running: false,
      role,
      ownerUserId: tenant.owner_user_id,
      createdAt: tenant.created_at,
      expiresAt: tenant.expires_at,
      updatedAt: tenant.updated_at,
      publicHost: this.publicHost(tenant),
      publicUrl: this.publicUrl(tenant),
      consoleUrl: this.publicUrl(tenant),
      model: tenant.default_model || null,
      agentPort: tenant.agent_port ?? null
    };
  }

  listForUser(user) {
    const rows = user.role === 'admin'
      ? this.db.prepare(`
          SELECT t.*, NULL AS member_role FROM tenants t ORDER BY t.created_at DESC
        `).all()
      : this.db.prepare(`
          SELECT t.*, m.role AS member_role FROM tenants t
          JOIN memberships m ON m.tenant_id = t.id
          WHERE m.user_id = ? ORDER BY t.created_at DESC
        `).all(user.id);
    return rows.map((row) => this.serialize(row, { role: row.member_role || 'admin' }));
  }

  listOwnedBy(userId) {
    return this.db.prepare('SELECT * FROM tenants WHERE owner_user_id = ? ORDER BY created_at DESC')
      .all(userId).map((row) => this.serialize(row, { role: 'admin' }));
  }

  assertSlug(slug) {
    const value = String(slug || '').trim().toLowerCase();
    if (!isValidSlug(value)) throw httpError(400, 'INVALID_SLUG', '子域只能使用 2-32 位小写字母、数字和单个连字符');
    if (RESERVED_SLUGS.has(value)) throw httpError(409, 'RESERVED_SLUG', '该子域为系统保留');
    if (this.bySlug(value)) throw httpError(409, 'SLUG_TAKEN', '该子域已被占用');
    return value;
  }

  create({ name, slug, planId = DEFAULT_PLAN, ownerUserId, actor = null, ip = null, days = null }) {
    const plan = getPlan(planId);
    if (!plan) throw httpError(400, 'UNKNOWN_PLAN', '未知套餐');
    const tenantName = String(name || '').trim().slice(0, 80);
    if (tenantName.length < 1) throw httpError(400, 'INVALID_NAME', '租户名称不能为空');
    const owner = this.db.prepare('SELECT id FROM users WHERE id = ?').get(ownerUserId);
    if (!owner) throw httpError(400, 'UNKNOWN_OWNER', '租户所有者不存在');
    const owned = Number(this.db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE owner_user_id = ?').get(ownerUserId)?.n ?? 0);
    if (owned >= plan.maxTenants && actor?.role !== 'admin') {
      throw httpError(403, 'TENANT_LIMIT', `当前套餐最多创建 ${plan.maxTenants} 个租户`);
    }
    let safeSlug = String(slug || '').trim().toLowerCase();
    if (!safeSlug) {
      for (let i = 0; i < 8; i += 1) {
        const candidate = `bot-${id('').replace(/-/g, '').slice(0, 8)}`;
        if (!this.bySlug(candidate) && isValidSlug(candidate) && !RESERVED_SLUGS.has(candidate)) {
          safeSlug = candidate;
          break;
        }
      }
      if (!safeSlug) throw httpError(500, 'SLUG_GENERATION_FAILED', '无法自动生成子域，请手动填写');
    } else {
      safeSlug = this.assertSlug(safeSlug);
    }
    const tenantId = id('tnt');
    const defaultModel = plan.models.includes(this.config.defaultModel) ? this.config.defaultModel : (plan.models[0] || '');
    const ts = now();
    const durationDays = Math.max(1, Math.min(3650, Number(days) || plan.days));
    const expiresAt = ts + durationDays * 24 * 60 * 60 * 1000;
    const dataDir = path.join(this.config.tenantDir, tenantId);
    ensureDir(dataDir, 0o700);
    ensureDir(path.join(dataDir, 'data'), 0o700);
    ensureDir(path.join(dataDir, 'qq'), 0o700);
    ensureDir(path.join(dataDir, 'bili'), 0o700);
    this.db.prepare(`
      INSERT INTO tenants (id, slug, name, plan_id, owner_user_id, status, created_at, expires_at, updated_at, data_dir, agent_port, default_model)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?)
    `).run(tenantId, safeSlug, tenantName, plan.id, ownerUserId, ts, expiresAt, ts, dataDir, defaultModel || null);
    this.db.prepare('INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(ownerUserId, tenantId, 'owner', ts);
    this.billing.ensureWallet(tenantId, plan.creditMicros);
    const relayKey = this.relayKeys.issue(tenantId);
    const tenant = this.row(tenantId);
    this.audit.record({
      actorUserId: actor?.id ?? null,
      tenantId,
      action: 'tenant.create',
      detail: { slug: safeSlug, planId: plan.id, ownerUserId, relayKeyId: relayKey.id },
      ip
    });
    return this.serialize(tenant, { role: operatorRole(actor, ownerUserId) });
  }

  require(tenantId, user, minRole = 'viewer') {
    const tenant = this.row(String(tenantId || ''));
    if (!tenant) throw httpError(404, 'TENANT_NOT_FOUND', '租户不存在');
    const role = this.roleFor(user, tenant.id);
    if (!role) throw httpError(403, 'TENANT_FORBIDDEN', '无权访问该租户');
    if (role !== 'admin' && ROLE_RANK[role] < ROLE_RANK[minRole]) {
      throw httpError(403, 'INSUFFICIENT_ROLE', '当前角色无权执行此操作');
    }
    this.refreshExpiry(tenant);
    return { tenant: this.row(tenant.id), role };
  }

  assertActive(tenant) {
    if (tenant.status === 'expired' || Number(tenant.expires_at) <= now()) {
      throw httpError(402, 'TENANT_EXPIRED', '租户已到期，请续费后继续使用', { expiresAt: tenant.expires_at });
    }
    if (tenant.status === 'suspended') throw httpError(403, 'TENANT_SUSPENDED', '租户已被暂停');
  }

  refreshExpiry(tenant) {
    if (tenant.status === 'active' && Number(tenant.expires_at) <= now()) {
      this.db.prepare("UPDATE tenants SET status = 'expired', updated_at = ? WHERE id = ?").run(now(), tenant.id);
      tenant.status = 'expired';
      this.audit.record({ tenantId: tenant.id, action: 'tenant.expire', detail: { expiresAt: tenant.expires_at } });
      if (this.onExpired) Promise.resolve(this.onExpired(tenant.id)).catch((error) => this.logger?.error?.('expiry stop failed', error));
      return true;
    }
    return false;
  }

  sweepExpired() {
    const rows = this.db.prepare("SELECT * FROM tenants WHERE status = 'active' AND expires_at <= ?").all(now());
    for (const tenant of rows) {
      this.db.prepare("UPDATE tenants SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'").run(now(), tenant.id);
      this.audit.record({ tenantId: tenant.id, action: 'tenant.expire', detail: { expiresAt: tenant.expires_at } });
      if (this.onExpired) Promise.resolve(this.onExpired(tenant.id)).catch((error) => this.logger?.error?.('expiry stop failed', error));
    }
    return rows.length;
  }

  setAgentPort(tenantId, port) {
    this.db.prepare('UPDATE tenants SET agent_port = ?, updated_at = ? WHERE id = ?').run(port, now(), tenantId);
  }

  setDefaultModel(tenantId, model) {
    this.db.prepare('UPDATE tenants SET default_model = ?, updated_at = ? WHERE id = ?').run(model, now(), tenantId);
  }

  update(tenantId, patch, { actor = null, ip = null } = {}) {    const tenant = this.row(tenantId);
    if (!tenant) throw httpError(404, 'TENANT_NOT_FOUND', '租户不存在');
    const nextName = patch.name === undefined ? tenant.name : String(patch.name).trim().slice(0, 80);
    if (!nextName) throw httpError(400, 'INVALID_NAME', '租户名称不能为空');
    const nextPlan = patch.planId === undefined ? tenant.plan_id : String(patch.planId);
    if (!getPlan(nextPlan)) throw httpError(400, 'UNKNOWN_PLAN', '未知套餐');
    this.db.prepare('UPDATE tenants SET name = ?, plan_id = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextPlan, now(), tenantId);
    this.audit.record({ actorUserId: actor?.id ?? null, tenantId, action: 'tenant.update', detail: { name: nextName, planId: nextPlan }, ip });
    return this.serialize(this.row(tenantId));
  }

  renew(tenantId, { days = null, creditMicros = null, planId = null, actor = null, ip = null } = {}) {
    const tenant = this.row(tenantId);
    if (!tenant) throw httpError(404, 'TENANT_NOT_FOUND', '租户不存在');
    const plan = getPlan(planId || tenant.plan_id);
    if (!plan) throw httpError(400, 'UNKNOWN_PLAN', '未知套餐');
    const durationDays = Math.max(1, Math.min(3650, Number(days) || plan.days));
    const base = Math.max(now(), Number(tenant.expires_at) || 0);
    const expiresAt = base + durationDays * 24 * 60 * 60 * 1000;
    const grant = creditMicros === null ? plan.monthlyCreditMicros : Math.max(0, Math.trunc(Number(creditMicros) || 0));
    this.db.prepare("UPDATE tenants SET plan_id = ?, status = 'active', expires_at = ?, updated_at = ? WHERE id = ?")
      .run(plan.id, expiresAt, now(), tenantId);
    if (grant > 0) this.billing.credit(tenantId, grant, `套餐续费赠送 (${plan.id})`, 'plan-grant');
    this.audit.record({
      actorUserId: actor?.id ?? null,
      tenantId,
      action: 'tenant.renew',
      detail: { days: durationDays, planId: plan.id, grantMicros: grant, expiresAt },
      ip
    });
    return this.serialize(this.row(tenantId));
  }

  setStatus(tenantId, status, { actor = null, ip = null, reason = null } = {}) {
    if (!['active', 'suspended', 'expired'].includes(status)) throw httpError(400, 'INVALID_STATUS', '非法状态');
    this.db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), tenantId);
    this.audit.record({ actorUserId: actor?.id ?? null, tenantId, action: `tenant.${status}`, detail: { reason }, ip });
    return this.serialize(this.row(tenantId));
  }

  addMember(tenantId, user, role = 'operator', { actor = null, ip = null } = {}) {
    if (!ROLE_RANK[role]) throw httpError(400, 'INVALID_ROLE', '非法成员角色');
    const exists = this.membership(user.id, tenantId);
    if (exists) {
      this.db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND tenant_id = ?').run(role, user.id, tenantId);
    } else {
      this.db.prepare('INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, tenantId, role, now());
    }
    this.audit.record({ actorUserId: actor?.id ?? null, tenantId, action: 'member.upsert', detail: { userId: user.id, role }, ip });
    return this.listMembers(tenantId);
  }

  removeMember(tenantId, userId, { actor = null, ip = null } = {}) {
    const tenant = this.row(tenantId);
    if (tenant?.owner_user_id === userId) throw httpError(409, 'OWNER_CANNOT_BE_REMOVED', '不能移除租户所有者');
    this.db.prepare('DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    this.audit.record({ actorUserId: actor?.id ?? null, tenantId, action: 'member.remove', detail: { userId }, ip });
    return this.listMembers(tenantId);
  }

  listMembers(tenantId) {
    return this.db.prepare(`
      SELECT m.user_id, m.role, m.created_at, u.username FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.created_at ASC
    `).all(tenantId).map((row) => ({ userId: row.user_id, username: row.username, role: row.role, createdAt: row.created_at }));
  }

  allPlans() {
    return Object.values(PLANS);
  }
}

function operatorRole(actor, ownerUserId) {
  if (!actor) return null;
  if (actor.role === 'admin') return 'admin';
  return actor.id === ownerUserId ? 'owner' : 'operator';
}
