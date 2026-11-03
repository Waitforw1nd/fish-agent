import http from 'node:http';

export const UPSTREAM_KEY = 'test-upstream-key';

export function startFakeUpstream({ port = 0, host = '127.0.0.1',
  models = ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'upstream-only-model'], reflectModelAuthorization = false, oversizedModels = false } = {}) {
  const stats = { requests: [], models: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
      const body = JSON.stringify({ error: { message: 'bad upstream key', type: 'authentication_error' } });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname === '/v1/models') {
      stats.models += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (oversizedModels) { res.end('x'.repeat(2 * 1024 * 1024)); return; }
      res.end(JSON.stringify({
        object: 'list',
        data: [...models, ...(reflectModelAuthorization ? [`reflected ${req.headers.authorization}`] : [])].map((id) => ({ id, object: 'model' }))
      }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      stats.requests.push({ at: Date.now(), body: payload });
      const text = JSON.stringify(payload.messages || []);
      if (text.includes('__empty_incomplete_sse__')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"unfinished');
        return;
      }
      if (text.includes('__role_incomplete_sse__') || text.includes('__finish_incomplete_sse__') || text.includes('__zero_usage_sse__')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = text.includes('__zero_usage_sse__')
          ? { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }
          : { choices: [{ delta: text.includes('__role_incomplete_sse__') ? { role: 'assistant' } : {}, finish_reason: text.includes('__finish_incomplete_sse__') ? 'stop' : null }] };
        res.end(`data: ${JSON.stringify(frame)}\n\n`);
        return;
      }
      if (text.includes('__empty_complete_sse__') || text.includes('__usage_only_sse__')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (text.includes('__usage_only_sse__')) res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":0}}\n\n');
        else res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const oversized = /__oversized_(json|error|frame|events)__/.exec(text)?.[1];
      if (oversized) {
        const sse = oversized === 'frame' || oversized === 'events';
        res.writeHead(oversized === 'error' ? 500 : 200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
        const block = oversized === 'events'
          ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(512) } }] })}\n\n`
          : oversized === 'frame' ? 'data: ' + 'x'.repeat(2048) : 'PRIVATE_FIXTURE' + 'x'.repeat(2048);
        let writes = 0;
        const timer = setInterval(() => {
          if (++writes > 1000) { clearInterval(timer); res.end(); return; }
          res.write(block);
        }, 2);
        res.on('close', () => { clearInterval(timer); (stats.oversizeClosed ||= []).push({ kind: oversized, writes }); });
        return;
      }
      const invalid = /__invalid_(string|array|tools|truncated)__/.exec(text)?.[1];
      if (invalid) {
        const data = invalid === 'string' ? JSON.stringify(`reflected ${req.headers.authorization}`)
          : invalid === 'array' ? JSON.stringify([{ secret: req.headers.authorization }])
            : JSON.stringify({ choices: [{ delta: { tool_calls: { secret: req.headers.authorization } } }] });
        const sse = invalid === 'tools' && payload.stream;
        res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
        if (invalid === 'truncated') { res.write('{"choices":['); setTimeout(() => res.destroy(), 5); }
        else res.end(sse ? `data: ${data}\n\n` : data);
        return;
      }
      if (text.includes('__reflect_stream_error__') || text.includes('__reflect_multiline_error__') || text.includes('__reflect_malformed_error__')) {
        const error = JSON.stringify({ error: { message: `reflected authorization: ${req.headers.authorization}` } }, null, text.includes('__reflect_multiline_error__') ? 2 : 0);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (text.includes('__reflect_malformed_error__') ? `data: error ${req.headers.authorization}` : error.split('\n').map(line => 'data: ' + line).join('\n')) + '\n\n';
        res.write(frame.slice(0, 24));
        setTimeout(() => res.end(frame.slice(24)), 5);
        return;
      }
      if (text.includes('__reflect_success_error__')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `reflected authorization: ${req.headers.authorization}` } }));
        return;
      }
      const reflected = /__reflect_error_(401|403|429|500)__/.exec(text);
      if (reflected) {
        res.writeHead(Number(reflected[1]), { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `reflected authorization: ${req.headers.authorization}`, type: 'server_error' } }));
        return;
      }
      if (text.includes('__upstream_error__')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded', type: 'server_error' } }));
        return;
      }
      const promptTokens = Math.max(1, Math.ceil(text.length / 3));
      const answer = 'pong from fake upstream';
      const completionTokens = Math.max(1, Math.ceil(answer.length / 3));
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
        const delta = text.includes('__tools_only__')
          ? { tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ text: 'x'.repeat(160) }) } }] }
          : { content: answer };
        const data = JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] }, null, text.includes('__multiline_success__') ? 2 : 0);
        res.write(data.split('\n').map(line => 'data: ' + line).join('\n') + '\n\n');
        if (!text.includes('__no_usage__')) res.write(`data: ${JSON.stringify({
          id: 'chatcmpl_fake',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_tokens_details: { cached_tokens: Math.min(2, promptTokens) }
          }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        if (text.includes('__review_hold_stream__')) stats.releaseReviewStream = () => res.end();
        else if (text.includes('__settlement_failure__')) setTimeout(() => res.end(), 20);
        else res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_fake',
        object: 'chat.completion',
        model: payload.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        ...(!text.includes('__no_usage__') ? { usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: Math.min(2, promptTokens) }
        } } : {})
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        port: server.address().port,
        baseUrl: `http://${host}:${server.address().port}`,
        stats,
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); })
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startFakeUpstream({ port: Number(process.env.FAKE_UPSTREAM_PORT || 0) }).then((upstream) => {
    console.log(JSON.stringify({ baseUrl: upstream.baseUrl, key: UPSTREAM_KEY }));
  });
}
