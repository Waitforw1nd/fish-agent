import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeCqText,
  unescapeCqText,
  parseCqString,
  normalizeSegments,
  segmentsToCq,
  renderOutboundSegments,
  buildGroupEvent,
  buildPrivateEvent,
  messagePreview
} from '../src/onebot/message.js';

test('CQ 转义、解析与数组消息规范化', () => {
  const raw = 'A&B[1],2';
  const escaped = escapeCqText(raw);
  assert.equal(escaped, 'A&amp;B&#91;1&#93;&#44;2');
  assert.equal(unescapeCqText(escaped), raw);
  const parsed = parseCqString(`你好${escapeCqText('A&B')}[CQ:at,qq=123,name=小明]`);
  assert.deepEqual(parsed, [
    { type: 'text', data: { text: '你好A&B' } },
    { type: 'at', data: { qq: '123', name: '小明' } }
  ]);
  assert.deepEqual(normalizeSegments([{ type: 'text', data: { text: 'x' } }]), [{ type: 'text', data: { text: 'x' } }]);
  assert.deepEqual(normalizeSegments('a[CQ:face,id=1]'), [
    { type: 'text', data: { text: 'a' } },
    { type: 'face', data: { id: '1' } }
  ]);
  assert.match(segmentsToCq([{ type: 'at', data: { qq: '1', name: 'A&B' } }]), /name=A&amp;B/);
  assert.equal(messagePreview([{ type: 'text', data: { text: 'hi' } }, { type: 'image', data: { file: 'x' } }]), 'hi[图片]');
});

test('出站消息段：CQ 还原、@ 反验、引用与不支持段', () => {
  const users = new Map([
    [String(2 ** 52 + 201), { name: '观众A', native: { mid: '20002' } }],
    [String(2 ** 52 + 202), { name: '', native: { mid: '20003' } }]
  ]);
  const resolveUser = (id) => users.get(String(id)) || null;
  const rendered = renderOutboundSegments([
    { type: 'reply', data: { id: String(2 ** 52 + 203) } },
    { type: 'at', data: { qq: String(2 ** 52 + 201), name: '观众A' } },
    { type: 'text', data: { text: ' A&amp;B&#91;1&#93;' } }
  ], { selfId: String(2 ** 52 + 200), selfName: '自己', resolveUser });
  assert.equal(rendered.replyMessageId, 2 ** 52 + 203);
  assert.equal(rendered.text, '@观众A  A&B[1]');
  assert.deepEqual(rendered.ats, [{ mid: '20002', name: '观众A' }]);

  assert.throws(() => renderOutboundSegments([
    { type: 'at', data: { qq: String(2 ** 52 + 201), name: '假名' } }
  ], { resolveUser }), (error) => /昵称.*不一致/.test(error.wording));

  assert.throws(() => renderOutboundSegments([
    { type: 'at', data: { qq: String(2 ** 52 + 299), name: '未知' } }
  ], { resolveUser }), (error) => /没有对应的 B 站账号/.test(error.wording));

  assert.throws(() => renderOutboundSegments([
    { type: 'image', data: { file: 'x' } }
  ], { resolveUser }), (error) => error.retcode === 1404 && /不支持发送图片/.test(error.wording));

  const selfAt = renderOutboundSegments([
    { type: 'at', data: { qq: String(2 ** 52 + 200) } },
    { type: 'text', data: { text: '在吗' } }
  ], { selfId: String(2 ** 52 + 200), selfName: '自己', resolveUser });
  assert.equal(selfAt.text, '@自己 在吗');
  assert.deepEqual(selfAt.ats, [{ mid: '', name: '自己', self: true }]);
});

test('OneBot 事件构造只接受安全整数 ID，并生成 CQ raw_message', () => {
  const event = buildGroupEvent({
    selfId: 2 ** 52 + 100,
    groupId: 2 ** 52 + 101,
    userId: 2 ** 52 + 102,
    senderName: '观众A',
    segments: [{ type: 'text', data: { text: 'a&b' } }],
    messageId: 2 ** 52 + 103,
    time: 100
  });
  assert.equal(event.message_id, 2 ** 52 + 103);
  assert.equal(event.raw_message, 'a&amp;b');
  assert.equal(event.sender.nickname, '观众A');
  assert.equal(event.self_id, 2 ** 52 + 100);

  const privateEvent = buildPrivateEvent({
    selfId: 2 ** 52 + 100,
    userId: 2 ** 52 + 102,
    segments: [{ type: 'text', data: { text: 'hi' } }],
    messageId: 2 ** 52 + 104
  });
  assert.equal(privateEvent.message_type, 'private');
  assert.equal(privateEvent.sub_type, 'friend');

  assert.throws(() => buildGroupEvent({
    selfId: 2 ** 52 + 100,
    groupId: 2 ** 52 + 101,
    userId: 2 ** 52 + 102,
    segments: [],
    messageId: 'not-int'
  }), /message_id/);
});
