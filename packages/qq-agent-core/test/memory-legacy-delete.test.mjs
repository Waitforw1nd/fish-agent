import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-legacy-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { MemoryStore } = await import('../src/memory.js');
const { encodeStorageId } = await import('../src/storage-identifiers.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { updateConfig } = await import('../src/config.js');
const { buildPastState, buildTriggerBlock } = await import('../src/prompt.js');

test('official member notes are isolated from numeric entry notes in memory and prompts', t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const official = 'group:qqbot_group_ABC';
  const numeric = 'group:123';
  const uid = '12345';
  updateConfig({ memberNotes: { [uid]: 'numeric-note' } });
  const store = new MemoryStore();
  store.append(official, 'memberImpression', 'official-memory', { userId: uid, target: 'official-name' });
  assert.match(store.formatForPrompt(official), /official-name/);
  assert.doesNotMatch(store.formatForPrompt(official), /numeric-note/);
  store.editMemberImpression(official, { userId: uid, name: 'official-name', note: 'official-note', impressions: ['official-memory'] });
  assert.match(store.formatForPrompt(official), /official-note/);
  store.append(numeric, 'memberImpression', 'numeric-memory', { userId: uid, target: 'numeric-name' });
  assert.match(store.formatForPrompt(numeric), /numeric-note/);
  const message = { senderId: uid, senderName: 'official-name', text: 'hello', ts: Date.now() };
  const history = { recent: () => [message] };
  assert.match(buildPastState(history, official).text, /official-note/);
  assert.doesNotMatch(buildPastState(history, official).text, /numeric-note/);
  assert.match(buildTriggerBlock([message], { chatKey: numeric }), /numeric-note/);
  assert.match(buildTriggerBlock([message], { chatKey: official }), /official-note/);
});

test('legacy single-file migration runs once and preserves all impressions', t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'group_123.json');
  fs.writeFileSync(source, '\ufeff' + JSON.stringify({ memberImpression: [
    { target: '12345', content: 'first', createdAt: 1 },
    { target: '12345', content: 'second', createdAt: 2 },
  ] }));
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.deepEqual(new MemoryStore().getMember('group:123', '12345').impressions.map(x => x.content), ['first', 'second']);
  } finally { console.error = originalError; }
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(path.join(dir, 'backups', 'group_123.json')), true);
  assert.deepEqual(new MemoryStore().getMember('group:123', '12345').impressions.map(x => x.content), ['first', 'second']);
});

test('numeric legacy memory never assigns an official OpenID from a matching note', t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  updateConfig({ memberNotes: { 'qqbot:OfficialOpenId': 'Shared Name' } });
  const dir = path.join(dataDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'group_777.json'), JSON.stringify({ memberImpression: [
    { target: 'Shared Name', content: 'legacy impression', createdAt: 1 },
  ] }));
  const migrated = new MemoryStore().members('group:777');
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].userId, '');
  assert.equal(migrated[0].name, 'Shared Name');
  assert.deepEqual(migrated[0].impressions.map(x => x.content), ['legacy impression']);
  assert.equal(new MemoryStore().members('group:777')[0].userId, '');
});

test('failed legacy backup can be retried without duplicating migrated impressions', t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'group_456.json');
  fs.writeFileSync(source, JSON.stringify({ memberImpression: [
    { target: '12345', content: 'once', createdAt: 1 },
  ] }));
  const rename = fs.renameSync;
  const error = console.error;
  let failures = 0;
  fs.renameSync = (from, to) => {
    if (from === source && failures++ === 0) throw new Error('fixture backup failure');
    return rename(from, to);
  };
  console.error = () => {};
  try {
    const store = new MemoryStore();
    assert.deepEqual(store.getMember('group:456', '12345').impressions.map(x => x.content), ['once']);
    assert.equal(fs.existsSync(source), true);
    assert.deepEqual(store.getMember('group:456', '12345').impressions.map(x => x.content), ['once']);
    assert.equal(fs.existsSync(source), false);
    assert.deepEqual(new MemoryStore().getMember('group:456', '12345').impressions.map(x => x.content), ['once']);
  } finally { fs.renameSync = rename; console.error = error; }
});

test('memory tool stores official member OpenIDs and rejects them for numeric channels', async t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const memory = new MemoryStore();
  const defs = buildToolDefs();
  const args = { category: 'memberImpression', userId: 'Member_A-1', target: 'Alice', content: 'likes fish' };
  const chatKey = 'group:qqbot_group_Test';
  const result = await executeTool(defs, { chatKey, memory }, 'memory_append', args);
  assert.equal(result.isError, undefined);
  assert.equal(new MemoryStore().getMember(chatKey, args.userId).impressions[0].content, args.content);
  const otherCase = { ...args, userId: 'member_A-1', content: 'likes tea' };
  assert.equal((await executeTool(defs, { chatKey, memory }, 'memory_append', otherCase)).isError, undefined);
  const reloaded = new MemoryStore();
  assert.equal(reloaded.getMember(chatKey, args.userId).impressions[0].content, 'likes fish');
  assert.equal(reloaded.getMember(chatKey, otherCase.userId).impressions[0].content, 'likes tea');
  for (const userId of ['123456', '9007199254740991']) {
    const numericArgs = { ...args, userId };
    const numericResult = await executeTool(defs, { chatKey: 'group:123', memory }, 'memory_append', numericArgs);
    assert.equal(numericResult.isError, undefined);
    assert.equal(new MemoryStore().getMember('group:123', userId).impressions[0].content, args.content);
  }
  assert.equal((await executeTool(defs, { chatKey: 'group:123', memory }, 'memory_append', args)).isError, true);
  assert.equal((await executeTool(defs, { chatKey, memory }, 'memory_append', { ...args, userId: 'x'.repeat(129) })).isError, true);
});

test('verified legacy member files cannot resurrect after deletion or consolidation', t => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const chat = 'group:qqbot_group_ABC';
  const dir = path.join(dataDir, 'memory', 'group_qqbot32_' + encodeStorageId('qqbot_group_ABC'));
  fs.mkdirSync(dir, { recursive: true });
  const fixture = id => ({ userId: id, name: id, impressions: [{ content: 'old', createdAt: 1 }] });
  fs.writeFileSync(path.join(dir, 'u_member_a.json'), JSON.stringify(fixture('member-a')));
  const store = new MemoryStore();
  assert.equal(store.members(chat)[0].impressions[0].content, 'old');
  assert.equal(fs.existsSync(path.join(dir, 'u_member_a.json')), false);
  assert.equal(store.remove(chat, 'memberImpression', { userId: 'member-a' }), true);
  assert.deepEqual(new MemoryStore().members(chat), []);

  fs.writeFileSync(path.join(dir, 'u_member_b.json'), JSON.stringify(fixture('member-b')));
  const second = new MemoryStore();
  second.replaceConsolidated(chat, { memberImpression: [] });
  assert.deepEqual(new MemoryStore().members(chat), []);

  // A pre-existing new file wins over an older duplicate, even when removal
  // transiently fails while loading. Consolidation retries both deletions.
  const uid = 'member-c';
  const legacy = path.join(dir, 'u_member_c.json');
  fs.writeFileSync(legacy, JSON.stringify(fixture(uid)));
  fs.writeFileSync(path.join(dir, 'u32_' + encodeStorageId(uid) + '.json'), JSON.stringify({ ...fixture(uid), impressions: [{ content: 'new', createdAt: 2 }] }));
  const originalRm = fs.rmSync;
  fs.rmSync = (file, ...args) => { if (file === legacy) throw new Error('transient fixture error'); return originalRm(file, ...args); };
  const third = new MemoryStore();
  try { assert.equal(third.getMember(chat, uid).impressions[0].content, 'new'); }
  finally { fs.rmSync = originalRm; }
  third.replaceConsolidated(chat, { memberImpression: [] });
  assert.deepEqual(new MemoryStore().members(chat), []);

  // A missing embedded ID is accepted only for the old numeric filename.
  fs.writeFileSync(path.join(dir, '12345.json'), JSON.stringify({ name: 'old numeric', impressions: [{ content: 'numeric', createdAt: 1 }] }));
  const fourth = new MemoryStore();
  assert.equal(fourth.getMember(chat, '12345').impressions[0].content, 'numeric');
  assert.equal(fourth.removeMember(chat, '12345'), true);
  assert.deepEqual(new MemoryStore().members(chat), []);

  fs.writeFileSync(path.join(dir, '23456.json'), JSON.stringify({ userId: '', name: 'empty numeric', impressions: [{ content: 'remove me', createdAt: 1 }, { content: 'keep me', createdAt: 2 }] }));
  const emptyId = new MemoryStore();
  assert.equal(emptyId.getMember(chat, '23456').userId, '23456');
  assert.equal(emptyId.remove(chat, 'memberImpression', { userId: '23456', content: 'remove me' }), true);
  const reloaded = new MemoryStore();
  assert.deepEqual(reloaded.getMember(chat, '23456').impressions.map(x => x.content), ['keep me']);
  assert.equal(reloaded.remove(chat, 'memberImpression', { userId: '23456' }), true);
  assert.deepEqual(new MemoryStore().members(chat), []);

  // A colliding sanitized legacy name belonging to another ID is untouched.
  fs.writeFileSync(path.join(dir, 'u_member_d.json'), JSON.stringify(fixture('member-d')));
  const fifth = new MemoryStore();
  assert.equal(fifth.getMember(chat, 'member_d').impressions.length, 0);
  fifth.removeMember(chat, 'member_d');
  assert.equal(new MemoryStore().getMember(chat, 'member-d').impressions[0].content, 'old');
});
