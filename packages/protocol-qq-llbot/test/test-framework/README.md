# `@llbot-test/framework` 双账号协议测试底座

用于 OneBot 11 / Milky / Satori 等协议的通用双账号端到端（E2E）测试基础设施，统一处理测试配置读取与主/副账号监听器编排。完整用法示例见 `../onebot11-api-test/`。

## 核心组件

- `ConfigLoader`：加载并校验 `test.config.json`（主账号 `primary`、副账号 `secondary` 及 `test_group_id`）。
- `AccountManager<C>`：为主/副两个测试账号创建协议客户端实例。
- `TwoAccountTest<C, L>`：统一启动/停止双端事件监听、清空消息队列并提供重试断言辅助方法。
- `IApiClient` / `IEventListener`：由各协议测试包自行实现的接口调用与事件等待抽象。

## 接入新协议测试（4 步）

1. **新建测试目录**并复制 `test.config.json`（格式如下）：
   ```json
   {
     "accounts": {
       "primary": { "host": "http://127.0.0.1:53000", "apiKey": "", "protocol": "http", "user_id": "123456" },
       "secondary": { "host": "http://127.0.0.1:53001", "apiKey": "", "protocol": "http", "user_id": "654321" }
     },
     "test_group_id": "111222333",
     "timeout": 30000,
     "retryAttempts": 3
   }
   ```
2. **实现 `IApiClient`**：封装该协议的 `call(action, params)` 与 `disconnect()`。
3. **实现 `IEventListener`**：封装 `startListening()`、`stopListening()`、`clearQueue()` 与 `waitForEvent(filter, customFilter, timeout)`。
4. **在 `tests/setup.ts` 组装 `TwoAccountTest`**，并使用 Jest `--runInBand` 串行执行测试（双账号共享真实群会话，不可并发运行）：
   ```bash
   node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand
   ```
