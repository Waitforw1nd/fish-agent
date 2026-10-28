import { BridgeError, asBridgeError } from '../errors.js';
import { normalizeSegments } from './message.js';

export function okResponse(data, echo = undefined) {
  return { status: 'ok', retcode: 0, data: data ?? null, wording: '', ...(echo !== undefined ? { echo } : {}) };
}

export function failedResponse(error, echo = undefined) {
  const err = asBridgeError(error);
  return {
    status: 'failed',
    retcode: Number.isFinite(Number(err.retcode)) ? Number(err.retcode) : 100,
    data: null,
    wording: String(err.wording || err.message || 'B 站桥接操作失败'),
    ...(echo !== undefined ? { echo } : {})
  };
}

function requireId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new BridgeError(`${name} 必须是安全整数`, {
      kind: 'INPUT', code: 400, retcode: 1400, wording: `${name} 必须是安全整数`
    });
  }
  return id;
}

export const SUPPORTED_ACTIONS = Object.freeze([
  'get_login_info',
  'get_status',
  'get_version_info',
  'send_group_msg',
  'send_private_msg',
  'send_msg',
  'get_msg',
  'get_group_info',
  'get_group_list',
  'get_group_member_info',
  'get_group_member_list',
  'get_friend_list',
  'get_stranger_info',
  'can_send_image',
  'can_send_record',
  'bili_get_video_context',
  'bili_inspect_user',
  'bili_reply_comment',
  'bili_like',
  'bili_live_send_msg'
]);

export function createActionHandler({ bridge, logger = null } = {}) {
  if (!bridge) throw new TypeError('createActionHandler 需要 bridge');
  const actions = {
    async get_login_info() {
      return bridge.loginInfo();
    },
    async get_status() {
      return bridge.onebotStatus();
    },
    async get_version_info() {
      return bridge.versionInfo();
    },
    async send_group_msg(params) {
      return bridge.sendGroupMessage({
        groupId: requireId(params.group_id, 'group_id'),
        message: normalizeSegments(params.message)
      });
    },
    async send_private_msg(params) {
      return bridge.sendPrivateMessage({
        userId: requireId(params.user_id, 'user_id'),
        message: normalizeSegments(params.message)
      });
    },
    async send_msg(params) {
      const type = params.message_type || (params.group_id != null ? 'group' : 'private');
      if (type === 'group') {
        return bridge.sendGroupMessage({
          groupId: requireId(params.group_id, 'group_id'),
          message: normalizeSegments(params.message)
        });
      }
      return bridge.sendPrivateMessage({
        userId: requireId(params.user_id, 'user_id'),
        message: normalizeSegments(params.message)
      });
    },
    async get_msg(params) {
      return bridge.getMessage(requireId(params.message_id, 'message_id'));
    },
    async get_group_info(params) {
      return bridge.getGroupInfo(requireId(params.group_id, 'group_id'));
    },
    async get_group_list() {
      return bridge.getGroupList();
    },
    async get_group_member_info(params) {
      return bridge.getGroupMemberInfo(requireId(params.group_id, 'group_id'), requireId(params.user_id, 'user_id'));
    },
    async get_group_member_list(params) {
      return bridge.getGroupMemberList(requireId(params.group_id, 'group_id'));
    },
    async get_friend_list() {
      return bridge.getFriendList();
    },
    async get_stranger_info(params) {
      return bridge.getStrangerInfo(requireId(params.user_id, 'user_id'));
    },
    async can_send_image() {
      return { yes: true, scope: 'private', formats: ['base64', 'data-url'] };
    },
    async can_send_record() {
      return { yes: false };
    },
    async bili_get_video_context(params) {
      return bridge.getVideoContext({
        bvid: params.bvid || undefined,
        aid: params.aid || undefined,
        cid: params.cid || undefined,
        url: params.url || undefined,
        groupId: params.group_id || undefined,
        includeSubtitles: params.includeSubtitles !== false,
        includeComments: params.includeComments === true,
        download: params.download !== false
      });
    },
    async bili_inspect_user(params) {
      return bridge.inspectUser({
        mid: params.mid ?? params.user_id,
        includeVideos: params.includeVideos === true,
        includeDynamics: params.includeDynamics === true
      });
    },
    async bili_reply_comment(params) {
      return bridge.replyComment({
        bvid: params.bvid || undefined,
        oid: params.oid || undefined,
        aid: params.aid || undefined,
        message: String(params.message ?? params.text ?? ''),
        root: params.root ?? params.rootId ?? '0',
        parent: params.parent ?? params.parentId ?? '0'
      });
    },
    async bili_like(params) {
      return bridge.likeComment({
        oid: params.oid || undefined,
        bvid: params.bvid || undefined,
        aid: params.aid || undefined,
        rpid: params.rpid,
        commentId: params.commentId,
        action: params.action ?? 1
      });
    },
    async bili_live_send_msg(params) {
      const roomId = params.room_id ?? params.roomId;
      return bridge.sendLiveDanmaku({ roomId, text: params.text ?? params.message });
    }
  };

  return async function handleAction(action, params = {}, echo = undefined) {
    const name = String(action || '');
    const fn = actions[name];
    if (!fn) {
      return failedResponse(new BridgeError(`不支持的 OneBot action: ${name}`, {
        kind: 'UNSUPPORTED',
        code: 404,
        retcode: 1404,
        wording: `不支持的操作 ${name || '(空)'}`
      }), echo);
    }
    try {
      const data = await fn(params || {});
      return okResponse(data, echo);
    } catch (error) {
      logger?.warn?.('OneBot action 失败', { action: name, error: error?.wording || error?.message });
      return failedResponse(error, echo);
    }
  };
}
