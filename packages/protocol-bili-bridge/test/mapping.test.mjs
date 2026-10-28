import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from '../src/store/json-store.js';
import { VirtualIdMapper, VIRTUAL_ID_RANGES, BILI_VIRTUAL_ID_START, BILI_VIRTUAL_ID_END, isBiliVirtualId } from '../src/mapping/ids.js';
import { MessageRing } from '../src/store/ring.js';
import { PollState } from '../src/store/poll-state.js';
import { PollScheduler, LowFrequencyQueue } from '../src/pollers/scheduler.js';
import { tempDir, waitFor, sleep } from './support/helpers.mjs';

async function makeMapper({ dir = null, tenantId = 'tenant-a' } = {}) {
  const base = dir || await tempDir();
  const store = new JsonStore({
    dir: base,
    name: 'mapping.json',
    defaults: () => ({ version: 1, tenantId, groups: {}, users: {}, nativeGroups: {}, nativeUsers: {} })
  });
  const mapper = new VirtualIdMapper({ store, tenantId, now: () => Date.now() });
  await mapper.load();
  return { dir: base, store, mapper };
}

test('所有虚拟号段位于 ChannelRouter 的 [2^52, 2^53-1]', () => {
  assert.equal(BILI_VIRTUAL_ID_START, 2 ** 52);
  assert.equal(BILI_VIRTUAL_ID_END, Number.MAX_SAFE_INTEGER);
  const entries = Object.entries(VIRTUAL_ID_RANGES);
  for (const [kind, range] of entries) {
    assert.ok(range.base >= BILI_VIRTUAL_ID_START, `${kind} base`);
    assert.ok(range.base + range.size - 1 <= BILI_VIRTUAL_ID_END, `${kind} end`);
    assert.ok(isBiliVirtualId(range.base), `${kind} base isBili`);
    assert.ok(isBiliVirtualId(range.base + range.size - 1), `${kind} end isBili`);
  }
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1][1];
    const curr = entries[i][1];
    assert.ok(prev.base + prev.size <= curr.base, '号段不得重叠');
  }
});

test('虚拟视频/动态/直播群与用户 ID 可逆且全部为安全整数', async () => {
  const { mapper } = await makeMapper();
  const video = await mapper.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001', title: '标题' });
  assert.ok(Number.isSafeInteger(video.id));
  assert.ok(video.id >= BILI_VIRTUAL_ID_START && video.id <= BILI_VIRTUAL_ID_END);
  assert.ok(video.id >= VIRTUAL_ID_RANGES.video.base);
  assert.ok(video.id < VIRTUAL_ID_RANGES.video.base + VIRTUAL_ID_RANGES.video.size);
  assert.equal(video.native.bvid, 'BV1xx411c7mD');
  assert.equal(video.native.aid, '170001');
  assert.equal((await mapper.groupForVideo({ bvid: 'BV1xx411c7mD', aid: '170001' })).id, video.id);
  assert.equal((await mapper.groupForVideo({ aid: '170001' })).id, video.id);
  assert.equal(mapper.resolveGroup(String(video.id)).native.bvid, 'BV1xx411c7mD');
  assert.equal(mapper.resolveGroup(video.id + 2_000_000_000_000), null);

  const dynamic = await mapper.groupForDynamic({ dynamicId: '987654321098765432', title: '动态' });
  const live = await mapper.groupForLive({ roomId: '9001', title: '直播间' });
  assert.ok(Number.isSafeInteger(dynamic.id));
  assert.ok(Number.isSafeInteger(live.id));
  assert.notEqual(dynamic.id, live.id);

  const user = await mapper.userFor({ mid: '20002', name: '观众A' });
  assert.ok(Number.isSafeInteger(user.id));
  assert.ok(user.id >= BILI_VIRTUAL_ID_START && user.id <= BILI_VIRTUAL_ID_END);
  assert.equal((await mapper.userFor({ mid: '20002', name: '观众A改名' })).id, user.id);
  assert.equal(mapper.resolveUser(user.id).name, '观众A改名');

  const ids = new Set([video.id, dynamic.id, live.id, user.id]);
  for (let i = 0; i < 100; i += 1) {
    const record = await mapper.groupForVideo({ bvid: `BV1test${String(i).padStart(8, '0')}`, aid: String(500000 + i) });
    assert.ok(Number.isSafeInteger(record.id));
    assert.ok(record.id >= BILI_VIRTUAL_ID_START && record.id <= BILI_VIRTUAL_ID_END);
    assert.equal(ids.has(record.id), false);
    ids.add(record.id);
  }
});

test('虚拟 ID 映射重启可恢复，并拒绝跨租户读取', async () => {
  const first = await makeMapper({ tenantId: 'tenant-a' });
  const video = await first.mapper.groupForVideo({ bvid: 'BV1restart001', aid: '777001', title: '恢复' });
  const second = await makeMapper({ dir: first.dir, tenantId: 'tenant-a' });
  const restored = await second.mapper.groupForVideo({ bvid: 'BV1restart001', aid: '777001' });
  assert.equal(restored.id, video.id);
  assert.equal(second.mapper.resolveGroup(video.id).title, '恢复');

  const otherDir = await tempDir();
  await fs.copyFile(path.join(first.dir, 'mapping.json'), path.join(otherDir, 'mapping.json'));
  const otherStore = new JsonStore({
    dir: otherDir,
    name: 'mapping.json',
    defaults: () => ({ version: 1, tenantId: 'tenant-b', groups: {}, users: {}, nativeGroups: {}, nativeUsers: {} })
  });
  const other = new VirtualIdMapper({ store: otherStore, tenantId: 'tenant-b', now: () => Date.now() });
  await assert.rejects(() => other.load(), (error) => error.kind === 'TENANT');
});

test('MessageRing 使用安全整数、环形淘汰并跨重启恢复', async () => {
  const dir = await tempDir();
  const make = () => new MessageRing({
    store: new JsonStore({ dir, name: 'messages.json', defaults: () => ({ version: 1, counter: 0, messages: [] }) }),
    capacity: 10,
    now: () => 1_700_000_000_000
  });
  const ring = make();
  await ring.load();
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const record = await ring.add({ channel: 'test', groupId: 2 ** 52 + 100, userId: 2 ** 52 + 101, message: [{ type: 'text', data: { text: `m${i}` } }] });
    assert.ok(Number.isSafeInteger(record.message_id));
    assert.ok(record.message_id >= VIRTUAL_ID_RANGES.message.base);
    ids.push(record.message_id);
  }
  assert.equal(ring.stats().count, 10);
  assert.equal(ring.get(ids[0]), null);
  assert.equal(ring.get(ids[11]).message[0].data.text, 'm11');
  ring.assertSafe();

  const restarted = make();
  await restarted.load();
  assert.equal(restarted.get(ids[11]).message[0].data.text, 'm11');
  assert.deepEqual(restarted.stats().count, 10);
});

test('PollState 游标与去重跨重启保持，claimMany 只返回新 key', async () => {
  const dir = await tempDir();
  const make = () => new PollState({
    store: new JsonStore({ dir, name: 'poll-state.json', defaults: () => ({ version: 1, cursors: {}, seen: {} }) }),
    capacity: 100,
    now: () => Date.now()
  });
  const state = make();
  await state.load();
  assert.deepEqual(await state.claimMany('comment:BV1', ['1', '2']), ['1', '2']);
  assert.deepEqual(await state.claimMany('comment:BV1', ['2', '3']), ['3']);
  assert.equal(await state.claim('comment:BV1', '3'), false);
  await state.setCursor('comment:BV1', { initialized: true, lastRpid: '3' });
  assert.deepEqual(state.getCursor('comment:BV1'), { initialized: true, lastRpid: '3' });

  const restarted = make();
  await restarted.load();
  assert.equal(restarted.hasSeen('comment:BV1', '3'), true);
  assert.deepEqual(restarted.getCursor('comment:BV1'), { initialized: true, lastRpid: '3' });
  assert.deepEqual(await restarted.claimMany('comment:BV1', ['4']), ['4']);
});

test('JsonStore 原子更新串行且损坏文件拒绝覆盖', async () => {
  const dir = await tempDir();
  const store = new JsonStore({ dir, name: 'state.json', defaults: () => ({ n: 0 }) });
  await store.load();
  await Promise.all(Array.from({ length: 20 }, () => store.update((draft) => { draft.n += 1; })));
  assert.equal(store.data.n, 20);
  const check = new JsonStore({ dir, name: 'state.json', defaults: () => ({ n: 0 }) });
  await check.load();
  assert.equal(check.data.n, 20);

  await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
  const bad = new JsonStore({ dir, name: 'bad.json', defaults: () => ({ ok: true }) });
  await assert.rejects(() => bad.load(), (error) => error.kind === 'STORAGE');
  assert.equal(await fs.readFile(path.join(dir, 'bad.json'), 'utf8'), '{not json');
});

test('低频队列串行且强制最小间隔，失败不阻断后续', async () => {
  const queue = new LowFrequencyQueue({ name: 'q', minIntervalMs: 40, jitterMs: 0 });
  const starts = [];
  const first = queue.enqueue(async () => { starts.push(Date.now()); return 'a'; });
  const second = queue.enqueue(async () => { starts.push(Date.now()); return 'b'; });
  const third = queue.enqueue(async () => { starts.push(Date.now()); return 'c'; });
  assert.deepEqual(await Promise.all([first, second, third]), ['a', 'b', 'c']);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 30, `间隔过短: ${starts[1] - starts[0]}`);
  assert.ok(starts[2] - starts[1] >= 30, `间隔过短: ${starts[2] - starts[1]}`);

  await assert.rejects(() => queue.enqueue(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await queue.enqueue(async () => 'after'), 'after');
  assert.ok(queue.stats().failures >= 1);
});

test('PollScheduler 周期执行、失败退避与 stop', async () => {
  const scheduler = new PollScheduler({ random: () => 0, now: () => Date.now() });
  let runs = 0;
  let failures = 0;
  scheduler.register({
    name: 'ok',
    intervalMs: 25,
    jitterMs: 0,
    run: async () => { runs += 1; }
  });
  scheduler.register({
    name: 'bad',
    intervalMs: 20,
    jitterMs: 0,
    maxBackoffMs: 60,
    run: async () => { failures += 1; throw new Error('expected'); }
  });
  scheduler.start();
  await waitFor(() => runs >= 2 && failures >= 1, { timeout: 2000, label: 'scheduler runs' });
  await scheduler.stop();
  const stats = scheduler.stats();
  assert.ok(stats.ok.runs >= 2);
  assert.ok(stats.bad.failures >= 1);
  assert.ok(stats.bad.lastError.includes('expected'));
  await sleep(70);
  const after = scheduler.stats();
  assert.equal(after.ok.runs, stats.ok.runs);
});
