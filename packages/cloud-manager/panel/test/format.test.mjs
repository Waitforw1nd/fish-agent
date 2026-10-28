import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expiryInfo,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMicros,
  formatPercent,
  formatTokens,
  maskSecret,
  parseDate,
  percentRatio,
  redactText,
  safeImageSrc,
  safeLink,
  statusTone
} from '../lib/format.js';

test('maskSecret 不泄露长秘密，保留可辨识尾部', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short'), '••••••');
  const masked = maskSecret('sk-1234567890abcdef');
  assert.match(masked, /^sk-/);
  assert.match(masked, /cdef$/);
  assert.ok(!masked.includes('1234567890ab'));
  assert.ok(masked.length < 'sk-1234567890abcdef'.length);
  assert.equal(maskSecret('••••••••'), '••••••••');
});

test('redactText 清除常见 token / cookie / Bearer', () => {
  const text = 'authToken=supersecret123 SESSDATA=cookie-value; bili_jct=csrf-value Authorization: Bearer abcdefghijklmnop';
  const safe = redactText(text);
  assert.ok(!safe.includes('supersecret123'));
  assert.ok(!safe.includes('cookie-value'));
  assert.ok(!safe.includes('csrf-value'));
  assert.ok(!safe.includes('abcdefghijklmnop'));
  assert.match(safe, /authToken=••••/);
  assert.match(safe, /Bearer ••••/);
  const key = redactText('upstream sk-1234567890abcdef failed');
  assert.ok(!key.includes('sk-1234567890abcdef'));
  assert.match(key, /sk-••••••cdef/);
});

test('formatMicros 使用整数微元，极小金额不显示为 0', () => {
  assert.equal(formatMicros(0), '¥0.00');
  assert.equal(formatMicros(1_000_000), '¥1.00');
  assert.equal(formatMicros(1_234_567), '¥1.2345');
  assert.equal(formatMicros(12_000), '¥0.012');
  assert.equal(formatMicros(500), '¥0.0005');
  assert.equal(formatMicros(1), '<¥0.0001');
  assert.equal(formatMicros(-1_000_000), '-¥1.00');
  assert.equal(formatMicros(1_500_000, 'USD'), '$1.50');
  assert.equal(formatMicros(null), '—');
});

test('Token / 百分比 / 时长格式化', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(12_345), '12.3K');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatTokens(2_000_000_000), '2B');
  assert.equal(formatTokens(1234, { compact: false }), '1,234');
  assert.equal(formatTokens('bad'), '—');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.876, 1), '87.6%');
  assert.equal(formatPercent(2), '100%');
  assert.equal(percentRatio(5, 10), 0.5);
  assert.equal(percentRatio(5, 0), 0);
  assert.equal(formatDuration(90_000), '1 分 30 秒');
  assert.equal(formatDuration(3 * 3_600_000 + 12 * 60_000), '3 小时 12 分');
  assert.equal(formatCountdown(65_000), '01:05');
  assert.equal(formatCountdown(-1), '00:00');
});

test('到期状态与日期解析', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  assert.equal(expiryInfo(null, now).state, 'none');
  assert.equal(expiryInfo('2026-10-27T23:00:00Z', now).state, 'expired');
  assert.deepEqual(expiryInfo('2026-10-31T00:00:00Z', now).state, 'soon');
  assert.equal(expiryInfo('2026-10-31T00:00:00Z', now).days, 3);
  assert.equal(expiryInfo('2026-11-20T00:00:00Z', now).state, 'ok');
  assert.equal(parseDate('2026-10-28').getDate(), 28);
  assert.equal(parseDate('not-a-date'), null);
  assert.ok(parseDate(1_700_000_000) instanceof Date);
  assert.notEqual(formatDate('2026-10-28', { timeZone: 'UTC' }), '—');
  assert.notEqual(formatDateTime('2026-10-28T10:20:30Z', { timeZone: 'UTC' }), '—');
});

test('safeImageSrc 阻断 javascript / 外部 http 二维码', () => {
  const data = `data:image/png;base64,${'A'.repeat(80)}`;
  assert.equal(safeImageSrc(data), data);
  assert.equal(safeImageSrc('javascript:alert(1)'), null);
  assert.equal(safeImageSrc('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(safeImageSrc('https://example.com/qr.png'), 'https://example.com/qr.png');
  assert.equal(safeImageSrc('/qr.png'), '/qr.png');
  assert.equal(safeImageSrc('//evil.example/qr.png'), null);
  assert.equal(safeImageSrc('http://other.example/qr.png', { origin: 'https://cloud.example' }), null);
  assert.equal(safeImageSrc('http://cloud.example/qr.png', { origin: 'http://cloud.example' }), 'http://cloud.example/qr.png');
  const base64 = 'A'.repeat(96);
  assert.equal(safeImageSrc(base64), `data:image/png;base64,${base64}`);
  assert.equal(safeLink('https://example.com'), 'https://example.com');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(statusTone('online'), 'ok');
  assert.equal(statusTone('expired'), 'danger');
  assert.equal(statusTone('waiting_login'), 'warn');
});
