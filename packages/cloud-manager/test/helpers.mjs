import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { CloudManager } from '../src/app.js';
import { reserveTestPortRange } from './port-pool.mjs';

export const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures');
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');

export function fixture(name) {
  return path.join(FIXTURES, name);
}

export async function makeConfig(extra = {}) {
  const pool = await reserveTestPortRange();
  let dataDir;
  try {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cloud-test-'));
  } catch (error) {
    await pool.release();
    throw error;
  }
  const env = {
    CLOUD_DATA_DIR: dataDir,
    CLOUD_HOST: '127.0.0.1',
    CLOUD_PORT: '0',
    CLOUD_RELAY_HOST: '127.0.0.1',
    CLOUD_RELAY_PORT: '0',
    CLOUD_BASE_DOMAIN: 'test.local',
    CLOUD_PUBLIC_SCHEME: 'http',
    CLOUD_COOKIE_SECURE: 'false',
    CLOUD_ADMIN_USERNAME: 'admin',
    CLOUD_ADMIN_PASSWORD: 'admin-password-123',
    CLOUD_AGENT_ENTRY: fixture('fake-agent.mjs'),
    CLOUD_LLBOT_ENTRY: fixture('fake-llbot.mjs'),
    CLOUD_NAPCAT_ENTRY: fixture('fake-qqproto.mjs'),
    CLOUD_SNOWLUMA_ENTRY: fixture('fake-qqproto.mjs'),
    CLOUD_BILI_BRIDGE_ENTRY: fixture('fake-bili.mjs'),
    CLOUD_PORT_RANGE_START: String(pool.start),
    CLOUD_PORT_RANGE_END: String(pool.end),
    CLOUD_PROCESS_START_TIMEOUT_MS: '8000',
    CLOUD_PROCESS_STOP_TIMEOUT_MS: '2000',
    CLOUD_CRASH_BACKOFF_MS: '100',
    CLOUD_CRASH_BACKOFF_MAX_MS: '1000',
    CLOUD_LOG_LEVEL: 'error',
    CLOUD_LOGIN_MAX_FAILURES: '20',
    CLOUD_EXPIRY_SWEEP_MS: '300'
  };
  try {
    const config = loadConfig(env, extra);
    return { config, dataDir, releasePorts: pool.release };
  } catch (error) {
    await pool.release();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

export async function startManager(extra = {}) {
  const { config, dataDir, releasePorts } = await makeConfig(extra);
  let manager;
  try {
    manager = new CloudManager({ config });
    await manager.start();
  } catch (error) {
    try { await manager?.stop(); } catch { /* ignore */ }
    await releasePorts();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  }
  return {
    manager,
    config,
    dataDir,
    async stop({ remove = true } = {}) {
      try { await manager.stop(); } catch { /* ignore */ }
      if (manager.stopped) await releasePorts();
      if (remove) {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  };
}

export function request(baseUrl, {
  method = 'GET', path: pathname = '/', headers = {}, body = null, timeoutMs = 15000, host = null
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path: pathname,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        host: host || url.host,
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class Client {
  constructor(baseUrl, { host = null, cookie = null, csrf = null } = {}) {
    this.baseUrl = baseUrl;
    this.host = host;
    this.cookie = cookie;
    this.csrf = csrf;
    this.user = null;
  }

  async call(pathname, { method = 'GET', body = null, headers = {}, csrf = true, timeoutMs = 20000 } = {}) {
    const sendHeaders = { ...headers };
    if (this.cookie) sendHeaders.cookie = this.cookie;
    if (csrf && this.csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) sendHeaders['x-csrf-token'] = this.csrf;
    const response = await request(this.baseUrl, {
      method, path: pathname, body, headers: sendHeaders, host: this.host, timeoutMs
    });
    if (response.setCookie?.length) {
      const match = /^[^=]+=[^;]*/.exec(response.setCookie[0]);
      if (match) this.cookie = match[0];
    }
    return response;
  }

  async login(username, password) {
    const response = await this.call('/api/auth/login', { method: 'POST', body: { username, password }, csrf: false });
    if (response.status === 200) {
      this.csrf = response.json.csrfToken;
      this.user = response.json.user;
    }
    return response;
  }

  async createTenant(payload) {
    const response = await this.call('/api/tenants', { method: 'POST', body: payload });
    return response;
  }

  async startTenant(id) {
    return this.call(`/api/tenants/${id}/start`, { method: 'POST' });
  }

  async getTenant(id) {
    return this.call(`/api/tenants/${id}`);
  }
}

export function tenantHost(config, slug) {
  return `${slug}.${config.baseDomain}:${config.panelPort}`;
}

export async function waitFor(fn, { timeoutMs = 8000, intervalMs = 80, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function loginAdmin(manager) {
  const base = `http://127.0.0.1:${manager.config.panelPort}`;
  const client = new Client(base);
  const response = await client.login('admin', 'admin-password-123');
  if (response.status !== 200) throw new Error(`admin login failed: ${response.status} ${response.text}`);
  return client;
}

export function makeDirectSse(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: pathname, method: 'GET',
      headers: { accept: 'text/event-stream', host: url.host, ...headers }
    }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}
