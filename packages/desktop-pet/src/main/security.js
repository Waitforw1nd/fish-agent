const none = args => args.length === 0;
const one = check => args => args.length === 1 && check(args[0]);
const id = value => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rules = Object.freeze({
  'pet:init': none, 'pet:reconnect': none, 'pet:unpair': none, 'pet:hide': none, 'pet:quit': none,
  'pet:pair': one(value => object(value) && Object.keys(value).every(k => ['host','code'].includes(k))
    && typeof value.host === 'string' && value.host.length <= 2048 && typeof value.code === 'string' && value.code.length <= 32),
  'pet:send': one(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 10000),
  'pet:retry': one(id), 'pet:drop': one(id), 'pet:pack': one(id),
  'pet:expanded': one(value => typeof value === 'boolean'),
  'pet:drag': one(value => value === 'start' || value === 'end'),
  'pet:regions': one(value => object(value) && Array.isArray(value.rects) && value.rects.length <= 32)
});

export function trustedHandler(name, fn, { getWindow, page }) {
  if (!Object.hasOwn(rules, name)) throw new Error('不允许的 IPC 通道');
  return (event, ...args) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== page) throw new Error('不允许的窗口请求');
    if (!rules[name](args)) throw new Error('窗口请求参数无效');
    return fn(...args);
  };
}

export function restrictWindow(window) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    contents.on(name, event => event.preventDefault());
  }
  // The text MVP needs no camera, microphone, geolocation, notifications or downloads.
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
}
