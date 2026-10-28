import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function tempDir(prefix = 'bili-bridge-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function waitFor(fn, { timeout = 5000, interval = 20, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

export function makeConfig({ fake, dataDir, overrides = {} } = {}) {
  if (!dataDir) throw new Error('makeConfig 需要 dataDir');
  return loadConfig({
    env: {},
    overrides: {
      dataDir,
      tenantId: 'tenant-test',
      logLevel: 'silent',
      endpoints: fake?.endpoints?.() || {},
      onebot: {
        host: '127.0.0.1',
        port: 0,
        token: 'test-onebot-token',
        adminToken: 'test-admin-token-123',
        heartbeatIntervalMs: 60_000
      },
      bili: { timeoutMs: 3000, forceHttps: false },
      poll: {
        msgfeedIntervalMs: 3_600_000,
        msgfeedJitterMs: 0,
        commentIntervalMs: 3_600_000,
        commentJitterMs: 0,
        dmIntervalMs: 3_600_000,
        dmJitterMs: 0,
        upIntervalMs: 3_600_000,
        upJitterMs: 0,
        cookieCheckIntervalMs: 3_600_000,
        cookieCheckJitterMs: 0
      },
      comment: { outboundMinIntervalMs: 20, outboundJitterMs: 0 },
      dm: { outboundMinIntervalMs: 20, outboundJitterMs: 0 },
      live: {
        wsProtocol: 'ws',
        heartbeatIntervalMs: 40,
        reconnectMinMs: 60,
        reconnectMaxMs: 500,
        authTimeoutMs: 2000,
        outboundMinIntervalMs: 20,
        outboundJitterMs: 0,
        filter: { danmaku: 'mentions', keywords: [], gifts: true, superChat: true, guard: true }
      },
      watch: { videos: [], ups: [], liveRooms: [] },
      subscriptions: { at: true, up: true, dm: true, live: true },
      ...overrides
    }
  });
}

export function actionUrl(bridge) {
  return `http://127.0.0.1:${bridge.server.port}`;
}

export async function postAction(bridge, action, params = {}, { token = 'test-onebot-token', pathMode = false } = {}) {
  const url = pathMode ? `${actionUrl(bridge)}/${action}` : `${actionUrl(bridge)}/`;
  const body = pathMode ? params : { action, params };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

export async function adminRequest(bridge, method, pathname, body = null, { token = 'test-admin-token-123' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${actionUrl(bridge)}${pathname}`, {
    method,
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
