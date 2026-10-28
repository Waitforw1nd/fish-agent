import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRoute, routeToHash, routeTitle, tenantHash } from '../lib/router.js';
import { createPoller } from '../lib/polling.js';
import { createFakeTimers } from './helpers/fake-timers.mjs';

test('哈希路由解析、编码与回退', () => {
  assert.deepEqual(parseRoute(''), { name: 'tenants', path: '#/tenants' });
  assert.deepEqual(parseRoute('#/'), { name: 'tenants', path: '#/tenants' });
  assert.equal(parseRoute('#/login').name, 'login');
  assert.equal(parseRoute('#/tenants').name, 'tenants');
  assert.equal(parseRoute('#/tenants/t1').name, 'hosting');
  assert.equal(parseRoute('#/tenants/t1').tenantId, 't1');
  assert.equal(parseRoute('#/tenants/t1/relay').name, 'relay');
  assert.equal(parseRoute('#/tenants/t%201/relay').tenantId, 't 1');
  assert.equal(parseRoute('#/tenants/t1/weird').name, 'notFound');
  assert.equal(parseRoute('#/nope').name, 'notFound');
  assert.equal(routeToHash({ name: 'hosting', tenantId: 'a/b' }), '#/tenants/a%2Fb/hosting');
  assert.equal(routeToHash({ name: 'relay', tenantId: 'a/b' }), '#/tenants/a%2Fb/relay');
  assert.equal(routeToHash({ name: 'tenants' }), '#/tenants');
  assert.equal(routeToHash({ name: 'hosting' }), '#/tenants');
  assert.equal(tenantHash('id', 'relay'), '#/tenants/id/relay');
  assert.equal(tenantHash('id'), '#/tenants/id/hosting');
  assert.equal(routeTitle({ name: 'hosting' }, '小鱼'), '小鱼');
  assert.equal(routeTitle({ name: 'relay' }, '小鱼'), '小鱼 · Relay');
  assert.equal(routeTitle({ name: 'tenants' }), '租户总览');
});

test('轮询器立即执行、按间隔重复、stop 后停止', async () => {
  const timers = createFakeTimers();
  let calls = 0;
  const poller = createPoller({
    task: async () => { calls += 1; },
    intervalMs: 1000,
    immediate: true,
    timers,
    visibility: { isHidden: () => false, subscribe: () => () => {} }
  });
  poller.start();
  assert.equal(calls, 0);
  await timers.tick(0);
  assert.equal(calls, 1);
  await timers.tick(999);
  assert.equal(calls, 1);
  await timers.tick(1);
  assert.equal(calls, 2);
  poller.stop();
  await timers.tick(5000);
  assert.equal(calls, 2);
  assert.equal(poller.isRunning(), false);
});

test('轮询器错误指数退避并在成功后复位', async () => {
  const timers = createFakeTimers();
  let calls = 0;
  let failures = 0;
  const intervals = [];
  const poller = createPoller({
    task: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    },
    intervalMs: 1000,
    maxIntervalMs: 5000,
    immediate: true,
    timers,
    visibility: { isHidden: () => false, subscribe: () => () => {} },
    onError: () => { failures += 1; intervals.push(poller.getInterval()); }
  });
  poller.start();
  await timers.tick(0);
  assert.equal(calls, 1);
  assert.equal(failures, 1);
  assert.equal(poller.getInterval(), 2000);
  await timers.tick(1999);
  assert.equal(calls, 1);
  await timers.tick(1);
  assert.equal(calls, 2);
  assert.equal(poller.getInterval(), 1000);
  poller.stop();
});

test('轮询器在页面隐藏时暂停，恢复可见立即补拉', async () => {
  const timers = createFakeTimers();
  let hidden = true;
  let listener = null;
  let calls = 0;
  const poller = createPoller({
    task: async () => { calls += 1; },
    intervalMs: 1000,
    immediate: true,
    timers,
    visibility: {
      isHidden: () => hidden,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      }
    }
  });
  poller.start();
  await timers.tick(0);
  assert.equal(calls, 0);
  hidden = false;
  listener();
  await timers.tick(0);
  assert.equal(calls, 1);
  hidden = true;
  listener();
  await timers.tick(5000);
  assert.equal(calls, 1);
  hidden = false;
  listener();
  await timers.tick(0);
  assert.equal(calls, 2);
  poller.stop();
  assert.equal(listener, null);
});

test('refreshNow 可主动刷新，飞行中会合并为下一轮', async () => {
  const timers = createFakeTimers();
  let calls = 0;
  let release = null;
  const poller = createPoller({
    task: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => { release = resolve; });
      }
    },
    intervalMs: 10_000,
    immediate: false,
    timers,
    visibility: { isHidden: () => false, subscribe: () => () => {} }
  });
  poller.start();
  const first = poller.refreshNow();
  assert.equal(calls, 1);
  await poller.refreshNow();
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  await timers.tick(0);
  assert.equal(calls, 2);
  poller.stop();
});
