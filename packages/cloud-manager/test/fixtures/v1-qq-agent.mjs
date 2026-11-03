import fs from 'node:fs';
import path from 'node:path';
const fixtureBase = JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json'), 'utf8')).v1FixtureBase;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (['bots.qq.com', 'api.sgroup.qq.com'].includes(url.hostname)) {
    return nativeFetch(`${fixtureBase}${url.pathname}${url.search}`, init);
  }
  if (url.hostname !== '127.0.0.1') throw new Error(`Blocked non-loopback fetch: ${url.hostname}`);
  return nativeFetch(input, init);
};
await import('../../../qq-agent-core/modules/headless/server.js');

