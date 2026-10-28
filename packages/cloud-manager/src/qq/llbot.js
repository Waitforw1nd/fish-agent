import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonFile, writeFilePrivate, writeJsonPrivate } from '../util.js';
import { llbotWebuiHeaders, requestJson } from './common.js';

function fail(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function runtimeSettings(ctx) {
  const file = path.join(ctx.paths.dir, 'runtime.json');
  const existing = readJsonFile(file, {});
  const mode = String(ctx.options?.mode ?? existing.mode ?? 'direct').toLowerCase();
  if (!['direct', 'desktop'].includes(mode)) throw fail(400, 'INVALID_LLBOT_MODE', 'LLBot 模式必须是 direct 或 desktop');
  const port = Number(ctx.options?.pmhqPort ?? existing.pmhqPort ?? 0);
  if (mode === 'desktop' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw fail(400, 'PMHQ_PORT_REQUIRED', '桌面模式需要专属本机 PMHQ 端口');
  }
  const settings = { mode, pmhqPort: mode === 'desktop' ? port : null };
  if (ctx.options) writeJsonPrivate(file, settings, 0o600);
  return settings;
}

function configPath(ctx) {
  return path.join(ctx.paths.dir, 'data', `config_${ctx.account.expected_uin}.json`);
}

function webuiBase(ctx) {
  return `http://127.0.0.1:${ctx.account.webui_port}`;
}

function authHeaders(ctx) {
  return llbotWebuiHeaders(ctx.tokens.webuiPassword);
}

function writeAuthTokenFile(ctx) {
  const file = path.join(ctx.paths.dir, 'data', 'auth_token.txt');
  if (ctx.tokens.authToken) writeFilePrivate(file, ctx.tokens.authToken.trim(), 0o600);
  else {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

function fullConfig(ctx) {
  const token = ctx.tokens.onebotToken;
  return {
    webui: { enable: true, host: '127.0.0.1', port: Number(ctx.account.webui_port) },
    milky: {
      enable: false,
      reportSelfMessage: false,
      http: { host: '127.0.0.1', port: 0, prefix: '', accessToken: '' },
      webhook: { urls: [], accessToken: '' }
    },
    satori: { enable: false, host: '127.0.0.1', port: 0, token: '' },
    ob11: {
      enable: true,
      connect: [
        {
          type: 'ws',
          enable: true,
          host: '127.0.0.1',
          port: Number(ctx.account.ob11_port),
          heartInterval: 30_000,
          token,
          reportSelfMessage: false,
          reportOfflineMessage: false,
          messageFormat: 'array',
          debug: false
        },
        {
          type: 'ws-reverse',
          enable: false,
          url: '',
          heartInterval: 30_000,
          token,
          reportSelfMessage: false,
          reportOfflineMessage: false,
          messageFormat: 'array',
          debug: false
        },
        {
          type: 'http',
          enable: false,
          host: '127.0.0.1',
          port: 0,
          token,
          reportSelfMessage: false,
          reportOfflineMessage: false,
          messageFormat: 'array',
          debug: false
        },
        {
          type: 'http-post',
          enable: false,
          url: '',
          enableHeart: false,
          heartInterval: 30_000,
          token,
          reportSelfMessage: false,
          reportOfflineMessage: false,
          messageFormat: 'array',
          debug: false
        }
      ]
    },
    enableLocalFile2Url: false,
    log: true,
    logLevel: 'info',
    autoDeleteFile: false,
    autoDeleteFileSecond: 60,
    musicSignUrl: '',
    msgCacheExpire: 120,
    ffmpeg: ''
  };
}

export const llbotDriver = {
  id: 'llbot',
  label: 'LLBot (Direct)',
  capabilities: {
    qrcode: true,
    authToken: true,
    webui: true,
    onebotHttp: false,
    loginInfo: true,
    logout: true
  },

  async prepare(ctx) {
    if (!/^\d{5,12}$/.test(String(ctx.account.expected_uin || ''))) {
      throw fail(400, 'UIN_REQUIRED', 'LLBot 需要先填写要登录的 QQ 号（5-12 位数字）');
    }
    const dir = ctx.paths.dir;
    ensureDir(path.join(dir, 'data'), 0o700);
    ensureDir(path.join(dir, 'data', 'logs'), 0o700);
    const runtime = runtimeSettings(ctx);
    writeFilePrivate(path.join(dir, 'data', 'webui_token.txt'), ctx.tokens.webuiPassword, 0o600);
    writeJsonPrivate(configPath(ctx), fullConfig(ctx), 0o600);
    writeAuthTokenFile(ctx);
    return {
      runtime,
      configPath: configPath(ctx),
      webuiPort: Number(ctx.account.webui_port),
      ob11Port: Number(ctx.account.ob11_port),
      entryExists: fs.existsSync(ctx.config.llbotEntry),
      authTokenFile: path.join(dir, 'data', 'auth_token.txt')
    };
  },

  async launch(ctx) {
    if (!fs.existsSync(ctx.config.llbotEntry)) {
      throw fail(503, 'LLBOT_NOT_BUILT', 'LLBot 尚未构建（缺少 dist/llbot.js），请先运行 LLBot 构建');
    }
    const runtime = runtimeSettings(ctx);
    if (runtime.mode === 'desktop') {
      let health;
      try { health = await requestJson(`http://127.0.0.1:${runtime.pmhqPort}/health`, { timeoutMs: 2500 }); }
      catch { throw fail(503, 'PMHQ_UNAVAILABLE', '专属 PMHQ 未就绪：需要独立 QQ 和与该端口匹配的 PMHQ 注入发行组件；当前平台不包含启动器或注入器'); }
      if (health.status !== 200 || !health.body || typeof health.body !== 'object') throw fail(503, 'PMHQ_INVALID', 'PMHQ 健康接口响应无效');
      const actual = String(health.body?.qq_full_version || '').trim();
      const expected = String(ctx.config.llbotDesktopQqVersion || '').trim();
      if (!actual || !expected) throw fail(503, 'QQ_VERSION_UNKNOWN', 'PMHQ 或平台未提供 QQ 版本，无法确认兼容性');
      if (actual !== expected) throw fail(409, 'QQ_VERSION_MISMATCH', `QQ 版本 ${actual} 与要求 ${expected} 不一致`);
      const uin = String(health.body?.uin || '');
      if (uin && uin !== String(ctx.account.expected_uin)) throw fail(409, 'QQ_UIN_MISMATCH', 'PMHQ 登录账号与配置不一致');
    }
    return {
      command: ctx.config.nodePath,
      args: [ctx.config.llbotEntry, '-q', String(ctx.account.expected_uin), ...(runtime.mode === 'desktop' ? ['--pmhq-port', String(runtime.pmhqPort)] : [])],
      cwd: ctx.paths.dir,
      readyPort: Number(ctx.account.webui_port),
      readyHost: '127.0.0.1'
    };
  },

  async status(ctx) {
    const base = webuiBase(ctx);
    let loginInfo = null;
    let authToken = null;
    try {
      const info = await requestJson(`${base}/api/login-info`, { headers: authHeaders(ctx), timeoutMs: 2500 });
      if (info.body?.success) loginInfo = info.body.data || {};
      else if (info.status === 401) return { error: 'LLBot WebUI 密码校验失败', code: 'WEBUI_AUTH_FAILED' };
      else return { error: info.body?.message || `login-info HTTP ${info.status}`, code: 'LOGIN_INFO_FAILED' };
    } catch (error) {
      return { error: `无法连接 LLBot WebUI: ${error?.message || error}`, code: 'WEBUI_UNREACHABLE' };
    }
    try {
      const status = await requestJson(`${base}/api/auth-token/status`, { headers: authHeaders(ctx), timeoutMs: 2500 });
      if (status.body?.success) authToken = status.body.data || {};
    } catch { /* auth status is advisory */ }
    const online = Boolean(loginInfo?.online);
    const uin = loginInfo?.uin ? String(loginInfo.uin) : null;
    const expected = String(ctx.account.expected_uin || '');
    return {
      online,
      uin,
      nickname: loginInfo?.nick || null,
      uid: loginInfo?.uid || null,
      mode: loginInfo?.mode || 'direct',
      webui: loginInfo?.webui || { enable: true, host: '127.0.0.1', port: Number(ctx.account.webui_port) },
      authToken,
      uinMismatch: Boolean(online && uin && expected && uin !== expected)
    };
  },

  async qrcode(ctx) {
    const base = webuiBase(ctx);
    const auth = await this.authStatus(ctx);
    if (auth.applicable && (!auth.hasToken || ['invalid', 'error'].includes(auth.validation))) {
      throw fail(409, auth.hasToken ? 'AUTH_TOKEN_INVALID' : 'AUTH_TOKEN_REQUIRED',
        auth.hasToken ? 'LLBot Auth Token 无效，请更新后重试' : 'LLBot 需要 Auth Token 才能完成扫码登录，请先配置平台或租户 Token',
        { authToken: auth, helpUrl: auth.authTokenPageUrl || null });
    }
    if (auth.applicable && auth.validation === 'validating') {
      throw fail(409, 'AUTH_TOKEN_VALIDATING', 'LLBot 正在校验 Auth Token，请稍候再获取二维码', { authToken: auth });
    }
    let response;
    try {
      response = await requestJson(`${base}/api/login-qrcode`, { headers: authHeaders(ctx), timeoutMs: 12_000 });
    } catch (error) {
      throw fail(502, 'QRCODE_FETCH_FAILED', `获取二维码失败: ${error?.message || error}`);
    }
    const data = response.body?.data || response.body;
    if (!response.body?.success || !data?.qrcodeUrl) {
      throw fail(502, 'QRCODE_FETCH_FAILED', response.body?.message || `获取二维码失败 HTTP ${response.status}`);
    }
    const expireSeconds = Number(data.expireTime) || 60;
    return {
      state: 'ready',
      qrcodeUrl: data.qrcodeUrl,
      pngBase64: data.pngBase64QrcodeData || '',
      expireTime: expireSeconds,
      expireAt: Date.now() + expireSeconds * 1000,
      pollTimeInterval: Number(data.pollTimeInterval) || 3
    };
  },

  async authStatus(ctx) {
    if (['running', 'awaiting_login', 'auth_required', 'online'].includes(ctx.account.state)) {
      try {
        const response = await requestJson(`${webuiBase(ctx)}/api/auth-token/status`, {
          headers: authHeaders(ctx), timeoutMs: 2500
        });
        if (response.body?.success) return normalizeAuth(response.body.data, ctx);
      } catch { /* fall through to local state */ }
    }
    return normalizeAuth({
      applicable: runtimeSettings(ctx).mode !== 'desktop',
      hasToken: Boolean(ctx.tokens.authToken),
      validation: ctx.tokens.authToken ? 'idle' : 'idle',
      message: ctx.tokens.authToken ? '' : '尚未配置 Auth Token',
      loginError: ''
    }, ctx);
  },

  async setAuthToken(ctx, token) {
    writeAuthTokenFile(ctx);
    if (['running', 'awaiting_login', 'auth_required', 'online'].includes(ctx.account.state)) {
      if (!token) return { saved: true, restartRequired: true };
      try {
        const response = await requestJson(`${webuiBase(ctx)}/api/auth-token`, {
          method: 'POST',
          headers: authHeaders(ctx),
          body: { token },
          timeoutMs: 4000
        });
        if (!response.body?.success) {
          throw fail(502, 'AUTH_TOKEN_SAVE_FAILED', response.body?.message || `HTTP ${response.status}`);
        }
      } catch (error) {
        if (error.status) throw error;
        return { saved: true, restartRequired: true, warning: String(error?.message || error) };
      }
    }
    return { saved: true, restartRequired: false };
  }
};

function normalizeAuth(data, ctx) {
  return {
    applicable: data?.applicable !== false,
    hasToken: Boolean(data?.hasToken),
    validation: data?.validation || 'idle',
    message: data?.message || '',
    loginError: data?.loginError || '',
    online: Boolean(data?.online),
    source: ctx.tokens.authSource || 'none',
    authTokenPageUrl: data?.authTokenPageUrl || 'https://auth.luckylillia.com'
  };
}
