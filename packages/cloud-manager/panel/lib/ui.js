// 视图共享片段：卡片、状态、空态、错误态与骨架屏。

import { h, setHidden } from '../lib/dom.js';

export function badge(label, tone = 'neutral', { dot = true } = {}) {
  return h('span', {
    class: `badge${dot ? '' : ' no-dot'}`,
    dataset: { tone }
  }, label);
}

export function setBadge(node, label, tone = 'neutral') {
  if (!node) return;
  node.textContent = label;
  node.dataset.tone = tone;
}

export function alertBox(message = '', tone = 'info', { hidden = false } = {}) {
  const text = h('span', { class: 'alert-text' }, message);
  const node = h('div', { class: 'alert', dataset: { tone }, role: 'status' },
    h('span', { class: 'alert-icon', 'aria-hidden': 'true' }, '!'),
    text
  );
  setHidden(node, hidden || !message);
  node._text = text;
  return node;
}

export function setAlert(node, message, tone = 'info') {
  if (!node) return;
  node._text.textContent = message;
  node.dataset.tone = tone;
  setHidden(node, !message);
}

export function spinner(size = '') {
  return h('span', { class: `spinner${size === 'lg' ? ' spinner-lg' : ''}`, 'aria-hidden': 'true' });
}

export function pageHead({ eyebrow = '', title = '', sub = '', actions = null } = {}) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-head-main' },
      eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null,
      h('h2', { class: 'page-title-lg' }, title),
      sub ? h('p', { class: 'page-sub' }, sub) : null
    ),
    actions ? h('div', { class: 'page-head-actions' }, actions) : null
  );
}

export function cardHead({ kicker = '', title = '', sub = '', actions = null, badge: badgeNode = null } = {}) {
  return h('div', { class: 'card-head' },
    h('div', { class: 'card-head-main' },
      kicker ? h('div', { class: 'card-kicker' }, kicker) : null,
      h('h3', { class: 'card-title' }, title),
      sub ? h('p', { class: 'card-sub' }, sub) : null
    ),
    (badgeNode || actions) ? h('div', { class: 'card-actions' }, badgeNode, actions) : null
  );
}

export function statusRow(label, value = '—', { tone = '', mono = false } = {}) {
  const valueNode = h('span', { class: `status-val${mono ? ' mono' : ''}${tone ? '' : ' muted'}`, dataset: tone ? { tone } : {} }, value);
  const row = h('div', { class: 'status-row' },
    h('span', { class: 'status-key' }, label),
    valueNode
  );
  return { row, value: valueNode };
}

export function setStatusValue(node, value, { tone = '', mono = false } = {}) {
  if (!node) return;
  node.textContent = value || '—';
  node.className = `status-val${mono ? ' mono' : ''}${tone ? '' : ' muted'}`;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

export function note(text) {
  return h('p', { class: 'note' }, text);
}

export function progressBar(ratio = 0, tone = '') {
  const inner = h('div', { class: 'progress-bar', style: { width: `${Math.max(0, Math.min(1, ratio)) * 100}%` } });
  const track = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)) }, inner);
  track._inner = inner;
  if (tone) inner.dataset.tone = tone;
  return track;
}

export function setProgress(track, ratio, tone = '') {
  if (!track) return;
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  track._inner.style.width = `${value * 100}%`;
  track.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  if (tone) track._inner.dataset.tone = tone;
  else delete track._inner.dataset.tone;
}

export function loadingBlock(message = '正在加载…', { rows = 4 } = {}) {
  return h('div', { class: 'card card-pad', 'aria-busy': 'true' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-head-main' },
        h('div', { class: 'skeleton skeleton-title' }),
        h('div', { class: 'skeleton skeleton-line', style: { width: '62%' } })
      )
    ),
    ...Array.from({ length: rows }, (_, index) =>
      h('div', {
        class: 'skeleton skeleton-line',
        style: { width: `${88 - index * 9}%`, height: index === 0 ? '26px' : '12px', marginBottom: index === 0 ? '18px' : '9px' }
      })
    ),
    message ? h('p', { class: 'note mt-14' }, message) : null
  );
}

export function skeletonGrid(count = 3) {
  return h('div', { class: 'tenant-grid' },
    ...Array.from({ length: count }, () => h('div', { class: 'skeleton skeleton-card' }))
  );
}

export function errorBlock({ title = '加载失败', message = '', onRetry = null, backHref = '', backLabel = '返回' } = {}) {
  return h('div', { class: 'card card-pad' },
    h('div', { class: 'empty-state', style: { border: '0', minHeight: '320px', background: 'transparent' } },
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '!'),
      h('p', { class: 'empty-title' }, title),
      h('p', { class: 'empty-sub' }, message || '请稍后重试。'),
      h('div', { class: 'empty-actions inline-buttons' },
        onRetry ? h('button', { class: 'btn btn-primary', type: 'button', on: { click: onRetry } }, '重试') : null,
        backHref ? h('a', { class: 'btn btn-ghost', href: backHref }, backLabel) : null
      )
    )
  );
}

export function emptyBlock({ title = '暂无数据', message = '', actions = null, symbol = '—' } = {}) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, symbol),
    h('p', { class: 'empty-title' }, title),
    message ? h('p', { class: 'empty-sub' }, message) : null,
    actions ? h('div', { class: 'empty-actions' }, actions) : null
  );
}

export function backLink(href, label = '返回租户总览') {
  return h('a', { class: 'btn btn-ghost btn-sm', href }, `← ${label}`);
}

export function switchRow({ title, description, checked = false, name = '', onChange = null, disabled = false }) {
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    name,
    checked,
    disabled,
    on: onChange ? { change: (event) => onChange(Boolean(event.target.checked), event) } : {}
  });
  const row = h('div', { class: 'subscription-row' },
    h('div', { class: 'subscription-copy' },
      h('strong', {}, title),
      description ? h('span', {}, description) : null
    ),
    h('label', { class: 'switch' },
      input,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' })
    )
  );
  return { row, input };
}

export function setSwitch(input, checked, disabled = false) {
  if (!input) return;
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
}

export function field({ label, hint = '', input, error = '', id = '' }) {
  const errorNode = h('p', { class: 'form-error', hidden: true });
  if (error) {
    errorNode.textContent = error;
    setHidden(errorNode, false);
  }
  const labelNode = h('label', { class: 'field-label', for: id }, label);
  return {
    node: h('div', { class: 'field' },
      h('div', { class: 'label-row' }, labelNode, hint ? h('span', { class: 'field-hint' }, hint) : null),
      input,
      errorNode
    ),
    error: errorNode,
    label: labelNode,
    input
  };
}

export function setFieldError(fieldRef, message) {
  if (!fieldRef?.input || !fieldRef.error) return;
  fieldRef.input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (message) setHidden(fieldRef.error, false);
  else setHidden(fieldRef.error, true);
  fieldRef.error.textContent = message || '';
}
