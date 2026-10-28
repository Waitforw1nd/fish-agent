// TRPG 骰子指令（确定性型插件）
//
// 处理 `.r 3d6+2` / `!r d20` / `。r 3#1d20` / `掷骰 2d6`。
// 通过 message.command 能力在进 LLM 前处理：命中即回复，不消耗 token；
// 非命令返回 {handled:false}，核心继续走正常对话。
//
// ⚠️ 集成点：当前上游核心没有 message.command 的调用点。orchestrator 需要在
// wake 前调用 skillManager.runMessageCommands({ ...skillContext, text })，
// 命中后把 replies 交给 sender.sendTextBatch 并 return（不再进模型）。
// 本插件已把解析/回复/边界全部实现为可测试的纯函数，核心补上这一处即可生效。
import crypto from 'node:crypto';

const DEFAULT_SETTINGS = Object.freeze({
  defaultDice: '1d100',
  maxDice: 100,
  maxSides: 10000,
  maxTerms: 20,
  maxRepeat: 10,
  showDetail: true
});

const COMMAND_PREFIX = /^\s*(?:[.．。!！/／]r|掷骰)(?:\s+|$)/i;
const MAX_REPLY_CHARS = 500;

let configFn = () => ({ ...DEFAULT_SETTINGS });

function cfg() {
  let raw = {};
  try { raw = configFn() || {}; } catch { raw = {}; }
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  const int = (v, fallback, min, max) => {
    const n = Number(v);
    return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : fallback));
  };
  return {
    defaultDice: String(merged.defaultDice || '1d100'),
    maxDice: int(merged.maxDice, 100, 1, 1000),
    maxSides: int(merged.maxSides, 10000, 2, 100000),
    maxTerms: int(merged.maxTerms, 20, 1, 50),
    maxRepeat: int(merged.maxRepeat, 10, 1, 50),
    showDetail: merged.showDetail !== false
  };
}

function parseTerm(term) {
  let m = /^(\d*)d(\d+)$/i.exec(term);
  if (m) {
    const count = m[1] ? Number(m[1]) : 1;
    const sides = Number(m[2]);
    return { type: 'dice', count, sides };
  }
  m = /^\d+$/.exec(term);
  if (m) return { type: 'modifier', value: Number(term) };
  return null;
}

/**
 * 解析掷骰指令。
 * @returns {{command:boolean, ok?:boolean, error?:string, repeat?:number, terms?:Array, expression?:string, diceCount?:number}}
 */
export function parseDiceCommand(text, options = {}) {
  const conf = { ...cfg(), ...(options.config || {}) };
  const raw = String(text ?? '');
  if (!COMMAND_PREFIX.test(raw)) return { command: false };
  let body = raw.replace(COMMAND_PREFIX, '').trim();
  if (!body) body = conf.defaultDice;

  let repeat = 1;
  const repeatMatch = /^(\d+)\s*#\s*/.exec(body);
  if (repeatMatch) {
    repeat = Number(repeatMatch[1]);
    body = body.slice(repeatMatch[0].length).trim();
  }
  if (!body) return { command: true, ok: false, error: '骰子公式为空' };
  if (repeat < 1 || repeat > conf.maxRepeat) {
    return { command: true, ok: false, error: `重复次数需在 1~${conf.maxRepeat} 之间` };
  }

  const compact = body.replace(/\s+/g, '');
  if (!/^[0-9dD+\-]+$/.test(compact)) {
    return { command: true, ok: false, error: `无法识别的骰子公式：${body.slice(0, 40)}` };
  }
  const tokens = compact.split(/([+\-])/);
  if (tokens.some((t) => t === '') && compact.startsWith('+')) {
    return { command: true, ok: false, error: '公式不能以 + 开头' };
  }

  const terms = [];
  let sign = 1;
  let expectTerm = true;
  for (const token of tokens) {
    if (token === '+') { sign = 1; expectTerm = true; continue; }
    if (token === '-') { sign = -1; expectTerm = true; continue; }
    if (!expectTerm) return { command: true, ok: false, error: '公式运算符位置错误' };
    const term = parseTerm(token);
    if (!term) return { command: true, ok: false, error: `无法识别的项：${token.slice(0, 30)}` };
    if (term.type === 'dice') {
      if (term.sides < 2 || term.sides > conf.maxSides) {
        return { command: true, ok: false, error: `骰子面数需在 2~${conf.maxSides} 之间` };
      }
      if (term.count < 1) return { command: true, ok: false, error: '骰子数量至少为 1' };
      terms.push({ ...term, sign });
    } else {
      terms.push({ ...term, sign });
    }
    expectTerm = false;
    if (terms.length > conf.maxTerms) {
      return { command: true, ok: false, error: `公式项数过多（最多 ${conf.maxTerms} 项）` };
    }
  }
  if (expectTerm || !terms.length) return { command: true, ok: false, error: '公式不完整' };

  let diceCount = 0;
  for (const t of terms) {
    if (t.type !== 'dice') continue;
    diceCount += t.count * repeat;
    if (diceCount > conf.maxDice) {
      return { command: true, ok: false, error: `骰子总数超过上限（${conf.maxDice}）` };
    }
  }

  const expression = terms.map((t, i) => {
    const signText = t.sign < 0 ? '-' : (i === 0 ? '' : '+');
    return `${signText}${t.type === 'dice' ? `${t.count}d${t.sides}` : t.value}`;
  }).join('');

  return { command: true, ok: true, repeat, terms, expression, diceCount };
}

function rollOnce(terms, rng) {
  const pieces = [];
  let total = 0;
  let detailed = true;
  const totalDice = terms.reduce((n, t) => n + (t.type === 'dice' ? t.count : 0), 0);
  if (totalDice > 20) detailed = false;
  for (const term of terms) {
    if (term.type === 'modifier') {
      total += term.sign * term.value;
      pieces.push(`${term.sign < 0 ? '-' : '+'} ${term.value}`);
      continue;
    }
    const rolls = [];
    for (let i = 0; i < term.count; i++) rolls.push(rng(term.sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    total += term.sign * sum;
    const signText = term.sign < 0 ? '-' : '';
    pieces.push(detailed
      ? `${signText}${term.count}d${term.sides}[${rolls.join(',')}]`
      : `${signText}${term.count}d${term.sides}`);
  }
  // 第一项若为正数，去掉开头的 +，读起来更自然
  let detail = pieces.join(' ');
  if (detail.startsWith('+ ')) detail = detail.slice(2);
  else if (detail.startsWith('+')) detail = detail.slice(1);
  return { total, detail, detailed };
}

function defaultRng(sides) {
  return crypto.randomInt(1, sides + 1);
}

/** 执行解析结果；rng 可注入（测试用）。 */
export function rollDice(parsed, { rng = defaultRng } = {}) {
  if (!parsed?.ok) throw new Error(parsed?.error || '骰子公式无效');
  const rounds = [];
  for (let i = 0; i < parsed.repeat; i++) rounds.push(rollOnce(parsed.terms, rng));
  if (parsed.repeat === 1) {
    const r = rounds[0];
    const text = `🎲 ${parsed.expression} = ${r.detail} = ${r.total}`;
    return text.slice(0, MAX_REPLY_CHARS);
  }
  const lines = rounds.map((r, i) => `第${i + 1}次：${r.total}`).join('；');
  return `🎲 ${parsed.repeat}#${parsed.expression}：${lines}`.slice(0, MAX_REPLY_CHARS);
}

const USAGE = '用法：.r 1d20 / .r 3d6+2 / .r 3#1d20（别名 !r、。r、掷骰）';

/** message.command 能力的实现：命中返回 replies，未命中 handed:false。 */
export function handleMessageCommand(text, options = {}) {
  const parsed = parseDiceCommand(text, options);
  if (!parsed.command) return { handled: false };
  if (!parsed.ok) return { handled: true, replies: [`${parsed.error}。${USAGE}`], result: { ok: false, error: parsed.error } };
  try {
    return { handled: true, replies: [rollDice(parsed, options)], result: parsed };
  } catch (error) {
    return { handled: true, replies: [`掷骰失败：${error?.message ?? error}`], result: { ok: false } };
  }
}

export const providers = {
  'message.command': (context = {}) => handleMessageCommand(context.text ?? context.message ?? '', {
    config: cfg()
  })
};

export function setup(api) {
  if (typeof api?.config === 'function') configFn = api.config;
}

export function activate() { /* 无定时器/监听，纯函数 */ }
export function deactivate() { /* 同上 */ }
