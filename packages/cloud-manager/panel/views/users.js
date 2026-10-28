import { h, clear, setBusy } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { apiErrorMessage } from '../lib/view-data.js';
import { alertBox, emptyBlock, errorBlock, pageHead, setAlert, skeletonGrid } from '../lib/ui.js';

export function mountUsers(container, { api, toast, navigate, modalRoot = null } = {}) {
  let active = true;
  let modal = null;
  let sequence = 0;
  const content = h('div', {});
  const refresh = h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => { void load(); } } }, '刷新');
  const create = h('button', { class: 'btn btn-primary', type: 'button', on: { click: openCreate } }, '＋ 创建用户');
  container.replaceChildren(pageHead({ eyebrow: 'Users', title: '用户管理', sub: '查看平台用户及其拥有的实例。', actions: [refresh, create] }), content);

  async function load() {
    const request = ++sequence;
    clear(content);
    content.appendChild(skeletonGrid(2));
    setBusy(refresh, true);
    try {
      const payload = await api.getUsers();
      if (!active || request !== sequence) return;
      const users = Array.isArray(payload?.users) ? payload.users : [];
      clear(content);
      if (!users.length) {
        content.appendChild(emptyBlock({ title: '还没有用户', message: '创建用户后可为其创建实例。', symbol: '+' }));
        return;
      }
      content.appendChild(h('div', { class: 'tenant-grid' }, ...users.map((user) => {
        const id = String(user.id ?? '');
        const url = `#/users/${encodeURIComponent(id)}/instances`;
        return h('article', { class: 'tenant-card', dataset: { userId: id } },
          h('div', { class: 'tenant-card-top' },
            h('strong', { class: 'tenant-card-name' }, user.username || id),
            h('span', { class: 'tenant-slug' }, user.role === 'admin' ? '管理员' : '用户')
          ),
          h('div', { class: 'tenant-card-foot' },
            h('span', { class: 'tenant-slug' }, `ID: ${id}`),
            h('a', { class: 'tenant-link', href: url }, '查看拥有的实例 →')
          )
        );
      })));
    } catch (error) {
      if (!active || request !== sequence) return;
      clear(content);
      content.appendChild(errorBlock({ title: '用户列表加载失败', message: apiErrorMessage(error, { fallback: '无法加载用户列表。' }), onRetry: () => { void load(); } }));
    } finally {
      if (active && request === sequence) setBusy(refresh, false);
    }
  }

  function openCreate() {
    if (!active || modal?.isOpen()) return;
    const username = h('input', { class: 'input', id: 'admin-create-username', name: 'username', autocomplete: 'off', maxLength: 64 });
    const password = h('input', { class: 'input', id: 'admin-create-password', name: 'password', type: 'password', autocomplete: 'new-password' });
    const role = h('select', { class: 'input', id: 'admin-create-role', name: 'role' },
      h('option', { value: 'user' }, '用户'), h('option', { value: 'admin' }, '管理员'));
    const error = alertBox('', 'danger', { hidden: true });
    const form = h('form', { class: 'modal-form', novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'admin-create-username' }, '用户名'), username),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'admin-create-password' }, '密码'), password),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'admin-create-role' }, '角色'), role),
      h('p', { class: 'note' }, '用户名为 3–64 位字母、数字或 _ . -；密码至少 8 位。'), error);
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, '创建用户');
    modal = openModal({ root: modalRoot || document.getElementById('modal-root') || document.body, title: '创建用户', content: form, footer: [cancel, submit], onClose: () => { password.value = ''; } });
    const dialog = modal;
    cancel.addEventListener('click', () => dialog.close('cancel'));
    let submitting = false;
    async function submitForm() {
      if (!active || !dialog.isOpen() || submitting) return;
      const name = username.value.trim();
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(name)) return setAlert(error, '用户名需为 3–64 位字母、数字或 _ . -', 'danger');
      if (password.value.length < 8) return setAlert(error, '密码至少 8 位', 'danger');
      submitting = true;
      setBusy(submit, true);
      setAlert(error, '', 'danger');
      try {
        await api.createUser({ username: name, password: password.value, role: role.value });
        if (!active) return;
        dialog.close('created');
        toast?.show?.('用户已创建', { tone: 'success' });
        await load();
      } catch (err) {
        if (active && dialog.isOpen()) setAlert(error, apiErrorMessage(err, { fallback: '创建用户失败。' }), 'danger');
      } finally {
        submitting = false;
        if (active) setBusy(submit, false);
      }
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); void submitForm(); });
    submit.addEventListener('click', () => { void submitForm(); });
  }

  void load();
  return { destroy() { active = false; sequence++; modal?.close('destroy'); container.replaceChildren(); }, refresh: load };
}
