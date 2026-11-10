# Agent Tool Center

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Tool Center helps an Agent compare similar tools, plugins, and Skills
from a bounded metadata catalog, follow a user's choice, and report its work.
It also offers experimental native windows for supported Codex metadata.

ChatGPT integration: Not implemented.

The catalog's deterministic defaults are routing choices, not quality rankings.
The advisor does not call a paid recommendation model.

## What it does

- Compare relevant candidates and select an eligible, ready entry.
- Follow a user's request to switch candidates within a comparison.
- Record Agent-reported task status, capability use, results, and quality.
- Display available local Codex observation metadata in read-only windows.

The six metadata tools are `list_capabilities`, `refresh_capabilities`,
`compare_capabilities`, `select_capability`, `report_task_status`, and
`report_capability_use`. They do not execute the selected capability or
change host permissions. Actual work uses host tools or loaded method Skills.
A method Skill is instructions used by an Agent, not an MCP or CLI endpoint.
Catalog entries, availability, use, and quality are Agent self-reports.

## Requirements and installation

- Node.js 22 or newer and npm.
- Git when using Git examples.
- Windows native windows require existing .NET Framework WinForms and `csc`.
- Codex chat launchers and observation require an installed, authenticated
  Codex CLI; the Windows chat launchers need `codex.cmd` on PATH.

Clone the [repository](https://github.com/cihuagu/Agent-Tool-Center),
enter its directory, and run:

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .cache/npm-cache
npm test
```

The locked root dependencies include the official MCP SDK under the
`@modelcontextprotocol/sdk-v1` alias. Setup does not install Codex or .NET.
An optional MCPHub fixture may be skipped unless separately prepared.
The native UI is experimental and primarily Chinese; English UI and
internationalization are incomplete. No native macOS or Linux GUI is promised.

## Windows entrypoints

These checkout-root entrypoints do not require a browser:

| Entrypoint | Action |
| --- | --- |
| `启动能力选择聊天.cmd` | Opens a new Codex CLI chat with the metadata advisor in a terminal. |
| `启动悬浮状态聊天.cmd` | Opens a new CLI chat in a terminal with an opt-in single-chat native window. |
| `启动多聊天管理器.vbs` | Starts an independent resident manager and native main window without opening a terminal. |

Ask the Agent to compare relevant candidates or switch to a ready candidate.
Check the actual host operation and its result separately from the report.
The single-chat window does not connect a real observer by default; observation
requires an explicitly trusted current thread binding or supported bridge.

The resident manager displays hook metadata and is independent of `node_repl`.
It is not a global six-tool service. Repeated launches reuse the manager.
Its tabs, tiles, drag, and topmost controls only affect display.
Closing it stops its own resources, not Codex chats; later hooks do not restart it.

## Hooks and observation

Preview the supported hook entries from the checkout:

```sh
node scripts/preview-multi-chat-hooks.mjs
```

The preview does not install hooks or grant trust. Hook installation requires
separate user review, installation through a supported host mechanism, and
official host trust. Host and version support must be checked. Without a
working source the window may be empty or show an unknown state.

Observation coverage depends on the host and events it supplies. A returned
call does not prove business success. Raw hook input can contain sensitive
content; the emitter keeps only allowlisted metadata for display and IPC.
Local IPC is unauthenticated: another local process could forge status, read
metadata, or disrupt the manager. Existing host permissions remain authoritative.
See the [usage guide](docs/USAGE.md) for setup, privacy, and limits.

## Optional local panel

`npm run dev` starts a separate loopback panel at `http://127.0.0.1:4173`.
It has its own controlled Git/Node allowlist and approval executor. It is not
required for the Windows entrypoints or synchronized with their catalogs.

## Documentation and license

- [Usage guide](docs/USAGE.md) and [documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)
- [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)
