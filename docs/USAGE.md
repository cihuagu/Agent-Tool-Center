# Usage guide

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

ChatGPT integration: Not implemented.

## Install and check

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
nor the launchers install Codex or .NET. Native UI is experimental, primarily
Chinese, and has incomplete English UI and internationalization.

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
