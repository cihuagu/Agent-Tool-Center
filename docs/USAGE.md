# Usage guide

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

ChatGPT integration: Not implemented.

## Install and check

To try the local choice flow before installing dependencies, run
`node scripts/demo-capability-choice.mjs --mode manual` from a clone with
Node 22+. Choose A/B explicitly, or cancel with q; this reads only the fixed
README through one local adapter and does not connect a host. See the
[quick start](../README.md#try-it-before-configuring-a-host).

Install Node.js 22 or newer and npm, then clone the repository and enter it.
Git is needed for Git examples. Run:

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .cache/npm-cache
npm test
```

The locked root dependencies include the official MCP SDK under the
`@modelcontextprotocol/sdk-v1` alias. The optional MCPHub fixture may skip
unless its resources have been separately prepared. No fixture is installed
automatically. Tests do not establish that a particular host integration works.

For Codex chat entrypoints and observation, install and authenticate Codex CLI
separately. Windows chat launchers require `codex.cmd` on PATH. Windows native
windows also require existing .NET Framework WinForms and `csc`. Neither setup
nor the launchers install Codex or .NET. Native Windows UI is experimental and
supports startup English and Simplified Chinese as described below.

## Read-only diagnostics

From the checkout, run:

```sh
node scripts/doctor.mjs
```

The command accepts no arguments and prints English JSON. Each check includes
`id`, `status`, `detail`, and `nextStep`:

- `node`: whether the running Node version meets the Node 22 minimum.
- `sdk`: whether the installed `@modelcontextprotocol/sdk-v1` client can import.
- `native_compiler`: whether the fixed Windows .NET compiler and the WinForms,
  Drawing, and Web Extensions assembly paths point to regular files.
- `native_sources`: whether the two fixed project C# window source paths point
  to regular files.
- `manager`: whether the existing resident manager answers a read-only `ping`
  with a 500 ms request timeout.
- `hook_trust` and `event_source`: always `unknown`. These require separate
  official host review and real events from the intended host/session.

`ready` proves only the stated observation. Regular-file presence does not prove
readability, executability, successful compilation, or a working native window.
Ping proves local IPC reachability, not server identity, hook trust, event
delivery, or complete host integration.
`not_ready` identifies a known missing or unsupported prerequisite or a negative
manager response. A known missing required file takes precedence over an
uncertain check of another required file. Denied access, failed imports of
uncertain cause, invalid responses, and unavailable or timed-out IPC are
reported as `unknown`.

Exit code 1 means at least one `not_ready` check, rejected arguments, or an
unexpected diagnostic failure; 0 means no known `not_ready` checks. Exit 0 can
include `unknown` and is not an integration acceptance result. Follow the next
steps manually; the diagnostic does not install, fix, configure, or grant trust.

The diagnostic uses module-relative project paths and fixed native paths. It
does not scan disks, read host configuration, credentials or chat contents,
start Codex or the manager, compile code, open a window, or send hooks/display
requests. It does not stop existing resources. `scripts/check-local.ps1` is a
separate test-suite runner and keeps its existing behavior.

## Choose an entrypoint

From the checkout root on Windows:

- `启动能力选择聊天.cmd` opens a new Codex CLI chat in a terminal with the advisor.
- `启动悬浮状态聊天.cmd` opens a new CLI chat in a terminal with a single-chat window.
- `启动多聊天管理器.vbs` starts the independent resident manager and its native
  window without opening a user terminal. Duplicate launches reuse it.

None requires a browser. Ask the Agent to compare candidates, or to switch to
an eligible ready candidate, then check the real work and its result.
The manager is independent of `node_repl` and displays hook metadata only;
it does not provide a global six-tool service. Window controls are read-only
display controls and do not take over the Codex GUI.

The single-chat window has no real observer connection by default. Observation
requires an explicitly trusted current thread binding via `ATC_STATUS_THREAD_ID`
or a supported desktop bridge. Do not guess a thread from recent logs or chats.
The separate current-chat bridge requires host-provided
`node_repl` `requestMeta.threadId`, strict UUID validation, and a matching
current binding before each use. It is not automatically connected.
The public setup, per-call guard, and owned cleanup examples are in the
[current-chat bridge guide](DESKTOP_BRIDGE.md).

### 单聊浮窗的隐藏与关闭

“隐藏已结束 / Hide ended”默认不勾选。勾选仅过滤当前窗口视图，取消勾选
会恢复最新完整快照，不删除历史或模式记录。结束状态包括成功、失败、取消、
未执行、已返回及已拒绝；已返回不代表成功。同一来源、同一身份组的早期选择和
运行记录也一起隐藏：宿主记录按聊天、轮次（可明确为 null）、能力及调用 ID
关联，Agent 自报按选择 ID 关联；身份缺失时只隐藏明确结束的单行。
独立的运行、等待及未知记录仍保留，隐藏摘要不代表整个聊天没有活动任务。

“关闭浮窗 / Close window”和标题栏 X 只关闭此浮窗及其自有观察与刷新资源。
聊天和六个元数据工具继续可用，权限不变，窗口不会自动重开。

## Native window language

Both native Windows windows accept `en` and `zh-CN` at creation time. The default
is `zh-CN`, preserving existing launchers. There is no live language switch or
persistent language preference. Unsupported values, including an empty value,
are rejected before the renderer creates a cache directory or native window.

For a **new** resident manager, set the launching process's environment and run
the existing entrypoint from the checkout:

```powershell
$env:ATC_UI_LANGUAGE = 'en'
& '.\启动多聊天管理器.vbs'
```

Use `zh-CN` for Chinese. This changes only that launching process's environment,
not a user or machine setting. An already running manager reuses its existing
window and language; this command does not switch it. Close and relaunch it
manually only when appropriate for your active work.

MCP hosts may filter inherited environment variables. For the existing single
chat launcher, pass the language explicitly to its MCP server:

```powershell
.\启动悬浮状态聊天.cmd -c "mcp_servers.capability_advisor.env.ATC_UI_LANGUAGE='en'"
```

That launcher starts a new CLI chat. A separate desktop bridge has its own
transport environment; do not assume it forwards this value automatically.
Programmatic renderer callers can pass `language: "en"` or `"zh-CN"` to
`createNativeRenderer`; an explicit option takes precedence over the environment.

Language selection changes native labels and explanations only. Task, project
and capability names, tool names, IDs, timestamps, and lifecycle event identifiers
remain as supplied. Protocol states, approvals, observation coverage and actual
results are unchanged. This does not provide full application internationalization.

## Installation, updates, and removal

See the [maintenance tools and runbook](INSTALLATION.md) for ownership, backup, migration,
confirmation and recovery rules. `scripts/manage-hooks.mjs` prepares explicit-target
JSON Hook plans and applies their exact reviewed bytes. Source checkout updates
and process transitions remain manual. Prepare and confirm the actual global-file
diff before applying it, then verify host discovery,
official trust and real event delivery separately.

## Catalog and reports

The six project metadata tools list, refresh, compare, select, report task
status, and report capability use. They do not run native capabilities or
grant or revoke host permissions. Actual execution remains with host tools or
loaded method Skills; a method Skill is Agent-used instructions, not an MCP or
CLI executable endpoint. Entries, availability, use, and quality are self-reported.
Deterministic defaults are not quality rankings or paid-model recommendations.

The default catalog is read at stdio process startup. An external refresh
replaces the complete bounded snapshot of host-visible entries for that session;
it is not disk discovery or a partial append. Omit commands, paths, URLs, and
Skill bodies from metadata. Default and external entries total at most 256;
pages contain at most 50 entries and a comparison contains at most four.
An empty snapshot clears external entries. Refresh disappears on process exit;
it does not hot-upgrade existing processes or synchronize the resident manager
or optional HTTP panel.

### 当前聊天的选择模式

用户可以说“当前聊天启用 manual（手动）模式”、“启用 recommend（推荐）模式”
或“启用 auto（自动）模式”，也可以询问当前模式。
在支持的当前聊天桌面桥接中，根 Agent 每次先严格校验
`nodeRepl.requestMeta.threadId` 是真实宿主 UUID，并确认
`globalThis.atcDesktop.getBinding().threadId` 与其规范小写值一致。
缺失或不一致时停止调用，关闭自己持有的旧会话并清空引用。
核验后查询调用 `await globalThis.atcDesktop.getMode()`；切换调用
`await globalThis.atcDesktop.setMode("manual")`（或 `"recommend"`、`"auto"`），
再调用 `getMode()` 读回。根据实际返回值用中文回显，例如
“当前聊天：手动模式”，明确只影响当前聊天，不能仅口头承诺。

两方法返回 `{ mode, scope: "current_chat", threadId }`，不新增 MCP 工具。
首次缺少记录返回 `auto`，查询不写文件；显式切换按规范 UUID 保存到项目
`.cache/desktop-chat-modes/<UUID>.json`，只含版本和模式。关闭桥接保留记录，
同 UUID 重连或独立进程读取同一记录，其他 UUID 隔离。目录注入仅供可信内部
代码使用，限定项目 `.cache` 内；目录链接、链接或非普通状态文件、损坏状态和
存储失败均拒绝，不静默回退自动。写入使用同目录独占临时文件及原子替换。

桥接的后续 `compare_capabilities` 调用省略 `mode`：每次比较重新读取保存状态
并自动补入，不修改调用者参数；显式传入的冲突模式会被拒绝转发。
其余五工具行为不变。切换只影响后续新比较；尚未执行的旧比较由 Agent
重新比较，不取消运行任务或改写历史。宿主缺少可信上下文或 `node_repl`
时不能假装完成接入；这些使用说明不代表真实宿主验收通过。

- `manual`：至少两个直接适用且自报 `ready` 的候选时返回
  `needs_selection` 和 `selection: null`，执行前等待用户选择，再以
  `user_requested` 调用 `select_capability`。只有一个合格候选时直接继续；
  没有合格候选时返回 `needs_check`。
- `recommend`：先解释按目录优先值确定的路由，再使用返回的选择继续，
  无需人工确认选择。
- `auto`：直接使用返回的选择继续。`recommend` 和 `auto` 没有合格候选时
  同样返回 `needs_check`。

等待选择时，状态窗显示等待用户；没有选择 ID，不调用 `report_task_status`。
用户选择后沿用现有的运行状态和实际采用报告流程。这些模式不引入独立的逐调用
审批，不扩大执行权限，也不提供全局拦截或全项目策略。原始 stdio 接口保持
按次传入 `mode`、省略默认 `auto` 的既有语义，不读取此桥接的聊天记录。
它们与旧 HTTP 面板的 manual/auto/mixed 系统无关。

## Resident hooks

Preview the eight supported entries on stdout:

```sh
node scripts/preview-multi-chat-hooks.mjs
```

To also write `.cache/multi-chat-hooks.preview.json`, append `--write-preview`.
Neither form installs global configuration or grants trust. The generated
`command` and `commandWindows` refer to the current Node binary and checkout's
`src/multi-chat-hook.mjs`; regenerate and review after moving the checkout or
changing the executable.

Review the concrete entries and preserve any existing host hook configuration.
The user must separately install them in the effective `CODEX_HOME` using a
supported host mechanism, then complete official host review and trust.
Availability, reload behavior, and the review mechanism depend on host and
version; check them and test the intended session. Hot reload is not guaranteed.
Opening the manager alone does not discover or connect every chat or project.

Supported metadata types are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`, `Interrupt`, and `SessionEnd`.
Their presence in the preview does not mean every host or session emits each one.
Actual callback metadata and Agent reports are distinct. No source means
unknown; without a start event, duration is unknown. A returned call does not
establish business success. Outer `node_repl` or `exec` calls remain outer calls;
code strings are not parsed to guess inner plugins.

Some API-delegated turns do not supply an ordinary `UserPromptSubmit` anchor.
Connected, unknown, and a null turn can therefore be correct; do not infer
running from dispatch or command completion. Ordinary input and host version
affect which anchors arrive. The manager retains at most 16 sessions and 20
history entries per session; five minutes without an event makes state unknown.
Closing its window stops only owned resources. Later hooks become no-ops and
do not restart the manager or stop Codex chats.

## Privacy and security

Official raw hook stdin may contain prompts, tool inputs and outputs, and full
working directories. The emitter reads it in memory, extracts allowlisted safe
metadata, and discards the raw input; raw bodies are not logged or uploaded by
default. Display and IPC exclude those bodies and full working directories.
Inputs over 1 MiB are dropped, so observation may be incomplete.

The manager uses a local named pipe scoped by same-user and checkout hash, not
TCP. Naming is not authentication or an ACL: IPC and payloads are unauthenticated.
Other local processes could forge status, read metadata, or cause denial of
service. The manager has no execution endpoint or native approval authority;
host permissions and approvals remain authoritative.
