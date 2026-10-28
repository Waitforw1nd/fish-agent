// 原生弹窗：焦点回收、Esc/遮罩关闭、Tab 环内焦点。无第三方依赖。

import { append, clear, h } from './dom.js';

let modalCounter = 0;
const activeModals = new Set();

export function openModal({
  root,
  title,
  kicker = '',
  description = '',
  content = null,
  footer = null,
  wide = false,
  closeLabel = '关闭',
  initialFocus = null,
  onClose = null
} = {}) {
  if (!root) throw new TypeError('缺少弹窗容器');
  const titleId = `fc-modal-title-${++modalCounter}`;
  const previousFocus = typeof document !== 'undefined' ? document.activeElement : null;

  const closeButton = h('button', {
    class: 'modal-close',
    type: 'button',
    'aria-label': closeLabel,
    on: { click: () => close('button') }
  }, h('span', { 'aria-hidden': 'true' }, '×'));

  const body = h('div', { class: 'modal-body' });
  if (content) append(body, content);
  const foot = footer ? h('div', { class: `modal-foot${footer.length > 1 ? ' modal-foot-split' : ''}` }, footer) : null;

  const modal = h('div', {
    class: `modal${wide ? ' modal-wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabIndex: -1
  },
    h('div', { class: 'modal-head' },
      h('div', { class: 'modal-head-main' },
        kicker ? h('div', { class: 'modal-kicker' }, kicker) : null,
        h('h2', { class: 'modal-title', id: titleId }, title || ''),
        description ? h('p', { class: 'modal-sub' }, description) : null
      ),
      closeButton
    ),
    body,
    foot
  );

  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  let restoreBody = false;

  function onBackdrop(event) {
    if (event.target === backdrop) close('backdrop');
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      close('escape');
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = focusable(modal);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault?.();
      last.focus?.();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault?.();
      first.focus?.();
    }
  }

  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    document.removeEventListener?.('keydown', onKeydown);
    backdrop.remove?.();
    if (restoreBody) document.body?.classList?.remove('modal-open');
    try {
      if (previousFocus?.isConnected !== false && typeof previousFocus?.focus === 'function') previousFocus.focus();
    } catch {
      // 焦点元素可能已被视图销毁
    }
    activeModals.delete(instance);
    if (typeof onClose === 'function') onClose(reason);
  }

  backdrop.addEventListener('click', onBackdrop);
  document.addEventListener?.('keydown', onKeydown);
  root.appendChild(backdrop);

  const hadModal = root.querySelectorAll?.('.modal-backdrop').length > 1;
  if (!hadModal) {
    document.body?.classList?.add('modal-open');
    restoreBody = true;
  }

  setTimeout(() => {
    if (closed) return;
    const target = initialFocus || modal.querySelector?.('input:not([type="hidden"]), select, textarea, button:not(.modal-close)') || modal;
    target?.focus?.();
  }, 0);

  const instance = {
    backdrop,
    modal,
    body,
    footer: foot,
    close,
    setContent(nextContent) {
      clear(body);
      if (nextContent) append(body, nextContent);
    },
    isOpen: () => !closed
  };
  activeModals.add(instance);
  return instance;
}

export function closeAllModals() {
  for (const modal of [...activeModals]) {
    try {
      modal.close('all');
    } catch {
      // 单个弹窗清理失败不应阻塞路由切换
    }
  }
  activeModals.clear();
  if (typeof document !== 'undefined') document.body?.classList?.remove('modal-open');
}

function focusable(root) {
  try {
    return [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
  } catch {
    return [];
  }
}

export function confirmDialog({
  root,
  title = '确认操作',
  message = '',
  detail = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const content = h('div', { class: 'modal-form' },
      h('p', { class: 'note', style: { fontSize: '12.5px', color: 'var(--ink)', lineHeight: '1.65' } }, message),
      detail ? h('p', { class: 'note' }, detail) : null
    );
    const dialog = openModal({
      root,
      title,
      content,
      footer: [
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          on: { click: () => { settle(false); dialog.close('cancel'); } }
        }, cancelText),
        h('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          on: { click: () => { settle(true); dialog.close('confirm'); } }
        }, confirmText)
      ],
      onClose: () => settle(false)
    });
  });
}
