import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhitelistEditor } from '../components/agent-studio/whitelist-editor.js';
import { appendRoot, findByText, flush, installDom } from './helpers/dom-stub.mjs';

test('official group/private IDs save in the correct fields and invalid IDs do not', async () => {
  const { root } = appendRoot(installDom());
  const saved = [], warnings = [];
  const ctx = { tenantId: 'tenant', readOnly: false, toast: { show: text => warnings.push(text) }, api: { updateAgentConfig: async (_id, patch) => { saved.push(patch); return { ok: true }; } } };
  root.appendChild(createWhitelistEditor(ctx, { allow: { groups: ['qqbot_group_OPEN-ID_1'], private: ['qqbot_user_OPEN_ID2'] } }, () => {}));
  findByText(root, 'button', '保存白名单').click();
  await flush(); await flush();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].allow, { groups: ['qqbot_group_OPEN-ID_1'], private: ['qqbot_user_OPEN_ID2'] });
  const areas = root.querySelectorAll('textarea');
  for (const invalid of ['qqbot_user_WRONG_KIND', 'qqbot_group_../secret', `qqbot_group_${'a'.repeat(129)}`, '9007199254740992']) {
    areas[0].value = invalid;
    findByText(root, 'button', '保存白名单').click(); await flush();
    assert.equal(saved.length, 1, invalid);
  }
  assert.equal(warnings.filter(message => /有效数字/.test(message)).length, 4);
});
