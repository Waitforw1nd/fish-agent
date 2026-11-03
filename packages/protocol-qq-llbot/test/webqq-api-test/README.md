# WebQQ 管理接口真机集成测试

针对 LLBot WebUI 后端（`src/webui/BE/routes/webqq/*.ts`）的单账号实机 HTTP 集成测试，与 `test/webui/` 下的 Mock 单元测试互补。

## 前置条件与配置

需先启动并登录一个真实的 LLBot 实例（WebUI 默认 `http://127.0.0.1:3080` 且已设置密码）：

```bash
cd packages/protocol-qq-llbot/test/webqq-api-test
npm install
cp config/test.config.example.json config/test.config.json
```

编辑 `config/test.config.json`（已被 `.gitignore` 忽略，不会提交）：

```json
{
  "host": "http://127.0.0.1:3080",
  "password": "<WebUI 明文登录密码>",
  "user_id": "<机器人自身 QQ 号>",
  "test_group_id": "<用于只读查询的群号>",
  "test_user_id": "<用于只读查询的 QQ 号>"
}
```

## 运行测试

```bash
npm test                       # 包含查询、参数校验及向自身发送群/好友戳一戳
npm test -- tests/chats.test.ts # 单独运行指定测试文件
```

完整套件会实际发送戳一戳，请只使用专门的测试账号和测试群。`RUN_DESTRUCTIVE` 不控制当前用例；从 URL 添加收藏表情的成功用例和危险的群、好友状态修改用例目前无条件跳过。

执行完成后会在当前目录生成 `test-report.html` 报告。
