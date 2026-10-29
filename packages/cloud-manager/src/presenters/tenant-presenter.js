import { getPlan } from '../plans.js';
import fs from 'node:fs';

export function createTenantPresenter(deps) {
  const { tenants, qq, bili, relayKeys, customUpstreams, billing, agent, relay } = deps;
  const qqPhase = (state, processState) => {
    if (state === 'online') return 'online';
    if (['uin_mismatch', 'crashed', 'failed'].includes(state)) return 'error';
    if (['starting', 'restarting'].includes(processState) || state === 'starting') return 'starting';
    if (['running', 'restarting'].includes(processState)) return 'waiting_login';
    if (['awaiting_login', 'auth_required', 'running'].includes(state)) return 'waiting_login';
    return 'stopped';
  };
  const qqSummary = (tenant) => {
    const row = qq.account(tenant.id);
    if (!row) return { available: false, phase: 'stopped', kernel: 'unknown', state: 'unprepared', running: false, loggedIn: false };
    const process = deps.supervisor.status(tenant.id, 'qq');
    const phase = qqPhase(row.state, process.state);
    const caps = qq.capabilities(row.driver);
    const hasToken = row.auth_source && row.auth_source !== 'none';
    return {
      available: true,
      kernel: row.driver,
      driver: row.driver,
      state: row.state,
      phase,
      running: ['running', 'starting', 'restarting'].includes(process.state),
      loggedIn: row.state === 'online',
      online: row.state === 'online',
      uin: row.uin || '',
      nickname: row.nickname || '',
      authTokenStatus: caps?.authToken ? (hasToken ? 'ok' : 'missing') : 'ok',
      authTokenMessage: '',
      qrAvailable: Boolean(caps?.qrcode) && process.state === 'running' && row.state !== 'online',
      onebotConnected: row.state === 'online',
      onebotPort: row.ob11_port ?? null,
      onebotTokenConfigured: true,
      error: row.last_error || '',
      message: row.last_error || ''
    };
  };
  const biliSummary = (tenant) => {
    const row = bili.row(tenant.id);
    if (!row) return { available: false, phase: 'offline', state: 'unprepared', loggedIn: false, subscriptions: {} };
    const process = deps.supervisor.status(tenant.id, 'bili');
    const config = bili.getConfig(tenant);
    return {
      available: true,
      prepared: true,
      enabled: config.enabled,
      phase: process.state === 'crashed' || process.state === 'failed' ? 'error' : (process.state === 'running' ? 'waiting' : 'offline'),
      state: process.state,
      loggedIn: false,
      subscriptions: config.subscriptions,
      error: process.lastError || ''
    };
  };
  const relaySummary = (tenant) => {
    const key = relayKeys.active(tenant.id);
    const custom = customUpstreams.public(tenant);
    const wallet = billing.wallet(tenant.id);
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    return {
      configured: Boolean(key),
      keyMasked: key ? `${key.key_prefix}••••` : '',
      keyStatus: key ? 'active' : 'missing',
      keyStatusLabel: key ? 'Key 有效' : '未绑定 Key',
      keyStatusTone: key ? 'ok' : 'warn',
      model: custom.model,
      source: custom.source,
      plan: { id: plan.id, name: plan.name, rpm: plan.rpm, tpm: plan.tpm },
      quota: { planName: plan.name, rpm: plan.rpm, tpm: plan.tpm, tokenLimit: null, tokenUsed: null, costLimitMicros: null, costUsedMicros: null },
      billing: { ...wallet, currency: 'CNY' }
    };
  };
  const summary = (tenant, role) => {
    const agentStatus = deps.supervisor.status(tenant.id, 'agent');
    const subscriptionStatus = tenant.status;
    const running = ['running', 'starting', 'restarting', 'stopping'].includes(agentStatus.state) || agentStatus.state === 'running';
    const status = subscriptionStatus === 'active'
      ? (agentStatus.state === 'running' ? 'running'
        : ['starting', 'restarting'].includes(agentStatus.state) ? 'starting'
          : agentStatus.state === 'stopping' ? 'stopping' : 'stopped')
      : subscriptionStatus;
    const serialized = tenants.serialize(tenant, { role });
    const qqView = qqSummary(tenant);
    const biliView = biliSummary(tenant);
    const relayView = relaySummary(tenant);
    let allow = {};
    try { allow = JSON.parse(fs.readFileSync(agent.configPath(tenant), 'utf8')).allow || {}; } catch { /* no saved config */ }
    const whitelistReady = [allow.groups, allow.private].some((list) =>
      Array.isArray(list) && list.some((entry) => /^\d+$/.test(String(entry ?? '').trim())));
    const custom = customUpstreams.public(tenant);
    const agentRunning = agentStatus.state === 'running';
    const qqOnline = qqView.loggedIn && qqView.running;
    const channelReady = custom.configured
      ? Boolean(custom.hasKey && custom.model)
      : Boolean(relayKeys.active(tenant.id) && relay.upstreamPublic().configured && billing.wallet(tenant.id).availableMicros > 0 && relayView.model);
    const steps = [
      { id: 'agent', label: '启动实例', ready: agentRunning },
      { id: 'qq', label: '扫码登录 QQ', ready: qqOnline },
      { id: 'channel', label: '配置模型渠道', ready: channelReady },
      { id: 'whitelist', label: '选择互动白名单', ready: whitelistReady }
    ];
    const completed = steps.filter((step) => step.ready).length;
    const readiness = { agentRunning, qqOnline, channelReady, whitelistReady, steps, completed, total: steps.length, ready: completed === steps.length };
    return {
      ...serialized,
      status,
      subscriptionStatus,
      running,
      consoleUrl: serialized.publicUrl,
      qq: qqView,
      bili: biliView,
      relay: relayView,
      readiness,
      summary: {
        agent: { state: agentStatus.state, pid: agentStatus.pid },
        qq: qqView,
        bili: biliView,
        relay: { configured: Boolean(relayKeys.active(tenant.id)) }
      }
    };
  };

  const listSummaries = (user) => tenants.listForUser(user)
    .map((item) => summary(tenants.row(item.id), item.role));

  return { summary, listSummaries };
}
