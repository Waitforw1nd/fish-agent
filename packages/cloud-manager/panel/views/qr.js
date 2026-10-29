// QQ / B 站扫码弹窗：拉码、3 秒轮询登录状态、过期倒计时、成功后自动关闭。
// 弹窗关闭即停表，不在后台持续请求二维码状态。

import { h, setHidden, setText } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { normalizeBiliLogin, normalizeQr, normalizeQQStatus, normalizeQQOperation } from '../lib/normalize.js';
import { createPoller } from '../lib/polling.js';
import { defaultTimers } from '../lib/timers.js';
import { apiErrorMessage, qrCountdown } from '../lib/view-data.js';
import { redactText } from '../lib/format.js';
import { alertBox, setAlert, spinner } from '../lib/ui.js';

export function openQrFlow({
  modalRoot,
  api,
  tenantId,
  kind = 'qq',
  toast,
  onConfirmed = null,
  safeMessages = false,
  capabilities = {},
  runtimeGeneration = null,
  operationId = null,
  qrGeneration = null,
  timers = defaultTimers(),
  nowFn = Date.now
} = {}) {
  if (!modalRoot) throw new TypeError('缺少弹窗容器');
  const isQq = kind === 'qq';
  let closed = false;
  let generation = 0;
  let poller = null;
  let countdownTimer = null;
  let currentQr = null;
  let expireHandled = false;
  let expectedRuntime = runtimeGeneration;
  let expectedQr = qrGeneration;
  let loading = false;
  function matchesOperation(value) {
    if (String(value || '') === String(operationId || '')) return true;
    stopBackground();
    setPlaceholder('切换操作已变化，请重新打开二维码。');
    setState('切换操作已变化', 'danger');
    refresh.disabled = true;
    return false;
  }
  async function matchesQr(qr, run) {
    if (!operationId) {
      expectedQr = qr.qrGeneration;
      return true;
    }
    const operation = normalizeQQOperation(await api.getQQOperation(tenantId, operationId));
    if (closed || run !== generation) return false;
    if (operation.operationId !== operationId || operation.status !== 'running' || operation.phase !== 'waiting_qr' || String(operation.runtimeGeneration) !== String(expectedRuntime)) {
      stopBackground(); setPlaceholder('切换状态已变化，请重新打开二维码。'); setState('切换状态已变化', 'danger'); return false;
    }
    if (operation.qrGeneration == null || qr.qrGeneration == null || String(operation.qrGeneration) !== String(qr.qrGeneration)) {
      setPlaceholder('正在等待最新二维码…', true);
      setText(countdown, '');
      if (countdownTimer !== null) { timers.clearInterval(countdownTimer); countdownTimer = null; }
      return false;
    }
    expectedQr = operation.qrGeneration;
    return true;
  }
  const canRefresh = !isQq || (!operationId && (capabilities.qrcodeRefresh === true || capabilities.refreshQrcode === true || capabilities.qrRefresh === true));
  function matchesRuntime(value) {
    if (value == null) return !operationId;
    if (expectedRuntime == null) { expectedRuntime = value; return true; }
    if (String(value) === String(expectedRuntime)) return true;
    stopBackground();
    setPlaceholder('运行实例已变化，请关闭并重新打开二维码。');
    setState('运行实例已变化', 'danger');
    refresh.disabled = true;
    return false;
  }

  const stateDot = h('span', { class: 'status-dot', dataset: { tone: 'warn' }, 'aria-hidden': 'true' });
  const stateText = h('span', {}, '正在获取二维码…');
  const stateRow = h('div', { class: 'qr-state', 'aria-live': 'polite' }, stateDot, stateText);

  const image = h('img', { alt: isQq ? 'QQ 登录二维码' : 'B 站登录二维码', hidden: true });
  const placeholder = h('div', { class: 'qr-placeholder' }, spinner(), h('span', {}, '二维码生成中…'));
  const overlay = h('div', { class: 'qr-overlay', hidden: true });
  const frame = h('div', { class: 'qr-frame' }, placeholder, image, overlay);
  const countdown = h('p', { class: 'qr-countdown' }, '');
  const error = alertBox('', 'danger', { hidden: true });
  const steps = h('div', { class: 'qr-steps' });

  const refreshLabel = isQq ? '获取新二维码' : '刷新二维码';
  const refresh = h('button', { class: 'btn btn-soft', type: 'button', hidden: !canRefresh }, refreshLabel);
  const closeButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '关闭');
  const actions = h('div', { class: 'qr-actions' }, refresh);

  const content = h('div', { class: 'qr-panel' },
    stateRow,
    frame,
    countdown,
    error,
    actions,
    steps
  );

  steps.appendChild(h('div', {}, h('strong', {}, '扫码步骤'), isQq ? '：手机 QQ → 扫一扫 → 确认登录。' : '：B 站 App → 我的 → 扫一扫 → 确认授权。'));
  steps.appendChild(h('div', {}, '二维码仅在当前弹窗展示，关闭后立即停止轮询；不会写入浏览器存储。'));
  if (isQq && operationId) steps.appendChild(h('div', {}, '当前切换会话不支持获取新二维码，可继续扫码；如需重新开始，请关闭弹窗后取消切换，再重新发起。关闭弹窗不会取消切换。'));

  const modal = openModal({
    root: modalRoot,
    kicker: isQq ? 'QQ Channel' : 'Bilibili Channel',
    title: isQq ? '扫码登录 QQ' : '扫码绑定 B 站',
    description: isQq
      ? (safeMessages ? '使用手机 QQ 扫码确认登录。二维码有效期以服务端返回为准。' : '登录成功后协议端会自动连接 OneBot。二维码有效期以服务端返回为准。')
      : '授权成功后即可启用评论、私信、UP 视频与直播订阅。',
    content,
    footer: [closeButton],
    onClose: () => cleanup()
  });

  closeButton.addEventListener('click', () => modal.close('button'));

  function stopBackground() {
    generation += 1;
    poller?.stop();
    poller = null;
    if (countdownTimer !== null) {
      timers.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    stopBackground();
  }

  function setState(text, tone = 'warn', overlayText = '') {
    setText(stateText, text);
    stateDot.dataset.tone = tone;
    if (overlayText) {
      overlay.replaceChildren(h('span', {}, overlayText));
      setHidden(overlay, false);
    } else {
      setHidden(overlay, true);
    }
  }

  function setPlaceholder(text, showSpinner = false) {
    placeholder.replaceChildren();
    if (showSpinner) placeholder.appendChild(spinner());
    placeholder.appendChild(h('span', {}, text));
    setHidden(placeholder, false);
    setHidden(image, true);
  }

  function startCountdown(qr) {
    if (countdownTimer !== null) {
      timers.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    expireHandled = false;
    const info = qrCountdown(qr.expiresAt, nowFn());
    if (!info.hasExpiry) {
      setText(countdown, '');
      return;
    }
    setText(countdown, info.text);
    if (info.expired) {
      markExpired();
      return;
    }
    countdownTimer = timers.setInterval(() => {
      if (closed) return;
      const current = qrCountdown(qr.expiresAt, nowFn());
      setText(countdown, current.text);
      if (current.expired) markExpired();
    }, 1000);
  }

  function markExpired() {
    if (closed || expireHandled) return;
    expireHandled = true;
    poller?.stop();
    poller = null;
    if (countdownTimer !== null) {
      timers.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    setState('二维码已过期', 'danger', '二维码已过期');
    setText(countdown, '二维码已过期');
    refresh.disabled = false;
    refresh.textContent = refreshLabel;
  }

  function showQr(qr) {
    currentQr = qr;
    image.style.filter = '';
    if (qr.imageSrc) {
      image.src = qr.imageSrc;
      image.alt = isQq ? 'QQ 登录二维码' : 'B 站登录二维码';
      setHidden(image, false);
      setHidden(placeholder, true);
    } else if (qr.content) {
      setPlaceholder('服务端已生成登录内容，但未返回二维码图片。请刷新重试。', false);
    } else {
      setPlaceholder('未获取到二维码图片，请刷新重试。', false);
    }
    if (qr.status === 'scanned') {
      setState('已扫码，请在手机确认', 'info', '已扫码，请在手机确认');
    } else if (qr.status === 'confirmed') {
      onSuccess({ nickname: '', mid: '' });
      return;
    } else if (qr.status === 'expired') {
      setState('二维码已过期', 'danger', '二维码已过期');
      markExpired();
      return;
    } else if (qr.status === 'error') {
      setState('获取二维码失败', 'danger');
      setAlert(error, safeMessages ? '获取二维码失败，请稍后重试。' : redactText(qr.message || '服务端未能生成二维码，请确认内核已准备并重试。', { maxLength: 300 }), 'danger');
    } else {
      setState('等待扫码', 'warn');
      setHidden(overlay, true);
    }
    if (qr.message && !safeMessages) setAlert(error, redactText(qr.message, { maxLength: 300 }), 'warn');
    startCountdown(qr);
  }

  async function loadQr(refreshRequested = false) {
    if (closed || loading || (refreshRequested && !canRefresh)) return;
    loading = true;
    const run = ++generation;
    poller?.stop();
    poller = null;
    if (countdownTimer !== null) {
      timers.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    refresh.disabled = true;
    refresh.hidden = !canRefresh;
    refresh.textContent = '获取中…';
    image.removeAttribute('src');
    currentQr = null;
    expireHandled = false;
    setAlert(error, '', 'info');
    setHidden(overlay, true);
    setPlaceholder('正在获取二维码…', true);
    setText(countdown, '');
    setState('正在获取二维码…', 'warn');
    try {
      let payload;
      if (isQq) {
        if (refreshRequested) {
          payload = await api.refreshQQQrcode(tenantId, expectedRuntime);
          if (closed || run !== generation) return;
          const renewed = normalizeQr(payload, { now: nowFn() });
          if (!matchesOperation(renewed.operationId)) return;
          if (renewed.runtimeGeneration != null) expectedRuntime = renewed.runtimeGeneration;
          expectedQr = null;
        } else payload = await api.getQQQrcode(tenantId);
      } else payload = await api.biliLoginQr(tenantId);
      if (closed || run !== generation) return;
      const qr = normalizeQr(payload, { now: nowFn() });
      if (isQq && (!matchesOperation(qr.operationId) || !matchesRuntime(qr.runtimeGeneration))) return;
      if (isQq && !(await matchesQr(qr, run))) {
        if (!closed && run === generation) { setPlaceholder('正在等待最新二维码…', true); startStatusPolling(run); }
        return;
      }
      if (closed || run !== generation) return;
      refresh.textContent = refreshLabel;
      if (isQq && qr.status === 'confirmed') {
        setPlaceholder('正在确认 QQ 登录状态…', true);
        setState('正在确认 QQ 登录状态…', 'info');
        startStatusPolling(run);
        return;
      }
      if (!qr.imageSrc && !qr.content && qr.status !== 'expired') {
        setState('等待二维码生成', 'warn');
        setPlaceholder(safeMessages ? '正在等待二维码生成…' : qr.message || '正在等待协议端生成二维码…', true);
        refresh.disabled = false;
        if (isQq) startStatusPolling(run);
        return;
      }
      showQr(qr);
      if (!closed) refresh.disabled = false;
      if (!qr.expired && qr.status !== 'confirmed') startStatusPolling(run);
    } catch (err) {
      if (closed || run !== generation) return;
      refresh.textContent = refreshLabel;
      if (isQq && err?.code === 'QRCODE_STALE') {
        setState('登录状态已变化', 'warn');
        setPlaceholder('请关闭后重新打开二维码');
        refresh.disabled = true;
        return;
      }
      if (isQq && err?.code === 'QQ_LOGIN_IN_PROGRESS') {
        setState('已扫码，请在手机确认', 'info');
        setPlaceholder('请在手机 QQ 完成登录确认');
        refresh.disabled = true;
        startStatusPolling(run);
        return;
      }
      setState('获取二维码失败', 'danger');
      const twoFactor = isQq && err?.code === 'NAPCAT_WEBUI_AUTH_FAILED' && /二次验证|2fa/i.test(String(err?.message || ''));
      setAlert(error, twoFactor ? 'QQ 登录服务启用了二次验证，请联系平台管理员处理。' : safeMessages ? '无法获取二维码，请稍后重试。' : apiErrorMessage(err, { fallback: '无法获取二维码，请稍后重试。' }), 'danger');
      setPlaceholder('二维码获取失败', false);
      refresh.disabled = false;
    } finally {
      loading = false;
    }
  }

  function startStatusPolling(run) {
    if (closed || run !== generation) return;
    poller?.stop();
    poller = createPoller({
      intervalMs: 3000,
      maxIntervalMs: 12_000,
      timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
      task: async () => {
        if (closed || run !== generation) return;
        if (isQq) {
          const status = operationId ? null : normalizeQQStatus(await api.getQQStatus(tenantId));
          if (closed || run !== generation || (status && (!matchesOperation(status.activeOperationId) || !matchesRuntime(status.runtimeGeneration)))) return;
          if (status && status.loginState === 'online' && status.loggedIn && status.uin && status.expectedUin && status.uin === status.expectedUin) {
            onSuccess({ nickname: status.nickname, mid: status.uin });
          } else if (status?.phase === 'waiting_confirm') {
            setState('已扫码，请在手机确认', 'info', '已扫码，请在手机确认');
          } else if (status?.phase === 'error') {
            setAlert(error, safeMessages ? 'QQ 登录异常，请联系平台管理员。' : status.error || status.message || 'QQ 登录异常，请检查内核日志。', 'danger');
          } else if (status?.phase === 'stopped') {
            setAlert(error, safeMessages ? 'QQ 登录服务未运行，请重试。' : 'QQ 进程未运行，请先在 Hosting Center 启动。', 'warning');
          } else {
            const qr = normalizeQr(await api.getQQQrcode(tenantId), { now: nowFn() });
            if (closed || run !== generation || !matchesOperation(qr.operationId) || !matchesRuntime(qr.runtimeGeneration)) return;
            if (!(await matchesQr(qr, run))) return;
            if (closed || run !== generation) return;
            if (qr.status === 'confirmed') {
              setPlaceholder('正在确认 QQ 登录状态…', true);
              setState('正在确认 QQ 登录状态…', 'info');
            } else if (qr.expired) markExpired();
            else if (qr.imageSrc || qr.content) showQr(qr);
          }
        } else {
          const login = normalizeBiliLogin(await api.getBiliLoginStatus(tenantId), { now: nowFn() });
          if (closed || run !== generation) return;
          if (login.status === 'confirmed') {
            onSuccess({ nickname: login.nickname, mid: login.mid });
          } else if (login.status === 'scanned') {
            setState('已扫码，请在手机确认', 'info', '已扫码，请在手机确认');
          } else if (login.status === 'expired') {
            markExpired();
          } else if (login.status === 'error') {
            setAlert(error, redactText(login.message || 'B 站授权失败，请刷新二维码后重试。', { maxLength: 300 }), 'danger');
          }
        }
      },
      onError: (err) => {
        if (closed || run !== generation) return;
        setAlert(error, safeMessages ? '登录状态刷新失败，正在重试。' : apiErrorMessage(err, { fallback: '登录状态刷新失败，正在重试。' }), 'warn');
      }
    });
    poller.start();
  }

  function onSuccess({ nickname = '', mid = '' } = {}) {
    if (closed) return;
    stopBackground();
    closed = true;
    const detail = nickname ? `${nickname}${mid ? `（${mid}）` : ''} ` : '';
    setState('登录成功', 'ok');
    setText(countdown, '');
    image.style.filter = 'blur(4px)';
    setHidden(overlay, false);
    overlay.replaceChildren(h('span', {}, '✓'), h('span', {}, `${detail}登录成功`));
    refresh.disabled = true;
    refresh.hidden = true;
    setAlert(error, '', 'info');
    toast?.show?.(isQq ? 'QQ 登录成功' : 'B 站绑定成功', { tone: 'success' });
    try {
      onConfirmed?.({ nickname, mid });
    } catch {
      // 刷新失败不影响扫码结果
    }
    timers.setTimeout(() => {
      modal.close('confirmed');
    }, 1300);
  }

  refresh.addEventListener('click', () => { if (canRefresh && !refresh.disabled) void loadQr(true); });
  void loadQr();

  return {
    close: () => modal.close('external'),
    isOpen: () => modal.isOpen()
  };
}
