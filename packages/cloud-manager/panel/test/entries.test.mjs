import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/api.js';
import { mountEntries } from '../components/entries.js';
import { appendRoot, findByText, flush, installDom } from './helpers/dom-stub.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const setup = () => appendRoot(installDom());
const toast = { show() {} };

test('entry APIs escape ids and keep writes same-origin', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (path, init) => { calls.push({ path, init }); return { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } }; } });
  await api.getEntries('a/b'); await api.setEntryEnabled('a/b', 'desktop', true); await api.createDesktopPairingCode('a/b'); await api.revokeDesktopDevice('a/b', 'device/1'); await api.getBillingEntries('a/b');
  assert.deepEqual(calls.map(x => [x.path, x.init.method]), [['/api/tenants/a%2Fb/entries', 'GET'], ['/api/tenants/a%2Fb/entries/desktop', 'PUT'], ['/api/tenants/a%2Fb/desktop/pairing-codes', 'POST'], ['/api/tenants/a%2Fb/desktop/devices/device%2F1', 'DELETE'], ['/api/tenants/a%2Fb/billing/entries', 'GET']]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { enabled: true });
  assert.throws(() => api.setEntryEnabled('a', '../x', true));
});

test('entry cards show usage, pairing QR and device revoke safely', async () => {
  const { root } = setup(); let revoked = '', paired = 0;
  const signals = [];
  const api = {
    getEntries: async (_id, o) => { signals.push(o.signal); return { entries: { qq_protocol: { enabled: true }, desktop: { enabled: true } } }; },
    getBillingEntries: async () => ({ entries: [{ entry: 'desktop', usage: [{ meter: 'desktop.device.seats', quantity: 2, unit: 'seats' }] }] }),
    getDesktopDevices: async () => ({ devices: [{ id: 'dev', name: '<img src=x onerror=alert(1)>', os: 'Windows' }] }),
    createDesktopPairingCode: async () => { paired++; return { code: 'ABC123', expiresAt: Date.now() + 10000, qr: 'data:image/png;base64,AAAA' }; },
    revokeDesktopDevice: async (_id, id) => { revoked = id; }, setEntryEnabled: async () => {}
  };
  const view = mountEntries(root, { api, tenantId: 't', toast }); await settle();
  assert.match(root.textContent, /desktop.device.seats: 2 seats/); assert.match(root.textContent, /<img src=x/); assert.equal(root.querySelector('img'), null);
  findByText(root, 'button', '生成配对码').click(); await settle(); assert.equal(paired, 1); assert.match(root.textContent, /ABC123/); assert.equal(root.querySelector('img').getAttribute('src'), 'data:image/png;base64,AAAA');
  findByText(root, 'button', '撤销').click(); await settle(); assert.equal(revoked, 'dev');
  view.destroy(); assert.equal(signals.at(-1).aborted, true);
});

test('viewer cannot mutate and desktop must be enabled before pairing', async () => {
  const { root } = setup(); let writes = 0;
  const api = { getEntries: async () => ({ entries: { desktop: { enabled: false } } }), getBillingEntries: async () => ({ entries: [] }), getDesktopDevices: async () => ({ devices: [{ id: 'd' }] }), setEntryEnabled: async () => { writes++; }, createDesktopPairingCode: async () => { writes++; }, revokeDesktopDevice: async () => { writes++; } };
  const view = mountEntries(root, { api, tenantId: 't', toast, readOnly: true }); await settle();
  assert.equal(findByText(root, 'button', '生成配对码').disabled, true); assert.equal(findByText(root, 'button', '撤销').disabled, true);
  for (const b of root.querySelectorAll('button')) if (b.textContent === '启用') assert.equal(b.disabled, true);
  assert.equal(writes, 0); view.destroy();
});

test('Bili explore viewer renders external text safely and cannot approve drafts', async () => {
  const { mountBiliExplore } = await import('../components/bili-explore.js');
  const { root } = setup(); let writes = 0, signal;
  const api = { getBiliExplore: async (_id, o) => { signal = o.signal; return { explore: { config: { enabled: true, level: 1, acknowledged: true, keywords: [], maxVideosPerDay: 2, maxDraftsPerDay: 1 }, riskUntil: 0, drafts: [{ id: 'd', status: 'pending', expiresAt: Date.now() + 1000, video: { title: '<script>bad</script>' }, text: '【AI生成】draft', evidence: 'caption' }], journal: [] } }; }, updateBiliExplore: async () => { writes++; }, reviewBiliDraft: async () => { writes++; } };
  const view = mountBiliExplore(root, { api, tenantId: 't', toast, readOnly: true }); await settle();
  assert.match(root.textContent, /<script>bad<\/script>/); assert.equal(root.querySelector('script'), null);
  assert.equal(findByText(root, 'button', '批准').disabled, true); assert.equal(findByText(root, 'button', '保存').disabled, true); assert.equal(writes, 0);
  view.destroy(); assert.equal(signal.aborted, true);
});
