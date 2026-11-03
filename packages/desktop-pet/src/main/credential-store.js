import fs from 'node:fs';
import path from 'node:path';
import { secureStorageAvailable } from '../secure-storage.js';
const MAX_STORE_BYTES = 24 * 1024 * 1024;
export function createCredentialStore({file,storage,platform=process.platform}) {
  const available=()=>secureStorageAvailable(storage,platform);
  return {
    available,
    exists:()=>fs.existsSync(file),
    load(){
      if(!fs.existsSync(file))return {};
      if(!available())throw new Error('系统安全存储不可用，无法读取设备；请恢复系统加密服务后重试。');
      if(fs.statSync(file).size>MAX_STORE_BYTES)throw new Error('本地会话文件过大');
      try {const value=JSON.parse(storage.decryptString(fs.readFileSync(file)));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
      catch {throw new Error('无法读取本机加密会话；可清除本机配对后重新连接。');}
    },
    save(value){
      if(!available())throw new Error('系统安全存储不可用，无法保存设备和消息。');
      const json=JSON.stringify(value);
      if(Buffer.byteLength(json)>MAX_STORE_BYTES)throw new Error('本地会话存储已满');
      let encrypted;
      try { encrypted=storage.encryptString(json); }
      catch { throw new Error('系统加密失败，未保存设备和消息。'); }
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('系统加密失败，未保存设备和消息。');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const temp=file+'.tmp';
      try {fs.writeFileSync(temp,encrypted,{mode:0o600});fs.renameSync(temp,file);}
      catch(error){try{fs.unlinkSync(temp);}catch{}throw new Error('无法保存本地会话：'+String(error.code||'写入失败'));}
    },
    clear(){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw new Error('无法清除本机配对：'+error.code);}}
  };
}
