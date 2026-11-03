# 管理员端公共上游与模型目录规划

## 1. 现状与已落地内容

- **静态模型目录（`packages/cloud-manager/src/plans.js`）**：已内置 `deepseek-chat`、`deepseek-reasoner`、`gpt-4o-mini` 以及 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision`、`deepseek-v4.1-flash` 共 7 个平台计费模型，所有套餐均可识别并按明确费率结算。
- **管理后台上游配置（`#/admin/platform`）**：支持通过 `GET / PUT /api/admin/upstream` 加密保存或清除平台公共 OpenAI 兼容 Base URL 与 API Key（响应不回显明文）。
- **当前不足**：平台全局默认模型仍依赖启动环境变量 `CLOUD_DEFAULT_MODEL`，管理面板尚无公共上游“测试连接 / 刷新模型”按钮，也暂不支持在网页上动态增删计费模型与调整单价。

---

## 2. 待开发目标（免 SSH 可视化管理）

1. **保留任意 OpenAI 兼容 URL**：继续允许管理员与租户自由填写完整 `http(s)` Base URL（不锁死预置厂商白名单，保留防 URL 内嵌凭据与 SSRF 校验）。
2. **公共上游连通性测试与缓存刷新**：在 `#/admin/platform` 增加“测试连接并拉取模型”，反馈延迟、HTTP 状态与可用模型数；更新 URL 或 Key 时自动清空旧模型缓存。
3. **可视化设置平台默认模型**：支持从已拉取模型中选择或手动输入默认模型，并可选应用范围（仅新实例 / 同步更新仍使用旧平台默认模型的实例，不覆盖自定义渠道）。
4. **动态模型启用与定价配置**：将模型启用开关、显示名、上下文上限、套餐白名单与百万 Token 单价持久化到数据库，替代手改 `MODEL_CATALOG`。
