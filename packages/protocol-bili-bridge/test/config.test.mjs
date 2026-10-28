import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, defaultConfig } from '../src/config.js';
import { tempDir } from './support/helpers.mjs';

test('默认配置只绑定回环，端口/端点可覆盖', async () => {
  const dataDir = await tempDir();
  const config = loadConfig({ env: { BILI_BRIDGE_DATA_DIR: dataDir } });
  assert.equal(config.onebot.host, '127.0.0.1');
  assert.equal(config.onebot.port, 36501);
  assert.equal(config.onebot.token, '');
  assert.equal(config.bili.forceHttps, true);
  assert.equal(config.subscriptions.at, true);
  assert.equal(defaultConfig().onebot.host, '127.0.0.1');

  const overridden = loadConfig({
    env: {
      BILI_BRIDGE_DATA_DIR: dataDir,
      BILI_ONEBOT_HOST: '127.0.0.1',
      BILI_ONEBOT_PORT: '0',
      BILI_ONEBOT_TOKEN: 'onebot-token-1',
      BILI_ADMIN_TOKEN: 'admin-token-123',
      BILI_ENDPOINT_API: 'http://127.0.0.1:9999/api/',
      BILI_WATCH_VIDEOS: 'BV1xx411c7mD, av170001',
      BILI_WATCH_UPS: '10086,20002',
      BILI_WATCH_LIVE_ROOMS: '9001',
      BILI_SUBSCRIBE_AT: 'false'
    }
  });
  assert.equal(overridden.onebot.port, 0);
  assert.equal(overridden.onebot.token, 'onebot-token-1');
  assert.equal(overridden.endpoints.api, 'http://127.0.0.1:9999/api');
  assert.deepEqual(overridden.watch.videos, ['BV1xx411c7mD', 'av170001']);
  assert.deepEqual(overridden.watch.ups, ['10086', '20002']);
  assert.deepEqual(overridden.watch.liveRooms, ['9001']);
  assert.equal(overridden.subscriptions.at, false);
});

test('非回环绑定必须配置 OneBot/管理令牌，且令牌不能相同', async () => {
  const dataDir = await tempDir();
  assert.throws(
    () => loadConfig({ env: { BILI_BRIDGE_DATA_DIR: dataDir, BILI_ONEBOT_HOST: '0.0.0.0' } }),
    /BILI_ONEBOT_TOKEN/
  );
  assert.throws(
    () => loadConfig({
      env: {
        BILI_BRIDGE_DATA_DIR: dataDir,
        BILI_ONEBOT_HOST: '0.0.0.0',
        BILI_ONEBOT_TOKEN: 'onebot-token-1'
      }
    }),
    /BILI_ADMIN_TOKEN/
  );
  assert.throws(
    () => loadConfig({
      env: {
        BILI_BRIDGE_DATA_DIR: dataDir,
        BILI_ONEBOT_TOKEN: 'same-token-123',
        BILI_ADMIN_TOKEN: 'same-token-123'
      }
    }),
    /必须不同/
  );
  assert.throws(
    () => loadConfig({
      env: {
        BILI_BRIDGE_DATA_DIR: dataDir,
        BILI_ADMIN_TOKEN: 'short'
      }
    }),
    /至少 12/
  );
  assert.doesNotThrow(() => loadConfig({
    env: {
      BILI_BRIDGE_DATA_DIR: dataDir,
      BILI_ONEBOT_HOST: '0.0.0.0',
      BILI_ONEBOT_TOKEN: 'onebot-token-1',
      BILI_ADMIN_TOKEN: 'admin-token-123'
    }
  }));
});
