import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
let electron;try{electron=require('electron');}catch{electron=require('../../qq-agent-core/node_modules/electron');}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(electron,[root,...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,env:{...process.env,FISH_DESKTOP_DEV:'1'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
