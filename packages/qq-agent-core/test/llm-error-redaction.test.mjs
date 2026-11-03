import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatCompletion, isRetryableError } from '../src/llm.js';

test('model errors do not expose credentials reflected by an upstream', async t => {
  const secret = 'fixture-secret-never-log';
  let fixture;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.writeHead(fixture.status, { 'content-type': `text/plain; x-reflected=${secret}` });
    res.end(fixture.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const overrides = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: secret, model: 'fixture', timeoutMs: 5000 };
  for (fixture of [
    { status: 503, body: `upstream reflected ${secret}`, match: /HTTP 503/, retry: true },
    { status: 200, body: `<html>${secret}</html>`, match: /无法解析的 JSON/, retry: true },
    { status: 200, body: JSON.stringify({ error: secret }), match: /缺少 choices/, retry: false },
  ]) {
    await assert.rejects(chatCompletion({ messages: [], overrides }), error => {
      assert.match(error.message, fixture.match);
      assert.equal(error.message.includes(secret), false);
      assert.equal(isRetryableError(error), fixture.retry);
      return true;
    });
  }
});
