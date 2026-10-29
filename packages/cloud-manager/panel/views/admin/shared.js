import { h, clear, setBusy, selectValue } from '../../lib/dom.js';
import { openModal } from '../../lib/modal.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { alertBox, setAlert, emptyBlock, errorBlock, pageHead, loadingBlock } from '../../lib/ui.js';

export function queryPath(path, values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value !== undefined && value !== null) params.set(key, String(value));
  }
  return `${path}${params.size ? `?${params}` : ''}`;
}

export function rows(payload, key) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

export function selectInput(id, options, value = '') {
  const input = h('select', { id, class: 'input', name: id },
    ...options.map(([key, label]) => h('option', { value: key }, label)));
  selectValue(input, value);
  return input;
}

export function labeled(label, input, hint = '') {
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: input.id }, label),
    input, hint ? h('p', { class: 'note' }, hint) : null);
}

export function dataTable(columns, items, { empty = '暂无记录' } = {}) {
  if (!items.length) return emptyBlock({ title: empty });
  return h('div', { class: 'workspace-table-wrap' },
    h('table', { class: 'workspace-table' },
      h('thead', {}, h('tr', {}, ...columns.map((column) => h('th', { scope: 'col' }, column.label)))),
      h('tbody', {}, ...items.map((item) => h('tr', {}, ...columns.map((column) => h('td', {}, column.value(item))))))));
}

export function createAdminPage(root, ctx, { title, sub = '', actions = [] }) {
  let alive = true;
  let version = 0;
  let loader = null;
  const cleanups = new Set();
  const content = h('div', { class: 'workspace-content' });
  const notice = alertBox('', 'danger', { hidden: true });
  const refresh = h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => { void reload(); } } }, '刷新');
  root.replaceChildren(pageHead({ eyebrow: '平台管理', title, sub, actions: [refresh, ...actions] }), notice, content);

  async function reload() {
    if (!alive || !loader) return;
    const current = ++version;
    clear(content);
    content.appendChild(loadingBlock());
    setBusy(refresh, true);
    try {
      const node = await loader();
      if (!alive || current !== version) return;
      content.replaceChildren(node);
    } catch (error) {
      if (!alive || current !== version) return;
      content.replaceChildren(errorBlock({ title: `${title}加载失败`, message: apiErrorMessage(error), onRetry: () => { void reload(); } }));
    } finally {
      if (alive && current === version) setBusy(refresh, false);
    }
  }

  async function perform(button, operation, message = '已保存', { refreshPage = true } = {}) {
    if (!alive || button?.disabled) return;
    setBusy(button, true);
    setAlert(notice, '', 'danger');
    try {
      const result = await operation();
      if (!alive) return result;
      ctx.toast?.show?.(message, { tone: 'success' });
      if (refreshPage) await reload();
      return result;
    } catch (error) {
      if (alive) setAlert(notice, apiErrorMessage(error), 'danger');
      return null;
    } finally {
      if (alive) setBusy(button, false);
    }
  }

  return {
    content, notice, reload, refresh: reload, perform,
    alive: () => alive,
    load(fn) { loader = fn; void reload(); },
    cleanup(fn) { cleanups.add(fn); },
    destroy() {
      alive = false;
      version++;
      for (const fn of cleanups) fn();
      cleanups.clear();
      root.replaceChildren();
    }
  };
}

export function editDialog(ctx, { title, fields, submitLabel = '保存', danger = false, submit, onSaved }) {
  let pending = false;
  const error = alertBox('', 'danger', { hidden: true });
  const form = h('form', { class: 'modal-form' }, ...fields, error);
  const button = h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, submitLabel);
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, '取消');
  const modal = openModal({
    root: ctx.modalRoot || document.getElementById('modal-root') || document.body,
    title, content: form, footer: [cancel, button],
    onClose() { for (const input of form.querySelectorAll('input[type="password"]')) input.value = ''; }
  });
  cancel.addEventListener('click', () => modal.close());
  async function save(event) {
    event?.preventDefault?.();
    if (pending || !modal.isOpen()) return;
    pending = true;
    setBusy(button, true);
    setAlert(error, '', 'danger');
    try {
      await submit();
      if (!modal.isOpen()) return;
      modal.close('saved');
      await onSaved?.();
    } catch (err) {
      if (modal.isOpen()) setAlert(error, apiErrorMessage(err), 'danger');
    } finally {
      pending = false;
      setBusy(button, false);
    }
  }
  button.addEventListener('click', save);
  form.addEventListener('submit', save);
  return modal;
}

export async function zipPayload(file) {
  if (!file || !/\.zip$/i.test(file.name)) throw new Error('请选择 ZIP 插件包');
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error('插件包大小需为 1 字节至 8 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return { filename: file.name, base64: btoa(text) };
}
