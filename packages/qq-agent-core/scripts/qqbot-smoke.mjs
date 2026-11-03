#!/usr/bin/env node
// 官方 QQ Bot（QQ 开放平台）接入冒烟测试。
//
// 验证链路：getAppAccessToken → GET /gateway/bot → WSS 连接 → READY →
// 收到第一条群@/私聊消息后用被动回复原样回显（验证"收 + 发"闭环）。
//
// 用法：
//   QQBOT_APP_ID=1900000000 QQBOT_APP_SECRET=xxx node scripts/qqbot-smoke.mjs
//   node scripts/qqbot-smoke.mjs <appId> <appSecret> [--sandbox] [--listen 120]
//
// 凭证只从环境变量/命令行读取，不落盘。
// 常见失败：getAppAccessToken 报 IP 相关错误 = 本机公网出口 IP 未加入
// q.qq.com 机器人管理后台的 IP 白名单；沙箱/正式环境选错用 --sandbox 切换。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const optionValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = [];
const valuedOptions = new Set(['--listen', '--intents', '--dm', '--text']);
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (valuedOptions.has(args[i])) i++; continue; }
  positional.push(args[i]);
}
const appId = process.env.QQBOT_APP_ID || positional[0] || '';
const appSecret = process.env.QQBOT_APP_SECRET || positional[1] || '';
const sandbox = flag('--sandbox');
const listenSec = Math.max(10, Number(optionValue('--listen', 120)) || 120);
// 默认只订阅群@ + C2C 私聊（1 << 25）。群/私聊机器人带上频道公域位（1 << 30）
// 会被网关以 4013/4014 断开；确需频道事件时再用 --intents 显式指定。
const intents = Number(optionValue('--intents', String(1 << 25)));
// --dm <user_openid> [--text 内容]：不发监听，直接测一条主动私聊（需已有好友关系）。
const dmTo = optionValue('--dm', '');
const dmText = optionValue('--text', '冒烟测试：主动私聊消息');

if (!appId || !appSecret) {
  console.error('用法：QQBOT_APP_ID=... QQBOT_APP_SECRET=... node scripts/qqbot-smoke.mjs [--sandbox] [--listen 120]');
  process.exit(2);
}

process.env.QQ_AGENT_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-smoke-'));
const { QQBotClient } = await import('../modules/headless/qqbot.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const preview = event => {
  const text = (Array.isArray(event.message) ? event.message : [])
    .map(s => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
  return text.slice(0, 80);
};

let echoed = false;
let probedProactive = false;
const events = [];
const client = new QQBotClient({
  appId,
  appSecret,
  sandbox,
  intents,
  reconnectMs: 3000,
  async onEvent(event) {
    events.push(event);
    const kind = event.message_type;
    const id = kind === 'group' ? event.group_id : event.user_id;
    console.log(`[事件] ${kind} ${id} 来自 ${event.sender?.nickname || event.user_id}：${preview(event)}`);
    if (!echoed) {
      echoed = true;
      try {
        const result = await client.sendText(kind, id, `冒烟测试收到：${preview(event) || '(非文本消息)'}`, { replyToMessageId: event.message_id });
        console.log(`[回显] 被动回复成功，message_id=${result?.message_id}`);
      } catch (error) {
        console.error(`[回显] 被动回复失败：${error?.message ?? error}`);
      }
    }
    // 群事件顺便验证主动推送（不带 msg_id 直接发，绕过被动锚点逻辑）。
    // 前提是群主已在 群设置 → 群机器人 里开启「主动推送消息」。
    if (kind === 'group' && !probedProactive) {
      probedProactive = true;
      try {
        const { path: targetPath } = client.parseTarget(kind, id);
        const result = await client.postMessage(targetPath, { content: '冒烟测试：主动推送（不依赖被动回复窗口）', msg_type: 0 }, '主动消息');
        console.log(`[主动] 主动推送成功，message_id=${result?.id}（群主权限已开启）`);
      } catch (error) {
        console.error(`[主动] 主动推送失败：${error?.message ?? error}`);
      }
    }
  }
});

console.log(`[冒烟] 环境=${sandbox ? '沙箱' : '正式'} appId=${appId}，正在获取凭证并连接网关…`);

// 主动私聊直发模式：REST 接口不需要网关连接，拿到 token 即可发。
if (dmTo) {
  try {
    const result = await client.postMessage(`/v2/users/${dmTo}`, { content: dmText, msg_type: 0 }, '主动私聊');
    console.log(`[主动私聊] 发送成功，message_id=${result?.id}`);
    process.exit(0);
  } catch (error) {
    console.error(`[主动私聊] 发送失败：${error?.message ?? error}`);
    process.exit(1);
  }
}

client.connect();
const deadline = Date.now() + 30000;
while (!client.connected && Date.now() < deadline) await sleep(200);

if (!client.connected) {
  console.error(`[冒烟] 连接失败：${client.lastConnectError || 'READY 超时'}`);
  console.error('[提示] 若报凭证/IP 相关错误：请到 q.qq.com 机器人管理后台 → 开发 → IP 白名单加入本机公网出口 IP；'
    + '若该机器人在沙箱环境，请加 --sandbox 重试。');
  client.close();
  process.exit(1);
}

console.log(`[冒烟] 已连接，机器人身份：${client.selfInfo?.nickname || '(未知)'}（${client.selfId}）`);
console.log(`[冒烟] 监听 ${listenSec} 秒：请在群里 @机器人 或私聊它发一条消息，将自动回显一条。`);
await sleep(listenSec * 1000);
console.log(`[冒烟] 结束。共收到 ${events.length} 条消息事件${echoed ? '，已完成一次被动回显' : '（未收到消息，请确认事件订阅已开启且机器人已入群）'}。`);
client.close();
process.exit(events.length ? 0 : 3);
