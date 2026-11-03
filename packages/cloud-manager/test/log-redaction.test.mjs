import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/logger.js';
import { redactSecrets } from '../src/util.js';

test('QQBot credentials, device tokens and complete cookie/password values are absent from logs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-redaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manager.log');
  const logger = new Logger({ file });
  const secrets = ['fixture-official-access', 'fixture-bili-session', 'fixture-bili-csrf', 'fixture-refresh', 'private-cookie-tail', 'space password tail', 'fdt_' + 'Z'.repeat(43)];
  logger.write('error', 'fixture', [new Error('Authorization: QQBot ' + secrets[0]),
    { cookie: `sid=x; SESSDATA=${secrets[1]}; bili_jct=${secrets[2]}; other=${secrets[4]}`, password: secrets[5] },
    `refresh_token=${secrets[3]}`, `device credential ${secrets[6]}`]);
  const logged = fs.readFileSync(file, 'utf8');
  for (const secret of secrets) assert.equal(logged.includes(secret), false, secret);
  assert.match(logged, /\[redacted/);
  const header = redactSecrets('Cookie: foo=first-secret; bar=second-secret\nHTTP 401');
  assert.equal(header.includes('first-secret'), false);
  assert.equal(header.includes('second-secret'), false);
  assert.match(header, /HTTP 401/);
});
