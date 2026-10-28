import { asBridgeError } from '../errors.js';

function success(data) {
  return { ok: true, data: data ?? null };
}

function failure(error) {
  const err = asBridgeError(error);
  const status = err.code >= 400 && err.code < 600 ? err.code : 500;
  return {
    status,
    payload: {
      ok: false,
      error: {
        kind: err.kind,
        code: err.code,
        retcode: err.retcode,
        wording: err.wording || err.message
      }
    }
  };
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value ?? ''));
}

function normalizeBoolPatch(body) {
  const patch = {};
  for (const key of ['at', 'up', 'dm', 'live']) {
    if (body?.[key] !== undefined) patch[key] = asBool(body[key]);
  }
  return patch;
}

/**
 * 管理 API：只接受显式白名单路由；任何响应都不读取/返回 Cookie、refresh_token 等秘密。
 * 鉴权由 OneBotServer 在进入本处理器前完成。
 */
export function createAdminHandler({ bridge, version = '0.1.0', logger = null } = {}) {
  if (!bridge) throw new TypeError('createAdminHandler 需要 bridge');

  return async function handleAdmin({ method, pathname, query = {}, body = null } = {}) {
    const verb = String(method || 'GET').toUpperCase();
    try {
      if (verb === 'GET' && pathname === '/admin/health') {
        return {
          status: 200,
          payload: success({
            ok: true,
            service: 'bili-bridge',
            version,
            tenantId: bridge.tenantId,
            uptimeMs: Date.now() - (bridge.startedAt || Date.now())
          })
        };
      }
      if (verb === 'GET' && pathname === '/admin/status') {
        return { status: 200, payload: success(bridge.adminStatus()) };
      }
      if (verb === 'GET' && pathname === '/admin/account') {
        return { status: 200, payload: success(bridge.accountStatus()) };
      }
      if (verb === 'GET' && pathname === '/admin/version') {
        return { status: 200, payload: success(bridge.versionInfo()) };
      }
      if (verb === 'POST' && pathname === '/admin/login/qr') {
        return { status: 200, payload: success(await bridge.createQr()) };
      }
      const qrMatch = pathname.match(/^\/admin\/login\/qr\/([A-Za-z0-9_-]+)$/);
      if (verb === 'GET' && (pathname === '/admin/login/qr' || qrMatch)) {
        const key = qrMatch?.[1] || query.key || '';
        return { status: 200, payload: success(await bridge.pollQr(key)) };
      }
      if (verb === 'POST' && pathname === '/admin/logout') {
        return { status: 200, payload: success(await bridge.logout()) };
      }
      if (verb === 'POST' && pathname === '/admin/refresh') {
        return { status: 200, payload: success(await bridge.refreshCookies({ force: asBool(body?.force) })) };
      }
      if (verb === 'POST' && pathname === '/admin/risk/clear') {
        return { status: 200, payload: success(await bridge.clearRisk()) };
      }
      if (verb === 'GET' && pathname === '/admin/subscriptions') {
        return { status: 200, payload: success(bridge.getSubscriptions()) };
      }
      if ((verb === 'PUT' || verb === 'POST') && pathname === '/admin/subscriptions') {
        return { status: 200, payload: success(await bridge.setSubscriptions(normalizeBoolPatch(body))) };
      }
      if (verb === 'GET' && pathname === '/admin/watches') {
        return { status: 200, payload: success(bridge.getWatches()) };
      }
      if ((verb === 'PUT' || verb === 'POST') && pathname === '/admin/watches') {
        return {
          status: 200,
          payload: success(await bridge.setWatches({
            videos: body?.videos,
            ups: body?.ups,
            liveRooms: body?.liveRooms
          }))
        };
      }
      if (verb === 'GET' && pathname === '/admin/mapping') {
        return { status: 200, payload: success(bridge.mappingSnapshot()) };
      }
      if (verb === 'GET' && pathname === '/admin/messages') {
        const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
        return { status: 200, payload: success(bridge.recentMessages(limit)) };
      }
      if (verb === 'POST' && pathname === '/admin/live/reconnect') {
        const roomId = body?.roomId ?? query.roomId;
        return { status: 200, payload: success(await bridge.reconnectLive(roomId)) };
      }
      return {
        status: 404,
        payload: { ok: false, error: { kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: `未知管理接口 ${verb} ${pathname}` } }
      };
    } catch (error) {
      logger?.warn?.('管理 API 失败', { method: verb, pathname, error: error?.wording || error?.message });
      return failure(error);
    }
  };
}
