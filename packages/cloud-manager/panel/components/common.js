import { h } from '../lib/dom.js';

export const lines = (value) => Array.isArray(value) ? value.map(String).join('\n') : '';
export const entries = (value) => [...new Set(String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
export const field = (label, control, note = '') => h('label', { class: 'field' },
  h('span', { class: 'field-label' }, label), control, note ? h('span', { class: 'note' }, note) : null);
export const input = (value = '', options = {}) => h('input', { class: 'input', value, ...options });
export const textarea = (value = '', options = {}) => h('textarea', { class: 'input', rows: 4, value, ...options });
export const checkbox = (label, checked, disabled = false) => {
  const control = h('input', { type: 'checkbox', checked, disabled });
  return { control, node: h('label', { class: 'workspace-check' }, control, h('span', {}, label)) };
};
export const button = (label, onClick, disabled = false, kind = 'soft') => h('button', {
  class: `btn btn-${kind}`, type: 'button', disabled, on: { click: onClick }
}, label);
export const panel = (title, ...children) => h('section', { class: 'card card-pad workspace-section' }, h('h3', {}, title), ...children);

export async function perform(ctx, fn, success = '已保存') {
  try {
    const result = await fn();
    if (ctx.isActive?.() === false) return undefined;
    if (success) ctx.toast?.show?.(success, { tone: 'success' });
    return result === undefined ? null : result;
  } catch (error) {
    if (ctx.isActive?.() === false) return undefined;
    ctx.toast?.show?.(error?.message || '操作失败，请稍后重试。', { tone: 'danger' });
    return undefined;
  }
}

export async function filePayload(file) {
  if (!file) throw new Error('请选择文件。');
  if (file.size > 8 * 1024 * 1024) throw new Error('文件不能超过 8 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return { name: file.name, base64: btoa(binary) };
}

export function optionalCall(api, name, ...args) {
  return typeof api?.[name] === 'function' ? Promise.resolve().then(() => api[name](...args)) : Promise.resolve(null);
}
