import path from 'node:path';
import WebSocket from 'ws';
import { id, now, sha256 } from '../util.js';
import { immediateTransaction } from '../db.js';
import { requestJson, normalizedOnebotStatus } from './common.js';

const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const parse = (value) => value ? JSON.parse(value) : null;
const active = ['running', 'needs_attention'];

export class QQSwitchExecutor {
  constructor(service) { this.s = service; this.db = service.db; }
  row(tenant, operationId) {
    const row = this.db.prepare('SELECT * FROM qq_operations WHERE tenant_id=? AND id=?').get(tenant.id, operationId);
    if (!row) throw fail('QQ_OPERATION_NOT_FOUND', '切换操作不存在', 404);
    return row;
  }
  save(row, patch) {
    Object.assign(row, patch, { updated_at: now() });
    this.db.prepare(`UPDATE qq_operations SET status=@status,phase=@phase,source_json=@source_json,target_json=@target_json,
      runtime_generation=@runtime_generation,qr_generation=@qr_generation,agent_was_running=@agent_was_running,
      error_json=@error_json,rollback_json=@rollback_json,updated_at=@updated_at WHERE id=@id`).run({
      id: row.id, status: row.status, phase: row.phase, source_json: row.source_json, target_json: row.target_json,
      runtime_generation: row.runtime_generation, qr_generation: row.qr_generation, agent_was_running: row.agent_was_running,
      error_json: row.error_json, rollback_json: row.rollback_json, updated_at: row.updated_at
    });
  }
  error(error) { return JSON.stringify({ code: error.code || 'QQ_SWITCH_FAILED', message: error.code ? error.message : 'QQ 切换执行失败' }); }
  attention(row, error) { this.save(row, { status: 'needs_attention', error_json: this.error(error) }); }
  profile(tenant, account, legacy = false) {
    let profile = this.db.prepare('SELECT * FROM qq_profiles WHERE tenant_id=? AND driver=? AND expected_uin=?').get(tenant.id, account.driver, account.expected_uin);
    if (!profile) {
      const directory = account.driver === 'snowluma' || (legacy && account.driver === 'llbot') ? path.join(tenant.data_dir, 'qq', account.driver)
        : path.join(tenant.data_dir, 'qq', account.driver, 'accounts', account.expected_uin);
      profile = { id: id('qqprof'), tenant_id: tenant.id, driver: account.driver, expected_uin: account.expected_uin, directory, config_json: '{}', created_at: now(), updated_at: now() };
      this.db.prepare('INSERT INTO qq_profiles VALUES (@id,@tenant_id,@driver,@expected_uin,@directory,@config_json,@created_at,@updated_at)').run(profile);
    }
    return profile;
  }
  claim(tenant, account, operationId = null, expectedOperationId = null) {
    const runtimeId = account.effective_runtime_id || null;
    const current = this.db.prepare('SELECT * FROM qq_account_claims WHERE uin=?').get(account.expected_uin);
    if (!current) {
      this.db.prepare('INSERT INTO qq_account_claims (uin,tenant_id,operation_id,runtime_id,created_at) VALUES (?,?,?,?,?)')
        .run(account.expected_uin, tenant.id, operationId, runtimeId, now());
      return;
    }
    if (current.tenant_id !== tenant.id) throw fail('QQ_ACCOUNT_IN_USE', '该 QQ 账号已被占用');
    if (current.runtime_id !== runtimeId || (current.operation_id !== expectedOperationId && current.operation_id !== operationId)) throw fail('QQ_CLAIM_CONFLICT', 'QQ 账号占用身份已改变');
    const result = this.db.prepare('UPDATE qq_account_claims SET operation_id=? WHERE tenant_id=? AND uin=? AND runtime_id IS ? AND operation_id IS ?')
      .run(operationId, tenant.id, account.expected_uin, runtimeId, current.operation_id);
    if (result.changes !== 1) throw fail('QQ_CLAIM_CONFLICT', 'QQ 账号占用身份已改变');
  }
  releaseClaim(tenant, account, operationId = null) {
    return this.db.prepare('DELETE FROM qq_account_claims WHERE tenant_id=? AND uin=? AND runtime_id IS ? AND operation_id IS ?')
      .run(tenant.id, account.expected_uin, account.effective_runtime_id || null, operationId).changes;
  }
  async preflight(tenant, account) {
    if (account.driver === 'napcat') await this.s.docker.preflight();
    else {
      await this.s.driver('llbot').preflight({ config: this.s.config });
      if (!this.s.resolveAuthToken(tenant, account).token) throw fail('AUTH_TOKEN_REQUIRED', 'LLBot Direct 需要登录授权');
    }
  }
  async start(tenant, { driver, expectedRevision, idempotencyKey, uin } = {}) {
    const targetDriver = String(driver || '').toLowerCase();
    const key = String(idempotencyKey || '').trim();
    if (!key || key.length > 200) throw fail('INVALID_IDEMPOTENCY_KEY', '需要有效的幂等键', 400);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('INVALID_REVISION', '需要有效的配置版本', 400);
    if (!['llbot', 'napcat'].includes(targetDriver) || !this.s.config.qqDrivers.includes(targetDriver)) throw fail('UNKNOWN_DRIVER', '未知或未允许的 QQ 协议端驱动', 400);
    const account = this.s.account(tenant.id);
    const expectedUin = String(uin || account?.expected_uin || '').trim();
    if (!/^\d{5,12}$/.test(expectedUin)) throw fail('INVALID_UIN', '请填写 5-12 位 QQ 号', 400);
    const hash = sha256(JSON.stringify({ target: targetDriver, expectedRevision, expectedUin }));
    const previous = this.db.prepare('SELECT * FROM qq_operations WHERE tenant_id=? AND idempotency_key=?').get(tenant.id, key);
    if (previous) {
      if (previous.request_hash !== hash) throw fail('IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
      return this.s.publicOperation(previous);
    }
    const operationId = id('qqop');
    immediateTransaction(this.db, () => {
      this.s.assertNoSwitch(tenant.id);
      if (!account || Number(account.revision) !== expectedRevision) throw fail('QQ_REVISION_CONFLICT', 'QQ 配置版本已改变');
      if (tenant.status !== 'active' || Number(tenant.expires_at) <= now()) throw fail('TENANT_INACTIVE', '实例不可用');
      this.db.prepare(`INSERT INTO qq_operations (id,tenant_id,idempotency_key,request_hash,status,phase,source_driver,target_driver,expected_uin,expected_revision,source_json,created_at,updated_at)
        VALUES (?,?,?,?,'running','preflight',?,?,?,?,?,?,?)`).run(operationId, tenant.id, key, hash, account.driver, targetDriver, expectedUin, expectedRevision, JSON.stringify({ account }), now(), now());
    });
    const row = this.row(tenant, operationId);
    try {
      await this.preflight(tenant, { driver: targetDriver });
      const claimed = this.db.prepare('SELECT tenant_id FROM qq_account_claims WHERE uin=?').get(expectedUin);
      if (claimed && claimed.tenant_id !== tenant.id) throw fail('QQ_ACCOUNT_IN_USE', '该 QQ 账号已被占用');
      const process = await this.s.runtimeStatus(tenant, account);
      if (!['running', 'starting', 'restarting', 'stopped', 'crashed'].includes(process.state)) throw fail('QQ_RUNTIME_UNCONFIRMED', '无法确认旧 QQ 运行状态', 503);
      this.save(row, { phase: 'snapshot_intent' });
      const snapshot = await this.s.switchLifecycle?.snapshot?.(tenant) || { agentWasRunning: false };
      const profile = this.profile(tenant, account, !account.effective_profile_id);
      const source = { account: { ...account, effective_profile_id: profile.id }, runtime: this.s.docker.row(tenant.id), process,
        wasRunning: ['running', 'starting', 'restarting'].includes(process.state),
        leases: this.db.prepare("SELECT * FROM port_leases WHERE tenant_id=? AND released_at IS NULL AND purpose LIKE 'qq.%'").all(tenant.id), snapshot };
      this.save(row, { source_json: JSON.stringify(source), agent_was_running: snapshot.agentWasRunning ? 1 : 0, phase: 'snapshot_saved' });
      immediateTransaction(this.db, () => this.claim(tenant, source.account, row.id));
      this.save(row, { phase: 'quiesce_intent' });
      await this.s.switchLifecycle?.quiesce?.(tenant, this.s.publicOperation(row));
      this.save(row, { phase: 'quiesced' });
      this.save(row, { phase: 'stop_source_intent' });
      await this.stopRuntime(tenant, source.account, source.runtime);
      this.save(row, { phase: 'source_stopped' });
      this.releaseClaim(tenant, source.account, row.id);
      const generation = Math.max(Number(source.runtime?.generation || 0), Number(account.runtime_generation || 0), Number(this.db.prepare('SELECT MAX(runtime_generation) AS value FROM qq_operations WHERE tenant_id=?').get(tenant.id).value || 0)) + 1;
      const target = { account: { tenant_id: tenant.id, driver: targetDriver, expected_uin: expectedUin, uin: null, nickname: null,
        state: 'awaiting_login', effective_runtime_id: id('qqrun'), runtime_generation: generation, runtime_secret_namespace: `qq.${targetDriver}.runtime.${generation}` }, leases: [], started: false };
      target.account.effective_profile_id = this.profile(tenant, target.account).id;
      this.save(row, { target_json: JSON.stringify(target), runtime_generation: generation, phase: 'prepare_target' });
      immediateTransaction(this.db, () => this.claim(tenant, target.account, row.id));
      for (const [purpose, field] of [['webui', 'webui_port'], ['ob11', 'ob11_port'], ...(targetDriver === 'napcat' ? [['http', 'http_port']] : [])]) {
        const lease = await this.s.allocator.allocate(tenant.id, `qq.g${generation}.${purpose}`, { host: '127.0.0.1', meta: { runtimeId: target.account.effective_runtime_id, generation } });
        target.leases.push(lease);
        target.account[field] = lease.port;
        this.save(row, { target_json: JSON.stringify(target) });
      }
      this.save(row, { phase: 'start_target_intent' });
      await this.launchRuntime(tenant, target.account);
      target.started = true;
      target.runtime = this.s.docker.row(tenant.id);
      this.save(row, { target_json: JSON.stringify(target), phase: 'waiting_qr' });
      await this.tick(tenant, row);
    } catch (error) {
      if (row.phase === 'preflight' && ['QQ_RUNTIME_UNCONFIRMED', 'NAPCAT_RESOURCE_UNCONFIRMED'].includes(error.code)) this.attention(row, error);
      else if (['preflight', 'snapshot_intent', 'snapshot_saved'].includes(row.phase)) this.save(row, { status: 'failed', error_json: this.error(error) });
      else if (['quiesce_intent', 'quiesced', 'stop_source_intent'].includes(row.phase)) this.attention(row, error);
      else await this.rollback(tenant, row, error);
    }
    return this.s.publicOperation(row);
  }
  async stopRuntime(tenant, account, expectedRuntime = null) {
    const runtime = this.s.docker.row(tenant.id);
    this.s.docker.assertResourceIdentity(runtime);
    if (runtime?.driver === 'napcat' && (runtime.container_id || runtime.network_id || runtime.state !== 'stopped')) {
      if (account.driver !== 'napcat' || (expectedRuntime?.runtime_id && expectedRuntime.runtime_id !== runtime.runtime_id)) throw fail('QQ_RUNTIME_UNCONFIRMED', 'QQ 运行身份不匹配', 503);
      await this.s.docker.stop(tenant.id);
      const after = this.s.docker.row(tenant.id);
      if (after?.container_id || after?.network_id) throw fail('QQ_STOP_UNCONFIRMED', 'QQ 容器停止未确认', 503);
    }
    if (account.driver !== 'napcat') {
      await this.s.supervisor.stop(tenant.id, 'qq', { force: true });
      this.s.supervisor.assertStopped?.(tenant.id, 'qq');
      if (!['stopped', 'crashed', 'failed'].includes(this.s.supervisor.status(tenant.id, 'qq').state)) throw fail('QQ_STOP_UNCONFIRMED', 'QQ 进程停止未确认', 503);
      if (runtime?.driver === account.driver) this.s.docker.save({ ...runtime, desired_state: 'stopped', state: 'stopped', updated_at: now() });
    }
  }
  async launchRuntime(tenant, account) {
    const driver = this.s.driver(account.driver);
    const tokens = this.s.tokens(tenant, account);
    account.auth_source = tokens.authSource;
    const ctx = this.s.driverContext(tenant, account, account.driver, tokens, driver);
    await driver.prepare(ctx);
    if (account.driver === 'napcat') {
      await this.s.docker.start(tenant, account, ctx.paths.dir, { runtimeId: account.effective_runtime_id, generation: account.runtime_generation });
      const deadline = now() + (this.s.config.processStartTimeoutMs || 30000);
      for (;;) {
        let status;
        try { status = await driver.status(ctx); } catch { status = null; }
        if (status && !status.error) break;
        if (now() >= deadline) throw fail('NAPCAT_READY_TIMEOUT', 'NapCat WebUI 未在时限内就绪', 503);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } else {
      const launch = await driver.launch(ctx);
      this.s.docker.save({ tenant_id: tenant.id, runtime_id: account.effective_runtime_id, driver: account.driver, generation: account.runtime_generation,
        container_id: null, network_id: null, image: null, desired_state: 'running', state: 'starting', updated_at: now(),
        spec_json: JSON.stringify({ dir: ctx.paths.dir, account }) });
      await this.s.supervisor.start({ tenantId: tenant.id, kind: 'qq', command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env || {},
        logFile: path.join(this.s.config.logDir, 'tenants', `${tenant.id}.qq.log`),
        ready: launch.readyOptional ? null : { host: launch.readyHost || '127.0.0.1', port: Number(launch.readyPort), timeoutMs: this.s.config.processStartTimeoutMs },
        restart: false, metadata: { runtimeId: account.effective_runtime_id, generation: account.runtime_generation } });
    }
  }
  async loginInfo(tenant, account) {
    const tokens = this.s.tokens(tenant, account);
    if (account.driver !== 'llbot') {
      const result = normalizedOnebotStatus(await requestJson(`http://127.0.0.1:${account.http_port}/get_login_info`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${tokens.onebotToken}` }, timeoutMs: 3000 }));
      if (!result.ok) throw fail('ONEBOT_NOT_READY', 'OneBot 尚未就绪', 503);
      return result.userId;
    }
    return new Promise((resolve, reject) => {
      const echo = id('probe');
      const socket = new WebSocket(`ws://127.0.0.1:${account.ob11_port}`, { headers: { Authorization: `Bearer ${tokens.onebotToken}` }, handshakeTimeout: 3000 });
      const timer = setTimeout(() => done(fail('ONEBOT_NOT_READY', 'OneBot 尚未就绪', 503)), 3500);
      let settled = false;
      const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(value); };
      socket.on('error', () => done(fail('ONEBOT_NOT_READY', 'OneBot 尚未就绪', 503)));
      socket.on('close', () => done(fail('ONEBOT_NOT_READY', 'OneBot 已断开', 503)));
      socket.on('open', () => socket.send(JSON.stringify({ action: 'get_login_info', params: {}, echo })));
      socket.on('message', (raw) => {
        let data; try { data = JSON.parse(raw); } catch { return; }
        if (data.echo !== echo) return;
        const result = normalizedOnebotStatus({ body: data });
        done(result.ok ? null : fail('ONEBOT_NOT_READY', 'OneBot 尚未就绪', 503), result.userId);
      });
    });
  }
  async tick(tenant, row) {
    if (row.status !== 'running') return;
    const currentTenant = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenant.id);
    if (!currentTenant || currentTenant.status !== 'active' || Number(currentTenant.expires_at) <= now()) {
      await this.rollback(tenant, row, fail('TENANT_INACTIVE', '实例不可用'), { restore: false, cancelled: true });
      return;
    }
    const target = parse(row.target_json);
    try {
      if (row.phase === 'waiting_qr') {
        const process = await this.s.runtimeStatus(tenant, target.account);
        if (['degraded', 'stop_unconfirmed'].includes(process.state)) { this.attention(row, fail('QQ_RUNTIME_UNCONFIRMED', '目标运行状态未确认')); return; }
        if (!['running', 'starting', 'restarting'].includes(process.state)) throw fail('QQ_TARGET_EXITED', '目标 QQ 已退出', 503);
        const driver = this.s.driver(target.account.driver);
        const status = await driver.status(this.s.driverContext(tenant, target.account, target.account.driver, this.s.tokens(tenant, target.account), driver));
        if (status.uinMismatch || (status.uin && String(status.uin) !== row.expected_uin)) throw fail('QQ_UIN_MISMATCH', '目标登录账号与预期不一致');
        if (!status.online || !status.uin) return;
        let uin;
        try { uin = await this.loginInfo(tenant, target.account); }
        catch (error) { if (error.code === 'ONEBOT_NOT_READY' || !error.code) return; throw error; }
        if (String(uin || '') !== row.expected_uin) throw fail('QQ_UIN_MISMATCH', 'OneBot 登录账号与预期不一致');
        Object.assign(target.account, { uin: row.expected_uin, nickname: status.nickname || null, state: 'online' });
        const runtime = this.s.docker.row(tenant.id);
        if (!runtime || runtime.runtime_id !== target.account.effective_runtime_id || Number(runtime.generation) !== Number(row.runtime_generation)) throw fail('QQ_RUNTIME_UNCONFIRMED', '目标运行身份已改变');
        this.s.docker.save({ ...runtime, state: 'running', updated_at: now() });
        immediateTransaction(this.db, () => {
          if (Number(this.s.account(tenant.id).revision) !== row.expected_revision) throw fail('QQ_REVISION_CONFLICT', 'QQ 配置版本已改变');
          this.s.upsertAccount(target.account);
          this.db.prepare('UPDATE qq_accounts SET revision=revision+1 WHERE tenant_id=?').run(tenant.id);
          this.save(row, { target_json: JSON.stringify(target), phase: 'committed' });
        });
      }
      if (row.phase === 'committed') {
        this.save(row, { phase: 'resume_intent' });
        await this.s.switchLifecycle?.resume?.(tenant, this.s.publicOperation(row), { rollback: false });
        this.save(row, { phase: 'verify_agent' });
      }
      if (row.phase === 'verify_agent') {
        if (row.agent_was_running) {
          const health = await this.s.agentRuntime?.health(tenant);
          const channel = health?.channels?.qq || (health?.onebot?.platform === 'qq' ? health.onebot : null);
          if (!health?.ok || !channel?.connected || Number(channel.generation) !== row.runtime_generation || String(channel.selfId || '') !== row.expected_uin) {
            if (now() - row.updated_at > (this.s.config.processStartTimeoutMs || 30000)) throw fail('AGENT_CHANNEL_TIMEOUT', 'Agent 未确认新 QQ 通道', 503);
            return;
          }
        }
        const source = parse(row.source_json);
        for (const lease of source.leases || []) this.s.allocator.releaseLease(lease.id);
        immediateTransaction(this.db, () => { this.claim(tenant, target.account, null, row.id); this.save(row, { phase: 'completed', status: 'succeeded' }); });
        try {
          await this.s.audit?.record?.({ tenantId: tenant.id, action: 'qq.switch', detail: { operationId: row.id, sourceDriver: row.source_driver, targetDriver: row.target_driver, status: 'succeeded' } });
        } catch {
          try { this.s.logger?.error?.('qq switch audit failed', { tenantId: tenant.id, operationId: row.id }); } catch { /* Audit logging cannot undo a completed switch. */ }
        }
      }
    } catch (error) { await this.rollback(tenant, row, error); }
  }
  async rollback(tenant, row, error, { restore = true, cancelled = false } = {}) {
    const source = parse(row.source_json);
    const target = parse(row.target_json);
    this.save(row, { phase: 'rollback_stop_intent', error_json: this.error(error), rollback_json: JSON.stringify({ status: 'running', restore }) });
    try {
      await this.s.switchLifecycle?.quiesce?.(tenant, this.s.publicOperation(row));
      const restoringSource = row.rollback_json && this.s.docker.row(tenant.id)?.runtime_id === source.account.effective_runtime_id;
      if (restoringSource) await this.stopRuntime(tenant, source.account);
      else if (target) await this.stopRuntime(tenant, target.account, target.runtime);
      else await this.stopRuntime(tenant, source.account, source.runtime);
      this.releaseClaim(tenant, source.account, row.id);
      if (target) {
        this.releaseClaim(tenant, target.account, row.id);
        for (const lease of target.leases || []) this.s.allocator.releaseLease(lease.id);
      }
      this.save(row, { phase: 'rollback_target_stopped' });
      const liveTenant = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenant.id);
      const allowed = restore && liveTenant?.status === 'active' && Number(liveTenant.expires_at) > now();
      const account = { ...source.account };
      if (allowed && source.wasRunning) {
        await this.preflight(tenant, account);
        account.effective_runtime_id = id('qqrun');
        account.runtime_generation = Math.max(Number(row.runtime_generation || 0), Number(account.runtime_generation || 0)) + 1;
        account.runtime_secret_namespace = `qq.${account.driver}.runtime.${account.runtime_generation}`;
        this.save(row, { source_json: JSON.stringify({ ...source, account }), phase: 'rollback_start_intent' });
        immediateTransaction(this.db, () => this.claim(tenant, account, row.id));
        await this.launchRuntime(tenant, account);
        account.state = 'awaiting_login';
        const deadline = now() + (this.s.config.processStartTimeoutMs || 30000);
        for (;;) {
          const status = await this.s.driver(account.driver).status(this.s.driverContext(tenant, account, account.driver, this.s.tokens(tenant, account)));
          if (status.uinMismatch || (status.uin && String(status.uin) !== account.expected_uin)) {
            await this.stopRuntime(tenant, account); this.releaseClaim(tenant, account, row.id);
            throw fail('QQ_ROLLBACK_UIN_MISMATCH', '旧内核恢复后账号不匹配');
          }
          if (status.online && String(status.uin || '') === account.expected_uin) {
            let loginUin;
            try { loginUin = await this.loginInfo(tenant, account); } catch { loginUin = null; }
            if (loginUin && String(loginUin) !== account.expected_uin) {
              await this.stopRuntime(tenant, account); this.releaseClaim(tenant, account, row.id);
              throw fail('QQ_ROLLBACK_UIN_MISMATCH', '旧内核 OneBot 账号不匹配');
            }
            if (String(loginUin || '') === account.expected_uin) break;
          }
          if (now() >= deadline) throw fail('QQ_ROLLBACK_LOGIN_REQUIRED', '旧内核待重新登录');
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        account.state = 'online';
        account.uin = account.expected_uin;
      } else account.state = 'prepared';
      immediateTransaction(this.db, () => {
        const changed = this.s.account(tenant.id).effective_runtime_id !== account.effective_runtime_id;
        this.s.upsertAccount(account);
        if (changed) this.db.prepare('UPDATE qq_accounts SET revision=revision+1 WHERE tenant_id=?').run(tenant.id);
        this.save(row, { phase: 'rollback_saved', source_json: JSON.stringify({ ...source, account }) });
      });
      if (allowed && row.agent_was_running) {
        this.save(row, { phase: 'rollback_resume_intent' });
        await this.s.switchLifecycle?.resume?.(tenant, this.s.publicOperation(row), { rollback: true });
        const deadline = now() + (this.s.config.processStartTimeoutMs || 30000);
        for (;;) {
          const health = await this.s.agentRuntime?.health(tenant);
          const channel = health?.channels?.qq || (health?.onebot?.platform === 'qq' ? health.onebot : null);
          if (health?.ok && (!source.wasRunning || (channel?.connected && Number(channel.generation) === account.runtime_generation && String(channel.selfId || '') === account.expected_uin))) break;
          if (now() >= deadline) throw fail('QQ_ROLLBACK_AGENT_UNCONFIRMED', '旧内核 Agent 通道尚未确认');
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      if (allowed && source.wasRunning) this.claim(tenant, account, null, row.id);
      this.save(row, { status: cancelled ? 'cancelled' : 'failed', phase: 'rolled_back', rollback_json: JSON.stringify({ status: allowed && source.wasRunning ? 'restored' : 'stopped', restore: allowed }) });
    } catch (rollbackError) {
      this.save(row, { status: 'needs_attention', rollback_json: JSON.stringify({ status: 'failed', restore, code: rollbackError.code || 'QQ_ROLLBACK_FAILED', message: rollbackError.code ? rollbackError.message : '旧内核恢复失败' }) });
    }
  }
  async cancel(tenant, operationId, { restore = true } = {}) {
    const row = this.row(tenant, operationId);
    if (restore && ['committed', 'resume_intent', 'verify_agent', 'completed'].includes(row.phase)) throw fail('CANCEL_TOO_LATE', '切换配置已提交，无法取消');
    if (!active.includes(row.status)) return this.s.publicOperation(row);
    if (row.status === 'needs_attention' && row.phase === 'preflight') return this.s.publicOperation(row);
    if (['preflight', 'snapshot_intent', 'snapshot_saved'].includes(row.phase)) this.save(row, { status: 'cancelled' });
    else if (row.status === 'needs_attention' && restore) return this.s.publicOperation(row);
    else await this.rollback(tenant, row, fail('QQ_SWITCH_CANCELLED', '切换已取消'), { restore, cancelled: true });
    return this.s.publicOperation(row);
  }
  async recover() {
    const rows = this.db.prepare("SELECT * FROM qq_operations WHERE status='running'").all();
    for (const row of rows) {
      const tenant = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(row.tenant_id);
      await this.s.serial(row.tenant_id, async () => {
        if (['preflight', 'snapshot_intent', 'snapshot_saved'].includes(row.phase)) this.save(row, { status: 'failed', error_json: this.error(fail('QQ_SWITCH_INTERRUPTED', '切换在暂停旧运行前中断')) });
        else if (row.phase === 'waiting_qr' && row.target_driver === 'napcat') {
          const target = parse(row.target_json);
          try {
            const runtime = this.s.docker.row(tenant.id);
            if (runtime?.runtime_id !== target.account.effective_runtime_id) throw fail('QQ_RECOVERY_UNCONFIRMED', '恢复时运行身份不匹配');
            const actual = await this.s.docker.inspect(runtime);
            if (!actual?.State?.Running) throw fail('QQ_RECOVERY_UNCONFIRMED', '目标运行停止状态需核对');
            if (tenant.status !== 'active' || Number(tenant.expires_at) <= now()) await this.cancel(tenant, row.id, { restore: false });
            else {
              if (this.s.agentRuntime?.assertNoUnconfirmedAgent) await this.s.agentRuntime.assertNoUnconfirmedAgent(tenant);
              else if (this.db.prepare("SELECT 1 FROM process_runs WHERE tenant_id=? AND kind='agent' AND (stopped_at IS NULL OR status NOT IN ('stopped','exited','failed','crashed'))").get(tenant.id)) throw fail('AGENT_STOP_UNCONFIRMED', '旧 Agent 退出状态未确认');
              await this.tick(tenant, row);
            }
          } catch (error) { this.attention(row, error); }
        } else this.attention(row, fail('QQ_RECOVERY_UNCONFIRMED', '管理器重启后运行或生命周期意图需核对，未启动第二份 QQ'));
      });
    }
  }
  async qrcode(tenant, row) {
    if (row.status !== 'running' || row.phase !== 'waiting_qr') throw fail('QQ_QRCODE_UNAVAILABLE', '当前切换阶段不可获取二维码');
    const target = parse(row.target_json);
    const account = target.account;
    const qr = await this.s.driver(account.driver).qrcode(this.s.driverContext(tenant, account, account.driver, this.s.tokens(tenant, account)));
    const signature = sha256(String(qr.qrcodeUrl || qr.pngBase64 || qr.state || ''));
    if (signature !== target.qrSignature) { target.qrSignature = signature; this.save(row, { target_json: JSON.stringify(target), qr_generation: row.qr_generation + 1 }); }
    return { ...qr, operationId: row.id, runtimeGeneration: row.runtime_generation, qrGeneration: row.qr_generation, driver: account.driver, expectedUin: account.expected_uin };
  }
}
