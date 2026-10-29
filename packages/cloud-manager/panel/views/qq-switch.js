import { h } from '../lib/dom.js';
import { normalizeQQOperation, normalizeQQStatus } from '../lib/normalize.js';
import { createPoller } from '../lib/polling.js';
import { openQrFlow } from './qr.js';

const phases = { preflight: '检查环境', snapshot_intent: '保存旧内核状态', snapshot_saved: '旧状态已保存', quiesce_intent: '暂停 QQ 任务', quiesced: 'QQ 任务已暂停', quiescing: '暂停 QQ 任务', stop_source_intent: '停止旧内核', source_stopped: '旧内核已停止', stopping_old: '停止旧内核', prepare_target: '准备目标内核', start_target_intent: '启动目标内核', starting_target: '启动目标内核', waiting_qr: '等待扫码', verifying: '验证账号和连接', committed: '连接已提交', committing: '提交连接', resume_intent: '恢复 Agent', verify_agent: '验证 Agent 通道', cleaning_up: '清理资源', rolling_back: '正在回滚', rollback_stop_intent: '回滚：停止目标', rollback_target_stopped: '回滚：目标已停止', rollback_start_intent: '回滚：启动旧内核', rollback_saved: '回滚：配置已恢复', rollback_resume_intent: '回滚：恢复 Agent' };
const statuses = { succeeded: '切换完成', failed: '切换失败', cancelled: '切换已取消', needs_attention: '需要管理员处理' };

export function createSwitchController({ api, tenantId, modalRoot, toast, timers, onChange = () => {} }) {
  let operation = null, alive = true, pending = false, retry = null, qr = null, sequence = 0, writable = true;
  const text = h('p', { class: 'note', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, '取消切换');
  const scan = h('button', { class: 'btn btn-soft', type: 'button', hidden: true }, '继续切换扫码');
  const node = h('div', {}, h('p', { class: 'note' }, '切换期间 QQ 暂停，可能需要重新扫码；人设和记忆保留，同实例的 Bili 可能短时中断。扫码后请保持此页面可见并等待最终结果；离开后可返回继续检查。'), text, cancel, scan);
  const poller = createPoller({ timers: timers || undefined, intervalMs: 3000, task: refresh, onError: () => { if (alive) text.textContent = '切换状态读取失败，正在重试。'; } });
  function apply(value) {
    const next = normalizeQQOperation(value);
    if (!next.operationId) return;
    if (operation && (operation.operationId !== next.operationId || next.phase !== 'waiting_qr' || String(operation.runtimeGeneration) !== String(next.runtimeGeneration))) qr?.close();
    operation = next;
    const rollbackLabels = { succeeded: '已恢复旧内核', restored: '已恢复旧内核', failed: '旧内核恢复失败，请联系管理员', needs_attention: '旧内核也待处理，请联系管理员', skipped: '未恢复旧内核', stopped: '已停止，未恢复旧内核' };
    const rollback = next.rollback?.message || rollbackLabels[next.rollback?.status] || next.rollback?.status || '';
    text.textContent = `切换状态：${statuses[next.status] || phases[next.phase] || '处理中'}${next.error ? `：${next.error}` : ''}${rollback ? `；回滚：${rollback}` : ''}`;
    cancel.hidden = !writable || !next.canCancel || next.status !== 'running';
    scan.hidden = !writable || next.status !== 'running' || next.phase !== 'waiting_qr';
    if (next.status === 'running') { if (!poller.isRunning()) poller.start(); }
    else { poller.stop(); qr?.close(); }
    onChange(next);
  }
  async function refresh() {
    if (!alive || pending || !operation?.operationId) return;
    const id = operation.operationId, run = ++sequence;
    let result;
    if (writable && typeof api.advanceQQOperation === 'function') {
      try { result = await api.advanceQQOperation(tenantId, id); }
      catch (error) {
        if (error.status !== 403) throw error;
        result = await api.getQQOperation(tenantId, id);
      }
    } else result = await api.getQQOperation(tenantId, id);
    if (alive && run === sequence && operation?.operationId === id) apply(result);
  }
  async function restore(id) {
    if (!alive || !id || typeof api.getQQOperation !== 'function') return;
    if (operation?.operationId === id) return;
    const run = ++sequence;
    try { const result = await api.getQQOperation(tenantId, id); if (alive && run === sequence) apply(result); }
    catch { if (alive && run === sequence) text.textContent = '无法读取切换状态，请刷新页面重试。'; }
  }
  async function start({ driver, expectedRevision, uin }) {
    if (!alive || !writable || pending || ['running', 'needs_attention'].includes(operation?.status)) return;
    if (expectedRevision == null) { text.textContent = '配置版本不可用，请刷新状态后重试。'; return; }
    const fingerprint = JSON.stringify([driver, expectedRevision, uin]);
    if (!retry || retry.fingerprint !== fingerprint) {
      if (!globalThis.crypto?.getRandomValues) { text.textContent = '浏览器无法生成安全请求标识，请使用安全连接。'; return; }
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      retry = { fingerprint, key: Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('') };
    }
    pending = true; onChange(operation);
    try {
      const result = await api.switchQQ(tenantId, { driver, expectedRevision, uin, idempotencyKey: retry.key });
      if (alive) { retry = null; apply(result); }
    } catch (error) {
      if (!alive) return;
      const id = error.payload?.operationId || error.payload?.operation?.operationId;
      if (error.status === 409) {
        retry = null;
        text.textContent = ['REVISION_CONFLICT', 'QQ_REVISION_CONFLICT'].includes(error.code) ? '配置已变化，请刷新状态后重新选择。' : '已有切换操作或请求冲突，请刷新状态。';
        if (id) await restore(id);
        else if (typeof api.getQQStatus === 'function') {
          try { const status = normalizeQQStatus(await api.getQQStatus(tenantId)); if (status.activeOperationId) await restore(status.activeOperationId); } catch { /* keep the conflict visible */ }
        }
      } else text.textContent = error.isNetwork ? '请求结果未知，重试将使用相同请求标识。' : (error.message || '切换请求失败。');
    } finally { pending = false; if (alive) onChange(operation); }
  }
  cancel.addEventListener('click', async () => {
    if (!writable || operation?.status !== 'running' || !operation.canCancel || pending) return;
    sequence++;
    pending = true; cancel.disabled = true;
    try { const result = await api.cancelQQOperation(tenantId, operation.operationId); if (alive) apply(result); }
    catch (error) {
      if (!alive) return;
      if (error.status === 409 && error.code === 'CANCEL_TOO_LATE') {
        operation = { ...operation, canCancel: false };
        cancel.hidden = true;
        text.textContent = '切换配置已提交，无法取消；正在继续确认连接状态。';
      } else text.textContent = error.message || '取消失败，请刷新状态。';
    }
    finally { pending = false; cancel.disabled = false; }
  });
  scan.addEventListener('click', () => {
    if (!writable || pending || operation?.status !== 'running') return;
    if (!operation || operation.phase !== 'waiting_qr' || operation.runtimeGeneration == null || operation.qrGeneration == null) { text.textContent = '等待切换操作提供二维码代次。'; return; }
    qr?.close();
    qr = openQrFlow({ modalRoot, api, tenantId, toast, timers: timers || undefined, safeMessages: true,
      operationId: operation.operationId, runtimeGeneration: operation.runtimeGeneration, qrGeneration: operation.qrGeneration,
      onConfirmed: () => { void refresh(); } });
  });
  return { node, start, restore, setWritable(value) { writable = Boolean(value); if (operation) apply(operation); }, get operation() { return operation; }, get busy() { return pending || ['running', 'needs_attention'].includes(operation?.status); }, destroy() { alive = false; sequence++; poller.stop(); qr?.close(); } };
}
