import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeQuery,
  encodeComponent,
  redactSecrets,
  redactText,
  truncateChars,
  truncateUtf8Bytes,
  toSafeNumber,
  toBigInt,
  byteLength
} from '../src/util.js';

test('query 编码遵循 RFC3986 并排序', () => {
  assert.equal(encodeComponent("a!'()*"), 'a%21%27%28%29%2A');
  assert.equal(encodeQuery({ b: '2', a: '1', skip: null }), 'a=1&b=2');
});

test('安全整数/大整数转换', () => {
  assert.equal(toSafeNumber('9007199254740991'), 9007199254740991);
  assert.equal(toSafeNumber('9007199254740992'), null);
  assert.equal(toBigInt('1890000000000000001'), 1890000000000000001n);
  assert.equal(toBigInt('1.5'), null);
});

test('日志脱敏覆盖 Cookie/令牌/二维码 key', () => {
  const text = redactText('SESSDATA=abc%2C123&bili_jct=jct-secret&qrcode_key=qr-secret Bearer token-secret');
  for (const secret of ['abc%2C123', 'jct-secret', 'qr-secret', 'token-secret']) {
    assert.equal(text.includes(secret), false, `未脱敏: ${secret}`);
  }
  const object = redactSecrets({
    SESSDATA: 'sess',
    bili_jct: 'jct',
    refreshToken: 'refresh',
    qrcodeKey: 'qr',
    nested: { token: 'token', safe: 'ok' }
  });
  assert.equal(object.SESSDATA, '[redacted]');
  assert.equal(object.bili_jct, '[redacted]');
  assert.equal(object.refreshToken, '[redacted]');
  assert.equal(object.qrcodeKey, '[redacted]');
  assert.equal(object.nested.token, '[redacted]');
  assert.equal(object.nested.safe, 'ok');
});

test('字符/字节截断不会切坏 UTF-8', () => {
  assert.equal(truncateChars('一二三四五', 4), '一二三…');
  const bytes = truncateUtf8Bytes('一二三四五', 7); // 一=3B, 二=3B, 省略号=3B => 一 + …
  assert.equal(bytes, '一…');
  assert.equal(byteLength(bytes) <= 7, true);
  assert.equal(truncateUtf8Bytes('abc', 10), 'abc');
});
