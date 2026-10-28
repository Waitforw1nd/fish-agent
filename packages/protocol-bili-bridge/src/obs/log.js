import { redactSecrets, redactText, safeJsonStringify } from '../util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function normalizeLevel(level) {
  const value = String(level ?? 'info').toLowerCase();
  return LEVELS[value] != null ? value : 'info';
}

function describeExtra(extra) {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${redactText(extra.message)}`;
  const redacted = redactSecrets(extra);
  const text = typeof redacted === 'string' ? redacted : safeJsonStringify(redacted, '');
  return text ? ` ${redactText(text)}` : '';
}

export function createLogger({ level = 'info', sink = console, scope = '' } = {}) {
  let current = normalizeLevel(level);
  const emit = (lvl, message, extra) => {
    if (LEVELS[lvl] < LEVELS[current]) return;
    const line = `[bili-bridge${scope ? `:${scope}` : ''}] ${lvl.toUpperCase()} ${redactText(String(message ?? ''))}${describeExtra(extra)}`;
    if (lvl === 'error') sink.error?.(line);
    else if (lvl === 'warn') (sink.warn ?? sink.error ?? sink.log)?.(line);
    else sink.log?.(line);
  };
  const logger = {
    level: () => current,
    setLevel: (next) => { current = normalizeLevel(next); },
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
    child: (childScope) => createLogger({ level: current, sink, scope: scope ? `${scope}:${childScope}` : childScope })
  };
  return logger;
}

export function silentLogger() {
  const noop = () => {};
  return {
    level: () => 'silent',
    setLevel: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger()
  };
}
