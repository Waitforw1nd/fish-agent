import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';

test('HTTPS tenant login redirect retains scheme and Host', async () => {
  const gateway = new Gateway({ config: { baseDomain: 'example.com', panelPort: 443, publicScheme: 'https', cookieSecure: true }, tenants: { bySlug: () => ({ id: '1', slug: 'fish' }) }, auth: { resolve: () => null } });
  const req = { headers: { host: 'fish.example.com', accept: 'text/html' }, url: '/settings', method: 'GET' };
  let location;
  const res = { writeHead(_status, headers) { location = headers.location; }, end() {} };
  assert.equal(await gateway.handle(req, res), true);
  assert.equal(location, 'https://example.com/login?next=https%3A%2F%2Ffish.example.com%2Fsettings');
});


test('HTTPS redirect through real manager HTTP routing retains tenant host', async t => {
  const { startManager, loginAdmin, request } = await import('./helpers.mjs');
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const created = await admin.createTenant({ name: 'HTTPS', slug: 'secure', planId: 'starter' });
  assert.equal(created.status, 201);
  env.manager.gateway.config.publicScheme = 'https';
  env.manager.gateway.config.cookieSecure = true;
  const result = await request(`http://127.0.0.1:${env.config.panelPort}`, { host: 'secure.test.local', path: '/settings', headers: { accept: 'text/html' } });
  assert.equal(result.status, 302);
  assert.match(result.headers.location, /^https:\/\/test\.local:\d+\/login\?next=https%3A%2F%2Fsecure\.test\.local%2Fsettings$/);
});
