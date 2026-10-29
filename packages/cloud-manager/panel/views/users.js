import { h, clear, setBusy } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { formatDateTime } from '../lib/format.js';
import { badge } from '../lib/ui.js';
import { editDialog, labeled, selectInput } from './admin/shared.js';
import { apiErrorMessage } from '../lib/view-data.js';
import { alertBox, emptyBlock, errorBlock, pageHead, setAlert, skeletonGrid } from '../lib/ui.js';

export function mountUsers(container, { api, toast, navigate, modalRoot = null } = {}) {
  let active = true;
  let modal = null;
  let sequence = 0;
  let users = [];
  const content = h('div', {});
  const search = h('input', { class: 'input', id: 'admin-user-search', type: 'search', placeholder: '搜索用户名或 ID' });
  const roleFilter = selectInput('admin-user-role-filter', [['', '全部角色'], ['admin', '管理员'], ['user', '普通用户']], '');
  const statusFilter = selectInput('admin-user-status-filter', [['', '全部状态'], ['active', '正常'], ['disabled', '已禁用']], '');
  const filters = h('div', { class: 'workspace-filters' }, labeled('搜索用户', search), labeled('角色', roleFilter), labeled('状态', statusFilter));
  const refresh = h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => { void load(); } } }, '刷新');
  const create = h('button', { class: 'btn btn-primary', type: 'button', on: { click: openCreate } }, '＋ 创建用户');
  container.replaceChildren(pageHead({ eyebrow: 'Users', title: '用户管理', sub: '管理账号权限、状态及其拥有的实例。', actions: [refresh, create] }), filters, content);

  function renderUsers() {
    if (!active) return;
    const needle = search.value.trim().toLowerCase();
    const matching = users.filter((user) => (!needle || `${user.username} ${user.id}`.toLowerCase().includes(needle))
      && (!roleFilter.value || user.role === roleFilter.value)
      && (!statusFilter.value || Boolean(user.disabled) === (statusFilter.value === 'disabled')));
    clear(content);
    if (!matching.length) {
      content.appendChild(emptyBlock({ title: users.length ? '没有匹配的用户' : '还没有用户', message: users.length ? '调整筛选条件后重试。' : '创建用户后可为其创建实例。', symbol: '+' }));
      return;
    }
    content.appendChild(h('div', { class: 'tenant-grid' }, ...matching.map((user) => {
      const id = String(user.id ?? '');
      const lastAdmin = user.role === 'admin' && !user.disabled && users.filter((item) => item.role === 'admin' && !item.disabled).length <= 1;
      return h('article', { class: 'tenant-card', dataset: { userId: id } },
        h('div', { class: 'tenant-card-top' },
          h('strong', { class: 'tenant-card-name' }, user.username || id),
          badge(user.disabled ? '已禁用' : user.role === 'admin' ? '管理员' : '用户', user.disabled ? 'danger' : 'neutral')),
        h('p', { class: 'note' }, `拥有实例：${user.tenantCount ?? 0} · 最近登录：${formatDateTime(user.lastLoginAt ?? user.last_login_at)}`),
        h('div', { class: 'inline-buttons' },
          h('button', { class: `btn ${user.disabled ? 'btn-ghost' : 'btn-danger'} btn-sm`, type: 'button', disabled: lastAdmin, title: lastAdmin ? '保留至少一名活跃管理员' : '', on: { click: () => editUser(user, 'disabled') } }, user.disabled ? '启用账号' : '禁用账号'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => editUser(user, 'password') } }, '重置密码'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: lastAdmin, title: lastAdmin ? '保留至少一名活跃管理员' : '', on: { click: () => editUser(user, 'role') } }, '调整角色')),
        h('div', { class: 'tenant-card-foot' },
          h('span', { class: 'tenant-slug' }, `ID: ${id}`),
          h('a', { class: 'tenant-link', href: `#/users/${encodeURIComponent(id)}/instances` }, '查看拥有的实例 →')));
    })));
  }

  function editUser(user, kind) {
    const password = h('input', { class: 'input', id: 'admin-reset-password', type: 'password', autocomplete: 'new-password', minLength: 8 });
    const role = selectInput('admin-update-role', [['user', '普通用户'], ['admin', '管理员']], user.role || 'user');
    const title = kind === 'password' ? '重置密码' : kind === 'role' ? '调整角色' : user.disabled ? '启用账号' : '禁用账号';
    modal = editDialog({ api, toast, modalRoot }, {
      title: `${title} · ${user.username || user.id}`,
      fields: kind === 'password' ? [labeled('新密码', password, '至少 8 位，保存后清理该用户的旧会话。')] : kind === 'role' ? [labeled('平台角色', role)] : [h('p', { class: 'note' }, user.disabled ? '启用后该用户可重新登录。' : '禁用会立即使该用户的登录会话失效。')],
      submitLabel: title, danger: kind === 'disabled' && !user.disabled,
      async submit() {
        const body = kind === 'password' ? { password: password.value } : kind === 'role' ? { role: role.value } : { disabled: !user.disabled };
        if (kind === 'password' && password.value.length < 8) throw new Error('密码至少 8 位');
        if (api.updateUser) await api.updateUser(user.id, body);
        else await api.request(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body });
      },
      onSaved: () => { toast?.show?.('用户已更新', { tone: 'success' }); return load(); }
    });
  }
  search.addEventListener('input', renderUsers);
  roleFilter.addEventListener('change', renderUsers);
  statusFilter.addEventListener('change', renderUsers);

  async function load() {
    const request = ++sequence;
    clear(content);
    content.appendChild(skeletonGrid(2));
    setBusy(refresh, true);
    try {
      const payload = await api.getUsers();
      if (!active || request !== sequence) return;
      users = Array.isArray(payload?.users) ? payload.users : [];
      renderUsers();
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
