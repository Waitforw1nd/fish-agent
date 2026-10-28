import http from 'node:http';
import zlib from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { buildPacket, parsePacketBuffer, OP_AUTH, OP_AUTH_REPLY, OP_HEARTBEAT, OP_HEARTBEAT_REPLY, OP_NOTIFICATION } from '../../src/bili/live.js';

function encodePopularity(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(Math.max(0, Number(value) || 0), 0);
  return buffer;
}

/**
 * fake 直播弹幕服务器：校验 auth token，回应心跳，按需发送明文/zlib/brotli 多子包。
 */
export class FakeDanmaku {
  constructor({ token = 'danmu-token-1', popularity = 12345, autoEvents = [], autoEncoding = 'brotli' } = {}) {
    this.token = token;
    this.popularity = popularity;
    this.autoEvents = autoEvents;
    this.autoEncoding = autoEncoding;
    this.httpServer = null;
    this.wss = null;
    this.port = 0;
    this.connections = 0;
    this.heartbeats = 0;
    this.auths = [];
    this.sockets = new Set();
    this.frames = [];
  }

  static async start(options = {}) {
    const fake = new FakeDanmaku(options);
    await fake.listen();
    return fake;
  }

  async listen() {
    this.httpServer = http.createServer((req, res) => {
      res.writeHead(404);
      res.end('danmaku ws only');
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => {
      this.connections += 1;
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('error', () => this.sockets.delete(ws));
      ws.on('message', (data) => this.#onMessage(ws, data));
      if (new URL(req.url || '/', 'http://localhost').pathname !== '/sub') {
        ws.close(4004, 'bad path');
      }
    });
    await new Promise((resolve) => this.httpServer.listen(0, '127.0.0.1', resolve));
    this.port = this.httpServer.address().port;
  }

  #onMessage(ws, data) {
    let packets;
    try {
      packets = parsePacketBuffer(Buffer.from(data));
    } catch {
      return;
    }
    for (const packet of packets) {
      if (packet.operation === OP_AUTH) {
        let auth = null;
        try { auth = JSON.parse(packet.body.toString('utf8')); } catch { auth = null; }
        this.auths.push(auth);
        if (!auth || auth.key !== this.token) {
          ws.send(buildPacket({ operation: OP_AUTH_REPLY, body: JSON.stringify({ code: -101 }) }));
          ws.close(4003, 'bad auth');
          return;
        }
        ws.send(buildPacket({ operation: OP_AUTH_REPLY, body: JSON.stringify({ code: 0 }) }));
        if (this.autoEvents.length) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) this.sendEvents(this.autoEvents, { encoding: this.autoEncoding, socket: ws });
          }, 5);
        }
      } else if (packet.operation === OP_HEARTBEAT) {
        this.heartbeats += 1;
        ws.send(buildPacket({ operation: OP_HEARTBEAT_REPLY, body: encodePopularity(this.popularity), version: 1 }));
      }
    }
  }

  sendEvents(events, { encoding = 'brotli', socket = null } = {}) {
    const target = socket || [...this.sockets].find((ws) => ws.readyState === WebSocket.OPEN);
    if (!target) return 0;
    const packets = (events || []).map((event) => buildPacket({
      operation: OP_NOTIFICATION,
      body: JSON.stringify(event),
      version: 0
    }));
    let frame;
    if (encoding === 'plain') {
      frame = Buffer.concat(packets);
    } else if (encoding === 'zlib') {
      const combined = Buffer.concat(packets);
      frame = buildPacket({ operation: OP_NOTIFICATION, body: zlib.deflateSync(combined), version: 2 });
    } else {
      const combined = Buffer.concat(packets);
      frame = buildPacket({ operation: OP_NOTIFICATION, body: zlib.brotliCompressSync(combined), version: 3 });
    }
    target.send(frame);
    this.frames.push({ at: Date.now(), encoding, count: packets.length });
    return packets.length;
  }

  sendPopularity(value) {
    const target = [...this.sockets].find((ws) => ws.readyState === WebSocket.OPEN);
    if (!target) return false;
    this.popularity = value;
    target.send(buildPacket({ operation: OP_HEARTBEAT_REPLY, body: encodePopularity(value), version: 1 }));
    return true;
  }

  dropClients() {
    let count = 0;
    for (const ws of this.sockets) {
      try { ws.terminate(); count += 1; } catch { /* ignore */ }
    }
    this.sockets.clear();
    return count;
  }

  async close() {
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    await new Promise((resolve) => {
      if (!this.wss) return resolve();
      try { this.wss.close(() => resolve()); } catch { resolve(); }
    });
    await new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      try {
        this.httpServer.close(() => resolve());
        this.httpServer.closeAllConnections?.();
      } catch { resolve(); }
    });
    this.wss = null;
    this.httpServer = null;
  }
}
