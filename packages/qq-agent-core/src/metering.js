import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isCloudRelay } from './llm.js';

const ENTRIES = new Set(['qq_protocol', 'qq_official', 'desktop', 'bili']);
const COUNT_METERS = /^(?:qq_protocol|qq_official|desktop|bili)\.(?:message\.(?:in|out)|llm\.session)$|^qq_official\.api\.calls?$/;
const ATTRIBUTES = new Set(['chatKey', 'messageId', 'sessionId', 'success', 'calls', 'promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function safeAttribute([key, value]) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return false;
  const tokenCount = /^(promptTokens|completionTokens|cachedTokens|totalTokens)$/.test(key) && Number.isSafeInteger(value) && value >= 0;
  if (/secret|token|password|content|text|message/i.test(key) && !(key === 'messageId' && typeof value === 'string') && !tokenCount) return false;
  return (typeof value === 'string' && value.length <= 256) || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}
function queuedEvent(value) {
  return isRecord(value) && ENTRIES.has(value.entry) && typeof value.meter === 'string'
    && COUNT_METERS.test(value.meter) && value.meter.startsWith(value.entry + '.')
    && typeof value.idempotencyKey === 'string' && /^[A-Za-z0-9:._-]{1,256}$/.test(value.idempotencyKey)
    && Number.isFinite(value.quantity) && value.quantity >= 0 && value.quantity <= 1e12
    && value.unit === 'count' && value.source === 'agent' && (value.kind === undefined || value.kind === 'delta')
    && Number.isSafeInteger(value.occurredAt) && value.occurredAt >= 0 && value.occurredAt <= 8640000000000000
    && (value.attrs == null || (isRecord(value.attrs) && Object.entries(value.attrs).every(safeAttribute)));
}
function errorTag(error) {
  // JSON parse errors may include file contents; transport errors may echo headers.
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return `HTTP ${error.status}`;
  return ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.code) ? error.code : 'operation failed';
}

export function entryForChat(chatKey, router) {
  const [kind, ...parts] = String(chatKey || '').split(':');
  const id = parts.join(':');
  if (/^qqbot_/.test(id)) return 'qq_official';
  try { return ({ qq: 'qq_protocol', bili: 'bili', desktop: 'desktop' })[router?.platformFor(kind, id)] || null; }
  catch { return null; }
}

export function messageMeterKey(entry, direction, chatKey, messageId) {
  if (messageId === undefined || messageId === null || messageId === '') return randomUUID();
  return 'message:' + createHash('sha256').update(JSON.stringify([entry, direction, chatKey, String(messageId)])).digest('hex');
}

// The spool is written before sending; retries retain the original idempotency key.
export class MeterClient {
  constructor({ api, dataDir, fetchImpl = fetch, log = () => {}, intervalMs = 5000, maxEvents = 10000 } = {}) {
    this.api = api || {}; this.enabled = isCloudRelay(this.api); this.fetch = fetchImpl; this.log = log;
    this.file = path.join(dataDir, 'meter-spool.json'); this.overflowDir = path.join(dataDir, 'meter-overflow');
    this.maxEvents = Math.max(1, Math.floor(Number(maxEvents) || 10000)); this.events = []; this.pending = null;
    if (!this.enabled) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data) || !data.every(queuedEvent)) throw new Error('Invalid meter queue');
      this.events = data;
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Cannot load meter spool; original file preserved (' + errorTag(e) + ')');
    }
    this.timer = setInterval(() => { void this.flush(); }, intervalMs); this.timer.unref?.();
  }
  persist() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.events), { mode: 0o600 }); fs.renameSync(tmp, this.file); return true; }
    catch (e) { this.log(`[meter] spool write failed: ${errorTag(e)}`); return false; }
  }
  record(entry, meter, attrs = {}, key = randomUUID()) {
    if (!this.enabled || !entry) return;
    if (this.events.some(event => event.idempotencyKey === key)) return;
    const safeAttrs = Object.fromEntries(Object.entries(isRecord(attrs) ? attrs : {})
      .filter(([name]) => ATTRIBUTES.has(name)).map(([name, value]) => [name, typeof value === 'string' ? value.slice(0, 256) : value])
      .filter(safeAttribute));
    const event = { idempotencyKey: key, entry, meter, quantity: 1, unit: 'count', occurredAt: Date.now(), source: 'agent', attrs: safeAttrs };
    if (!queuedEvent(event)) throw new Error('Invalid agent meter event');
    if (this.events.length >= this.maxEvents) {
      // Keep the in-memory queue bounded without losing accepted operations during
      // a long Relay outage. Each spill file is atomic and independently retryable.
      try {
        fs.mkdirSync(this.overflowDir, { recursive: true });
        const file = path.join(this.overflowDir, createHash('sha256').update(key).digest('hex') + '.json');
        if (fs.existsSync(file)) return;
        fs.writeFileSync(file + '.tmp', JSON.stringify(event), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
        return;
      } catch (e) { this.log(`[meter] spill write failed; retaining event in memory: ${errorTag(e)}`); }
    }
    this.events.push(event);
    this.persist(); if (this.events.length >= 100) void this.flush();
  }
  async flush() {
    if (!this.enabled || this.pending) return this.pending;
    const batch = this.events.slice(0, 100);
    const spilled = [];
    try {
      // Use a directory iterator so an extended outage cannot require loading all
      // spill filenames or events into memory just to deliver one batch.
      if (batch.length < 100 && fs.existsSync(this.overflowDir)) {
        const dir = fs.opendirSync(this.overflowDir);
        try {
          let item;
          while (batch.length < 100 && (item = dir.readSync())) {
            if (!item.isFile() || !/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
            const file = path.join(this.overflowDir, item.name);
            try {
              const event = JSON.parse(fs.readFileSync(file, 'utf8'));
              if (!queuedEvent(event)) throw new Error('Invalid meter event');
              batch.push(event); spilled.push(file);
            } catch (e) {
              // Keep corrupt records for repair, but do not poison every good batch.
              this.log(`[meter] spill read failed; file retained for repair: ${errorTag(e)}`);
              try { fs.renameSync(file, file + '.invalid'); } catch { /* Preserve the original when quarantine fails. */ }
            }
          }
        } finally { dir.closeSync(); }
      }
    } catch (e) { this.log(`[meter] spill scan failed: ${errorTag(e)}`); }
    if (!batch.length) return;
    this.pending = Promise.resolve().then(async () => {
      try {
        const res = await this.fetch(`${String(this.api.baseUrl).replace(/\/+$/, '')}/fish/meter-events`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.api.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw Object.assign(new Error('Meter delivery rejected'), { status: res.status });
        const ack = await res.json();
        if (!isRecord(ack) || ack.ok === false || !Number.isSafeInteger(ack.accepted) || !Number.isSafeInteger(ack.duplicates)
            || ack.accepted < 0 || ack.duplicates < 0 || ack.accepted + ack.duplicates !== batch.length) throw new Error('Invalid meter acknowledgement');
        const keys = new Set(batch.map(e => e.idempotencyKey)); this.events = this.events.filter(e => !keys.has(e.idempotencyKey)); this.persist();
        for (const file of spilled) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') this.log(`[meter] spill cleanup failed: ${errorTag(e)}`); } }
      } catch (e) { this.log(`[meter] delivery failed: ${errorTag(e)}`); }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  close() { if (this.timer) clearInterval(this.timer); if (this.enabled) this.persist(); }
}
