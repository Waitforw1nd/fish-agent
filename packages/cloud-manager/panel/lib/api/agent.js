export function createAgentApi({ request, tenantPath }) {
  const path = (id, suffix) => tenantPath(id, `/agent${suffix}`);
  const part = (value) => encodeURIComponent(String(value));
  const get = (id, suffix) => request(path(id, suffix));
  const write = (id, suffix, method, body) => request(path(id, suffix), { method, body });
  return {
    getAgentConfig: (id) => get(id, '/config'),
    updateAgentConfig: (id, body) => write(id, '/config', 'PATCH', body),
    getAgentPersonas: (id) => get(id, '/personas'),
    createAgentPersona: (id, body) => write(id, '/personas', 'POST', body),
    deleteAgentPersona: (id, templateId) => write(id, `/personas/${part(templateId)}`, 'DELETE'),
    previewAgentPersonaCard: (id, body) => write(id, '/persona-cards/preview', 'POST', body),
    importAgentPersonaCard: (id, body) => write(id, '/persona-cards/import', 'POST', body),
    getAgentContacts: (id) => get(id, '/contacts'),
    getAgentStatus: (id) => get(id, '/status'),
    setAgentPause: (id, paused, options = {}) => write(id, '/pause', 'PUT', { paused: Boolean(paused), ...options }),
    getAgentSessions: (id) => get(id, '/sessions'),
    clearAgentSessions: (id) => write(id, '/sessions/clear-finished', 'POST'),
    controlAgentSession: (id, sessionId, action) => {
      if (!['retry', 'abort', 'delete'].includes(action)) throw new TypeError('Invalid session action');
      return write(id, `/sessions/${part(sessionId)}/${action}`, 'POST');
    },
    getAgentChats: (id) => get(id, '/chats'),
    getAgentChatMessages: (id, chatId, query = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== '' && value != null) params.set(key, String(value));
      return get(id, `/chats/${part(chatId)}/messages${params.size ? `?${params}` : ''}`);
    },
    agentChatAction: (id, chatId, body) => write(id, `/chats/${part(chatId)}/actions`, 'POST', body),
    getAgentMemories: (id) => get(id, '/memories'),
    getAgentMemory: (id, chatId) => get(id, `/memories/${part(chatId)}`),
    updateAgentMemoryMember: (id, chatId, userId, body) => write(id, `/memories/${part(chatId)}/members/${part(userId)}`, 'PUT', body),
    deleteAgentMemory: (id, chatId) => write(id, `/memories/${part(chatId)}`, 'DELETE'),
    deleteAgentMemoryMember: (id, chatId, userId) => write(id, `/memories/${part(chatId)}/members/${part(userId)}`, 'DELETE'),
    consolidateAgentMemory: (id, body) => write(id, '/memories/consolidate', 'POST', body),
    getAgentSkills: (id) => get(id, '/skills'),
    updateAgentSkill: (id, skillId, body) => write(id, `/skills/${part(skillId)}`, 'PATCH', body),
    previewAgentPrompt: (id, body = {}) => write(id, '/prompt-preview', 'POST', body)
  };
}
