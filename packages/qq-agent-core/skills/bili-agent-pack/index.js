// B 站 Agent 工具包（LLM 型技能）
//
// 四个工具：bili_get_video_context / bili_inspect_user / bili_reply_comment / bili_like。
// 传输优先级：
//   1. 能力 `bili.action`（由桥接集成插件/通道路由器提供，推荐）
//   2. 当前 onebot 客户端明确是 B 站通道时，直接 call 同名 custom action
//   3. 都没有 → 返回明确错误（不伪造成功、不退回 QQ 通道误发）
//
// 写操作（回复评论/点赞）发送前先问 `send.guard`；anti-ban-guard 的夜间静默/
// 敏感内容/熔断因此同样覆盖 B 站评论。真正的 15 秒抖动与平台限频由桥接执行。

const MAX_COMMENT_BYTES = 2000;

let apiRef = null;
let logFn = (...args) => console.log('[bili-agent-pack]', ...args);

function clip(text, max = 8000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatResult(result) {
  if (result === undefined || result === null) return '桥接没有返回结果';
  if (typeof result === 'string') return clip(result);
  try { return clip(JSON.stringify(result, null, 2)); }
  catch { return clip(String(result)); }
}

function bridgeErrorText(error) {
  return String(error?.message ?? error ?? '未知错误').slice(0, 500);
}

/** 桥接用 {ok:false} 表达业务失败（无字幕/需登录/已删除）时，工具必须报错而不是装作成功。 */
function failedResult(result) {
  return result === false || Boolean(result && typeof result === 'object' && result.ok === false);
}

function isBiliOneBot(ctx) {
  const ob = ctx?.onebot;
  if (!ob) return false;
  if (String(ob.channel || '').toLowerCase() === 'bili') return true;
  try {
    if (typeof ob.channelFor === 'function') {
      const ch = String(ob.channelFor(ctx.chatKey) || '').toLowerCase();
      if (ch === 'bili') return true;
    }
    if (typeof ob.isBiliChat === 'function' && ob.isBiliChat(ctx.chatKey)) return true;
  } catch { /* 判断失败按非 B 站处理 */ }
  return false;
}

async function callBridge(ctx, action, args) {
  // 1) 显式能力：桥接进程/通道插件注入的 action 路由器
  if (apiRef && typeof apiRef.hasCapability === 'function' && apiRef.hasCapability('bili.action')) {
    try {
      const res = await apiRef.capability('bili.action', {
        action,
        args,
        chatKey: ctx?.chatKey,
        kind: ctx?.kind,
        chatId: ctx?.chatId,
        selfId: ctx?.selfId
      });
      if (res !== undefined) return res;
    } catch (error) {
      throw new Error(`B 站桥接调用失败：${bridgeErrorText(error)}`);
    }
  }

  // 2) 当前会话确实走 B 站通道时，custom action 透传。
  //    不能只看 supportsAction(action)：通道路由器对 bili_* 是全局支持，
  //    若在 QQ 会话里放行就会把 B 站动作发到 B 站（跨会话误操作）。
  const ob = ctx?.onebot;
  if (!ob || typeof ob.call !== 'function') {
    throw new Error('未连接 B 站桥接（缺少 bili.action 能力与 onebot 客户端）');
  }
  let onBili = isBiliOneBot(ctx);
  if (!onBili && typeof ob.platformFor === 'function') {
    try { onBili = ob.platformFor(ctx.kind, ctx.chatId) === 'bili'; } catch { onBili = false; }
  }
  if (!onBili) {
    throw new Error('当前会话不是 B 站通道，已拒绝把 B 站动作发到 QQ 通道');
  }
  return ob.call(action, args);
}

function guardWrite(ctx, text) {
  if (!apiRef || typeof apiRef.capability !== 'function') return true;
  let verdict;
  try {
    verdict = apiRef.capability('send.guard', {
      platform: 'bili',
      kind: 'comment',
      action: 'bili_reply_comment',
      chatKey: ctx?.chatKey,
      chatId: ctx?.chatId,
      text: String(text ?? '')
    });
  } catch (error) {
    return `发送守卫异常：${bridgeErrorText(error)}`;
  }
  if (verdict === undefined || verdict === null || verdict === true) return true;
  if (verdict === false) return '发送守卫拒绝了这条 B 站评论';
  if (verdict && verdict.ok === false) return String(verdict.reason || '发送守卫拒绝了这条 B 站评论');
  return true;
}

function fail(content) {
  return { content: String(content), isError: true };
}

const TOOL_GET_CONTEXT = {
  id: 'bili_get_video_context',
  name: 'B 站视频上下文',
  description: '获取 B 站视频详情、分P、热评、封面和字幕（AI 字幕可用时）。在 B 站会话里被问到视频内容、需要总结/回应视频时必须先调用；返回无字幕/需登录/已删除时如实说明，不要编造。',
  category: 'query',
  icon: '📺',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: '视频 BV 号，例如 BV1xx411c7mD；可用 url 代替' },
      url: { type: 'string', description: '视频链接或 b23.tv 短链（与 bvid 二选一）' },
      includeSubtitles: { type: 'boolean', description: '是否尝试拉取 AI 字幕，默认 true' },
      includeComments: { type: 'boolean', description: '是否带少量热评，默认 false' }
    }
  },
  async execute(ctx, args) {
    if (!args?.bvid && !args?.url) return fail('需要提供 bvid 或 url');
    try {
      const res = await callBridge(ctx, 'bili_get_video_context', {
        bvid: args.bvid ? String(args.bvid).slice(0, 40) : undefined,
        url: args.url ? String(args.url).slice(0, 500) : undefined,
        includeSubtitles: args.includeSubtitles !== false,
        includeComments: args.includeComments === true
      });
      if (failedResult(res)) return fail(`获取 B 站视频上下文失败：${res.error || res.reason || formatResult(res)}`);
      return { content: formatResult(res) };
    } catch (error) {
      return fail(`获取 B 站视频上下文失败：${bridgeErrorText(error)}`);
    }
  }
};

const TOOL_INSPECT_USER = {
  id: 'bili_inspect_user',
  name: 'B 站用户资料',
  description: '查询 B 站用户的昵称、简介、粉丝数、近期投稿等公开资料。需要了解评论者/UP 主身份时使用。',
  category: 'query',
  icon: '👤',
  parameters: {
    type: 'object',
    properties: {
      mid: { type: ['string', 'integer'], description: 'B 站用户 mid（数字）' },
      includeVideos: { type: 'boolean', description: '是否附带近期投稿列表，默认 false' },
      includeDynamics: { type: 'boolean', description: '是否查询近期公开动态，默认 false' }
    },
    required: ['mid']
  },
  async execute(ctx, args) {
    const mid = String(args?.mid ?? '').trim();
    if (!/^\d{1,18}$/.test(mid)) return fail('mid 必须是数字');
    try {
      const res = await callBridge(ctx, 'bili_inspect_user', { mid, includeVideos: args?.includeVideos === true, includeDynamics: args?.includeDynamics === true });
      if (failedResult(res)) return fail(`查询 B 站用户失败：${res.error || res.reason || formatResult(res)}`);
      return { content: formatResult(res) };
    } catch (error) {
      return fail(`查询 B 站用户失败：${bridgeErrorText(error)}`);
    }
  }
};

const TOOL_REPLY_COMMENT = {
  id: 'bili_reply_comment',
  name: '回复 B 站评论',
  description: '在 B 站视频下回复评论。属于写操作：只有用户明确要求你回复时才传 confirm=true。文本按 UTF-8 不得超过 2000 字节，发送前会经过 send.guard（夜间静默/敏感内容/熔断）。',
  category: 'messaging',
  icon: '💬',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '回复内容，≤2000 字节' },
      bvid: { type: 'string', description: '视频 BV 号（与 oid 二选一）' },
      oid: { type: ['string', 'integer'], description: '视频 aid（与 bvid 二选一）' },
      rootId: { type: ['string', 'integer'], description: '根评论 rpid（回复楼中楼时提供）' },
      parentId: { type: ['string', 'integer'], description: '父评论 rpid（回复楼中楼时提供）' },
      confirm: { type: 'boolean', description: '必须为 true 才真正发送；仅在用户明确要求时使用' }
    },
    required: ['text', 'confirm']
  },
  async execute(ctx, args) {
    if (args?.confirm !== true) return fail('写操作需要 confirm=true；请先向用户确认是否真的要回复这条评论');
    const text = String(args?.text ?? '').trim();
    if (!text) return fail('回复内容不能为空');
    if (Buffer.byteLength(text, 'utf8') > MAX_COMMENT_BYTES) return fail('回复内容超过 B 站 2000 字节限制');
    if (!args?.bvid && !args?.oid) return fail('需要提供 bvid 或 oid');
    const guarded = guardWrite(ctx, text);
    if (guarded !== true) return fail(guarded);
    try {
      const res = await callBridge(ctx, 'bili_reply_comment', {
        text,
        bvid: args.bvid ? String(args.bvid).slice(0, 40) : undefined,
        oid: args.oid !== undefined ? String(args.oid).slice(0, 30) : undefined,
        rootId: args.rootId !== undefined ? String(args.rootId).slice(0, 30) : undefined,
        parentId: args.parentId !== undefined ? String(args.parentId).slice(0, 30) : undefined
      });
      if (failedResult(res)) return fail(`回复 B 站评论失败：${res.error || res.reason || formatResult(res)}`);
      return { content: `已提交回复。${formatResult(res)}` };
    } catch (error) {
      return fail(`回复 B 站评论失败：${bridgeErrorText(error)}`);
    }
  }
};

const TOOL_LIKE = {
  id: 'bili_like',
  name: 'B 站点赞/取消点赞',
  description: '给 B 站视频或评论点赞/取消点赞。属于写操作：只有用户明确要求且传 confirm=true 时执行。',
  category: 'messaging',
  icon: '👍',
  parameters: {
    type: 'object',
    properties: {
      bvid: { type: 'string', description: '视频 BV 号（点赞视频时）' },
      oid: { type: ['string', 'integer'], description: '视频 aid（与 bvid 二选一）' },
      commentId: { type: ['string', 'integer'], description: '评论 rpid（点赞评论时提供）' },
      action: { type: 'string', enum: ['like', 'unlike'], description: '点赞或取消，默认 like' },
      confirm: { type: 'boolean', description: '必须为 true 才真正执行' }
    },
    required: ['confirm']
  },
  async execute(ctx, args) {
    if (args?.confirm !== true) return fail('写操作需要 confirm=true；请先向用户确认');
    if (!args?.bvid && !args?.oid) return fail('需要提供 bvid 或 oid');
    try {
      const res = await callBridge(ctx, 'bili_like', {
        bvid: args.bvid ? String(args.bvid).slice(0, 40) : undefined,
        oid: args.oid !== undefined ? String(args.oid).slice(0, 30) : undefined,
        commentId: args.commentId !== undefined ? String(args.commentId).slice(0, 30) : undefined,
        action: args.action === 'unlike' ? 'unlike' : 'like'
      });
      if (failedResult(res)) return fail(`B 站点赞失败：${res.error || res.reason || formatResult(res)}`);
      return { content: formatResult(res) };
    } catch (error) {
      return fail(`B 站点赞失败：${bridgeErrorText(error)}`);
    }
  }
};

export function setup(api) {
  apiRef = api;
  if (typeof api?.log === 'function') logFn = api.log;
  api.registerTool(TOOL_GET_CONTEXT);
  api.registerTool(TOOL_INSPECT_USER);
  api.registerTool(TOOL_REPLY_COMMENT);
  api.registerTool(TOOL_LIKE);
}

export function activate() { /* 无后台状态 */ }
export function deactivate() { /* 工具由 loader 统一回收 */ }

export const __test = {
  callBridge,
  guardWrite,
  isBiliOneBot,
  MAX_COMMENT_BYTES,
  setApi(api) { apiRef = api; }
};
