// 原生前端角色卡导入入口的结构测试：
//   · 人设选择器有「导入角色卡」按钮
//   · 弹窗能真正打开，包含文件选择/预览/确认控件
//   · 事件绑定存在（openPersonaImportModal 可被调用，不抛错）
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadUiAppCode } = await import('./_ui-load.mjs');
let code = loadUiAppCode().code;
code = code.replace(/^export\s+(function|const|async function)/gm, '$1');

let pass = 0;
let fail = 0;
const check = (c, m, d) => {
  if (c) { pass++; console.log(`  ✓ ${m}`); }
  else { fail++; console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`); }
};

function makeEl() {
  const el = {
    innerHTML: '', className: '', textContent: '', style: {}, dataset: {}, files: [],
    disabled: false, checked: false, value: '', children: [], _q: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (el._handlers ||= {})[type] = fn; },
    removeEventListener() {}, remove() {},
    appendChild(c) { el.children.push(c); return c; },
    querySelector(sel) { el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, focus() {}, click() {},
    scrollIntoView() {}, insertBefore() {}, closest: () => null,
    dispatchEvent() {}
  };
  return el;
}
const document = {
  documentElement: makeEl(), body: makeEl(), head: makeEl(),
  querySelector: () => makeEl(), querySelectorAll: () => [],
  getElementById: () => makeEl(), createElement: () => makeEl(),
  addEventListener() {}, removeEventListener() {}
};
const sandbox = {
  document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert: () => {}, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {}, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } = await import('../src/tier-slider.js');
const { matchPriceTable } = await import('../src/model-prices.js');
Object.assign(sandbox, { TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable });

const ctx = vm.createContext(sandbox);
vm.runInContext(code, ctx, { filename: 'ui/app.js' });

check(typeof sandbox.openPersonaImportModal === 'function', 'openPersonaImportModal 已定义');
check(typeof sandbox.openPersonaPicker === 'function', 'openPersonaPicker 仍存在');
check(typeof sandbox.renderPersonaPicker === 'function', 'renderPersonaPicker 仍存在');

const pickerHtml = sandbox.renderPersonaPicker({ persona: {} });
check(pickerHtml.includes('import-persona-btn'), '人设选择器含「导入角色卡」按钮');
check(pickerHtml.includes('导入角色卡'), '按钮有可读文案');

const before = document.body.children.length;
sandbox.openPersonaImportModal();
const modal = document.body.children[document.body.children.length - 1];
check(document.body.children.length > before, '弹窗已挂到 body');
check(modal && String(modal.innerHTML).includes('SillyTavern'), '弹窗说明支持 SillyTavern 角色卡');
check(modal && String(modal.innerHTML).includes('pc-import-file'), '弹窗含文件选择控件');
check(modal && String(modal.innerHTML).includes('pc-import-greeting'), '弹窗含“包含开场白”开关（默认不勾选）');
check(modal && String(modal.innerHTML).includes('不会自动发送'), '明确告知开场白不会自动发送');

// 绑定检查：页面事件段确实把按钮接到了 openPersonaImportModal
const events = fs.readFileSync(path.join(ROOT, 'ui', 'app', '07-settings-events.js'), 'utf8');
check(events.includes("import-persona-btn") && events.includes('openPersonaImportModal'), '页面按钮已绑定导入弹窗');

console.log(`\n角色卡导入 UI：通过 ${pass}，失败 ${fail}`);
// UI 代码会建立轮询/计时器；断言完成后显式退出，避免测试进程挂住
process.exit(fail ? 1 : 0);
