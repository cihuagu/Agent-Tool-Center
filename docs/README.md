# Documentation

- [Usage guide](USAGE.md)
- [Current-chat desktop bridge](DESKTOP_BRIDGE.md)
- [Installation, update, and removal](INSTALLATION.md)
- [Public roadmap](ROADMAP.md)
- [English README](../README.md) | [简体中文 README](../README.zh-CN.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [License](../LICENSE)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)

## 当前聊天模式

首次连接见 [当前聊天桥接指南](DESKTOP_BRIDGE.md)，模式语义见 [当前聊天的选择模式](USAGE.md#当前聊天的选择模式)。
根 Agent 每次先校验真实宿主 UUID 与桥接绑定，再调用 `getMode()` 查询，
或按用户要求调用 `setMode("manual" | "recommend" | "auto")` 并以 `getMode()`
读回，按实际结果回显“当前聊天：手动／推荐／自动模式”。桥接比较调用省略
`mode`。模式按 UUID 保存在项目 `.cache/desktop-chat-modes/`，首次缺失默认
自动，关闭保留；原始 stdio 的按次 `mode` 语义不变。这不是实际宿主验收结果。
