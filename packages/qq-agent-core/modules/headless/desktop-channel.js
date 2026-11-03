import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { OneBotClient } from '../../src/onebot.js';

const USER_START = 7459086882832384n, USER_SIZE = 140737488355328n;
const equal = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); };
const frame = (op, d, extra = {}) => JSON.stringify({ v: 1, op, ts: Date.now(), ...extra, d });
const send = (ws, data) => { if (ws.readyState === 1) ws.send(data, () => {}); };

export class DesktopChannelClient extends OneBotClient {
  constructor({ server, token, onEvent, dataDir }) {
    super({ platform: 'desktop', onEvent, selfNickname: '养鱼Bot' });
    this.server = server; this.token = token; this.users = new Map(); this.identities = new Map(); this.sockets = new Set(); this.selfInfo = { user_id: '7318349394477056', nickname: '养鱼Bot' };
    this.file = dataDir ? path.join(dataDir, 'desktop-outbox.json') : null;
    if (this.file) {
      try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid state'); for (const [id, u] of Object.entries(saved)) { if (!/^\d{16}$/.test(id) || !u || !Number.isSafeInteger(u.seq) || u.seq < 0 || !Array.isArray(u.outbox) || !Array.isArray(u.seen) || (u.epoch !== undefined && (typeof u.epoch !== 'string' || !u.epoch)) || (u.inputSeq !== undefined && (!Number.isSafeInteger(u.inputSeq) || u.inputSeq < 0)) || (u.inputs !== undefined && !Array.isArray(u.inputs))) throw new Error('invalid state'); let last = 0; for (const item of u.outbox) { if (!Number.isSafeInteger(item?.seq) || (last && item.seq !== last + 1) || item.seq <= last || item.seq > u.seq || item.op !== 'msg.push') throw new Error('invalid outbox'); last = item.seq; } if (last && last !== u.seq) throw new Error('invalid outbox tail'); last = 0; for (const item of u.inputs || []) { if (!Number.isSafeInteger(item?.inputSeq) || (last && item.inputSeq !== last + 1) || item.inputSeq <= last || item.inputSeq > (u.inputSeq || 0) || item.op !== 'input.push') throw new Error('invalid inputs'); last = item.inputSeq; } if (last && last !== u.inputSeq) throw new Error('invalid input tail'); if (u.seen.some(x => !Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string')) throw new Error('invalid receipt'); this.users.set(id, { seq: u.seq || 0, outbox: (u.outbox || []).filter(x => x.ts > Date.now() - 86400000).slice(-200), seen: new Map(u.seen || []), epoch: u.epoch || randomUUID(), inputSeq: u.inputSeq || 0, inputs: (u.inputs || []).filter(x => x.ts > Date.now() - 86400000).slice(-200), sockets: new Set() }); } }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read desktop outbox', { cause: error }); }
    }
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const saved = Object.fromEntries([...this.users].map(([id, u]) => [id, { seq: u.seq, outbox: u.outbox, seen: [...u.seen].slice(-1000), epoch: u.epoch, inputSeq: u.inputSeq, inputs: u.inputs }])); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(tmp, this.file);
    // A later successful write also commits any inputs whose original write failed.
    for (const user of this.users.values()) {
      if (!user.dirtyInputs?.size) continue;
      for (const input of user.dirtyInputs.values()) for (const peer of user.sockets) if (peer.desktopCapabilities?.has('input-history.v1')) send(peer, JSON.stringify(input));
      user.dirtyInputs.clear();
    }
  }
  ownsMessage(user, id) {
    const value = String(id || '');
    return [...user.seen.values()].includes(value) || user.outbox.some(m => String(m.d?.messageId) === value);
  }
  validateSegments(user, segments) {
    if (!Array.isArray(segments) || !segments.length || segments.length > 32) return false;
    return segments.every(seg => {
      const d = seg?.data;
      if (!d || typeof d !== 'object') return false;
      if (seg.type === 'text') return typeof d.text === 'string' && d.text.length <= 10000;
      if (seg.type === 'face') return /^\d{1,8}$/.test(String(d.id ?? ''));
      if (seg.type === 'reply') return this.ownsMessage(user, d.id);
      if (seg.type === 'image') {
        const value = String(d.file || '');
        const match = /^(?:base64:[/][/]|data:image[/](?:png|jpeg|gif|webp);base64,)([A-Za-z0-9+\/]+={0,2})$/.exec(value);
        if (!match || match[1].length > Math.ceil(2 * 1024 * 1024 / 3) * 4) return false;
        const bytes = Buffer.from(match[1], 'base64');
        if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== match[1]) return false;
        return (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG') || (bytes[0] === 0xff && bytes[1] === 0xd8) || bytes.subarray(0, 6).toString().startsWith('GIF8') || (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
      }
      return false;
    });
  }
  async sendText(kind, id, text, options = {}) {
    if (kind !== 'private' || options.atUserId) throw new Error('Unsupported desktop target');
    const segments = [];
    if (options.replyToMessageId) segments.push({ type: 'reply', data: { id: String(options.replyToMessageId) } });
    segments.push({ type: 'text', data: { text: String(text ?? '') } });
    return this.call('send_private_msg', { user_id: id, message: segments });
  }
  async connect() {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
    this.upgrade = (req, socket, head) => {
      let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return; }
      if (pathname !== '/channels/desktop/ws') return;
      const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const device = String(req.headers['x-fish-device-id'] || ''); const identity = String(req.headers['x-fish-desktop-user'] || '');
      if (!['127.0.0.1', '::1'].includes(remote) || !equal(req.headers['x-console-token'], this.token()) || !/^[\w-]{1,128}$/.test(device) || !/^[\w@.:-]{1,128}$/.test(identity)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      if (!/^\d{16}$/.test(identity) || BigInt(identity) < USER_START || BigInt(identity) >= USER_START + USER_SIZE) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
      const id = identity;
      if (this.identities.has(id) && this.identities.get(id) !== identity) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
      this.identities.set(id, identity);
      this.wss.handleUpgrade(req, socket, head, ws => this.bind(ws, id, device));
    };
    this.server.on('upgrade', this.upgrade); this.connected = this.everConnected = true;
    for (const fn of this.statusListeners) fn({ connected: true, everConnected: true });
  }
  bind(ws, id, device) {
    const user = this.users.get(id) || { seq: 0, outbox: [], seen: new Map(), epoch: randomUUID(), inputSeq: 0, inputs: [], sockets: new Set() }; this.users.set(id, user); this.sockets.add(ws);
    let ready = false, capabilities = new Set(), aliveAt = Date.now(); const heartbeat = setInterval(() => { if (Date.now() - aliveAt > 90000) ws.terminate(); else if (ws.readyState === 1) ws.send(frame('ping', {})); }, 30000); heartbeat.unref?.(); const timer = setTimeout(() => ws.close(1008, 'hello required'), 10000);
    ws.on('close', () => { clearTimeout(timer); clearInterval(heartbeat); user.sockets.delete(ws); this.sockets.delete(ws); });
    ws.on('error', () => {});
    const receive = async (raw, binary) => {
      if (binary) return ws.close(1003, 'text frames required');
      let msg; try { msg = JSON.parse(raw); } catch { return ws.close(1007, 'invalid JSON'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.v !== 1 || typeof msg.op !== 'string') return ws.close(1008, 'invalid envelope');
      if (!ready) {
        if (msg.op !== 'hello' || (msg.d?.deviceId && msg.d.deviceId !== device)) return ws.close(1008, 'invalid hello');
        const seq = msg.d?.resumeSeq ?? 0;
        capabilities = new Set(Array.isArray(msg.d?.capabilities) ? msg.d.capabilities.filter(x => typeof x === 'string') : []);
        const recovery = capabilities.has('recovery.v1');
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > user.seq || (recovery && msg.d?.epoch && msg.d.epoch !== user.epoch)) {
          if (recovery) send(ws, frame('error', { code: 'RESUME_INVALID', message: 'resume state is invalid' }));
          return ws.close(1008, 'invalid resume sequence');
        }
        const inputSeq = msg.d?.inputResumeSeq ?? 0;
        if (capabilities.has('input-history.v1') && (!Number.isSafeInteger(inputSeq) || inputSeq < 0 || inputSeq > user.inputSeq)) {
          send(ws, frame('error', { code: 'RESUME_INVALID', message: 'resume state is invalid' })); return ws.close(1008, 'invalid resume sequence');
        }
        this.persist();
        ready = true; clearTimeout(timer); user.outbox = user.outbox.filter(x => x.ts > Date.now() - 86400000);
        user.inputs = user.inputs.filter(x => x.ts > Date.now() - 86400000);
        const replay = user.outbox.filter(x => x.seq > seq).sort((a, b) => a.seq - b.seq);
        const oldestSeq = user.outbox[0]?.seq ?? user.seq + 1;
        const info = { epoch: user.epoch, serverSeq: user.seq, oldestSeq, replayFrom: replay[0]?.seq ?? user.seq + 1, replayTo: user.seq, hasGap: seq < user.seq && seq + 1 < oldestSeq };
        const inputReplay = user.inputs.filter(x => x.inputSeq > inputSeq).sort((a, b) => a.inputSeq - b.inputSeq);
        const inputOldestSeq = user.inputs[0]?.inputSeq ?? user.inputSeq + 1;
        const inputInfo = { epoch: user.epoch, inputServerSeq: user.inputSeq, inputOldestSeq, inputReplayFrom: inputReplay[0]?.inputSeq ?? user.inputSeq + 1, inputReplayTo: user.inputSeq, inputHasGap: inputSeq < user.inputSeq && inputSeq + 1 < inputOldestSeq };
        send(ws, frame('ready', { selfName: '养鱼Bot', aiLabel: 'AI 生成', replay: [], serverSeq: user.seq, ...(capabilities.size ? { capabilities: ['recovery.v1', 'receipt.v1', 'input-history.v1'].filter(x => capabilities.has(x)) } : {}), ...(recovery ? info : {}), ...(capabilities.has('input-history.v1') ? inputInfo : {}), ...(capabilities.has('receipt.v1') ? { receiptRetention: { maxEntries: 1000, scope: 'user', eviction: 'oldest', unknownMeans: 'not_retained', noTimeGuarantee: true } } : {}) }));
        for (const push of replay) send(ws, JSON.stringify(push));
        if (recovery) send(ws, frame('replay.end', info));
        if (capabilities.has('input-history.v1')) { for (const input of inputReplay) send(ws, JSON.stringify(input)); send(ws, frame('input.replay.end', inputInfo)); }
        ws.desktopCapabilities = capabilities; user.sockets.add(ws); return;
      }
      aliveAt = Date.now();
      if (msg.op === 'pong') return;
      if (msg.op === 'ping') return ws.send(frame('pong', {}));
      if (msg.op === 'pet.poke') { await this.onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: id, target_id: this.selfId, self_id: this.selfId, time: Math.floor(Date.now()/1000) }); return; }
      if (msg.op === 'msg.status' && capabilities.has('receipt.v1') && typeof msg.id === 'string' && /^[\w.-]{1,128}$/.test(msg.id)) {
        const key = device + ':' + msg.id; const messageId = user.dirtyInputs?.has(key) ? undefined : user.seen.get(key);
        if (!messageId && user.pending?.has(key)) user.pending.get(key).add(ws);
        return send(ws, frame('msg.status', { id: msg.id, status: messageId ? 'accepted' : user.pending?.has(key) ? 'in_progress' : 'unknown', ...(messageId ? { messageId } : {}) }));
      }
      if (msg.op !== 'msg.send' || typeof msg.id !== 'string' || !/^[\w.-]{1,128}$/.test(msg.id)) return send(ws, frame('error', { ...(typeof msg.id === 'string' ? { id: msg.id } : {}), code: 'INVALID_MESSAGE', message: 'invalid message' }));
      const dedupe = device + ':' + msg.id;
      if (user.seen.has(dedupe)) { this.persist(); return send(ws, frame('msg.ack', { id: msg.id, messageId: user.seen.get(dedupe) })); }
      const segments = msg.d?.segments;
      if (!this.validateSegments(user, segments)) return send(ws, frame('error', { id: msg.id, code: 'INVALID_SEGMENTS', message: 'invalid or unsafe segments' }));
      if (!user.pending) user.pending = new Map();
      if (user.pending.has(dedupe)) { user.pending.get(dedupe).add(ws); return send(ws, frame('error', { id: msg.id, code: 'IN_PROGRESS', message: 'message is being processed' })); }
      const pendingBytes = Buffer.byteLength(raw);
      if (user.pending.size >= 100 || (user.pendingBytes || 0) + pendingBytes > 8 * 1024 * 1024) return send(ws, frame('error', { id: msg.id, code: 'INGEST_FAILED', message: 'message was not accepted' }));
      user.pending.set(dedupe, new Set([ws])); user.pendingBytes = (user.pendingBytes || 0) + pendingBytes;
      // Serialize a user's inputs so the preflight sequence is the exact sequence persisted.
      const previous = user.inputTurn || Promise.resolve();
      let release; const turn = new Promise(resolve => { release = resolve; }); user.inputTurn = turn;
      await previous;
      try {
        const mid = 'desktop-' + createHash('sha256').update(id + ':' + dedupe).digest('hex');
        const input = { v: 1, op: 'input.push', inputSeq: user.inputSeq + 1, ts: Date.now(), d: { messageId: mid, segments, deviceId: device, clientMessageId: msg.id } };
        if (Buffer.byteLength(JSON.stringify(input)) > 3 * 1024 * 1024) {
          const waiters = user.pending.get(dedupe); user.pending.delete(dedupe);
          for (const peer of waiters) send(peer, frame('error', { id: msg.id, code: 'INVALID_SEGMENTS', message: 'invalid or unsafe segments' }));
          return;
        }
        try {
          const accepted = await this.onEvent({ post_type: 'message', message_type: 'private', user_id: id, sender: { user_id: id, nickname: id }, self_id: this.selfId, message_id: mid, time: Math.floor(Date.now()/1000), message: segments });
          if (accepted === false) throw new Error('message rejected');
          user.seen.set(dedupe, mid); if (user.seen.size > 1000) user.seen.delete(user.seen.keys().next().value);
          user.inputSeq++; user.inputs = [...user.inputs.filter(x => x.ts > Date.now() - 86400000), input].slice(-200);
          try { this.persist(); } catch (error) { (user.dirtyInputs ||= new Map()).set(dedupe, input); throw error; }
          for (const other of user.sockets) if (other.desktopCapabilities?.has('input-history.v1')) send(other, JSON.stringify(input));
        } catch { const waiters = user.pending.get(dedupe); user.pending.delete(dedupe); for (const peer of waiters) send(peer, frame('error', { id: msg.id, code: 'INGEST_FAILED', message: 'message acceptance could not be confirmed' })); return; }
        const waiters = user.pending.get(dedupe); user.pending.delete(dedupe);
        for (const peer of waiters) send(peer, frame('msg.ack', { id: msg.id, messageId: mid }));
        for (const other of user.sockets) if (other !== ws && !other.desktopCapabilities?.has('input-history.v1')) send(other, frame('msg.echo', { messageId: mid, segments }));
      } finally { user.pendingBytes -= pendingBytes; release(); if (user.inputTurn === turn) user.inputTurn = null; }
    };
    ws.on('message', (raw, binary) => { void receive(raw, binary).catch(() => ws.close(1011, 'desktop processing failed')); });
  }
  setState(id, mood) {
    const user = this.users.get(String(id));
    if (!user) return;
    for (const ws of user.sockets) if (ws.readyState === 1) ws.send(frame('state', { mood }));
  }
  async call(action, params = {}) {
    if (action === 'get_login_info') return this.selfInfo;
    if (action === 'get_stranger_info') {
      if (String(params.user_id) !== String(this.selfId)) throw new Error('Desktop identity is not available');
      return { user_id: this.selfId, nickname: this.selfNickname };
    }
    if (action === 'get_status') return { online: true, good: true };
    if (action === 'get_version_info') return { app_name: 'fish-desktop', app_version: '1' };
    if (!['send_private_msg', 'send_msg'].includes(action)) throw new Error(`Desktop action ${action} is unsupported`);
    const user = this.users.get(String(params.user_id)); if (!user) throw new Error('Unknown desktop user');
    const segments = Array.isArray(params.message) ? params.message : [{ type: 'text', data: { text: String(params.message || '') } }];
    if (!this.validateSegments(user, segments)) throw new Error('Invalid or unsafe desktop segments');
    const mid = randomUUID(), seq = user.seq + 1, ts = Date.now();
    const push = { v: 1, op: 'msg.push', seq, ts, d: { messageId: mid, segments, aiLabel: true } };
    if (Buffer.byteLength(JSON.stringify(push)) > 3 * 1024 * 1024) throw new Error('Desktop message is too large');
    const previous = { seq: user.seq, outbox: user.outbox };
    user.seq = seq; user.outbox = [...user.outbox.filter(x => x.ts > ts - 86400000), push].slice(-200);
    try { this.persist(); } catch (error) { Object.assign(user, previous); throw error; }
    for (const ws of user.sockets) if (ws.readyState === 1) ws.send(JSON.stringify(push));
    return { message_id: mid };
  }
  close() { if (this.upgrade) this.server.off('upgrade', this.upgrade); for (const ws of this.sockets) ws.close(); this.wss?.close(); this.wss = null; this.connected = false; }
}
