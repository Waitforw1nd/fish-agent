// 最小 DOM 桩：仅覆盖面板所需的元素、属性、事件冒泡、选择器与焦点行为。
// 目的不是模拟浏览器布局，而是让视图交互（提交、切换、弹窗、轮询）可在 node:test 中执行。

export class StubEvent {
  constructor(type, { bubbles = false, cancelable = true, detail = null } = {}) {
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    this.detail = detail;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._propagationStopped = false;
    this._immediateStopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this._propagationStopped = true;
  }

  stopImmediatePropagation() {
    this._immediateStopped = true;
    this._propagationStopped = true;
  }
}

class StubNode {
  constructor(ownerDocument, nodeType) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node.nodeType === 9) return true;
      node = node.parentNode;
    }
    return false;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.nodeType === 11) {
      for (const item of [...child.childNodes]) this.appendChild(item);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      this.appendChild(typeof node === 'object' ? node : this.ownerDocument.createTextNode(String(node)));
    }
  }

  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'object' ? node : this.ownerDocument.createTextNode(String(node));
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.unshift(child);
    }
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    const path = [];
    let node = this;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    for (const current of path) {
      event.currentTarget = current;
      const list = current._listeners?.get(event.type);
      if (list) {
        for (const handler of [...list]) {
          try {
            handler.call(current, event);
          } catch (error) {
            queueMicrotask(() => { throw error; });
          }
          if (event._immediateStopped) break;
        }
      }
      if (event._immediateStopped || event._propagationStopped) break;
      if (!event.bubbles && current !== this) break;
    }
    return !event.defaultPrevented;
  }

  get textContent() {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? '');
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  getElementsByTagName(tag) {
    return queryAll(this, tag);
  }
}

class StubText extends StubNode {
  constructor(ownerDocument, data) {
    super(ownerDocument, 3);
    this.data = String(data);
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value) {
    this.data = String(value ?? '');
  }
}

class StubElement extends StubNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument, 1);
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this._style = {};
    this._value = undefined;
    this._datasetProxy = null;
    this._styleProxy = null;
  }

  get attributes() {
    return [...this._attrs.entries()].map(([name, value]) => ({ name, value }));
  }

  setAttribute(name, value) {
    this._attrs.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
  }

  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return next;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get classList() {
    if (!this._classList) {
      const element = this;
      this._classList = {
        add(...names) {
          const set = new Set(element.className.split(/\s+/).filter(Boolean));
          for (const name of names) if (name) set.add(String(name));
          element.className = [...set].join(' ');
        },
        remove(...names) {
          const remove = new Set(names.map(String));
          element.className = element.className.split(/\s+/).filter((name) => name && !remove.has(name)).join(' ');
        },
        contains(name) {
          return element.className.split(/\s+/).includes(String(name));
        },
        toggle(name, force) {
          const has = this.contains(name);
          const next = force === undefined ? !has : Boolean(force);
          if (next) this.add(name);
          else this.remove(name);
          return next;
        },
        get length() {
          return element.className.split(/\s+/).filter(Boolean).length;
        },
        item(index) {
          return element.className.split(/\s+/).filter(Boolean)[index] || null;
        }
      };
    }
    return this._classList;
  }

  get dataset() {
    if (!this._datasetProxy) {
      const element = this;
      this._datasetProxy = new Proxy({}, {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          return element.getAttribute(`data-${camelToKebab(prop)}`);
        },
        set(_target, prop, value) {
          element.setAttribute(`data-${camelToKebab(String(prop))}`, value);
          return true;
        },
        deleteProperty(_target, prop) {
          element.removeAttribute(`data-${camelToKebab(String(prop))}`);
          return true;
        },
        has(_target, prop) {
          return element.hasAttribute(`data-${camelToKebab(String(prop))}`);
        },
        ownKeys() {
          return [...element._attrs.keys()].filter((key) => key.startsWith('data-'));
        },
        getOwnPropertyDescriptor(_target, prop) {
          const value = element.getAttribute(`data-${camelToKebab(String(prop))}`);
          return value === null ? undefined : { configurable: true, enumerable: true, value };
        }
      });
    }
    return this._datasetProxy;
  }

  get style() {
    if (!this._styleProxy) {
      const store = this._style;
      this._styleProxy = new Proxy(store, {
        get(target, prop) {
          if (prop === 'setProperty') return (name, value) => { target[name] = String(value); };
          if (prop === 'removeProperty') return (name) => { delete target[name]; };
          return target[prop] ?? '';
        },
        set(target, prop, value) {
          target[prop] = String(value);
          return true;
        }
      });
    }
    return this._styleProxy;
  }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

  get checked() { return this.hasAttribute('checked'); }
  set checked(value) { if (value) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }

  get selected() { return this.hasAttribute('selected'); }
  set selected(value) { if (value) this.setAttribute('selected', ''); else this.removeAttribute('selected'); }

  get required() { return this.hasAttribute('required'); }
  set required(value) { if (value) this.setAttribute('required', ''); else this.removeAttribute('required'); }

  get readOnly() { return this.hasAttribute('readonly'); }
  set readOnly(value) { if (value) this.setAttribute('readonly', ''); else this.removeAttribute('readonly'); }

  get multiple() { return this.hasAttribute('multiple'); }
  set multiple(value) { if (value) this.setAttribute('multiple', ''); else this.removeAttribute('multiple'); }

  get name() { return this.getAttribute('name') || ''; }
  set name(value) { this.setAttribute('name', value); }

  get type() {
    if (this.hasAttribute('type')) return this.getAttribute('type');
    return this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : '';
  }

  set type(value) { this.setAttribute('type', value); }

  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(value) { this.setAttribute('placeholder', value); }

  get title() { return this.getAttribute('title') || ''; }
  set title(value) { this.setAttribute('title', value); }

  get href() { return this.getAttribute('href') || ''; }
  set href(value) { this.setAttribute('href', value); }

  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }

  get alt() { return this.getAttribute('alt') || ''; }
  set alt(value) { this.setAttribute('alt', value); }

  get role() { return this.getAttribute('role') || ''; }
  set role(value) { this.setAttribute('role', value); }

  get autocomplete() { return this.getAttribute('autocomplete') || ''; }
  set autocomplete(value) { this.setAttribute('autocomplete', value); }

  get htmlFor() { return this.getAttribute('for') || ''; }
  set htmlFor(value) { this.setAttribute('for', value); }

  get tabIndex() { return Number(this.getAttribute('tabindex') || 0); }
  set tabIndex(value) { this.setAttribute('tabindex', value); }

  get maxLength() { return Number(this.getAttribute('maxlength') || 0); }
  set maxLength(value) { this.setAttribute('maxlength', value); }

  get form() {
    return this.closest('form');
  }

  get options() {
    if (this.localName !== 'select') return [];
    return queryAll(this, 'option');
  }

  get selectedOptions() {
    return this.options.filter((option) => option.selected);
  }

  get selectedIndex() {
    return this.options.findIndex((option) => option.selected);
  }

  get value() {
    if (this.localName === 'select') {
      const selected = this.selectedOptions[0] || this.options.find((option) => option.value === this._value);
      if (selected) return selected.value;
      return this._value === undefined ? (this.options[0]?.value || '') : String(this._value);
    }
    if (this.localName === 'option') {
      return this._value === undefined ? (this.getAttribute('value') ?? this.textContent) : String(this._value);
    }
    if (this._value !== undefined) return this._value;
    return this.getAttribute('value') ?? '';
  }

  set value(value) {
    const text = String(value ?? '');
    this._value = text;
    if (this.localName === 'select') {
      for (const option of this.options) option.selected = option.value === text;
    }
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.ownerDocument.activeElement = this;
  }

  click() {
    if (this.disabled) return false;
    const event = new StubEvent('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  scrollIntoView() {}

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
}

class StubDocument extends StubNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.documentElement = new StubElement(this, 'html');
    this.body = new StubElement(this, 'body');
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    this.hidden = false;
  }

  createElement(tagName) {
    return new StubElement(this, tagName);
  }

  createTextNode(data) {
    return new StubText(this, data);
  }

  createDocumentFragment() {
    const fragment = new StubNode(this, 11);
    return fragment;
  }

  getElementById(id) {
    return this.querySelector(`#${cssEscape(id)}`);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

function camelToKebab(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function cssEscape(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}

function queryAll(root, selector) {
  if (!selector) return [];
  const groups = splitGroups(String(selector));
  const result = [];
  for (const node of collectElements(root)) {
    if (groups.some((group) => matchesComplex(node, group, root))) {
      if (!result.includes(node)) result.push(node);
    }
  }
  return result;
}

function collectElements(root) {
  const result = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        result.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return result;
}

function splitGroups(selector) {
  const groups = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of selector) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) groups.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) groups.push(current.trim());
  return groups;
}

function tokenize(selector) {
  const tokens = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of selector.trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function matchesComplex(node, group, scopeRoot) {
  const tokens = tokenize(group);
  if (!tokens.length) return false;
  if (!matchesCompound(node, tokens[tokens.length - 1])) return false;
  let cursor = node.parentElement;
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    let found = null;
    while (cursor) {
      if (matchesCompound(cursor, tokens[i])) {
        found = cursor;
        break;
      }
      cursor = cursor.parentElement;
    }
    if (!found) return false;
    cursor = found.parentElement;
  }
  return true;
}

function matchesSelector(node, selector) {
  if (!selector) return false;
  return splitGroups(selector).some((group) => {
    const tokens = tokenize(group);
    return tokens.length === 1 && matchesCompound(node, tokens[0]);
  });
}

function matchesCompound(node, compound) {
  if (!node || node.nodeType !== 1) return false;
  let rest = compound;
  if (rest === '*') return true;

  const tag = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    if (node.localName !== tag[1].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }

  while (rest) {
    let match;
    if ((match = /^#([\w-]+)/.exec(rest))) {
      if (node.id !== match[1]) return false;
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = /^\.([\w-]+)/.exec(rest))) {
      if (!node.classList.contains(match[1])) return false;
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = /^\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) {
      const name = match[1];
      const expected = match[2] ?? match[3] ?? match[4];
      if (!node.hasAttribute(name)) return false;
      if (expected !== undefined && node.getAttribute(name) !== expected) return false;
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = /^:not\(([^)]+)\)/.exec(rest))) {
      const inner = match[1].trim();
      if (matchesCompound(node, inner)) return false;
      rest = rest.slice(match[0].length);
      continue;
    }
    if ((match = /^:([\w-]+)/.exec(rest))) {
      if (match[1] === 'checked' && !node.checked) return false;
      if (match[1] === 'disabled' && !node.disabled) return false;
      rest = rest.slice(match[0].length);
      continue;
    }
    return false;
  }
  return true;
}

export function createDocument() {
  return new StubDocument();
}

export function installDom() {
  const document = createDocument();
  globalThis.document = document;
  globalThis.Event = StubEvent;
  globalThis.CustomEvent = StubEvent;
  globalThis.Node = StubNode;
  globalThis.HTMLElement = StubElement;
  if (!globalThis.location) {
    globalThis.location = { origin: 'http://localhost', hash: '' };
  }
  return document;
}

export function appendRoot(document, id = 'test-root') {
  const root = document.createElement('div');
  root.id = id;
  document.body.appendChild(root);
  const modalRoot = document.createElement('div');
  modalRoot.id = 'modal-root';
  document.body.appendChild(modalRoot);
  return { root, modalRoot };
}

export function findByText(root, tag, text) {
  return collectElements(root).find((node) => node.localName === String(tag).toLowerCase() && node.textContent.includes(text)) || null;
}

export function findAll(root, selector) {
  return root.querySelectorAll(selector);
}

export function fire(node, type, init = {}) {
  const event = new StubEvent(type, { bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
}

export async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
