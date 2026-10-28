import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { id, now, ensureDir, redactSecrets, sleep, truncate } from './util.js';

function minimalEnv(extra = {}) {
  const keep = [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'ComSpec', 'PATHEXT',
    'LANG', 'LC_ALL', 'TZ', 'NODE_ENV'
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

export function waitForPort({ host = '127.0.0.1', port, timeoutMs = 10_000, shouldAbort = null }) {
  const started = now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (shouldAbort?.()) return reject(Object.assign(new Error('进程在就绪前退出'), { code: 'PROCESS_EXITED' }));
      const socket = net.connect({ host, port });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) resolve(true);
        else if (now() - started > timeoutMs) reject(Object.assign(new Error('等待端口就绪超时'), { code: 'READY_TIMEOUT' }));
        else setTimeout(attempt, 120);
      };
      socket.setTimeout(800);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.unref?.();
    };
    attempt();
  });
}

class LogSink {
  constructor({ file, maxBytes = 5 * 1024 * 1024, keep = 3, ringSize = 300 }) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.ring = [];
    this.ringSize = ringSize;
    if (file) ensureDir(path.dirname(file), 0o700);
  }

  write(stream, text) {
    const line = `${new Date().toISOString()} ${stream} ${redactSecrets(text)}`;
    const bounded = truncate(line, 16_000);
    this.ring.push(bounded);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (!this.file) return;
    try {
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { size = 0; }
      if (size > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, `${bounded}\n`, { mode: 0o600 });
    } catch { /* logging must never crash the manager */ }
  }

  rotate() {
    try {
      for (let i = this.keep - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch { /* ignore */ }
  }

  tail(limit = 100) {
    return this.ring.slice(-Math.max(1, Math.min(300, limit)));
  }
}

export class Supervisor {
  constructor({ db, config, logger }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.services = new Map();
    this.closing = false;
  }

  key(tenantId, kind) { return `${tenantId}:${kind}`; }

  get(tenantId, kind) { return this.services.get(this.key(tenantId, kind)) || null; }

  status(tenantId, kind) {
    const service = this.get(tenantId, kind);
    if (!service) return { state: 'stopped', pid: null };
    return {
      state: service.state,
      pid: service.child?.pid || null,
      startedAt: service.startedAt,
      readyAt: service.readyAt,
      restarts: service.restarts,
      lastError: service.lastError,
      kind: service.kind,
      tenantId: service.tenantId
    };
  }

  list(tenantId = null) {
    const out = [];
    for (const service of this.services.values()) {
      if (tenantId && service.tenantId !== tenantId) continue;
      out.push(this.status(service.tenantId, service.kind));
    }
    return out;
  }

  async start(spec) {
    const {
      tenantId, kind, command, args = [], cwd, env = {}, logFile = null,
      ready = null, restart = true, maxRestarts = this.config.maxCrashRestarts,
      stopTimeoutMs = this.config.processStopTimeoutMs, metadata = {}
    } = spec;
    const key = this.key(tenantId, kind);
    const existing = this.services.get(key);
    if (existing && ['starting', 'running', 'restarting'].includes(existing.state)) {
      return this.status(tenantId, kind);
    }
    if (!command) throw new Error(`service ${key} has no command`);
    const service = {
      tenantId,
      kind,
      command,
      args,
      cwd,
      env,
      logFile,
      ready,
      restart,
      maxRestarts,
      stopTimeoutMs,
      metadata,
      state: 'starting',
      child: null,
      startedAt: now(),
      readyAt: null,
      restarts: 0,
      lastError: null,
      intentionalStop: false,
      exitWaiters: [],
      restartTimer: null,
      runId: null,
      logs: new LogSink({ file: logFile, maxBytes: this.config.logMaxBytes })
    };
    this.services.set(key, service);
    await this._launch(service, false);
    return this.status(tenantId, kind);
  }

  async _launch(service, isRestart) {
    if (this.closing) throw Object.assign(new Error('manager shutting down'), { code: 'SHUTTING_DOWN' });
    service.state = isRestart ? 'restarting' : 'starting';
    service.startedAt = now();
    service.readyAt = null;
    service.intentionalStop = false;
    ensureDir(service.cwd, 0o700);
    const runId = id('run');
    service.runId = runId;
    this._recordRun(runId, service, 'starting', null);
    let child;
    try {
      child = spawn(service.command, service.args, {
        cwd: service.cwd,
        env: minimalEnv({ ...service.env, NODE_ENV: service.env.NODE_ENV || 'production' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      service.state = 'failed';
      service.lastError = String(error?.message || error);
      this._recordRun(runId, service, 'failed', service.lastError);
      throw Object.assign(new Error(`无法启动 ${service.kind}: ${service.lastError}`), { status: 503, code: 'SPAWN_FAILED' });
    }
    service.child = child;
    service.state = isRestart ? 'restarting' : 'starting';
    this._recordRun(runId, service, service.state, null);

    const attach = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line) service.logs.write(stream === child.stdout ? 'out' : 'err', line);
        }
        if (buffer.length > 64 * 1024) {
          service.logs.write('out', buffer);
          buffer = '';
        }
      });
      stream.on('end', () => {
        if (buffer) service.logs.write('out', buffer);
        buffer = '';
      });
    };
    attach(child.stdout);
    attach(child.stderr);

    child.once('error', (error) => {
      service.lastError = String(error?.message || error);
      service.logs.write('err', service.lastError);
    });

    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    exitPromise.then(({ code, signal }) => this._onExit(service, runId, code, signal));

    if (service.ready) {
      try {
        await waitForPort({
          host: service.ready.host || '127.0.0.1',
          port: Number(service.ready.port),
          timeoutMs: service.ready.timeoutMs || this.config.processStartTimeoutMs,
          shouldAbort: () => child.exitCode !== null || service.child !== child
        });
        service.readyAt = now();
        service.state = 'running';
        this._recordRun(runId, service, 'running', null);
      } catch (error) {
        service.lastError = String(error?.message || error);
        service.logs.write('err', `readiness failed: ${service.lastError}`);
        service.intentionalStop = true;
        await this._terminate(service, true);
        service.state = 'failed';
        this._recordRun(runId, service, 'failed', service.lastError);
        throw Object.assign(new Error(`${service.kind} 启动失败: ${service.lastError}`), { status: 503, code: 'READY_FAILED' });
      }
    } else {
      service.readyAt = now();
      service.state = 'running';
      this._recordRun(runId, service, 'running', null);
    }
  }

  async _onExit(service, runId, code, signal) {
    if (service.runId !== runId) return;
    const uptime = now() - service.startedAt;
    const intentional = service.intentionalStop;
    service.child = null;
    for (const resolve of service.exitWaiters.splice(0)) resolve({ code, signal });
    if (intentional) {
      service.state = 'stopped';
      this._recordRun(runId, service, 'stopped', null, code);
      return;
    }
    service.lastError = `进程退出 code=${code} signal=${signal || ''}`.trim();
    service.logs.write('err', service.lastError);
    this._recordRun(runId, service, 'exited', service.lastError, code);
    if (!service.restart || this.closing) {
      service.state = 'crashed';
      return;
    }
    if (uptime > 60_000) service.restarts = 0;
    if (service.restarts >= service.maxRestarts) {
      service.state = 'crashed';
      this.logger.error(this.key(service.tenantId, service.kind), `崩溃重启次数已达上限: ${service.lastError}`);
      return;
    }
    service.restarts += 1;
    const delay = Math.min(this.config.crashBackoffMaxMs, this.config.crashBackoffBaseMs * (2 ** (service.restarts - 1)));
    service.state = 'restarting';
    service.restartTimer = setTimeout(() => {
      service.restartTimer = null;
      if (this.closing || service.state !== 'restarting') return;
      this._launch(service, true).catch((error) => {
        service.lastError = String(error?.message || error);
        this._onExit(service, service.runId, null, null);
      });
    }, delay);
    service.restartTimer.unref?.();
  }

  _recordRun(runId, service, state, error, exitCode = null) {
    try {
      const existing = this.db.prepare('SELECT id FROM process_runs WHERE id = ?').get(runId);
      const ts = now();
      if (!existing) {
        this.db.prepare(`
          INSERT INTO process_runs (id, tenant_id, kind, pid, status, started_at, stopped_at, exit_code, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, service.tenantId, service.kind, service.child?.pid || null, state, ts, null, null, error ? truncate(error, 500) : null);
      } else {
        const terminal = ['stopped', 'crashed', 'failed', 'exited'].includes(state);
        this.db.prepare(`
          UPDATE process_runs SET status = ?, pid = ?, stopped_at = ?, exit_code = ?, last_error = ? WHERE id = ?
        `).run(state, service.child?.pid || null, terminal ? ts : null, exitCode, error ? truncate(error, 500) : null, runId);
      }
    } catch { /* process bookkeeping must not break lifecycle */ }
  }

  async stop(tenantId, kind, { force = false } = {}) {
    const service = this.get(tenantId, kind);
    if (!service) return { state: 'stopped' };
    service.intentionalStop = true;
    service.restart = false;
    if (service.restartTimer) {
      clearTimeout(service.restartTimer);
      service.restartTimer = null;
    }
    await this._terminate(service, force);
    service.state = 'stopped';
    this.services.delete(this.key(tenantId, kind));
    return { state: 'stopped' };
  }

  async _terminate(service, force = false) {
    const child = service.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => service.exitWaiters.push(resolve));
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const timeout = force ? 500 : service.stopTimeoutMs;
    const result = await Promise.race([exited, sleep(timeout).then(() => null)]);
    if (result === null && child.exitCode === null) {
      service.logs.write('err', 'SIGTERM 超时，强制终止');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.unref();
        } catch { /* ignore */ }
      }
      await Promise.race([exited, sleep(3000)]);
    }
  }

  async stopTenant(tenantId) {
    const kinds = [...this.services.values()].filter((s) => s.tenantId === tenantId).map((s) => s.kind);
    await Promise.allSettled(kinds.map((kind) => this.stop(tenantId, kind, { force: true })));
  }

  async shutdown() {
    this.closing = true;
    const entries = [...this.services.values()];
    await Promise.allSettled(entries.map((service) => this.stop(service.tenantId, service.kind, { force: true })));
  }

  logs(tenantId, kind, limit = 100) {
    const service = this.get(tenantId, kind);
    if (!service) return [];
    return service.logs.tail(limit);
  }
}
