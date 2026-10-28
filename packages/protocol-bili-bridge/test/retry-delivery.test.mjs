import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonStore } from '../src/store/json-store.js';
import { PollState } from '../src/store/poll-state.js';
import { ReplyWatcher, CommentWatcher, DmWatcher, UpWatcher } from '../src/pollers/watchers.js';
import { tempDir } from './support/helpers.mjs';

async function state() {
  const store = new JsonStore({ dir: await tempDir(), name: 'state.json', defaults: () => ({ version: 1, seen: {}, cursors: {} }) });
  const value = new PollState({ store });
  await value.load();
  return value;
}

function flaky() {
  let calls = 0;
  return { send: async () => { calls += 1; if (calls === 1) throw new Error('delivery failed'); }, calls: () => calls };
}

test('failed msgfeed delivery retries even after unread count clears', async () => {
  const pollState = await state();
  const sink = flaky();
  let unread = 1;
  const item = { rpid: '123', oid: '1', mid: '2', isVideo: true, ctime: 1 };
  const watcher = new ReplyWatcher({ pollState, mapper: { groupForVideo: async () => ({ id: 1 }) }, dispatch: { comment: sink.send }, msgfeed: {
    unread: async () => ({ total: unread }), replies: async () => ({ items: [item], cursor: {} }), normalizeItems: (items) => items
  } });
  await watcher.poll();
  item.rpid = '124';
  await assert.rejects(watcher.poll(), /delivery failed/);
  unread = 0;
  assert.equal((await watcher.poll()).emitted, 1);
  assert.equal(sink.calls(), 2);
});

test('failed video, UP and DM deliveries are retried', async () => {
  const pollState = await state();
  const mapper = { groupForVideo: async () => ({ id: 1 }) };
  let replies = [];
  const commentSink = flaky();
  const comments = new CommentWatcher({ pollState, mapper, video: { view: async () => ({ aid: '1' }) }, comment: { list: async () => ({ replies }) }, getWatches: () => ({ videos: ['1'] }), dispatch: { comment: commentSink.send } });
  await comments.poll();
  replies = [{ rpid: '2', mid: '3', ctime: 1 }];
  await assert.rejects(comments.poll(), /delivery failed/);
  assert.equal((await comments.poll()).emitted, 1);
  let videos = [];
  const upSink = flaky();
  const ups = new UpWatcher({ pollState, mapper, getWatches: () => ({ ups: ['42'] }), api: { request: async () => ({ data: { list: { vlist: videos } } }) }, dispatch: { upVideo: upSink.send } });
  await ups.poll();
  videos = [{ bvid: 'BV1xx411c7mD', aid: '1' }];
  await assert.rejects(ups.poll(), /delivery failed/);
  assert.equal((await ups.poll()).emitted, 1);
  let messages = [];
  const dmSink = flaky();
  const dm = new DmWatcher({ pollState, dm: { sessions: async () => [{ talkerId: '5', maxSeqno: '2', unread: 1 }], messages: async () => ({ messages, maxSeqno: '2' }), profile: async () => ({}), ack: async () => {} }, dispatch: { privateMessage: dmSink.send } });
  await dm.poll();
  messages = [{ seqno: '2', mid: '5' }];
  await assert.rejects(dm.poll(), /delivery failed/);
  assert.equal((await dm.poll()).emitted, 1);
});
