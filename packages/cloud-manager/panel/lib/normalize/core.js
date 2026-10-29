export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getPath(source, path) {
  if (!source || !path) return undefined;
  let cursor = source;
  for (const key of String(path).split('.')) {
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

export function first(source, keys, fallback = undefined) {
  if (!isObject(source)) return fallback;
  for (const key of keys) {
    const value = key.includes('.') ? getPath(source, key) : source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value.replace(/,/g, ''));
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

export function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'active', 'running', 'online', 'ok', 'healthy'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'disabled', 'inactive', 'stopped', 'offline', 'error'].includes(text)) return false;
  }
  return fallback;
}

export function toObject(value) {
  return isObject(value) ? value : {};
}

export function unwrapKey(source, key) {
  if (!isObject(source)) return source;
  const nested = source[key];
  return isObject(nested) ? nested : source;
}
