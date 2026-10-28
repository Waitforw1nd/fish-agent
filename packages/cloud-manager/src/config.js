import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampInt, ensureDir, parseBool } from './util.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

function readMasterKey(dataDir, env) {
  const raw = String(env.CLOUD_MASTER_KEY ?? '').trim();
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('CLOUD_MASTER_KEY must be 32 bytes (base64 or 64-char hex)');
    return key;
  }
  ensureDir(dataDir, 0o700);
  const keyPath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${keyPath} does not contain a 32-byte key`);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
  return key;
}

function defaultEntry(env, name, fallback) {
  return path.resolve(String(env[name] || fallback));
}

function resourceInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = path.resolve(String(env.CLOUD_DATA_DIR || path.join(REPO_ROOT, 'var', 'cloud')));
  const publicScheme = String(env.CLOUD_PUBLIC_SCHEME || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  const baseDomain = String(env.CLOUD_BASE_DOMAIN || 'localhost').trim().toLowerCase();
  const cookieDomainRaw = String(env.CLOUD_COOKIE_DOMAIN ?? '').trim().toLowerCase();
  const config = {
    packageRoot: PACKAGE_ROOT,
    repoRoot: REPO_ROOT,
    dataDir,
    tenantDir: path.join(dataDir, 'tenants'),
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    dbPath: path.join(dataDir, 'cloud.sqlite'),
    panelDir: path.join(PACKAGE_ROOT, 'panel'),
    panelHost: String(env.CLOUD_HOST || '0.0.0.0'),
    panelPort: clampInt(env.CLOUD_PORT ?? 8080, 0, 65535, 8080),
    relayHost: String(env.CLOUD_RELAY_HOST || '127.0.0.1'),
    relayPort: clampInt(env.CLOUD_RELAY_PORT ?? 8790, 0, 65535, 8790),
    baseDomain,
    publicScheme,
    publicOrigin: `${publicScheme}://${baseDomain}`,
    cookieName: String(env.CLOUD_COOKIE_NAME || 'fm_session'),
    cookieDomain: cookieDomainRaw || '',
    cookieSecure: parseBool(env.CLOUD_COOKIE_SECURE, publicScheme === 'https'),
    trustProxy: parseBool(env.CLOUD_TRUST_PROXY, false),
    sessionTtlMs: clampInt(env.CLOUD_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000),
    sessionTouchMs: 5 * 60 * 1000,
    sessionSweepMs: 10 * 60 * 1000,
    loginMaxFailures: clampInt(env.CLOUD_LOGIN_MAX_FAILURES ?? 5, 1, 50, 5),
    loginWindowMs: clampInt(env.CLOUD_LOGIN_WINDOW_MS ?? 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000, 15 * 60 * 1000),
    adminUsername: String(env.CLOUD_ADMIN_USERNAME || 'admin'),
    adminPassword: String(env.CLOUD_ADMIN_PASSWORD || ''),
    masterKey: readMasterKey(dataDir, env),
    portRangeStart: clampInt(env.CLOUD_PORT_RANGE_START ?? 31000, 1, 65535, 31000),
    portRangeEnd: clampInt(env.CLOUD_PORT_RANGE_END ?? 39999, 1, 65535, 39999),
    portLeaseTtlMs: clampInt(env.CLOUD_PORT_LEASE_TTL_MS ?? 60 * 60 * 1000, 10_000, 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
    processStopTimeoutMs: clampInt(env.CLOUD_PROCESS_STOP_TIMEOUT_MS ?? 6000, 500, 60_000, 6000),
    processStartTimeoutMs: clampInt(env.CLOUD_PROCESS_START_TIMEOUT_MS ?? 20_000, 1000, 120_000, 20_000),
    crashBackoffBaseMs: clampInt(env.CLOUD_CRASH_BACKOFF_MS ?? 1000, 20, 60_000, 1000),
    crashBackoffMaxMs: clampInt(env.CLOUD_CRASH_BACKOFF_MAX_MS ?? 60_000, 100, 600_000, 60_000),
    maxCrashRestarts: clampInt(env.CLOUD_MAX_CRASH_RESTARTS ?? 5, 0, 50, 5),
    agentEntry: defaultEntry(env, 'CLOUD_AGENT_ENTRY', path.join(REPO_ROOT, 'packages', 'qq-agent-core', 'modules', 'headless', 'server.js')),
    llbotEntry: defaultEntry(env, 'CLOUD_LLBOT_ENTRY', path.join(REPO_ROOT, 'packages', 'protocol-qq-llbot', 'dist', 'llbot.js')),
    llbotDesktopQqVersion: String(env.CLOUD_LLBOT_DESKTOP_QQ_VERSION || '').trim(),
    napcatEntry: String(env.CLOUD_NAPCAT_ENTRY || ''),
    napcatImage: String(env.CLOUD_NAPCAT_IMAGE || '').trim(),
    napcatMemoryMb: resourceInt(env, 'CLOUD_NAPCAT_MEMORY_MB', 2048, 256, 65536),
    napcatCpuMillis: resourceInt(env, 'CLOUD_NAPCAT_CPU_MILLIS', 2000, 100, 64000),
    napcatPids: resourceInt(env, 'CLOUD_NAPCAT_PIDS', 512, 64, 8192),
    napcatShmMb: resourceInt(env, 'CLOUD_NAPCAT_SHM_MB', 512, 64, 8192),
    napcatLogMb: resourceInt(env, 'CLOUD_NAPCAT_LOG_MB', 10, 1, 1024),
    napcatLogFiles: resourceInt(env, 'CLOUD_NAPCAT_LOG_FILES', 3, 1, 20),
    dockerPath: String(env.CLOUD_DOCKER_PATH || 'docker'),
    deploymentId: String(env.CLOUD_DEPLOYMENT_ID || 'fish-cloud'),
    defaultQqDriver: String(env.CLOUD_DEFAULT_QQ_DRIVER || 'napcat').toLowerCase(),
    snowlumaEntry: defaultEntry(env, 'CLOUD_SNOWLUMA_ENTRY', path.join(REPO_ROOT, 'packages', 'qq-agent-core', 'snowluma', 'index.mjs')),
    biliEntry: defaultEntry(env, 'CLOUD_BILI_BRIDGE_ENTRY', path.join(REPO_ROOT, 'packages', 'protocol-bili-bridge', 'src', 'main.js')),
    nodePath: String(env.CLOUD_NODE_PATH || process.execPath),
    upstreamBaseUrl: String(env.CLOUD_UPSTREAM_BASE_URL || '').replace(/\/+$/, ''),
    upstreamApiKey: String(env.CLOUD_UPSTREAM_API_KEY || ''),
    upstreamTimeoutMs: clampInt(env.CLOUD_UPSTREAM_TIMEOUT_MS ?? 120_000, 1000, 600_000, 120_000),
    relayMaxBodyBytes: clampInt(env.CLOUD_RELAY_MAX_BODY_BYTES ?? 8 * 1024 * 1024, 16 * 1024, 64 * 1024 * 1024, 8 * 1024 * 1024),
    apiMaxBodyBytes: clampInt(env.CLOUD_API_MAX_BODY_BYTES ?? 1024 * 1024, 4096, 16 * 1024 * 1024, 1024 * 1024),
    gatewayTimeoutMs: clampInt(env.CLOUD_GATEWAY_TIMEOUT_MS ?? 30_000, 1000, 300_000, 30_000),
    expirySweepMs: clampInt(env.CLOUD_EXPIRY_SWEEP_MS ?? 15_000, 100, 300_000, 15_000),
    backupMaxFileBytes: clampInt(env.CLOUD_BACKUP_MAX_FILE_BYTES ?? 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024, 64 * 1024 * 1024),
    backupMaxTotalBytes: clampInt(env.CLOUD_BACKUP_MAX_TOTAL_BYTES ?? 512 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024, 512 * 1024 * 1024),
    logLevel: String(env.CLOUD_LOG_LEVEL || 'info'),
    logMaxBytes: clampInt(env.CLOUD_LOG_MAX_BYTES ?? 5 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024, 5 * 1024 * 1024),
    defaultModel: String(env.CLOUD_DEFAULT_MODEL || 'deepseek-chat'),
    platformAuthToken: String(env.CLOUD_LLBOT_AUTH_TOKEN || ''),
    rateLimitWindowMs: 60_000,
    relayKeyPrefix: 'sk-fish-',
    upstreamModelsTtlMs: 5 * 60 * 1000,
    relayCustomAllowPrivate: parseBool(env.CLOUD_RELAY_CUSTOM_ALLOW_PRIVATE, false),
    qqDrivers: ['llbot', 'napcat', 'snowluma'],
    secureHeaders: true,
    devAllowAnyOrigin: parseBool(env.CLOUD_DEV_ALLOW_ANY_ORIGIN, false)
  };
  const merged = { ...config, ...overrides };
  ensureDir(merged.dataDir, 0o700);
  ensureDir(merged.tenantDir, 0o700);
  ensureDir(merged.backupDir, 0o700);
  ensureDir(merged.logDir, 0o700);
  return merged;
}
