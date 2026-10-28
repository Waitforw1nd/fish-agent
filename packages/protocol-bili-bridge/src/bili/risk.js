import { BridgeError } from '../errors.js';
import { redactSecrets } from '../util.js';

/**
 * B 站风控（v_voucher/gaia）检测。这里只做“识别 + 换取验证挑战 + 明确失败”，
 * 不尝试绕过人机验证：拿到 geetest 后必须由管理员在可信环境完成。
 */
export class RiskGuard {
  constructor({ now = Date.now, logger = null, blockTtlMs = 10 * 60 * 1000 } = {}) {
    this.now = now;
    this.logger = logger;
    this.blockTtlMs = blockTtlMs;
    this.api = null;
    this.voucher = '';
    this.blockedAt = 0;
    this.type = '';
    this.token = '';
    this.exchanges = 0;
    this.lastCode = null;
    this.exchangeError = '';
  }

  setApi(api) { this.api = api; }

  /** 从任意 API 响应中提取风控信息；返回是否命中。 */
  capture(payload, { code = null, url = '' } = {}) {
    const voucher = payload?.data?.v_voucher || payload?.v_voucher || '';
    const riskCode = code ?? payload?.code;
    if (voucher) this.voucher = String(voucher);
    const hit = Boolean(voucher) || riskCode === -352 || riskCode === -412;
    if (!hit) return false;
    this.blockedAt = this.now();
    this.lastCode = riskCode;
    this.logger?.warn?.('B 站接口触发风控', { code: riskCode, url, hasVoucher: Boolean(voucher) });
    return true;
  }

  get blocked() {
    if (!this.blockedAt) return false;
    if (this.now() - this.blockedAt > this.blockTtlMs) {
      this.blockedAt = 0;
      return false;
    }
    return true;
  }

  /**
   * 用 v_voucher 换取 gaia challenge。成功后保留 type/token（不对外），
   * 用于管理面板提示“需要人机验证”。失败不抛出，避免掩盖原始 API 错误。
   */
  async exchange({ csrf = '' } = {}) {
    if (!this.api || !this.voucher) return null;
    this.blockedAt = this.now();
    if (this.type) return { type: this.type, token: this.token };
    try {
      const payload = await this.api.request({
        method: 'POST',
        service: 'api',
        path: '/x/gaia-vgate/v1/register',
        form: { v_voucher: this.voucher, csrf },
        signed: false,
        allowedCodes: [0],
        retries: 0,
        skipRisk: true
      });
      this.exchanges += 1;
      this.type = String(payload?.data?.type ?? payload?.data?.geetest?.type ?? 'unknown');
      this.token = String(payload?.data?.token ?? '');
      this.exchangeError = '';
      return { type: this.type, token: this.token };
    } catch (error) {
      this.exchangeError = String(error?.message ?? error);
      this.logger?.warn?.('换取 gaia 验证挑战失败', error);
      return null;
    }
  }

  challenge() {
    return {
      blocked: this.blocked,
      type: this.type || null,
      hasToken: Boolean(this.token),
      at: this.blockedAt || null
    };
  }

  /** 管理员完成验证后调用；不会伪造成功，只是允许下一次请求重试。 */
  clear() {
    this.blockedAt = 0;
    this.voucher = '';
    this.type = '';
    this.token = '';
    this.exchangeError = '';
    return true;
  }

  snapshot() {
    return redactSecrets({
      blocked: this.blocked,
      code: this.lastCode,
      type: this.type || null,
      exchanges: this.exchanges,
      since: this.blockedAt || null,
      exchangeError: this.exchangeError || null
    });
  }

  assertNotBlocked() {
    if (!this.blocked) return;
    throw new BridgeError('B 站风控尚未解除，需要先在可信浏览器完成人机验证', {
      kind: 'RISK',
      code: 403,
      retcode: 1403,
      wording: 'B 站触发人机验证，请先在可信浏览器完成验证，然后调用管理 API 清除风控状态',
      details: this.challenge()
    });
  }
}
