import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { placeholderPng } from '../scripts/generate-placeholder.mjs';
import { assertReleaseRuntime } from '../scripts/check-runtime.mjs';

test('shipped character assets are exactly the two reproducible geometric PNGs', () => {
  const root=new URL('../resources/pets/',import.meta.url);
  assert.deepEqual(fs.readdirSync(root).sort(),['placeholder','placeholder-alt']);
  for(const [name,alt] of [['placeholder',false],['placeholder-alt',true]]) {
    const dir=new URL(name+'/',root);assert.deepEqual(fs.readdirSync(dir).sort(),['LICENSE.txt','idle.png','manifest.json']);
    assert.deepEqual(fs.readFileSync(new URL('idle.png',dir)),placeholderPng(alt));
    const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',dir),'utf8'));
    assert.equal(manifest.license.id,'LicenseRef-Fish-Owned');assert.equal(manifest.license.file,'LICENSE.txt');
  }
});

test('code attribution and the original MIT notice are included in distributable files', () => {
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const file of ['licenses/**/*','THIRD_PARTY_NOTICES.md','resources/**/*']) assert.ok(pkg.build.files.includes(file));
  const license=fs.readFileSync(new URL('../licenses/dsh-pet-MIT.txt',import.meta.url));
  // Checked against the local upstream snapshot's LICENSE at commit 3229ab2.
  assert.equal(createHash('sha256').update(license).digest('hex'),'22757dc9c895b2729a2fc684d227cadfb54d5af3dd300029926839e8c4e269ce');
  const notice=fs.readFileSync(new URL('../THIRD_PARTY_NOTICES.md',import.meta.url),'utf8');
  assert.ok(notice.includes('https://github.com/PC2005-cloud/dsh-pet'));assert.ok(notice.includes('3229ab287d82d7621af2ee51544a0e746c2e40fd'));
});

test('packaging blocks the unsupported runtime and prereleases instead of silently accepting them', () => {
  const lock=version=>({packages:{'node_modules/electron':{version}}});
  for(const version of ['33.4.11','42.0.0','45.0.0-beta.1',undefined]) assert.throws(()=>assertReleaseRuntime(lock(version)),/禁止打包/);
  assert.equal(assertReleaseRuntime(lock('45.0.0')),'45.0.0');
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.predist,'node scripts/check-runtime.mjs');
});
