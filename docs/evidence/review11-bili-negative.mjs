// Run from the repository root. REVIEW_OLD_VIDEO=1 removes the new notification
// in memory and must fail. All platform responses are local in-memory fixtures.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ExploreWatcher } from '../../packages/protocol-bili-bridge/src/pollers/explore.js';
import { BiliApi } from '../../packages/protocol-bili-bridge/src/bili/api.js';
import { CookieJar } from '../../packages/protocol-bili-bridge/src/bili/cookie-jar.js';

const file = path.resolve('packages/protocol-bili-bridge/src/bili/video.js');
let source = await readFile(file, 'utf8');
source = source.replace("from '../errors.js'", `from '${pathToFileURL(path.resolve('packages/protocol-bili-bridge/src/errors.js')).href}'`)
  .replace("from '../util.js'", `from '${pathToFileURL(path.resolve('packages/protocol-bili-bridge/src/util.js')).href}'`);
if (process.env.REVIEW_OLD_VIDEO === '1') {
  assert.ok(source.includes('    onView?.();'));
  source = source.replace('    onView?.();', '');
}
const { VideoService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const dir = await mkdtemp(path.join(os.tmpdir(), 'review11-bili-negative-'));
try {
  const api = new BiliApi({ jar: new CookieJar(), signer: { sign: async params => params }, fetchImpl: async url => {
    if (new URL(url).pathname === '/x/web-interface/view') return Response.json({ code: 0, data: { bvid: 'BV1234567890', aid: 1, pages: [{ cid: 2 }] } });
    return Response.json({ code: -404 });
  } });
  const watcher = new ExploreWatcher({ dir, risk: { blocked: false }, video: new VideoService({ api }),
    api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }) } });
  await watcher.load();
  await watcher.configure({ enabled: true });
  await assert.rejects(watcher.poll(['1']));
  assert.equal(watcher.store.data.pendingMeters.length, 1, 'completed view must leave a pending meter');
  console.log('PASS: completed view retains pending meter');
} finally { await rm(dir, { recursive: true, force: true }); }
