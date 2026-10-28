import { BridgeError } from '../errors.js';

export class DynamicService {
  constructor({ api }) { this.api = api; }

  async detail(dynamicId) {
    if (!/^\d+$/.test(String(dynamicId || ''))) throw new BridgeError('动态 ID 无效', { kind: 'INPUT', code: 400 });
    const payload = await this.api.request({ method: 'GET', service: 'api', path: '/x/polymer/web-dynamic/v1/detail', params: { id: String(dynamicId) }, allowedCodes: [0], retries: 1 });
    const item = payload?.data?.item;
    const type = Number(item?.basic?.comment_type);
    const oid = String(item?.basic?.comment_id_str || '');
    if (![11, 17].includes(type) || !/^\d+$/.test(oid)) throw new BridgeError('动态评论主体不可用或不支持', { kind: 'UNSUPPORTED', code: 400, retcode: 1404 });
    return { dynamicId: String(item.id_str || dynamicId), type, oid, title: String(item.modules?.module_dynamic?.desc?.text || '').slice(0, 200), ownerMid: String(item.modules?.module_author?.mid || '') };
  }
}
