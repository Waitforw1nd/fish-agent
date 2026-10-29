import http from 'node:http';

export const UPSTREAM_KEY = 'test-upstream-key';

export function startFakeUpstream({ port = 0, host = '127.0.0.1',
  models = ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'upstream-only-model'] } = {}) {
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
      res.end(JSON.stringify({
        object: 'list',
        data: models.map((id) => ({ id, object: 'model' }))
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
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: answer } }] })}\n\n`);
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
        res.end();
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
