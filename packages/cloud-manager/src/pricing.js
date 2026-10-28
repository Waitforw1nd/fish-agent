import { MODEL_CATALOG, estimateMessagesTokens } from './plans.js';

export function priceFor(model) {
  return MODEL_CATALOG[String(model || '')] || null;
}

export function calculateCostMicros(model, usage = {}) {
  const price = priceFor(model);
  if (!price) return null;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage.cached_tokens) || 0));
  const uncached = prompt - cached;
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
  const numerator = uncached * price.inputPerMillion
    + cached * cachedRate
    + completion * price.outputPerMillion;
  return Math.max(0, Math.ceil(numerator / 1_000_000));
}

export function estimateHoldMicros({ model, messages, maxTokens, promptTokens = 0, margin = 1.15 }) {
  const price = priceFor(model);
  if (!price) return null;
  const prompt = Math.max(1, Math.ceil(Number(promptTokens) || 0), estimateMessagesTokens(messages));
  const outputTokens = Math.max(1, Number(maxTokens) || 1024);
  const numerator = prompt * price.inputPerMillion + outputTokens * price.outputPerMillion;
  return Math.max(1, Math.ceil((numerator / 1_000_000) * margin));
}

export function resetPriceCatalog() {
  // Pricing is intentionally static in-process; this hook exists so callers can
  // drop cached derived data if the catalog ever becomes configurable.
}
