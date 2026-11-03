import { id, now } from '../util.js';
import { transaction } from '../db.js';
import { sha256 } from '../util.js';
import { ENTRY_TYPES as ENTRIES } from '../entry-types.js';
import { getPlan } from '../plans.js';

export { ENTRY_TYPES as ENTRIES } from '../entry-types.js';
const MODES = ['off', 'soft', 'hard'];
const WINDOWS = ['day', 'month', 'plan', 'concurrent'];
const MAX_DATE_MS = 8_640_000_000_000_000;
const CLIENT_METERS = /^(?:qq_protocol|qq_official|desktop|bili)\.(?:message\.(?:in|out)|llm\.session)$|^qq_official\.api\.calls?$|^bili\.(?:video\.browsed|comment\.(?:drafted|posted)|dm\.sent|danmaku\.sent)$/;

function bad(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_meter_event' });
}

function invalidAttribute([key, value]) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return true;
  const tokenCount = /^(promptTokens|completionTokens|cachedTokens|totalTokens)$/.test(key)
    && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (/secret|token|password|content|text|message/i.test(key)
      && !(key === 'messageId' && typeof value === 'string') && !tokenCount) return true;
  return !['string', 'number', 'boolean'].includes(typeof value)
    || (typeof value === 'string' && value.length > 256)
    || (typeof value === 'number' && !Number.isFinite(value));
}

function entryForChatKey(chatKey) {
  if (typeof chatKey !== 'string') return null;
  if (/^(?:group:qqbot_(?:group|channel)|private:qqbot_(?:user|dm))_[A-Za-z0-9_-]{1,128}$/.test(chatKey)) return 'qq_official';
  if (!/^(?:group|private):[1-9]\d{0,15}$/.test(chatKey)) return null;
  const n = Number(chatKey.split(':')[1]);
  if (!Number.isSafeInteger(n)) return null;
  if (n <= 4503599627370495) return 'qq_protocol';
  if (n <= 7318349394477055) return 'bili';
  if (n <= 7881299347898367) return 'desktop';
  return null;
}

export function validateMeter(event, { client = false, tenantId } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw bad('Invalid event');
  if (tenantId && event.tenantId !== undefined && event.tenantId !== tenantId) throw bad('Tenant mismatch');
  const e = { ...event, tenantId: tenantId || event.tenantId, kind: event.kind || 'delta' };
  if (typeof e.tenantId !== 'string' || !e.tenantId || !ENTRIES.includes(e.entry)
      || typeof e.meter !== 'string' || e.meter.length > 128
      || !new RegExp(`^${e.entry}\\.[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$`).test(e.meter)) {
    throw bad('Invalid tenant, entry or meter');
  }
  if (typeof e.idempotencyKey !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(e.idempotencyKey)) {
    throw bad('Invalid idempotency key');
  }
  if (!Number.isFinite(e.quantity) || e.quantity < 0 || e.quantity > 1e12
      || !['count', 'seconds', 'tokens', 'seats'].includes(e.unit)
      || !['delta', 'gauge'].includes(e.kind) || !Number.isSafeInteger(e.occurredAt)
      || e.occurredAt < 0 || e.occurredAt > MAX_DATE_MS) {
    throw bad('Invalid quantity, unit, kind or timestamp');
  }
  if (!['agent', 'bridge', 'relay', 'supervisor', 'gateway', 'panel'].includes(e.source)) throw bad('Invalid source');
  if (client && (!['agent', 'bridge'].includes(e.source) || !CLIENT_METERS.test(e.meter)
      || e.kind !== 'delta' || e.unit !== 'count')) throw bad('Meter is server-only');
  if (e.attrs != null && (typeof e.attrs !== 'object' || Array.isArray(e.attrs)
      || Object.entries(e.attrs).some(invalidAttribute))) throw bad('Invalid attributes');
  if (client && e.attrs) {
    const platformEntry = { qq: 'qq_protocol', qqbot: 'qq_official', qq_protocol: 'qq_protocol', qq_official: 'qq_official', desktop: 'desktop', bili: 'bili' };
    if (Object.hasOwn(e.attrs, 'platform') && platformEntry[e.attrs.platform] !== e.entry) throw bad('Platform and entry mismatch');
    if (Object.hasOwn(e.attrs, 'chatKey') && entryForChatKey(e.attrs.chatKey) !== e.entry) throw bad('Chat key and entry mismatch');
  }
  return e;
}

export class LedgerBillingProvider {
  constructor({ db, wallet }) {
    this.db = db;
    this.wallet = wallet;
  }

  recordMeter(event) {
    const e = validateMeter(event);
    const eventId = id('mev');
    const result = this.db.prepare(`
      INSERT INTO meter_events (id, idempotency_key, tenant_id, entry, meter, quantity,
        unit, kind, source, attrs_json, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, idempotency_key) DO NOTHING
    `).run(eventId, e.idempotencyKey, e.tenantId, e.entry, e.meter, e.quantity,
      e.unit, e.kind, e.source, e.attrs ? JSON.stringify(e.attrs) : null, e.occurredAt, now());
    const row = result.changes ? { id: eventId } : this.db.prepare(
      'SELECT id FROM meter_events WHERE tenant_id=? AND idempotency_key=?'
    ).get(e.tenantId, e.idempotencyKey);
    return { id: row.id, duplicate: !result.changes };
  }

  recordMeters(events, options = {}) {
    if (!Array.isArray(events) || events.length > 100) throw bad('Expected at most 100 events');
    const validated = events.map(event => {
      const e = validateMeter(event, options);
      // Relay clients must not be able to preempt authoritative seat/token events.
      return options.client ? { ...e, idempotencyKey: `client:${e.source}:${e.entry}:${sha256(e.idempotencyKey)}` } : e;
    });
    return transaction(this.db, () => {
      let accepted = 0;
      let duplicates = 0;
      for (const e of validated) {
        if (this.recordMeter(e).duplicate) duplicates++;
        else accepted++;
      }
      return { accepted, duplicates };
    });
  }

  entitlements(tenantId) {
    const tenant = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
    if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404, code: 'TENANT_NOT_FOUND' });
    const plan = getPlan(tenant.plan_id);
    const entitlements = structuredClone(plan?.entitlements || {});
    // Existing databases may have multiple windows for one meter. Newest wins.
    const rows = this.db.prepare(`
      SELECT * FROM tenant_entitlements WHERE tenant_id=? ORDER BY updated_at, rowid
    `).all(tenantId);
    for (const row of rows) {
      entitlements[row.meter] = { window: row.window, limit: row.limit_value, mode: row.mode };
    }
    return { planId: tenant.plan_id, entries: [...(plan?.entries || ENTRIES)],
      enforce: plan?.enforce || 'off', entitlements };
  }

  usage({ tenantId, entry, meter, from = 0, to = MAX_DATE_MS + 1, groupBy = 'meter' }) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0
        || from > MAX_DATE_MS || to > MAX_DATE_MS + 1 || to <= from
        || !['meter', 'day'].includes(groupBy)) throw bad('Invalid usage range');
    const params = [tenantId, entry || null, entry || null, meter || null, meter || null];
    // Seed each gauge with its last value before the window. Delta events never carry forward.
    const prior = this.db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY entry, meter
          ORDER BY occurred_at DESC, created_at DESC, rowid DESC) AS position
        FROM meter_events WHERE tenant_id=? AND (? IS NULL OR entry=?)
          AND (? IS NULL OR meter=?) AND kind='gauge' AND occurred_at<?
      ) WHERE position=1
    `).all(...params, from);
    const rows = this.db.prepare(`
      SELECT * FROM meter_events WHERE tenant_id=? AND (? IS NULL OR entry=?)
        AND (? IS NULL OR meter=?) AND occurred_at>=? AND occurred_at<?
      ORDER BY occurred_at, created_at, rowid
    `).all(...params, from, to);
    const groups = new Map();
    const add = (row, at) => {
      const day = groupBy === 'day' ? new Date(at).toISOString().split('T')[0] : null;
      const key = `${row.entry}\0${row.meter}\0${day || ''}`;
      const current = groups.get(key) || { entry: row.entry, meter: row.meter,
        unit: row.unit, kind: row.kind, quantity: 0, ...(day ? { day } : {}) };
      current.quantity = row.kind === 'gauge' ? row.quantity : current.quantity + row.quantity;
      groups.set(key, current);
    };
    for (const row of prior) add(row, from);
    for (const row of rows) add(row, row.occurred_at);
    return [...groups.values()];
  }

  checkEntitlement({ tenantId, entry, meter, quantity = 1 }) {
    if (!ENTRIES.includes(entry) || !meter?.startsWith(`${entry}.`)
        || !Number.isFinite(quantity) || quantity < 0) throw bad('Invalid entitlement query');
    const snapshot = this.entitlements(tenantId);
    const rule = snapshot.entitlements[meter] || {};
    const mode = MODES.includes(rule.mode) ? rule.mode : snapshot.enforce;
    const window = WINDOWS.includes(rule.window) ? rule.window : 'month';
    const time = now();
    const date = new Date(time);
    let from = 0;
    if (window === 'day') from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (window === 'month') from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    if (window === 'plan') from = this.db.prepare('SELECT created_at FROM tenants WHERE id=?').get(tenantId).created_at;
    const used = this.usage({ tenantId, entry, meter, from, to: time + 1 }).reduce((n, row) => n + row.quantity, 0);
    const limit = rule.limit == null ? null : Number(rule.limit);
    const reason = !snapshot.entries.includes(entry) ? 'ENTRY_NOT_IN_PLAN'
      : limit !== null && used + quantity > limit ? 'QUOTA_EXCEEDED' : undefined;
    return { allowed: !reason || mode !== 'hard', mode, limit, used,
      remaining: limit === null ? null : Math.max(0, limit - used), window, ...(reason ? { reason } : {}) };
  }

  setEntitlements(tenantId, overrides) {
    if (!Array.isArray(overrides) || overrides.length > 100) throw bad('Invalid overrides');
    transaction(this.db, () => {
      for (const override of overrides) {
        if (!override || typeof override !== 'object' || Array.isArray(override)
            || typeof override.meter !== 'string' || !ENTRIES.some(entry => override.meter.startsWith(`${entry}.`))
            || !WINDOWS.includes(override.window) || !MODES.includes(override.mode)
            || !(override.limit === null || (Number.isFinite(override.limit) && override.limit >= 0))) {
          throw bad('Invalid override');
        }
        this.db.prepare('DELETE FROM tenant_entitlements WHERE tenant_id=? AND meter=?').run(tenantId, override.meter);
        this.db.prepare(`
          INSERT INTO tenant_entitlements(tenant_id, meter, window, limit_value, mode, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(tenantId, override.meter, override.window, override.limit, override.mode, now());
      }
    });
    return this.entitlements(tenantId);
  }
}

export class NoopBillingProvider {
  constructor({ wallet = null } = {}) { this.wallet = wallet; }
  recordMeter() { return { id: null, duplicate: false }; }
  recordMeters(events) { return { accepted: events.length, duplicates: 0 }; }
  entitlements() { return { entries: [...ENTRIES], enforce: 'off', entitlements: {} }; }
  usage() { return []; }
  checkEntitlement() { return { allowed: true, mode: 'off', limit: null, used: 0, remaining: null, window: 'month' }; }
}

