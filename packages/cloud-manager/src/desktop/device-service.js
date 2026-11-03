import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { transaction } from '../db.js';
import { httpError } from '../contracts/http.js';
import { id, sha256, randomToken } from '../util.js';

const USER_START = 7459086882832384;
const USER_SIZE = 2 ** 47;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function publicDevice(row) {
  return { id: row.id, userId: row.user_id, name: row.name, os: row.os, desktopUserId: row.desktop_user_id,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at };
}

export class DesktopDeviceService {
  constructor({ db, tenants, entries, billingProvider, config }) {
    Object.assign(this, { db, tenants, entries, billingProvider, config });
  }
  baseUrl() {
    const scheme = this.config.publicScheme;
    const port = this.config.publicPort ?? this.config.panelPort;
    const suffix = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`;
    return `${scheme}://${this.config.baseDomain}${suffix}`;
  }
  assertUser(tenant, userId) {
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const role = user && !user.disabled && this.tenants.roleFor(user, tenant.id);
    if (!['owner', 'operator', 'admin'].includes(role)) throw httpError(403, 'DEVICE_USER_FORBIDDEN', '设备绑定用户不再具有对话权限');
    return user;
  }
  async createPairingCode(tenantId, actorUserId) {
    const tenant = this.tenants.row(tenantId);
    this.tenants.assertActive(tenant);
    this.assertUser(tenant, actorUserId);
    if (!this.entries.enabled(tenantId, 'desktop')) throw httpError(409, 'ENTRY_DISABLED', '请先启用桌宠入口');
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = Date.now() + 600000;
    this.db.prepare('DELETE FROM desktop_pairing_codes WHERE expires_at<? OR used_at IS NOT NULL').run(Date.now());
    this.db.prepare('INSERT INTO desktop_pairing_codes(code_hash,tenant_id,user_id,expires_at) VALUES (?,?,?,?)').run(sha256(code), tenantId, actorUserId, expiresAt);
    const uri = `fishpet://pair?host=${encodeURIComponent(this.baseUrl())}&code=${code}`;
    return { code, expiresAt, uri, qr: await QRCode.toDataURL(uri), host: this.baseUrl() };
  }
  userNumber(tenantId, userId) {
    const existing = this.db.prepare('SELECT desktop_user_id FROM desktop_devices WHERE tenant_id=? AND user_id=? LIMIT 1').get(tenantId, userId);
    if (existing) return existing.desktop_user_id;
    let value = USER_START + Number(BigInt(`0x${sha256(`${tenantId}:${userId}`).slice(0, 12)}`) % BigInt(USER_SIZE));
    while (this.db.prepare('SELECT 1 FROM desktop_devices WHERE tenant_id=? AND desktop_user_id=? AND user_id<>?').get(tenantId, value, userId)) {
      value = USER_START + ((value - USER_START + 1) % USER_SIZE);
    }
    return value;
  }
  seatMeter(tenantId, eventKey) {
    const quantity = Number(this.db.prepare('SELECT COUNT(*) n FROM desktop_devices WHERE tenant_id=? AND revoked_at IS NULL').get(tenantId).n);
    this.billingProvider.recordMeter({ tenantId, entry: 'desktop', meter: 'desktop.device.seats', quantity, unit: 'seats', kind: 'gauge', source: 'gateway', occurredAt: Date.now(), idempotencyKey: eventKey });
  }
  pair(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'INVALID_PAIRING', '配对请求必须是对象');
    const { code, deviceName, os } = input;
    if (typeof code !== 'string' || !/^[A-Z2-9]{8}$/.test(code.toUpperCase()) || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80 || typeof os !== 'string' || os.length > 40) {
      throw httpError(400, 'INVALID_PAIRING', '请填写有效的配对码和设备名称');
    }
    return transaction(this.db, () => {
      const pairing = this.db.prepare('SELECT * FROM desktop_pairing_codes WHERE code_hash=?').get(sha256(code.toUpperCase()));
      if (!pairing || pairing.used_at || pairing.expires_at <= Date.now()) throw httpError(401, 'PAIRING_EXPIRED', '配对码已失效或已使用');
      const tenant = this.tenants.row(pairing.tenant_id);
      this.tenants.assertActive(tenant);
      this.assertUser(tenant, pairing.user_id);
      if (!this.entries.enabled(tenant.id, 'desktop')) throw httpError(403, 'ENTRY_DISABLED', '桌宠入口已关闭');
      const quota = this.billingProvider.checkEntitlement({ tenantId: tenant.id, entry: 'desktop', meter: 'desktop.device.seats', quantity: 1 });
      const count = Number(this.db.prepare('SELECT COUNT(*) n FROM desktop_devices WHERE tenant_id=? AND revoked_at IS NULL').get(tenant.id).n);
      const userCount = Number(this.db.prepare('SELECT COUNT(*) n FROM desktop_devices WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL').get(tenant.id, pairing.user_id).n);
      if (!quota.allowed || (quota.limit !== null && count >= quota.limit) || userCount >= 3) throw httpError(403, 'SEAT_LIMIT', '桌宠设备席位已满');
      const deviceId = id('ddev');
      const deviceToken = `fdt_${randomToken(32)}`;
      const desktopUserId = this.userNumber(tenant.id, pairing.user_id);
      const time = Date.now();
      this.db.prepare('INSERT INTO desktop_devices(id,tenant_id,user_id,name,os,token_hash,token_prefix,desktop_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(deviceId, tenant.id, pairing.user_id, deviceName.trim(), os, sha256(deviceToken), deviceToken.slice(0, 12), desktopUserId, time);
      this.db.prepare('UPDATE desktop_pairing_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').run(time, sha256(code.toUpperCase()));
      this.seatMeter(tenant.id, `device:${deviceId}:pair`);
      return { deviceId, deviceToken, desktopUserId, tenantSlug: tenant.slug, wsUrl: this.baseUrl().replace(/^http/, 'ws') + '/desktop/v1/ws' };
    });
  }
  authenticate(bearer) {
    if (typeof bearer !== 'string' || !/^fdt_[A-Za-z0-9_-]{43}$/.test(bearer)) throw httpError(401, 'TOKEN_REVOKED', '设备凭据无效');
    const device = this.db.prepare('SELECT * FROM desktop_devices WHERE token_hash=? AND revoked_at IS NULL').get(sha256(bearer));
    if (!device) throw httpError(401, 'TOKEN_REVOKED', '设备已吊销或凭据无效');
    const tenant = this.tenants.row(device.tenant_id);
    try { this.tenants.assertActive(tenant); } catch (error) {
      if (error.code === 'TENANT_EXPIRED' || error.code === 'TENANT_SUSPENDED') throw httpError(403, 'TENANT_INACTIVE', '租户不可用');
      throw error;
    }
    this.assertUser(tenant, device.user_id);
    if (!this.entries.enabled(tenant.id, 'desktop')) throw httpError(403, 'ENTRY_DISABLED', '桌宠入口已关闭');
    return { device, tenant };
  }
  list(tenantId) { return this.db.prepare('SELECT * FROM desktop_devices WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId).map(publicDevice); }
  revoke(tenantId, deviceId) {
    const device = this.db.prepare('SELECT * FROM desktop_devices WHERE tenant_id=? AND id=?').get(tenantId, deviceId);
    if (!device) throw httpError(404, 'DEVICE_NOT_FOUND', '设备不存在');
    transaction(this.db, () => {
      if (!device.revoked_at) {
        this.db.prepare('UPDATE desktop_devices SET revoked_at=? WHERE id=?').run(Date.now(), deviceId);
        this.seatMeter(tenantId, `device:${deviceId}:revoke`);
      }
    });
    this.onRevoke?.(deviceId);
  }
}
