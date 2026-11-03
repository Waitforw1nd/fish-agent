import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);let electron;
try{electron=require('electron');}catch{electron=require('../../qq-agent-core/node_modules/electron');}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'fish-pet-smoke-'));
const profile=path.join(output,'profile');fs.mkdirSync(profile);
const env={...process.env,FISH_DESKTOP_DEV:'1',FISH_PET_DATA_DIR:profile,FISH_PET_SMOKE_OUTPUT:output,FISH_PET_SMOKE_COMPAT:process.argv.includes('--compat')?'1':'0'};
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[path.join(root,'test/fixtures/electron-smoke.cjs')],{stdio:'inherit',windowsHide:true,env});
let timeout=false;
const timer=setTimeout(()=>{timeout=true;if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill('SIGKILL');},30000);
child.on('error',error=>{console.error(error.message);clearTimeout(timer);process.exitCode=1;});
child.on('exit',code=>{
  clearTimeout(timer);
  // Remove only the profile created under this run's verified temporary root.
  if(path.dirname(output)===path.resolve(os.tmpdir())&&path.basename(output).startsWith('fish-pet-smoke-'))try{fs.rmSync(profile,{recursive:true,force:true});}catch{console.error('Temporary profile retained:',profile);}
  console.log('Smoke artifacts:',output);
  let report;try{report=JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8'));}catch{}
  process.exitCode=!timeout&&code===0&&report?.result==='PASS'?0:1;
});
