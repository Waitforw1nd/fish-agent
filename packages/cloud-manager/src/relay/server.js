import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { getPlan } from '../plans.js';
import { estimateHoldMicros } from '../pricing.js';
import { estimateMessagesTokens, estimateTokens } from '../plans.js';
import { now, truncate } from '../util.js';
import { requestJson } from '../qq/common.js';

const OPENAI_ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'insufficient_quota',
  403: 'permission_error',
  404: 'invalid_request_error',
  408: 'timeout_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'upstream_error',
  503: 'upstream_error',
  504: 'timeout_error'
};

const FORWARD_FIELDS = [
  'messages', 'temperature', 'top_p', 'n', 'stop', 'presence_penalty', 'frequency_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'user', 'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format', 'seed', 'reasoning_effort', 'thinking', 'extra_body'
];

function relayError(status, code, message, param = null) {
  return Object.assign(new Error(message), { status, code, param, relay: true });
}

function sendOpenAIError(res, status, code, message, { param = null, headers = {} } = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify({
    error: {
      message: String(message || 'request failed'),
      type: OPENAI_ERROR_TYPES[status] || 'server_error',
      param,
      code
    }
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : '';
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(relayError(413, 'request_too_large', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(relayError(400, 'invalid_request', String(error?.message || error))));
  });
}

function extractUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isSafeInteger(prompt) || prompt < 0 || !Number.isSafeInteger(completion) || completion < 0) return null;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cache_read_input_tokens
    ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: Number.isSafeInteger(cached) ? Math.max(0, Math.min(prompt, cached)) : 0,
    total_tokens: prompt + completion
  };
}

function fallbackUsage(messages, contentText) {
  const prompt = estimateMessagesTokens(messages);
  const completion = estimateTokens(contentText);
  return { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: 0, total_tokens: prompt + completion };
}

function attributionOf(raw, messages) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw relayError(400, 'invalid_attribution', '归因信息必须是对象');
  const value = raw || {};
  if (Object.keys(value).some(key => !['platform', 'chatKey', 'runId', 'vision'].includes(key))) throw relayError(400, 'invalid_attribution', '归因字段无效');
  const platform = value.platform == null || value.platform === '' ? null : value.platform;
  const chatKey = value.chatKey == null || value.chatKey === '' ? null : value.chatKey;
  const runId = value.runId == null || value.runId === '' ? null : value.runId;
  if (platform !== null && !['qq', 'bili'].includes(platform)) throw relayError(400, 'invalid_attribution', '归因平台无效');
  if (chatKey !== null && (typeof chatKey !== 'string' || !/^(group|private):[1-9]\d{0,15}$/.test(chatKey) || !Number.isSafeInteger(Number(chatKey.split(':')[1])))) throw relayError(400, 'invalid_attribution', '归因会话无效');
  if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(runId))) throw relayError(400, 'invalid_attribution', '归因运行标识无效');
  if (value.vision !== undefined && typeof value.vision !== 'boolean') throw relayError(400, 'invalid_attribution', '视觉标记无效');
  const vision = Boolean(value.vision || messages.some(m => Array.isArray(m?.content) && m.content.some(p => ['image_url', 'image', 'video_url', 'video'].includes(p?.type))));
  return { platform, chatKey, runId, vision };
}

function completionText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  let out = '';
  for (const choice of choices) {
    const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text;
    if (typeof content === 'string') out += content;
    if (choice?.message?.tool_calls) out += JSON.stringify(choice.message.tool_calls);
  }
  return out;
}

function contentTextFromBody(body) {
  try { return JSON.stringify(body); } catch { return ''; }
}

export class RelayService {
  constructor({ config, db, billing, relayKeys, tenants, settings, customUpstreams, logger }) {
    this.config = config;
    this.db = db;
    this.billing = billing;
    this.relayKeys = relayKeys;
    this.tenants = tenants;
    this.settings = settings;
    this.customUpstreams = customUpstreams;
    this.logger = logger;
    this.rate = new Map();
    this.inflight = new Map();
    this.modelsCache = new Map();
  }

  upstream() {
    const stored = this.settings.get('upstream', null) || {};
    const baseUrl = String(stored.baseUrl || this.config.upstreamBaseUrl || '').replace(/\/+$/, '');
    const apiKey = String(stored.apiKey || this.config.upstreamApiKey || '');
    return { baseUrl, apiKey, configured: Boolean(baseUrl && apiKey), source: stored.baseUrl ? 'admin' : 'env' };
  }

  setUpstream({ baseUrl, apiKey, clear = false }) {
    if (clear) {
      this.settings.delete('upstream');
      this.modelsCache.clear();
      return this.upstreamPublic();
    }
    let normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!normalized) throw Object.assign(new Error('上游 Base URL 不能为空'), { status: 400, code: 'INVALID_UPSTREAM_URL' });
    let parsed;
    try { parsed = new URL(normalized); } catch { throw Object.assign(new Error('上游 Base URL 不是合法 URL'), { status: 400, code: 'INVALID_UPSTREAM_URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('上游只支持 http/https'), { status: 400, code: 'INVALID_UPSTREAM_URL' });
    if (parsed.username || parsed.password) throw Object.assign(new Error('上游 URL 不能包含凭据'), { status: 400, code: 'INVALID_UPSTREAM_URL' });
    const value = { baseUrl: normalized };
    if (apiKey !== undefined) value.apiKey = String(apiKey || '').trim();
    else {
      const previous = this.settings.get('upstream', null) || {};
      if (previous.apiKey) value.apiKey = previous.apiKey;
      else if (this.config.upstreamApiKey) value.apiKey = this.config.upstreamApiKey;
    }
    this.settings.set('upstream', value);
    this.modelsCache.clear();
    return this.upstreamPublic();
  }

  upstreamPublic() {
    const up = this.upstream();
    return { configured: up.configured, baseUrl: up.baseUrl || null, hasKey: Boolean(up.apiKey), source: up.source };
  }

  upstreamUrl(path) {
    const up = this.upstream();
    if (!up.baseUrl) throw relayError(503, 'upstream_not_configured', '平台中转尚未配置上游');
    const base = up.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/${path}` : `${base}/v1/${path}`;
  }

  async fetchModels(tenant = null) {
    const custom = tenant ? this.customUpstreams?.get(tenant.id) : null;
    const up = custom?.configured ? custom : this.upstream();
    if (!up.configured || !up.apiKey) return { ok: false, models: [], error: '上游未配置' };
    const cacheKey = crypto.createHash('sha256').update(`${tenant?.id || 'platform'}|${up.baseUrl}|${up.apiKey}`).digest('hex');
    const cached = this.modelsCache.get(cacheKey);
    if (cached && now() - cached.at < this.config.upstreamModelsTtlMs) return cached.value;
    let response;
    try {
      let url = this.upstreamUrl('models');
      let lookup;
      if (custom?.configured) {
        const resolved = await this.customUpstreams.resolve(up.baseUrl);
        url = this.customUpstreams.url(resolved.url.toString(), 'models');
        lookup = resolved.lookup;
      }
      response = await requestJson(url, {
        headers: { authorization: `Bearer ${up.apiKey}` },
        timeoutMs: 8000,
        lookup
      });
    } catch (error) {
      const value = { ok: false, models: [], error: `无法连接上游: ${error.message}` };
      this.modelsCache.set(cacheKey, { at: now(), value });
      return value;
    }
    if (response.status < 200 || response.status >= 300) {
      const value = { ok: false, models: [], error: `上游 /models 返回 HTTP ${response.status}` };
      this.modelsCache.set(cacheKey, { at: now(), value });
      return value;
    }
    const data = Array.isArray(response.body?.data) ? response.body.data
      : Array.isArray(response.body?.models) ? response.body.models : [];
    const models = data.map((entry) => typeof entry === 'string' ? entry : entry?.id).filter(Boolean);
    const value = { ok: true, models: [...new Set(models)], error: null };
    this.modelsCache.set(cacheKey, { at: now(), value });
    return value;
  }

  async panelModels(tenant) {
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    const custom = this.customUpstreams?.get(tenant.id);
    const upstream = await this.fetchModels(tenant);
    const upstreamIds = upstream.models;
    if (custom?.configured) {
      const ids = upstream.ok ? [...new Set([custom.model, ...upstreamIds])] : [custom.model];
      return {
        models: ids.map((id) => ({ id, allowed: id === custom.model, upstream: upstream.ok ? upstreamIds.includes(id) : null })),
        allowed: [custom.model],
        upstream: { ok: upstream.ok, error: upstream.error, count: upstreamIds.length },
        plan: plan.id,
        source: 'custom'
      };
    }
    const models = (upstream.ok ? upstreamIds : plan.models).map((id) => ({
      id,
      allowed: plan.models.includes('*') || plan.models.includes(id),
      upstream: upstream.ok ? upstreamIds.includes(id) : null
    }));
    return {
      models,
      allowed: plan.models.includes('*') ? models.filter((m) => m.allowed).map((m) => m.id) : [...plan.models],
      upstream: { ok: upstream.ok, error: upstream.error, count: upstreamIds.length },
      plan: plan.id,
      source: 'platform'
    };
  }

  async authenticate(req) {
    const key = bearer(req);
    if (!key) throw relayError(401, 'invalid_api_key', '缺少 Bearer API Key');
    const result = this.relayKeys.authenticate(key);
    if (!result) throw relayError(401, 'invalid_api_key', 'API Key 无效或已吊销');
    if (result.error === 'tenant_expired') throw relayError(402, 'insufficient_quota', '租户已到期，请续费后继续使用');
    const tenant = this.tenants.row(result.row.tenant_id);
    if (!tenant) throw relayError(401, 'invalid_api_key', 'API Key 所属租户不存在');
    if (tenant.status !== 'active' || Number(tenant.expires_at) <= now()) {
      throw relayError(402, 'insufficient_quota', '租户已到期或被暂停');
    }
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    return { keyRow: result.row, tenant, plan };
  }

  checkRate(tenant, plan, tokens) {
    const ts = now();
    const cutoff = ts - this.config.rateLimitWindowMs;
    let entry = this.rate.get(tenant.id);
    if (!entry) { entry = { events: [] }; this.rate.set(tenant.id, entry); }
    entry.events = entry.events.filter((event) => event.at > cutoff);
    if (entry.events.length >= plan.rpm) {
      const retryAfter = Math.max(1, Math.ceil((entry.events[0].at + this.config.rateLimitWindowMs - ts) / 1000));
      const error = relayError(429, 'rate_limit_exceeded', `请求频率超过套餐限制 (${plan.rpm} RPM)`);
      error.retryAfter = retryAfter;
      throw error;
    }
    const used = entry.events.reduce((sum, event) => sum + event.tokens, 0);
    if (used + tokens > plan.tpm) {
      throw relayError(429, 'rate_limit_exceeded', `Token 速率超过套餐限制 (${plan.tpm} TPM)`);
    }
    entry.events.push({ at: ts, tokens });
    return entry.events;
  }

  trackInflight(tenant, plan) {
    const current = this.inflight.get(tenant.id) || 0;
    if (current >= plan.maxConcurrent) {
      throw relayError(429, 'rate_limit_exceeded', `并发请求超过套餐限制 (${plan.maxConcurrent})`);
    }
    this.inflight.set(tenant.id, current + 1);
    return () => {
      const next = Math.max(0, (this.inflight.get(tenant.id) || 1) - 1);
      if (next) this.inflight.set(tenant.id, next);
      else this.inflight.delete(tenant.id);
    };
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        sendJson(res, 200, { ok: true, service: 'relay' });
        return;
      }
      if (url.pathname === '/v1/models' || url.pathname === '/models') {
        if (req.method !== 'GET') { sendOpenAIError(res, 405, 'method_not_allowed', '仅支持 GET'); return; }
        const auth = await this.authenticate(req);
        const data = await this.panelModels(auth.tenant);
        sendJson(res, 200, {
          object: 'list',
          data: data.models.filter((m) => m.allowed).map((m) => ({
            id: m.id, object: 'model', created: 0, owned_by: 'fish'
          }))
        });
        return;
      }
      if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
        if (req.method !== 'POST') { sendOpenAIError(res, 405, 'method_not_allowed', '仅支持 POST'); return; }
        await this.handleChat(req, res);
        return;
      }
      sendOpenAIError(res, 404, 'not_found', '未知的 Relay 端点');
    } catch (error) {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      const status = Number(error?.status) || 500;
      if (status >= 500) this.logger?.error?.('relay error', error);
      const headers = {};
      if (error?.retryAfter) headers['retry-after'] = String(error.retryAfter);
      sendOpenAIError(res, status, error?.code || 'server_error', status === 500 ? '中转服务器内部错误' : error.message, { param: error?.param || null, headers });
    }
  }

  async handleChat(req, res) {
    const requestId = crypto.randomUUID();
    const startedAt = now();
    let tenantId = null;
    let model = '';
    let source = 'platform';
    let recorded = false;
    const record = ({ status, tokens = 0, costMicros = 0, error = null }) => {
      if (recorded || !tenantId) return;
      recorded = true;
      try {
        this.billing.recordRelayLog({
          tenantId, requestId, model, status, tokens, costMicros,
          latencyMs: now() - startedAt, error, source
        });
      } catch (logError) {
        this.logger?.error?.('relay usage log failed', logError);
      }
    };
    const context = (next) => {
      if (next.auth) tenantId = next.auth.tenant.id;
      if (next.model !== undefined) model = next.model;
      if (next.source) source = next.source;
    };
    try {
      await this.performChat(req, res, { requestId, record, context });
    } catch (error) {
      record({ status: Number(error?.status) || 500, error: error?.code || 'request_failed' });
      throw error;
    }
  }

  async performChat(req, res, { requestId, record, context }) {
    const auth = await this.authenticate(req);
    context({ auth });
    const custom = this.customUpstreams?.get(auth.tenant.id);
    const source = custom?.configured ? 'custom' : 'platform';
    context({ source });
    const raw = await readBody(req, this.config.relayMaxBodyBytes);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw relayError(400, 'invalid_json', '请求体不是合法 JSON'); }
    if (!body || typeof body !== 'object') throw relayError(400, 'invalid_request', '请求体必须是对象');
    const model = String(body.model || '');
    context({ model });
    if (!model) throw relayError(400, 'invalid_model', '缺少 model 字段');
    if (custom?.configured ? model !== custom.model : !(auth.plan.models.includes('*') || auth.plan.models.includes(model))) {
      throw relayError(403, 'model_not_allowed', custom?.configured ? `自定义上游仅允许模型 ${custom.model}` : `模型 ${model} 不在当前套餐白名单内`);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw relayError(400, 'invalid_messages', 'messages 不能为空');
    }
    const attribution = attributionOf(body._fish_attribution, body.messages);
    const requestedMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
    const maxTokens = Math.min(
      Number(auth.plan.maxOutputTokens) || 4096,
      requestedMax > 0 ? Math.trunc(requestedMax) : Number(auth.plan.maxOutputTokens) || 4096
    );
    if (requestedMax > (Number(auth.plan.maxOutputTokens) || 4096)) {
      throw relayError(400, 'max_tokens_exceeded', `max_tokens 超过套餐上限 ${auth.plan.maxOutputTokens}`);
    }
    const promptEstimate = estimateMessagesTokens(body.messages);
    this.checkRate(auth.tenant, auth.plan, promptEstimate + maxTokens);
    const releaseInflight = this.trackInflight(auth.tenant, auth.plan);
    let reservation = null;
    if (!custom?.configured) {
      const estimatedMicros = estimateHoldMicros({
        model,
        messages: body.messages,
        maxTokens,
        promptTokens: Math.max(promptEstimate, Buffer.byteLength(raw))
      }) || 1;
      try {
        reservation = this.billing.reserve({
          tenantId: auth.tenant.id,
          keyId: auth.keyRow.id,
          model,
          estimatedMicros,
          maxTokens,
          ttlMs: Math.max(180_000, this.config.upstreamTimeoutMs)
        });
      } catch (error) {
        releaseInflight();
        throw error;
      }
    }
    const stream = body.stream === true;
    const payload = this.buildUpstreamBody(body, { model, maxTokens, stream });
    const cleanup = () => {
      releaseInflight();
    };
    if (stream) {
      await this.streamChat({ req, res, body, payload, auth, custom, reservation, requestId, cleanup, record, attribution });
    } else {
      await this.bufferedChat({ req, res, body, payload, auth, custom, reservation, requestId, cleanup, record, attribution });
    }
  }

  buildUpstreamBody(body, { model, maxTokens, stream }) {
    const out = { model };
    for (const field of FORWARD_FIELDS) {
      if (body[field] !== undefined) out[field] = body[field];
    }
    out.messages = body.messages;
    out.max_tokens = maxTokens;
    out.stream = stream;
    if (stream) out.stream_options = { include_usage: true };
    return out;
  }

  async upstreamRequest(payload, { timeoutMs, custom = null }) {
    const up = custom?.configured ? custom : this.upstream();
    if (!up.configured || !up.apiKey) throw relayError(503, 'upstream_not_configured', custom?.configured ? '自定义上游未配置 API Key' : '平台中转尚未配置上游');
    let url;
    let lookup;
    if (custom?.configured) {
      const resolved = await this.customUpstreams.resolve(up.baseUrl);
      url = new URL(this.customUpstreams.url(resolved.url.toString(), 'chat/completions'));
      lookup = resolved.lookup;
    } else {
      url = new URL(this.upstreamUrl('chat/completions'));
    }
    const data = Buffer.from(JSON.stringify(payload));
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      lookup,
      headers: {
        authorization: `Bearer ${up.apiKey}`,
        'content-type': 'application/json',
        accept: payload.stream ? 'text/event-stream' : 'application/json',
        'accept-encoding': 'identity',
        'content-length': data.length
      },
      timeout: timeoutMs
    });
    req.end(data);
    return req;
  }

  releaseReservation(reservation, reason) {
    if (reservation) this.billing.release(reservation.id, reason);
  }

  settleUsage({ custom, reservation, usage, upstreamStatus, requestId, attribution, usageSource }) {
    if (custom?.configured) return { costMicros: 0 };
    return this.billing.settle({ reservation, usage, upstreamStatus, requestId, attribution, usageSource });
  }

  async bufferedChat({ res, body, payload, auth, custom, reservation, requestId, cleanup, record, attribution }) {
    let upstream;
    try {
      upstream = await this.upstreamRequest(payload, { timeoutMs: this.config.upstreamTimeoutMs, custom });
    } catch (error) {
      this.releaseReservation(reservation, 'upstream-unavailable');
      cleanup();
      throw error;
    }
    const result = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      upstream.on('response', (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => done({ status: upstreamRes.statusCode, headers: upstreamRes.headers, text: Buffer.concat(chunks).toString('utf8') }));
        upstreamRes.on('error', (error) => done({ error }));
      });
      upstream.on('timeout', () => { upstream.destroy(); done({ error: Object.assign(new Error('上游超时'), { code: 'ETIMEDOUT' }) }); });
      upstream.on('error', (error) => done({ error }));
    });
    cleanup();
    if (result.error) {
      this.releaseReservation(reservation, 'upstream-error');
      throw relayError(502, 'upstream_error', `上游请求失败: ${result.error.message}`);
    }
    let json = null;
    try { json = JSON.parse(result.text); } catch { /* non-json */ }
    if (result.status < 200 || result.status >= 300) {
      this.releaseReservation(reservation, `upstream-${result.status}`);
      const message = custom?.configured ? `自定义上游 HTTP ${result.status}` : (json?.error?.message || truncate(result.text, 500) || `上游 HTTP ${result.status}`);
      if (result.status === 429) throw relayError(429, 'upstream_rate_limited', message);
      if (result.status === 401 || result.status === 403) throw relayError(502, 'upstream_auth_failed', '平台上游凭据不可用，请联系管理员');
      throw relayError(502, 'upstream_error', message);
    }
    if (!json) {
      this.releaseReservation(reservation, 'upstream-invalid-json');
      throw relayError(502, 'upstream_invalid_response', '上游返回了非 JSON 响应');
    }
    const reportedUsage = extractUsage(json);
    const usage = reportedUsage || fallbackUsage(body.messages, completionText(json));
    if (!reportedUsage) {
      json.usage = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        prompt_tokens_details: { cached_tokens: usage.cached_tokens }
      };
    }
    const settlement = this.settleUsage({ custom, reservation, usage, upstreamStatus: result.status, requestId, attribution, usageSource: reportedUsage ? 'reported' : 'estimated' });
    record({ status: 200, tokens: usage.total_tokens, costMicros: settlement.costMicros });
    res.setHeader('x-fish-request-id', requestId);
    res.setHeader('x-fish-cost-micros', String(settlement.costMicros || 0));
    sendJson(res, 200, json);
  }

  async streamChat({ req, res, body, payload, auth, custom, reservation, requestId, cleanup, record, attribution }) {
    let upstream;
    try {
      upstream = await this.upstreamRequest(payload, { timeoutMs: this.config.upstreamTimeoutMs, custom });
    } catch (error) {
      this.releaseReservation(reservation, 'upstream-unavailable');
      cleanup();
      throw error;
    }
    let headersSent = false;
    let buffer = '';
    let completion = '';
    let usage = null;
    let finalized = false;
    let clientClosed = false;
    const finalize = (upstreamStatus) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      const finalUsage = usage || fallbackUsage(body.messages, completion);
      const settlement = this.settleUsage({ custom, reservation, usage: finalUsage, upstreamStatus, requestId, attribution, usageSource: usage ? 'reported' : 'estimated' });
      record({ status: 200, tokens: finalUsage.total_tokens, costMicros: settlement.costMicros });
    };
    const release = (reason, status = 502) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      this.releaseReservation(reservation, reason);
      record({ status, error: reason });
    };
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        try { upstream.destroy(); } catch { /* ignore */ }
        if (usage || completion) finalize(200);
        else release('client-closed');
      }
    });
    upstream.on('response', (upstreamRes) => {
      if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          release(`upstream-${upstreamRes.statusCode}`, upstreamRes.statusCode === 401 ? 502 : upstreamRes.statusCode);
          if (!res.headersSent) {
            let json = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
            const message = custom?.configured ? `自定义上游 HTTP ${upstreamRes.statusCode}` : (json?.error?.message || truncate(Buffer.concat(chunks).toString('utf8'), 500) || `上游 HTTP ${upstreamRes.statusCode}`);
            sendOpenAIError(res, upstreamRes.statusCode === 401 ? 502 : upstreamRes.statusCode, 'upstream_error', message);
          } else {
            try { res.end(); } catch { /* ignore */ }
          }
        });
        return;
      }
      const contentType = String(upstreamRes.headers['content-type'] || '');
      if (!contentType.includes('text/event-stream')) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
          if (json) {
            usage = extractUsage(json);
            const u = usage || fallbackUsage(body.messages, completionText(json));
            if (!usage) completion = completionText(json);
            finalize(upstreamRes.statusCode);
            if (!usage) json.usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens };
            sendJson(res, upstreamRes.statusCode || 200, json);
          } else {
            release('upstream-invalid-stream');
            sendOpenAIError(res, 502, 'upstream_invalid_response', '上游未返回 SSE');
          }
        });
        return;
      }
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-fish-request-id': requestId
      });
      res.flushHeaders?.();
      res.socket?.setNoDelay?.(true);
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk) => {
        if (clientClosed) return;
        res.write(chunk);
        buffer += chunk;
        let index;
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          index = match.index;
          const event = buffer.slice(0, index);
          buffer = buffer.slice(index + match[0].length);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) usage = extractUsage(parsed);
              completion += completionText(parsed);
            } catch { /* ignore malformed keepalive */ }
          }
        }
      });
      upstreamRes.on('end', () => {
        finalize(upstreamRes.statusCode || 200);
        if (!res.writableEnded) res.end();
      });
      upstreamRes.on('error', () => {
        if (usage || completion) finalize(200);
        else release('upstream-stream-error');
        try { res.end(); } catch { /* ignore */ }
      });
    });
    upstream.on('timeout', () => {
      upstream.destroy();
      if (!headersSent) {
        release('upstream-timeout');
        if (!res.headersSent) sendOpenAIError(res, 504, 'upstream_timeout', '上游超时');
      } else if (usage || completion) {
        finalize(200);
        try { res.end(); } catch { /* ignore */ }
      } else {
        release('upstream-timeout');
        try { res.end(); } catch { /* ignore */ }
      }
    });
    upstream.on('error', (error) => {
      if (!headersSent) {
        release('upstream-error');
        if (!res.headersSent) sendOpenAIError(res, 502, 'upstream_error', `上游请求失败: ${error.message}`);
      } else if (usage || completion) {
        finalize(200);
        try { res.end(); } catch { /* ignore */ }
      } else {
        release('upstream-error');
        try { res.end(); } catch { /* ignore */ }
      }
    });
  }

  createServer() {
    return http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) sendOpenAIError(res, 500, 'server_error', '中转服务器内部错误');
      });
    });
  }
}
