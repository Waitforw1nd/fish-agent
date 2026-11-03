import WebSocket, { WebSocketServer } from 'ws';
import { readJson, sendJson } from '../http.js';
import { httpError } from '../contracts/http.js';
import { id } from '../util.js';

const MAX_PAYLOAD = 3 * 1024 * 1024;
const SAFE_UPSTREAM_CLOSE_CODES = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1012, 1013, 4001, 4003]);
const AUTH_CODES = new Set(['TOKEN_REVOKED', 'ENTRY_DISABLED', 'USER_FORBIDDEN', 'TENANT_INACTIVE']);
function permissionClose(error) { const code = error?.code === 'DEVICE_USER_FORBIDDEN' ? 'USER_FORBIDDEN' : error?.code; return AUTH_CODES.has(code) ? code : null; }
function rejectUpgrade(socket, status, code) {
  const body = JSON.stringify({ ok: false, code });
  socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export class DesktopGateway {
  constructor({ devices, agentRuntime, billingProvider, logger }) {
    Object.assign(this, { devices, agentRuntime, billingProvider, logger });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this.connections = new Set();
    this.attempts = new Map();
    this.onlineMeters = new Map();
    this.activeMeters = new Map();
    this.meterTimer = setInterval(() => this.flushMeters(), 30000);
    this.meterTimer.unref?.();
    devices.onRevoke = deviceId => this.closeDevice(deviceId);
  }
  startOnline(tenantId, deviceId) {
    let meter = this.activeMeters.get(deviceId);
    if (!meter) {
      meter = { id: id('dconn'), tenantId, deviceId, count: 0, cursor: Date.now(), endedAt: null };
      this.activeMeters.set(deviceId, meter);
      this.onlineMeters.set(meter.id, meter);
    }
    meter.count++;
    return meter;
  }
  endOnline(meter) {
    if (!meter || --meter.count > 0) return;
    meter.endedAt = Date.now();
    this.activeMeters.delete(meter.deviceId);
    this.flushMeters();
  }
  flushMeters(time = Date.now()) {
    for (const meter of this.onlineMeters.values()) {
      // Keep a failed interval stable: the provider may have committed before
      // throwing, so changing its end would defeat its idempotency key.
      // An ended meter can have one older uncertain interval plus its final
      // tail. Drain both after successful writes, but stop immediately on a
      // failure so a flush never spins on an unavailable provider.
      for (let i = 0; i < 2; i++) {
        const end = meter.pendingEnd ?? meter.endedAt ?? time;
        if (end <= meter.cursor) break;
        meter.pendingEnd = end;
        try {
          this.billingProvider.recordMeter({ tenantId: meter.tenantId, entry: 'desktop', meter: 'desktop.device.online.seconds', quantity: (end - meter.cursor) / 1000, unit: 'seconds', source: 'gateway', occurredAt: end, idempotencyKey: `${meter.id}:${meter.cursor}:${end}`, attrs: { deviceId: meter.deviceId } });
          meter.cursor = end;
          meter.pendingEnd = null;
        } catch (error) { this.logger?.error?.('desktop online meter failed', error); break; }
        if (meter.endedAt === null || meter.cursor >= meter.endedAt) break;
      }
      if (meter.endedAt !== null && meter.cursor >= meter.endedAt) this.onlineMeters.delete(meter.id);
    }
  }
  limitPairing(req) {
    const now = Date.now();
    for (const [key, record] of this.attempts) if (record.until <= now) this.attempts.delete(key);
    const ip = req.socket.remoteAddress || 'unknown';
    const entry = this.attempts.get(ip) || { until: now + 60000, count: 0 };
    if (++entry.count > 10 || this.attempts.size > 10000) throw httpError(429, 'PAIRING_RATE_LIMIT', '配对尝试过于频繁，请稍后再试');
    this.attempts.set(ip, entry);
  }
  async handle(req, res, url) {
    if (url.pathname !== '/desktop/v1/pair' || req.method !== 'POST' || url.search) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' }); return;
    }
    this.limitPairing(req);
    const body = await readJson(req, 2048);
    const paired = this.devices.pair(body);
    sendJson(res, 200, { ok: true, ...paired });
  }
  upgrade(req, socket, head) {
    let identity, token;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/desktop/v1/ws' || url.search || req.method !== 'GET') throw httpError(404, 'NOT_FOUND', 'Not found');
      // Native clients send no Origin. Cookies never grant this capability.
      if (req.headers.origin) throw httpError(403, 'ORIGIN_REJECTED', 'Native desktop client required');
      token = /^Bearer (fdt_[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''))?.[1];
      identity = this.devices.authenticate(token);
      const { tenant, device } = identity;
      if (this.connections.size >= 4096 || [...this.connections].filter(c => c.deviceId === device.id).length >= 3) throw httpError(429, 'CONNECTION_LIMIT', 'Too many connections');
      if (this.agentRuntime.supervisor.status(tenant.id, 'agent').state !== 'running' || !tenant.agent_port) throw httpError(503, 'AGENT_NOT_RUNNING', 'Agent is not running');
    } catch (error) { rejectUpgrade(socket, error.status || 401, permissionClose(error) || (['NOT_FOUND', 'ORIGIN_REJECTED', 'CONNECTION_LIMIT', 'AGENT_NOT_RUNNING'].includes(error.code) ? error.code : 'UNAUTHENTICATED')); return; }
    const { tenant, device } = identity;
    const upstream = new WebSocket(`ws://127.0.0.1:${tenant.agent_port}/channels/desktop/ws`, {
      headers: { ...this.agentRuntime.consoleHeaders(tenant), 'x-fish-device-id': device.id, 'x-fish-desktop-user': String(device.desktop_user_id) },
      maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: 5000
    });
    let client, timer, ended = false, meter = null;
    const record = { tenantId: tenant.id, deviceId: device.id, close: (code = 4001, reason) => finish(code, reason), closeForTenant: () => { try { this.devices.authenticate(token); finish(1001); } catch (error) { const reason = permissionClose(error); finish(reason === 'TOKEN_REVOKED' ? 4001 : reason ? 4003 : 1011, reason); } } };
    this.connections.add(record);
    function finish(code = 1011, reason) {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      thisGateway.endOnline(meter);
      thisGateway.connections.delete(record);
      try { if (client?.readyState === WebSocket.OPEN) client.close(code, AUTH_CODES.has(reason) ? reason : code === 4001 ? 'TOKEN_REVOKED' : 'CONNECTION_CLOSED'); else if (!client) socket.destroy(); } catch { /* closed */ }
      try { upstream.close(); } catch { /* closed */ }
      const cleanup = setTimeout(() => { client?.terminate(); upstream.terminate(); }, 1000); cleanup.unref?.();
    }
    const thisGateway = this;
    socket.once('close', () => finish());
    upstream.once('error', () => { if (!client && !ended) rejectUpgrade(socket, 503, 'AGENT_NOT_RUNNING'); finish(); });
    // Preserve protocol/recovery failures for the client, never upstream text.
    upstream.once('close', code => finish(SAFE_UPSTREAM_CLOSE_CODES.has(code) ? code : 1011));
    upstream.once('open', () => {
      if (ended) return;
      try { this.devices.authenticate(token); } catch (error) { const reason = permissionClose(error); finish(reason === 'TOKEN_REVOKED' ? 4001 : reason ? 4003 : 1011, reason); return; }
      try { this.wss.handleUpgrade(req, socket, head, downstream => {
        client = downstream;
        meter = this.startOnline(tenant.id, device.id);
        this.devices.db.prepare('UPDATE desktop_devices SET last_seen_at=? WHERE id=?').run(Date.now(), device.id);
        const forward = (from, to) => from.on('message', (data, binary) => {
          if (ended) return;
          try { this.devices.authenticate(token); } catch (error) { const reason = permissionClose(error); finish(reason === 'TOKEN_REVOKED' ? 4001 : reason ? 4003 : 1011, reason); return; }
          if (binary) { finish(1003); return; }
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 2 * MAX_PAYLOAD) { finish(1013); return; }
          to.send(data, { binary: false }, error => { if (error) finish(); });
        });
        forward(client, upstream); forward(upstream, client);
        client.on('error', () => finish()); client.once('close', () => finish(1000));
        timer = setInterval(() => {
          try { this.devices.authenticate(token); } catch (error) { const reason = permissionClose(error); finish(reason === 'TOKEN_REVOKED' ? 4001 : reason ? 4003 : 1011, reason); return; }
          try { this.devices.db.prepare('UPDATE desktop_devices SET last_seen_at=? WHERE id=?').run(Date.now(), device.id); }
          catch { finish(); }
        }, 30000);
        timer.unref?.();
      }); } catch { finish(); }
    });
  }
  closeDevice(deviceId) { for (const c of [...this.connections]) if (c.deviceId === deviceId) c.close(4001); }
  closeTenant(tenantId) { let count = 0; for (const c of [...this.connections]) if (c.tenantId === tenantId) { c.closeForTenant(); count++; } return count; }
  closeAll() { for (const c of [...this.connections]) c.close(1001); this.flushMeters(); clearInterval(this.meterTimer); }
}
