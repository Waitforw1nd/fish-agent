import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicService } from '../src/bili/dynamic.js';
import { CommentService } from '../src/bili/comment.js';
import { DmService } from '../src/bili/dm.js';
import { VideoService } from '../src/bili/video.js';
import { BiliApi } from '../src/bili/api.js';

for (const [type, oid] of [[17, '90071992547409999'], [11, '34567']]) {
  test(`dynamic type ${type} uses returned comment OID and reply threading`, async () => {
    let form;
    const api = { requireLogin() {}, csrf: () => 'csrf', request: async (req) => {
      if (req.path.includes('/detail')) return { data: { item: { id_str: '90071992547409999', basic: { comment_type: type, comment_id_str: oid } } } };
      form = req.form; return { data: { rpid_str: '987' } };
    } };
    const detail = await new DynamicService({ api }).detail('90071992547409999');
    await new CommentService({ api }).add({ oid: detail.oid, type: detail.type, message: 'reply', root: '123', parent: '456' });
    assert.deepEqual([form.oid, form.type, form.root, form.parent], [oid, type, '123', '456']);
  });
}

test('DM uploads validated image then sends type 2 with Bili URL', async () => {
  const calls = [];
  const api = { requireLogin() {}, csrf: () => 'csrf', request: async (req) => { calls.push(req); return req.multipart ? { data: { image_url: 'https://i0.hdslb.com/bfs/album/example.png', image_width: 1, image_height: 2 } } : { data: { msg_seqno: '2' } }; } };
  const dm = new DmService({ api, jar: { get: () => '1' } });
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const image = await dm.uploadImage(`base64://${png.toString('base64')}`);
  await dm.send({ receiverId: '2', image });
  assert.equal(calls[0].multipart.get('category'), 'daily');
  assert.equal(calls[0].multipart.get('file_up').type, 'image/png');
  assert.equal(calls[1].form['msg[msg_type]'], 2);
  assert.deepEqual(JSON.parse(calls[1].form['msg[content]']), image);
  await dm.uploadImage(`data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(dm.uploadImage('base64://YWJj'), /仅支持/);
});

test('recent dynamics distinguish empty, restricted and failure', async () => {
  let mode = 'empty';
  const api = { request: async ({ path }) => {
    if (path.includes('/card')) return { data: { card: {} } };
    if (mode !== 'empty') throw Object.assign(new Error(mode), { apiCode: mode === 'restricted' ? -403 : -500 });
    return { data: { items: [] } };
  } };
  const service = new VideoService({ api });
  for (mode of ['empty', 'restricted', 'failed']) assert.equal((await service.inspectUser({ mid: '1', includeDynamics: true })).dynamicsStatus, mode);
});

test('real BiliApi emits multipart upload and form encoded type 2 send', async () => {
  const requests = [];
  const jar = { get: (key) => ({ SESSDATA: 'session', bili_jct: 'csrf', DedeUserID: '1' })[key] || '', headerFor: () => '', applySetCookie() {} };
  const api = new BiliApi({ jar, signer: { sign: async (params) => params }, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ code: 0, data: url.includes('upload_bfs') ? { image_url: 'https://i0.hdslb.com/bfs/album/a.png', image_width: 1, image_height: 1 } : { msg_seqno: '3' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const dm = new DmService({ api, jar });
  const image = await dm.uploadImage(`base64://${Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64')}`);
  await dm.send({ receiverId: '2', image });
  assert.match(requests[0].url, /\/x\/dynamic\/feed\/draw\/upload_bfs$/);
  assert.ok(requests[0].init.body instanceof FormData);
  assert.equal(requests[0].init.body.get('csrf'), 'csrf');
  assert.match(requests[1].url, /\/web_im\/v1\/web_im\/send_msg\?/);
  const form = new URLSearchParams(requests[1].init.body);
  assert.equal(form.get('msg[msg_type]'), '2');
  assert.equal(JSON.parse(form.get('msg[content]')).url, image.url);
});
