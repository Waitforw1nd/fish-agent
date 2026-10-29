import { id, now } from './util.js';
import { immediateTransaction, transaction } from './db.js';
import { calculateCostMicros, priceFor } from './pricing.js';

function error(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

export class BillingService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  ensureWallet(tenantId, initialMicros = 0) {
    const existing = this.db.prepare('SELECT * FROM wallets WHERE tenant_id = ?').get(tenantId);
    if (existing) return existing;
    const ts = now();
    this.db.prepare('INSERT INTO wallets (tenant_id, balance_micros, updated_at) VALUES (?, ?, ?)')
      .run(tenantId, Math.max(0, Number(initialMicros) || 0), ts);
    if (initialMicros) {
      this.db.prepare(`
        INSERT INTO wallet_transactions (id, tenant_id, amount_micros, kind, note, created_at)
        VALUES (?, ?, ?, 'grant', '初始额度', ?)
      `).run(id('wtx'), tenantId, Math.max(0, Number(initialMicros) || 0), ts);
    }
    return this.db.prepare('SELECT * FROM wallets WHERE tenant_id = ?').get(tenantId);
  }

  expireHolds(tenantId = null) {
    const ts = now();
    const rows = tenantId
      ? this.db.prepare("SELECT id FROM reservations WHERE status = 'held' AND expires_at <= ? AND tenant_id = ?").all(ts, tenantId)
      : this.db.prepare("SELECT id FROM reservations WHERE status = 'held' AND expires_at <= ?").all(ts);
    if (!rows.length) return 0;
    immediateTransaction(this.db, () => {
      for (const row of rows) {
        this.db.prepare("UPDATE reservations SET status = 'expired', settled_at = ? WHERE id = ? AND status = 'held'")
          .run(ts, row.id);
      }
    });
    return rows.length;
  }

  heldMicros(tenantId) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(estimated_micros), 0) AS held
      FROM reservations WHERE tenant_id = ? AND status = 'held' AND expires_at > ?
    `).get(tenantId, now());
    return Number(row?.held ?? 0);
  }

  wallet(tenantId) {
    const row = this.db.prepare('SELECT * FROM wallets WHERE tenant_id = ?').get(tenantId);
    const balanceMicros = Number(row?.balance_micros ?? 0);
    const held = this.heldMicros(tenantId);
    return {
      balanceMicros,
      heldMicros: held,
      availableMicros: balanceMicros - held,
      updatedAt: row?.updated_at ?? null
    };
  }

  credit(tenantId, amountMicros, note = '人工充值', kind = 'credit') {
    const amount = Math.trunc(Number(amountMicros));
    if (!Number.isFinite(amount) || amount === 0) throw error(400, 'INVALID_AMOUNT', '金额必须是非零整数微元');
    this.ensureWallet(tenantId);
    transaction(this.db, () => {
      this.db.prepare('UPDATE wallets SET balance_micros = balance_micros + ?, updated_at = ? WHERE tenant_id = ?')
        .run(amount, now(), tenantId);
      this.db.prepare(`
        INSERT INTO wallet_transactions (id, tenant_id, amount_micros, kind, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id('wtx'), tenantId, amount, kind, String(note).slice(0, 300), now());
    });
    return this.wallet(tenantId);
  }

  reserve({ tenantId, keyId, model, estimatedMicros, maxTokens, ttlMs = 120_000 }) {
    this.expireHolds(tenantId);
    return immediateTransaction(this.db, () => {
      const walletRow = this.db.prepare('SELECT balance_micros FROM wallets WHERE tenant_id = ?').get(tenantId);
      const balance = Number(walletRow?.balance_micros ?? 0);
      const held = Number(this.db.prepare(`
        SELECT COALESCE(SUM(estimated_micros), 0) AS held FROM reservations
        WHERE tenant_id = ? AND status = 'held' AND expires_at > ?
      `).get(tenantId, now()).held);
      const available = balance - held;
      if (available < estimatedMicros) {
        throw error(402, 'INSUFFICIENT_BALANCE', '余额不足，请充值或更换套餐', {
          balanceMicros: balance,
          heldMicros: held,
          availableMicros: available,
          requiredMicros: estimatedMicros
        });
      }
      const reservationId = id('rsv');
      const ts = now();
      this.db.prepare(`
        INSERT INTO reservations (id, tenant_id, key_id, model, estimated_micros, max_tokens, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?)
      `).run(reservationId, tenantId, keyId, model, estimatedMicros, maxTokens, ts, ts + ttlMs);
      return {
        id: reservationId,
        estimatedMicros,
        maxTokens,
        expiresAt: ts + ttlMs
      };
    });
  }

  settle({ reservation, usage = {}, upstreamStatus = 200, requestId = null, attribution = {}, usageSource = 'unknown' }) {
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
      if (!row || row.status !== 'held') {
        return { settled: false, reason: 'reservation-not-held', costMicros: 0 };
      }
      const cost = calculateCostMicros(row.model, usage) ?? 0;
      const promptTokens = Math.max(0, Number(usage.prompt_tokens) || 0);
      const completionTokens = Math.max(0, Number(usage.completion_tokens) || 0);
      const cachedTokens = Math.min(promptTokens, Math.max(0, Number(usage.cached_tokens) || 0));
      const ts = now();
      this.db.prepare(`
        UPDATE reservations SET status = 'settled', settled_at = ?, actual_micros = ?,
          prompt_tokens = ?, completion_tokens = ?, cached_tokens = ?, upstream_status = ?
        WHERE id = ?
      `).run(ts, cost, promptTokens, completionTokens, cachedTokens, upstreamStatus, row.id);
      this.db.prepare('UPDATE wallets SET balance_micros = balance_micros - ?, updated_at = ? WHERE tenant_id = ?')
        .run(cost, ts, row.tenant_id);
      this.db.prepare(`
        INSERT INTO ledger (id, tenant_id, key_id, reservation_id, model, prompt_tokens, completion_tokens,
          cached_tokens, cost_micros, upstream_status, request_id, created_at, platform, chat_key, run_id, vision, usage_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id('led'), row.tenant_id, row.key_id, row.id, row.model, promptTokens, completionTokens,
        cachedTokens, cost, upstreamStatus, requestId, ts, attribution.platform || null, attribution.chatKey || null,
        attribution.runId || null, attribution.vision ? 1 : 0, ['reported', 'estimated'].includes(usageSource) ? usageSource : 'unknown');
      return {
        settled: true,
        costMicros: cost,
        promptTokens,
        completionTokens,
        cachedTokens,
        wallet: this.wallet(row.tenant_id)
      };
    });
  }

  release(reservationId, reason = 'released') {
    const ts = now();
    const row = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    if (!row || row.status !== 'held') return false;
    this.db.prepare("UPDATE reservations SET status = 'released', settled_at = ? WHERE id = ? AND status = 'held'")
      .run(ts, reservationId);
    this.logger?.debug?.('relay reservation released', { reservationId, reason });
    return true;
  }

  usageSummary(tenantId, { days = 30 } = {}) {
    const since = now() - Math.max(1, Math.min(365, Number(days) || 30)) * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(`
      SELECT model, prompt_tokens, completion_tokens, cached_tokens, cost_micros, created_at, platform, chat_key, run_id, vision, usage_source
      FROM ledger WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at ASC
    `).all(tenantId, since);
    const totals = { requests: rows.length, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0 };
    const dailyMap = new Map();
    const modelMap = new Map();
    const chatMap = new Map();
    const usageSources = { reported: 0, estimated: 0, unknown: 0 };
    let visionRequests = 0;
    let visionRequestCostMicros = 0;
    for (const row of rows) {
      const cost = Number(row.cost_micros) || 0;
      const prompt = Number(row.prompt_tokens) || 0;
      const completion = Number(row.completion_tokens) || 0;
      const cached = Number(row.cached_tokens) || 0;
      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.cachedTokens += cached;
      totals.costMicros += cost;
      const date = new Date(Number(row.created_at)).toISOString().slice(0, 10);
      const source = ['reported', 'estimated'].includes(row.usage_source) ? row.usage_source : 'unknown';
      usageSources[source]++;
      if (row.vision) { visionRequests++; visionRequestCostMicros += cost; }
      const platform = row.platform || null;
      const chatKey = row.chat_key || null;
      const key = JSON.stringify([date, row.model, platform, chatKey]);
      const chat = chatMap.get(key) || { date, model: row.model, platform, chatKey, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0, visionRequests: 0, visionRequestCostMicros: 0, usageSources: { reported: 0, estimated: 0, unknown: 0 } };
      chat.requests++; chat.promptTokens += prompt; chat.completionTokens += completion; chat.cachedTokens += cached; chat.costMicros += cost;
      chat.usageSources[source]++;
      if (row.vision) { chat.visionRequests++; chat.visionRequestCostMicros += cost; }
      chatMap.set(key, chat);
      const day = dailyMap.get(date) || {
        date, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0, models: new Map()
      };
      day.requests += 1;
      day.promptTokens += prompt;
      day.completionTokens += completion;
      day.cachedTokens += cached;
      day.costMicros += cost;
      const dayModel = day.models.get(row.model) || {
        model: row.model, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0
      };
      dayModel.requests += 1;
      dayModel.promptTokens += prompt;
      dayModel.completionTokens += completion;
      dayModel.cachedTokens += cached;
      dayModel.costMicros += cost;
      day.models.set(row.model, dayModel);
      dailyMap.set(date, day);
      const model = modelMap.get(row.model) || { model: row.model, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0 };
      model.requests += 1;
      model.promptTokens += prompt;
      model.completionTokens += completion;
      model.cachedTokens += cached;
      model.costMicros += cost;
      modelMap.set(row.model, model);
    }
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = dailyMap.get(today) || { date: today, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costMicros: 0 };
    const daily = [...dailyMap.values()].map((day) => {
      const models = [...day.models.values()].sort((a, b) => b.costMicros - a.costMicros);
      return {
        date: day.date,
        requests: day.requests,
        promptTokens: day.promptTokens,
        completionTokens: day.completionTokens,
        cachedTokens: day.cachedTokens,
        costMicros: day.costMicros,
        totals: {
          requests: day.requests,
          promptTokens: day.promptTokens,
          completionTokens: day.completionTokens,
          cachedTokens: day.cachedTokens,
          totalTokens: day.promptTokens + day.completionTokens,
          costMicros: day.costMicros
        },
        models
      };
    });
    return {
      days: Math.max(1, Math.min(365, Number(days) || 30)),
      totals,
      today: todayRow,
      daily,
      byModel: [...modelMap.values()].sort((a, b) => b.costMicros - a.costMicros),
      byChat: [...chatMap.values()].sort((a, b) => b.date.localeCompare(a.date) || b.costMicros - a.costMicros),
      usageSources,
      visionRequests,
      visionRequestCostMicros,
      pricing: ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini']
        .map((model) => ({ model, ...priceFor(model) }))
        .filter((entry) => entry.inputPerMillion !== undefined)
    };
  }

  recordRelayLog({ tenantId, requestId = null, model, status, tokens = 0, costMicros = 0, latencyMs = 0, error: message = null, source = 'platform' }) {
    this.db.prepare(`
      INSERT INTO relay_logs (id, tenant_id, request_id, model, status, tokens, cost_micros, latency_ms, error, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id('rlog'), tenantId, requestId, String(model || '').slice(0, 200), Math.trunc(Number(status) || 500),
      Math.max(0, Math.trunc(Number(tokens) || 0)), Math.max(0, Math.trunc(Number(costMicros) || 0)),
      Math.max(0, Math.trunc(Number(latencyMs) || 0)), message ? String(message).slice(0, 500) : null,
      source === 'custom' ? 'custom' : 'platform', now()
    );
  }

  relayLogs(tenantId, { days = 30, limit = 100, model = '', status = '' } = {}) {
    const since = now() - Math.max(1, Math.min(365, Number(days) || 30)) * 24 * 60 * 60 * 1000;
    const take = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));
    const clauses = ['tenant_id = ?', 'created_at >= ?'];
    const params = [tenantId, since];
    if (model) {
      clauses.push('model = ?');
      params.push(String(model));
    }
    if (status === 'success') clauses.push('status >= 200 AND status < 300');
    else if (status === 'error') clauses.push('(status < 200 OR status >= 300)');
    else if (status !== '' && status !== null && status !== undefined) {
      const numeric = Number(status);
      if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) throw error(400, 'INVALID_LOG_STATUS', 'status 必须是 HTTP 状态码、success 或 error');
      clauses.push('status = ?');
      params.push(numeric);
    }
    const rows = this.db.prepare(`
      SELECT created_at, request_id, model, status, tokens, cost_micros, latency_ms, error, source
      FROM relay_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params, take);
    return rows.map((row) => ({
      time: row.created_at,
      requestId: row.request_id,
      model: row.model,
      status: row.status,
      tokens: row.tokens,
      cost: row.cost_micros,
      latency: row.latency_ms,
      error: row.error || null,
      source: row.source
    }));
  }

  createRecharge(tenantId, amountMicros, userId) {
    const amount = amountMicros;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw error(400, 'INVALID_RECHARGE_AMOUNT', '充值金额必须是正整数微元');
    const rechargeId = id('recharge');
    this.db.prepare(`
      INSERT INTO recharges (id, tenant_id, amount_micros, status, created_by_user_id, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(rechargeId, tenantId, amount, userId, now());
    return this.recharge(rechargeId);
  }

  recharge(rechargeId) {
    const row = this.db.prepare('SELECT * FROM recharges WHERE id = ?').get(rechargeId);
    return row ? serializeRecharge(row) : null;
  }

  recharges(tenantId) {
    return this.db.prepare('SELECT * FROM recharges WHERE tenant_id = ? ORDER BY created_at DESC, id DESC')
      .all(tenantId).map(serializeRecharge);
  }

  listRecharges({ status = 'all', tenantId = '', limit = 100 } = {}) {
    if (!['all', 'pending', 'confirmed', 'rejected'].includes(status)) {
      throw error(400, 'INVALID_RECHARGE_STATUS', '充值状态无效');
    }
    const conditions = [];
    const params = [];
    if (status !== 'all') { conditions.push('r.status = ?'); params.push(status); }
    if (tenantId) { conditions.push('r.tenant_id = ?'); params.push(tenantId); }
    params.push(Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100)));
    return this.db.prepare(`
      SELECT r.*, t.name AS tenant_name, t.slug AS tenant_slug,
        u.username AS created_by_username, reviewer.username AS reviewed_by_username
      FROM recharges r
      LEFT JOIN tenants t ON t.id = r.tenant_id
      LEFT JOIN users u ON u.id = r.created_by_user_id
      LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by_user_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?
    `).all(...params).map(serializeRecharge);
  }

  transactions(tenantId, limit = 100) {
    return this.db.prepare(`
      SELECT id, tenant_id, amount_micros, kind, note, created_at FROM wallet_transactions
      WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(tenantId, Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100)))
      .map((row) => ({
        id: row.id, tenantId: row.tenant_id, amountMicros: Number(row.amount_micros),
        kind: row.kind, note: row.note || '', createdAt: row.created_at
      }));
  }

  reviewNote(value, required = false) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw error(400, 'INVALID_REVIEW_NOTE', '审核备注必须是文本');
    }
    const note = String(value || '').trim();
    if ((required && !note) || note.length > 500) {
      throw error(400, 'INVALID_REVIEW_NOTE', required ? '请填写不超过 500 字的驳回原因' : '审核备注不能超过 500 字');
    }
    return note || null;
  }

  confirmRecharge(rechargeId, adminUserId, note) {
    const reviewNote = this.reviewNote(note);
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM recharges WHERE id = ?').get(rechargeId);
      if (!row) throw error(404, 'RECHARGE_NOT_FOUND', '充值订单不存在');
      if (row.status !== 'pending') throw error(409, 'RECHARGE_ALREADY_CONFIRMED', '充值订单已审核，不能重复到账');
      const ts = now();
      const updated = this.db.prepare(`
        UPDATE recharges SET status = 'confirmed', confirmed_by_user_id = ?, confirmed_at = ?,
          reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?
        WHERE id = ? AND status = 'pending'
      `).run(adminUserId, ts, adminUserId, ts, reviewNote, rechargeId);
      if (Number(updated.changes) !== 1) throw error(409, 'RECHARGE_ALREADY_CONFIRMED', '充值订单已审核，不能重复到账');
      const wallet = this.credit(row.tenant_id, row.amount_micros, `充值订单 ${rechargeId}`, 'recharge');
      return { recharge: serializeRecharge(this.db.prepare('SELECT * FROM recharges WHERE id = ?').get(rechargeId)), wallet };
    });
  }

  rejectRecharge(rechargeId, adminUserId, note) {
    const reviewNote = this.reviewNote(note, true);
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM recharges WHERE id = ?').get(rechargeId);
      if (!row) throw error(404, 'RECHARGE_NOT_FOUND', '充值订单不存在');
      if (row.status !== 'pending') throw error(409, 'RECHARGE_ALREADY_CONFIRMED', '充值订单已审核，不能重复审核');
      const updated = this.db.prepare(`
        UPDATE recharges SET status = 'rejected', reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?
        WHERE id = ? AND status = 'pending'
      `).run(adminUserId, now(), reviewNote, rechargeId);
      if (Number(updated.changes) !== 1) throw error(409, 'RECHARGE_ALREADY_CONFIRMED', '充值订单已审核，不能重复审核');
      return serializeRecharge(this.db.prepare('SELECT * FROM recharges WHERE id = ?').get(rechargeId));
    });
  }

  platformStats() {
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount_micros), 0) AS amount FROM recharges WHERE status = 'pending'
    `).get();
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const readUsage = (since) => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS prompt,
          COALESCE(SUM(completion_tokens), 0) AS completion, COALESCE(SUM(cost_micros), 0) AS cost
        FROM ledger WHERE created_at >= ?
      `).get(since);
      return { requests: Number(row.requests), promptTokens: Number(row.prompt), completionTokens: Number(row.completion),
        totalTokens: Number(row.prompt) + Number(row.completion), costMicros: Number(row.cost) };
    };
    return {
      pendingRecharges: { count: Number(pending.count), amountMicros: Number(pending.amount) },
      today: readUsage(today.getTime()), last7Days: readUsage(now() - 7 * 86400000)
    };
  }

  hasBalance(tenantId, micros = 1) {
    return this.wallet(tenantId).availableMicros >= micros;
  }
}

function serializeRecharge(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    amountMicros: Number(row.amount_micros),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    confirmedByUserId: row.confirmed_by_user_id || null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
    reviewedByUserId: row.reviewed_by_user_id || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null,
    tenantName: row.tenant_name || null,
    tenantSlug: row.tenant_slug || null,
    createdByUsername: row.created_by_username || null,
    reviewedByUsername: row.reviewed_by_username || null
  };
}
