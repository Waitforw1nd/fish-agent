import { requestJson } from './common.js';

// 官方 QQ 机器人（QQ 开放平台）驱动：没有本地协议端进程，
// 租户 Agent（headless 核心）直连官方 WebSocket 网关。
// 云端只负责凭证校验、密钥托管与配置下发。
export const QQBOT_DRIVER_ID = 'qqbot';

export const qqbotDescriptor = Object.freeze({
  id: QQBOT_DRIVER_ID,
  label: '官方机器人（QQ 开放平台）',
  capabilities: Object.freeze({ qrcode: false, authToken: false, official: true, proactive: false })
});

export const QQBOT_SECRET_NAME = 'qq.qqbot.appSecret';
export const QQBOT_CONFIG_NAME = 'qq.qqbot.config';
export const QQBOT_DEFAULT_INTENTS = 1 << 25;   // 群 @ 消息 + C2C 私聊（含全量群消息）

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

export function normalizeQqbotInput({ appId, appSecret, sandbox, intents } = {}) {
  const id = String(appId ?? '').trim();
  if (!/^\d{6,20}$/.test(id)) throw fail(400, 'INVALID_QQBOT_APP_ID', 'AppID 必须是 6-20 位数字');
  const result = { appId: id, sandbox: sandbox === true };
  if (appSecret !== undefined && appSecret !== null && String(appSecret).trim() !== '') {
    const secret = String(appSecret).trim();
    if (secret.length < 8 || secret.length > 256 || /[\r\n]/.test(secret)) {
      throw fail(400, 'INVALID_QQBOT_APP_SECRET', 'AppSecret 格式不正确');
    }
    result.appSecret = secret;
  }
  if (intents !== undefined && intents !== null && intents !== '') {
    const value = Number(intents);
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
      throw fail(400, 'INVALID_QQBOT_INTENTS', 'intents 必须是 1 ~ 2^32-1 的整数');
    }
    result.intents = value;
  }
  return result;
}

/** 用 getAppAccessToken 实测凭证（顺带验证 IP 白名单），成功返回 { ok, expiresIn }。 */
export async function verifyQqbotCredentials({ appId, appSecret, tokenUrl, timeoutMs = 10000 }) {
  const url = String(tokenUrl || 'https://bots.qq.com/app/getAppAccessToken');
  let parsed;
  try { parsed = new URL(url); } catch { throw fail(500, 'QQBOT_TOKEN_URL_INVALID', '凭证校验地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
      || (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
    throw fail(400, 'QQBOT_TOKEN_URL_INVALID', '凭证校验地址必须是 HTTPS（本机地址除外）');
  }
  let response;
  try {
    response = await requestJson(url, { method: 'POST', body: { appId, clientSecret: appSecret }, timeoutMs });
  } catch {
    throw fail(502, 'QQBOT_VERIFY_UNREACHABLE', '无法连接 QQ 开放平台校验凭证，请检查网络与校验地址');
  }
  const data = response.body && typeof response.body === 'object' && !Array.isArray(response.body) ? response.body : {};
  const expiresIn = Number(data.expires_in);
  if (response.status === 200 && typeof data.access_token === 'string' && data.access_token.length > 0
      && data.access_token.length <= 8192 && Number.isFinite(expiresIn) && expiresIn > 0) return { ok: true, expiresIn };
  // Upstream error text is untrusted and may echo submitted credentials.
  const detail = /^\d{1,12}$/.test(String(data.code || '')) ? `code=${data.code}` : `HTTP ${response.status}`;
  throw fail(400, 'QQBOT_CREDENTIALS_INVALID', `官方平台拒绝了凭证：${detail}（请检查 AppID/AppSecret 是否正确、本机公网 IP 是否已加入机器人后台白名单）`);
}
