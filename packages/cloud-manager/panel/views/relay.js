// Relay & Billing：Relay Key、默认模型、额度与按日按模型账单。
// 账单展示以云端 Relay 计量为准；本地估算单独标注，不混入结算数字。

import { h, setBusy, clear } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { createPoller } from '../lib/polling.js';
import {
  normalizeTenant,
  normalizeRelayOverview,
  normalizeModels,
  asString
} from '../lib/normalize.js';
import {
  formatDateTime,
  formatMicros,
  formatNumber,
  formatPercent,
  formatTokens,
  percentRatio,
  redactText
} from '../lib/format.js';
import {
  apiErrorMessage,
  dayLabel,
  filterBillingDays,
  modelDisplayName,
  summarizeRange
} from '../lib/view-data.js';
import { validateRelayInput } from '../lib/validate.js';
import {
  alertBox,
  backLink,
  badge,
  cardHead,
  emptyBlock,
  errorBlock,
  loadingBlock,
  note,
  pageHead,
  progressBar,
  setAlert,
  setBadge
} from '../lib/ui.js';

export function mountRelay({
  root,
  api,
  tenantId,
  toast,
  modalRoot = null,
  timers = null,
  now = Date.now
} = {}) {
  let active = true;
  let tenant = null;
  let overview = null;
  let models = [];
  let modelsError = '';
  let modelsUpstreamError = '';
  let pollError = '';
  let poller = null;
  let saving = false;
  let modelsBusy = false;
  let range = '30';
  let selectedModel = '';
  let modelTouched = false;

  let nodes = {};
  const nowMs = () => (typeof now === 'function' ? now() : now);
  const currency = () => overview?.billing?.currency || 'CNY';

  root.replaceChildren();
  renderLoading();
  void loadAll();

  async function loadAll() {
    if (!active) return;
    poller?.stop();
    poller = null;
    renderLoading();
    const [tenantResult, overviewResult, modelsResult] = await Promise.allSettled([
      api.getTenant(tenantId),
      api.getRelayOverview(tenantId),
      api.getRelayModels(tenantId)
    ]);
    if (!active) return;
    if (tenantResult.status === 'rejected') {
      renderFatal(apiErrorMessage(tenantResult.reason, { fallback: '无法加载租户信息。' }));
      return;
    }
    tenant = normalizeTenant(tenantResult.value, { now: nowMs() });
    if (overviewResult.status === 'rejected') {
      renderFatal(apiErrorMessage(overviewResult.reason, { fallback: '无法加载 Relay 概览。' }));
      return;
    }
    overview = normalizeRelayOverview(overviewResult.value);
    if (modelsResult.status === 'fulfilled') {
      models = normalizeModels(modelsResult.value);
      modelsError = '';
      modelsUpstreamError = modelsResult.value?.upstream?.ok === false
        ? redactText(asString(modelsResult.value.upstream.error, '上游模型探测失败'), { maxLength: 200 })
        : '';
    } else {
      models = [];
      modelsError = apiErrorMessage(modelsResult.reason, { fallback: '模型列表加载失败。' });
      modelsUpstreamError = '';
    }
    selectedModel = overview.model || models[0]?.id || '';
    modelTouched = false;
    renderPage();
    startPolling();
  }

  function renderLoading() {
    clear(root);
    root.appendChild(h('div', { class: 'mb-14' },
      backLink(`#/tenants/${encodeURIComponent(tenantId)}/hosting`, '返回 Hosting Center')
    ));
    root.appendChild(loadingBlock('正在读取 Relay 用量与账单…', { rows: 5 }));
  }

  function renderFatal(message) {
    clear(root);
    root.appendChild(h('div', { class: 'mb-14' },
      backLink(`#/tenants/${encodeURIComponent(tenantId)}/hosting`, '返回 Hosting Center')
    ));
    root.appendChild(errorBlock({
      title: '无法打开 Relay & Billing',
      message,
      onRetry: () => { void loadAll(); }
    }));
  }

  // ── 页面骨架 ──────────────────────────────────────────

  function renderPage() {
    clear(root);
    const refreshButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '刷新');
    const hostingLink = h('a', { class: 'btn btn-soft', href: `#/tenants/${encodeURIComponent(tenantId)}/hosting` }, 'Hosting Center');
    const head = pageHead({
      eyebrow: 'Relay & Billing',
      title: `${tenant.name} · 中转计费`,
      sub: 'OpenAI 兼容 Relay 的 Key、模型白名单、额度与按日按模型账单。结算以网关计量为准。',
      actions: [hostingLink, refreshButton]
    });

    const keyCard = renderKeyCard();
    const quotaCard = renderQuotaCard();
    const billing = renderBillingCard();

    root.appendChild(head);
    root.appendChild(h('div', { class: 'relay-grid' }, keyCard.card, quotaCard.card));
    root.appendChild(h('div', { class: 'mt-18' }, billing.card));

    nodes = {
      refreshButton,
      ...keyCard.nodes,
      ...quotaCard.nodes,
      ...billing.nodes
    };

    refreshButton.addEventListener('click', () => { void refreshAll(true); });
    updateKeyUi();
    updateQuotaUi();
    updateBillingUi();
  }

  // ── Key / 模型 ────────────────────────────────────────

  function renderKeyCard() {
    const keyBadge = badge(overview.keyStatusLabel, overview.keyStatusTone);
    const keyCode = h('code', {}, overview.keyMasked || '未绑定');
    const keyDisplay = h('div', { class: 'key-display' },
      h('span', { class: 'mono', 'aria-hidden': 'true' }, 'KEY'),
      keyCode,
      keyBadge
    );
    const upstreamNote = h('p', { class: 'note mt-14' }, '');
    const keyAlert = alertBox('', 'danger', { hidden: true });

    const keyInput = h('input', {
      class: 'input',
      id: 'relay-key',
      name: 'relayKey',
      type: 'password',
      autocomplete: 'off',
      spellcheck: false,
      placeholder: overview.configured ? '输入新 Key（留空保留现有 Key）' : '输入 Relay Key，或选择模型由平台签发'
    });
    const modelSelect = h('select', { class: 'select', id: 'relay-model', name: 'model' });
    const modelsStatus = h('p', { class: 'note' }, '');
    const refreshModels = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, '刷新模型');
    const saveButton = h('button', { class: 'btn btn-primary', type: 'button' }, '保存 Key / 模型');
    const formAlert = alertBox('', 'danger', { hidden: true });

    let modelOptionsSignature = '';
    function fillModelSelect() {
      const signature = `${selectedModel}|${models.map((item) => item.id).join(',')}|${overview.model}`;
      if (signature === modelOptionsSignature) return;
      modelOptionsSignature = signature;
      clear(modelSelect);
      const seen = new Set();
      for (const model of models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        const label = model.contextWindow
          ? `${modelDisplayName(model)} · ${formatTokens(model.contextWindow)}`
          : modelDisplayName(model);
        modelSelect.appendChild(h('option', { value: model.id, selected: model.id === selectedModel }, label));
      }
      if (selectedModel && !seen.has(selectedModel)) {
        modelSelect.appendChild(h('option', { value: selectedModel, selected: true }, `${selectedModel}（当前）`));
      }
      if (!models.length && !selectedModel) {
        modelSelect.appendChild(h('option', { value: '' }, '暂无可用模型，请先绑定 Relay Key'));
      }
      modelSelect.value = selectedModel || '';
      modelsStatus.textContent = modelsBusy
        ? '正在拉取模型…'
        : modelsError
          ? modelsError
          : models.length
            ? `已拉取 ${models.length} 个模型；模型白名单与价格由平台 Relay 配置。${modelsUpstreamError ? ` 上游探测失败：${modelsUpstreamError}` : ''}`
            : '尚未拉取到模型。绑定 Key 后点击“刷新模型”。';
      modelsStatus.dataset.tone = modelsError ? 'danger' : modelsUpstreamError ? 'warn' : '';
      modelsStatus.style.color = modelsError ? 'var(--danger)' : modelsUpstreamError ? 'var(--warn)' : '';
      refreshModels.disabled = modelsBusy;
      refreshModels.classList.toggle('is-loading', modelsBusy);
    }

    const form = h('div', { class: 'relay-form' },
      h('div', { class: 'field' },
        h('div', { class: 'label-row' },
          h('label', { class: 'field-label', for: 'relay-key' }, 'Relay Key'),
          h('span', { class: 'field-hint' }, '服务端加密保存，不回显')
        ),
        keyInput
      ),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' },
          h('label', { class: 'field-label', for: 'relay-model' }, '默认模型'),
          refreshModels
        ),
        modelSelect,
        modelsStatus
      ),
      formAlert,
      h('div', { class: 'inline-buttons' }, saveButton)
    );

    keyInput.addEventListener('input', () => {
      setAlert(formAlert, '', 'danger');
    });
    modelSelect.addEventListener('change', () => {
      selectedModel = modelSelect.value;
      modelTouched = true;
      setAlert(formAlert, '', 'danger');
    });

    const card = h('section', { class: 'card card-pad' },
      cardHead({
        kicker: 'Credential',
        title: 'Relay Key 与模型',
        sub: '虚拟 Key 由平台 Relay 校验，不直接暴露上游密钥。',
        badge: keyBadge
      }),
      keyAlert,
      keyDisplay,
      upstreamNote,
      h('div', { class: 'divider mt-18 mb-18' }),
      form,
      note('面板不允许自定义上游 Provider URL；模型与上游由平台统一配置，避免 SSRF 与密钥外带。')
    );

    saveButton.addEventListener('click', () => { void saveKey(); });
    refreshModels.addEventListener('click', () => { void loadModels(); });

    return {
      card,
      nodes: {
        keyBadge,
        keyCode,
        keyDisplay,
        upstreamNote,
        keyAlert,
        keyInput,
        modelSelect,
        modelsStatus,
        refreshModels,
        saveButton,
        formAlert,
        fillModelSelect
      }
    };
  }

  function updateKeyUi() {
    if (!nodes.keyBadge) return;
    setBadge(nodes.keyBadge, overview.keyStatusLabel, overview.keyStatusTone);
    nodes.keyCode.textContent = overview.keyMasked || '未绑定';
    nodes.upstreamNote.textContent = overview.baseHost
      ? `上游主机：${overview.baseHost}（由平台托管，只读）`
      : '上游地址由平台托管，面板不提供自定义入口。';
    if (!overview.configured) {
      setAlert(nodes.keyAlert, '尚未绑定 Relay Key。绑定后才能拉取模型并产生云端账单。', 'warn');
    } else if (['invalid', 'expired'].includes(overview.keyStatus.status)) {
      setAlert(nodes.keyAlert, redactText(overview.keyStatus.message, { maxLength: 300 }) || 'Relay Key 已失效，请重新绑定。', 'danger');
    } else if (overview.keyStatus.status === 'quota_exceeded') {
      setAlert(nodes.keyAlert, redactText(overview.keyStatus.message, { maxLength: 300 }) || 'Relay 额度已用尽，请联系管理员或调整套餐。', 'danger');
    } else if (overview.lastError) {
      setAlert(nodes.keyAlert, `Relay 最近错误：${redactText(overview.lastError, { maxLength: 300 })}`, 'warn');
    } else {
      setAlert(nodes.keyAlert, '', 'danger');
    }
    if (!modelTouched) {
      selectedModel = overview.model || selectedModel || models[0]?.id || '';
      nodes.modelSelect.value = selectedModel;
    }
    nodes.fillModelSelect();
    nodes.keyInput.placeholder = overview.configured ? '输入新 Key（留空保留现有 Key）' : '输入 Relay Key，或选择模型由平台签发';
  }

  function showIssuedKey(key) {
    const keyInput = h('input', {
      class: 'input mono',
      id: 'issued-relay-key',
      readOnly: true,
      value: key,
      'aria-label': '新签发的 Relay Key'
    });
    const copyButton = h('button', { class: 'btn btn-soft', type: 'button' }, '复制 Key');
    const dialog = openModal({
      root: modalRoot || document.getElementById('modal-root') || document.body,
      kicker: 'Relay Key',
      title: '新的 Relay Key',
      description: '平台已签发新的虚拟 Key。它只在这里显示一次，关闭后无法再次查看。',
      content: h('div', { class: 'modal-form' },
        alertBox('请立即复制并妥善保存。面板不会把完整 Key 写入本地存储或日志。', 'warn'),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'issued-relay-key' }, 'Relay Key'),
          keyInput
        )
      ),
      footer: [copyButton, h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => dialog.close('close') } }, '我已保存')]
    });
    copyButton.addEventListener('click', async () => {
      try {
        const writeText = globalThis.navigator?.clipboard?.writeText;
        if (typeof writeText !== 'function') throw new Error('clipboard unavailable');
        await writeText.call(globalThis.navigator.clipboard, key);
        toast?.show?.('Relay Key 已复制', { tone: 'success' });
      } catch {
        keyInput.select?.();
        toast?.show?.('复制失败，请手动选择输入框内容', { tone: 'warn' });
      }
    });
    setTimeout(() => { keyInput.focus?.(); keyInput.select?.(); }, 0);
  }

  async function saveKey() {
    if (saving || !active) return;
    const key = nodes.keyInput.value;
    const validation = validateRelayInput({ key, model: selectedModel }, { configured: overview.configured });
    if (!validation.ok) {
      setAlert(nodes.formAlert, validation.error, 'danger');
      (key ? nodes.keyInput : nodes.modelSelect).focus?.();
      return;
    }
    saving = true;
    setBusy(nodes.saveButton, true);
    setAlert(nodes.formAlert, '', 'danger');
    try {
      const result = await api.updateRelayKey(tenantId, validation.payload);
      const issuedKey = !validation.payload.key && result && typeof result.key === 'string' ? result.key : '';
      nodes.keyInput.value = '';
      modelTouched = false;
      toast?.show?.('Relay Key / 模型已保存', { tone: 'success' });
      if (issuedKey) showIssuedKey(issuedKey);
      await refreshOverviewQuiet();
      await loadModels();
      selectedModel = overview.model || selectedModel;
      nodes.fillModelSelect();
      updateKeyUi();
    } catch (error) {
      if (active) setAlert(nodes.formAlert, apiErrorMessage(error, { fallback: '保存 Relay Key 失败。' }), 'danger');
    } finally {
      saving = false;
      if (active) setBusy(nodes.saveButton, false);
    }
  }

  async function loadModels() {
    if (modelsBusy || !active) return;
    modelsBusy = true;
    nodes.fillModelSelect();
    try {
      const payload = await api.getRelayModels(tenantId);
      if (!active) return;
      models = normalizeModels(payload);
      modelsError = '';
      modelsUpstreamError = payload?.upstream?.ok === false ? redactText(asString(payload.upstream.error, '上游模型探测失败'), { maxLength: 200 }) : '';
      if (!selectedModel || !models.some((model) => model.id === selectedModel)) {
        selectedModel = overview.model && models.some((model) => model.id === overview.model)
          ? overview.model
          : (models[0]?.id || selectedModel);
      }
    } catch (error) {
      if (!active) return;
      modelsError = apiErrorMessage(error, { fallback: '模型列表加载失败。' });
      modelsUpstreamError = '';
      models = [];
    } finally {
      modelsBusy = false;
      if (active) nodes.fillModelSelect();
    }
  }

  // ── 额度 ──────────────────────────────────────────────

  function renderQuotaCard() {
    const quotaBadge = badge(overview.quota.planName || '套餐额度', 'neutral', { dot: false });
    const quotaBody = h('div', { class: 'quota-panel' });
    const card = h('section', { class: 'card card-pad' },
      cardHead({
        kicker: 'Quota',
        title: '套餐额度',
        sub: '费用与 Token 额度以平台 Relay 的预扣与结算记录为准。',
        badge: quotaBadge
      }),
      quotaBody
    );
    return { card, nodes: { quotaBadge, quotaBody } };
  }

  function updateQuotaUi() {
    if (!nodes.quotaBody) return;
    setBadge(nodes.quotaBadge, overview.quota.planName || '套餐额度', 'neutral');
    const body = nodes.quotaBody;
    clear(body);
    const quota = overview.quota;
    let blocks = 0;

    if (overview.wallet?.available) {
      blocks += 1;
      const wallet = overview.wallet;
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, '可用余额'),
          h('span', { class: 'quota-value' }, h('strong', {}, formatMicros(wallet.availableMicros ?? wallet.balanceMicros ?? 0, wallet.currency || currency())))
        ),
        h('div', { class: 'quota-meta' },
          h('span', {}, `账面 ${formatMicros(wallet.balanceMicros ?? 0, wallet.currency || currency())}`),
          h('span', {}, `冻结 ${formatMicros(wallet.heldMicros ?? 0, wallet.currency || currency())}`)
        )
      ));
    }

    if (overview.plan?.monthlyCreditMicros > 0) {
      blocks += 1;
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, '套餐月度额度'),
          h('span', { class: 'quota-value' }, h('strong', {}, formatMicros(overview.plan.monthlyCreditMicros, currency())), ' / 月')
        ),
        h('div', { class: 'quota-meta', style: { marginTop: '0' } },
          h('span', {}, `模型并发上限 ${overview.plan.maxConcurrent ?? '—'}`),
          h('span', {}, `单次输出 ${overview.plan.maxOutputTokens ? formatTokens(overview.plan.maxOutputTokens) : '—'}`)
        )
      ));
    }

    if (quota.costLimitMicros !== null) {
      blocks += 1;
      const used = quota.costUsedMicros || 0;
      const limit = quota.costLimitMicros;
      const ratio = percentRatio(used, limit);
      const bar = progressBar(ratio, ratio >= 1 ? 'danger' : ratio >= 0.85 ? 'warn' : '');
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, '费用额度'),
          h('span', { class: 'quota-value' }, h('strong', {}, formatMicros(used, currency())), ` / ${formatMicros(limit, currency())}`)
        ),
        bar,
        h('div', { class: 'quota-meta' },
          h('span', {}, `已用 ${formatPercent(ratio)}`),
          h('span', {}, `剩余 ${formatMicros(Math.max(0, limit - used), currency())}`)
        )
      ));
    }

    if (quota.tokenLimit !== null) {
      blocks += 1;
      const used = quota.tokenUsed || 0;
      const limit = quota.tokenLimit;
      const ratio = percentRatio(used, limit);
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, 'Token 额度'),
          h('span', { class: 'quota-value' }, h('strong', {}, formatTokens(used)), ` / ${formatTokens(limit)}`)
        ),
        progressBar(ratio, ratio >= 1 ? 'danger' : ratio >= 0.85 ? 'warn' : ''),
        h('div', { class: 'quota-meta' },
          h('span', {}, `已用 ${formatPercent(ratio)}`),
          h('span', {}, `剩余 ${formatTokens(Math.max(0, limit - used))} tokens`)
        )
      ));
    }

    if (quota.requestsLimit !== null) {
      blocks += 1;
      const used = quota.requestsUsed || 0;
      const ratio = percentRatio(used, quota.requestsLimit);
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, '请求额度'),
          h('span', { class: 'quota-value' }, h('strong', {}, formatNumber(used)), ` / ${formatNumber(quota.requestsLimit)}`)
        ),
        progressBar(ratio, ratio >= 1 ? 'danger' : '')
      ));
    }

    if (quota.rpm !== null || quota.tpm !== null) {
      blocks += 1;
      body.appendChild(h('div', { class: 'quota-block' },
        h('div', { class: 'quota-head' },
          h('span', { class: 'quota-label' }, '速率限制'),
          h('span', { class: 'quota-value' }, '平台 Relay')
        ),
        h('div', { class: 'quota-meta', style: { marginTop: '0' } },
          h('span', {}, `RPM ${quota.rpm === null ? '—' : formatNumber(quota.rpm)}`),
          h('span', {}, `TPM ${quota.tpm === null ? '—' : formatNumber(quota.tpm)}`)
        )
      ));
    }

    if (quota.periodStart || quota.periodEnd) {
      body.appendChild(h('p', { class: 'note' },
        quota.periodStart
          ? `计费周期：${formatDateTime(quota.periodStart)} 至 ${quota.periodEnd ? formatDateTime(quota.periodEnd) : '—'}`
          : `套餐有效期至：${quota.periodEnd ? formatDateTime(quota.periodEnd) : '未设置'}`
      ));
    }

    if (!blocks) {
      body.appendChild(emptyBlock({
        title: '暂无额度信息',
        message: '服务端未返回费用、Token 或请求额度。绑定 Key 或配置套餐后会显示。',
        symbol: '—'
      }));
    }
  }

  // ── 账单 ──────────────────────────────────────────────

  function renderBillingCard() {
    const authorityBadge = badge('云端权威', 'ok', { dot: false });
    const summary = h('div', { class: 'billing-summary' });
    const rangeButtons = ['7', '30', 'all'].map((value) => h('button', {
      type: 'button',
      dataset: { range: value },
      'aria-pressed': value === range ? 'true' : 'false',
      on: {
        click: () => {
          range = value;
          updateRangeButtons();
          renderBillingBody();
          updateBillingStats();
        }
      }
    }, value === 'all' ? '全部' : `近 ${value} 天`));
    const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': '账单范围' }, ...rangeButtons);
    const updated = h('span', { class: 'note' }, '');
    const billingBody = h('div', { class: 'billing-days' });
    const localBox = h('div', {});
    const footnote = h('div', { class: 'billing-footnote' },
      h('span', {}, 'ⓘ'),
      h('span', {},
        h('strong', {}, '云端权威账单：'),
        '以 Relay 网关记录的 usage 与扣费为准。QQ-agent 本地统计仅作估算，不参与结算；缓存 Token 单独统计，视觉 Token 视上游返回计入。'
      )
    );

    const card = h('section', { class: 'card card-pad' },
      cardHead({
        kicker: 'Usage & Billing',
        title: '按日按模型账单',
        sub: '按自然日聚合，模型维度展示输入、输出、缓存、视觉 Token 与费用。',
        badge: authorityBadge
      }),
      summary,
      h('div', { class: 'billing-toolbar' },
        h('div', { class: 'inline-buttons' }, segmented),
        updated
      ),
      billingBody,
      localBox,
      footnote
    );

    return {
      card,
      nodes: {
        summary,
        segmented,
        rangeButtons,
        updated,
        billingBody,
        localBox
      }
    };
  }

  function updateRangeButtons() {
    if (!nodes.rangeButtons) return;
    for (const button of nodes.rangeButtons) {
      const active = button.dataset.range === range;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function updateBillingUi() {
    if (!nodes.billingBody) return;
    const billing = overview.billing;
    const windowNote = billing.windowDays ? ` · 服务端窗口 ${billing.windowDays} 天` : '';
    nodes.updated.textContent = billing.updatedAt
      ? `更新于 ${formatDateTime(billing.updatedAt)}${windowNote}`
      : windowNote.replace(/^ · /, '');
    updateRangeButtons();
    updateBillingStats();
    renderBillingBody();
    renderLocalEstimate();
  }

  function updateBillingStats() {
    if (!nodes.summary) return;
    const billing = overview.billing;
    const days = filterBillingDays(billing.days, range, nowMs());
    const rangeTotals = days.length
      ? summarizeRange(days)
      : range === 'all'
        ? billing.total
        : summarizeRange([]);
    const cur = currency();
    clear(nodes.summary);
    nodes.summary.appendChild(billingStat('今日费用', billing.today.available ? formatMicros(billing.today.costMicros, cur) : '—', `${formatNumber(billing.today.requests)} 次请求`));
    nodes.summary.appendChild(billingStat('今日 Token', billing.today.available ? formatTokens(billing.today.totalTokens) : '—', `输入 ${formatTokens(billing.today.promptTokens)} · 输出 ${formatTokens(billing.today.completionTokens)}`));
    nodes.summary.appendChild(billingStat('今日缓存', billing.today.available ? formatTokens(billing.today.cachedTokens) : '—', '缓存命中 Token'));
    const rangeLabel = range === 'all'
      ? (billing.windowDays ? `服务端 ${billing.windowDays} 天费用` : '累计费用')
      : `近 ${range} 天费用`;
    nodes.summary.appendChild(billingStat(rangeLabel, formatMicros(rangeTotals.costMicros, cur), `${formatTokens(rangeTotals.totalTokens)} tokens`));
    nodes.summary.appendChild(billingStat('含图片请求成本', formatMicros(billing.visionRequestCostMicros, cur), `${formatNumber(billing.visionRequests)} 次请求（服务端窗口，包含文字成本）`));
    nodes.summary.appendChild(billingStat('用量来源', `${formatNumber(billing.usageSources.reported || 0)} 实报`, `${formatNumber(billing.usageSources.estimated || 0)} 估算 · ${formatNumber(billing.usageSources.unknown || 0)} 历史未知`));
  }

  function billingStat(label, value, meta) {
    return h('div', { class: 'billing-stat' },
      h('div', { class: 'stat-key' }, label),
      h('div', { class: 'stat-val' }, value),
      h('div', { class: 'stat-meta' }, meta)
    );
  }

  function renderBillingBody() {
    if (!nodes.billingBody) return;
    const billing = overview.billing;
    const filtered = filterBillingDays(billing.days, range, nowMs());
    clear(nodes.billingBody);
    const dates = new Set(filtered.map(day => day.date));
    const chats = (billing.byChat || []).filter(row => range === 'all' || dates.has(row.date));
    if (chats.length) {
      nodes.billingBody.appendChild(h('section', { class: 'billing-day' },
        h('div', { class: 'billing-day-head' }, '按日期、模型和会话归因'),
        h('table', { class: 'billing-table' },
          h('thead', {}, h('tr', {}, ...['日期', '模型', '平台 / 会话', '请求', '缓存', '费用', '含图片请求', '用量来源'].map(label => h('th', {}, label)))),
          h('tbody', {}, ...chats.map(row => h('tr', {},
            h('td', {}, row.date), h('td', {}, row.model), h('td', {}, row.chatKey ? `${row.platform || '未归因'} / ${row.chatKey}` : '未归因'),
            h('td', {}, formatNumber(row.requests)), h('td', {}, formatTokens(row.cachedTokens)), h('td', {}, formatMicros(row.costMicros, billing.currency)),
            h('td', {}, `${row.visionRequests} 次 · ${formatMicros(row.visionRequestCostMicros, billing.currency)}`),
            h('td', {}, `实报 ${row.usageSources.reported || 0} / 估算 ${row.usageSources.estimated || 0} / 未知 ${row.usageSources.unknown || 0}`)))))));
    }

    if (filtered.length) {
      for (const day of filtered) nodes.billingBody.appendChild(renderDay(day));
      return;
    }

    if (billing.byModel?.length) {
      const pseudo = {
        date: '',
        models: billing.byModel,
        totals: billing.total,
        currency: billing.currency
      };
      nodes.billingBody.appendChild(renderDay(pseudo, true));
      return;
    }

    if (billing.total.available && (billing.total.costMicros || billing.total.totalTokens || billing.total.requests)) {
      nodes.billingBody.appendChild(renderDay({
        date: '',
        models: [{ model: '全部模型', ...billing.total }],
        totals: billing.total,
        currency: billing.currency
      }, true));
      return;
    }

    nodes.billingBody.appendChild(emptyBlock({
      title: '暂无账单记录',
      message: '当前范围内还没有 Relay 调用记录。产生请求后，这里会按日与模型展示 Token 和费用。',
      symbol: '—'
    }));
  }

  function renderDay(day, aggregate = false) {
    const cur = day.currency || currency();
    const totals = day.totals || {};
    const label = aggregate ? '累计汇总' : dayLabel(day.date, nowMs());
    const dateText = day.date && day.date !== label ? day.date : '';
    const head = h('div', { class: 'billing-day-head' },
      h('div', { class: 'billing-day-date' },
        h('span', {}, label),
        dateText ? h('span', { class: 'note' }, dateText) : null,
        aggregate ? badge('非按日', 'warn', { dot: false }) : null
      ),
      h('div', { class: 'billing-day-total' },
        h('span', {}, '请求 ', h('strong', {}, formatNumber(totals.requests))),
        h('span', {}, 'Token ', h('strong', {}, formatTokens(totals.totalTokens))),
        h('span', {}, '费用 ', h('strong', {}, formatMicros(totals.costMicros, cur)))
      )
    );

    const bodyRows = (day.models || []).map((model) => h('tr', {},
      h('td', { class: 'cell-model', title: model.model }, model.model || '未命名模型'),
      h('td', {}, formatNumber(model.requests)),
      h('td', {}, formatTokens(model.promptTokens)),
      h('td', {}, formatTokens(model.completionTokens)),
      h('td', {}, formatTokens(model.cachedTokens)),
      h('td', {}, formatTokens(model.visionTokens)),
      h('td', { class: 'cell-cost' }, formatMicros(model.costMicros, cur))
    ));

    if (!bodyRows.length) {
      bodyRows.push(h('tr', {},
        h('td', { class: 'cell-model' }, '—'),
        h('td', {}, '—'),
        h('td', {}, '—'),
        h('td', {}, '—'),
        h('td', {}, '—'),
        h('td', {}, '—'),
        h('td', { class: 'cell-cost' }, formatMicros(totals.costMicros, cur))
      ));
    }

    const table = h('div', { class: 'table-wrap' },
      h('table', { class: 'billing-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '模型'),
          h('th', {}, '请求'),
          h('th', {}, 'Prompt'),
          h('th', {}, 'Completion'),
          h('th', {}, '缓存'),
          h('th', {}, '视觉'),
          h('th', {}, '费用')
        )),
        h('tbody', {}, ...bodyRows)
      )
    );

    return h('article', { class: 'billing-day' }, head, table);
  }

  function renderLocalEstimate() {
    if (!nodes.localBox) return;
    clear(nodes.localBox);
    const local = overview.localEstimate;
    if (!local) {
      nodes.localBox.appendChild(note('本地估算：服务端未提供 QQ-agent 本地统计；平台账单以上方 Relay 计量为准。'));
      return;
    }
    nodes.localBox.appendChild(h('div', { class: 'local-estimate' },
      h('span', {}, '本地估算（QQ-agent 侧，仅供参考）'),
      h('strong', {}, `${formatMicros(local.costMicros, local.currency || currency())} · ${formatTokens(local.totalTokens)} tokens · ${formatNumber(local.requests)} 次`)
    ));
  }

  // ── 轮询 / 刷新 ────────────────────────────────────────

  function startPolling() {
    poller?.stop();
    poller = createPoller({
      intervalMs: 30_000,
      maxIntervalMs: 120_000,
      immediate: false,
      timers: timers || undefined,
      task: async () => {
        const payload = await api.getRelayOverview(tenantId);
        if (!active) return;
        overview = normalizeRelayOverview(payload);
        pollError = '';
        if (!modelTouched) selectedModel = overview.model || selectedModel;
        updateKeyUi();
        updateQuotaUi();
        updateBillingUi();
      },
      onError: (error) => {
        if (!active) return;
        pollError = apiErrorMessage(error, { fallback: 'Relay 概览刷新失败。' });
        updatePollError();
      }
    });
    poller.start();
  }

  function updatePollError() {
    if (!nodes.updated) return;
    if (pollError) nodes.updated.textContent = `刷新失败：${pollError}`;
    else if (overview?.billing?.updatedAt) nodes.updated.textContent = `更新于 ${formatDateTime(overview.billing.updatedAt)}`;
  }

  async function refreshOverviewQuiet() {
    try {
      const payload = await api.getRelayOverview(tenantId);
      if (!active) return null;
      overview = normalizeRelayOverview(payload);
      pollError = '';
      updateKeyUi();
      updateQuotaUi();
      updateBillingUi();
      return overview;
    } catch (error) {
      if (active) {
        pollError = apiErrorMessage(error, { fallback: 'Relay 概览刷新失败。' });
        updatePollError();
      }
      return null;
    }
  }

  async function refreshAll(notify = false) {
    if (!active) return;
    setBusy(nodes.refreshButton, true);
    try {
      await Promise.allSettled([refreshOverviewQuiet(), loadModels()]);
      if (notify) toast?.show?.('Relay 数据已刷新', { tone: 'success' });
      updatePollError();
    } finally {
      if (active) setBusy(nodes.refreshButton, false);
    }
  }

  // ── 生命周期 ──────────────────────────────────────────

  return {
    destroy() {
      active = false;
      poller?.stop();
      poller = null;
      root.replaceChildren();
    },
    refresh: loadAll
  };
}
