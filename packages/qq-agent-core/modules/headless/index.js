import { createApp } from '../../src/app.js';
import { getConfig, deepMerge, resolveChannels } from '../../src/config.js';
import { ChannelRouter } from '../../src/channel-router.js';
import { OneBotClient } from '../../src/onebot.js';
import { BotConnection, connectionConfig } from './connection.js';
import { createConsoleAuth, serverOptions } from './console.js';

// Trusted, explicit bootstrap composition; never loaded as a chat Skill/plugin.
// The desktop entry does not import this module.
export function createHeadlessApp({ env = process.env, log = console.log } = {}) {
  const options = () => serverOptions(getConfig(), env);
  options();
  connectionConfig(getConfig());
  const auth = createConsoleAuth({ getOptions: options });
  let connection, orchestrator, emit, stopped = false;
  const channelsFor = config => {
    const channels = resolveChannels(config);
    const qq = connectionConfig(config);
    if (qq.enabled && qq.type === 'qqbot') throw new Error('当前双通道路由仅支持数字 OneBot ID，暂不支持 QQBot OpenID');
    return { ...channels, qq: { ...channels.qq, enabled: qq.enabled } };
  };
  channelsFor(getConfig());
  const runtime = {
    name: 'headless',
    listenOptions: () => options(),
    authorize: auth.authorize,
    originAllowed: auth.originAllowed,
    createConnection({ config, server, onEvent }) {
      connection = new ChannelRouter({
        channels: channelsFor(config), log, onEvent,
        createClient(platform, cfg) {
          const dispatch = event => connection.dispatch(platform, event);
          if (platform === 'qq') return new BotConnection({ config: connectionConfig(getConfig()), server, onEvent: dispatch });
          return new OneBotClient({ platform, wsUrl: cfg.wsUrl, httpUrl: cfg.httpUrl,
            accessToken: cfg.accessToken, httpToken: cfg.httpAccessToken,
            selfUserId: cfg.selfUserId, selfNickname: cfg.selfNickname, onEvent: dispatch });
        }
      });
      return connection;
    },
    attach(context) { ({ orchestrator, emit } = context); },
    status() {
      const cfg = connectionConfig(getConfig());
      const status = connection.status();
      const qq = status.channels.qq;
      return {
        runtime: { name: 'headless', platform: process.platform, arch: process.arch, connectionSettingsPath: '/runtime/connection' },
        connection: { type: cfg.type, enabled: cfg.enabled, connected: qq?.connected || false },
        onebot: { ...status, type: cfg.type,
          diagnosis: !cfg.enabled ? '协议接入未启用 / Connection disabled'
            : qq?.connected ? '' : qq?.error || '等待协议连接 / Waiting for protocol connection'
        },
        snowluma: { external: true, running: false, dir: '', webuiUrl: '' },
        qqPortable: { external: true, installed: false, running: false }
      };
    },
    validateConfig(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuration patch must be an object');
      const merged = deepMerge(getConfig(), patch);
      serverOptions(merged, env);
      channelsFor(merged);
    },
    async configChanged(next, before) {
      const config = connectionConfig(next);
      const channels = channelsFor(next);
      if (JSON.stringify([config, channels]) === JSON.stringify([connectionConfig(before), channelsFor(before)])) return;
      // abortAll is a permanent shutdown gate in the core. Reconfiguration must
      // cancel old runs individually and then restore scheduling and timers.
      for (const id of orchestrator.activeRuns.values()) orchestrator.abortSession(id);
      await orchestrator.abortAll();
      if (stopped) return;
      try {
        connection.close();
        connection.applyChannelConfig(channels);
        connection.channel('qq')?.client?.configure(config);
        await connection.connect();
      } finally {
        if (!stopped) {
          orchestrator.aborted = false;
          if (next.proactive?.enabled) orchestrator.startProactiveLoop();
          orchestrator.startReminderLoop();
        }
      }
      emit('onebot-status', connection.status());
    },
    async handleRequest(context) {
      if (await auth.handleRequest(context)) return true;
      const { req, res, url, json } = context;
      if (url.pathname === '/api/runtime/connection' && req.method === 'GET') {
        const config = connectionConfig(getConfig());
        const ob = { ...config.onebot }, qq = { ...config.qqbot };
        ob.hasAccessToken = Boolean(ob.accessToken);
        ob.hasHttpAccessToken = Boolean(ob.httpAccessToken);
        qq.hasAppSecret = Boolean(qq.appSecret);
        delete ob.accessToken;
        delete ob.httpAccessToken;
        delete qq.appSecret;
        json(res, 200, { ...config, onebot: ob, qqbot: qq });
        return true;
      }
      if (/^\/api\/(snowluma|qq-portable)(\/|$)/.test(url.pathname) || url.pathname === '/api/open-data-dir') {
        json(res, 409, { error: '外部运行模块不管理桌面 QQ 进程 / Manage the external protocol service separately' });
        return true;
      }
      return false;
    },
    stop() { stopped = true; connection?.close(); auth.close(); }
  };
  return createApp({ log, runtime });
}
