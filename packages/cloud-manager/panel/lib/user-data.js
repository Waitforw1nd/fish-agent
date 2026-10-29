import { asArray, asBool, asNumber, asString, first, getPath, isObject, toObject } from './normalize.js';

function amountMicros(source, prefix = 'amount') {
  const explicit = first(source, [`${prefix}Micros`, `${prefix}_micros`]);
  if (explicit !== undefined) return asNumber(explicit, 0);
  const decimal = first(source, [prefix]);
  return decimal === undefined ? 0 : Math.round(asNumber(decimal, 0) * 1_000_000);
}

export function normalizeRelayCustom(payload) {
  const root = toObject(payload);
  const source = toObject(root.custom || getPath(root, 'relay.custom') || root.config || root);
  const baseUrl = asString(first(source, ['baseUrl', 'base_url', 'url']));
  const configured = asBool(first(source, ['configured', 'enabled', 'hasConfig']), Boolean(baseUrl));
  const test = toObject(source.test || source.lastTest || source.testResult);
  const testStatus = asString(first(source, ['testStatus', 'test_status', 'connectionStatus'])
    ?? first(test, ['status', 'state']), configured ? 'untested' : 'missing').toLowerCase();
  const success = ['ok', 'success', 'valid', 'active', 'healthy', 'passed', 'connected'].includes(testStatus);
  const failed = ['error', 'failed', 'invalid', 'unavailable', 'timeout'].includes(testStatus);
  return {
    configured,
    baseUrl,
    model: asString(first(source, ['model', 'modelId', 'model_id', 'defaultModel'])),
    keyConfigured: asBool(first(source, ['keyConfigured', 'hasKey', 'apiKeyConfigured']), configured),
    testStatus,
    testLabel: !configured ? '未配置' : success ? '连接可用' : failed ? '测试失败' : testStatus === 'testing' ? '测试中' : '未测试',
    testTone: !configured ? 'neutral' : success ? 'ok' : failed ? 'danger' : 'warn',
    testMessage: asString(first(source, ['testMessage', 'test_message', 'lastError', 'error'])
      ?? first(test, ['message', 'error', 'detail'])),
    testedAt: first(source, ['testedAt', 'lastTestAt', 'last_test_at']) ?? first(test, ['testedAt', 'createdAt']) ?? null
  };
}

function listFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  const root = toObject(payload);
  for (const key of keys) {
    const value = key.includes('.') ? getPath(root, key) : root[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function normalizeRelayLogs(payload) {
  return asArray(listFrom(payload, ['logs', 'items', 'records', 'data', 'data.logs', 'data.items'])).map((value) => {
    const source = toObject(value);
    const statusCode = asNumber(first(source, ['statusCode', 'status_code', 'httpStatus', 'http_status']) ?? (typeof source.status === 'number' ? source.status : undefined));
    const rawStatus = asString(first(source, ['status', 'state', 'result'], statusCode !== null && statusCode < 400 ? 'success' : 'error')).toLowerCase();
    const success = asBool(source.success, ['ok', 'success', 'succeeded', 'completed', 'done', '200'].includes(rawStatus)
      || (statusCode !== null && statusCode >= 200 && statusCode < 300));
    const promptTokens = asNumber(first(source, ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens']), 0);
    const completionTokens = asNumber(first(source, ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens']), 0);
    const totalTokens = asNumber(first(source, ['totalTokens', 'total_tokens', 'tokens']), promptTokens + completionTokens);
    return {
      id: asString(first(source, ['id', 'requestId', 'request_id', 'traceId'])),
      time: first(source, ['createdAt', 'created_at', 'timestamp', 'time', 'requestedAt']) ?? null,
      model: asString(first(source, ['model', 'modelId', 'model_id']), '未命名模型'),
      status: success ? 'success' : 'error',
      statusLabel: success ? '成功' : '失败',
      statusCode,
      totalTokens,
      costMicros: asNumber(first(source, ['costMicros', 'cost_micros', 'cost']), 0),
      currency: asString(first(source, ['currency', 'currencyCode']), 'CNY').toUpperCase(),
      latencyMs: asNumber(first(source, ['latencyMs', 'latency_ms', 'latency', 'durationMs', 'duration_ms', 'elapsedMs'])),
      chatId: asString(first(source, ['chatId', 'chat_id', 'chatKey', 'chat_key', 'sessionId', 'session_id'])),
      source: asString(first(source, ['source', 'channel', 'provider', 'keyType', 'key_type']), '—'),
      error: asString(first(source, ['errorMessage', 'error_message', 'error', 'message', 'detail']))
    };
  });
}

export function normalizeRecharges(payload) {
  const root = toObject(payload);
  const walletSource = toObject(root.wallet || root.billing || root.balance);
  const wallet = {
    available: isObject(root.wallet || root.billing),
    balanceMicros: amountMicros(walletSource, 'balance'),
    heldMicros: amountMicros(walletSource, 'held'),
    availableMicros: first(walletSource, ['availableMicros', 'available_micros', 'available']) !== undefined ? amountMicros(walletSource, 'available') : amountMicros(walletSource, 'balance') - amountMicros(walletSource, 'held'),
    currency: asString(first(walletSource, ['currency', 'currencyCode']) || first(root, ['currency']), 'CNY').toUpperCase()
  };
  const recharges = asArray(listFrom(payload, ['recharges', 'orders', 'items', 'records', 'data', 'data.recharges'])).map((value) => {
    const source = toObject(value);
    const status = asString(first(source, ['status', 'state', 'reviewStatus', 'review_status']), 'pending').toLowerCase();
    const approved = ['confirmed', 'approved', 'paid', 'completed', 'success', 'credited'].includes(status);
    const rejected = ['rejected', 'failed', 'cancelled', 'canceled'].includes(status);
    return {
      id: asString(first(source, ['id', 'orderId', 'order_id', 'rechargeId'])),
      amountMicros: amountMicros(source),
      currency: asString(first(source, ['currency', 'currencyCode']), wallet.currency).toUpperCase(),
      status,
      statusLabel: approved ? '已到账' : rejected ? '已驳回' : '待管理员审核',
      statusTone: approved ? 'ok' : rejected ? 'danger' : 'warn',
      pending: !approved && !rejected,
      createdAt: first(source, ['createdAt', 'created_at', 'submittedAt', 'timestamp']) ?? null,
      reviewedAt: first(source, ['reviewedAt', 'reviewed_at', 'confirmedAt', 'paidAt', 'completedAt']) ?? null,
      note: asString(first(source, ['reviewNote', 'review_note', 'note', 'message', 'reason']))
    };
  });
  recharges.sort((a, b) => Number(b.pending) - Number(a.pending));
  return { wallet, recharges };
}
