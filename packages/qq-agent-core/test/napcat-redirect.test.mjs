import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-redirect-'));
process.env.QQ_AGENT_DATA_DIR = root;
const lookup = dns.promises.lookup;
const request = http.request;
dns.promises.lookup = async (host, options) => host === 'public.fixture.test'
  ? [{ address: '93.184.216.34', family: 4 }] : lookup(host, options);
http.request = function(options, ...args) {
  if (options.hostname === '93.184.216.34') options = { ...options, hostname: '127.0.0.1' };
  return request.call(this, options, ...args);
};
const { updateConfig } = await import('../src/config.js');
const { SendQueue } = await import('../src/sender.js');

test('public resolved first hop redirects to private host and sender rejects before action', async t => {
  let firstHop = 0, privateHop = 0, sends = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { firstHop++; res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/private` }); res.end(); }
    else { privateHop++; res.end('private'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  updateConfig({ channels: { qq: { driver: 'napcat', media: { mode: 'inline-base64', maxImageBytes: 5242880, incomingLocalPaths: 'deny' } } }, security: { allowPrivateImageHosts: true }, send: { guard: { enabled: false } } });
  const sender = new SendQueue({ onebot: { async sendImage() { sends++; } }, store: { appendSelf() {} } });
  await assert.rejects(sender.sendImage('group:456', { url: `http://public.fixture.test:${server.address().port}/redirect` }), /内网|本机/);
  assert.equal(firstHop, 1);
  assert.equal(privateHop, 0);
  assert.equal(sends, 0);
});

test.after(() => { dns.promises.lookup = lookup; http.request = request; fs.rmSync(root, { recursive: true, force: true }); });
