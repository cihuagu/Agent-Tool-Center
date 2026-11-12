# Security

This project currently targets local, single-user use. The in-chat capability advisor provides advice and agent-reported information; it cannot enforce restrictions on native host tools. The controlled executor checks fixed allowlists and applicable approvals only on execution paths connected to it. Other host calls are not automatically controlled by the executor. Listening on a loopback address is not authentication and does not provide a complete security guarantee. Assess risks against your environment and actual permissions.

The resident manager uses a local named pipe but does not currently verify or guarantee same-user ACL-based authentication; its hashed name is not authentication. Other local processes may be able to read allowlisted metadata, forge displayed status, or deny service. The manager accepts only fixed display and metadata protocol operations; it does not execute shell commands or change tool permissions.

Raw Codex hook stdin may contain prompts and tool inputs or outputs. The emitter receives it only in memory, extracts allowlisted metadata, and discards the raw body; IPC and the window do not receive raw content. Inputs over 1 MiB are dropped, so observation and coverage can be incomplete. User hook trust permits the hook script to run with existing host permissions; it does not grant new execution permissions. Events are not uploaded by default.

## Reporting a vulnerability

If **Security > Report a vulnerability** is enabled in the repository, use it to report the issue privately. Otherwise, make only a public contact request without sensitive details and wait for a private channel. Do not publish exploit details, credentials, or logs containing private data in public issues or pull requests.
