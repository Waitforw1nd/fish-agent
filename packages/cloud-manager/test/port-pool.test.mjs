import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startManager } from './helpers.mjs';
import { reserveTestPortRange } from './port-pool.mjs';

function assertDisjoint(ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index - 1].end < ordered[index].start, JSON.stringify(ordered));
  }
}

test('parallel processes reserve disjoint manager port ranges', async t => {
  const entry = fileURLToPath(new URL('./fixtures/hold-test-port-range.mjs', import.meta.url));
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [entry], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
  }));
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('release', error => { if (error) child.kill(); });
      else child.kill();
    })));
  });
  const ranges = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test range worker did not respond')), 10000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`test range worker exited: ${code}`)); });
  })));
  const local = await reserveTestPortRange();
  t.after(() => local.release());
  assertDisjoint([...ranges, local]);
  for (const range of ranges) assert.equal(range.end - range.start + 1, 128);
});

test('manager startup failure closes the range reservation and any started server', async t => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const oldNetCreate = net.createServer;
  const oldHttpCreate = http.createServer;
  const anchors = [], servers = [];
  net.createServer = (...args) => { const server = oldNetCreate(...args); anchors.push(server); return server; };
  http.createServer = (...args) => { const server = oldHttpCreate(...args); servers.push(server); return server; };
  t.after(() => { net.createServer = oldNetCreate; http.createServer = oldHttpCreate; });
  await assert.rejects(startManager({ panelPort: blocker.address().port }), { code: 'EADDRINUSE' });
  assert.ok(anchors.length > 0);
  assert.ok(anchors.every(server => !server.listening));
  assert.equal(servers.length, 2);
  assert.ok(servers.every(server => !server.listening));
});
