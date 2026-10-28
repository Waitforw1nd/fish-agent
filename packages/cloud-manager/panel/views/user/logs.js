import { h, clear, setBusy } from '../../lib/dom.js';
import { normalizeRelayLogs } from '../../lib/user-data.js';
import { formatDateTime, formatMicros, formatNumber, redactText, truncate } from '../../lib/format.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { badge, emptyBlock, errorBlock } from '../../lib/ui.js';
import { renderTenantPrerequisite, resolveTenant, userHead } from './shared.js';

export function mountUserLogs({ root, api, toast, tenants = [], tenantId = '', tenantsError = '', retryTenants, onTenantChange } = {}) {
  let active = true;
  let loading = true;
  let requestSerial = 0;
  let logs = [];
  let loadError = '';
  const filters = { days: '7', model: '', status: '' };
  const tenant = resolveTenant(tenants, tenantId);
  if (!tenant) {
    renderTenantPrerequisite(root, { tenantsError, retryTenants, tenantId });
    return { destroy() { active = false; root.replaceChildren(); } };
  }

  const daysSelect = h('select', { class: 'select', id: 'log-days', name: 'days', 'aria-label': '日志天数' },
    h('option', { value: '1', selected: true }, '近 1 天'),
    h('option', { value: '7' }, '近 7 天'),
    h('option', { value: '30' }, '近 30 天'),
    h('option', { value: '90' }, '近 90 天')
  );
  daysSelect.value = filters.days;
  const modelInput = h('input', { class: 'input', id: 'log-model', name: 'model', type: 'text', placeholder: '全部模型', 'aria-label': '按模型筛选' });
  const statusSelect = h('select', { class: 'select', id: 'log-status', name: 'status', 'aria-label': '按状态筛选' },
    h('option', { value: '' }, '全部状态'),
    h('option', { value: 'success' }, '成功'),
    h('option', { value: 'error' }, '失败')
  );
  const applyButton = h('button', { class: 'btn btn-soft', type: 'submit' }, '应用筛选');
  const refreshButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '刷新');
  const head = userHead({
    eyebrow: 'Usage Logs', title: '调用日志', sub: '查看每次模型调用的状态、Token、费用和延迟；错误信息会脱敏展示。',
    tenants, tenant, onTenantChange, refresh: () => { void load(true); }
  });
  const result = h('div', {});
  const filterForm = h('form', { class: 'card card-pad user-filter-form' },
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'log-days' }, '时间范围'), daysSelect),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'log-model' }, '模型'), modelInput),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'log-status' }, '状态'), statusSelect),
    h('div', { class: 'user-filter-actions' }, applyButton, refreshButton)
  );
  root.replaceChildren(head, filterForm, result);

  function render() {
    if (!active) return;
    clear(result);
    if (loading) {
      result.appendChild(h('div', { class: 'card card-pad', 'aria-busy': 'true' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'note mt-14' }, '正在加载调用日志…')));
      return;
    }
    if (loadError) {
      result.appendChild(errorBlock({ title: '调用日志加载失败', message: loadError, onRetry: () => { void load(); } }));
      return;
    }
    if (!logs.length) {
      result.appendChild(emptyBlock({ title: '暂无调用日志', message: '当前筛选条件下没有记录，可调整时间、模型或状态后重试。', symbol: '—' }));
      return;
    }
    const rows = logs.map((log) => h('tr', {},
      h('td', {}, formatDateTime(log.time)),
      h('td', { class: 'cell-model', title: log.model }, log.model),
      h('td', {}, badge(log.statusLabel, log.status === 'success' ? 'ok' : 'danger', { dot: false })),
      h('td', {}, formatNumber(log.totalTokens)),
      h('td', { class: 'cell-cost' }, formatMicros(log.costMicros, log.currency)),
      h('td', {}, log.latencyMs === null ? '—' : `${formatNumber(log.latencyMs)} ms`),
      h('td', {}, log.source || '—'),
      h('td', { class: 'user-log-error', title: redactText(log.error, { maxLength: 600 }) }, log.error ? truncate(redactText(log.error), 100) : '—')
    ));
    result.appendChild(h('div', { class: 'card user-log-card' },
      h('div', { class: 'table-wrap' },
        h('table', { class: 'billing-table user-log-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, '时间'), h('th', {}, '模型'), h('th', {}, '状态'), h('th', {}, 'Token'),
            h('th', {}, '费用'), h('th', {}, '延迟'), h('th', {}, '来源'), h('th', {}, '错误')
          )),
          h('tbody', {}, ...rows)
        )
      )
    ));
  }

  async function load(notify = false) {
    if (!active) return;
    const serial = ++requestSerial;
    loading = true;
    loadError = '';
    render();
    setBusy(refreshButton, true);
    try {
      const payload = await api.getRelayLogs(tenant.id, { ...filters });
      if (!active || serial !== requestSerial) return;
      logs = normalizeRelayLogs(payload);
      loading = false;
      render();
      if (notify) toast?.show?.('日志已刷新');
    } catch (error) {
      if (!active || serial !== requestSerial) return;
      loading = false;
      loadError = apiErrorMessage(error, { fallback: '无法加载调用日志。' });
      render();
    } finally {
      if (active && serial === requestSerial) setBusy(refreshButton, false);
    }
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    filters.days = daysSelect.value;
    filters.model = modelInput.value.trim();
    filters.status = statusSelect.value;
    void load();
  });
  daysSelect.addEventListener('change', () => { filters.days = daysSelect.value; void load(); });
  statusSelect.addEventListener('change', () => { filters.status = statusSelect.value; void load(); });
  refreshButton.addEventListener('click', () => { void load(true); });

  void load();
  return {
    destroy() { active = false; requestSerial += 1; root.replaceChildren(); },
    refresh: load
  };
}
