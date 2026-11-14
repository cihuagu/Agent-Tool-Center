# Installation, update, and removal

This runbook covers the portable checkout and its explicit-target JSON Hook
maintenance tools. The tools prepare and apply installation, binding updates,
detachment and recovery. Source checkout updates and process transitions remain
manual; no service, startup registration or dependency upgrade is installed.

Preparing this plan or a hook preview does not authorize a global change. Before
each actual global configuration write, present its resolved targets, exact diff,
backup, recovery steps, and effects for explicit user confirmation. Host trust
review is a separate step when a definition is new or changed.

## Supported model and boundaries

Keep the checkout at a stable, user-chosen local path. Reuse existing Node.js,
Codex CLI and Windows .NET prerequisites; do not modify PATH, install global npm
packages, create startup tasks/services, or add registry entries as a side effect.
The resident manager and the optional single-chat advisor are separate entrypoints.
Installing hooks does not install a global six-tool service or connect all hosts.

Choose the requested entrypoint scope first. The metadata advisor and an
Agent-reported single-chat window do not require lifecycle-hook installation;
their existing session-scoped launcher settings remain session-scoped. A real
single-chat observer still needs its supported explicit binding. The Hook-source
installation steps below apply only when resident Hook observation is requested.
Judge prerequisite checks against the chosen features rather than adding an
unrequested global integration to make every diagnostic item ready.

The current advisor launcher supplies MCP configuration to that process; it does
not create a persistent global MCP registration. If a previous/manual setup added
an ATC registration, shortcut, or startup item, treat it as a separate identified
target with ownership evidence and its own approved diff. Do not assume it exists
or sweep unrelated configuration to find/remove it.

Existing setup and diagnostic commands:

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .cache/npm-cache
node scripts/doctor.mjs
npm test
node scripts/preview-multi-chat-hooks.mjs
```

Dependency installation changes the checkout and may use the network; run it only
within an authorized setup/update. Doctor is read-only and does not grant trust.
The preview prints metadata and fixed commands; it does not install anything.
The existing `--write-preview` option writes only a project cache preview.

## JSON Hook maintenance commands

Start with `node scripts/manage-hooks.mjs --help`. The CLI requires an explicit
absolute path named `hooks.json`, with an existing ordinary parent directory.
It never infers a target from `CODEX_HOME`, searches personal directories, edits
TOML, invokes Hook commands, or grants host trust.

This release supports actual apply on Windows. POSIX can prepare previews, but
apply refuses before writing: mode bits alone cannot preserve inherited or
extended ACLs reliably with the current dependencies. No POSIX target-writing
support or acceptance is claimed.

Prepare one operation (replace the placeholders with reviewed absolute paths):

```sh
node scripts/manage-hooks.mjs preview install --target "<absolute path>/hooks.json"
node scripts/manage-hooks.mjs preview adopt --target "<absolute path>/hooks.json"
node scripts/manage-hooks.mjs preview update --target "<absolute path>/hooks.json" --receipt "<absolute path>/receipt.json"
node scripts/manage-hooks.mjs preview uninstall --target "<absolute path>/hooks.json" --receipt "<absolute path>/receipt.json"
node scripts/manage-hooks.mjs preview rollback --target "<absolute path>/hooks.json" --receipt "<absolute path>/receipt.json"
```

`install` without a receipt refuses recognizable existing ATC definitions.
`adopt` is a separate reviewed ownership operation: it requires exactly one of
each current definition, preserves target bytes, and treats the groups as
pre-existing. Repeating `install` with `--receipt` is a no-op only when the owned
bindings still match. A changed checkout or Node path requires `update`.

Preview writes only a UUID record under `.cache/hook-maintenance/` in this
checkout. Its JSON output includes `planPath`, `planSha256`, `receiptPath`, exact
ATC ownership before/after, whole-file hashes, source identities, and the fixed
temporary/lock/backup paths. Foreign configuration bodies are omitted. Inspect
this packet together with the host facts and approval checklist below.

Only after the concrete global change has been approved, apply those exact plan
bytes using the returned path and digest:

```sh
node scripts/manage-hooks.mjs apply --plan "<returned absolute planPath>" --plan-sha256 "<returned planSha256>"
```

The digest checks integrity; it does not authenticate user approval. Apply
recomputes the candidate, source and receipt identities, and target baseline.
Any drift requires a fresh preview and renewed review. A source identity is a
digest of the current working-tree files and runtime, not a clean Git revision,
signed release, host discovery or host trust claim.

Successful output is `applied` or `noop` with the resulting receipt path and
target hash. Keep the latest applicable receipt and its source receipts/backups;
ownership and recovery depend on them at their original absolute paths. Copying
only the latest receipt is insufficient. There is no automatic receipt-chain
relocation or compaction tool; missing or changed ancestors stop maintenance.
A no-op still saves a project receipt,
while leaving target bytes and target-side artifacts untouched. Invalid or
ambiguous ownership stops before writing the target.

Actual JSON changes preserve foreign values and relative order but normalize
formatting. Duplicate keys (including escaped aliases), invalid UTF-8, excessive
depth, files over 1 MiB, and numbers that would lose their exact decimal value
are refused. No-op operations preserve the original bytes. The exact original
bytes of a changed existing file are backed up before publication.

Windows backups use CurrentUser DPAPI; recovery depends on the corresponding
Windows user/DPAPI environment. The fixed PowerShell helper verifies protection
round trips. Newly created empty temporary candidates establish current-user
ownership and receive the existing target's DACL before any payload is written;
without an existing target, they use private user/SYSTEM access.
Existing source ownership is unchanged and strictly checked against the current
user; sources owned by another identity are refused. This establishes Owner and
DACL on temporary candidates, not a complete security-descriptor or SACL restore.
Changing the helper hash invalidates old plans; prepare a new plan without
modifying existing plans, backups, or receipts. It does not request audit/SACL
privileges or elevation. POSIX preview records use checked current ownership and
0700/0600 permissions. An ignored cache alone is never the privacy guarantee.

Apply uses an exclusive cooperative `.atc-hooks.lock`, a same-directory temporary
file, readback hashing, and a prepared receipt before replacement. An originally
absent destination is published exclusively. This does not lock out unrelated
editors or guarantee a power-loss transaction. Never steal a leftover lock or
blindly overwrite a changed target. `recovery_required` means preserve the
record and prepare a separate rollback. A prepared receipt is recoverable only
when the current target exactly matches its recorded candidate.

Uninstall retains `hooks.json` and the checkout. Exact rollback can restore the
original bytes, or remove an unchanged file originally created from absence.
With later foreign edits, install/update rollback inverts only unchanged owned
entries; ambiguous cases, including uninstall rollback after drift, stop with
`rollback_conflict`. File/checkout deletion and running-process transitions remain
separate approved operations.

The preview contains eight events: `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Interrupt`, and
`SessionEnd`. Each uses the current absolute Node executable and checkout's
`src/multi-chat-hook.mjs`, a two-second timeout, and `async: false`. Windows uses
the separately quoted `commandWindows`; do not replace it with an unquoted path
or a user-provided shell string.

## Host facts to check before integration

The current [official Hooks documentation](https://learn.chatgpt.com/docs/hooks)
describes JSON and inline TOML sources, additive loading across sources,
project-layer trust, and hash-based review of non-managed definitions through
`/hooks`. A `commandWindows` override is supported. These are host rules; check
the installed host/version and effective source before applying this runbook.

Confirm the running host's effective configuration home and active hook sources;
do not guess them from a different terminal or a default personal directory.
The proposed user-level target is `<effective CODEX_HOME>/hooks.json`, unless the
review establishes that ATC already lives in another supported source. Resolve
the actual absolute path only for the concrete operation. Do not scan unrelated
directories or read authentication files, chat bodies, or the private trust store.

Inspect the active sources through the supported host view and the specifically
identified hook files. JSON, inline TOML, project, and plugin sources may overlap.
Avoid a second ATC copy in another source. Preserve the current representation;
do not edit TOML with regexes or create a JSON duplicate to avoid a difficult edit.
Invalid/ambiguous input, including duplicate JSON keys, stops the operation.
The preview's optional top-level description is metadata, not proof of ownership.

## Approval and recovery packet

Before a global install, update, migration, removal, or recovery write, prepare a
project-private packet. Placeholders below are not an executable approval:

| Item | Required evidence |
| --- | --- |
| Operation | Install, update, adopt, migrate, detach, remove files, or recover; one explicit scope. |
| Host and targets | Verified host/version, effective source, logical and resolved absolute paths, including any temporary replacement file. |
| Baseline | File absent or exact SHA-256; source representation; other active sources checked for duplicates. |
| Candidate | Exact ATC before/after definitions and target hash; unchanged foreign content identified without logging its command bodies. |
| Code identity | Reviewed revision/artifact digest, lockfile digest, dirty-state disposition, absolute Node binary and relevant source hashes. |
| Backup | Exact-byte backup, its hash, approved destination, and verified privacy; file-absent state recorded explicitly. |
| Effects | Affected eight bindings, possible event gap, manager stop/start if separately approved, host reload/review requirements. |
| Recovery | Inverse change and preconditions; what happens if another application edits the file. |

Backups may contain sensitive third-party configuration. Keep them outside Git
and ordinary logs, never upload them, and verify a suitably private destination.
An ignored cache is not an access-control mechanism. If privacy cannot be
established, stop before changing the original. Do not copy credentials, chats,
or the entire host home as a convenient backup.

Record an operation receipt outside the host hook schema: operation identity,
checkout and Node bindings, original/candidate hashes, backup identity, and the
exact event, matcher/group context and handler definitions added or adopted.
Do not inject unsupported ownership IDs into `hooks.json`. Event names, labels,
and path substrings alone are insufficient ownership evidence.

Recheck the baseline immediately before applying. Observed drift invalidates the
packet and requires a new diff/confirmation. A hash check is not a cross-process
lock: arrange an exclusive maintenance window or use a supported conditional
write mechanism. Do not promise a transaction against uncooperative editors.
Use the tested same-volume replacement procedure above or a supported editor;
reject unexpected symlinks/junctions or broaden the reviewed target explicitly.

## Install

1. Choose the stable checkout path and verify the intended source/revision. Check
   Git state; preserve local work. Do not stash, reset, clean, or discard it.
2. Inspect prerequisites and explicitly prepare locked dependencies if authorized.
   Run doctor and the appropriate tests. Read each result; an exit code of zero
   with `unknown` checks is not integration acceptance.
3. Generate a fresh preview. Verify both the absolute Hook Node binding and the
   Node that the existing launchers resolve from PATH. A mismatch requires a
   deliberate session/path choice; do not silently change global PATH.
4. Build the packet against the actual active source. If ATC definitions already
   exist without a reliable receipt, prepare a separate reviewed adoption or
   replacement. Do not silently adopt, duplicate, or delete them.
5. Obtain confirmation of the concrete global diff. Back up and hash the exact
   target bytes, then add only approved ATC handlers. Keep foreign handlers,
   matcher groups, root metadata, and their order. Repeated owned definitions
   with a matching receipt should be a no-op.
6. Read back the result and compare it with the approved candidate. Use the
   installed host's official review for new/changed definitions. Never modify
   trust databases or use trust-bypass flags. Unchanged definitions already
   trusted by the host do not need invented extra trust prompts.
7. Activate/reload only by the supported host/version procedure and within the
   authorized scope. Start the resident window manually when desired. Check the
   intended session's real lifecycle, not a generated or injected hook payload.

Classify verification separately: file written; host discovered definition;
official trust confirmed; manager reachable; target-session event delivered;
display correct. None implies the next. No active source or missing anchors may
correctly produce unknown state. Do not manufacture events to obtain a pass.

## Update

Review a specific candidate revision/artifact, not an unreviewed moving branch.
Stage and validate a public source export separately before replacing a working
installation. Exclude maintainer caches, private collaboration records, local
configuration and raw acceptance evidence. The package version alone does not
identify a particular checkout or dirty build.

If the installed checkout is dirty, stop an in-place update and show the relevant
diff; preserve it. A clean checkout may use a reviewed fast-forward or an approved
artifact replacement. Record old code and lockfile identities for recovery, and
check dependency changes before any new download. Do not automatically upgrade
Node, Codex, or .NET as part of an ATC update.

Arrange a quiet switch window before changing files that live hook processes may
load. The running manager retains loaded code, so a code update needs a separately
authorized close/relaunch to take effect there. Closing it loses its in-memory
cards/history; it must not close Codex chats. If ATC hooks must be temporarily
disabled, include that exact global change in the approval packet and affect
only owned ATC definitions, not the host's global hook switch.

Also identify affected single-chat advisor and desktop-bridge processes that this
operation owns. They retain loaded code independently of the manager. Explicitly
defer their upgrade, or close/reconnect only those ATC resources within the agreed
switch scope while preserving Codex chats. Record the loss of temporary catalogs,
selection/use reports and window state. Check the existing `.close()` result's
`cleanupFailed`; an unconfirmed cleanup is not a completed transition.

Desktop reconnection still requires the current root Agent's real host UUID and
a matching binding. Do not reuse an old thread ID or assume that importing the
same module URL refreshes a persistent kernel's ESM cache. Arrange a supported
fresh runtime only after closing owned resources; do not reset unrelated sessions.
Record the version/result or explicit deferral for each entrypoint. Restarting
the manager alone cannot establish that all entrypoints have upgraded.

Regenerate and compare the preview. An unchanged command definition does not
establish the safety of newly deployed bytes: review the release contents
independently. If bindings change, obtain a fresh global-diff confirmation and
follow official review for the changed definitions. Do not assume hot reload or
trust carry-over. Verify the intended session after the authorized switch; retain
the previous source/lockfile and configuration backup until acceptance.

## Checkout or Node path migration

A new checkout path changes the manager's endpoint scope. Preview commands also
contain absolute Node and emitter paths. Moving files or changing Node location
therefore needs a planned rebind, not a blind directory move.

Prepare the destination, verify its contents/prerequisites, and generate its
preview. Compare old/new bindings and inspect all active sources for duplicate
callbacks. Obtain confirmation for replacing the exact owned definitions, then
perform the authorized source/manager transition. Keep the old checkout until
recovery is no longer needed. The old checkout's source files and its referenced
maintenance records have separate retention needs: continuing maintenance from
the latest receipt still requires every referenced receipt/backup at its original
path, even after a migration has been accepted. Do not delete that record chain
as part of source cleanup. Do not run both old and new ATC registrations as
an undocumented migration strategy. A language change remains process-only;
do not persist `ATC_UI_LANGUAGE` in user/machine environment settings by default.

## Uninstall and optional file removal

The default is **detach the integration and keep the checkout/backups**.

1. Inventory only receipt-owned definitions in verified active sources. If an
   owned definition or matcher context has been edited, stop and present it for
   review. Do not infer ownership from the command's path or event type.
2. Present the exact removal diff and obtain confirmation. Remove only matching
   handlers. Preserve foreign handlers in mixed groups and all unrelated metadata.
   Remove a group only when the receipt proves ATC created it and it is now empty.
3. Delete a whole hook file only if ATC created it, it remains exactly unchanged,
   no unrelated data exists, and that deletion was explicitly approved. Never
   delete a shared hook file, disable all hooks, or remove the entire host home.
4. Verify the changed file and supported host reload/removal behavior. Confirm
   ATC is absent from the intended loaded sources and other registrations remain.
   Historical callbacks may remain in memory; distinguish them from new delivery.
5. Close only the approved ATC manager/window. Current IPC has no shutdown command;
   do not invent one or kill every Node/Codex process. For a hung process, verify
   the exact owned executable, PID and creation identity before proposing action.

Handle owned single-chat advisor/desktop resources as in the update procedure,
without ending their chats. If another active session still needs the checkout
or ownership is unknown, retain it and record the deferred removal. Do not remove
its code files merely because the resident window has closed.

Full checkout/cache deletion is a separate optional operation after detachment.
Show the exact resolved paths and local/uncommitted files, verify backups and
reparse-point boundaries, and obtain explicit deletion confirmation. Prefer
keeping the source and backups when uncertain. Never remove shared Node, Codex,
.NET, other plugins, or third-party hooks as ATC dependencies.

## Recover or roll back

Restore an entire exact-byte configuration backup only when the current file
still matches the applied candidate hash and restoration is approved. If another
party changed it, prepare an inverse change against current content that touches
only unchanged receipt-owned entries; preserve new foreign changes. If ownership
or context is ambiguous, stop rather than overwrite. A file originally absent
may be removed only under the same unchanged/owned/approved conditions.

Restore the approved prior code and lockfile through the normal source workflow;
do not overwrite subsequent local work. Regenerate old bindings when appropriate,
read back the recovered configuration, and follow official review if required.
Restoring bytes does not authorize restoring private trust state or guarantee
old trust. Re-run the intended-session verification after any authorized restart.

Keep receipts/backups until the user accepts recovery and separately authorizes
their removal. A missing backup, permission denial, interrupted replacement or
hash mismatch leaves the installation/recovery unverified, not successful.

## Acceptance and remaining host checks

Required rejection cases include ambiguous ownership, modified owned handlers,
invalid or duplicate-key configuration, concurrent drift, denied writes, unsafe
paths/reparse points, backup failure and interrupted replacement. Also cover
empty/mixed configurations, idempotent installation, mixed matcher groups,
exact-byte recovery, preservation of later foreign changes, and path migration.
Run these in owned fixtures first with `npm test`. The maintenance tests use the
real CLI, filesystem and backup protection in project fixtures, plus controlled
I/O failures. Fixture success does not establish host trust or real
installed-source delivery.

For the actual host, repeat discovery/trust/event/display acceptance after the
approved operation. Windows command quoting must retain the existing emitter's
special-character-path coverage. Do not use real credentials or chat content as
test data. A code/test pass cannot substitute for these host checks.

## English entrypoint names

Keep the existing three filenames working. The proposed ASCII aliases are
`start-advisor.cmd`, `start-status-chat.cmd`, and `start-manager.vbs`, delegating
to the current launchers. They are **not implemented** and
are not commands to run now. They would improve discoverability without changing
Hook bindings; review the small wrappers and their exit-code/quoting behavior
before adding them. No desktop shortcut, startup registration or global PATH
entry is needed for this portable model.
