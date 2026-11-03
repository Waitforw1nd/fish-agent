// Match legacy numeric IDs and case-sensitive official OpenIDs with their scope.
// The same grammar must protect proxy routes and compose agent settings paths.
const numeric = '\\d{1,20}';
const openId = '[A-Za-z0-9_-]{1,128}';
export const CHAT_PATH_SOURCE = `(?:group_(?:${numeric}|qqbot_(?:group|channel)_${openId})|private_(?:${numeric}|qqbot_(?:user|dm)_${openId}))`;
const chatPath = new RegExp(`^${CHAT_PATH_SOURCE}$`);

export function normalizeChatPath(chatId) {
  const value = String(chatId || '').replace(/^(group|private):/, '$1_');
  return chatPath.test(value) ? value : null;
}

export function chatApiRoute(resource, suffix = '') {
  return new RegExp(`^/api/${resource}/${CHAT_PATH_SOURCE}${suffix}$`);
}
