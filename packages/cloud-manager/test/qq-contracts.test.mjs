import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { napcatDriver } from '../src/qq/napcat.js';
import { llbotDriver } from '../src/qq/llbot.js';
import { startManager, loginAdmin } from './helpers.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return port;
}

test('NapCat QR uses upstream WebUI hash and credential contract', async t => {
  let phase = 'waiting';
  const port = await fixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/login') {
      assert.equal(JSON.parse(body).hash, createHash('sha256').update('fixture.napcat').digest('hex'));
      return res.end(JSON.stringify({ code: 0, data: { Credential: 'signed-fixture' } }));
    }
    assert.equal(req.headers.authorization, 'Bearer signed-fixture');
    if (req.url === '/api/QQLogin/CheckLoginStatus') return res.end(JSON.stringify({ code: 0, data: { isLogin: phase === 'success', loginPhase: phase } }));
    if (req.url === '/api/QQLogin/GetQQLoginQrcode') return res.end(JSON.stringify(phase === 'pending' ? { code: -1, message: 'QRCode Get Error' } : { code: 0, data: { qrcode: 'https://example.test/fixture' } }));
    res.statusCode = 404; res.end();
  });
  const ctx = { account: { webui_port: port }, tokens: { webuiPassword: 'fixture' } };
  const ready = await napcatDriver.qrcode(ctx);
  assert.equal(ready.state, 'ready');
  assert.match(ready.pngBase64, /^data:image\/png;base64,/);
  phase = 'qrcode_scanned'; assert.equal((await napcatDriver.qrcode(ctx)).state, 'scanned');
  phase = 'pending'; assert.equal((await napcatDriver.qrcode(ctx)).state, 'pending');
  phase = 'success'; assert.equal((await napcatDriver.qrcode(ctx)).state, 'success');
});

test('LLBot desktop requires matching PMHQ version and account and preserves mode', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llbot-desktop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let health = { qq_full_version: '9.9.33.51802', uin: '12345' };
  const port = await fixture(t, (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(health)); });
  const entry = path.join(dir, 'llbot.js'); fs.writeFileSync(entry, '');
  const ctx = { paths: { dir }, config: { llbotEntry: entry, nodePath: process.execPath, llbotDesktopQqVersion: '9.9.33.51802' }, account: { expected_uin: '12345', webui_port: 1, ob11_port: 2 }, tokens: { webuiPassword: 'fixture', onebotToken: 'fixture', authToken: '' }, options: { mode: 'desktop', pmhqPort: port } };
  await llbotDriver.prepare(ctx); delete ctx.options;
  assert.deepEqual((await llbotDriver.launch(ctx)).args.slice(-2), ['--pmhq-port', String(port)]);
  health = { qq_full_version: 'wrong' }; await assert.rejects(llbotDriver.launch(ctx), { code: 'QQ_VERSION_MISMATCH' });
  health = {}; await assert.rejects(llbotDriver.launch(ctx), { code: 'QQ_VERSION_UNKNOWN' });
  health = { qq_full_version: '9.9.33.51802', uin: '54321' }; await assert.rejects(llbotDriver.launch(ctx), { code: 'QQ_UIN_MISMATCH' });
});

test('desktop API reserves distinct PMHQ ports and preserves unrelated tenant leases', async t => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const a = (await admin.createTenant({ name: 'Desktop A', slug: 'desktop-a', planId: 'starter' })).json.tenant.id;
  const b = (await admin.createTenant({ name: 'Desktop B', slug: 'desktop-b', planId: 'starter' })).json.tenant.id;
  const agent = await env.manager.allocator.allocate(a, 'agent.http');
  const prepare = (id, body) => admin.call(`/api/tenants/${id}/qq/prepare`, { method: 'POST', body });
  const first = await prepare(a, { driver: 'llbot', uin: '12345', mode: 'desktop' });
  assert.equal(first.status, 200, first.text);
  const port = first.json.qq.ports.pmhq;
  assert.ok(port > 0);
  const conflict = await prepare(b, { driver: 'llbot', uin: '12346', mode: 'desktop', pmhqPort: port });
  assert.equal(conflict.status, 409);
  const existing = await prepare(b, { driver: 'napcat', uin: '12346' });
  assert.equal(existing.status, 200, existing.text);
  const before = ['qq.webui', 'qq.ob11', 'qq.http'].map(purpose => env.manager.allocator.find(b, purpose).port);
  const switchConflict = await prepare(b, { driver: 'llbot', uin: '12346', mode: 'desktop', pmhqPort: port });
  assert.equal(switchConflict.status, 409);
  assert.deepEqual(['qq.webui', 'qq.ob11', 'qq.http'].map(purpose => env.manager.allocator.find(b, purpose).port), before);
  assert.equal(env.manager.allocator.find(a, 'qq.pmhq').port, port);
  const second = await prepare(b, { driver: 'llbot', uin: '12346', mode: 'desktop' });
  assert.equal(second.status, 200, second.text);
  assert.notEqual(second.json.qq.ports.pmhq, port);
  const direct = await prepare(a, { driver: 'napcat', uin: '12345' });
  assert.equal(direct.status, 200, direct.text);
  assert.equal(env.manager.allocator.find(a, 'agent.http').port, agent.port);
  assert.equal(env.manager.allocator.find(a, 'qq.pmhq'), null);
});

test('failed desktop prepare releases only the newly allocated PMHQ lease', async t => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const a = (await admin.createTenant({ name: 'Failure A', slug: 'failure-a', planId: 'starter' })).json.tenant.id;
  const b = (await admin.createTenant({ name: 'Failure B', slug: 'failure-b', planId: 'starter' })).json.tenant.id;
  const prepare = (id, body) => admin.call(`/api/tenants/${id}/qq/prepare`, { method: 'POST', body });
  const other = await prepare(b, { driver: 'llbot', uin: '12346', mode: 'desktop' });
  assert.equal(other.status, 200, other.text);
  const otherLease = env.manager.allocator.find(b, 'qq.pmhq');
  const original = llbotDriver.prepare;
  llbotDriver.prepare = async () => { throw new Error('simulated file failure'); };
  try {
    const failed = await prepare(a, { driver: 'llbot', uin: '12345', mode: 'desktop' });
    assert.equal(failed.status, 500);
    assert.equal(env.manager.allocator.find(a, 'qq.pmhq'), null);
    assert.equal(env.manager.allocator.find(b, 'qq.pmhq').id, otherLease.id);
    const existingFailed = await prepare(b, { driver: 'llbot', uin: '12346', mode: 'desktop' });
    assert.equal(existingFailed.status, 500);
    assert.equal(env.manager.allocator.find(b, 'qq.pmhq').id, otherLease.id);
  } finally { llbotDriver.prepare = original; }
});
