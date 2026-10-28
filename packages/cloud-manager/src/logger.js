import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets, truncate, ensureDir } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ level = 'info', file = null, maxBytes = 5 * 1024 * 1024, keep = 3 } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    if (file) ensureDir(path.dirname(file));
  }

  child(scope) {
    return new ScopedLogger(this, scope);
  }

  write(level, scope, args) {
    if ((LEVELS[level] ?? 99) < this.level) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${scope ? `[${scope}] ` : ''}${args.map((arg) => {
      if (arg instanceof Error) return redactSecrets(arg.stack || arg.message);
      if (typeof arg === 'string') return redactSecrets(arg);
      try { return redactSecrets(JSON.stringify(arg)); } catch { return '[unserializable]'; }
    }).join(' ')}`;
    const bounded = truncate(line, 16000);
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${bounded}\n`);
    if (this.file) this.append(bounded);
  }

  append(line) {
    try {
      ensureDir(path.dirname(this.file));
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { size = 0; }
      if (size > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the service down.
    }
  }

  rotate() {
    if (!this.file) return;
    try {
      for (let i = this.keep - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* ignore */ }
  }

  logFileForTenant(tenantId) {
    if (!this.file) return null;
    return path.join(path.dirname(this.file), 'tenants', `${tenantId}.log`);
  }
}

class ScopedLogger {
  constructor(logger, scope) {
    this.logger = logger;
    this.scope = scope;
  }

  debug(...args) { this.logger.write('debug', this.scope, args); }
  info(...args) { this.logger.write('info', this.scope, args); }
  warn(...args) { this.logger.write('warn', this.scope, args); }
  error(...args) { this.logger.write('error', this.scope, args); }
  child(scope) { return new ScopedLogger(this.logger, `${this.scope}:${scope}`); }
  logFileForTenant(tenantId) { return this.logger.logFileForTenant(tenantId); }
}

export function createLogger(options) {
  return new Logger(options);
}
