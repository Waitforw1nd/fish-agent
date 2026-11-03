export const RECOVERY_CAPABILITIES = Object.freeze(['recovery.v1', 'receipt.v1', 'input-history.v1']);

const sequence = n => Number.isSafeInteger(n) && n >= 0;
export function validRecoveryMetadata(data, input = false) {
  const keys = input
    ? ['inputServerSeq', 'inputOldestSeq', 'inputReplayFrom', 'inputReplayTo', 'inputHasGap']
    : ['serverSeq', 'oldestSeq', 'replayFrom', 'replayTo', 'hasGap'];
  const [server, oldest, from, to, gap] = keys.map(key => data[key]);
  return typeof data.epoch === 'string' && /^[\w.-]{1,128}$/.test(data.epoch)
    && [server, oldest, from, to].every(sequence) && oldest <= server + 1
    && from <= to + 1 && to === server && typeof gap === 'boolean';
}

// The advertised retained window must account for every sequence after our
// cursor. Otherwise an empty replay can silently skip undeclared messages.
export function matchesRecoveryCursor(data, cursor, input = false) {
  const server = input ? data.inputServerSeq : data.serverSeq;
  const oldest = input ? data.inputOldestSeq : data.oldestSeq;
  const from = input ? data.inputReplayFrom : data.replayFrom;
  const gap = input ? data.inputHasGap : data.hasGap;
  return cursor <= server && oldest >= 1
    && from === Math.max(cursor + 1, oldest)
    && gap === (cursor < server && cursor + 1 < oldest);
}

// Input history has its own cursor. Matching the source device as well as the
// client ID prevents another device's identical ID from merging a local row.
export function mergeInput(snapshot, frame, deviceId) {
  const data = frame.d;
  const messages = structuredClone(snapshot.messages);
  const index = messages.findIndex(row => row.messageId === data.messageId
    || (data.deviceId === deviceId && row.role === 'user' && row.id === data.clientMessageId));
  if (index >= 0) messages[index] = {...messages[index], messageId:data.messageId};
  else messages.push({role:'user', messageId:data.messageId, segments:data.segments});
  return {...snapshot, inputSeq:frame.inputSeq, messages};
}
