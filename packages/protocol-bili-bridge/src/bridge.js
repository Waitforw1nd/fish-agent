import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { AuthRequiredError, BridgeError } from './errors.js';
import { createLogger } from './obs/log.js';
import { JsonStore } from './store/json-store.js';
import { SecretStore } from './store/secret-store.js';
import { PollState } from './store/poll-state.js';
import { MessageRing } from './store/ring.js';
import { FileLock, Mutex } from './store/file-lock.js';
import { CookieJar } from './bili/cookie-jar.js';
import { BiliApi } from './bili/api.js';
import { WbiSigner } from './bili/wbi.js';
import { RiskGuard } from './bili/risk.js';
import { BiliAuth } from './bili/auth.js';
import { CookieRefresher } from './bili/refresh.js';
import { ensureBuvid } from './bili/buvid.js';
import { VideoService, extractBvidFromText } from './bili/video.js';
import { CommentService, commentRootParent } from './bili/comment.js';
import { MsgfeedService } from './bili/msgfeed.js';
import { DynamicService } from './bili/dynamic.js';
import { DmService } from './bili/dm.js';
import { LiveService } from './bili/live.js';
import { VirtualIdMapper } from './mapping/ids.js';
import { PollScheduler, LowFrequencyQueue } from './pollers/scheduler.js';
import { ReplyWatcher, CommentWatcher, UpWatcher, DmWatcher, normalizeVideoWatch } from './pollers/watchers.js';
import { OneBotServer } from './onebot/server.js';
import { createActionHandler } from './onebot/actions.js';
import { createAdminHandler } from './onebot/admin.js';
import {
  buildGroupEvent,
  buildPrivateEvent,
  segmentsToCq,
  renderOutboundSegments,
  textSegments
} from './onebot/message.js';
import { truncateChars } from './util.js';

const APP_VERSION = '0.1.0';

function nowSeconds(now) {
  return Math.floor(now / 1000);
}

function normalizeWatchList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const parsed = normalizeVideoWatch(item);
    if (parsed) out.push(parsed.bvid || parsed.aid);
  }
  return [...new Set(out.filter(Boolean))];
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter((item) => /^\d+$/.test(item)))];
}

function emptySettings(config) {
  return {
    version: 1,
    subscriptions: { ...config.subscriptions },
    watches: {
      videos: normalizeWatchList(config.watch.videos),
      ups: normalizeIdList(config.watch.ups),
      liveRooms: normalizeIdList(config.watch.liveRooms)
    }
  };
}

function cloudSettings(file) {
  const config = JSON.parse(readFileSync(file, 'utf8')).config;
  if (!config || typeof config !== 'object') throw new Error('云端 B站配置无效');
  const enabled = config.enabled !== false;
  const sub = config.subscriptions || {};
  return {
    version: 1,
    subscriptions: { at: enabled && sub.mentions !== false, up: enabled && sub.upVideos !== false, dm: enabled && sub.privateMessages !== false, live: enabled && sub.liveRoom === true },
    watches: { videos: normalizeWatchList(config.videos), ups: normalizeIdList(config.upMids), liveRooms: normalizeIdList([...(config.liveRoomIds || []), ...(config.liveRoomId ? [config.liveRoomId] : [])]) }
  };
}

export class BiliBridge {
  constructor({
    config,
    logger = null,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = WebSocket,
    now = Date.now,
    dispatcher = null,
    refreshPublicKey = null,
    version = APP_VERSION
  } = {}) {
    if (!config) throw new TypeError('BiliBridge 需要 config');
    this.config = config;
    this.version = version;
    this.logger = logger || createLogger({ level: config.logLevel });
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.dispatcher = dispatcher;
    this.refreshPublicKey = refreshPublicKey;
    this.initialized = false;
    this.started = false;
    this.startedAt = 0;
    this.lastWatcherDecision = null;
    this.selfId = 0;
    this.selfMid = '';
    this.selfName = '';
    this.liveClients = new Map();
    this.liveInfos = new Map();
    this.liveStats = new Map();
    this.liveSyncMutex = new Mutex();
    this.lastSyncError = '';
    this.eventSink = {
      comment: (payload) => this.ingestComment(payload),
      upVideo: (payload) => this.ingestUpVideo(payload),
      privateMessage: (payload) => this.ingestDm(payload)
    };
  }

  get tenantId() {
    return this.config.tenantId;
  }

  identity() {
    return { id: this.selfId, mid: this.selfMid, name: this.selfName };
  }

  async init() {
    if (this.initialized) return this;
    const { config } = this;
    await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    this.secrets = await SecretStore.open({
      dir: path.join(config.dataDir, 'secrets'),
      passphrase: config.security?.secretPassphrase || '',
      ...(config.security?.secretKey ? { key: config.security.secretKey } : {}),
      aadPrefix: `bili-bridge:${config.tenantId}`,
      now: this.now,
      logger: this.logger
    });
    this.jar = new CookieJar({ now: () => this.now() });
    this.risk = new RiskGuard({ now: this.now, logger: this.logger });
    this.api = new BiliApi({
      endpoints: config.endpoints,
      jar: this.jar,
      fetchImpl: this.fetchImpl,
      timeoutMs: config.bili.timeoutMs,
      maxResponseBytes: config.bili.maxResponseBytes,
      userAgent: config.bili.userAgent,
      now: this.now,
      logger: this.logger
    });
    this.signer = new WbiSigner({
      request: (args) => this.api.request(args),
      now: this.now,
      logger: this.logger
    });
    this.api.setSigner(this.signer);
    this.api.setRisk(this.risk);
    this.auth = new BiliAuth({
      api: this.api,
      jar: this.jar,
      secrets: this.secrets,
      now: this.now,
      logger: this.logger,
      onLogin: (account) => this.#handleLogin(account)
    });
    this.refresher = new CookieRefresher({
      api: this.api,
      auth: this.auth,
      jar: this.jar,
      lock: new FileLock({
        path: path.join(config.dataDir, 'account.lock'),
        staleMs: 90_000,
        timeoutMs: 20_000,
        now: this.now,
        logger: this.logger
      }),
      now: this.now,
      logger: this.logger,
      ...(this.refreshPublicKey ? { publicKey: this.refreshPublicKey } : {})
    });
    this.mappingStore = new JsonStore({
      dir: config.dataDir,
      name: 'mapping.json',
      defaults: () => ({ version: 1, tenantId: config.tenantId, groups: {}, users: {}, nativeGroups: {}, nativeUsers: {} }),
      logger: this.logger
    });
    this.mapping = new VirtualIdMapper({
      store: this.mappingStore,
      tenantId: config.tenantId,
      now: this.now,
      logger: this.logger
    });
    this.pollStore = new JsonStore({
      dir: config.dataDir,
      name: 'poll-state.json',
      defaults: () => ({ version: 1, cursors: {}, seen: {} }),
      logger: this.logger
    });
    this.pollState = new PollState({
      store: this.pollStore,
      now: this.now,
      capacity: config.store.dedupeCapacity,
      logger: this.logger
    });
    this.ringStore = new JsonStore({
      dir: config.dataDir,
      name: 'messages.json',
      defaults: () => ({ version: 1, counter: 0, messages: [] }),
      logger: this.logger
    });
    this.ring = new MessageRing({
      store: this.ringStore,
      capacity: config.store.messageCapacity,
      now: this.now,
      logger: this.logger
    });
    this.settingsStore = new JsonStore({
      dir: config.dataDir,
      name: 'settings.json',
      defaults: () => emptySettings(config),
      logger: this.logger
    });
    await Promise.all([this.mapping.load(), this.pollState.load(), this.ring.load(), this.settingsStore.load(), this.auth.load()]);
    const saved = this.settingsStore.data || {};
    this.settings = {
      version: 1,
      subscriptions: { ...emptySettings(config).subscriptions, ...(saved.subscriptions || {}) },
      watches: {
        videos: Array.isArray(saved.watches?.videos) ? normalizeWatchList(saved.watches.videos) : normalizeWatchList(config.watch.videos),
        ups: Array.isArray(saved.watches?.ups) ? normalizeIdList(saved.watches.ups) : normalizeIdList(config.watch.ups),
        liveRooms: Array.isArray(saved.watches?.liveRooms) ? normalizeIdList(saved.watches.liveRooms) : normalizeIdList(config.watch.liveRooms)
      }
    };
    if (process.env.BILI_CLOUD_CONFIG_FILE) this.settings = cloudSettings(process.env.BILI_CLOUD_CONFIG_FILE);
    else if (process.env.BILI_WATCH_LIFECYCLE_FILE) this.settings = emptySettings(config);
    for (const key of ['at', 'up', 'dm', 'live']) this.settings.subscriptions[key] = Boolean(this.settings.subscriptions[key]);
    this.#buildServices();
    this.#buildWatchers();
    this.#buildScheduler();
    this.initialized = true;
    return this;
  }

  #buildServices() {
    const { config } = this;
    this.videoService = new VideoService({
      api: this.api,
      now: this.now,
      logger: this.logger,
      maxCoverBytes: config.bili.maxCoverBytes,
      forceHttps: config.bili.forceHttps
    });
    this.commentService = new CommentService({
      api: this.api,
      video: this.videoService,
      now: this.now,
      logger: this.logger,
      maxChars: config.comment.maxChars
    });
    this.dynamicService = new DynamicService({ api: this.api });
    this.msgfeedService = new MsgfeedService({ api: this.api, now: this.now, logger: this.logger });
    this.dmService = new DmService({
      api: this.api,
      jar: this.jar,
      selfUid: this.jar.get('DedeUserID') || '',
      now: this.now,
      logger: this.logger,
      textLimitBytes: config.dm.maxBytes
    });
    this.liveService = new LiveService({
      api: this.api,
      jar: this.jar,
      now: this.now,
      logger: this.logger,
      wsProtocol: config.live.wsProtocol,
      WebSocketImpl: this.WebSocketImpl,
      heartbeatIntervalMs: config.live.heartbeatIntervalMs,
      reconnectMinMs: config.live.reconnectMinMs,
      reconnectMaxMs: config.live.reconnectMaxMs,
      authTimeoutMs: config.live.authTimeoutMs
    });
    this.commentQueue = new LowFrequencyQueue({
      name: 'comment',
      minIntervalMs: config.comment.outboundMinIntervalMs,
      jitterMs: config.comment.outboundJitterMs,
      now: this.now,
      logger: this.logger
    });
    this.dmQueue = new LowFrequencyQueue({
      name: 'dm',
      minIntervalMs: config.dm.outboundMinIntervalMs,
      jitterMs: config.dm.outboundJitterMs,
      now: this.now,
      logger: this.logger
    });
    this.liveQueue = new LowFrequencyQueue({
      name: 'live',
      minIntervalMs: config.live.outboundMinIntervalMs,
      jitterMs: config.live.outboundJitterMs,
      now: this.now,
      logger: this.logger
    });
  }

  #buildWatchers() {
    const common = {
      mapper: this.mapping,
      pollState: this.pollState,
      dispatch: this.eventSink,
      getSelf: () => this.identity(),
      now: this.now,
      logger: this.logger
    };
    this.replyWatcher = new ReplyWatcher({
      ...common,
      msgfeed: this.msgfeedService,
      video: this.videoService,
      dynamic: this.dynamicService,
      getSubscriptions: () => this.getSubscriptions()
    });
    this.commentWatcher = new CommentWatcher({
      ...common,
      comment: this.commentService,
      video: this.videoService,
      getWatches: () => this.watcherActive() ? this.getWatches() : { videos: [] }
    });
    this.upWatcher = new UpWatcher({
      ...common,
      api: this.api,
      getWatches: () => this.getWatches(),
      getSubscriptions: () => this.getSubscriptions()
    });
    this.dmWatcher = new DmWatcher({
      dm: this.dmService,
      pollState: this.pollState,
      dispatch: this.eventSink,
      getSubscriptions: () => this.getSubscriptions(),
      getSelf: () => this.identity(),
      now: this.now,
      logger: this.logger
    });
    this.watchers = {
      msgfeed: this.replyWatcher,
      comment: this.commentWatcher,
      up: this.upWatcher,
      dm: this.dmWatcher
    };
  }

  #buildScheduler() {
    const { config } = this;
    this.scheduler = new PollScheduler({ now: this.now, logger: this.logger });
    const guard = (fn, watcher = true) => async () => {
      if (!this.started || !this.auth.loggedIn) return;
      if (watcher) {
        const active = this.watcherActive();
        if (active !== this.lastWatcherActive) {
          await this.syncLiveRooms();
          this.lastWatcherActive = active;
        }
        if (!active) return;
      }
      await fn();
    };
    this.scheduler.register({
      name: 'msgfeed',
      intervalMs: config.poll.msgfeedIntervalMs,
      jitterMs: config.poll.msgfeedJitterMs,
      initialDelayMs: 0,
      run: guard(() => this.replyWatcher.poll())
    });
    this.scheduler.register({
      name: 'comment',
      intervalMs: config.poll.commentIntervalMs,
      jitterMs: config.poll.commentJitterMs,
      initialDelayMs: 0,
      run: guard(() => this.commentWatcher.poll())
    });
    this.scheduler.register({
      name: 'up',
      intervalMs: config.poll.upIntervalMs,
      jitterMs: config.poll.upJitterMs,
      initialDelayMs: 0,
      run: guard(() => this.upWatcher.poll())
    });
    this.scheduler.register({
      name: 'dm',
      intervalMs: config.poll.dmIntervalMs,
      jitterMs: config.poll.dmJitterMs,
      initialDelayMs: 0,
      run: guard(() => this.dmWatcher.poll())
    });
    this.scheduler.register({
      name: 'cookie-refresh',
      intervalMs: config.poll.cookieCheckIntervalMs,
      jitterMs: config.poll.cookieCheckJitterMs,
      initialDelayMs: 60_000,
      run: guard(async () => {
        const result = await this.refresher.refresh();
        if (result.refreshed) this.logger.info('B 站 cookie 自动保活完成');
      }, false)
    });
  }

  async startServer() {
    if (this.server) return this.server;
    const actionHandler = createActionHandler({ bridge: this, logger: this.logger });
    const adminHandler = createAdminHandler({ bridge: this, version: this.version, logger: this.logger });
    this.server = new OneBotServer({
      host: this.config.onebot.host,
      port: this.config.onebot.port,
      path: this.config.onebot.path,
      token: this.config.onebot.token,
      adminToken: this.config.onebot.adminToken,
      heartbeatIntervalMs: this.config.onebot.heartbeatIntervalMs,
      actionHandler,
      adminHandler,
      bridge: this,
      logger: this.logger
    });
    await this.server.start();
    return this.server;
  }

  async start() {
    await this.init();
    if (this.started) return this;
    this.started = true;
    this.startedAt = this.now();
    try {
      try {
        await ensureBuvid({ api: this.api, jar: this.jar, logger: this.logger, now: this.now });
      } catch (error) {
        this.logger.warn('初始化 buvid 失败（继续启动）', error);
      }
      try {
        await this.auth.ensureSession();
      } catch (error) {
        this.logger.warn('校验 B 站登录态失败（继续启动）', error);
      }
      await this.refreshIdentity();
      await this.startServer();
      this.scheduler.start();
      await this.syncLiveRooms().catch((error) => {
        this.lastSyncError = String(error?.message || error);
        this.logger.warn('启动直播订阅失败', error);
      });
    } catch (error) {
      this.started = false;
      await this.scheduler?.stop().catch(() => {});
      await this.stopAllLiveClients().catch(() => {});
      await this.server?.stop().catch(() => {});
      this.server = null;
      throw error;
    }
    this.logger.info('B 站桥接已启动', {
      tenantId: this.config.tenantId,
      port: this.server?.port,
      loggedIn: this.auth.loggedIn,
      selfId: this.selfId || null
    });
    return this;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    await this.scheduler?.stop();
    await this.stopAllLiveClients();
    await this.server?.stop();
    this.server = null;
    this.logger.info('B 站桥接已停止', { tenantId: this.config.tenantId });
  }

  async #handleLogin(account) {
    this.logger.info('B 站扫码登录成功', { mid: account?.mid, name: account?.name });
    try {
      await this.refreshIdentity();
      this.server?.notifyReady();
      // 扫码可能切换了账号，已有直播连接必须用新的 self 身份重建。
      await this.stopAllLiveClients();
      await this.syncLiveRooms();
      this.kickPollers();
    } catch (error) {
      this.logger.warn('登录后初始化失败', error);
    }
  }

  async refreshIdentity() {
    const account = this.auth.account();
    if (!this.auth.loggedIn || !account.mid) {
      this.selfId = 0;
      this.selfMid = account.mid ? String(account.mid) : '';
      this.selfName = account.name || '';
      return this.identity();
    }
    this.selfMid = String(account.mid);
    this.selfName = String(account.name || '');
    const record = await this.mapping.userFor({ mid: this.selfMid, name: this.selfName });
    this.selfId = record.id;
    if (!this.selfName) this.selfName = record.name || '';
    this.dmService.selfUid = this.selfMid;
    return this.identity();
  }

  kickPollers() {
    if (!this.started) return;
    for (const name of ['msgfeed', 'comment', 'up', 'dm']) {
      this.scheduler.trigger(name).catch((error) => {
        this.logger.warn(`手动触发轮询失败: ${name}`, error);
      });
    }
  }

  watcherStatus() {
    const file = process.env.BILI_WATCH_LIFECYCLE_FILE;
    if (!file) return { active: true, reason: 'standalone' };
    const configFile = path.resolve(path.dirname(file), '..', 'config.json');
    let configured;
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      const value = config?.skills?.['bili-watcher']?.enabled;
      if (value === false || value === true) configured = value;
    } catch (error) {
      if (error.code !== 'ENOENT') return { active: this.lastWatcherDecision ?? false, reason: 'config_unavailable' };
    }
    if (configured === false) {
      this.lastWatcherDecision = false;
      return { active: false, reason: 'disabled' };
    }
    try {
      const status = JSON.parse(readFileSync(file, 'utf8'));
      if (status.active === false) {
        this.lastWatcherDecision = false;
        return { active: false, reason: 'disabled' };
      }
      if (status.active !== true || !Number.isSafeInteger(status.pid) || status.pid <= 0) throw new Error('invalid watcher status');
      try { process.kill(status.pid, 0); } catch (error) {
        if (error.code !== 'EPERM') {
          const active = this.lastWatcherDecision ?? (configured !== false);
          return { active, reason: 'agent_offline' };
        }
      }
      this.lastWatcherDecision = true;
      return { active: true, reason: 'enabled' };
    } catch (error) {
      const missing = error.code === 'ENOENT';
      const active = this.lastWatcherDecision ?? (missing && configured !== false);
      return { active, reason: missing ? 'state_missing' : 'state_invalid' };
    }
  }

  watcherActive() { return this.watcherStatus().active; }

  getSubscriptions() {
    const subscriptions = { ...(this.settings?.subscriptions || this.config.subscriptions) };
    if (!this.watcherActive()) for (const key of Object.keys(subscriptions)) subscriptions[key] = false;
    return subscriptions;
  }

  getWatches() {
    const watches = this.settings?.watches || this.config.watch;
    return {
      videos: [...(watches.videos || [])],
      ups: [...(watches.ups || [])],
      liveRooms: [...(watches.liveRooms || [])]
    };
  }

  async #saveSettings() {
    await this.settingsStore.update((draft) => {
      draft.version = 1;
      draft.subscriptions = { ...this.settings.subscriptions };
      draft.watches = {
        videos: [...this.settings.watches.videos],
        ups: [...this.settings.watches.ups],
        liveRooms: [...this.settings.watches.liveRooms]
      };
    });
  }

  async setSubscriptions(patch = {}) {
    for (const key of ['at', 'up', 'dm', 'live']) {
      if (patch[key] !== undefined) this.settings.subscriptions[key] = Boolean(patch[key]);
    }
    await this.#saveSettings();
    if (this.started) {
      try { await this.syncLiveRooms(); } catch (error) {
        this.lastSyncError = String(error?.message || error);
        this.logger.warn('应用直播订阅变更失败', error);
      }
    }
    return this.getSubscriptions();
  }

  async setWatches(patch = {}) {
    if (patch.videos !== undefined) this.settings.watches.videos = normalizeWatchList(patch.videos);
    if (patch.ups !== undefined) this.settings.watches.ups = normalizeIdList(patch.ups);
    if (patch.liveRooms !== undefined) this.settings.watches.liveRooms = normalizeIdList(patch.liveRooms);
    await this.#saveSettings();
    if (this.started && patch.liveRooms !== undefined) {
      try { await this.syncLiveRooms(); } catch (error) {
        this.lastSyncError = String(error?.message || error);
        this.logger.warn('应用直播间订阅变更失败', error);
      }
    }
    return this.getWatches();
  }

  async syncLiveRooms() {
    return this.liveSyncMutex.run(async () => {
      if (!this.started) return { started: 0, stopped: 0, skipped: true };
      if (!this.auth.loggedIn || this.getSubscriptions().live === false) {
        const stopped = await this.stopAllLiveClients();
        return { started: 0, stopped, skipped: true };
      }
      const desired = this.getWatches().liveRooms;
      const desiredSet = new Set(desired);
      let stopped = 0;
      for (const [room, entry] of [...this.liveClients]) {
        if (desiredSet.has(room)) continue;
        await entry.client.stop();
        this.liveClients.delete(room);
        this.liveInfos.delete(room);
        this.liveStats.delete(room);
        stopped += 1;
      }
      let started = 0;
      for (const room of desired) {
        if (!this.started) break;
        if (this.liveClients.has(room)) continue;
        try {
          const info = await this.liveService.info(room);
          if (!this.started) break;
          const group = await this.mapping.groupForLive({
            roomId: info.roomId,
            title: info.title,
            cover: info.cover,
            ownerMid: info.ownerMid
          });
          if (!this.started) break;
          const client = this.liveService.createClient({
            roomId: room,
            canonicalRoomId: info.roomId,
            ownerMid: info.ownerMid,
            title: info.title,
            selfMid: this.selfMid,
            selfName: this.selfName,
            filter: this.config.live.filter,
            heartbeatIntervalMs: this.config.live.heartbeatIntervalMs,
            reconnectMinMs: this.config.live.reconnectMinMs,
            reconnectMaxMs: this.config.live.reconnectMaxMs,
            authTimeoutMs: this.config.live.authTimeoutMs
          });
          const entry = { client, info, group };
          this.liveClients.set(room, entry);
          this.liveInfos.set(room, info);
          this.liveStats.set(room, client.stats());
          client.on('event', (event) => {
            this.ingestLiveEvent(event, entry).catch((error) => {
              this.logger.warn('处理直播事件失败', error);
            });
          });
          client.on('status', (stats) => this.liveStats.set(room, stats));
          client.on('ready', (stats) => {
            this.liveStats.set(room, stats);
            this.logger.info('直播间弹幕已连接', { roomId: info.roomId, host: stats.host });
          });
          await client.start();
          started += 1;
        } catch (error) {
          this.lastSyncError = String(error?.wording || error?.message || error);
          this.logger.warn('启动直播间 watcher 失败', { room, error: this.lastSyncError });
        }
      }
      if (!started && !stopped) this.lastSyncError = '';
      return { started, stopped };
    });
  }

  async stopAllLiveClients() {
    let stopped = 0;
    for (const [, entry] of this.liveClients) {
      try { await entry.client.stop(); } catch { /* ignore */ }
      stopped += 1;
    }
    this.liveClients.clear();
    this.liveInfos.clear();
    this.liveStats.clear();
    return stopped;
  }

  async reconnectLive(roomId) {
    const key = String(roomId ?? '');
    if (!this.getWatches().liveRooms.includes(key)) {
      throw new BridgeError(`直播间 ${key || '(空)'} 未订阅`, {
        kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: '该直播间不在订阅列表中'
      });
    }
    const entry = this.liveClients.get(key);
    if (entry) {
      await entry.client.stop();
      this.liveClients.delete(key);
      this.liveInfos.delete(key);
      this.liveStats.delete(key);
    }
    await this.syncLiveRooms();
    const next = this.liveClients.get(key);
    return { roomId: key, connected: Boolean(next?.client.stats().connected), stats: next?.client.stats() || null };
  }

  #watchGroup(groupId) {
    const group = this.mapping.resolveGroup(groupId);
    if (!group) {
      throw new BridgeError(`未知的 B 站虚拟群 ${groupId}`, {
        kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: '该群不是 B 站映射群'
      });
    }
    return group;
  }

  #watchUser(userId) {
    const user = this.mapping.resolveUser(userId);
    if (!user) {
      throw new BridgeError(`未知的 B 站虚拟用户 ${userId}`, {
        kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: '该用户不是 B 站映射用户'
      });
    }
    return user;
  }

  async sendGroupMessage({ groupId, message } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const group = this.#watchGroup(groupId);
    if (group.kind !== 'video' && group.kind !== 'dynamic' && group.kind !== 'live') {
      throw new BridgeError('不支持的 B 站群类型', { kind: 'UNSUPPORTED', code: 400, retcode: 1404 });
    }
    if (group.kind === 'live') {
      return this.#sendLiveGroupMessage(group, message);
    }
    return this.#sendVideoComment(group, message);
  }

  async #sendVideoComment(group, message) {
    const rendered = renderOutboundSegments(message, {
      selfId: this.selfId,
      selfName: this.selfName,
      resolveUser: (id) => this.mapping.resolveUser(id),
      allowReply: true,
      allowAt: true
    });
    let root = '0';
    let parent = '0';
    if (rendered.replyMessageId != null) {
      const target = this.ring.get(rendered.replyMessageId);
      if (!target) {
        throw new BridgeError('引用的 B 站消息已不在最近消息缓冲中', {
          kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: '无法引用：消息已过期或不存在'
        });
      }
      const native = target.native || {};
      if (Number(target.group_id) !== Number(group.id)) throw new BridgeError('不能跨评论区引用', { kind: 'INPUT', code: 400, retcode: 1400 });
      if (native.kind !== 'comment') {
        throw new BridgeError('不能引用非同平台消息', {
          kind: 'INPUT', code: 400, retcode: 1400, wording: '不能引用直播/私信消息作为评论'
        });
      }
      if (group.native?.aid && native.oid && String(group.native.aid) !== String(native.oid)) {
        throw new BridgeError('引用评论不属于当前视频', {
          kind: 'INPUT', code: 400, retcode: 1400, wording: '不能跨视频引用评论'
        });
      }
      if (!native.rpid) {
        throw new BridgeError('被引用评论缺少 rpid', {
          kind: 'PROTOCOL', code: 502, retcode: 1502, wording: '无法引用该评论'
        });
      }
      ({ root, parent } = commentRootParent({ rpid: native.rpid, root: native.root }));
    }
    const text = truncateChars(rendered.text.trim(), this.config.comment.maxChars);
    if (!text.trim()) {
      throw new BridgeError('评论文本为空', { kind: 'INPUT', code: 400, retcode: 1400, wording: '评论内容不能为空' });
    }
    const subject = group.kind === 'dynamic' ? await this.dynamicService.detail(group.native.dynamicId) : null;
    const result = await this.commentQueue.enqueue(() => this.commentService.add({
      oid: subject?.oid || group.native?.aid || undefined,
      type: subject?.type || 1,
      bvid: group.native?.bvid || undefined,
      message: text,
      root,
      parent
    }));
    const record = await this.ring.add({
      channel: 'video-comment',
      direction: 'out',
      groupId: group.id,
      userId: this.selfId,
      message,
      rawMessage: segmentsToCq(message),
      native: {
        kind: 'comment',
        oid: result.oid,
        bvid: group.native?.bvid || '',
        rpid: result.rpid || '',
        root,
        parent
      },
      time: nowSeconds(this.now()),
      extra: { senderName: this.selfName }
    });
    return {
      message_id: record.message_id,
      rpid: result.rpid || null,
      root,
      parent,
      ...(text !== rendered.text.trim() ? { truncated: true } : {})
    };
  }

  async #sendLiveGroupMessage(group, message) {
    const warnings = [];
    if ((message || []).some((segment) => segment.type === 'reply')) warnings.push('直播弹幕不支持引用，已忽略引用段');
    const rendered = renderOutboundSegments(message, {
      selfId: this.selfId,
      selfName: this.selfName,
      resolveUser: (id) => this.mapping.resolveUser(id),
      allowReply: false,
      allowAt: true
    });
    const text = truncateChars(rendered.text.trim(), 20);
    if (!text.trim()) {
      throw new BridgeError('弹幕内容为空', { kind: 'INPUT', code: 400, retcode: 1400, wording: '弹幕内容不能为空' });
    }
    const result = await this.liveQueue.enqueue(() => this.liveService.sendDanmaku({
      roomId: group.native?.roomId,
      text
    }));
    const record = await this.ring.add({
      channel: 'live-danmaku',
      direction: 'out',
      groupId: group.id,
      userId: this.selfId,
      message,
      rawMessage: segmentsToCq(message),
      native: { kind: 'live-out', roomId: String(group.native?.roomId || '') },
      time: nowSeconds(this.now()),
      extra: { senderName: this.selfName }
    });
    return {
      message_id: record.message_id,
      room_id: result.roomId,
      ...(text !== rendered.text.trim() ? { truncated: true } : {}),
      ...(warnings.length ? { warnings } : {})
    };
  }

  async sendPrivateMessage({ userId, message } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const user = this.#watchUser(userId);
    const targetMid = user.native?.mid;
    if (!targetMid) {
      throw new BridgeError('私信目标缺少 B 站 mid', { kind: 'PROTOCOL', code: 500, retcode: 1500 });
    }
    const warnings = [];
    if ((message || []).some((segment) => segment.type === 'reply')) warnings.push('B 站私信不支持引用，已忽略引用段');
    const images = message.filter((segment) => segment.type === 'image');
    if (images.length > 1) throw new BridgeError('一次只能发送一张私信图片', { kind: 'INPUT', code: 400, retcode: 1400 });
    const rendered = renderOutboundSegments(message.filter((segment) => segment.type !== 'image'), {
      selfId: this.selfId,
      selfName: this.selfName,
      resolveUser: (id) => this.mapping.resolveUser(id),
      allowReply: false,
      allowAt: true
    });
    const text = rendered.text.trim();
    if (images.length && text) throw new BridgeError('图片与文字需要分开发送', { kind: 'INPUT', code: 400, retcode: 1400 });
    if (!text && !images.length) throw new BridgeError('私信内容为空', { kind: 'INPUT', code: 400, retcode: 1400 });
    const result = await this.dmQueue.enqueue(async () => {
      const image = images.length ? await this.dmService.uploadImage(images[0].data?.file) : null;
      return this.dmService.send({ receiverId: targetMid, text, image });
    });
    const record = await this.ring.add({
      channel: 'private',
      direction: 'out',
      groupId: null,
      userId: user.id,
      message,
      rawMessage: segmentsToCq(message),
      native: { kind: 'dm-out', talkerId: String(targetMid), seqno: result.seqno || '' },
      time: nowSeconds(this.now()),
      extra: { senderName: this.selfName }
    });
    return {
      message_id: record.message_id,
      seqno: result.seqno || null,
      ...(warnings.length ? { warnings } : {})
    };
  }

  async ingestComment({ group, reply, atSelf = false, source = 'video', sourceContent = '', title = '', uri = '' } = {}) {
    if (!this.selfId || !group || !reply) return null;
    if (!/^\d+$/.test(String(reply.mid || ''))) return null;
    if (String(reply.mid) === String(this.selfMid)) return null;
    const sender = await this.mapping.userFor({ mid: String(reply.mid || ''), name: reply.uname || '' });
    const segments = await this.#buildMentionSegments(reply.message || '', {
      members: reply.members,
      atNameToMid: reply.atNameToMid,
      atSelf
    });
    if (sourceContent) {
      segments.unshift({ type: 'text', data: { text: `[原评论] ${truncateChars(sourceContent, 200)}\n` } });
    }
    const record = await this.ring.add({
      channel: 'video-comment',
      direction: 'in',
      groupId: group.id,
      userId: sender.id,
      message: segments,
      rawMessage: segmentsToCq(segments),
      native: {
        kind: 'comment',
        oid: String(group.commentSubject?.oid || reply.oid || group.native?.aid || ''),
        type: group.commentSubject?.type || 1,
        bvid: group.native?.bvid || '',
        rpid: String(reply.rpid || ''),
        root: String(reply.root ?? '0'),
        parent: String(reply.parent ?? '0')
      },
      time: Number(reply.ctime) || nowSeconds(this.now()),
      extra: { senderName: reply.uname || sender.name || '', source, title, uri }
    });
    const event = buildGroupEvent({
      selfId: this.selfId,
      groupId: group.id,
      userId: sender.id,
      senderName: reply.uname || sender.name || String(reply.mid || ''),
      segments,
      messageId: record.message_id,
      time: Number(reply.ctime) || nowSeconds(this.now())
    });
    await this.emitEvent(event);
    return { messageId: record.message_id, groupId: group.id, userId: sender.id };
  }

  async ingestDm({ user, message, session = null } = {}) {
    if (!this.selfId || !message) return null;
    if (message.self || String(message.mid) === String(this.selfMid)) return null;
    const mid = String(message.mid || user?.mid || session?.talkerId || '');
    if (!/^\d+$/.test(mid)) return null;
    const sender = await this.mapping.userFor({ mid, name: user?.name || '' });
    let segments;
    if (message.contentType === 'text' && message.text) {
      segments = textSegments(message.text);
    } else if (message.imageUrl) {
      segments = [{ type: 'image', data: { file: message.imageUrl, url: message.imageUrl } }];
    } else {
      segments = textSegments(message.text || '[消息]');
    }
    const record = await this.ring.add({
      channel: 'private',
      direction: 'in',
      groupId: null,
      userId: sender.id,
      message: segments,
      rawMessage: segmentsToCq(segments),
      native: { kind: 'dm', talkerId: mid, seqno: String(message.seqno || '') },
      time: Number(message.timestamp) || nowSeconds(this.now()),
      extra: { senderName: user?.name || sender.name || '' }
    });
    const event = buildPrivateEvent({
      selfId: this.selfId,
      userId: sender.id,
      senderName: user?.name || sender.name || mid,
      segments,
      messageId: record.message_id,
      time: Number(message.timestamp) || nowSeconds(this.now())
    });
    await this.emitEvent(event);
    return { messageId: record.message_id, userId: sender.id };
  }

  async ingestUpVideo({ group, video, up } = {}) {
    if (!this.selfId || !group || !video) return null;
    const upMid = String(up?.mid || video.mid || '');
    if (!/^\d+$/.test(upMid)) return null;
    const user = await this.mapping.userFor({ mid: upMid, name: up?.name || video.author || '' });
    const url = video.bvid ? `https://www.bilibili.com/video/${video.bvid}` : '';
    const description = video.description ? `\n${truncateChars(video.description, 200)}` : '';
    const segments = textSegments(`[UP主更新] ${video.title}${description}${url ? `\n${url}` : ''}`);
    const record = await this.ring.add({
      channel: 'up-video',
      direction: 'in',
      groupId: group.id,
      userId: user.id,
      message: segments,
      rawMessage: segmentsToCq(segments),
      native: { kind: 'up-video', bvid: String(video.bvid || ''), aid: String(video.aid || ''), mid: upMid },
      time: Number(video.created) || nowSeconds(this.now()),
      extra: { senderName: up?.name || video.author || '' }
    });
    const event = buildGroupEvent({
      selfId: this.selfId,
      groupId: group.id,
      userId: user.id,
      senderName: up?.name || video.author || upMid,
      segments,
      messageId: record.message_id,
      time: Number(video.created) || nowSeconds(this.now())
    });
    await this.emitEvent(event);
    return { messageId: record.message_id, groupId: group.id };
  }

  async ingestLiveEvent(event, entry) {
    if (!this.selfId || !event || !entry) return null;
    if (event.kind === 'room_status') {
      this.liveStats.set(entry.client.roomId, { ...(this.liveStats.get(entry.client.roomId) || {}), roomStatus: event.status });
      return null;
    }
    if (this.getSubscriptions().live === false) return null;
    if (this.pollState.hasSeen(`live:${event.roomId || entry.info.roomId}`, event.eventId)) return null;
    const uid = String(event.uid || '');
    if (!/^\d+$/.test(uid)) {
      this.logger.debug('忽略没有有效 UID 的直播事件', { kind: event.kind });
      return null;
    }
    if (uid === String(this.selfMid)) {
      this.logger.debug('忽略自己发出的直播事件，避免回环', { kind: event.kind });
      return null;
    }
    const user = await this.mapping.userFor({ mid: uid, name: event.uname || '' });
    let segments;
    let text;
    if (event.kind === 'danmaku') {
      text = String(event.text || '');
      const atSelf = Boolean(event.atSelf);
      if (atSelf && this.selfName) {
        const token = `@${this.selfName}`;
        if (text.startsWith(token)) text = text.slice(token.length).trimStart();
        else text = text.replace(token, '');
      }
      segments = [];
      if (atSelf) segments.push({ type: 'at', data: { qq: String(this.selfId), name: this.selfName } });
      if (text) segments.push({ type: 'text', data: { text } });
    } else if (event.kind === 'gift') {
      text = `[礼物] ${event.giftName} ×${event.num}`;
      segments = textSegments(text);
    } else if (event.kind === 'super_chat') {
      text = `[醒目留言 ¥${event.price}] ${event.text}`;
      segments = textSegments(text);
    } else if (event.kind === 'guard') {
      text = `[大航海] ${event.uname} 开通 ${event.giftName} ×${event.num}`;
      segments = textSegments(text);
    } else {
      return null;
    }
    const record = await this.ring.add({
      channel: 'live',
      direction: 'in',
      groupId: entry.group.id,
      userId: user.id,
      message: segments,
      rawMessage: segmentsToCq(segments),
      native: {
        kind: 'live',
        roomId: String(event.roomId || entry.info.roomId),
        eventId: event.eventId,
        eventKind: event.kind,
        uid
      },
      time: Number(event.timestamp) || nowSeconds(this.now()),
      extra: { senderName: event.uname || user.name || '' }
    });
    const eventPayload = buildGroupEvent({
      selfId: this.selfId,
      groupId: entry.group.id,
      userId: user.id,
      senderName: event.uname || user.name || uid,
      segments,
      messageId: record.message_id,
      time: Number(event.timestamp) || nowSeconds(this.now())
    });
    const delivered = await this.pollState.deliverOnce(`live:${event.roomId || entry.info.roomId}`, event.eventId, () => this.emitEvent(eventPayload));
    return delivered ? { messageId: record.message_id, groupId: entry.group.id } : null;
  }

  async #buildMentionSegments(message, { members = [], atNameToMid = {}, atSelf = false } = {}) {
    const text = String(message || '');
    const candidates = [];
    const seenNames = new Set();
    const seenMids = new Set();
    const addCandidate = (mid, name) => {
      const m = String(mid || '');
      const n = String(name || '').replace(/^@/, '').trim();
      if (!m || !n) return;
      if (seenNames.has(n) || seenMids.has(m)) return;
      seenNames.add(n);
      seenMids.add(m);
      candidates.push({ mid: m, name: n });
    };
    if (this.selfMid && this.selfName) addCandidate(this.selfMid, this.selfName);
    for (const member of members || []) addCandidate(member?.mid, member?.uname || member?.nickname);
    for (const [name, mid] of Object.entries(atNameToMid || {})) addCandidate(mid, name);

    const resolved = [];
    for (const candidate of candidates) {
      try {
        if (candidate.mid === String(this.selfMid) && this.selfId) {
          resolved.push({ ...candidate, virtual: this.selfId, self: true, display: this.selfName || candidate.name });
        } else {
          const record = await this.mapping.userFor({ mid: candidate.mid, name: candidate.name });
          resolved.push({ ...candidate, virtual: record.id, self: false, display: record.name || candidate.name });
        }
      } catch (error) {
        this.logger.debug('提及用户映射失败，保留纯文本', { mid: candidate.mid, error: error?.message });
      }
    }
    resolved.sort((a, b) => b.name.length - a.name.length);

    const segments = [];
    let rest = text;
    let selfMentioned = false;
    let guard = 0;
    while (rest && guard < 50) {
      guard += 1;
      let best = null;
      let bestIndex = -1;
      for (const candidate of resolved) {
        const token = `@${candidate.name}`;
        const index = rest.indexOf(token);
        if (index < 0) continue;
        if (bestIndex < 0 || index < bestIndex || (index === bestIndex && candidate.name.length > best.name.length)) {
          best = candidate;
          bestIndex = index;
        }
      }
      if (!best) {
        segments.push({ type: 'text', data: { text: rest } });
        break;
      }
      if (bestIndex > 0) segments.push({ type: 'text', data: { text: rest.slice(0, bestIndex) } });
      segments.push({ type: 'at', data: { qq: String(best.virtual), name: best.display } });
      if (best.self) selfMentioned = true;
      rest = rest.slice(bestIndex + best.name.length + 1);
    }
    if (atSelf && !selfMentioned && this.selfId) {
      segments.unshift({ type: 'at', data: { qq: String(this.selfId), name: this.selfName || '' } });
    }
    return segments.filter((segment) => segment.type !== 'text' || segment.data.text);
  }

  async emitEvent(event) {
    if (this.dispatcher) await this.dispatcher(event);
    return this.server?.broadcast(event) ?? 0;
  }

  // ── OneBot 查询与身份 ────────────────────────────────────────────────
  loginInfo() {
    if (!this.auth.loggedIn || !this.selfId) throw new AuthRequiredError('B 站账号未登录，请先在管理面板扫码');
    return { user_id: this.selfId, nickname: this.selfName || `B站用户${this.selfMid}` };
  }

  onebotStatus() {
    return { online: true, good: this.auth.loggedIn, self_id: this.selfId || null };
  }

  versionInfo() {
    return { app_name: 'fish-bili-bridge', app_version: this.version, protocol_version: 'v11' };
  }

  getMessage(messageId) {
    const record = this.ring.get(messageId);
    if (!record) {
      throw new BridgeError('消息不存在或已超出最近缓冲', {
        kind: 'NOT_FOUND', code: 404, retcode: 1404, wording: '消息不存在或已过期'
      });
    }
    return {
      message_id: record.message_id,
      real_id: record.message_id,
      message_type: record.group_id != null ? 'group' : 'private',
      group_id: record.group_id ?? undefined,
      user_id: record.user_id ?? undefined,
      time: record.time,
      sender: {
        user_id: record.user_id ?? 0,
        nickname: record.extra?.senderName || ''
      },
      message: record.message,
      raw_message: record.raw_message,
      message_format: 'array'
    };
  }

  #groupName(group) {
    if (group.title) return group.title;
    if (group.kind === 'video') return `B站视频 ${group.native?.bvid || group.native?.aid || ''}`.trim();
    if (group.kind === 'live') return `B站直播 ${group.native?.roomId || ''}`.trim();
    if (group.kind === 'dynamic') return `B站动态 ${group.native?.dynamicId || ''}`.trim();
    return `B站群 ${group.id}`;
  }

  getGroupInfo(groupId) {
    const group = this.#watchGroup(groupId);
    return {
      group_id: group.id,
      group_name: this.#groupName(group),
      member_count: 0,
      max_member_count: 0
    };
  }

  getGroupList() {
    return this.mapping.groups().map((group) => ({
      group_id: group.id,
      group_name: this.#groupName(group),
      member_count: 0,
      max_member_count: 0
    }));
  }

  getGroupMemberInfo(groupId, userId) {
    this.#watchGroup(groupId);
    const user = this.mapping.resolveUser(userId);
    return {
      group_id: Number(groupId),
      user_id: Number(userId),
      nickname: user?.name || String(userId),
      card: user?.name || '',
      role: 'member'
    };
  }

  getGroupMemberList(groupId) {
    this.#watchGroup(groupId);
    const users = this.mapping.users().map((user) => ({
      user_id: user.id,
      nickname: user.name || String(user.native?.mid || user.id),
      card: user.name || '',
      role: 'member'
    }));
    if (this.selfId && !users.some((user) => user.user_id === this.selfId)) {
      users.unshift({ user_id: this.selfId, nickname: this.selfName || 'B站账号', card: this.selfName || '', role: 'member' });
    }
    return users.slice(0, 500);
  }

  getFriendList() {
    return this.mapping.users()
      .filter((user) => user.id !== this.selfId)
      .slice(0, 500)
      .map((user) => ({
        user_id: user.id,
        nickname: user.name || String(user.native?.mid || user.id),
        remark: ''
      }));
  }

  getStrangerInfo(userId) {
    const user = this.#watchUser(userId);
    return {
      user_id: user.id,
      nickname: user.name || String(user.native?.mid || user.id),
      sex: 'unknown',
      age: 0
    };
  }

  // ── 管理操作 ──────────────────────────────────────────────────────────
  accountStatus() {
    return { ...this.auth.status(), risk: this.risk.snapshot() };
  }

  adminStatus() {
    return {
      ok: true,
      tenantId: this.config.tenantId,
      version: this.version,
      uptimeMs: this.now() - (this.startedAt || this.now()),
      self: this.identity(),
      bili: this.accountStatus(),
      cookies: this.refresher.snapshot(),
      api: this.api.snapshot(),
      subscriptions: this.getSubscriptions(),
      watcherActive: this.watcherActive(),
      watcher: this.watcherStatus(),
      watches: this.getWatches(),
      pollIntervals: {
        msgfeedMs: this.config.poll.msgfeedIntervalMs,
        commentMs: this.config.poll.commentIntervalMs,
        dmMs: this.config.poll.dmIntervalMs,
        upMs: this.config.poll.upIntervalMs,
        cookieMs: this.config.poll.cookieCheckIntervalMs
      },
      pollers: this.scheduler.stats(),
      watchers: {
        msgfeed: this.replyWatcher.status(),
        comment: this.commentWatcher.status(),
        up: this.upWatcher.status(),
        dm: this.dmWatcher.status()
      },
      queues: {
        comment: this.commentQueue.stats(),
        dm: this.dmQueue.stats(),
        live: this.liveQueue.stats()
      },
      live: this.liveService.snapshot(),
      liveStatus: Object.fromEntries(this.liveStats),
      liveSyncError: this.lastSyncError || null,
      mapping: this.mapping.stats(),
      messages: this.ring.stats(),
      onebot: this.server?.status() || null
    };
  }

  async createQr() {
    try {
      await ensureBuvid({ api: this.api, jar: this.jar, logger: this.logger, now: this.now });
    } catch (error) {
      this.logger.warn('生成二维码前初始化 buvid 失败', error);
    }
    return this.auth.generateQr();
  }

  async pollQr(key) {
    const qr = await this.auth.pollQr(key);
    return {
      ...qr,
      account: this.auth.loggedIn ? this.auth.account() : null
    };
  }

  async logout() {
    await this.stopAllLiveClients();
    await this.auth.logout();
    this.selfId = 0;
    this.selfMid = '';
    this.selfName = '';
    return this.auth.status();
  }

  async refreshCookies({ force = false } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const result = await this.refresher.refresh({ force });
    this.logger.info('手动 cookie 保活完成', { refreshed: result.refreshed });
    return { ...result, snapshot: this.refresher.snapshot() };
  }

  async clearRisk() {
    const cleared = this.risk.clear();
    return { cleared, risk: this.risk.snapshot() };
  }

  mappingSnapshot() {
    return {
      stats: this.mapping.stats(),
      groups: this.mapping.groups().slice(0, 500).map((group) => ({
        id: group.id,
        kind: group.kind,
        title: group.title || '',
        nativeKey: group.nativeKey,
        native: { ...group.native },
        updatedAt: group.updatedAt || null
      })),
      users: this.mapping.users().slice(0, 500).map((user) => ({
        id: user.id,
        name: user.name || '',
        mid: String(user.native?.mid || ''),
        updatedAt: user.updatedAt || null
      }))
    };
  }

  recentMessages(limit = 20) {
    return this.ring.recent(limit).map((record) => ({
      message_id: record.message_id,
      channel: record.channel,
      direction: record.direction,
      group_id: record.group_id,
      user_id: record.user_id,
      time: record.time,
      text: record.message?.map((segment) => segment.type === 'text' ? segment.data?.text || '' : `[${segment.type}]`).join('') || '',
      native: record.native
    }));
  }

  async getVideoContext({ bvid, aid, cid, url, groupId, includeSubtitles = true, includeComments = false, download = true } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const group = groupId ? this.mapping.resolveGroup(groupId) : null;
    let resolvedBvid = bvid ? String(bvid) : (group?.kind === 'video' ? group.native.bvid || '' : '');
    if (!aid && group?.kind === 'video') aid = group.native.aid || undefined;
    if (!resolvedBvid && url) {
      resolvedBvid = extractBvidFromText(url) || await this.videoService.resolveBvid(url);
    }
    if (!resolvedBvid && !aid) {
      throw new BridgeError('链接中没有找到 BV 号', {
        kind: 'INPUT', code: 400, retcode: 1400,
        wording: url ? '链接中未找到 BV 号，请提供 BV 号或完整视频地址' : '需要 bvid 或 aid'
      });
    }
    const context = await this.videoService.context({
      bvid: resolvedBvid || undefined,
      aid,
      cid,
      includeSubtitles: includeSubtitles !== false,
      download: download !== false
    });
    if (includeComments) {
      try {
        const result = await this.commentService.list({
          oid: context.aid,
          bvid: context.bvid,
          ps: 5,
          order: 'hot'
        });
        context.comments = result.replies.slice(0, 5).map((reply) => ({
          rpid: reply.rpid,
          mid: reply.mid,
          uname: reply.uname,
          message: reply.message,
          like: reply.like,
          ctime: reply.ctime
        }));
      } catch (error) {
        context.comments = [];
        context.commentsError = String(error?.wording || error?.message || error);
      }
    }
    return context;
  }

  async inspectUser({ mid, includeVideos = false, includeDynamics = false } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    return this.videoService.inspectUser({ mid, includeVideos: includeVideos === true, includeDynamics: includeDynamics === true });
  }

  async replyComment({ oid, bvid, aid, message, text, root, parent, rootId, parentId } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const content = String(message ?? text ?? '').trim();
    if (!content) throw new BridgeError('评论内容为空', { kind: 'INPUT', code: 400, retcode: 1400 });
    if (Array.from(content).length > this.config.comment.maxChars) {
      throw new BridgeError(`评论不能超过 ${this.config.comment.maxChars} 字`, {
        kind: 'INPUT', code: 400, retcode: 1400,
        wording: `B 站评论不能超过 ${this.config.comment.maxChars} 字，请缩短后再试`
      });
    }
    return this.commentQueue.enqueue(() => this.commentService.add({
      oid,
      bvid,
      aid,
      message: content,
      root: root ?? rootId ?? '0',
      parent: parent ?? parentId ?? '0'
    }));
  }

  async likeComment({ oid, bvid, aid, rpid, commentId, action = 1 } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const target = rpid ?? commentId;
    const value = action === 0 || action === '0' || String(action).toLowerCase() === 'unlike' ? 0 : 1;
    if (target !== undefined && target !== null && String(target).trim() !== '') {
      return this.commentService.like({ oid, bvid, aid, rpid: target, action: value });
    }
    return this.videoService.likeVideo({ bvid, aid, like: value });
  }

  async sendLiveDanmaku({ roomId, text } = {}) {
    if (!this.auth.loggedIn) throw new AuthRequiredError();
    const message = truncateChars(String(text || '').trim(), 20);
    if (!message) throw new BridgeError('弹幕内容为空', { kind: 'INPUT', code: 400, retcode: 1400 });
    return this.liveQueue.enqueue(() => this.liveService.sendDanmaku({ roomId, text: message }));
  }
}
