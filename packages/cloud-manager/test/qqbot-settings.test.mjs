import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSettingsService } from '../src/agent-settings.js';
import { isApiAllowed } from '../src/config-guard.js';

test('official QQ allowlists persist and session paths preserve complete IDs', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-qq-settings-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'); const calls=[]; const tenant={id:'fixture'};
  const agent={configPath:()=>file,isRunning:()=>false,request:async (_tenant,method,url)=>{calls.push({method,url}); return {ok:true};}};
  const settings=new AgentSettingsService({agent});
  const groups=['123','qqbot_group_A-b_C']; const users=['456','qqbot_user_U-x_Y'];
  await settings.updateConfig(tenant,{allow:{groups,private:users}});
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).allow,{groups,private:users});
  await settings.messages(tenant,'group:qqbot_group_A-b_C'); await settings.chatAction(tenant,'private:qqbot_user_U-x_Y',{action:'test-send'});
  assert.deepEqual(calls.map(c=>c.url),['/api/chats/group_qqbot_group_A-b_C/messages','/api/chats/private_qqbot_user_U-x_Y/test-send']);
  await settings.updateConfig(tenant,{allow:{groups:[],private:[]}}); assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).allow,{groups:[],private:[]});
  for(const id of ['group:qqbot_user_wrong','private:qqbot_group_wrong','group:qqbot_group_../evil','group_qqbot_group_A:B','group:qqbot_group_'+ 'x'.repeat(129)]) await assert.rejects(settings.messages(tenant,id),e=>e.code==='INVALID_CHAT_ID');
});
test('proxy allows bounded official IDs only for matching conversation kinds',()=>{
  for(const part of ['group_qqbot_group_A-b','group_qqbot_channel_A','private_qqbot_user_A','private_qqbot_dm_A','group_123','private_7459086882832384','group_qqbot_group_'+'A'.repeat(128)]) {
    assert.equal(isApiAllowed('GET',`/api/chats/${part}/messages`),true);
    assert.equal(isApiAllowed('POST',`/api/chats/${part}/mark-read`),true);
    assert.equal(isApiAllowed('GET',`/api/memory-files/${part}`),true);
    assert.equal(isApiAllowed('DELETE',`/api/memory-files/${part}`),true);
    assert.equal(isApiAllowed('PUT',`/api/memory-files/${part}/members/abc_123`),true);
    assert.equal(isApiAllowed('DELETE',`/api/memory-files/${part}/members/abc_123`),true);
  }
  for(const part of ['group_qqbot_user_A','private_qqbot_group_A','group_qqbot_group_../admin','group_qqbot_group_A:B','group_qqbot_group_'+ 'x'.repeat(129)]) {
    assert.equal(isApiAllowed('GET',`/api/chats/${part}/messages`),false);
    assert.equal(isApiAllowed('PUT',`/api/memory-files/${part}/members/abc_123`),false);
  }
});
