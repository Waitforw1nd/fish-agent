// Official QQ member OpenIDs can equal numeric IDs from other entries. Legacy
// bare notes have ambiguous ownership and are never assigned to official QQ.
export function memberNoteKey(chatKey, userId) {
  const id = String(userId ?? '');
  return /^(?:group|private):qqbot_/.test(String(chatKey || '')) ? `qqbot:${id}` : id;
}

export function memberNotesForChat(chatKey, notes = {}) {
  if (!/^(?:group|private):qqbot_/.test(String(chatKey || ''))) {
    return Object.fromEntries(Object.entries(notes).filter(([key]) => !key.startsWith('qqbot:')));
  }
  return Object.fromEntries(Object.entries(notes).filter(([key]) => key.startsWith('qqbot:')).map(([key, value]) => [key.slice(6), value]));
}
