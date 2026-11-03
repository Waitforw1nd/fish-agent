# OneBot 11 双账号真机集成测试

基于 `@llbot-test/framework` 的双账号实机自动化测试套件，验证 LLBot 在 HTTP 与 WebSocket 协议下的 OneBot 11 接口与事件推送（注意：日常免账号单测请直接在包根目录运行 `npm test`）。

## 配置与运行

1. 安装依赖并复制配置模板：

```bash
cd packages/protocol-qq-llbot/test/onebot11-api-test
npm install
cp config/test.config.example.json config/test.config.json
```

2. 编辑 `config/test.config.json`，填入已在线且互为好友、同处 `test_group_id` 测试群的主/副两个账号信息：

```json
{
  "accounts": {
    "primary": {
      "host": "http://127.0.0.1:3000",
      "apiKey": "your-api-key-1",
      "protocol": "http",
      "user_id": "123456789"
    },
    "secondary": {
      "host": "ws://127.0.0.1:3001",
      "apiKey": "your-api-key-2",
      "protocol": "ws",
      "user_id": "987654321"
    }
  },
  "test_group_id": "111222333",
  "timeout": 30000,
  "retryAttempts": 3
}
```

3. 执行测试（运行结束后生成 `test-report.html`）：

```bash
npm test              # 运行全部测试
npm run test:watch    # 监听模式
npm run test:coverage # 生成覆盖率报告
```
