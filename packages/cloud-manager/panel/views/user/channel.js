import { h, clear, setBusy } from '../../lib/dom.js';
import { confirmDialog, openModal } from '../../lib/modal.js';
import { normalizeRelayOverview, normalizeModels } from '../../lib/normalize.js';
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

  const readOnly = ['viewer', 'operator'].includes(tenant.role);
  let platform = null;
  let custom = null;
  let savingPlatform = false;
  let savingCustom = false;
  let deleting = false;
  let dirtyPlatform = false;
  let dirtyCustom = false;
  const hasUnsavedChanges = () => dirtyPlatform || dirtyCustom;
  const canLeave = () => !hasUnsavedChanges() || !globalThis.confirm || globalThis.confirm('渠道配置尚未保存，确定离开吗？');
  const head = userHead({
    eyebrow: 'Channels', title: '模型与渠道',
    sub: '绑定平台 Relay Key，或使用自己的 OpenAI 兼容服务。密钥只写入服务端，不会回显。',
    tenants, tenant, onTenantChange: (next) => {
      if (!canLeave()) {
        const select = head.querySelector('select');
        if (select) select.value = tenant.id;
        return;
      }
      onTenantChange?.(next);
    },
    refresh: () => { if (canLeave()) { dirtyPlatform = false; dirtyCustom = false; void load(true); } }
  });
  userLoading(root, head, '正在读取渠道配置…');

  const platformBadge = badge('读取中', 'neutral');
  const platformKey = h('code', {}, '—');
  const platformAlert = alertBox('', 'danger', { hidden: true });
  const platformInput = h('input', {
    class: 'input', id: 'user-relay-key', name: 'relayKey', type: 'password',
    autocomplete: 'off', spellcheck: false, placeholder: '输入平台 Relay Key'
  });
  const platformModel = h('select', { class: 'select', id: 'user-relay-model', disabled: readOnly },
    h('option', { value: '' }, '选择套餐允许的模型'));
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
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'user-relay-model' }, '默认模型'), platformModel),
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
    autocomplete: 'off', spellcheck: false, placeholder: '例如：gpt-4o-mini', attrs: { list: 'custom-model-options' }
  });
  const modelSuggestions = h('datalist', { id: 'custom-model-options' });
  const customAlert = alertBox('', 'danger', { hidden: true });
  const customSave = h('button', { class: 'btn btn-primary', type: 'button' }, '保存配置');
  const customDelete = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, '删除配置');
  const customTest = h('button', { class: 'btn btn-soft', type: 'button', disabled: readOnly || typeof api.testRelayCustom !== 'function' }, '测试连接并拉取模型');
  const customCard = h('section', { class: 'card card-pad' },
    cardHead({
      kicker: 'OpenAI Compatible', title: '自定义 OpenAI 兼容渠道',
      sub: '填写自己的 Base URL、API Key 和模型，可先测试连接并拉取模型。', badge: customBadge
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
          modelInput, modelSuggestions
        )
      ),
      customAlert,
      h('div', { class: 'inline-buttons' }, customSave, customTest, customDelete)
    ),
    customStatus,
    note('API Key 仅用于本次写入；更新其他字段时可留空以保留原密钥。')
  );

  if (readOnly) {
    for (const element of [platformInput, platformModel, platformSave, baseUrlInput, apiKeyInput, modelInput, customSave, customTest, customDelete]) element.disabled = true;
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
    const [platformResult, customResult, modelsResult] = await Promise.allSettled([
      api.getRelayOverview(tenant.id),
      api.getRelayCustom(tenant.id),
      typeof api.getRelayModels === 'function' ? api.getRelayModels(tenant.id) : Promise.resolve(null)
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
    if (modelsResult.status === 'fulfilled' && modelsResult.value) {
      const models = normalizeModels(modelsResult.value.platformModels || modelsResult.value);
      platformModel.replaceChildren(h('option', { value: '' }, '选择套餐允许的模型'),
        ...models.map((model) => h('option', { value: model.id }, model.name)));
      if (!dirtyPlatform) platformModel.value = modelsResult.value.platformModel || platform?.model || '';
    }
    if (customResult.status === 'fulfilled') {
      custom = normalizeRelayCustom(customResult.value);
      if (!dirtyCustom) {
        baseUrlInput.value = custom.baseUrl;
        modelInput.value = custom.model;
        apiKeyInput.value = '';
      }
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
    const validation = validateRelayInput({ key: platformInput.value, model: platformModel.value }, { configured: platform?.configured });
    if (!validation.ok) {
      setAlert(platformAlert, validation.error, 'danger');
      return;
    }
    savingPlatform = true;
    setBusy(platformSave, true);
    try {
      const result = await api.updateRelayKey(tenant.id, validation.payload);
      if (!active) return;
      platformInput.value = '';
      dirtyPlatform = false;
      if (!validation.payload.key && typeof result?.key === 'string' && result.key) {
        const key = h('input', { class: 'input mono', type: 'text', value: result.key, readOnly: true, 'aria-label': '新签发的 Relay Key' });
        const close = h('button', { class: 'btn btn-primary', type: 'button' }, '我已保存');
        const modal = openModal({ root: modalRoot || document.getElementById('modal-root') || document.body,
          title: '新的 Relay Key', description: '密钥仅显示一次，请妥善保存。', content: key, footer: [close],
          onClose: () => { key.value = ''; } });
        close.addEventListener('click', () => modal.close('saved'));
      }
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
      dirtyCustom = false;
      updateCustom();
      toast?.show?.('自定义渠道已保存', { tone: 'success' });
    } catch (error) {
      if (active) setAlert(customAlert, apiErrorMessage(error, { fallback: '保存自定义渠道失败。' }), 'danger');
    } finally {
      savingCustom = false;
      if (active) setBusy(customSave, false);
    }
  }

  async function testCustom() {
    if (readOnly || !active || typeof api.testRelayCustom !== 'function') return;
    const baseUrl = baseUrlInput.value.trim();
    let parsed;
    try { parsed = new URL(baseUrl); } catch { /* reported below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      setAlert(customAlert, '请输入有效的 http(s) Base URL', 'danger');
      return;
    }
    const body = { baseUrl };
    if (apiKeyInput.value.trim()) body.apiKey = apiKeyInput.value.trim();
    setBusy(customTest, true); setAlert(customAlert, '', 'danger');
    try {
      const result = await api.testRelayCustom(tenant.id, body);
      if (!active) return;
      const connected = result?.connected ?? result?.test?.connected;
      const models = normalizeModels(result?.models || result?.test?.models || []);
      modelSuggestions.replaceChildren(...models.map((model) => h('option', { value: model.id }, model.name)));
      customStatus.textContent = connected
        ? `连接成功${Number.isFinite(Number(result?.latencyMs)) ? ` · ${Number(result.latencyMs)} ms` : ''} · 发现 ${models.length} 个模型。`
        : `连接失败：${redactText(result?.error || result?.test?.error || '请检查地址与密钥。', { maxLength: 240 })}`;
      if (connected && !modelInput.value && models[0]) modelInput.value = models[0].id;
    } catch (error) {
      if (active) setAlert(customAlert, apiErrorMessage(error, { fallback: '连接测试失败。' }), 'danger');
    } finally { if (active) setBusy(customTest, false); }
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
      dirtyCustom = false;
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
  customTest.addEventListener('click', () => { void testCustom(); });
  customDelete.addEventListener('click', () => { void deleteCustom(); });
  customCard.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); void saveCustom(); });
  for (const input of [platformInput, baseUrlInput, apiKeyInput, modelInput]) {
    input.addEventListener('input', () => {
      if (input === platformInput) dirtyPlatform = true; else dirtyCustom = true;
      setAlert(input === platformInput ? platformAlert : customAlert, '', 'danger');
    });
  }
  platformModel.addEventListener('change', () => { dirtyPlatform = true; });

  renderPage();
  void load();
  return {
    destroy() { active = false; root.replaceChildren(); },
    refresh: load,
    hasUnsavedChanges,
    canLeave
  };
}
