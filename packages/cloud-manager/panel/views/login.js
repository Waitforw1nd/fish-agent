// 平台登录页：密码可见切换、内联错误、网络失败重试。

import { h, setBusy, setHidden } from '../lib/dom.js';
import { normalizeMe } from '../lib/normalize.js';
import { loginErrorMessage } from '../lib/view-data.js';
import { validateLoginInput } from '../lib/validate.js';

export function mountLogin({ root, api, toast, onSuccess, notice = '', onRetry = null } = {}) {
  if (!root) throw new TypeError('缺少登录容器');
  let active = true;
  root.replaceChildren();

  const username = h('input', {
    class: 'input',
    id: 'login-username',
    name: 'username',
    type: 'text',
    autocomplete: 'username',
    placeholder: '平台账号',
    required: true,
    disabled: false
  });
  const password = h('input', {
    class: 'input',
    id: 'login-password',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    placeholder: '密码',
    required: true
  });
  const reveal = h('button', {
    class: 'password-toggle',
    type: 'button',
    'aria-label': '显示密码',
    'aria-pressed': 'false',
    on: {
      click: () => {
        const show = password.type === 'password';
        password.type = show ? 'text' : 'password';
        reveal.textContent = show ? '隐藏' : '显示';
        reveal.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
        reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
      }
    }
  }, '显示');

  const errorNode = h('div', { class: 'form-error', hidden: true });
  const submit = h('button', { class: 'btn btn-primary btn-lg login-submit', type: 'submit' }, '登录平台');
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('div', { class: 'field' },
      h('div', { class: 'label-row' },
        h('label', { class: 'field-label', for: 'login-username' }, '用户名'),
        h('span', { class: 'field-hint' }, '平台管理员或租户账号')
      ),
      username
    ),
    h('div', { class: 'field' },
      h('div', { class: 'label-row' },
        h('label', { class: 'field-label', for: 'login-password' }, '密码'),
        h('span', { class: 'field-hint' }, 'HttpOnly 会话')
      ),
      h('div', { class: 'password-wrap' }, password, reveal)
    ),
    errorNode,
    submit
  );

  const noticeNode = notice
    ? h('div', { class: 'form-error', role: 'status', style: { marginBottom: '18px' } },
        h('span', {}, notice),
        onRetry
          ? h('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              style: { marginLeft: 'auto', flex: 'none' },
              on: { click: () => onRetry() }
            }, '重试连接')
          : null
      )
    : null;

  const shell = h('div', { class: 'login-shell' },
    h('section', { class: 'login-hero' },
      h('a', { class: 'login-brand', href: '#/login' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'brand-copy' },
          h('strong', {}, 'Fish Cloud'),
          h('small', {}, '养鱼 Bot 云托管')
        )
      ),
      h('div', { class: 'login-eyebrow' }, 'Multi-channel · Multi-tenant'),
      h('h1', { class: 'login-title' }, '把养鱼 Bot，', h('br'), h('em', {}, '放进云里。')),
      h('p', { class: 'login-sub' },
        '一台面板管理所有租户：QQ 与 B 站双通道、协议端进程托管、OpenAI 兼容 Relay 与按日计费。账号隔离、端口租约与密钥加密由云端负责。'
      ),
      h('div', { class: 'feature-list' },
        h('div', { class: 'feature' }, h('strong', {}, 'QQ 内核托管'), h('span', {}, 'LLBot / NapCat / SnowLuma 统一启停与扫码')),
        h('div', { class: 'feature' }, h('strong', {}, 'B 站桥接'), h('span', {}, '评论、私信、UP 视频与直播四类订阅')),
        h('div', { class: 'feature' }, h('strong', {}, 'Relay 计费'), h('span', {}, '模型白名单、额度与按日按模型账单')),
        h('div', { class: 'feature' }, h('strong', {}, '多租户隔离'), h('span', {}, '独立数据目录、端口与租户级密钥'))
      )
    ),
    h('section', { class: 'login-panel' },
      h('div', { class: 'login-card' },
        h('div', { class: 'login-card-head' },
          h('h2', { class: 'login-card-title' }, '登录控制台'),
          h('p', { class: 'login-card-sub' }, '使用平台账号进入租户总览。')
        ),
        noticeNode,
        form,
        h('p', { class: 'login-foot' },
          '会话由服务端 HttpOnly Cookie 维护，面板不保存密码或令牌。登录入口：',
          h('code', {}, ' /api/auth/login')
        )
      )
    )
  );

  root.appendChild(shell);

  function showError(message) {
    errorNode.textContent = message;
    setHidden(errorNode, false);
  }

  function clearError() {
    setHidden(errorNode, true);
    errorNode.textContent = '';
  }

  async function onSubmit(event) {
    event.preventDefault?.();
    if (!active) return;
    clearError();
    const validation = validateLoginInput({ username: username.value, password: password.value });
    if (validation) {
      showError(validation);
      (username.value.trim() ? password : username).focus?.();
      return;
    }
    setBusy(submit, true);
    username.disabled = true;
    password.disabled = true;
    reveal.disabled = true;
    try {
      const payload = await api.login(username.value.trim(), password.value);
      const user = normalizeMe(payload);
      if (active) onSuccess?.(user, payload);
    } catch (error) {
      if (active) {
        showError(loginErrorMessage(error));
        password.focus?.();
        password.select?.();
      }
    } finally {
      if (active) {
        setBusy(submit, false);
        username.disabled = false;
        password.disabled = false;
        reveal.disabled = false;
      }
    }
  }

  form.addEventListener('submit', onSubmit);
  setTimeout(() => {
    if (active) username.focus?.();
  }, 0);

  return {
    root,
    destroy() {
      active = false;
      form.removeEventListener('submit', onSubmit);
      root.replaceChildren();
    }
  };
}
