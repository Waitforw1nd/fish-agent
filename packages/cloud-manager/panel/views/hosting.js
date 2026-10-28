// Hosting Center：QQ 内核托管 + B 站桥接。页面只渲染一次，轮询时局部更新，避免打断输入。

import { h, setBusy, setHidden, clear } from '../lib/dom.js';
import { confirmDialog } from '../lib/modal.js';
import {
  normalizeTenant,
  normalizeQQStatus,
  normalizeBiliStatus,
  normalizeBiliConfig
} from '../lib/normalize.js';
import { createPoller } from '../lib/polling.js';
import {
  formatDate,
  formatDateTime,
  formatRelative,
  expiryInfo,
  initials,
  redactText,
  truncate
} from '../lib/format.js';
import {
  apiErrorMessage,
  resolveSubscriptions,
  SUBSCRIPTION_DEFS
} from '../lib/view-data.js';
import {
  alertBox,
  backLink,
  badge,
  cardHead,
  errorBlock,
  loadingBlock,
  note,
  setAlert,
  setBadge,
  setStatusValue,
  statusRow,
  switchRow
} from '../lib/ui.js';
import { openQrFlow } from './qr.js';
import { validateUin } from '../lib/validate.js';

const KERNELS = [
  { id: 'llbot', name: 'LLBot', tag: '推荐', desc: 'Direct 登录，需 auth token' },
  { id: 'napcat', name: 'NapCat', tag: '', desc: 'QQ 客户端注入，扫码登录' },
  { id: 'snowluma', name: 'SnowLuma', tag: '', desc: '兼容旧版配置' }
];

const AUTH_TOKEN_LABELS = {
  missing: '未配置 auth token',
  invalid: 'auth token 无效或已过期',
  quota: 'auth token 配额或限流异常',
  ok: 'auth token 状态正常',
  unknown: 'auth token 状态未知'
};

export function mountHosting({
  root,
  api,
  tenantId,
  toast,
  modalRoot,
  timers = null,
  now = Date.now
} = {}) {
  let active = true;
  let tenant = null;
  let qq = null;
  let bili = null;
  let config = null;
  let qqLoadError = '';
  let biliLoadError = '';
  let pollError = '';
  let poller = null;
  let qrFlow = null;

  let selectedKernel = 'llbot';
  let kernelTouched = false;
  let uinTouched = false;
  let tenantBusy = false;
  let qqBusy = false;
  let biliBusy = false;
  let savingSubs = false;

  let subscriptions = { mentions: false, upVideos: false, privateMessages: false, liveRooms: false };
  let savedSubscriptions = { ...subscriptions };
  let subsDirty = false;

  let prevQqPhase = '';
  let prevBiliPhase = '';
  let firstStatusApplied = false;

  const nowMs = () => (typeof now === 'function' ? now() : now);
  const dialogsRoot = modalRoot || (typeof document !== 'undefined' ? document.getElementById('modal-root') : null) || (typeof document !== 'undefined' ? document.body : null);
  const hash = (suffix = 'hosting') => `#/tenants/${encodeURIComponent(tenantId)}/${suffix}`;

  root.replaceChildren();
  renderLoading();

  // ── 初始加载 ──────────────────────────────────────────

  async function loadAll() {
    if (!active) return;
    poller?.stop();
    poller = null;
    qqLoadError = '';
    biliLoadError = '';
    pollError = '';
    renderLoading();
    const results = await Promise.allSettled([
      api.getTenant(tenantId),
      api.getQQStatus(tenantId),
      api.getBiliStatus(tenantId),
      api.getBiliConfig(tenantId)
    ]);
    if (!active) return;
    const [tenantResult, qqResult, biliResult, configResult] = results;
    if (tenantResult.status === 'rejected') {
      renderFatal(apiErrorMessage(tenantResult.reason, { fallback: '无法加载租户信息。' }));
      return;
    }
    tenant = normalizeTenant(tenantResult.value, { now: nowMs() });
    qq = qqResult.status === 'fulfilled'
      ? normalizeQQStatus(qqResult.value)
      : (tenant.qq.available ? tenant.qq : normalizeQQStatus(null));
    bili = biliResult.status === 'fulfilled'
      ? normalizeBiliStatus(biliResult.value)
      : (tenant.bili.available ? tenant.bili : normalizeBiliStatus(null));
    config = configResult.status === 'fulfilled' ? normalizeBiliConfig(configResult.value) : null;
    qqLoadError = qqResult.status === 'rejected' ? apiErrorMessage(qqResult.reason, { fallback: 'QQ 状态加载失败。' }) : '';
    biliLoadError = biliResult.status === 'rejected' ? apiErrorMessage(biliResult.reason, { fallback: 'B 站状态加载失败。' }) : '';
    if (qqResult.status === 'fulfilled' && qq.available) {
      selectedKernel = qq.kernel !== 'unknown' ? qq.kernel : 'llbot';
    }
    subscriptions = resolveSubscriptions(config, bili);
    savedSubscriptions = { ...subscriptions };
    subsDirty = false;
    prevQqPhase = qq.available ? qq.phase : '';
    prevBiliPhase = bili.available ? bili.phase : '';
    firstStatusApplied = false;
    renderPage();
    startPolling();
  }

  // ── 加载 / 错误态 ──────────────────────────────────────

  function renderLoading() {
    clear(root);
    root.appendChild(h('div', { class: 'mb-14' }, backLink('#/tenants')));
    root.appendChild(loadingBlock('正在读取 Hosting 状态…', { rows: 5 }));
  }

  function renderFatal(message) {
    clear(root);
    root.appendChild(h('div', { class: 'mb-14' }, backLink('#/tenants')));
    root.appendChild(errorBlock({
      title: '无法打开 Hosting Center',
      message,
      onRetry: () => { void loadAll(); }
    }));
  }

  // ── 页面骨架 ──────────────────────────────────────────

  let nodes = {};

  function renderPage() {
    clear(root);
    const startButton = h('button', { class: 'btn btn-primary', type: 'button' }, '启动托管');
    const stopButton = h('button', { class: 'btn btn-danger', type: 'button' }, '停止托管');
    const refreshButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '刷新状态');
    const statusChip = badge('状态刷新异常', 'danger');
    statusChip.hidden = !pollError;

    const title = h('h2', { class: 'page-title-lg' }, tenant.name);
    const sub = h('p', { class: 'page-sub' }, '');
    const tenantBadge = badge(tenant.statusLabel, tenant.statusTone);
    const planChip = badge(tenant.plan?.name || '默认套餐', 'neutral', { dot: false });
    const expiryChip = badge(tenant.expiry?.label || '未设置到期', toneForExpiry(), { dot: false });
    const summary = h('div', { class: 'hosting-summary' }, tenantBadge, planChip, expiryChip, statusChip);

    const head = h('div', { class: 'page-head' },
      h('div', { class: 'page-head-main' },
        h('div', { class: 'eyebrow' },
          h('a', { href: '#/tenants', class: 'muted' }, '租户总览'),
          h('span', { class: 'dot-sep' }),
          'Hosting Center'
        ),
        title,
        sub,
        summary
      ),
      h('div', { class: 'page-head-actions' }, refreshButton, startButton, stopButton)
    );

    const expiryBanner = alertBox('', 'warn', { hidden: true });

    const qqCard = renderQqCard();
    const biliCard = renderBiliCard();

    root.appendChild(head);
    root.appendChild(expiryBanner);
    root.appendChild(h('div', { class: 'hosting-grid' }, qqCard.card, biliCard.card));
    root.appendChild(h('p', { class: 'note mt-18' },
      '安全提示：auth token、Relay Key 与 B 站 Cookie 由服务端加密保存；本面板只在状态中展示脱敏结果，不写入 localStorage。'
    ));

    nodes = {
      title,
      sub,
      tenantBadge,
      planChip,
      expiryChip,
      statusChip,
      summary,
      expiryBanner,
      startButton,
      stopButton,
      refreshButton,
      ...qqCard.nodes,
      ...biliCard.nodes
    };

    startButton.addEventListener('click', () => { void startTenant(); });
    stopButton.addEventListener('click', () => { void stopTenant(); });
    refreshButton.addEventListener('click', () => { void refreshEverything(true); });
    updateHeader();
    updateQQ();
    updateBili();
    updateSubscriptionsUi();
  }

  function toneForExpiry() {
    if (tenant?.expiry?.state === 'expired') return 'danger';
    if (tenant?.expiry?.state === 'soon') return 'warn';
    return 'neutral';
  }

  function updateHeader() {
    if (!tenant || !nodes.tenantBadge) return;
    setBadge(nodes.tenantBadge, tenant.statusLabel, tenant.statusTone);
    setBadge(nodes.expiryChip, tenant.expiry?.label || '未设置到期', toneForExpiry());
    setBadge(nodes.planChip, tenant.plan?.name || '默认套餐', 'neutral');
    nodes.sub.textContent = [
      tenant.slug ? `@${tenant.slug}` : '未分配子域',
      `套餐 ${tenant.plan?.name || '默认'}`,
      tenant.expiresAt ? `服务至 ${formatDate(tenant.expiresAt)}` : '未设置服务期'
    ].join(' · ');

    const expired = tenant.expiry?.state === 'expired';
    nodes.startButton.disabled = tenantBusy || tenant.running || expired;
    nodes.startButton.title = expired ? '租户已到期，无法启动' : tenant.running ? '租户已在运行' : '';
    nodes.stopButton.disabled = tenantBusy || !tenant.running;
    nodes.refreshButton.disabled = tenantBusy;

    setHidden(nodes.statusChip, !pollError);
    if (pollError) setBadge(nodes.statusChip, '状态刷新异常', 'danger');

    if (tenant.expiry?.state === 'expired') {
      setAlert(nodes.expiryBanner, '租户已到期：启动操作已禁用，停止仍可用。续费或调整套餐后请刷新状态。', 'danger');
    } else if (tenant.expiry?.state === 'soon') {
      setAlert(nodes.expiryBanner, `服务期仅剩 ${tenant.expiry.days} 天（${formatDate(tenant.expiresAt)} 到期），请及时续费。`, 'warn');
    } else {
      setAlert(nodes.expiryBanner, '', 'warn');
    }
  }

  // ── QQ 卡片 ───────────────────────────────────────────

  function renderQqCard() {
    const qqBadge = badge(qq?.phaseLabel || '未知', qq?.tone || 'neutral');
    const head = cardHead({
      kicker: 'QQ Channel',
      title: 'QQ 内核托管',
      sub: '选择协议端内核，准备后启动并扫码登录。',
      badge: qqBadge
    });

    const kernelInputs = [];
    const kernelGrid = h('div', { class: 'kernel-grid' });
    for (const kernel of KERNELS) {
      const input = h('input', {
        type: 'radio',
        name: 'qq-kernel',
        value: kernel.id,
        checked: selectedKernel === kernel.id,
        on: {
          change: () => {
            if (input.checked) {
              selectedKernel = kernel.id;
              kernelTouched = true;
              updateKernelSelection();
            }
          }
        }
      });
      const label = h('label', { class: 'kernel-option', dataset: { kernel: kernel.id } },
        input,
        h('span', { class: 'kernel-body' },
          h('span', { class: 'kernel-name' }, kernel.name, kernel.tag ? h('span', { class: 'kernel-tag' }, kernel.tag) : null),
          h('span', { class: 'kernel-desc' }, kernel.desc)
        )
      );
      kernelInputs.push({ input, label });
      kernelGrid.appendChild(label);
    }

    const kernelBlock = h('div', {},
      h('div', { class: 'section-label' }, '协议端内核'),
      kernelGrid
    );

    const uinInput = h('input', {
      class: 'input',
      id: 'qq-uin',
      name: 'uin',
      type: 'text',
      inputMode: 'numeric',
      autocomplete: 'off',
      spellcheck: false,
      maxLength: 12,
      pattern: '\\d{5,12}',
      placeholder: '例如 10001',
      value: qq?.expectedUin || qq?.uin || '',
      on: {
        input: () => {
          uinTouched = true;
          setUinError('');
        }
      }
    });
    const uinError = h('p', { class: 'form-error', hidden: true });
    const uinBlock = h('div', { class: 'field mt-14' },
      h('div', { class: 'label-row' },
        h('label', { class: 'field-label', for: 'qq-uin' }, 'QQ 号（UIN）'),
        h('span', { class: 'field-hint' }, '5-12 位数字')
      ),
      uinInput,
      uinError
    );

    const modeInput = h('select', { class: 'input', id: 'qq-mode', on: { change: () => { modeInput.dataset.touched = '1'; updateKernelSelection(); } } },
      h('option', { value: 'direct' }, 'Direct'),
      h('option', { value: 'desktop' }, '桌面 QQ / PMHQ'));
    modeInput.value = qq?.mode || 'direct';
    const pmhqInput = h('input', { class: 'input', id: 'qq-pmhq-port', type: 'number', min: 1, max: 65535, placeholder: '留空自动分配', value: qq?.pmhqPort || '', on: { input: () => { pmhqInput.dataset.touched = '1'; } } });
    const modeBlock = h('div', { class: 'field mt-14' },
      h('label', { class: 'field-label', for: 'qq-mode' }, 'LLBot 运行模式'), modeInput,
      h('label', { class: 'field-label', for: 'qq-pmhq-port' }, 'PMHQ 端口（桌面模式）'), pmhqInput,
      h('p', { class: 'field-hint' }, '桌面模式需要已部署的独立 QQ 和 PMHQ 注入组件；留空由平台分配端口。'));

    const tokenInput = h('input', {
      class: 'input',
      id: 'qq-auth-token',
      name: 'authToken',
      type: 'password',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: '租户自带 auth token（留空使用平台配置）'
    });
    const tokenStatus = h('p', { class: 'field-hint' }, '');
    const tokenBlock = h('div', { class: 'auth-token-block' },
      h('div', { class: 'field' },
        h('div', { class: 'label-row' },
          h('label', { class: 'field-label', for: 'qq-auth-token' }, 'LLBot auth token'),
          h('span', { class: 'field-hint' }, '可选 · 仅随请求发送')
        ),
        tokenInput,
        tokenStatus
      ),
      h('p', { class: 'note mt-14' }, 'LLBot Direct 登录必须配置 auth token。平台可代管平台级 token；此处填写会覆盖为租户自有 token，留空则沿用平台配置。')
    );

    const prepareButton = h('button', { class: 'btn btn-soft', type: 'button' }, '准备内核');
    const startQqButton = h('button', { class: 'btn btn-primary', type: 'button' }, '启动 QQ 并扫码');
    const actionRow = h('div', { class: 'inline-buttons mt-14' }, prepareButton, startQqButton);

    const qrButton = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, '打开二维码');
    const qrCopyStrong = h('strong', {}, '登录二维码');
    const qrCopySpan = h('span', {}, '启动后获取');
    const qrBlock = h('div', { class: 'qr-trigger-row' },
      h('div', { class: 'qr-trigger-copy' }, qrCopyStrong, qrCopySpan),
      qrButton
    );

    const status = {
      kernel: statusRow('当前内核', '—'),
      uin: statusRow('UIN', '—', { mono: true }),
      nickname: statusRow('昵称', '—'),
      onebot: statusRow('OneBot', '—'),
      version: statusRow('版本对齐', '—'),
      updated: statusRow('最近更新', '—'),
      error: statusRow('最近错误', '—')
    };
    const statusList = h('div', { class: 'status-list' },
      status.kernel.row,
      status.uin.row,
      status.nickname.row,
      status.onebot.row,
      status.version.row,
      status.updated.row,
      status.error.row
    );

    const qqAlert = alertBox('', 'danger', { hidden: true });

    const card = h('section', { class: 'card card-pad' },
      head,
      qqAlert,
      kernelBlock,
      uinBlock,
      modeBlock,
      tokenBlock,
      actionRow,
      qrBlock,
      statusList,
      note('准备会校验 QQ 号、内核与 auth token；启动后二维码有效期由协议端返回，过期可重新获取。')
    );

    prepareButton.addEventListener('click', () => { void prepareQq(); });
    startQqButton.addEventListener('click', () => { void startQq(); });
    qrButton.addEventListener('click', () => openQqQr());

    return {
      card,
      nodes: {
        qqBadge,
        qqAlert,
        kernelGrid,
        kernelInputs,
        uinBlock,
        uinInput,
        uinError,
        modeBlock,
        modeInput,
        pmhqInput,
        tokenBlock,
        tokenInput,
        tokenStatus,
        prepareButton,
        startQqButton,
        qrBlock,
        qrButton,
        qrCopyStrong,
        qrCopySpan,
        qqStatus: status,
        qqStatusList: statusList
      }
    };
  }

  function updateKernelSelection() {
    if (!nodes.kernelInputs) return;
    for (const { input, label } of nodes.kernelInputs) {
      const selected = input.value === selectedKernel;
      input.checked = selected;
      label.classList.toggle('is-selected', selected);
    }
    const desktop = nodes.modeInput?.value === 'desktop';
    if (nodes.modeBlock) setHidden(nodes.modeBlock, selectedKernel !== 'llbot');
    if (nodes.pmhqInput) nodes.pmhqInput.disabled = !desktop;
    if (nodes.tokenBlock) setHidden(nodes.tokenBlock, selectedKernel !== 'llbot' || desktop);
  }

  function updateQQ() {
    if (!nodes.qqBadge) return;
    if (!qq || !qq.available) {
      setBadge(nodes.qqBadge, '状态未知', 'neutral');
      setStatusValue(nodes.qqStatus.kernel.value, '—');
      setStatusValue(nodes.qqStatus.uin.value, '—');
      setStatusValue(nodes.qqStatus.nickname.value, '—');
      setStatusValue(nodes.qqStatus.onebot.value, '—');
      setStatusValue(nodes.qqStatus.version.value, '—');
      setStatusValue(nodes.qqStatus.updated.value, qqLoadError || '—');
      setStatusValue(nodes.qqStatus.error.value, qqLoadError || '—', { tone: qqLoadError ? 'danger' : '' });
      setAlert(nodes.qqAlert, qqLoadError, 'danger');
      return;
    }
    setBadge(nodes.qqBadge, qq.phaseLabel, qq.tone);
    setStatusValue(nodes.qqStatus.kernel.value, qq.kernelLabel, { mono: true });
    setStatusValue(nodes.qqStatus.uin.value, qq.uin || qq.expectedUin || '—', { mono: true });
    setStatusValue(nodes.qqStatus.nickname.value, qq.nickname || '—');
    const onebotText = qq.onebotConnected
      ? `已连接${qq.onebotPort ? ` · :${qq.onebotPort}` : ''}`
      : qq.loggedIn ? '登录成功，等待连接' : '未连接';
    setStatusValue(nodes.qqStatus.onebot.value, onebotText, {
      tone: qq.onebotConnected ? 'ok' : qq.loggedIn ? 'warn' : ''
    });
    const versionText = qq.version
      ? `${qq.version}${qq.versionAligned ? ' · 已对齐' : ' · 待确认'}`
      : qq.versionAligned ? '已对齐' : '未验证';
    setStatusValue(nodes.qqStatus.version.value, versionText, {
      tone: qq.versionAligned ? 'ok' : ''
    });
    setStatusValue(nodes.qqStatus.updated.value, qq.updatedAt ? formatRelative(qq.updatedAt, nowMs()) : '—');
    const safeQqError = qq.error ? redactText(qq.error, { maxLength: 300 }) : '';
    setStatusValue(nodes.qqStatus.error.value, safeQqError ? truncate(safeQqError, 120) : '—', {
      tone: safeQqError ? 'danger' : ''
    });
    nodes.qqStatus.error.value.title = safeQqError;

    if (!kernelTouched && qq.kernel !== 'unknown') {
      selectedKernel = qq.kernel;
    }
    if (nodes.modeInput && !nodes.modeInput.dataset.touched && qq.mode) nodes.modeInput.value = qq.mode;
    if (nodes.pmhqInput && !nodes.pmhqInput.dataset.touched && qq.pmhqPort) nodes.pmhqInput.value = String(qq.pmhqPort);
    updateKernelSelection();
    if (!uinTouched && nodes.uinInput) {
      const expected = qq.expectedUin || qq.uin;
      if (expected) nodes.uinInput.value = expected;
    }
    if (nodes.uinInput) nodes.uinInput.disabled = qqBusy;

    const locked = qq.running || qq.phase === 'preparing' || qqBusy;
    for (const { input, label } of nodes.kernelInputs || []) {
      input.disabled = locked;
      label.classList.toggle('is-disabled', locked);
    }
    if (nodes.tokenInput) nodes.tokenInput.disabled = qqBusy;
    if (nodes.tokenStatus) {
      const status = qq.authTokenStatus || 'unknown';
      const text = AUTH_TOKEN_LABELS[status] || AUTH_TOKEN_LABELS.unknown;
      nodes.tokenStatus.textContent = text;
      nodes.tokenStatus.dataset.tone = status === 'ok' ? 'ok' : status === 'invalid' || status === 'quota' ? 'danger' : 'warn';
      nodes.tokenStatus.style.color = status === 'ok' ? 'var(--ok)'
        : status === 'invalid' || status === 'quota' ? 'var(--danger)' : 'var(--warn)';
    }

    const canAct = Boolean(tenant?.running) && tenant?.expiry?.state !== 'expired';
    if (nodes.prepareButton) {
      nodes.prepareButton.disabled = qqBusy;
      nodes.prepareButton.classList.toggle('is-loading', qqBusy);
    }
    if (nodes.startQqButton) {
      nodes.startQqButton.disabled = qqBusy || !canAct || qq.phase === 'online';
      nodes.startQqButton.textContent = qq.phase === 'waiting_login' || qq.phase === 'waiting_confirm'
        ? '继续扫码登录'
        : '启动 QQ 并扫码';
      nodes.startQqButton.title = !tenant?.running ? '请先启动租户托管' : tenant?.expiry?.state === 'expired' ? '租户已到期' : '';
    }
    if (nodes.qrButton) {
      nodes.qrButton.disabled = !canAct;
    }
    if (nodes.qrCopyStrong && nodes.qrCopySpan) {
      let copy = '登录二维码';
      let detail = '启动后可获取';
      if (!tenant?.running) detail = '请先启动租户托管';
      else if (qq.phase === 'online') detail = 'QQ 已在线；可重新扫码';
      else if (qq.phase === 'waiting_confirm') detail = '已扫码，请在手机确认';
      else if (qq.phase === 'waiting_login' || qq.qrAvailable) detail = '等待扫码登录';
      else if (qq.phase === 'preparing') detail = '内核准备中…';
      else if (qq.phase === 'starting') detail = '内核启动中，稍候获取';
      if (qq.phase === 'online') copy = 'QQ 已登录';
      nodes.qrCopyStrong.textContent = copy;
      nodes.qrCopySpan.textContent = detail;
    }

    if (qqLoadError) setAlert(nodes.qqAlert, qqLoadError, 'danger');
    else if (safeQqError) setAlert(nodes.qqAlert, `QQ 异常：${safeQqError}`, 'danger');
    else setAlert(nodes.qqAlert, '', 'danger');
  }

  // ── B 站卡片 ──────────────────────────────────────────

  function renderBiliCard() {
    const biliBadge = badge(bili?.phaseLabel || '未知', bili?.tone || 'neutral');
    const bindButton = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, bili?.loggedIn ? '重新扫码' : '扫码绑定');
    const head = cardHead({
      kicker: 'Bilibili Channel',
      title: 'B 站桥接',
      sub: '扫码绑定后，四类订阅共用同一 Agent 人设与记忆。',
      badge: biliBadge,
      actions: bindButton
    });

    const avatar = h('span', { class: 'bili-avatar' }, bili?.nickname ? initials(bili.nickname) : 'B');
    const accountName = h('strong', {}, bili?.nickname || '尚未绑定 B 站账号');
    const accountMid = h('small', {}, bili?.mid ? `MID ${bili.mid}` : '扫码后显示昵称与 MID');
    const account = h('div', { class: 'bili-account' },
      avatar,
      h('div', { class: 'bili-account-copy' }, accountName, accountMid)
    );

    const status = {
      cookie: statusRow('Cookie 保活', '—'),
      live: statusRow('直播连接', '—'),
      poll: statusRow('最近轮询', '—'),
      limit: statusRow('限流', '—'),
      error: statusRow('最近错误', '—')
    };
    const statusList = h('div', { class: 'status-list' },
      status.cookie.row,
      status.live.row,
      status.poll.row,
      status.limit.row,
      status.error.row
    );

    const subInputs = {};
    const subRows = [];
    for (const def of SUBSCRIPTION_DEFS) {
      const created = switchRow({
        title: def.title,
        description: def.description,
        checked: Boolean(subscriptions[def.key]),
        name: `bili-sub-${def.key}`,
        onChange: (checked) => {
          subscriptions[def.key] = checked;
          updateDirtyState();
        }
      });
      subInputs[def.key] = created.input;
      subRows.push(created.row);
    }
    const subList = h('div', { class: 'subscription-list' }, ...subRows);
    const dirtyHint = h('span', { class: 'dirty-hint', hidden: true }, '有未保存的订阅变更');
    const resetButton = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, '撤销');
    const saveButton = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, '保存订阅设置');
    const subActions = h('div', { class: 'subscription-actions' },
      dirtyHint,
      h('div', { class: 'inline-buttons' }, resetButton, saveButton)
    );

    const biliAlert = alertBox('', 'danger', { hidden: true });

    const card = h('section', { class: 'card card-pad' },
      head,
      biliAlert,
      account,
      h('div', { class: 'section-label mt-18' }, '连接状态'),
      statusList,
      h('div', { class: 'section-label mt-20' }, '订阅类型'),
      subList,
      subActions,
      note('四类订阅的开关保存到租户配置；实际轮询与限频由 B 站桥接服务执行。')
    );

    bindButton.addEventListener('click', () => openBiliQr());
    saveButton.addEventListener('click', () => { void saveSubscriptions(); });
    resetButton.addEventListener('click', () => {
      subscriptions = { ...savedSubscriptions };
      subsDirty = false;
      updateSubscriptionsUi();
      updateDirtyState();
    });

    return {
      card,
      nodes: {
        biliBadge,
        biliAlert,
        bindButton,
        avatar,
        accountName,
        accountMid,
        biliStatus: status,
        subInputs,
        subList,
        dirtyHint,
        resetButton,
        saveButton,
        subActions
      }
    };
  }

  function updateBili() {
    if (!nodes.biliBadge) return;
    if (!bili || !bili.available) {
      setBadge(nodes.biliBadge, '状态未知', 'neutral');
      setStatusValue(nodes.biliStatus.cookie.value, '—');
      setStatusValue(nodes.biliStatus.live.value, '—');
      setStatusValue(nodes.biliStatus.poll.value, biliLoadError || '—');
      setStatusValue(nodes.biliStatus.limit.value, '—');
      setStatusValue(nodes.biliStatus.error.value, biliLoadError || '—', { tone: biliLoadError ? 'danger' : '' });
      setAlert(nodes.biliAlert, biliLoadError, 'danger');
      return;
    }
    setBadge(nodes.biliBadge, bili.phaseLabel, bili.tone);
    nodes.accountName.textContent = bili.nickname || (bili.loggedIn ? 'B 站账号' : '尚未绑定 B 站账号');
    nodes.accountMid.textContent = bili.mid ? `MID ${bili.mid}` : (bili.loggedIn ? '未返回 MID' : '扫码后显示昵称与 MID');
    nodes.avatar.textContent = bili.nickname ? initials(bili.nickname) : 'B';
    nodes.bindButton.textContent = bili.loggedIn ? '重新扫码' : '扫码绑定';
    nodes.bindButton.classList.toggle('btn-primary', !bili.loggedIn);
    nodes.bindButton.classList.toggle('btn-ghost', Boolean(bili.loggedIn));

    setStatusValue(nodes.biliStatus.cookie.value, bili.cookieHealthy ? '正常' : (redactText(bili.cookieStatus, { maxLength: 80 }) || '需要检查'), {
      tone: bili.cookieHealthy ? 'ok' : 'warn'
    });
    setStatusValue(nodes.biliStatus.live.value, bili.liveConnected ? '已连接' : '未连接', {
      tone: bili.liveConnected ? 'ok' : ''
    });
    setStatusValue(nodes.biliStatus.poll.value, bili.lastPollAt ? formatRelative(bili.lastPollAt, nowMs()) : '—');
    setStatusValue(nodes.biliStatus.limit.value,
      bili.rateLimited ? (bili.rateLimitUntil ? `限流至 ${formatDateTime(bili.rateLimitUntil)}` : '限流中') : '未触发',
      { tone: bili.rateLimited ? 'warn' : '' }
    );
    const safeBiliError = bili.error ? redactText(bili.error, { maxLength: 300 }) : '';
    setStatusValue(nodes.biliStatus.error.value, safeBiliError ? truncate(safeBiliError, 120) : '—', {
      tone: safeBiliError ? 'danger' : ''
    });
    nodes.biliStatus.error.value.title = safeBiliError;

    if (!subsDirty) {
      subscriptions = resolveSubscriptions(config, bili);
      savedSubscriptions = { ...subscriptions };
      updateSubscriptionsUi();
    }

    if (biliLoadError) setAlert(nodes.biliAlert, biliLoadError, 'danger');
    else if (safeBiliError) setAlert(nodes.biliAlert, `B 站桥接异常：${safeBiliError}`, 'danger');
    else setAlert(nodes.biliAlert, '', 'danger');
  }

  function updateSubscriptionsUi() {
    if (!nodes.subInputs) return;
    for (const def of SUBSCRIPTION_DEFS) {
      const input = nodes.subInputs[def.key];
      if (!input) continue;
      input.checked = Boolean(subscriptions[def.key]);
      input.disabled = savingSubs;
    }
    nodes.saveButton.disabled = savingSubs || !subsDirty;
    nodes.resetButton.disabled = savingSubs || !subsDirty;
    setHidden(nodes.dirtyHint, !subsDirty);
  }

  function updateDirtyState() {
    subsDirty = SUBSCRIPTION_DEFS.some((def) => Boolean(subscriptions[def.key]) !== Boolean(savedSubscriptions[def.key]));
    updateSubscriptionsUi();
  }

  // ── 轮询 ──────────────────────────────────────────────

  function startPolling() {
    poller?.stop();
    poller = createPoller({
      intervalMs: 7000,
      maxIntervalMs: 30_000,
      immediate: true,
      timers: timers || undefined,
      task: pollStatuses,
      onError: (error) => {
        if (!active) return;
        if (error?.isAuthExpired) return;
        pollError = apiErrorMessage(error, { fallback: '状态刷新失败。' });
        updatePollChip();
      }
    });
    poller.start();
  }

  async function pollStatuses() {
    if (!active) return;
    const [tenantResult, qqResult, biliResult] = await Promise.allSettled([
      api.getTenant(tenantId),
      api.getQQStatus(tenantId),
      api.getBiliStatus(tenantId)
    ]);
    if (!active) return;
    const errors = [];
    if (tenantResult.status === 'fulfilled') {
      tenant = normalizeTenant(tenantResult.value, { now: nowMs() });
    } else {
      errors.push(tenantResult.reason);
    }

    if (qqResult.status === 'fulfilled') {
      const next = normalizeQQStatus(qqResult.value);
      if (next.available) {
        const wasOnline = prevQqPhase === 'online';
        qq = next;
        qqLoadError = '';
        if (firstStatusApplied && next.phase === 'online' && !wasOnline) {
          toast?.show?.('QQ 已成功上线', { tone: 'success' });
        }
        prevQqPhase = next.phase;
        updateQQ();
      } else if (qqLoadError) {
        setAlert(nodes.qqAlert, qqLoadError, 'danger');
      }
    } else {
      errors.push(qqResult.reason);
      qqLoadError = apiErrorMessage(qqResult.reason, { fallback: 'QQ 状态刷新失败。' });
      updateQQ();
    }

    if (biliResult.status === 'fulfilled') {
      const next = normalizeBiliStatus(biliResult.value);
      if (next.available) {
        const wasOnline = prevBiliPhase === 'online';
        bili = next;
        biliLoadError = '';
        if (firstStatusApplied && next.phase === 'online' && !wasOnline) {
          toast?.show?.('B 站已连接', { tone: 'success' });
        }
        prevBiliPhase = next.phase;
        updateBili();
      } else if (biliLoadError) {
        setAlert(nodes.biliAlert, biliLoadError, 'danger');
      }
    } else {
      errors.push(biliResult.reason);
      biliLoadError = apiErrorMessage(biliResult.reason, { fallback: 'B 站状态刷新失败。' });
      updateBili();
    }

    firstStatusApplied = true;
    if (errors.length) {
      const authError = errors.find((error) => error?.isAuthExpired);
      if (authError) return;
      pollError = apiErrorMessage(errors[0], { fallback: '部分状态刷新失败。' });
    } else {
      pollError = '';
    }
    updatePollChip();
    updateHeader();
  }

  function updatePollChip() {
    if (!nodes.statusChip) return;
    if (!pollError) {
      setHidden(nodes.statusChip, true);
    } else {
      setHidden(nodes.statusChip, false);
      setBadge(nodes.statusChip, '状态刷新异常', 'danger');
      nodes.statusChip.title = pollError;
    }
  }

  // ── 租户启停 ──────────────────────────────────────────

  async function startTenant() {
    if (tenantBusy || !active) return;
    if (tenant?.expiry?.state === 'expired') {
      toast?.show?.('租户已到期，无法启动。', { tone: 'danger' });
      return;
    }
    tenantBusy = true;
    setBusy(nodes.startButton, true);
    updateHeader();
    try {
      const payload = await api.startTenant(tenantId);
      if (payload && typeof payload === 'object') {
        const maybe = normalizeTenant(payload, { now: nowMs() });
        if (maybe.id) tenant = maybe;
      }
      toast?.show?.('托管启动指令已下发', { tone: 'success' });
      await refreshTenant();
      await refreshStatusesQuiet();
      updateHeader();
    } catch (error) {
      if (active) toast?.show?.(apiErrorMessage(error, { fallback: '启动托管失败。' }), { tone: 'danger' });
    } finally {
      tenantBusy = false;
      if (active) {
        setBusy(nodes.startButton, false);
        updateHeader();
        updateQQ();
      }
    }
  }

  async function stopTenant() {
    if (tenantBusy || !active) return;
    const ok = await confirmDialog({
      root: dialogsRoot,
      title: '停止托管',
      message: '停止租户会中断 QQ 与 B 站的连接，但会保留会话、记忆与配置。',
      detail: '确认停止当前租户？',
      confirmText: '停止托管',
      danger: true
    });
    if (!ok || !active) return;
    tenantBusy = true;
    setBusy(nodes.stopButton, true);
    updateHeader();
    try {
      qrFlow?.close?.();
      await api.stopTenant(tenantId);
      toast?.show?.('托管已停止', { tone: 'success' });
      await refreshTenant();
      await refreshStatusesQuiet();
      updateHeader();
    } catch (error) {
      if (active) toast?.show?.(apiErrorMessage(error, { fallback: '停止托管失败。' }), { tone: 'danger' });
    } finally {
      tenantBusy = false;
      if (active) {
        setBusy(nodes.stopButton, false);
        updateHeader();
        updateQQ();
      }
    }
  }

  // ── QQ 操作 ───────────────────────────────────────────

  function setUinError(message) {
    if (!nodes.uinError || !nodes.uinInput) return;
    nodes.uinError.textContent = message || '';
    setHidden(nodes.uinError, !message);
    nodes.uinInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function readUin() {
    const result = validateUin(nodes.uinInput?.value);
    if (!result.ok) {
      setUinError(result.error);
      nodes.uinInput?.focus?.();
      return null;
    }
    setUinError('');
    return result.value;
  }

  async function prepareQq() {
    if (qqBusy || !active) return;
    const uin = readUin();
    if (!uin) return;
    qqBusy = true;
    setBusy(nodes.prepareButton, true);
    updateQQ();
    try {
      await api.prepareQQ(tenantId, {
        kernel: selectedKernel,
        uin,
        mode: nodes.modeInput?.value,
        pmhqPort: nodes.pmhqInput?.value,
        authToken: nodes.tokenInput?.value || ''
      });
      if (nodes.tokenInput) nodes.tokenInput.value = '';
      toast?.show?.(`${kernelName(selectedKernel)} 准备完成`, { tone: 'success' });
      await refreshStatusesQuiet();
    } catch (error) {
      if (active) setAlert(nodes.qqAlert, apiErrorMessage(error, { fallback: '准备内核失败。' }), 'danger');
    } finally {
      qqBusy = false;
      if (active) {
        setBusy(nodes.prepareButton, false);
        updateQQ();
      }
    }
  }

  async function startQq() {
    if (qqBusy || !active) return;
    const uin = readUin();
    if (!uin) return;
    if (!tenant?.running) {
      toast?.show?.('请先启动租户托管，再启动 QQ。', { tone: 'warn' });
      return;
    }
    qqBusy = true;
    setBusy(nodes.startQqButton, true);
    updateQQ();
    try {
      await api.startQQ(tenantId, {
        kernel: selectedKernel,
        uin,
        mode: nodes.modeInput?.value,
        pmhqPort: nodes.pmhqInput?.value,
        authToken: nodes.tokenInput?.value || ''
      });
      if (nodes.tokenInput) nodes.tokenInput.value = '';
      toast?.show?.('QQ 启动中，正在获取登录二维码', { tone: 'success' });
      const latest = await refreshStatusesQuiet();
      if (active && (latest.qq?.phase === 'waiting_login' || latest.qq?.phase === 'waiting_confirm' || latest.qq?.qrAvailable || latest.qq?.phase === 'starting')) {
        openQqQr();
      } else if (active && latest.qq?.phase === 'online') {
        toast?.show?.('QQ 已在线', { tone: 'success' });
      }
    } catch (error) {
      if (active) setAlert(nodes.qqAlert, apiErrorMessage(error, { fallback: '启动 QQ 失败。' }), 'danger');
    } finally {
      qqBusy = false;
      if (active) {
        setBusy(nodes.startQqButton, false);
        updateQQ();
      }
    }
  }

  function openQqQr() {
    if (!active) return;
    qrFlow?.close?.();
    qrFlow = openQrFlow({
      modalRoot: dialogsRoot,
      api,
      tenantId,
      kind: 'qq',
      toast,
      timers: timers || undefined,
      onConfirmed: async () => {
        await refreshStatusesQuiet();
        await refreshTenant();
      }
    });
  }

  async function openBiliQr() {
    if (!active) return;
    qrFlow?.close?.();
    qrFlow = openQrFlow({
      modalRoot: dialogsRoot,
      api,
      tenantId,
      kind: 'bili',
      toast,
      timers: timers || undefined,
      onConfirmed: async () => {
        await refreshStatusesQuiet();
        subsDirty = false;
        await loadBiliConfigQuiet();
        updateBili();
      }
    });
  }

  // ── B 站配置 ──────────────────────────────────────────

  async function saveSubscriptions() {
    if (savingSubs || !active || !subsDirty) return;
    savingSubs = true;
    setBusy(nodes.saveButton, true);
    updateSubscriptionsUi();
    try {
      await api.updateBiliConfig(tenantId, subscriptions);
      savedSubscriptions = { ...subscriptions };
      config = {
        ...(config || {}),
        available: true,
        complete: true,
        known: { mentions: true, upVideos: true, privateMessages: true, liveRooms: true },
        subscriptions: { ...subscriptions }
      };
      subsDirty = false;
      setAlert(nodes.biliAlert, '', 'danger');
      toast?.show?.('B 站订阅设置已保存', { tone: 'success' });
    } catch (error) {
      if (active) setAlert(nodes.biliAlert, apiErrorMessage(error, { fallback: '保存订阅设置失败。' }), 'danger');
    } finally {
      savingSubs = false;
      if (active) {
        setBusy(nodes.saveButton, false);
        updateSubscriptionsUi();
      }
    }
  }

  async function loadBiliConfigQuiet() {
    try {
      const payload = await api.getBiliConfig(tenantId);
      if (!active) return;
      config = normalizeBiliConfig(payload);
      if (!subsDirty) {
        subscriptions = resolveSubscriptions(config, bili);
        savedSubscriptions = { ...subscriptions };
        updateSubscriptionsUi();
      }
    } catch {
      // 配置读取失败不阻塞扫码结果；状态接口的订阅值仍可用
    }
  }

  // ── 刷新辅助 ──────────────────────────────────────────

  async function refreshTenant() {
    try {
      const payload = await api.getTenant(tenantId);
      if (!active) return;
      tenant = normalizeTenant(payload, { now: nowMs() });
      updateHeader();
    } catch (error) {
      if (active && !error?.isAuthExpired) {
        pollError = apiErrorMessage(error, { fallback: '租户状态刷新失败。' });
        updatePollChip();
      }
    }
  }

  async function refreshQqQuiet() {
    try {
      const next = normalizeQQStatus(await api.getQQStatus(tenantId));
      if (!active) return null;
      if (next.available) {
        qq = next;
        qqLoadError = '';
        prevQqPhase = next.phase;
        updateQQ();
      }
      return next;
    } catch (error) {
      if (active) {
        qqLoadError = apiErrorMessage(error, { fallback: 'QQ 状态刷新失败。' });
        updateQQ();
      }
      return null;
    }
  }

  async function refreshBiliQuiet() {
    try {
      const next = normalizeBiliStatus(await api.getBiliStatus(tenantId));
      if (!active) return null;
      if (next.available) {
        bili = next;
        biliLoadError = '';
        prevBiliPhase = next.phase;
        updateBili();
      }
      return next;
    } catch (error) {
      if (active) {
        biliLoadError = apiErrorMessage(error, { fallback: 'B 站状态刷新失败。' });
        updateBili();
      }
      return null;
    }
  }

  async function refreshStatusesQuiet() {
    const [qqResult, biliResult] = await Promise.allSettled([refreshQqQuiet(), refreshBiliQuiet()]);
    return {
      qq: qqResult.status === 'fulfilled' ? qqResult.value : null,
      bili: biliResult.status === 'fulfilled' ? biliResult.value : null
    };
  }

  async function refreshEverything(notify = false) {
    if (!active) return;
    if (nodes.refreshButton) setBusy(nodes.refreshButton, true);
    try {
      await Promise.allSettled([refreshTenant(), refreshQqQuiet(), refreshBiliQuiet()]);
      if (notify) toast?.show?.('状态已刷新', { tone: 'success' });
    } finally {
      if (active && nodes.refreshButton) setBusy(nodes.refreshButton, false);
      updateHeader();
    }
  }

  function kernelName(id) {
    return KERNELS.find((item) => item.id === id)?.name || id;
  }

  // ── 生命周期 ──────────────────────────────────────────

  void loadAll();

  return {
    destroy() {
      active = false;
      poller?.stop();
      poller = null;
      qrFlow?.close?.();
      qrFlow = null;
      root.replaceChildren();
    },
    refresh: loadAll
  };
}
