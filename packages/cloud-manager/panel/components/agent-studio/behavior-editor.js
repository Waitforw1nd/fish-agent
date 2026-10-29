import { h } from '../../lib/dom.js';
import { button, checkbox, entries, field, input, lines, panel, perform, textarea } from '../common.js';

export function createBehaviorEditor(ctx, config, refresh) {
  const ro = ctx.readOnly, store = config.store || {};
  const tierOptions = [
    ['1', '仅被 @', '只在直接召唤时回复，节省额度。'],
    ['2', '@ 与关键词', '命中关键词时也会参与。'],
    ['3', '随机接话', '在前两档基础上按概率参与。'],
    ['4', '自主判断', '完整消息交给模型判断是否接话。']
  ];
  let selectedTier = String(store.contextTier || 4);
  const tierCards = h('div', { class: 'workspace-tier-grid' }, ...tierOptions.map(([value, title, description]) => {
    const radio = h('input', { type: 'radio', name: 'agent-response-tier', value, checked: selectedTier === value, disabled: ro });
    radio.addEventListener('change', () => { if (radio.checked) selectedTier = value; });
    return h('label', { class: 'workspace-tier-card' }, radio, h('strong', {}, `${value} 档 · ${title}`), h('span', { class: 'note' }, description));
  }));
  const keywords = textarea(lines(store.keywords), { disabled: ro, placeholder: '每行一个关键词' });
  const random = input(store.randomPercent ?? 10, { type: 'range', min: 0, max: 100, step: 1, disabled: ro });
  const randomValue = h('output', {}, `${random.value}%`);
  random.addEventListener('input', () => { randomValue.textContent = `${random.value}%`; });
  const history = input(store.historyCount ?? 80, { type: 'number', min: 1, max: 1000, disabled: ro });
  const unified = checkbox('所有群使用同一档位', store.unifiedTier !== false, ro);
  const group = textarea(Object.entries(store.groupSliderPos || {}).map(([id, pos]) => `${id}: ${pos}`).join('\n'), { disabled: ro, placeholder: '群号: 滑条位置 0~100，每群一行' });
  const peak = checkbox('启用峰谷时段自动切换', !!store.peakSchedule?.enabled, ro);
  const peakStart = input(store.peakSchedule?.peak?.start || '09:00', { type: 'time', disabled: ro });
  const peakEnd = input(store.peakSchedule?.peak?.end || '18:00', { type: 'time', disabled: ro });
  const peakPos = input(store.peakSchedule?.peak?.sliderPos ?? 10, { type: 'number', min: 0, max: 100, disabled: ro });
  const valleyPos = input(store.peakSchedule?.valley?.sliderPos ?? 100, { type: 'number', min: 0, max: 100, disabled: ro });
  const groupPeak = textarea(Object.entries(store.groupPeakPos || {}).map(([id, v]) => `${id}: ${v.peak}, ${v.valley}`).join('\n'), { disabled: ro, placeholder: '群号: 高峰位置, 低谷位置' });
  const sticker = checkbox('发送表情包', config.sticker?.enabled !== false, ro);
  const collect = checkbox('收藏表情包', config.sticker?.collectEnabled !== false, ro);
  const encourage = input(config.sticker?.encourage ?? 1, { type: 'number', min: 0, max: 3, disabled: ro });
  const proactive = checkbox('冷场主动开话题', !!config.proactive?.enabled, ro);
  const active = checkbox('活跃话题持续跟聊', !!config.chatActive?.enabled, ro);
  const mute = checkbox('启用临时禁言指令', config.commandMute?.enabled !== false, ro);
  const muteCommand = input(config.commandMute?.command || '/安静', { disabled: ro });
  const muteDuration = input(config.commandMute?.durationMin ?? 30, { type: 'number', min: 0, disabled: ro });
  const parseMap = (raw, dual = false) => {
    const output = {};
    for (const row of raw.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const match = row.match(/^\s*([^:：\s]+)\s*[:：]\s*(\d+(?:\.\d+)?)(?:\s*[,，]\s*(\d+(?:\.\d+)?))?\s*$/);
      if (!match || Number(match[2]) > 100 || (dual && (match[3] == null || Number(match[3]) > 100))) throw new Error('分群档位格式不正确，滑条位置应为 0 至 100。');
      output[match[1]] = dual ? { peak: Number(match[2]), valley: Number(match[3]) } : Number(match[2]);
    }
    return output;
  };
  const save = button('保存响应与互动', async () => {
    let positions, peaks;
    try { positions = parseMap(group.value); peaks = parseMap(groupPeak.value, true); }
    catch (error) { ctx.toast?.show?.(error.message, { tone: 'danger' }); return; }
    const result = await perform(ctx, () => ctx.api.updateAgentConfig(ctx.tenantId, {
      store: {
        contextTier: Number(selectedTier), randomPercent: Number(random.value), historyCount: Number(history.value),
        keywords: [...new Set(keywords.value.split(/[,，\r\n]+/).map((word) => word.trim()).filter(Boolean))], unifiedTier: unified.control.checked,
        groupSliderPos: { __replace__: positions }, groupPeakPos: { __replace__: peaks },
        peakSchedule: { enabled: peak.control.checked, peak: { start: peakStart.value, end: peakEnd.value, sliderPos: Number(peakPos.value) }, valley: { sliderPos: Number(valleyPos.value) } }
      },
      sticker: { enabled: sticker.control.checked, collectEnabled: collect.control.checked, encourage: Number(encourage.value) },
      proactive: { enabled: proactive.control.checked }, chatActive: { enabled: active.control.checked },
      commandMute: { enabled: mute.control.checked, command: muteCommand.value, durationMin: Number(muteDuration.value) }
    }));
    if (result !== undefined) refresh();
  }, ro, 'primary');
  return h('div', { class: 'workspace-stack' },
    panel('响应档位', tierCards, field('关键词', keywords), field('随机接话概率', h('span', { class: 'workspace-range' }, random, randomValue)),
      field('读取历史条数', history), unified.node, field('分群独立档位', group)),
    panel('峰谷时段', peak.node, field('高峰开始', peakStart), field('高峰结束', peakEnd),
      field('高峰滑条位置 0~100', peakPos), field('低谷滑条位置 0~100', valleyPos), field('分群峰谷位置', groupPeak)),
    panel('拟人互动', sticker.node, collect.node, field('表情积极度 0~3', encourage), proactive.node, active.node, mute.node,
      field('禁言指令', muteCommand), field('禁言时长（分钟）', muteDuration), save)
  );
}
