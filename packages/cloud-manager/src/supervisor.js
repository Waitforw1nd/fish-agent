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

function waitForAgentListening({ child, port, timeoutMs, shouldAbort }) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const done = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onExit);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => Object.assign(new Error('进程在就绪前退出'), { code: 'PROCESS_EXITED' });
    const onExit = () => done(exited());
    const onMessage = (message) => {
      if (shouldAbort()) return done(exited());
      if (message?.type !== 'fish-agent-listening' || message.pid !== child.pid || message.port !== port) return;
      done();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onExit);
    timer = setTimeout(() => done(Object.assign(new Error('等待端口就绪超时'), { code: 'READY_TIMEOUT' })), timeoutMs);
    if (shouldAbort()) done(exited());
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

  unconfirmedRuns(tenantId = null, kind = null) {
    return this.db.prepare(`SELECT * FROM process_runs
      WHERE (status NOT IN ('stopped', 'exited', 'failed', 'crashed') OR stopped_at IS NULL)
        AND (? IS NULL OR tenant_id = ?) AND (? IS NULL OR kind = ?)`)
      .all(tenantId, tenantId, kind, kind);
  }

  assertStopped(tenantId, kind) {
    if (this.unconfirmedRuns(tenantId, kind).length) {
      throw Object.assign(new Error('无法确认旧进程已退出'), { status: 503, code: 'PROCESS_STOP_UNCONFIRMED' });
    }
  }

  status(tenantId, kind) {
    const service = this.get(tenantId, kind);
    if (!service) {
      const run = this.unconfirmedRuns(tenantId, kind)[0];
      return run ? { state: 'stop_unconfirmed', pid: run.pid, lastError: '旧进程停止状态未确认' } : { state: 'stopped', pid: null };
    }
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
    if (existing?.child || existing?.processGroup || existing?.state === 'stop_unconfirmed') {
      throw Object.assign(new Error('旧进程停止状态未确认'), { status: 503, code: 'PROCESS_STOP_UNCONFIRMED' });
    }
    this.assertStopped(tenantId, kind);
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
    if (service.bookkeepingError) {
      service.state = 'stop_unconfirmed';
      throw Object.assign(new Error('无法持久化进程运行记录', { cause: service.bookkeepingError }), { code: 'PROCESS_STOP_UNCONFIRMED' });
    }
    let child;
    try {
      child = spawn(service.command, service.args, {
        cwd: service.cwd,
        env: minimalEnv({ ...service.env, NODE_ENV: service.env.NODE_ENV || 'production' }),
        stdio: service.ready?.signal === 'agent-listening' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        detached: process.platform === 'linux',
        windowsHide: true
      });
    } catch (error) {
      service.state = 'failed';
      service.lastError = String(error?.message || error);
      this._recordRun(runId, service, 'failed', service.lastError);
      throw Object.assign(new Error(`无法启动 ${service.kind}: ${service.lastError}`), { status: 503, code: 'SPAWN_FAILED' });
    }
    service.child = child;
    service.processGroup = process.platform === 'linux' ? child.pid : null;
    service.exitCode = null;
    service.signalCode = null;
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

    const spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const readyTimeoutMs = service.ready?.timeoutMs || this.config.processStartTimeoutMs;
    const readinessStarted = now();
    const shouldAbort = () => child.exitCode !== null || child.signalCode !== null || service.child !== child || service.intentionalStop;
    const readySignal = service.ready?.signal === 'agent-listening'
      ? waitForAgentListening({ child, port: Number(service.ready.port), timeoutMs: readyTimeoutMs, shouldAbort })
      : null;
    child.once('error', (error) => {
      service.lastError = String(error?.message || error);
      service.logs.write('err', service.lastError);
      if (!child.pid) {
        service.child = null;
        service.state = 'failed';
        this._recordRun(runId, service, 'failed', service.lastError);
      }
    });
    child.once('exit', (code, signal) => {
      this._onExit(service, runId, code, signal).catch((error) => {
        service.state = 'stop_unconfirmed';
        service.lastError = String(error?.message || error);
        this._recordRun(runId, service, 'stop_unconfirmed', service.lastError, code);
      });
    });

    try {
      if (readySignal) await Promise.all([spawned, readySignal]);
      else await spawned;
      if (service.ready) {
        const remaining = readySignal ? readyTimeoutMs - (now() - readinessStarted) : readyTimeoutMs;
        if (remaining <= 0) throw Object.assign(new Error('等待端口就绪超时'), { code: 'READY_TIMEOUT' });
        await waitForPort({
          host: service.ready.host || '127.0.0.1',
          port: Number(service.ready.port),
          timeoutMs: remaining,
          shouldAbort
        });
      }
      if (service.child !== child || service.intentionalStop || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('进程在就绪前退出');
      }
      service.readyAt = now();
      service.state = 'running';
      this._recordRun(runId, service, 'running', null);
      if (service.bookkeepingError) throw service.bookkeepingError;
    } catch (error) {
      service.lastError = String(error?.message || error);
      service.logs.write('err', `readiness failed: ${service.lastError}`);
      service.intentionalStop = true;
      if (service.restartTimer) clearTimeout(service.restartTimer);
      service.restartTimer = null;
      await this._terminate(service, true);
      service.state = 'failed';
      this._recordRun(runId, service, 'failed', service.lastError, service.exitCode);
      throw Object.assign(new Error(`${service.kind} 启动失败: ${service.lastError}`), { status: 503, code: child.pid ? 'READY_FAILED' : 'SPAWN_FAILED' });
    }
  }

  async _onExit(service, runId, code, signal) {
    if (service.runId !== runId) return;
    const uptime = now() - service.startedAt;
    service.exitCode = code;
    service.signalCode = signal;
    service.child = null;
    service.lastError = `进程退出 code=${code} signal=${signal || ''}`.trim();
    const groupAlive = this._groupAlive(service);
    this._recordRun(runId, service, groupAlive ? 'stop_unconfirmed' : service.intentionalStop ? 'stopped' : 'exited', service.lastError, code);
    if (service.intentionalStop) {
      service.state = groupAlive ? 'stopping' : 'stopped';
      return;
    }
    if (groupAlive) await this._terminate(service, true);
    this._recordRun(runId, service, 'exited', service.lastError, code);
    service.processGroup = null;
    if (!service.restart || service.intentionalStop || this.closing || service.bookkeepingError) {
      service.state = service.intentionalStop ? 'stopped' : 'crashed';
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
        if (service.state !== 'stop_unconfirmed') service.state = 'crashed';
      });
    }, delay);
    service.restartTimer.unref?.();
  }

  _recordRun(runId, service, state, error, exitCode = null) {
    try {
      const existing = this.db.prepare('SELECT id FROM process_runs WHERE id = ?').get(runId);
      const ts = now();
      const terminal = ['stopped', 'crashed', 'failed', 'exited'].includes(state);
      const pid = service.child?.pid || service.processGroup || null;
      if (!existing) {
        this.db.prepare(`
          INSERT INTO process_runs (id, tenant_id, kind, pid, status, started_at, stopped_at, exit_code, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, service.tenantId, service.kind, pid, state, ts, terminal ? ts : null, exitCode, error ? truncate(error, 500) : null);
      } else {
        this.db.prepare(`
          UPDATE process_runs SET status = ?, pid = COALESCE(?, pid), stopped_at = ?, exit_code = ?, last_error = ? WHERE id = ?
        `).run(state, pid, terminal ? ts : null, exitCode, error ? truncate(error, 500) : null, runId);
      }
      service.bookkeepingError = null;
    } catch (error) {
      service.bookkeepingError = error;
      this.logger?.error?.('process lifecycle persistence failed', error);
    }
  }

  async stop(tenantId, kind, { force = false } = {}) {
    const service = this.get(tenantId, kind);
    if (!service) {
      this.assertStopped(tenantId, kind);
      return { state: 'stopped' };
    }
    if (service.stopPromise) return service.stopPromise;
    service.intentionalStop = true;
    service.restart = false;
    service.state = 'stopping';
    if (service.restartTimer) {
      clearTimeout(service.restartTimer);
      service.restartTimer = null;
    }
    service.stopPromise = (async () => {
      try {
        await this._terminate(service, force);
        this._recordRun(service.runId, service, 'stopped', service.signalCode ? `进程退出 signal=${service.signalCode}` : null, service.exitCode);
        if (service.bookkeepingError) throw service.bookkeepingError;
        this.assertStopped(tenantId, kind);
        service.state = 'stopped';
        service.processGroup = null;
        this.services.delete(this.key(tenantId, kind));
        return { state: 'stopped' };
      } catch (error) {
        service.state = 'stop_unconfirmed';
        throw Object.assign(new Error('无法确认进程已退出并持久化停止记录', { cause: error }), { status: 503, code: 'PROCESS_STOP_UNCONFIRMED' });
      } finally {
        service.stopPromise = null;
      }
    })();
    return service.stopPromise;
  }

  _groupAlive(service) {
    if (!service.processGroup) return false;
    try { process.kill(-service.processGroup, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  }

  async _terminate(service, force = false) {
    const child = service.child;
    const gone = () => !service.child && !this._groupAlive(service);
    if (gone()) return;
    const signal = (name) => {
      try {
        if (service.processGroup) process.kill(-service.processGroup, name);
        else if (child && child.exitCode === null && child.signalCode === null) child.kill(name);
      } catch (error) {
        if (error.code !== 'ESRCH') service.logs.write('err', `stop signal failed: ${error.code || error.message}`);
      }
    };
    const wait = async (timeoutMs) => {
      const deadline = now() + timeoutMs;
      while (!gone() && now() < deadline) await sleep(25);
      return gone();
    };
    signal('SIGTERM');
    if (await wait(force ? 500 : service.stopTimeoutMs)) return;
    service.logs.write('err', '检查并终止剩余进程');
    signal('SIGKILL');
    if (process.platform === 'win32' && child?.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', (error) => service.logs.write('err', `taskkill failed: ${error.message}`));
      killer.unref();
    }
    if (await wait(3000)) return;
    service.state = 'stop_unconfirmed';
    this._recordRun(service.runId, service, 'stop_unconfirmed', '进程或进程组未确认退出', service.exitCode);
    throw Object.assign(new Error('无法确认进程或进程组已退出'), { status: 503, code: 'PROCESS_STOP_UNCONFIRMED' });
  }

  async stopTenant(tenantId) {
    const kinds = new Set([
      ...[...this.services.values()].filter((s) => s.tenantId === tenantId).map((s) => s.kind),
      ...this.unconfirmedRuns(tenantId).map((s) => s.kind)
    ]);
    const results = await Promise.allSettled([...kinds].map((kind) => this.stop(tenantId, kind, { force: true })));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, '租户进程停止失败');
  }

  async shutdown() {
    this.closing = true;
    const tenants = new Set([...this.services.values(), ...this.unconfirmedRuns()].map((service) => service.tenantId || service.tenant_id));
    const results = await Promise.allSettled([...tenants].map((tenantId) => this.stopTenant(tenantId)));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, '部分进程停止失败');
  }

  logs(tenantId, kind, limit = 100) {
    const service = this.get(tenantId, kind);
    if (!service) return [];
    return service.logs.tail(limit);
  }
}
