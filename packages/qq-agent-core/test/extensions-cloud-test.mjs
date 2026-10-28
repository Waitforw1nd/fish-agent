// 云环境扩展/遥测/社区默认开关测试：
//   · QQ_AGENT_SKILLS_DIR / QQ_AGENT_PLUGINS_DIR 租户扩展目录
//   · 云环境默认关闭热重载，可用 QQ_AGENT_HOT_RELOAD=1 显式打开
//   · QQ_AGENT_EXTENSIONS_ALLOW 白名单（名单外跳过并卸载）
//   · 云环境默认关闭遥测与社区屏蔽名单同步
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-cloud-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED = '1';
fs.mkdirSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true });

const writeSkill = (root, id, body = 'export function setup() {}\n') => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1 }));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  return dir;
};
const writePlugin = (root, id) => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, capabilities: ['env.test']
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), "export const providers = { 'env.test': () => true };\n");
  return dir;
};

const skillsA = path.join(tmp, 'skills-a');
const pluginsA = path.join(tmp, 'plugins-a');
fs.mkdirSync(skillsA, { recursive: true });
fs.mkdirSync(pluginsA, { recursive: true });
writeSkill(skillsA, 'allowed');
writeSkill(skillsA, 'denied');
writePlugin(pluginsA, 'env-plugin');

const {
  loadPlugins, resolveSkillRoots, isCloudMode, isHotReloadAllowed, watchPlugins
} = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const telemetry = await import('../src/telemetry.js');
const community = await import('../src/community.js');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}\n      ${error?.message ?? error}`); }
};
const withEnv = async (patch, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(patch)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

console.log('\n=== 租户扩展目录 env ===');
await check('resolveSkillRoots 使用 QQ_AGENT_SKILLS_DIR / QQ_AGENT_PLUGINS_DIR', async () => {
  await withEnv({ QQ_AGENT_SKILLS_DIR: skillsA, QQ_AGENT_PLUGINS_DIR: pluginsA }, async () => {
    const roots = resolveSkillRoots();
    assert.equal(path.resolve(roots.skills), path.resolve(skillsA));
    assert.equal(path.resolve(roots.plugins), path.resolve(pluginsA));
  });
});

await check('loadPlugins() 不传 roots 时从 env 目录加载', async () => {
  await withEnv({
    QQ_AGENT_SKILLS_DIR: skillsA,
    QQ_AGENT_PLUGINS_DIR: pluginsA,
    QQ_AGENT_EXTENSIONS_ALLOW: undefined
  }, async () => {
    const r = await loadPlugins({ log: () => {} });
    const ids = new Set(r.loaded.map((x) => x.id));
    assert.ok(ids.has('allowed'));
    assert.ok(ids.has('denied'));
    assert.ok(ids.has('env-plugin'), '插件目录 env 也应生效');
    for (const id of ['anti-ban-guard', 'trpg-dice-hook', 'bili-watcher', 'bili-agent-pack']) assert.ok(ids.has(id), `缺少包内扩展 ${id}`);
    assert.equal(skillManager.isEnabled('bili-watcher'), true, '新租户默认启用 B 站 watcher');
    assert.equal(path.resolve(r.dirs.skills), path.resolve(skillsA));
    assert.equal(path.resolve(r.dirs.plugins), path.resolve(pluginsA));
  });
});

console.log('\n=== 扩展白名单 ===');
await check('白名单外条目被跳过，且已加载的会被卸载', async () => {
  await withEnv({
    QQ_AGENT_SKILLS_DIR: skillsA,
    QQ_AGENT_PLUGINS_DIR: pluginsA,
    QQ_AGENT_EXTENSIONS_ALLOW: 'allowed'
  }, async () => {
    const r = await loadPlugins({ log: () => {} });
    assert.ok(r.skipped.some((s) => s.id === 'denied'));
    assert.ok(!r.loaded.some((x) => x.id === 'denied'));
    assert.equal(skillManager.isLoaded('denied'), false);
    assert.equal(skillManager.isLoaded('allowed'), true);
  });
});

console.log('\n=== 云默认：热重载 ===');
await check('云环境 + 未显式设置 → 热重载关闭', async () => {
  await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_HOT_RELOAD: undefined, QQ_AGENT_DEV: undefined }, async () => {
    assert.equal(isCloudMode(), true);
    assert.equal(isHotReloadAllowed(), false);
    const w = watchPlugins({ log: () => {}, roots: { skills: skillsA, plugins: pluginsA } });
    assert.equal(w, null);
  });
});

await check('QQ_AGENT_HOT_RELOAD=1 可显式打开云环境热重载', async () => {
  await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_HOT_RELOAD: '1', QQ_AGENT_DEV: undefined }, async () => {
    assert.equal(isHotReloadAllowed(), true);
    const w = watchPlugins({ log: () => {}, roots: { skills: skillsA, plugins: pluginsA } });
    assert.ok(w && typeof w.close === 'function');
    w.close();
  });
});

await check('桌面环境默认开启热重载', async () => {
  await withEnv({ QQ_AGENT_CLOUD: undefined, QQ_AGENT_DEPLOYMENT: undefined, QQ_AGENT_MULTI_TENANT: undefined, QQ_AGENT_HOT_RELOAD: undefined, QQ_AGENT_DEV: undefined }, async () => {
    assert.equal(isCloudMode(), false);
    assert.equal(isHotReloadAllowed(), true);
  });
});

console.log('\n=== 云默认：遥测 / 社区 ===');
await check('云环境默认关闭遥测与社区同步', async () => {
  await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_TELEMETRY: undefined, QQ_AGENT_COMMUNITY_SYNC: undefined }, async () => {
    assert.equal(telemetry.telemetryEnabled(), false);
    assert.equal(telemetry.startTelemetryLoop(() => {}), null);
    assert.equal(community.communitySyncEnabled(), false);
    const timer = community.startCommunitySync(() => {});
    // app.js 会调用 timer.unref?.()，所以禁用时必须返回哑句柄而不是 null
    assert.equal(typeof timer?.unref, 'function');
    assert.equal(timer.unref(), undefined);
  });
});

await check('显式 QQ_AGENT_TELEMETRY=1 可在云环境打开', async () => {
  await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_TELEMETRY: '1' }, async () => {
    assert.equal(telemetry.telemetryEnabled(), true);
  });
});

await check('显式 QQ_AGENT_COMMUNITY_SYNC=1 可在云环境打开', async () => {
  await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_COMMUNITY_SYNC: '1' }, async () => {
    assert.equal(community.communitySyncEnabled(), true);
  });
});

await check('禁用时 report / syncGlobalBlocklist 不发网络请求', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('不应发起网络请求'); };
  try {
    await withEnv({ QQ_AGENT_CLOUD: '1', QQ_AGENT_TELEMETRY: undefined, QQ_AGENT_COMMUNITY_SYNC: undefined }, async () => {
      await telemetry.report(() => {});
      await community.syncGlobalBlocklist({ pushLocal: false });
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n云环境扩展/遥测/社区：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
