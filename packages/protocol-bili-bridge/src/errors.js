export class BridgeError extends Error {
  constructor(message, { kind = 'BRIDGE', code = 500, retcode = 100, retryable = false, wording = '', details = null, cause } = {}) {
    super(String(message ?? 'unknown error'));
    this.name = 'BridgeError';
    this.kind = kind;
    this.code = code;
    this.retcode = retcode;
    this.retryable = Boolean(retryable);
    this.wording = wording || String(message ?? '');
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export class ConfigError extends BridgeError {
  constructor(message, options = {}) {
    super(message, { kind: 'CONFIG', code: 500, retcode: 500, ...options });
    this.name = 'ConfigError';
  }
}

export class AuthRequiredError extends BridgeError {
  constructor(message = 'B 站账号未登录', options = {}) {
    super(message, { kind: 'AUTH', code: 401, retcode: 1401, wording: message, ...options });
    this.name = 'AuthRequiredError';
  }
}

export class BiliApiError extends BridgeError {
  constructor(message, { code = 0, apiCode = null, retcode = 200, kind = 'API', retryable = false, data = null, url = '', wording = '', cause = null } = {}) {
    super(message, { kind, code, retcode, retryable, details: data, wording, cause });
    this.name = 'BiliApiError';
    this.apiCode = apiCode;
    this.data = data;
    this.url = url;
  }
}

export class BiliRiskError extends BiliApiError {
  constructor(message, { challenge = null, ...options } = {}) {
    super(message, {
      kind: 'RISK',
      retcode: 403,
      retryable: false,
      wording: message || 'B 站触发人机验证，需要先在可信浏览器完成验证',
      ...options
    });
    this.name = 'BiliRiskError';
    this.challenge = challenge;
  }
}

export function asBridgeError(error, fallback = 'B 站桥接操作失败') {
  if (error instanceof BridgeError) return error;
  return new BridgeError(error?.message ? String(error.message) : fallback, {
    kind: 'INTERNAL',
    code: 500,
    retcode: 1500,
    cause: error
  });
}
