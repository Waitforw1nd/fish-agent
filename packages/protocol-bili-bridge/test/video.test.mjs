import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBili } from './support/fake-bili.mjs';
import { CookieJar } from '../src/bili/cookie-jar.js';
import { BiliApi } from '../src/bili/api.js';
import { WbiSigner } from '../src/bili/wbi.js';
import { RiskGuard } from '../src/bili/risk.js';
import { VideoService, formatSubtitleEntries, normalizeImageUrl } from '../src/bili/video.js';
import { BridgeError } from '../src/errors.js';

async function setup() {
  const fake = await FakeBili.start();
  const now = () => Date.now();
  const jar = new CookieJar({ now });
  const api = new BiliApi({ endpoints: fake.endpoints(), jar, timeoutMs: 2000, now });
  const signer = new WbiSigner({ request: (args) => api.request(args), now });
  api.setSigner(signer);
  api.setRisk(new RiskGuard({ now }));
  const video = new VideoService({ api, now, forceHttps: false });
  return { fake, jar, api, signer, video, cleanup: () => fake.close() };
}

test('视频上下文：详情、分 P、AI 字幕下载与封面', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { video, fake } = env;

  const context = await video.context({ bvid: 'BV1xx411c7mD', download: true });
  assert.equal(context.ok, true);
  assert.equal(context.bvid, 'BV1xx411c7mD');
  assert.equal(context.aid, '170001');
  assert.equal(context.title, '测试视频标题');
  assert.equal(context.owner.name, '测试UP主');
  assert.equal(context.pages.length, 1);
  assert.equal(context.pages[0].cid, '3001001');
  assert.equal(context.stat.view, 1000);
  assert.equal(context.subtitle.available, true);
  assert.equal(context.subtitle.list[0].isAi, true);
  assert.equal(context.subtitle.downloaded.lan, 'ai-zh');
  assert.equal(context.subtitle.downloaded.count, 2);
  assert.match(context.subtitleText, /^\[00:00\] 字幕内容/m);
  assert.match(context.subtitleText, /第二句字幕/);

  const subtitles = await video.subtitles({ bvid: 'BV1xx411c7mD' });
  assert.equal(subtitles.available, true);
  assert.equal(subtitles.cid, '3001001');

  const cover = await video.cover('/cover.jpg');
  assert.equal(cover.contentType, 'image/jpeg');
  assert.deepEqual([...cover.data], [0xff, 0xd8, 0xff, 0xd9]);

  const user = await video.inspectUser({ mid: '20002' });
  assert.equal(user.name, '观众A');
  assert.equal(user.level, 3);
  assert.equal(user.fans, 12);

  fake.subtitles.set('170001', []);
  const none = await video.context({ bvid: 'BV1xx411c7mD' });
  assert.equal(none.subtitle.available, false);
  assert.equal(none.subtitle.reason, 'NO_SUBTITLE');
  assert.equal(none.subtitleText, '');
});

test('字幕缺失、地址过期、需要登录都明确返回原因', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { video, fake } = env;

  fake.subtitles.set('170001', []);
  const noSubtitle = await video.subtitles({ bvid: 'BV1xx411c7mD', aid: '170001', cid: '3001001' });
  assert.equal(noSubtitle.available, false);
  assert.equal(noSubtitle.reason, 'NO_SUBTITLE');
  assert.match(noSubtitle.wording, /没有可用字幕/);

  fake.subtitles.set('170001', [{
    id: 'sub-ai-1',
    lan: 'ai-zh',
    lan_doc: '中文（AI生成）',
    subtitle_url: `http://127.0.0.1:${fake.port}/subtitle/sub-ai-1.json`,
    author: { name: 'AI' },
    type: 1
  }]);
  fake.failNext('/subtitle/sub-ai-1.json', { status: 403, code: 0, message: 'expired' });
  const expired = await video.downloadSubtitle(`http://127.0.0.1:${fake.port}/subtitle/sub-ai-1.json`);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'EXPIRED');
  assert.match(expired.wording, /过期/);

  fake.failNext('/x/player/wbi/v2', { code: -101, message: '账号未登录' });
  const loginRequired = await video.subtitles({ bvid: 'BV1xx411c7mD', aid: '170001', cid: '3001001' });
  assert.equal(loginRequired.available, false);
  assert.equal(loginRequired.reason, 'LOGIN_REQUIRED');

  fake.failNext('/x/player/wbi/v2', { code: -101, message: '账号未登录' });
  const context = await video.context({ bvid: 'BV1xx411c7mD' });
  assert.equal(context.ok, true);
  assert.equal(context.title, '测试视频标题');
  assert.equal(context.subtitle.reason, 'LOGIN_REQUIRED');
});

test('b23 短链解析为 BV 号并拒绝外部域名', async () => {
  const jar = new CookieJar({ now: () => Date.now() });
  const api = new BiliApi({
    endpoints: { api: 'https://api.example.test' },
    jar,
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://b23.tv/')) {
        return new Response('', { status: 302, headers: { location: 'https://www.bilibili.com/video/BV1short0001?x=1' } });
      }
      return new Response('', { status: 200 });
    }
  });
  const video = new VideoService({ api, forceHttps: false });
  assert.equal(await video.resolveBvid('https://b23.tv/abcdef'), 'BV1short0001');
  await assert.rejects(() => video.resolveBvid('https://evil.example/abc'), (error) => error.retcode === 1400);
});

test('字幕格式化、URL 规范与错误输入', async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { video, fake } = env;
  assert.equal(formatSubtitleEntries([{ from: 65.5, content: '  一句话  ' }]), '[01:05] 一句话');
  assert.equal(normalizeImageUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(normalizeImageUrl('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(normalizeImageUrl('http://i0.hdslb.com/a.jpg', { forceHttps: false }), 'http://i0.hdslb.com/a.jpg');

  await assert.rejects(() => video.view({}), (error) => error instanceof BridgeError && /视频 ID/.test(error.wording));
  await assert.rejects(() => video.inspectUser({ mid: 'abc' }), (error) => error instanceof BridgeError && error.retcode === 1400);
  await assert.rejects(() => video.view({ bvid: 'BV1missing000' }), (error) => error.apiCode === -404);

  fake.failNext('/cover.jpg', { code: 0, message: 'not image' });
  await assert.rejects(() => video.cover('/cover.jpg'), (error) => /封面/.test(error.wording));
});
