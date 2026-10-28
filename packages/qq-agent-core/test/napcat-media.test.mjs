import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-media-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { inlineImage } = await import('../src/container-media.js');
const { resolveChannels, updateConfig } = await import('../src/config.js');
const { SendQueue } = await import('../src/sender.js');
const media = { mode: 'inline-base64', maxImageBytes: 5, incomingLocalPaths: 'deny' };

test('media policy is preserved and malformed NapCat policy is rejected', () => {
  assert.deepEqual(resolveChannels({ channels: { qq: { driver: 'napcat', generation: 3, media } } }).qq.media, media);
  assert.throws(() => resolveChannels({ channels: { qq: { driver: 'napcat' } } }), /media/);
});

test('controlled image sources enforce limits and reject outside and symlink paths', async () => {
  const image = path.join(root, 'sticker-images', 'image.png');
  fs.mkdirSync(path.dirname(image), { recursive: true });
  fs.writeFileSync(image, '12345');
  assert.equal(await inlineImage(image, 5), 'base64://MTIzNDU=');
  await assert.rejects(inlineImage(image, 4), /上限/);
  await assert.rejects(inlineImage('base64://MTIzNDU2', 5), /上限/);
  const outside = path.join(os.tmpdir(), `fish-outside-${process.pid}`);
  fs.writeFileSync(outside, 'x');
  try {
    await assert.rejects(inlineImage(outside, 5), /受控/);
    try { fs.symlinkSync(outside, path.join(root, 'sticker-images', 'link')); await assert.rejects(inlineImage(path.join(root, 'sticker-images', 'link'), 5), /受控/); } catch (error) { if (error.code !== 'EPERM') throw error; }
  } finally { fs.rmSync(outside, { force: true }); }
});

test('container send uses base64 on first action and never retries unknown results', async () => {
  updateConfig({ channels: { qq: { driver: 'napcat', media } }, send: { guard: { enabled: false } } });
  const calls = [];
  const onebot = { async sendImage(_kind, _id, ref) { calls.push(ref); throw new Error('timeout'); } };
  const queue = new SendQueue({ onebot, store: { appendSelf() {} } });
  await assert.rejects(queue.sendImage('group:123', { file: path.join(root, 'sticker-images', 'image.png') }), /timeout/);
  assert.deepEqual(calls, ['base64://MTIzNDU=']);
});
