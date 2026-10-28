import fs from 'node:fs';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import path from 'node:path';
import { ensureDir, writeJsonPrivate } from '../util.js';
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
        debug: false,
        enableHeart: false,
        heartInterval: 30_000
      }],
      httpSseServers: [],
      httpClients: [],
      websocketClients: []
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false
  };
}

export const napcatDriver = {
  id: 'napcat',
  label: 'NapCat',
  capabilities: {
    qrcode: true,
    authToken: false,
    webui: true,
    onebotHttp: true,
    loginInfo: true,
    logout: false
  },

  async prepare(ctx) {
    if (!/^\d{5,12}$/.test(String(ctx.account.expected_uin || ''))) {
      throw fail(400, 'UIN_REQUIRED', 'NapCat 需要先填写要登录的 QQ 号（5-12 位数字）');
    }
    ensureDir(path.join(ctx.paths.dir, 'config'), 0o700);
    writeJsonPrivate(path.join(ctx.paths.dir, 'config', `onebot11_${ctx.account.expected_uin}.json`), onebotConfig(ctx), 0o600);
    writeJsonPrivate(path.join(ctx.paths.dir, 'config', 'webui.json'), {
      host: '127.0.0.1',
      port: Number(ctx.account.webui_port),
      token: ctx.tokens.webuiPassword
    }, 0o600);
    return {
      configPath: path.join(ctx.paths.dir, 'config', `onebot11_${ctx.account.expected_uin}.json`),
      entryExists: fs.existsSync(ctx.config.napcatEntry),
      webuiPort: Number(ctx.account.webui_port),
      ob11Port: Number(ctx.account.ob11_port),
      httpPort: Number(ctx.account.http_port)
    };
  },

  async launch(ctx) {
    if (!fs.existsSync(ctx.config.napcatEntry)) {
      throw fail(503, 'NAPCAT_NOT_INSTALLED', 'NapCat 尚未安装或未配置 CLOUD_NAPCAT_ENTRY');
    }
    const isExecutable = /\.(exe|bat|cmd)$/i.test(ctx.config.napcatEntry);
    return {
      command: isExecutable ? ctx.config.napcatEntry : ctx.config.nodePath,
      args: isExecutable ? ['-q', String(ctx.account.expected_uin)] : [ctx.config.napcatEntry, '-q', String(ctx.account.expected_uin)],
      cwd: ctx.paths.dir,
      env: {
        NAPCAT_WEBUI_SECRET_KEY: ctx.tokens.webuiPassword,
        CLOUD_QQ_DRIVER: 'napcat',
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

  async qrcode(ctx) {
    const base = `http://127.0.0.1:${ctx.account.webui_port}/api`;
    const hash = createHash('sha256').update(`${ctx.tokens.webuiPassword}.napcat`).digest('hex');
    const login = await requestJson(`${base}/auth/login`, { method: 'POST', body: { hash } });
    const credential = login.body?.data?.Credential;
    if (login.body?.code !== 0 || !credential) {
      throw fail(502, 'NAPCAT_WEBUI_AUTH_FAILED', login.body?.data?.require2FA ? 'NapCat WebUI 启用了二次验证，无法自动获取二维码' : 'NapCat WebUI 鉴权失败，请检查版本和配置');
    }
    const headers = { authorization: `Bearer ${credential}` };
    const status = await requestJson(`${base}/QQLogin/CheckLoginStatus`, { method: 'POST', headers, body: {} });
    if (status.body?.code !== 0) throw fail(502, 'NAPCAT_LOGIN_STATUS_FAILED', status.body?.message || 'NapCat 登录状态不可用');
    const data = status.body.data || {};
    if (data.isLogin) return { state: 'success' };
    const qr = await requestJson(`${base}/QQLogin/GetQQLoginQrcode`, { method: 'POST', headers, body: {} });
    if (qr.body?.code !== 0 || !qr.body?.data?.qrcode) {
      return { state: 'pending', message: qr.body?.message || '等待 NapCat 生成二维码', pollTimeInterval: 3 };
    }
    const qrcodeUrl = String(qr.body.data.qrcode);
    if (qrcodeUrl.length > 4096) throw fail(502, 'NAPCAT_QRCODE_INVALID', 'NapCat 返回的二维码内容过长');
    return { state: data.loginPhase === 'qrcode_scanned' ? 'scanned' : 'ready', qrcodeUrl, pngBase64: await QRCode.toDataURL(qrcodeUrl), pollTimeInterval: 3 };
  },

  async authStatus() {
    return {
      applicable: false,
      hasToken: false,
      validation: 'idle',
      message: 'NapCat 不需要 LLBot Auth Token（使用 QQ 客户端自有登录）',
      loginError: '',
      online: false,
      source: 'none',
      authTokenPageUrl: ''
    };
  },

  async setAuthToken() {
    throw fail(400, 'AUTH_TOKEN_UNSUPPORTED', 'NapCat 模式不使用 LLBot Auth Token');
  }
};
