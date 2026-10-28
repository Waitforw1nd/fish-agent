import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const env = await bootApp({
  config: {
    skills: {
      'trpg-dice-hook': { enabled: true }
    }
  }
});

try {
  env.pushGroupMsg(111, '张三', '.r 2d6+1', 9101);
  await waitFor(
    () => env.app.store.recent('group:456', { limit: 20 }).some((m) => m.self && m.text.includes('2d6+1')),
    5000,
    '骰子命令经 SendQueue 回复并存档'
  );
  await sleep(400);

  const diceEntries = env.app.store.recent('group:456', { limit: 20 });
  assert.ok(diceEntries.some((m) => !m.self && m.mid === 9101 && m.text === '.r 2d6+1'), '骰子命令原文应存档');
  assert.ok(diceEntries.some((m) => m.self && m.text.includes('🎲') && m.text.includes('2d6+1')), '骰子回复应作为自发消息存档');
  assert.equal(env.onebotHttp.state.sends.length, 1, '骰子回复应实际经过 OneBot 出站');
  assert.equal(env.llm.state.requests.length, 0, '骰子命令不应调用 LLM');
  assert.equal(env.app.sessions.listSummaries(20).length, 0, '骰子命令不应创建 LLM 会话');
  console.log('  OK    骰子命令存档、SendQueue 回复且不调用 LLM');

  env.pushGroupMsg(111, '张三', '@覆盖Bot 普通消息仍走原流程', 9102);
  await waitFor(
    () => env.llm.state.requests.some((r) => JSON.stringify(r.messages).includes('普通消息仍走原流程')),
    5000,
    '普通消息调用 LLM'
  );
  console.log('  OK    普通消息仍进入原 LLM 流程');

  const { skillManager } = await import('../src/skills/manager.js');
  let thrown = 0;
  skillManager.register({
    manifest: {
      id: 'test-message-command-error',
      enabledByDefault: true,
      capabilities: ['message.command']
    },
    providers: {
      'message.command': () => {
        thrown += 1;
        throw new Error('模拟插件异常');
      }
    }
  });
  try {
    env.pushGroupMsg(111, '张三', '@覆盖Bot 插件异常仍走原流程', 9103);
    await waitFor(
      () => env.llm.state.requests.some((r) => JSON.stringify(r.messages).includes('插件异常仍走原流程')),
      5000,
      '插件异常后调用 LLM'
    );
    assert.equal(thrown, 1, '测试应实际执行抛错插件');
  } finally {
    skillManager.unregister('test-message-command-error');
  }
  console.log('  OK    message.command 插件异常隔离并回落原流程');

  const { OneBotClient } = await import('../src/onebot.js');
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const timeouts = [];
  try {
    AbortSignal.timeout = (ms) => {
      timeouts.push(ms);
      return realTimeout.call(AbortSignal, ms);
    };
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    const client = new OneBotClient({ platform: 'bili', httpUrl: 'http://127.0.0.1:3100' });
    await client.call('bili_reply_comment', { text: 'test' });
    await client.call('get_login_info');
    await client.call('bili_like', {}, 1234);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
  assert.ok(timeouts[0] > 15000, 'bili_* 默认超时应覆盖评论队列等待');
  assert.equal(timeouts[1], 15000, '普通查询超时不应被放宽');
  assert.equal(timeouts[2], 1234, '显式超时应保持最高优先级');
  console.log(`  OK    bili_* 默认超时 ${timeouts[0]}ms，显式超时优先`);
} finally {
  await env.teardown();
}
