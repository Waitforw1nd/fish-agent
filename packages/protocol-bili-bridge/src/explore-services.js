// Cloud exploration only talks to authenticated loopback services. Keeping this
// transport separate lets tests exercise the same acknowledgement path as main.
export function createExploreServices(env, { fetchImpl = fetch } = {}) {
  const localUrl = (value, pathname) => {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === pathname
        && !u.username && !u.password && !u.search && !u.hash ? u.href : '';
    } catch { return ''; }
  };
  const agentUrl = localUrl(env.BILI_EXPLORE_AGENT_URL, '/api/internal/bili-explore');
  const meterUrl = localUrl(env.BILI_EXPLORE_METER_URL, '/v1/fish/meter-events');
  const post = async (url, headers, body) => {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('Explore local service unavailable'); }
    if (!response.ok) throw new Error('Explore local service HTTP ' + response.status);
    // Even authenticated local peers can fail or return an unexpectedly large
    // body. Bound the stream before parsing rather than buffering response.json().
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Invalid explore local service response');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) {
          await reader.cancel().catch(() => {});
          throw new Error('Explore local service response too large');
        }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch (error) {
      if (error.message === 'Explore local service response too large') throw error;
      throw new Error('Invalid explore local service response');
    } finally { reader.releaseLock(); }
  };
  const exploreGenerate = agentUrl && env.BILI_EXPLORE_AGENT_TOKEN
    ? input => post(agentUrl, { 'x-console-token': env.BILI_EXPLORE_AGENT_TOKEN }, input) : null;
  const exploreMeter = meterUrl && env.BILI_EXPLORE_RELAY_KEY ? async event => {
    const ack = await post(meterUrl, { authorization: 'Bearer ' + env.BILI_EXPLORE_RELAY_KEY },
      { events: [{ ...event, entry: 'bili', source: 'bridge', kind: 'delta', attrs: {} }] });
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) || ack.ok === false
        || !Number.isSafeInteger(ack.accepted) || !Number.isSafeInteger(ack.duplicates)
        || ack.accepted < 0 || ack.duplicates < 0 || ack.accepted + ack.duplicates !== 1) {
      throw new Error('Invalid explore meter acknowledgement');
    }
    return ack;
  } : null;
  return { exploreGenerate, exploreMeter };
}
