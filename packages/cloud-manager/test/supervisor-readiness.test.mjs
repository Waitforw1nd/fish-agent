import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Supervisor } from '../src/supervisor.js';
import { waitFor } from './helpers.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE process_runs (id TEXT PRIMARY KEY, tenant_id TEXT, kind TEXT, pid INTEGER,
    status TEXT, started_at INTEGER, stopped_at INTEGER, exit_code INTEGER, last_error TEXT)`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-ready-proof-'));
  const supervisor = new Supervisor({
    db,
    config: { processStartTimeoutMs: 3000, processStopTimeoutMs: 500, maxCrashRestarts: 0 },
    logger: { error() {} }
  });
  t.after(async () => {
    try { await supervisor.shutdown(); } catch { /* best-effort cleanup after a failed assertion */ }
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, supervisor };
}

async function listen(t) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => { if (server.listening) server.close(); });
  return server;
}

test('agent readiness waits for its own listener instead of another process using the port', async t => {
  const { cwd, supervisor } = fixture(t);
  const decoy = await listen(t);
  let decoyConnections = 0;
  decoy.on('connection', () => { decoyConnections += 1; });
  const port = decoy.address().port;
  const marker = path.join(cwd, 'child-started');
  const gate = path.join(cwd, 'allow-listen');
  const script = `
    const fs = require('node:fs');
    const net = require('node:net');
    process.send?.({ type: 'fish-agent-listening', pid: process.pid + 1, port: Number(process.env.PORT) });
    process.send?.({ type: 'fish-agent-listening', pid: process.pid, port: Number(process.env.PORT) + 1 });
    fs.writeFileSync(process.env.MARKER, 'started');
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.GATE)) return;
      clearInterval(timer);
      const server = net.createServer(socket => socket.destroy());
      server.listen(Number(process.env.PORT), '127.0.0.1', () => {
        process.send?.({ type: 'fish-agent-listening', pid: process.pid, port: server.address().port });
      });
    }, 20);
  `;
  const launch = supervisor.start({
    tenantId: 'tenant', kind: 'agent', command: process.execPath, args: ['-e', script], cwd,
    env: { MARKER: marker, GATE: gate, PORT: port },
    ready: { host: '127.0.0.1', port, timeoutMs: 3000, signal: 'agent-listening' },
    restart: false
  });
  await waitFor(() => fs.existsSync(marker), { timeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(supervisor.status('tenant', 'agent').state, 'starting');
  assert.equal(decoyConnections, 0);

  await new Promise(resolve => decoy.close(resolve));
  fs.writeFileSync(gate, 'go');
  const status = await launch;
  assert.equal(status.state, 'running');
  assert.ok(status.readyAt);
  await supervisor.stop('tenant', 'agent');
});

test('agent startup fails when the child never sends a listener receipt', async t => {
  const { cwd, supervisor } = fixture(t);
  const decoy = await listen(t);
  const port = decoy.address().port;
  await assert.rejects(supervisor.start({
    tenantId: 'tenant', kind: 'agent', command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
    ready: { host: '127.0.0.1', port, timeoutMs: 400, signal: 'agent-listening' },
    restart: false
  }), { code: 'READY_FAILED' });
  assert.equal(supervisor.status('tenant', 'agent').state, 'failed');
  assert.equal(supervisor.get('tenant', 'agent').child, null);
});

test('agent startup fails promptly if the child exits before its listener receipt', async t => {
  const { cwd, supervisor } = fixture(t);
  const decoy = await listen(t);
  await assert.rejects(supervisor.start({
    tenantId: 'tenant', kind: 'agent', command: process.execPath,
    args: ['-e', 'process.exit(17)'], cwd,
    ready: { host: '127.0.0.1', port: decoy.address().port, timeoutMs: 3000, signal: 'agent-listening' },
    restart: false
  }), { code: 'READY_FAILED' });
  assert.equal(supervisor.status('tenant', 'agent').state, 'failed');
  assert.equal(supervisor.get('tenant', 'agent').child, null);
});

test('agent startup reports spawn failure while waiting for a listener receipt', async t => {
  const { cwd, supervisor } = fixture(t);
  const decoy = await listen(t);
  await assert.rejects(supervisor.start({
    tenantId: 'tenant', kind: 'agent', command: path.join(cwd, 'missing-command'), cwd,
    ready: { host: '127.0.0.1', port: decoy.address().port, timeoutMs: 1000, signal: 'agent-listening' },
    restart: false
  }), { code: 'SPAWN_FAILED' });
  assert.equal(supervisor.status('tenant', 'agent').state, 'failed');
});

test('agent startup also checks the port after a valid receipt', async t => {
  const { cwd, supervisor } = fixture(t);
  const placeholder = await listen(t);
  const port = placeholder.address().port;
  await new Promise(resolve => placeholder.close(resolve));
  const script = `
    process.send({ type: 'fish-agent-listening', pid: process.pid, port: Number(process.env.PORT) });
    setInterval(() => {}, 1000);
  `;
  await assert.rejects(supervisor.start({
    tenantId: 'tenant', kind: 'agent', command: process.execPath, args: ['-e', script], cwd,
    env: { PORT: port },
    ready: { host: '127.0.0.1', port, timeoutMs: 400, signal: 'agent-listening' },
    restart: false
  }), { code: 'READY_FAILED' });
  assert.equal(supervisor.status('tenant', 'agent').state, 'failed');
});
