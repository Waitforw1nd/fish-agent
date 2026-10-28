import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonPrivate } from '../util.js';
import { normalizedOnebotStatus, requestJson } from './common.js';

function fail(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function onebotConfig(ctx) {
  const token = ctx.tokens.onebotToken;
  return {
    network: {
      websocketServers: [{
        name: 'fish-cloud',
        enable: true,
        host: '127.0.0.1',
        port: Number(ctx.account.ob11_port),
        messagePostFormat: 'array',
        token,
        reportSelfMessage: false,
        reportOfflineMessage: false,
        debug: false,
        heartInterval: 30_000
      }],
      httpServers: [{
        name: 'fish-cloud-http',
        enable: true,
        host: '127.0.0.1',
        port: Number(ctx.account.http_port),
        token,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        reportOfflineMessage: false,
        debug: false
      }],
      httpSseServers: [],
      httpClients: [],
      websocketClients: []
    }
  };
}

export const snowlumaDriver = {
  id: 'snowluma',
  label: 'SnowLuma',
  capabilities: {
    qrcode: false,
    authToken: false,
    webui: true,
    onebotHttp: true,
    loginInfo: true,
    logout: false
  },

  async prepare(ctx) {
    if (!/^\d{5,12}$/.test(String(ctx.account.expected_uin || ''))) {
      throw fail(400, 'UIN_REQUIRED', 'SnowLuma 需要先填写要登录的 QQ 号（5-12 位数字）');
    }
    ensureDir(path.join(ctx.paths.dir, 'config'), 0o700);
    const runtimePath = path.join(ctx.paths.dir, 'config', 'runtime.json');
    const runtime = readJsonFile(runtimePath, {});
    writeJsonPrivate(runtimePath, {
      ...runtime,
      webuiHost: '127.0.0.1',
      webuiPort: Number(ctx.account.webui_port),
      webuiTls: { enabled: false },
      webuiToken: ctx.tokens.webuiPassword
    }, 0o600);
    writeJsonPrivate(path.join(ctx.paths.dir, 'config', `onebot_${ctx.account.expected_uin}.json`), onebotConfig(ctx), 0o600);
    return {
      configPath: path.join(ctx.paths.dir, 'config', `onebot_${ctx.account.expected_uin}.json`),
      runtimePath,
      entryExists: fs.existsSync(ctx.config.snowlumaEntry),
      webuiPort: Number(ctx.account.webui_port),
      ob11Port: Number(ctx.account.ob11_port),
      httpPort: Number(ctx.account.http_port)
    };
  },

  async launch(ctx) {
    if (!fs.existsSync(ctx.config.snowlumaEntry)) {
      throw fail(503, 'SNOWLUMA_NOT_INSTALLED', 'SnowLuma 尚未安装或未配置 CLOUD_SNOWLUMA_ENTRY');
    }
    const entryDir = path.dirname(ctx.config.snowlumaEntry);
    const bundledNode = path.join(entryDir, 'node.exe');
    return {
      command: process.platform === 'win32' && fs.existsSync(bundledNode) ? bundledNode : ctx.config.nodePath,
      args: [ctx.config.snowlumaEntry],
      cwd: ctx.paths.dir,
      env: {
        CLOUD_QQ_DRIVER: 'snowluma',
        CLOUD_QQ_UIN: String(ctx.account.expected_uin),
        CLOUD_QQ_WEBUI_PORT: String(ctx.account.webui_port),
        CLOUD_QQ_HTTP_PORT: String(ctx.account.http_port)
      },
      readyPort: Number(ctx.account.webui_port),
      readyHost: '127.0.0.1',
      readyOptional: true
    };
  },

  async status(ctx) {
    if (!ctx.account.http_port) return { online: null, error: '未配置 OneBot HTTP 端口' };
    try {
      const response = await requestJson(`http://127.0.0.1:${ctx.account.http_port}/get_login_info`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.tokens.onebotToken}` },
        body: {},
        timeoutMs: 2500
      });
      const normalized = normalizedOnebotStatus(response);
      if (!normalized.ok) return { online: false, error: normalized.error };
      const expected = String(ctx.account.expected_uin || '');
      return {
        online: true,
        uin: normalized.userId,
        nickname: normalized.nickname,
        uinMismatch: Boolean(expected && normalized.userId && normalized.userId !== expected)
      };
    } catch (error) {
      return { online: false, error: `OneBot HTTP 不可达: ${error?.message || error}` };
    }
  },

  async qrcode() {
    throw fail(501, 'QRCODE_UNSUPPORTED', 'SnowLuma 接入已登录的独立 QQ 进程；其公开接口未提供登录二维码，当前无法通过云面板取码。需要可隔离并展示 QQ 客户端二维码的运行组件');
  },

  async authStatus() {
    return {
      applicable: false,
      hasToken: false,
      validation: 'idle',
      message: 'SnowLuma 不需要 LLBot Auth Token',
      loginError: '',
      online: false,
      source: 'none',
      authTokenPageUrl: ''
    };
  },

  async setAuthToken() {
    throw fail(400, 'AUTH_TOKEN_UNSUPPORTED', 'SnowLuma 模式不使用 LLBot Auth Token');
  }
};
