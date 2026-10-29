export const MODEL_CATALOG = {
  'deepseek-chat': {
    label: 'DeepSeek Chat',
    inputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 8_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  },
  'deepseek-reasoner': {
    label: 'DeepSeek Reasoner',
    inputPerMillion: 4_000_000,
    cachedInputPerMillion: 1_000_000,
    outputPerMillion: 16_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  },
  'gpt-4o-mini': {
    label: 'GPT-4o mini',
    inputPerMillion: 1_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 4_000_000,
    contextWindow: 128_000,
    maxOutputTokens: 8_192
  },
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    inputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 8_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  },
  'deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    inputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 8_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  },
  'deepseek-v4-flash-vision': {
    label: 'DeepSeek V4 Flash Vision',
    inputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 8_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  },
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    inputPerMillion: 2_000_000,
    cachedInputPerMillion: 500_000,
    outputPerMillion: 8_000_000,
    contextWindow: 64_000,
    maxOutputTokens: 8_192
  }
};

const ALL_MODELS = Object.keys(MODEL_CATALOG);

export const PLANS = {
  trial: {
    id: 'trial',
    name: '试用套餐',
    days: 14,
    creditMicros: 10_000_000,
    monthlyCreditMicros: 0,
    rpm: 10,
    tpm: 50_000,
    maxOutputTokens: 2_048,
    maxConcurrent: 2,
    maxTenants: 1,
    models: ALL_MODELS
  },
  starter: {
    id: 'starter',
    name: '入门套餐',
    days: 30,
    creditMicros: 30_000_000,
    monthlyCreditMicros: 30_000_000,
    rpm: 60,
    tpm: 300_000,
    maxOutputTokens: 4_096,
    maxConcurrent: 4,
    maxTenants: 3,
    models: ALL_MODELS
  },
  pro: {
    id: 'pro',
    name: '专业套餐',
    days: 30,
    creditMicros: 150_000_000,
    monthlyCreditMicros: 150_000_000,
    rpm: 240,
    tpm: 2_000_000,
    maxOutputTokens: 8_192,
    maxConcurrent: 12,
    maxTenants: 10,
    models: ALL_MODELS
  }
};

export const DEFAULT_PLAN = 'trial';

export function getPlan(planId) {
  return PLANS[planId] || null;
}

export function listPlans() {
  return Object.values(PLANS).map((plan) => ({ ...plan, models: [...plan.models] }));
}

export function planAllowsModel(plan, model) {
  if (!plan) return false;
  return plan.models.includes('*') || plan.models.includes(String(model || ''));
}

export function modelPrice(model) {
  return MODEL_CATALOG[model] || null;
}

export function listModels() {
  return Object.entries(MODEL_CATALOG).map(([id, meta]) => ({ id, ...meta }));
}

export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  // Conservative upper bound for mixed CJK/Latin text: roughly one token per two
  // UTF-16 code units. Actual tokenizers can differ; reservations keep a margin.
  return Math.ceil(value.length / 2);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content === 'string') total += estimateTokens(message.content);
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') total += estimateTokens(part.text);
        else if (part?.type === 'image_url') total += 1_000;
        else if (part?.type === 'video_url') total += 8_000;
      }
    }
    if (Array.isArray(message?.tool_calls)) total += estimateTokens(JSON.stringify(message.tool_calls));
    total += 8;
  }
  return total;
}
