# Third-party code

养鱼 Bot 桌宠使用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的部分 MIT 代码。
来源快照：`3229ab287d82d7621af2ee51544a0e746c2e40fd`，Copyright (c) 2026 PC2005-cloud。
许可全文随包提供：[licenses/dsh-pet-MIT.txt](licenses/dsh-pet-MIT.txt)。

| 本地文件 | 上游文件（相对 dsh-pet/runtime/electron-helper） | 改造 |
|---|---|---|
| src/vendor/dsh-pet/pointer-target.cjs | pointer-target.js | 保留区域分类、穿透与输入占用算法；用包/布局矩形替换原角色常量 |
| src/vendor/dsh-pet/desktop-geometry.cjs | desktop-geometry.js | 保留显示器工作区汇总；移除角色与 macOS 菜单栏耦合，新增窗口边界夹紧 |
| src/main/window-controller.js | main/windows.js | 适配透明置顶窗口参数及鼠标轮询兜底；单窗口、严格沙箱、自有图标，输入与显示器生命周期重写 |

只导入上述代码片段。没有使用上游角色、动画、图标、光标、音效、字体、提示词、截图或视频。
上游资源不适用本目录的 MIT 代码许可；其形象/素材的 CC BY-NC-SA / 禁商用约束不因代码复用改变。

两个内置资源包均由本项目 `scripts/generate-placeholder.mjs` 的几何图形代码独立生成，未使用参考项目素材。
每包附自己的 LICENSE.txt。AIRI 与 Open-LLM-VTuber 仅用于架构参考，未复制其代码或资产。

2026-11-03 交叉审查：对照本地上游上述快照，随包 MIT 文本与原 LICENSE 完全一致；测试逐字节比较两个 PNG 与本项目生成器输出，并限制角色资源目录文件清单。公开项目应保留本页的上游项目链接、作者及许可全文。以上核对仅涵盖当前代码片段和占位素材，不授予使用上游角色素材的许可。

Electron、ws 和其他依赖仍适用各自随包提供的许可证；本声明不替代它们的许可文件。
