import { isObject, getPath, first, asArray, asString, asNumber, asBool, toObject, unwrapKey } from './core.js';
import { expiryInfo, maskSecret, parseDate, safeImageSrc } from '../format.js';

function normalizeAmountMicros(source, prefix = '') {
  const explicit = first(source, [
    `${prefix}Micros`, `${prefix}_micros`, `${prefix}AmountMicros`, `${prefix}_amount_micros`
  ]);
  if (explicit !== undefined && explicit !== null && explicit !== '') return Math.round(asNumber(explicit, 0));
  const decimal = first(source, [prefix, `${prefix}Amount`, `${prefix}_amount`, `${prefix}Cost`, `${prefix}_cost`]);
  if (decimal !== undefined && decimal !== null && decimal !== '') {
    return Math.round(asNumber(decimal, 0) * 1_000_000);
  }
  return null;
}

export function normalizeTotals(value) {
  const source = toObject(value);
  const requests = asNumber(first(source, ['requests', 'requestCount', 'calls', 'count']), 0);
  const promptTokens = asNumber(first(source, ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens', 'input']), 0);
  const completionTokens = asNumber(first(source, ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens', 'output']), 0);
  const cachedTokens = asNumber(first(source, ['cachedTokens', 'cached_tokens', 'cacheReadTokens', 'cache_read_tokens', 'cacheTokens', 'cache_tokens']), 0);
  const visionTokens = asNumber(first(source, ['visionTokens', 'vision_tokens', 'imageTokens', 'image_tokens']), 0);
  const explicitTotal = first(source, ['totalTokens', 'total_tokens', 'tokens']);
  const totalTokens = explicitTotal !== undefined && explicitTotal !== null
    ? asNumber(explicitTotal, 0)
    : promptTokens + completionTokens + visionTokens;
  const currency = asString(first(source, ['currency', 'currencyCode'], 'CNY')).toUpperCase();
  const costMicros = normalizeAmountMicros(source, 'cost') ?? normalizeAmountMicros(source, 'amount') ?? 0;
  const fields = ['requests', 'promptTokens', 'completionTokens', 'cachedTokens', 'visionTokens', 'totalTokens', 'costMicros'];
  const available = fields.some((field) => source[field] !== undefined || source[field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] !== undefined)
    || Boolean(first(source, ['cost', 'amount', 'total_tokens', 'tokens']));
  return {
    requests: Math.max(0, Math.round(requests)),
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    cachedTokens: Math.max(0, Math.round(cachedTokens)),
    visionTokens: Math.max(0, Math.round(visionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    costMicros,
    currency,
    available
  };
}

function emptyTotals(currency = 'CNY') {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    visionTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    currency,
    available: false
  };
}

function addTotals(target, source) {
  target.requests += source.requests || 0;
  target.promptTokens += source.promptTokens || 0;
  target.completionTokens += source.completionTokens || 0;
  target.cachedTokens += source.cachedTokens || 0;
  target.visionTokens += source.visionTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.costMicros += source.costMicros || 0;
  if (source.available) target.available = true;
  return target;
}

function toDayKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const date = parseDate(value);
  if (!date) return asString(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeModelUsage(value, fallbackModel = '') {
  const source = toObject(value);
  const totals = normalizeTotals(source);
  return {
    model: asString(first(source, ['model', 'modelId', 'model_id', 'name', 'id'], fallbackModel), fallbackModel || '未命名模型'),
    ...totals
  };
}

function normalizeModelList(modelsValue) {
  if (Array.isArray(modelsValue)) {
    return modelsValue.map((item) => normalizeModelUsage(item));
  }
  if (isObject(modelsValue)) {
    return Object.entries(modelsValue).map(([name, item]) => normalizeModelUsage(item, name));
  }
  return [];
}

export function normalizeBilling(value, { now = new Date() } = {}) {
  const source = toObject(value);
  const usage = toObject(source.usage || source.billing || source);
  const dailyCandidates = [
    usage.daily,
    usage.days,
    source.daily,
    source.days,
    source.dailyUsage,
    source.daily_usage,
    source.usageByDay,
    source.usage_by_day,
    getPath(source, 'billing.daily'),
    getPath(source, 'billing.days'),
    getPath(source, 'usage.daily')
  ];
  const dailyRaw = dailyCandidates.find((item) => Array.isArray(item)) || [];
  const currency = asString(first(usage, ['currency', 'currencyCode']) || first(source, ['currency']), 'CNY').toUpperCase();

  const days = asArray(dailyRaw).map((dayValue) => {
    const day = toObject(dayValue);
    const date = toDayKey(first(day, ['date', 'day', 'dayKey', 'day_key', 'dateKey', 'date_key']));
    const modelSource = day.models ?? day.byModel ?? day.by_model ?? day.usageByModel;
    let models = normalizeModelList(modelSource).filter((model) => model.available || model.model);
    for (const model of models) {
      if (!model.currency || model.currency === 'CNY') model.currency = currency;
    }
    const totalsSource = day.totals ?? day.total ?? day.summary;
    let totals = totalsSource ? normalizeTotals(totalsSource) : emptyTotals(currency);
    if (!totalsSource) {
      for (const model of models) addTotals(totals, model);
    }
    if (totals.available && models.length === 0 && (totals.costMicros || totals.totalTokens || totals.requests)) {
      models = [{ model: '未分类', ...totals }];
    }
    return { date, models, totals, currency };
  });

  const hasDaily = days.length > 0;
  days.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

  const explicitTotal = first(usage, ['total', 'totals', 'allTime', 'all_time']) ?? first(source, ['total', 'totals']);
  let total = explicitTotal ? normalizeTotals(explicitTotal) : emptyTotals(currency);
  if (!explicitTotal && hasDaily) {
    for (const day of days) addTotals(total, day.totals);
  }
  if (!total.currency || total.currency === 'CNY') total.currency = currency;

  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const explicitToday = first(usage, ['today', 'todayUsage', 'today_usage']) ?? first(source, ['today']);
  let today = explicitToday ? normalizeTotals(explicitToday) : emptyTotals(currency);
  if (!explicitToday) {
    const match = days.find((day) => day.date === todayKey);
    if (match) today = { ...match.totals };
  }
  if (!today.available && (today.costMicros || today.totalTokens || today.requests)) today.available = true;

  const windowDays = asNumber(first(usage, ['days', 'windowDays', 'window_days']) ?? first(source, ['days', 'windowDays']));
  const byModelSource = first(usage, ['byModel', 'by_model', 'models']) ?? first(source, ['byModel', 'by_model']);
  const byModel = isObject(byModelSource) || Array.isArray(byModelSource)
    ? normalizeModelList(byModelSource).sort((a, b) => b.costMicros - a.costMicros)
    : [];

  return {
    days,
    hasDaily,
    windowDays,
    today,
    total,
    byModel,
    byChat: asArray(usage.byChat).map(row => ({ date: asString(row.date), model: asString(row.model), platform: asString(row.platform), chatKey: asString(row.chatKey), requests: asNumber(row.requests) || 0, cachedTokens: asNumber(row.cachedTokens) || 0, costMicros: asNumber(row.costMicros) || 0, visionRequests: asNumber(row.visionRequests) || 0, visionRequestCostMicros: asNumber(row.visionRequestCostMicros) || 0, usageSources: toObject(row.usageSources) })),
    usageSources: toObject(usage.usageSources),
    visionRequests: asNumber(usage.visionRequests) || 0,
    visionRequestCostMicros: asNumber(usage.visionRequestCostMicros) || 0,
    currency,
    updatedAt: first(usage, ['updatedAt', 'updated_at']) ?? first(source, ['updatedAt']) ?? null
  };
}

export function normalizeQuota(value) {
  const source = toObject(value);
  const costLimit = asNumber(first(source, [
    'costLimitMicros', 'cost_limit_micros', 'limitMicros', 'limit_micros', 'monthlyCostMicros', 'monthly_cost_micros'
  ]));
  const costUsed = asNumber(first(source, [
    'costUsedMicros', 'cost_used_micros', 'usedMicros', 'used_micros', 'spentMicros', 'spent_micros'
  ]));
  const tokenLimit = asNumber(first(source, [
    'tokenLimit', 'token_limit', 'tokensLimit', 'tokens_limit', 'monthlyTokens', 'monthly_tokens', 'limitTokens', 'limit_tokens'
  ]));
  const tokenUsed = asNumber(first(source, [
    'tokenUsed', 'token_used', 'tokensUsed', 'tokens_used', 'usedTokens', 'used_tokens'
  ]));
  const requestsLimit = asNumber(first(source, ['requestsLimit', 'requests_limit', 'requestLimit', 'request_limit']));
  const requestsUsed = asNumber(first(source, ['requestsUsed', 'requests_used', 'requestUsed', 'request_used']));
  const unit = asString(first(source, ['unit', 'quotaUnit', 'quota_unit'])).toLowerCase();
  let finalCostLimit = costLimit;
  let finalCostUsed = costUsed;
  let finalTokenLimit = tokenLimit;
  let finalTokenUsed = tokenUsed;
  const genericLimit = asNumber(first(source, ['limit', 'quota']));
  const genericUsed = asNumber(first(source, ['used', 'consumed']));
  if (genericLimit !== null) {
    if (unit.includes('token')) {
      finalTokenLimit = finalTokenLimit ?? genericLimit;
      finalTokenUsed = finalTokenUsed ?? genericUsed ?? 0;
    } else if (unit.includes('micro') || unit.includes('cost') || unit.includes('currency') || unit.includes('money')) {
      finalCostLimit = finalCostLimit ?? genericLimit;
      finalCostUsed = finalCostUsed ?? genericUsed ?? 0;
    }
  }
  if (finalCostLimit !== null && finalCostUsed === null) finalCostUsed = 0;
  if (finalTokenLimit !== null && finalTokenUsed === null) finalTokenUsed = 0;
  return {
    costLimitMicros: finalCostLimit,
    costUsedMicros: finalCostUsed,
    tokenLimit: finalTokenLimit,
    tokenUsed: finalTokenUsed,
    requestsLimit,
    requestsUsed,
    periodStart: first(source, ['periodStart', 'period_start', 'cycleStart', 'cycle_start']) ?? null,
    periodEnd: first(source, ['periodEnd', 'period_end', 'cycleEnd', 'cycle_end', 'resetAt', 'reset_at']) ?? null,
    planName: asString(first(source, ['planName', 'plan_name', 'name']), ''),
    rpm: asNumber(first(source, ['rpm', 'requestsPerMinute', 'requests_per_minute'])),
    tpm: asNumber(first(source, ['tpm', 'tokensPerMinute', 'tokens_per_minute']))
  };
}

export function normalizeRelayOverview(payload) {
  const root = toObject(payload);
  const source = toObject(root.relay || root.overview || root);
  const keyValue = first(source, [
    'keyMasked', 'key_mask', 'maskedKey', 'masked_key', 'keyPreview', 'key_preview',
    'apiKeyMasked', 'api_key_masked', 'apiKey', 'api_key', 'key'
  ]);
  const keyObject = isObject(keyValue) ? keyValue : null;
  const keyRaw = typeof keyValue === 'string'
    ? keyValue
    : (keyObject && keyObject.prefix ? `${keyObject.prefix}••••` : '');
  const configuredRaw = first(source, ['configured', 'hasKey', 'keyConfigured', 'key_configured']);
  const configured = asBool(configuredRaw, Boolean(keyRaw));
  const keyStatusRaw = first(source, ['keyStatus', 'key_status', 'credentialStatus']);
  const keyStatus = isObject(keyStatusRaw)
    ? {
        status: asString(first(keyStatusRaw, ['status', 'state'], configured ? 'active' : 'missing')).toLowerCase(),
        message: asString(first(keyStatusRaw, ['message', 'detail'], ''))
      }
    : { status: asString(keyStatusRaw, configured ? 'active' : 'missing').toLowerCase(), message: '' };
  const lastErrorSource = source.lastError ?? source.error;
  const lastError = isObject(lastErrorSource)
    ? asString(first(lastErrorSource, ['message', 'detail'], ''))
    : asString(lastErrorSource);
  const baseValue = first(source, ['baseUrl', 'base_url', 'providerUrl']);
  const baseUrl = typeof baseValue === 'string' ? baseValue : '';
  let baseHost = '';
  if (baseUrl) {
    try {
      baseHost = new URL(baseUrl).host;
    } catch {
      baseHost = '';
    }
  }
  const planSource = toObject(source.plan);
  const plan = {
    id: asString(planSource.id),
    name: asString(planSource.name),
    monthlyCreditMicros: asNumber(planSource.monthlyCreditMicros ?? planSource.monthly_credit_micros),
    maxOutputTokens: asNumber(planSource.maxOutputTokens ?? planSource.max_output_tokens),
    maxConcurrent: asNumber(planSource.maxConcurrent ?? planSource.max_concurrent),
    rpm: asNumber(planSource.rpm),
    tpm: asNumber(planSource.tpm)
  };
  const walletSource = isObject(source.billing) && (
    Object.hasOwn(source.billing, 'balanceMicros') || Object.hasOwn(source.billing, 'availableMicros')
  ) ? source.billing : toObject(source.wallet);
  const walletAvailable = ['balanceMicros', 'heldMicros', 'availableMicros']
    .some((key) => walletSource[key] !== undefined && walletSource[key] !== null);
  const wallet = {
    available: walletAvailable,
    balanceMicros: asNumber(walletSource.balanceMicros ?? walletSource.balance_micros),
    heldMicros: asNumber(walletSource.heldMicros ?? walletSource.held_micros),
    availableMicros: asNumber(walletSource.availableMicros ?? walletSource.available_micros),
    currency: asString(walletSource.currency, 'CNY').toUpperCase()
  };
  const quota = normalizeQuota({
    ...planSource,
    ...toObject(source.quota ?? source.limits),
    planName: asString(planSource.name || source.quota?.planName || source.planName)
  });
  const billing = normalizeBilling(source);
  const localEstimateSource = source.localEstimate ?? source.localUsage ?? source.local_usage ?? source.estimates;
  const localEstimate = localEstimateSource ? normalizeTotals(localEstimateSource) : null;
  const model = asString(first(source, ['model', 'defaultModel', 'default_model', 'modelId']));
  return {
    configured,
    keyMasked: keyRaw ? maskSecret(keyRaw) : '',
    keyStatus,
    keyStatusLabel: KEY_STATUS_LABELS[keyStatus.status] || (configured ? '已绑定' : '未绑定'),
    keyStatusTone: configured ? (['invalid', 'expired', 'quota_exceeded', 'missing'].includes(keyStatus.status) ? 'danger' : 'ok') : 'warn',
    model,
    plan,
    baseHost,
    wallet,
    quota,
    billing,
    localEstimate,
    lastError,
    updatedAt: first(source, ['updatedAt', 'updated_at']) ?? null
  };
}

const KEY_STATUS_LABELS = {
  active: 'Key 有效',
  ok: 'Key 有效',
  valid: 'Key 有效',
  missing: '未绑定 Key',
  invalid: 'Key 无效',
  expired: 'Key 已过期',
  quota_exceeded: '额度已用尽',
  error: 'Key 异常'
};

export function normalizeModels(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (isObject(payload)) {
    if (Array.isArray(payload.models)) list = payload.models;
    else if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.data?.models)) list = payload.data.models;
    else if (Array.isArray(payload.items)) list = payload.items;
  }
  const seen = new Set();
  return asArray(list).map((item) => {
    if (typeof item === 'string') {
      return { id: item, name: item, description: '', contextWindow: null, ownedBy: '', priceLabel: '' };
    }
    const model = toObject(item);
    const id = asString(first(model, ['id', 'model', 'modelId', 'model_id', 'name']));
    if (!id) return null;
    const contextWindow = asNumber(first(model, ['contextWindow', 'context_window', 'contextLength', 'context_length', 'maxTokens', 'max_tokens']));
    const pricing = toObject(model.pricing || model.price);
    const inputPrice = first(pricing, ['input', 'prompt']) ?? first(model, ['inputPrice', 'input_price', 'promptPrice']);
    const outputPrice = first(pricing, ['output', 'completion']) ?? first(model, ['outputPrice', 'output_price', 'completionPrice']);
    let priceLabel = '';
    if (inputPrice !== undefined || outputPrice !== undefined) {
      const input = asNumber(inputPrice);
      const output = asNumber(outputPrice);
      const fmt = (value) => (value === null ? '—' : String(value));
      priceLabel = `入 ${fmt(input)} / 出 ${fmt(output)}`;
    }
    return {
      id,
      name: asString(first(model, ['displayName', 'display_name', 'title', 'name'], id), id),
      description: asString(first(model, ['description', 'desc'], '')),
      contextWindow,
      ownedBy: asString(first(model, ['ownedBy', 'owned_by'], '')),
      priceLabel
    };
  }).filter((model) => {
    if (!model || !model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}
