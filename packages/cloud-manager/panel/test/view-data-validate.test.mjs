import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apiErrorMessage,
  dayLabel,
  filterBillingDays,
  localDayKey,
  loginErrorMessage,
  qrCountdown,
  resolveSubscriptions,
  subscriptionLabel,
  summarizeRange,
  tenantSummary
} from '../lib/view-data.js';
import {
  suggestSlug,
  validateLoginInput,
  validateRelayInput,
  validateTenantInput,
  validateUin
} from '../lib/validate.js';
import { ApiError } from '../lib/api.js';

test('tenantSummary 统计运行、即将到期与已到期', () => {
  const summary = tenantSummary([
    { status: 'running', expiry: { state: 'ok' } },
    { status: 'starting', expiry: { state: 'soon' } },
    { status: 'stopped', expiry: { state: 'expired' } },
    { status: 'stopped', expiry: { state: 'none' } }
  ]);
  assert.deepEqual(summary, { total: 4, running: 2, expiring: 1, expired: 1 });
});

test('resolveSubscriptions 让配置中的已知项覆盖状态值', () => {
  const resolved = resolveSubscriptions(
    { available: true, known: { mentions: true, liveRooms: true }, subscriptions: { mentions: false, liveRooms: true } },
    { subscriptions: { mentions: true, upVideos: true, privateMessages: true, liveRooms: false } }
  );
  assert.deepEqual(resolved, { mentions: false, upVideos: true, privateMessages: true, liveRooms: true });
  assert.equal(subscriptionLabel('upVideos'), 'UP 新视频');
});

test('filterBillingDays 区间过滤与 dayLabel', () => {
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const days = [
    { date: '2026-10-28', totals: {} },
    { date: '2026-10-27', totals: {} },
    { date: '2026-10-20', totals: {} },
    { date: '2026-09-01', totals: {} },
    { date: '', totals: {} }
  ];
  assert.deepEqual(filterBillingDays(days, '7', now).map((day) => day.date), ['2026-10-28', '2026-10-27']);
  assert.deepEqual(filterBillingDays(days, '30', now).map((day) => day.date), ['2026-10-28', '2026-10-27', '2026-10-20']);
  assert.equal(filterBillingDays(days, 'all', now).length, 5);
  assert.equal(localDayKey(now), '2026-10-28');
  assert.equal(dayLabel('2026-10-28', now), '今天');
  assert.equal(dayLabel('2026-10-27', now), '昨天');
  assert.equal(dayLabel('2026-10-20', now), '10 月 20 日');
  assert.equal(dayLabel('', now), '累计汇总');
});

test('qrCountdown 与错误文案', () => {
  const now = Date.parse('2026-10-28T08:00:00Z');
  assert.equal(qrCountdown(null, now).hasExpiry, false);
  assert.equal(qrCountdown(new Date(now + 65_000).toISOString(), now).text, '01:05 后过期');
  assert.equal(qrCountdown(new Date(now - 1).toISOString(), now).expired, true);
  assert.match(apiErrorMessage(new ApiError(0, 'network_error', 'x')), /无法连接/);
  assert.match(apiErrorMessage(new ApiError(402, 'subscription_expired', 'x')), /到期/);
  assert.match(apiErrorMessage(new ApiError(403, 'forbidden', 'x')), /权限/);
  assert.match(apiErrorMessage(new ApiError(429, 'rate_limit', 'x')), /频繁/);
  assert.match(apiErrorMessage(new ApiError(500, 'server_error', 'x')), /暂时不可用/);
  assert.match(apiErrorMessage(new ApiError(400, 'bad', 'token=secret123')), /token=••••/);
  assert.match(loginErrorMessage(new ApiError(401, 'bad_credentials', 'x')), /用户名或密码不正确/);
  assert.match(loginErrorMessage(new ApiError(0, 'network_error', 'x')), /无法连接/);
  assert.match(loginErrorMessage(new ApiError(429, 'rate_limit', 'x')), /次数过多/);
});

test('QQ 号校验为 5-12 位数字', () => {
  assert.equal(validateUin('10001').ok, true);
  assert.equal(validateUin(' 10001 ').value, '10001');
  assert.equal(validateUin('12345').ok, true);
  assert.equal(validateUin('123456789012').ok, true);
  assert.equal(validateUin('1234').ok, false);
  assert.equal(validateUin('1234567890123').ok, false);
  assert.equal(validateUin('1234a').ok, false);
  assert.equal(validateUin('').ok, false);
  assert.match(validateUin('abc').error, /5-12 位数字/);
});

test('登录与租户表单校验', () => {
  assert.equal(validateLoginInput({}), '请输入用户名');
  assert.equal(validateLoginInput({ username: 'a' }), '请输入密码');
  assert.equal(validateLoginInput({ username: 'a', password: 'b' }), null);
  assert.equal(validateLoginInput({ username: 'x'.repeat(129), password: 'b' }), '用户名过长');

  const valid = validateTenantInput({ name: '  My  Bot ', slug: 'MY-BOT' });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.values, { name: 'My Bot', slug: 'my-bot' });
  assert.equal(validateTenantInput({ name: '' }).ok, false);
  assert.equal(validateTenantInput({ name: 'x' }).ok, true);
  assert.equal(validateTenantInput({ name: 'x'.repeat(81) }).ok, false);
  assert.equal(validateTenantInput({ name: 'ok', slug: 'a' }).ok, false);
  assert.equal(validateTenantInput({ name: 'ok', slug: 'bad_slug' }).ok, false);
  assert.equal(validateTenantInput({ name: 'ok', slug: 'api' }).ok, false);
  assert.equal(validateTenantInput({ name: 'ok', slug: 'a'.repeat(33) }).ok, false);
  assert.equal(suggestSlug('My Fish Bot!'), 'my-fish-bot');
  assert.equal(suggestSlug('小鱼bot'), 'bot');
  assert.equal(suggestSlug('---'), '');
});

test('Relay Key 表单校验与 payload', () => {
  assert.equal(validateRelayInput({}, { configured: false }).ok, false);
  assert.equal(validateRelayInput({ key: 'short' }, { configured: false }).error, 'Relay Key 至少 6 个字符');
  assert.equal(validateRelayInput({ key: 'valid-key' }, { configured: false }).ok, true);
  assert.deepEqual(validateRelayInput({ key: ' valid-key ', model: ' m ' }, { configured: false }).payload, {
    key: 'valid-key',
    model: 'm'
  });
  assert.equal(validateRelayInput({}, { configured: true }).ok, false);
  assert.deepEqual(validateRelayInput({ model: 'm' }, { configured: false }).payload, { model: 'm' });
  assert.deepEqual(validateRelayInput({ model: 'm' }, { configured: true }).payload, { model: 'm' });
  assert.equal(validateRelayInput({ key: 'has space' }, { configured: false }).ok, false);
});

test('summarizeRange 汇总已筛选日数据', () => {
  const totals = summarizeRange([
    { totals: { requests: 1, promptTokens: 10, completionTokens: 5, cachedTokens: 2, visionTokens: 1, totalTokens: 16, costMicros: 100, available: true } },
    { totals: { requests: 2, promptTokens: 20, completionTokens: 10, cachedTokens: 4, visionTokens: 0, totalTokens: 30, costMicros: 200, available: true } }
  ]);
  assert.equal(totals.requests, 3);
  assert.equal(totals.totalTokens, 46);
  assert.equal(totals.costMicros, 300);
  assert.equal(totals.available, true);
});
