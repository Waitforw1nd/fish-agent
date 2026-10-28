import { h, clear, setBusy } from '../../lib/dom.js';
import { confirmDialog } from '../../lib/modal.js';
import { normalizeRelayOverview } from '../../lib/normalize.js';
import { normalizeRelayCustom } from '../../lib/user-data.js';
import { formatDateTime, redactText } from '../../lib/format.js';
import { validateRelayInput } from '../../lib/validate.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { alertBox, badge, cardHead, note, setAlert, setBadge } from '../../lib/ui.js';
import { renderTenantPrerequisite, resolveTenant, userHead, userLoading } from './shared.js';

export function mountUserChannel({ root, api, toast, tenants = [], tenantId = '', tenantsError = '', retryTenants, onTenantChange, modalRoot = null } = {}) {
  let active = true;
  const tenant = resolveTenant(tenants, tenantId);
  if (!tenant) {
    renderTenantPrerequisite(root, { tenantsError, retryTenants, tenantId });
    return { destroy() { active = false; root.replaceChildren(); } };
  }

  const readOnly = tenant.role === 'viewer';
  let platform = null;
  let custom = null;
  let savingPlatform = false;
  let savingCustom = false;
  let deleting = false;
  const head = userHead({
    eyebrow: 'Channels', title: '渠道 Key',
    sub: '绑定平台 Relay Key，或使用自己的 OpenAI 兼容服务。密钥只写入服务端，不会回显。',
    tenants, tenant, onTenantChange, refresh: () => { void load(true); }
  });
  userLoading(root, head, '正在读取渠道配置…');

  const platformBadge = badge('读取中', 'neutral');
  const platformKey = h('code', {}, '—');
  const platformAlert = alertBox('', 'danger', { hidden: true });
  const platformInput = h('input', {
    class: 'input', id: 'user-relay-key', name: 'relayKey', type: 'password',
    autocomplete: 'off', spellcheck: false, placeholder: '输入平台 Relay Key'
  });
  const platformSave = h('button', { class: 'btn btn-primary', type: 'button' }, '绑定平台 Key');
  const platformCard = h('section', { class: 'card card-pad' },
    cardHead({
      kicker: 'Fish Cloud Relay', title: '平台 Relay Key',
      sub: '使用平台提供的模型渠道与额度，费用以平台调用记录为准。', badge: platformBadge
    }),
    h('div', { class: 'key-display' }, h('span', { class: 'mono' }, 'KEY'), platformKey),
    h('div', { class: 'relay-form mt-18' },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'user-relay-key' }, 'Relay Key'),
        platformInput
      ),
      platformAlert,
      h('div', { class: 'inline-buttons' }, platformSave)
    )
  );

  const customBadge = badge('读取中', 'neutral');
  const customStatus = h('p', { class: 'note' }, '正在读取测试状态…');
  const baseUrlInput = h('input', {
    class: 'input mono', id: 'custom-base-url', name: 'baseUrl', type: 'url',
    autocomplete: 'off', spellcheck: false, placeholder: 'https://api.example.com/v1'
  });
  const apiKeyInput = h('input', {
    class: 'input', id: 'custom-api-key', name: 'apiKey', type: 'password',
    autocomplete: 'off', spellcheck: false, placeholder: '输入你的 API Key'
  });
  const modelInput = h('input', {
    class: 'input mono', id: 'custom-model', name: 'model', type: 'text',
    autocomplete: 'off', spellcheck: false, placeholder: '例如：gpt-4o-mini'
  });
  const customAlert = alertBox('', 'danger', { hidden: true });
  const customSave = h('button', { class: 'btn btn-primary', type: 'button' }, '保存配置');
  const customDelete = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, '删除配置');
  const customCard = h('section', { class: 'card card-pad' },
    cardHead({
      kicker: 'OpenAI Compatible', title: '自定义 OpenAI 兼容渠道',
      sub: '填写自己的 Base URL、API Key 和模型。当前接口不提供连接测试。', badge: customBadge
    }),
    h('form', { class: 'relay-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'custom-base-url' }, 'Base URL'),
        baseUrlInput
      ),
      h('div', { class: 'form-row' },
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'custom-api-key' }, 'API Key'),
          apiKeyInput
        ),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'custom-model' }, 'model'),
          modelInput
        )
      ),
      customAlert,
      h('div', { class: 'inline-buttons' }, customSave, customDelete)
    ),
    customStatus,
    note('API Key 仅用于本次写入；更新其他字段时可留空以保留原密钥。')
  );

  if (readOnly) {
    for (const element of [platformInput, platformSave, baseUrlInput, apiKeyInput, modelInput, customSave, customDelete]) element.disabled = true;
  }

  function renderPage() {
    root.replaceChildren(head, h('div', { class: 'user-two-column' }, platformCard, customCard));
  }

  function updatePlatform() {
    if (!platform) return;
    setBadge(platformBadge, platform.keyStatusLabel, platform.keyStatusTone);
    platformKey.textContent = platform.configured ? '已绑定（不回显）' : '未绑定';
    platformInput.placeholder = platform.configured ? '输入新 Key 以替换（密钥不回显）' : '输入平台 Relay Key';
  }

  function updateCustom() {
    if (!custom) return;
    setBadge(customBadge, custom.testLabel, custom.testTone);
    customDelete.disabled = readOnly || !custom.configured || deleting;
    apiKeyInput.placeholder = custom.keyConfigured ? '留空保留原 Key，输入新 Key 则替换' : '输入你的 API Key';
    const tested = custom.testedAt ? ` · ${formatDateTime(custom.testedAt)}` : '';
    customStatus.textContent = `测试状态：${custom.testLabel}${tested}${custom.testMessage ? ` · ${redactText(custom.testMessage, { maxLength: 240 })}` : ''}`;
  }

  async function load(notify = false) {
    if (!active) return;
    const refresh = head.querySelector('button');
    setBusy(refresh, true);
    const [platformResult, customResult] = await Promise.allSettled([
      api.getRelayOverview(tenant.id),
      api.getRelayCustom(tenant.id)
    ]);
    if (!active) return;
    if (platformResult.status === 'fulfilled') {
      platform = normalizeRelayOverview(platformResult.value);
      updatePlatform();
      if (!platform.configured) setAlert(platformAlert, '尚未绑定平台 Relay Key。', 'warn');
      else setAlert(platformAlert, '', 'danger');
    } else {
      setAlert(platformAlert, apiErrorMessage(platformResult.reason, { fallback: '平台渠道加载失败。' }), 'danger');
    }
    if (customResult.status === 'fulfilled') {
      custom = normalizeRelayCustom(customResult.value);
      baseUrlInput.value = custom.baseUrl;
      modelInput.value = custom.model;
      apiKeyInput.value = '';
      updateCustom();
      setAlert(customAlert, '', 'danger');
    } else {
      setAlert(customAlert, apiErrorMessage(customResult.reason, { fallback: '自定义渠道加载失败。' }), 'danger');
      customStatus.textContent = '无法读取测试状态，请刷新重试。';
    }
    setBusy(refresh, false);
    if (notify) toast?.show?.('渠道状态已刷新', { tone: 'success' });
  }

  async function savePlatform() {
    if (readOnly || savingPlatform || !active) return;
    const validation = validateRelayInput({ key: platformInput.value }, { configured: platform?.configured });
    if (!validation.ok) {
      setAlert(platformAlert, validation.error, 'danger');
      return;
    }
    savingPlatform = true;
    setBusy(platformSave, true);
    try {
      await api.updateRelayKey(tenant.id, { key: validation.payload.key });
      if (!active) return;
      platformInput.value = '';
      toast?.show?.('平台 Relay Key 已绑定', { tone: 'success' });
      const payload = await api.getRelayOverview(tenant.id);
      if (!active) return;
      platform = normalizeRelayOverview(payload);
      updatePlatform();
      setAlert(platformAlert, '', 'danger');
    } catch (error) {
      if (active) setAlert(platformAlert, apiErrorMessage(error, { fallback: '绑定平台 Key 失败。' }), 'danger');
    } finally {
      savingPlatform = false;
      if (active) setBusy(platformSave, false);
    }
  }

  function validCustomInput() {
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim();
    let parsed;
    try { parsed = new URL(baseUrl); } catch { /* 下方统一提示 */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return { error: '请输入有效的 http(s) Base URL' };
    if (!model) return { error: '请输入 model' };
    if (!apiKey && !custom?.keyConfigured) return { error: '首次配置请输入 API Key' };
    if (apiKey.length > 512 || /[\u0000-\u001f\u007f\s]/.test(apiKey)) return { error: 'API Key 不能包含空白或控制字符，且最长 512 个字符' };
    return { baseUrl, apiKey, model };
  }

  async function saveCustom() {
    if (readOnly || savingCustom || !active) return;
    const values = validCustomInput();
    if (values.error) {
      setAlert(customAlert, values.error, 'danger');
      return;
    }
    savingCustom = true;
    setBusy(customSave, true);
    setAlert(customAlert, '', 'danger');
    try {
      const result = await api.updateRelayCustom(tenant.id, values);
      if (!active) return;
      custom = normalizeRelayCustom({
        ...result,
        baseUrl: result?.baseUrl ?? result?.custom?.baseUrl ?? values.baseUrl,
        model: result?.model ?? result?.custom?.model ?? values.model,
        keyConfigured: result?.keyConfigured ?? result?.custom?.keyConfigured ?? true
      });
      apiKeyInput.value = '';
      updateCustom();
      toast?.show?.('自定义渠道已保存', { tone: 'success' });
    } catch (error) {
      if (active) setAlert(customAlert, apiErrorMessage(error, { fallback: '保存自定义渠道失败。' }), 'danger');
    } finally {
      savingCustom = false;
      if (active) setBusy(customSave, false);
    }
  }

  async function deleteCustom() {
    if (readOnly || deleting || !custom?.configured || !active) return;
    const confirmed = await confirmDialog({
      root: modalRoot || document.getElementById('modal-root') || document.body,
      title: '删除自定义渠道', message: '确定删除此实例的 Base URL、API Key 和模型配置吗？',
      confirmText: '删除配置', danger: true
    });
    if (!confirmed || !active) return;
    deleting = true;
    setBusy(customDelete, true);
    try {
      await api.deleteRelayCustom(tenant.id);
      if (!active) return;
      custom = normalizeRelayCustom(null);
      baseUrlInput.value = '';
      apiKeyInput.value = '';
      modelInput.value = '';
      updateCustom();
      toast?.show?.('自定义渠道已删除', { tone: 'success' });
    } catch (error) {
      if (active) setAlert(customAlert, apiErrorMessage(error, { fallback: '删除自定义渠道失败。' }), 'danger');
    } finally {
      deleting = false;
      if (active) {
        setBusy(customDelete, false);
        updateCustom();
      }
    }
  }

  platformSave.addEventListener('click', () => { void savePlatform(); });
  customSave.addEventListener('click', () => { void saveCustom(); });
  customDelete.addEventListener('click', () => { void deleteCustom(); });
  customCard.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); void saveCustom(); });
  for (const input of [platformInput, baseUrlInput, apiKeyInput, modelInput]) {
    input.addEventListener('input', () => {
      setAlert(input === platformInput ? platformAlert : customAlert, '', 'danger');
    });
  }

  renderPage();
  void load();
  return {
    destroy() { active = false; root.replaceChildren(); },
    refresh: load
  };
}
