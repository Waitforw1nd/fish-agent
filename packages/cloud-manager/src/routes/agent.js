import { httpError, parseQueryInt } from '../contracts/http.js';

const decoded = (value) => {
  try { return decodeURIComponent(String(value)); }
  catch { throw httpError(400, 'INVALID_PARAMETER', '路径参数无效'); }
};

export function registerAgentRoutes(router, deps) {
  const { tenantCtx, readBody, sendOk, agentSettings: service, extensionService } = deps;
  const base = '/api/tenants/:id/agent';
  const tenant = (ctx, role = 'viewer') => tenantCtx(ctx, role).tenant;
  const bodyLimit = 12 * 1024 * 1024;
  const limitQuery = (ctx) => ctx.url.searchParams.has('limit')
    ? `?limit=${parseQueryInt(ctx.url.searchParams, 'limit', 100, 1, 10000)}` : '';

  router.get(`${base}/config`, async (ctx) => sendOk(ctx, await service.getConfig(tenant(ctx))));
  const update = async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.updateConfig(row, await readBody(ctx)));
  };
  router.patch(`${base}/config`, update);
  router.put(`${base}/config`, update);
  router.get(`${base}/personas`, async (ctx) => sendOk(ctx, await service.personas(tenant(ctx))));
  router.post(`${base}/personas`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.savePersona(row, await readBody(ctx)), 201);
  });
  router.delete(`${base}/personas/:templateId`, async (ctx) => {
    sendOk(ctx, await service.deletePersona(tenant(ctx, 'operator'), decoded(ctx.params.templateId)));
  });
  router.post(`${base}/persona-cards/preview`, async (ctx) => {
    tenant(ctx, 'operator');
    const result = service.previewCard(await readBody(ctx, bodyLimit));
    sendOk(ctx, { card: result.card });
  });
  router.post(`${base}/persona-cards/import`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.importCard(row, await readBody(ctx, bodyLimit)), 201);
  });
  router.get(`${base}/contacts`, async (ctx) => sendOk(ctx, await service.contacts(tenant(ctx))));
  router.get(`${base}/status`, async (ctx) => sendOk(ctx, await service.status(tenant(ctx))));
  router.put(`${base}/pause`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    const body = await readBody(ctx);
    if (typeof body.paused !== 'boolean') throw httpError(400, 'INVALID_PAUSE', 'paused 必须是布尔值');
    const clear = body.paused === false && body.clearUnread === true;
    sendOk(ctx, await service.bridge(row, clear ? 'DELETE' : 'POST', '/api/pause', body));
  });
  router.get(`${base}/sessions`, async (ctx) => sendOk(ctx, await service.sessions(tenant(ctx), limitQuery(ctx))));
  router.post(`${base}/sessions/clear-finished`, async (ctx) => sendOk(ctx, await service.bridge(tenant(ctx, 'operator'), 'POST', '/api/sessions/clear-finished', {})));
  router.post(`${base}/sessions/:sessionId/:action`, async (ctx) => {
    sendOk(ctx, await service.sessionAction(tenant(ctx, 'operator'), decoded(ctx.params.sessionId), decoded(ctx.params.action)));
  });
  router.get(`${base}/chats`, async (ctx) => sendOk(ctx, await service.chats(tenant(ctx))));
  router.get(`${base}/chats/:chatId/messages`, async (ctx) => {
    sendOk(ctx, await service.messages(tenant(ctx), decoded(ctx.params.chatId), limitQuery(ctx)));
  });
  router.post(`${base}/chats/:chatId/actions`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.chatAction(row, decoded(ctx.params.chatId), await readBody(ctx)));
  });
  router.get(`${base}/memories`, async (ctx) => sendOk(ctx, await service.memories(tenant(ctx))));
  router.get(`${base}/memories/:chatId`, async (ctx) => sendOk(ctx, await service.memory(tenant(ctx), decoded(ctx.params.chatId))));
  router.put(`${base}/memories/:chatId/members/:userId`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.memoryMember(row, decoded(ctx.params.chatId), decoded(ctx.params.userId), 'PUT', await readBody(ctx)));
  });
  router.delete(`${base}/memories/:chatId/members/:userId`, async (ctx) => {
    sendOk(ctx, await service.memoryMember(tenant(ctx, 'operator'), decoded(ctx.params.chatId), decoded(ctx.params.userId), 'DELETE'));
  });
  router.delete(`${base}/memories/:chatId`, async (ctx) => sendOk(ctx, await service.deleteMemory(tenant(ctx, 'operator'), decoded(ctx.params.chatId))));
  router.post(`${base}/memories/consolidate`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    sendOk(ctx, await service.bridge(row, 'POST', '/api/memory-files/consolidate', await readBody(ctx)), 202);
  });
  router.get(`${base}/skills`, async (ctx) => sendOk(ctx, await service.skills(tenant(ctx))));
  router.patch(`${base}/skills/:skillId`, async (ctx) => {
    const row = tenant(ctx, 'operator');
    const input = await readBody(ctx);
    const result = await extensionService.withLock(`tenant:${row.id}`, () => service.updateSkill(row, decoded(ctx.params.skillId), input));
    sendOk(ctx, result);
  });
  router.post(`${base}/prompt-preview`, async (ctx) => {
    const row = tenant(ctx);
    const input = await readBody(ctx);
    sendOk(ctx, await service.bridge(row, 'POST', '/api/prompt-preview', input));
  });
}
