import crypto from 'node:crypto';

export function generateBuvid() {
  return `${crypto.randomBytes(16).toString('hex').toUpperCase()}infoc`;
}

/**
 * 匿名设备指纹。优先走 B 站 spi 接口；失败时本地生成并明确标记 source=fallback，
 * 避免因为一个非关键接口阻塞登录。
 */
export async function ensureBuvid({ api, jar, force = false, logger = null, now = Date.now } = {}) {
  if (!jar) throw new TypeError('ensureBuvid 需要 cookie jar');
  const existing3 = jar.get('buvid3');
  const existing4 = jar.get('buvid4');
  if (!force && existing3 && existing4) {
    return { buvid3: existing3, buvid4: existing4, source: 'cookie' };
  }
  let buvid3 = '';
  let buvid4 = '';
  let source = 'api';
  try {
    const payload = await api.request({
      method: 'GET',
      service: 'api',
      path: '/x/frontend/finger/spi',
      signed: false,
      allowedCodes: [0],
      retries: 1
    });
    buvid3 = String(payload?.data?.b_3 || '').trim();
    buvid4 = String(payload?.data?.b_4 || '').trim();
    if (!/^[0-9A-Za-z]{16,64}$/.test(buvid3) || !/^[0-9A-Za-z]{16,64}$/.test(buvid4)) {
      throw new Error('spi 返回的 buvid 格式无效');
    }
  } catch (error) {
    logger?.warn?.('获取 buvid 失败，使用本地生成值', error);
    buvid3 = generateBuvid();
    buvid4 = generateBuvid();
    source = 'fallback';
  }
  const expires = now + 365 * 24 * 60 * 60 * 1000;
  for (const [name, value] of [['buvid3', buvid3], ['buvid4', buvid4]]) {
    jar.set(name, value, { domain: 'bilibili.com', hostOnly: false, path: '/', secure: true, expires });
  }
  return { buvid3, buvid4, source };
}
