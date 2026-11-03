# 视频理解模式与配置

核心通过 `api.videoMode` 控制收到群聊视频消息时的处理路线，**原生视频输入**与**本地抽帧**两条路线二选一（互斥，避免重复计费或触发 OpenAI 兼容网关 `400` 格式冲突）：

| `videoMode` 值 | 行为说明 |
|---|---|
| `auto`（默认） | 配置了 `api.videoModel` 时走原生视频直传；否则尝试 `video.frames` 抽帧；均不可用时仅读取视频时长与分辨率元信息。 |
| `native` | 强制以 `{ type: "video_url", video_url: { url } }` 原生格式发送给全模态模型。 |
| `frames` | 强制使用本地 `ffmpeg` 扩展抽取关键帧作为多张图片输入视觉模型。 |
| `off` | 仅读取元信息，不传输画面内容。 |

## 模块分工与安全边界

- **路由判定**：`src/video-reader.js`（`resolveVideoRoute`）决定当前会话走哪条路线；`src/llm.js`（`specializedModelFor`）在检测到图片或视频部件时自动切换到 `visionModel` 或 `videoModel`。
- **防 SSRF 先下载后抽帧**：不让 `ffmpeg` 直接请求外部消息中的原始 URL（防止通过恶意视频链接探测宿主机内网），统一先经 `src/safe-fetch.js` 做公网 DNS 与 IP 校验并下载为本地临时文件（上限 200 MB），再执行抽帧。

## 配置示例

```json
{
  "api": {
    "model": "deepseek-chat",
    "visionModel": "qwen-vl-max",
    "videoModel": "gemini-2.5-pro",
    "videoMode": "auto"
  }
}
```

> 若所用的中转网关不支持 `video_url` 字段导致请求返回 `400`，将 `videoMode` 改为 `"frames"` 并确保宿主机已安装 `ffmpeg` 即可。
