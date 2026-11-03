import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Review baseline 2026-11-03: Electron 45 is current stable. Recheck the official
// support schedule before release; a floor is not a substitute for patch updates.
export const MIN_ELECTRON_MAJOR = 45;
export function assertReleaseRuntime(lock) {
  const version=lock?.packages?.['node_modules/electron']?.version;
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if(!match || Number(match[1])<MIN_ELECTRON_MAJOR) throw new Error(`禁止打包：请更新 Electron 及锁文件到受支持稳定版（本次审查基线 >= ${MIN_ELECTRON_MAJOR}），并完成原生安全验收。`);
  return version;
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  try {
    const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
    const version=assertReleaseRuntime(lock);
    const installed=JSON.parse(fs.readFileSync(path.join(root,'node_modules/electron/package.json'),'utf8')).version;
    if(installed!==version) throw new Error('Electron 安装版本与锁文件不一致，请使用 npm ci 重新安装。');
    console.log('Electron packaging version check passed: '+version);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
