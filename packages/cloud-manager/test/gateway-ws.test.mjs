import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { loginAdmin, readJsonLines, startManager, tenantHost, waitFor } from './helpers.mjs';

test('gateway WebSocket upgrade auth, header rewrite and expiry close', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'WS Demo', slug: 'ws-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  assert.equal((await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' })).status, 200);
  const host = tenantHost(config, 'ws-demo');

  const ws = await openWs(config, host, admin.cookie, '/ws', `http://${host}`);
  const messages = [];
  ws.on('message', (data) => messages.push(String(data)));
  await waitFor(() => messages.includes('hello'), { label: 'ws hello' });
  ws.send('ping');
  await waitFor(() => messages.includes('pong:ping'), { label: 'ws echo' });

  const tenant = manager.tenants.row(tenantId);
  const logEntries = readJsonLines(`${manager.agent.dataDir(tenant)}/fake-agent-requests.jsonl`);
  const upgrade = logEntries.filter((entry) => entry.method === 'UPGRADE').at(-1);
  const agentPort = manager.agent.port(tenant);
  assert.equal(upgrade.host, `127.0.0.1:${agentPort}`);
  assert.equal(upgrade.origin, `http://127.0.0.1:${agentPort}`);
  assert.equal(upgrade.cookiePresent, false);
  assert.equal(upgrade.tokenMatches, true);

  await assert.rejects(
    openWs(config, host, null, '/ws', `http://${host}`),
    /401|Unexpected server response/i
  );
  await assert.rejects(
    openWs(config, host, 'fm_session=invalid', '/ws', `http://${host}`),
    /401|Unexpected server response/i
  );
  await assert.rejects(
    openWs(config, host, admin.cookie, '/api/reset-data', `http://${host}`),
    /403|Unexpected server response/i
  );

  const closed = new Promise((resolve) => ws.once('close', () => resolve(true)));
  manager.db.prepare('UPDATE tenants SET expires_at = ?, status = ? WHERE id = ?').run(Date.now() - 10, 'active', tenantId);
  manager.tenants.sweepExpired();
  await closed;
  await waitFor(() => manager.agent.supervisor.status(tenantId, 'agent').state === 'stopped', { label: 'ws tenant stopped' });
});

function openWs(config, host, cookie, pathname, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.panelPort}${pathname}`, {
      headers: {
        host,
        origin,
        ...(cookie ? { cookie } : {})
      },
      handshakeTimeout: 4000
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => reject(new Error(`Unexpected server response: ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
