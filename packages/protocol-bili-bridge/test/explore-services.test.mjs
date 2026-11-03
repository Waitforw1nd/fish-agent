import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createExploreServices } from '../src/explore-services.js';

test('explore transport rejects redirects and incomplete ACKs without reflecting secrets', async t => {
  let mode = 'redirect', redirected = 0;
  const events = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirected') { redirected++; res.end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.events) events.push(body.events[0]);
    if (mode === 'redirect') { res.writeHead(307, { location: '/redirected' }); res.end(); }
    else if (mode === 'invalid-json') res.end('PRIVATE_FIXTURE');
    else if (mode === 'incomplete') res.end('{"ok":true}');
    else if (mode === 'partial') res.end('{"accepted":0,"duplicates":0}');
    else if (mode === 'oversize') res.end(JSON.stringify({ text: 'x'.repeat(70 * 1024) }));
    else res.end('{"accepted":0,"duplicates":1}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { BILI_EXPLORE_AGENT_URL: `${base}/api/internal/bili-explore`, BILI_EXPLORE_AGENT_TOKEN: 'PRIVATE_FIXTURE',
    BILI_EXPLORE_METER_URL: `${base}/v1/fish/meter-events`, BILI_EXPLORE_RELAY_KEY: 'PRIVATE_FIXTURE' };
  const { exploreMeter, exploreGenerate } = createExploreServices(env);
  const event = { idempotencyKey: 'visit-fixture', meter: 'bili.video.browsed', quantity: 1, unit: 'count', occurredAt: Date.now() };
  const safeError = error => { assert.doesNotMatch(String(error.stack), /PRIVATE_FIXTURE/); return true; };
  await assert.rejects(exploreGenerate({ mode: 'summary' }), safeError);
  for (const value of ['redirect', 'invalid-json', 'incomplete', 'partial']) {
    mode = value; await assert.rejects(exploreMeter(event), safeError);
  }
  mode = 'oversize'; await assert.rejects(exploreGenerate({ mode: 'summary' }), /response too large/);
  mode = 'accepted'; assert.deepEqual(await exploreMeter(event), { accepted: 0, duplicates: 1 });
  assert.equal(redirected, 0); assert.equal(events.length, 5);
  assert.ok(events.every(e => JSON.stringify(e) === JSON.stringify(events[0])));
  assert.equal(createExploreServices({ ...env, BILI_EXPLORE_AGENT_URL: 'https://example.invalid/api/internal/bili-explore' }).exploreGenerate, null);
});

test('explore response budget accepts the boundary and cancels oversized streams', async () => {
  const env = { BILI_EXPLORE_AGENT_URL: 'http://127.0.0.1:12345/api/internal/bili-explore', BILI_EXPLORE_AGENT_TOKEN: 'fixture' };
  const payload = JSON.stringify({ text: 'x'.repeat(64 * 1024 - 11) });
  assert.equal(Buffer.byteLength(payload), 64 * 1024);
  const atLimit = createExploreServices(env, { fetchImpl: async () => new Response(payload) });
  assert.equal((await atLimit.exploreGenerate({ mode: 'summary' })).text.length, 64 * 1024 - 11);
  let cancelled = false, pulls = 0;
  const oversize = createExploreServices(env, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(16 * 1024)); },
    cancel() { cancelled = true; }
  })) });
  await assert.rejects(oversize.exploreGenerate({ mode: 'summary' }), /response too large/);
  assert.equal(cancelled, true, 'upstream must be cancelled at the byte limit');
  assert.ok(pulls <= 6, 'must not buffer an unbounded response');
});
