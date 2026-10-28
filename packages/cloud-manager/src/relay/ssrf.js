import dns from 'node:dns';
import net from 'node:net';

function validationError(message, code = 'INVALID_CUSTOM_UPSTREAM_URL') {
  return Object.assign(new Error(message), { status: 400, code });
}

function ipv4Bytes(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function inRange(bytes, base, prefix) {
  const target = ipv4Bytes(base);
  const whole = Math.floor(prefix / 8);
  for (let i = 0; i < whole; i += 1) if (bytes[i] !== target[i]) return false;
  const remainder = prefix % 8;
  if (!remainder) return true;
  const mask = 0xff << (8 - remainder);
  return (bytes[whole] & mask) === (target[whole] & mask);
}

const PRIVATE_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

export function isPublicIp(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const bytes = ipv4Bytes(value);
    return Boolean(bytes) && !PRIVATE_IPV4.some(([base, prefix]) => inRange(bytes, base, prefix));
  }
  if (family !== 6) return false;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const first = parseInt(canonical.split(':')[0], 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (/^2001:(?:0:|db8:|db8$)/.test(canonical) || canonical.startsWith('2002:')) return false;
  return true;
}

export function normalizeCustomUpstreamUrl(input, { allowPrivate = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048) throw validationError('自定义上游 Base URL 不能为空且不能超过 2048 字符');
  let url;
  try { url = new URL(raw); } catch { throw validationError('自定义上游 Base URL 不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw validationError('自定义上游只支持 http/https');
  if (!allowPrivate && url.protocol !== 'https:') throw validationError('自定义上游默认仅允许公网 HTTPS', 'CUSTOM_UPSTREAM_HTTPS_REQUIRED');
  if (url.username || url.password) throw validationError('自定义上游 URL 不能包含凭据');
  if (url.search || url.hash) throw validationError('自定义上游 URL 不能包含查询参数或片段');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(hostname) && !isPublicIp(hostname)) {
    throw validationError('自定义上游不能指向私网、环回或元数据地址', 'CUSTOM_UPSTREAM_PRIVATE_ADDRESS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

async function lookupAll(hostname, lookup) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses || []);
    });
  });
}

export async function resolveCustomUpstreamUrl(input, {
  allowPrivate = false,
  lookup = dns.lookup
} = {}) {
  const url = normalizeCustomUpstreamUrl(input, { allowPrivate });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try { addresses = await lookupAll(hostname, lookup); } catch {
      throw validationError('自定义上游域名解析失败', 'CUSTOM_UPSTREAM_DNS_FAILED');
    }
  }
  if (!addresses.length) throw validationError('自定义上游域名没有可用地址', 'CUSTOM_UPSTREAM_DNS_FAILED');
  if (!allowPrivate && addresses.some((entry) => !isPublicIp(entry.address))) {
    throw validationError('自定义上游解析到私网、环回或元数据地址', 'CUSTOM_UPSTREAM_PRIVATE_ADDRESS');
  }
  const pinnedLookup = (_hostname, options, callback) => {
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  return { url, addresses, lookup: pinnedLookup };
}
