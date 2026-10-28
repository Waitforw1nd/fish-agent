#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BiliBridge } from './bridge.js';
import { loadConfig } from './config.js';
import { createLogger } from './obs/log.js';
import { redactText } from './util.js';

async function writeReadyFile(file, payload) {
  if (!file) return;
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function main({ env = process.env } = {}) {
  const config = loadConfig({ env });
  // stdout 只保留一行 ready JSON；日志统一走 stderr，方便编排器解析。
  const logger = createLogger({
    level: config.logLevel,
    sink: {
      log: (...args) => console.error(...args),
      warn: (...args) => console.error(...args),
      error: (...args) => console.error(...args)
    }
  });
  const bridge = new BiliBridge({ config, logger });
  await bridge.start();
  const address = bridge.server?.address;
  const ready = {
    event: 'ready',
    service: 'bili-bridge',
    tenantId: config.tenantId,
    host: address?.address || config.onebot.host,
    port: address?.port || 0,
    pid: process.pid,
    startedAt: bridge.startedAt,
    loggedIn: bridge.auth.loggedIn
  };
  const readyFile = env.BILI_BRIDGE_READY_FILE || '';
  await writeReadyFile(readyFile, ready);
  // 只输出一行机器可读的 ready；不打印 token/cookie。
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在停止 B 站桥接`);
    try {
      await bridge.stop();
      if (readyFile) await fs.unlink(path.resolve(readyFile)).catch(() => {});
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  return { bridge, config, ready };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${redactText(error?.stack || error?.message || String(error))}\n`);
    process.exitCode = 1;
  });
}
