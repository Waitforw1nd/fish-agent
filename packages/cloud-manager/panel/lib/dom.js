// 安全 DOM 构建工具：不使用 innerHTML，所有文本走 textContent。

const PROP_KEYS = new Set([
  'value', 'checked', 'selected', 'type', 'id', 'name', 'placeholder', 'title',
  'href', 'target', 'rel', 'autocomplete', 'maxLength', 'minLength', 'min', 'max',
  'step', 'rows', 'cols', 'htmlFor', 'role', 'tabIndex', 'readOnly', 'required',
  'multiple', 'accept', 'inputMode', 'spellcheck', 'form', 'disabled', 'hidden'
]);

const BOOLEAN_ATTRS = new Set(['disabled', 'hidden', 'required', 'readonly', 'multiple']);

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props || {});
  append(node, ...children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      const classes = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (classes) node.setAttribute('class', classes);
      continue;
    }
    if (key === 'text') {
      node.textContent = String(value);
      continue;
    }
    if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === undefined || dataValue === null) continue;
        node.setAttribute(`data-${dataKey}`, String(dataValue));
      }
      continue;
    }
    if (key === 'style') {
      for (const [styleKey, styleValue] of Object.entries(value)) {
        if (styleValue !== undefined && styleValue !== null) node.style[styleKey] = String(styleValue);
      }
      continue;
    }
    if (key === 'aria') {
      for (const [ariaKey, ariaValue] of Object.entries(value)) {
        if (ariaValue === undefined || ariaValue === null || ariaValue === false) continue;
        node.setAttribute(`aria-${ariaKey}`, ariaValue === true ? 'true' : String(ariaValue));
      }
      continue;
    }
    if (key === 'attrs') {
      for (const [attrKey, attrValue] of Object.entries(value)) {
        if (attrValue === undefined || attrValue === null || attrValue === false) continue;
        node.setAttribute(attrKey, attrValue === true ? '' : String(attrValue));
      }
      continue;
    }
    if (key === 'on') {
      for (const [eventName, handler] of Object.entries(value)) {
        if (typeof handler === 'function') node.addEventListener(eventName, handler);
      }
      continue;
    }
    if (key === 'ref' && typeof value === 'function') {
      value(node);
      continue;
    }
    if (key.startsWith('aria-')) {
      if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? 'true' : String(value));
      continue;
    }
    if (key === 'checked' || key === 'selected') {
      node[key] = Boolean(value);
      if (value) node.setAttribute(key, '');
      else node.removeAttribute(key);
      continue;
    }
    if (key === 'disabled' || key === 'hidden' || key === 'readOnly' || key === 'required' || key === 'multiple') {
      node[key] = Boolean(value);
      const attr = key === 'readOnly' ? 'readonly' : key;
      if (value) node.setAttribute(attr, '');
      else node.removeAttribute(attr);
      continue;
    }
    if (key === 'value') {
      node.value = value;
      continue;
    }
    if (key === 'htmlFor') {
      node.htmlFor = value;
      node.setAttribute('for', String(value));
      continue;
    }
    if (PROP_KEYS.has(key)) {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, String(value));
      }
      continue;
    }
    if (BOOLEAN_ATTRS.has(key)) {
      if (value) node.setAttribute(key, '');
      else node.removeAttribute(key);
      continue;
    }
    node.setAttribute(key, String(value));
  }
}

export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (typeof child === 'object' && typeof child.nodeType === 'number') {
      parent.appendChild(child);
    }
  }
  return parent;
}

export function clear(node) {
  if (!node) return node;
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setText(node, value) {
  if (node) node.textContent = String(value ?? '');
  return node;
}

export function setHidden(node, hidden) {
  if (!node) return;
  node.hidden = Boolean(hidden);
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

export function setAttr(node, name, value) {
  if (!node) return;
  if (value === false || value === null || value === undefined) node.removeAttribute(name);
  else node.setAttribute(name, value === true ? '' : String(value));
}

export function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.busyWasDisabled) {
      button.dataset.busyWasDisabled = button.disabled ? '1' : '0';
    }
    button.classList.add('is-loading');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.classList.remove('is-loading');
    button.disabled = button.dataset.busyWasDisabled === '1';
    delete button.dataset.busyWasDisabled;
    button.removeAttribute('aria-busy');
  }
}

export function selectValue(node, value) {
  if (!node) return;
  const text = String(value ?? '');
  node.value = text;
  for (const option of node.options || []) {
    option.selected = option.value === text;
  }
}

export function focusFirst(root) {
  if (!root) return;
  const candidate = root.querySelector?.(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]'
  );
  candidate?.focus?.();
}

export function isElement(node) {
  return Boolean(node) && typeof node === 'object' && typeof node.nodeType === 'number';
}
