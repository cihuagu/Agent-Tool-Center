# Agent Tool Center

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Tool Center 帮助 Agent 从有界元数据目录中比较相似的工具、
插件和 Skills，遵循用户选择，并报告工作情况。
项目还提供实验性的 Windows 窗口，展示受支持的 Codex 元数据。

ChatGPT 集成：尚未实现。

目录使用确定性的默认路由，默认顺序不是质量排名；
助手不调用付费推荐模型。

## 主要功能

- 比较相关候选，并选择符合条件且已就绪的条目。
- 按用户要求，在同一次比较的候选中换选。
- 记录 Agent 自报的任务状态、能力使用、结果和质量。
- 在只读窗口中展示可获得的本地 Codex 观察元数据。

六个元数据工具是 `list_capabilities`、`refresh_capabilities`、
`compare_capabilities`、`select_capability`、`report_task_status`
和 `report_capability_use`。它们不执行选中的能力，也不改变宿主权限。
实际工作仍由宿主工具或已加载的方法型 Skill 完成。
方法型 Skill 是 Agent 使用的指令，不是 MCP 或 CLI 可执行入口。
目录条目、可用性、使用情况和质量均由 Agent 自报。

## 环境与安装

- Node.js 22 或更高版本，以及 npm。
- 在使用 Git 示例时需要 Git。
- Windows 原生窗口需要已有的 .NET Framework WinForms 和 `csc`。
- Codex 聊天入口和观察功能需要已安装并登录的 Codex CLI；
  Windows 聊天启动入口需要 PATH 中存在 `codex.cmd`。

克隆[源代码仓库](https://github.com/cihuagu/Agent-Tool-Center)，
进入检出目录后运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .cache/npm-cache
npm test
```

锁定的根依赖包含以 `@modelcontextprotocol/sdk-v1` 为别名的官方 MCP SDK。
安装不会安装 Codex 或 .NET。可选 MCPHub fixture 未单独准备时可能跳过。
原生界面为实验性功能，以中文为主；英文界面和国际化尚未完成。
项目不承诺提供 macOS 或 Linux 原生图形界面。

## Windows 启动入口

以下入口位于检出目录根部，均无需浏览器：

| 入口 | 作用 |
| --- | --- |
| `启动能力选择聊天.cmd` | 在终端中启动带元数据助手的新 Codex CLI 聊天。 |
| `启动悬浮状态聊天.cmd` | 在终端中启动新 CLI 聊天，并启用单聊天原生窗口。 |
| `启动多聊天管理器.vbs` | 启动独立常驻管理器及原生主窗，不打开终端。 |

可以要求 Agent 比较相关候选，或换选已就绪的候选。
实际宿主操作及其结果应与 Agent 报告分别核对。
单聊天窗口默认不连接真实观察源；观察需要明确可信的当前线程绑定
或受支持的桥接。

常驻管理器独立于 `node_repl`，只展示 Hook 元数据，
不是全局六工具服务。重复启动会复用已有管理器。
标签、平铺、拖动、置顶只控制显示。
关闭管理器只停止其自有资源，不终止 Codex 聊天；后续 Hook 不会重启它。

## Hook 与观察

在检出目录预览受支持的 Hook 条目：

```sh
node scripts/preview-multi-chat-hooks.mjs
```

预览不会安装 Hook 或授予信任。安装需要用户单独审阅，
通过受支持的宿主机制安装，并取得宿主官方信任。
需检查具体宿主及版本是否支持；没有有效来源时窗口可能为空或显示未知。

观察范围取决于宿主及其提供的事件。调用返回不代表业务成功。
Hook 原始输入可能包含敏感内容；发射器仅保留允许的元数据用于显示和 IPC。
本地 IPC 未认证：其他本地进程可能伪造状态、读取元数据或干扰管理器。
实际权限仍由宿主控制。安装、隐私与限制详见[使用指南](docs/USAGE.md)。

## 可选本地面板

`npm run dev` 启动独立的回环面板 `http://127.0.0.1:4173`。
它有独立的受控 Git/Node 白名单及审批执行器，不是上述入口的必需项，
也不会与其目录同步。

## 文档与许可证

- [使用指南](docs/USAGE.md)和[文档索引](docs/README.md)
- [贡献指南](CONTRIBUTING.md)和[安全说明](SECURITY.md)
- [MIT 许可证](LICENSE)和[第三方声明](THIRD_PARTY_NOTICES.md)
