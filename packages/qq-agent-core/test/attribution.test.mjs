import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../src/llm.js';
import { detectModelVision } from '../src/vision-scan.js';

test('cloud Relay requests include attribution and vision, external providers do not', async () => {
  const originalFetch = globalThis.fetch;
  const oldCloud = process.env.QQ_AGENT_CLOUD;
  const bodies = [];
  process.env.QQ_AGENT_CLOUD = '1';
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ model: 'fixture', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  try {
    await chatCompletion({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }], attribution: { platform: 'qq', chatKey: 'group:123', runId: 'run-1' }, overrides: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-fish-fixture', model: 'fixture' } });
    assert.deepEqual(bodies[0]._fish_attribution, { platform: 'qq', chatKey: 'group:123', runId: 'run-1', vision: true });
    await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], attribution: { platform: 'qq' }, overrides: { baseUrl: 'https://example.test/v1', apiKey: 'sk-fish-fixture', model: 'fixture' } });
    assert.equal(bodies[1]._fish_attribution, undefined);
    await detectModelVision({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-fish-fixture', model: 'fixture' });
    assert.deepEqual(bodies[2]._fish_attribution, { vision: true });
    await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], skillContext: { platform: 'bili', chatKey: 'group:4503599627370500', runId: 'run-2' }, overrides: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-fish-fixture', model: 'fixture' } });
    assert.deepEqual(bodies[3]._fish_attribution, { platform: 'bili', chatKey: 'group:4503599627370500', runId: 'run-2', vision: false });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCloud === undefined) delete process.env.QQ_AGENT_CLOUD; else process.env.QQ_AGENT_CLOUD = oldCloud;
  }
});
