import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliContextCache } from '../src/bili-context.js';

const chatId = 2 ** 52 + 1;
const args = { kind: 'group', chatId, triggerEntries: [] };

test('video context is fetched on wake, cached, bounded and keeps missing subtitle status', async () => {
  let calls = 0; let now = 0;
  const context = new BiliContextCache({ now: () => now, ttlMs: 10 });
  const onebot = { platformFor: () => 'bili', call: async (action, params) => { calls++; assert.equal(action, 'bili_get_video_context'); assert.equal(params.group_id, chatId); return { title: 't', desc: 'x'.repeat(8000), subtitle: { available: false, reason: 'NO_SUBTITLE' } }; } };
  assert.equal(await context.forWake({ ...args, kind: 'private', onebot }), '');
  let text = await context.forWake({ ...args, onebot });
  assert.ok(text.length < 4100);
  assert.equal(calls, 1);
  await context.forWake({ ...args, onebot });
  assert.equal(calls, 1);
  now = 11;
  await context.forWake({ ...args, onebot });
  assert.equal(calls, 2);
  const missing = new BiliContextCache();
  text = await missing.forWake({ ...args, onebot: { ...onebot, call: async () => ({ subtitle: { available: false, reason: 'NO_SUBTITLE' } }) } });
  assert.match(text, /NO_SUBTITLE/);
});

test('failure and timeout degrade without caching failure', async () => {
  let calls = 0;
  const cache = new BiliContextCache({ timeoutMs: 15 });
  const onebot = { platformFor: () => 'bili', call: async () => { calls++; if (calls === 1) throw new Error('failed'); if (calls === 2) return new Promise(() => {}); return { title: 'ok' }; } };
  assert.match(await cache.forWake({ ...args, onebot }), /不可用.*failed/);
  assert.match(await cache.forWake({ ...args, onebot }), /不可用.*超时/);
  assert.match(await cache.forWake({ ...args, onebot }), /"title":"ok"/);
  assert.equal(calls, 3);
});
