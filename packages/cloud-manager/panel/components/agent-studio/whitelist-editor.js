import { h, clear } from '../../lib/dom.js';
import { normalizeAgentContacts } from '../../lib/normalize.js';
import { button, checkbox, entries, field, input, lines, optionalCall, panel, perform, textarea } from '../common.js';

export function createWhitelistEditor(ctx, config, refresh) {
  const ro = ctx.readOnly;
  const groups = textarea(lines(config.allow?.groups), { disabled: ro, placeholder: '每行一个群号，也可用逗号分隔' });
  const friends = textarea(lines(config.allow?.private), { disabled: ro, placeholder: '每行一个 QQ 号' });
  const denyGroups = textarea(lines(config.deny?.groups), { disabled: ro });
  const denyPrivate = textarea(lines(config.deny?.private), { disabled: ro });
  const globalBlocklist = textarea(lines(config.globalBlocklist), { disabled: ro });
  const blocklist = textarea(Object.entries(config.blocklist || {}).map(([group, users]) => `${group}: ${(users || []).join(', ')}`).join('\n'), { disabled: ro, placeholder: '群号: QQ号, QQ号（每群一行）' });
  const contactList = h('div', { class: 'workspace-contact-list' }, h('p', { class: 'note' }, '加载联系人后可搜索并勾选群或好友。'));
  const search = input('', { placeholder: '搜索群名、群号或好友', 'aria-label': '搜索联系人' });
  let contacts = { online: false, groups: [], friends: [] };
  function renderContacts() {
    clear(contactList);
    if (!contacts.online) {
      contactList.appendChild(h('p', { class: 'note' }, 'QQ 当前离线，请手动输入群号和好友 QQ 号。'));
      return;
    }
    const term = search.value.trim().toLowerCase();
    const all = [...contacts.groups, ...contacts.friends].filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(term));
    if (!all.length) contactList.appendChild(h('p', { class: 'note' }, '没有匹配的联系人。'));
    for (const item of all) {
      const target = item.kind === 'group' ? groups : friends;
      const choice = checkbox(`${item.name || item.id}（${item.id}）${item.kind === 'group' ? ' · 群' : ' · 好友'}`, entries(target.value).includes(item.id), ro);
      choice.control.addEventListener('change', () => {
        const selected = new Set(entries(target.value));
        if (choice.control.checked) selected.add(item.id); else selected.delete(item.id);
        target.value = [...selected].join('\n');
      });
      contactList.appendChild(choice.node);
    }
  }
  search.addEventListener('input', renderContacts);
  const loadContacts = button('拉取 QQ 联系人', async () => {
    const payload = await perform(ctx, () => optionalCall(ctx.api, 'getAgentContacts', ctx.tenantId), '');
    if (payload) { contacts = normalizeAgentContacts(payload); renderContacts(); }
  });
  const save = button('保存白名单', async () => {
    const groupsAllowed = entries(groups.value), friendsAllowed = entries(friends.value);
    const groupsDenied = entries(denyGroups.value), friendsDenied = entries(denyPrivate.value), global = entries(globalBlocklist.value);
    if ([...groupsAllowed, ...friendsAllowed, ...groupsDenied, ...friendsDenied, ...global].some((value) => !/^\d{1,20}$/.test(value))) {
      ctx.toast?.show?.('群号和 QQ 号必须为数字。', { tone: 'danger' }); return;
    }
    const blocks = {};
    for (const row of blocklist.value.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const match = row.match(/^\s*([^:：\s]+)\s*[:：]\s*(.*)$/);
      if (!match) { ctx.toast?.show?.('群员屏蔽格式应为“群号: QQ号, QQ号”。', { tone: 'danger' }); return; }
      const members = entries(match[2]);
      if (!/^\d{1,20}$/.test(match[1]) || members.some((member) => !/^\d{1,20}$/.test(member))) {
        ctx.toast?.show?.('群员屏蔽中的群号和 QQ 号必须为数字。', { tone: 'danger' }); return;
      }
      blocks[match[1]] = members;
    }
    const result = await perform(ctx, () => ctx.api.updateAgentConfig(ctx.tenantId, {
      allow: { groups: groupsAllowed, private: friendsAllowed },
      deny: { groups: groupsDenied, private: friendsDenied },
      blocklist: { __replace__: blocks }, globalBlocklist: global
    }));
    if (result !== undefined) refresh();
  }, ro, 'primary');
  return h('div', { class: 'workspace-stack' },
    panel('选择互动对象', h('p', { class: 'note' }, '白名单为空时机器人不会回复任何群或私聊。'),
      loadContacts, field('搜索联系人', search), contactList,
      field('允许的群号', groups), field('允许的私聊 QQ 号', friends)),
    panel('黑名单与群员屏蔽', field('拒绝的群号', denyGroups), field('拒绝的私聊 QQ 号', denyPrivate),
      field('所有群屏蔽的成员', globalBlocklist), field('指定群内屏蔽成员', blocklist), save)
  );
}
