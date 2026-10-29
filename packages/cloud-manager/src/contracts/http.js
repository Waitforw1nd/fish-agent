import { readJson, sendJson } from '../http.js';
import { now } from '../util.js';

export function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

export function parseQueryInt(params, name, fallback, min, max) {
  if (!params.has(name)) return fallback;
  const raw = String(params.get(name) || '');
  if (!/^\d+$/.test(raw)) throw httpError(400, 'INVALID_QUERY', `${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw httpError(400, 'INVALID_QUERY', `${name} 必须在 ${min}-${max} 之间`);
  return value;
}

export function parseQueryString(params, name, fallback = '', max = 200) {
  const value = String(params.get(name) ?? fallback).trim();
  if (value.length > max) throw httpError(400, 'INVALID_QUERY', `${name} 超出长度限制`);
  return value;
}

export function parseQueryEnum(params, name, values, fallback) {
  const value = parseQueryString(params, name, fallback);
  if (!values.includes(value)) throw httpError(400, 'INVALID_QUERY', `${name} 不受支持`);
  return value;
}

export function createRouteHelpers(deps, presenter) {
  const { config, auth, tenants, agent, qq, logger } = deps;
  const readBody = (ctx, limit = config.apiMaxBodyBytes) => readJson(ctx.req, limit);
  const sendOk = (ctx, data = {}, status = 200) => sendJson(ctx.res, status, { ok: true, ...data });
  const tenantCtx = (ctx, minRole = 'viewer') => {
    const { user } = ctx.auth || auth.require(ctx.req);
    const { tenant, role } = tenants.require(ctx.params.id, user, minRole);
    return { tenant, role };
  };
  const activeTenant = (ctx, minRole = 'operator') => {
    const result = tenantCtx(ctx, minRole);
    tenants.assertActive(result.tenant);
    return result;
  };
  const requireAdmin = (ctx) => {
    const authed = ctx.auth || auth.require(ctx.req);
    if (authed.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    return authed;
  };
  const syncAgentRelayConfig = async (tenant) => {
    await agent.writeConfig(tenant);
    if (deps.supervisor.status(tenant.id, 'agent').state !== 'running') return false;
    const active = (row) => row?.status === 'active' && Number(row.expires_at) > now();
    if (!active(tenants.row(tenant.id))) return false;
    try {
      await agent.stop(tenant);
      const fresh = tenants.row(tenant.id);
      if (active(fresh)) await agent.start(fresh);
      return false;
    } catch (error) {
      logger?.warn?.('agent restart after relay configuration change failed', { tenantId: tenant.id, error: error.message });
      return true;
    }
  };
  const updateAgentRelayConfig = (tenant, update) => qq.serial(tenant.id, async () => {
    qq.assertNoSwitch(tenant.id);
    const result = await update(tenants.row(tenant.id));
    const fresh = tenants.row(tenant.id);
    const restartRequired = await syncAgentRelayConfig(fresh);
    return { result, fresh, restartRequired };
  });

  return { readBody, sendOk, tenantCtx, activeTenant, requireAdmin, updateAgentRelayConfig, ...presenter };
}
