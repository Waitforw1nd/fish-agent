import net from 'node:net';
import { id, now } from './util.js';
import { immediateTransaction } from './db.js';

export function isPortFree(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* ignore */ }
      resolve(free);
    };
    server.unref();
    server.once('error', () => done(false));
    server.listen({ port, host, exclusive: true }, () => done(true));
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

export class PortAllocator {
  constructor({ db, config, logger }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
  }

  find(tenantId, purpose) {
    return this.db.prepare(`
      SELECT * FROM port_leases
      WHERE tenant_id = ? AND purpose = ? AND released_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, purpose) || null;
  }

  activeSet() {
    const rows = this.db.prepare('SELECT port FROM port_leases WHERE released_at IS NULL').all();
    return new Set(rows.map((row) => Number(row.port)));
  }

  async allocate(tenantId, purpose, { preferredPort = null, host = '127.0.0.1', meta = null } = {}) {
    const existing = this.find(tenantId, purpose);
    if (existing) return this.publicLease(existing);
    const start = this.config.portRangeStart;
    const end = this.config.portRangeEnd;
    if (end < start) throw new Error('invalid port range');

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = immediateTransaction(this.db, () => {
        const taken = this.activeSet();
        if (preferredPort && !taken.has(Number(preferredPort)) && this._inRange(Number(preferredPort))) {
          return Number(preferredPort);
        }
        const offset = Math.abs(hashCode(`${tenantId}:${purpose}`)) % (end - start + 1);
        for (let i = 0; i < end - start + 1; i += 1) {
          const port = start + ((offset + i) % (end - start + 1));
          if (!taken.has(port)) return port;
        }
        return null;
      });
      if (!candidate) throw Object.assign(new Error('端口池已耗尽'), { status: 503, code: 'PORTS_EXHAUSTED' });
      // Check both loopback and wildcard conflicts before committing the lease.
      const free = await isPortFree(candidate, host) && await isPortFree(candidate, '0.0.0.0');
      if (!free) {
        if (preferredPort) preferredPort = null;
        continue;
      }
      try {
        const leaseId = id('prt');
        immediateTransaction(this.db, () => {
          const taken = this.db.prepare('SELECT 1 AS ok FROM port_leases WHERE port = ? AND released_at IS NULL').get(candidate);
          if (taken) throw Object.assign(new Error('port race'), { code: 'PORT_RACE' });
          this.db.prepare(`
            INSERT INTO port_leases (id, tenant_id, purpose, host, port, created_at, released_at, meta)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
          `).run(leaseId, tenantId, purpose, host, candidate, now(), meta ? JSON.stringify(meta) : null);
        });
        return this.publicLease(this.db.prepare('SELECT * FROM port_leases WHERE id = ?').get(leaseId));
      } catch (error) {
        if (error.code !== 'PORT_RACE') throw error;
      }
    }
    throw Object.assign(new Error('无法分配空闲端口'), { status: 503, code: 'PORT_ALLOCATION_FAILED' });
  }

  _inRange(port) {
    return port >= this.config.portRangeStart && port <= this.config.portRangeEnd;
  }

  release(tenantId, purpose) {
    return this.db.prepare(`
      UPDATE port_leases SET released_at = ? WHERE tenant_id = ? AND purpose = ? AND released_at IS NULL
    `).run(now(), tenantId, purpose).changes;
  }

  releaseAll(tenantId) {
    return this.db.prepare('UPDATE port_leases SET released_at = ? WHERE tenant_id = ? AND released_at IS NULL')
      .run(now(), tenantId).changes;
  }

  releaseLease(leaseId) {
    this.db.prepare('UPDATE port_leases SET released_at = ? WHERE id = ? AND released_at IS NULL').run(now(), leaseId);
  }

  releaseExpired(olderThanMs) {
    const cutoff = now() - olderThanMs;
    this.db.prepare('UPDATE port_leases SET released_at = ? WHERE released_at IS NULL AND created_at < ?')
      .run(now(), cutoff);
  }

  publicLease(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      purpose: row.purpose,
      host: row.host,
      port: Number(row.port),
      createdAt: row.created_at,
      meta: row.meta ? JSON.parse(row.meta) : null
    };
  }
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}
