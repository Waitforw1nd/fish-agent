import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { randomHex, sha256 } from '../util.js';

const ALG = 'aes-256-gcm';
const VERSION = 1;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function secretError(message, cause, code = 500) {
  return new BridgeError(message, { kind: 'SECRETS', code, retcode: 1500, cause });
}

function parseKeyMaterial(raw, source) {
  const text = String(raw ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  try {
    const buf = Buffer.from(text, 'base64');
    if (buf.length === 32) return buf;
  } catch { /* ignore */ }
  throw secretError(`${source} 中的密钥格式无效（需要 32 字节 hex 或 base64）`);
}

async function atomicWrite(file, mode, body) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomHex(4)}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tmp, 'w', mode);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } catch (error) {
    try { if (handle) await handle.close(); } catch { /* ignore */ }
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw error;
  }
}

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 加密持久化：AES-256-GCM + 随机 IV + 按条目 AAD（重放/改名会解密失败）。
 * 密钥来自显式 key、口令 scrypt，或数据目录下自动生成的 32 字节随机文件。
 * 明文永远不落盘；管理 API 也不读取这里的值。
 */
export class SecretStore {
  constructor({ dir, keyPath, saltPath, passphrase = '', key = null, aadPrefix = 'bili-bridge', now = Date.now, logger = null }) {
    if (!dir) throw new TypeError('SecretStore 需要 dir');
    this.dir = path.resolve(dir);
    this.keyPath = path.resolve(keyPath || path.join(this.dir, 'secret.key'));
    this.saltPath = path.resolve(saltPath || path.join(this.dir, 'secret.salt'));
    this.passphrase = String(passphrase || '');
    this.explicitKey = key;
    this.aadPrefix = String(aadPrefix || 'bili-bridge');
    this.now = now;
    this.logger = logger;
    this.key = null;
    this.fingerprint = '';
    this.#queue = Promise.resolve();
  }

  #queue;

  static async open(options) {
    const store = new SecretStore(options);
    await store.#init();
    return store;
  }

  async #init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (this.explicitKey) {
      this.key = Buffer.isBuffer(this.explicitKey)
        ? Buffer.from(this.explicitKey)
        : parseKeyMaterial(this.explicitKey, '显式密钥');
      if (this.key.length !== 32) throw secretError('显式密钥必须是 32 字节');
    } else if (this.passphrase) {
      let saltText = await readIfExists(this.saltPath);
      if (!saltText) {
        saltText = randomHex(16);
        await atomicWrite(this.saltPath, 0o600, `${saltText}\n`);
      }
      const salt = Buffer.from(saltText.trim(), 'hex');
      this.key = crypto.scryptSync(this.passphrase, salt, 32);
    } else {
      const existing = await readIfExists(this.keyPath);
      if (existing) {
        this.key = parseKeyMaterial(existing, '密钥文件');
      } else {
        this.key = crypto.randomBytes(32);
        await atomicWrite(this.keyPath, 0o600, `${this.key.toString('hex')}\n`);
      }
    }
    this.fingerprint = sha256(this.key).slice(0, 16);
  }

  #file(name) {
    if (!NAME_RE.test(String(name || ''))) throw secretError(`非法的密钥条目名: ${name}`, null, 400);
    return path.join(this.dir, `${name}.enc.json`);
  }

  #aad(name) {
    return Buffer.from(`${this.aadPrefix}:${name}`, 'utf8');
  }

  async save(name, value) {
    const file = this.#file(name);
    const run = this.#queue.then(async () => {
      const aad = this.#aad(name);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALG, this.key, iv);
      cipher.setAAD(aad);
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload = {
        v: VERSION,
        alg: ALG,
        name,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: ciphertext.toString('base64'),
        updatedAt: this.now()
      };
      await atomicWrite(file, 0o600, `${JSON.stringify(payload)}\n`);
      return true;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async load(name) {
    const file = this.#file(name);
    const run = this.#queue.then(async () => {
      const text = await readIfExists(file);
      if (text == null) return null;
      let payload;
      try { payload = JSON.parse(text); } catch (error) {
        throw secretError('加密凭据文件损坏', error);
      }
      if (payload?.v !== VERSION || payload?.alg !== ALG || payload?.name !== name) {
        throw secretError('加密凭据文件版本或条目不匹配');
      }
      try {
        const decipher = crypto.createDecipheriv(ALG, this.key, Buffer.from(payload.iv, 'base64'));
        decipher.setAAD(this.#aad(name));
        decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(payload.data, 'base64')),
          decipher.final()
        ]);
        return JSON.parse(plaintext.toString('utf8'));
      } catch (error) {
        // GCM 失败可能是篡改，也可能是换了密钥；对外不暴露底层细节。
        throw secretError('无法解密凭据（密钥不匹配或文件被篡改）', error);
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async delete(name) {
    const file = this.#file(name);
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw secretError(`删除凭据失败: ${name}`, error);
    }
  }

  async list() {
    let entries;
    try { entries = await fs.readdir(this.dir); } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw secretError('读取凭据目录失败', error);
    }
    return entries
      .filter((name) => name.endsWith('.enc.json') && !name.startsWith('.'))
      .map((name) => name.slice(0, -'.enc.json'.length))
      .sort();
  }
}
