import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexObserver, selectedThread } from "./codex-observer.mjs";

const ID = /^[a-z][a-z0-9_]{1,63}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[\p{L}\p{N} ._()\-]{1,80}$/u;
const EVIDENCE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|call_[A-Za-z0-9_-]{6,100})$/i;
const REASONS = {
  running: ["none"],
  waiting: ["awaiting_tool", "awaiting_user", "permission_required", "dependency_unavailable", "tool_error"],
  cancelled: ["user_cancelled"]
};
const QUALITY = ["not_assessed", "meets_requirement", "does_not_meet"];
const ERRORS = new Set([
  "OBSERVER_SOURCE_UNAVAILABLE", "OBSERVER_SOURCE_CLOSED", "OBSERVER_RESPONSE_LIMIT",
  "OBSERVER_PROTOCOL_ERROR", "OBSERVER_READ_FAILED", "OBSERVER_RPC_TIMEOUT",
  "OBSERVER_CLEANUP_FAILED"
]);
const DIAGNOSTIC = "原生状态窗显示通道不可用；聊天仍可继续，未记录原始诊断内容。\n";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const label = value => matches(NAME, value) && value.trim() === value;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const time = value => iso(value) ? new Date(value).toISOString() : null;

function scope(value) {
  try { return value === null ? null : selectedThread(value); } catch { return null; }
}

export function createStatusProjection({
  threadId = null, now = () => new Date(), desktopMode = false
} = {}) {
  const thread = scope(threadId);
  const comparisons = new Map();
  const selections = new Map();
  const seen = new Set();
  const history = [];
  const hostStates = new Map();
  let hostCurrent = null;
  let latestSourceAt = null;
  let current = null;
  let observer = { state: "unconnected", threadId: thread };
  const received = () => now().toISOString();

  function remember(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > 400) seen.delete(seen.values().next().value);
    return true;
  }

  function append(entry) {
    history.push(entry);
    if (history.length > 100) history.shift();
  }

  function select(selection, comparison) {
    if (!object(selection) || !matches(UUID, selection.selectionId) ||
        selection.comparisonId !== comparison.comparisonId ||
        !integer(selection.catalogRevision) ||
        selection.catalogRevision !== comparison.catalogRevision ||
        !comparison.candidates.some(candidate =>
          candidate.candidateId === selection.candidateId &&
          candidate.capabilityId === selection.capabilityId)) return false;
    if (!remember(`selection:${selection.selectionId}`)) return true;
    const candidate = comparison.candidates.find(item =>
      item.candidateId === selection.candidateId &&
      item.capabilityId === selection.capabilityId);
    const previous = current?.comparisonId === comparison.comparisonId ? current : null;
    const card = {
      comparisonId: comparison.comparisonId,
      selectionId: selection.selectionId,
      taskLabel: comparison.taskType,
      selectedCapabilityId: selection.capabilityId,
      selectedCapabilityName: candidate.name,
      actualCapabilityId: null,
      actualCapabilityName: null,
      state: "selected", reason: "unknown", verification: "agent_reported",
      startedAt: null, endedAt: null, cancelledAt: null,
      quality: "not_assessed", matchesSelection: null,
      switchFrom: previous?.selectedCapabilityId ?? null,
      switchFromName: previous?.selectedCapabilityName ?? null
    };
    selections.set(selection.selectionId, card);
    while (selections.size > 50) selections.delete(selections.keys().next().value);
    current = card;
    append({
      source: "agent_reported", state: "selected", capabilityId: selection.capabilityId,
      comparisonId: comparison.comparisonId, selectionId: selection.selectionId,
      receivedAt: received()
    });
    return true;
  }

  function accept(toolName, response) {
    if (!object(response) || response.isError !== false ||
        !object(response.structuredContent) ||
        response.structuredContent.controlLevel !== "advice_only") return;
    const data = response.structuredContent;
    if (toolName === "compare_capabilities") {
      if (!matches(UUID, data.comparisonId) || !matches(ID, data.taskType) ||
          !integer(data.catalogRevision) || !["ready", "needs_check"].includes(data.status) ||
          !Array.isArray(data.candidates) || data.candidates.length < 1 ||
          data.candidates.length > 4 || !data.candidates.every(item =>
            object(item) && matches(UUID, item.candidateId) &&
            matches(ID, item.capabilityId) && label(item.name))) return;
      if (seen.has(`comparison:${data.comparisonId}`)) return;
      const comparison = {
        comparisonId: data.comparisonId, catalogRevision: data.catalogRevision,
        taskType: data.taskType,
        candidates: data.candidates.map(item => ({
          candidateId: item.candidateId, capabilityId: item.capabilityId, name: item.name
        }))
      };
      if (data.status === "ready" && !select(data.selection, comparison)) return;
      if (data.status === "needs_check") {
        if (data.selection !== null) return;
        current = {
          comparisonId: data.comparisonId, selectionId: null, taskLabel: data.taskType,
          selectedCapabilityId: null, actualCapabilityId: null,
          selectedCapabilityName: null, actualCapabilityName: null,
          state: "needs_check", reason: "unknown", verification: "agent_reported",
          startedAt: null, endedAt: null, cancelledAt: null, quality: "not_assessed",
          matchesSelection: null, switchFrom: null, switchFromName: null
        };
        append({
          source: "agent_reported", state: "needs_check", capabilityId: null,
          comparisonId: data.comparisonId, receivedAt: received()
        });
      }
      remember(`comparison:${data.comparisonId}`);
      comparisons.set(data.comparisonId, comparison);
      while (comparisons.size > 20) {
        const oldest = comparisons.keys().next().value;
        comparisons.delete(oldest);
        for (const [id, card] of selections) {
          if (card.comparisonId === oldest) selections.delete(id);
        }
      }
    } else if (toolName === "select_capability") {
      const comparison = comparisons.get(data.selection?.comparisonId);
      if (comparison) select(data.selection, comparison);
    } else if (toolName === "report_task_status") {
      const record = data.taskStatus;
      if (!object(record) || record.verification !== "agent_reported" ||
          !matches(UUID, record.statusId) || !iso(record.recordedAt) ||
          typeof record.state !== "string" || !Object.hasOwn(REASONS, record.state) ||
          !REASONS[record.state].includes(record.reason) ||
          (Object.hasOwn(record, "taskLabel") && !label(record.taskLabel))) return;
      const card = selections.get(record.selectionId);
      const comparison = comparisons.get(card?.comparisonId);
      if (!card || record.comparisonId !== card.comparisonId ||
          record.catalogRevision !== comparison?.catalogRevision ||
          record.capabilityId !== card.selectedCapabilityId ||
          !remember(`status:${record.statusId}`)) return;
      const at = received();
      append({
        source: "agent_reported", state: record.state, reason: record.reason,
        capabilityId: record.capabilityId, selectionId: record.selectionId,
        comparisonId: card.comparisonId, statusId: record.statusId,
        recordedAt: time(record.recordedAt), receivedAt: at
      });
      if (card.endedAt || ["succeeded", "failed", "not_run", "cancelled"].includes(card.state)) return;
      card.state = record.state;
      card.reason = record.reason;
      if (record.taskLabel) card.taskLabel = record.taskLabel;
      if (record.state === "running" && !card.startedAt) card.startedAt = time(record.recordedAt);
      if (record.state === "cancelled") {
        card.cancelledAt = at;
        if (card.startedAt && !card.endedAt) card.endedAt = at;
      }
    } else if (toolName === "report_capability_use") {
      const record = data.report;
      if (!object(record) || record.verification !== "agent_reported" ||
          !matches(UUID, record.reportId) ||
          !["succeeded", "failed", "not_run"].includes(record.outcome) ||
          !QUALITY.includes(record.quality) ||
          (record.outcome === "not_run"
            ? record.actualCapabilityId !== null || Object.hasOwn(record, "evidenceCallId")
            : !matches(ID, record.actualCapabilityId)) ||
          (Object.hasOwn(record, "evidenceCallId") && !matches(EVIDENCE, record.evidenceCallId))) return;
      const card = selections.get(record.selectionId);
      const comparison = comparisons.get(card?.comparisonId);
      const expectedMatch = record.outcome === "not_run"
        ? null : record.actualCapabilityId === card?.selectedCapabilityId;
      if (!card || record.catalogRevision !== comparison?.catalogRevision ||
          record.selectedCapabilityId !== card.selectedCapabilityId ||
          record.matchesSelection !== expectedMatch ||
          !remember(`report:${record.reportId}`)) return;
      const at = received();
      append({
        source: "agent_reported", state: record.outcome,
        capabilityId: record.actualCapabilityId, selectionId: record.selectionId,
        comparisonId: card.comparisonId, reportId: record.reportId,
        quality: record.quality, matchesSelection: expectedMatch, receivedAt: at,
        ...(record.evidenceCallId ? { evidenceCallId: record.evidenceCallId } : {})
      });
      card.state = record.outcome;
      card.reason = "unknown";
      card.actualCapabilityId = record.actualCapabilityId;
      card.actualCapabilityName = record.outcome === "not_run" ? null
        : comparison.candidates.find(item =>
          item.capabilityId === record.actualCapabilityId)?.name ?? record.actualCapabilityId;
      card.quality = record.quality;
      card.matchesSelection = expectedMatch;
      if (card.startedAt && !card.endedAt) card.endedAt = at;
    }
  }

  function observe(event) {
    if (!thread || !object(event) || event.source !== "codex-observer" ||
        event.controllability !== "observable" || event.threadId !== thread ||
        !matches(TOKEN, event.callId)) return;
    const raw = ["codex.recorded.function", "codex.recorded.custom"].includes(event.toolId);
    const unscoped = desktopMode === true && raw &&
      event.turnId === null && event.scope === "thread_tail";
    if (!unscoped && (!matches(TOKEN, event.turnId) ||
        (event.scope !== undefined && event.scope !== "recent_turns"))) return;
    let state;
    if (raw) {
      const expectedKind = event.toolId === "codex.recorded.function" ? "function_call" : "custom_tool_call";
      if (event.rawKind !== expectedKind || !matches(TOOL, event.toolName)) return;
      if (event.status === "completed" && event.sourceStatus === "returned") state = "returned";
      else if (event.status === "queued" && event.sourceStatus === "recorded") state = "recorded";
      else return;
    } else if (desktopMode === true && event.toolId === "codex.native.mcp") {
      if (!matches(TOOL, event.serverName) || !matches(TOOL, event.toolName)) return;
      if (event.status === "completed" && event.sourceStatus === "completed") state = "returned";
      else if (event.status === "running" && event.sourceStatus === "inProgress") state = "running";
      else if (event.status === "failed" && event.sourceStatus === "failed") state = "failed";
      else return;
    } else if (event.toolId === "codex.native.terminal") {
      const sourceStatuses = {
        running: "inProgress", denied: "declined", failed: "failed", succeeded: "completed"
      };
      if (typeof event.status !== "string" || !Object.hasOwn(sourceStatuses, event.status) ||
          !(event.sourceStatus === sourceStatuses[event.status] ||
            (event.status === "failed" && event.sourceStatus === "completed"))) return;
      state = event.status === "succeeded" && event.exitCode !== 0 ? "unknown" : event.status;
    } else return;
    const callKey = JSON.stringify([thread, event.turnId, event.toolId, event.callId]);
    const terminal = !["running", "recorded"].includes(state);
    if (desktopMode === true) {
      const previous = hostStates.get(callKey);
      if (previous?.terminal && !terminal) return;
      hostStates.delete(callKey);
      hostStates.set(callKey, { terminal });
      while (hostStates.size > 400) hostStates.delete(hostStates.keys().next().value);
    }
    if (!remember(`host:${thread}:${event.turnId}:${event.callId}:${event.status}`)) return;
    const entry = {
      source: "codex-observer", state, capabilityId: event.toolId,
      threadId: thread, turnId: event.turnId, callId: event.callId,
      receivedAt: received(),
      ...(iso(event.at) ? { at: time(event.at) } : {}),
      ...(iso(event.startedAt) ? { startedAt: time(event.startedAt) } : {}),
      ...(iso(event.completedAt) ? { completedAt: time(event.completedAt) } : {}),
      ...(integer(event.durationMs) ? { durationMs: event.durationMs } : {}),
      ...(Number.isSafeInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
      ...(matches(TOOL, event.toolName) ? { toolName: event.toolName } : {}),
      ...(desktopMode === true ? {
        scope: unscoped ? "thread_tail" : "recent_turns",
        ...(matches(TOOL, event.serverName) ? { serverName: event.serverName } : {})
      } : {})
    };
    append(entry);
    if (desktopMode !== true) return;
    const at = time(event.at);
    const sourceAt = at === null ? null : Date.parse(at);
    const sameCall = hostCurrent && hostCurrent.callId === event.callId &&
      hostCurrent.turnId === event.turnId && hostCurrent.capabilityId === event.toolId;
    const candidate = {
      ...entry,
      at,
      durationMs: integer(event.durationMs) ? event.durationMs : null,
      ordering: at === null ? "unknown" : "source_time"
    };
    if (sourceAt !== null) {
      if (latestSourceAt === null || sourceAt >= latestSourceAt) {
        latestSourceAt = sourceAt;
        hostCurrent = candidate;
      } else if (sameCall && terminal) {
        hostCurrent = {
          ...hostCurrent, state, receivedAt: entry.receivedAt,
          durationMs: candidate.durationMs
        };
      }
    } else if (!hostCurrent || sameCall) {
      hostCurrent = sameCall ? {
        ...hostCurrent, state, receivedAt: entry.receivedAt,
        durationMs: candidate.durationMs, ordering: "unknown"
      } : candidate;
    } else {
      hostCurrent = { ...hostCurrent, ordering: "unknown" };
    }
  }

  function setObserverStatus(value) {
    if (!object(value) || !thread || value.threadId !== thread) return;
    observer = {
      state: ["stopped", "starting", "observing", "stopping", "error", "unconnected"].includes(value.state)
        ? value.state : "unknown",
      threadId: thread,
      lastReadAt: time(value.lastReadAt),
      lastErrorCode: value.lastErrorCode == null ? null
        : ERRORS.has(value.lastErrorCode) ? value.lastErrorCode : "OBSERVER_READ_FAILED",
      cleanupFailed: value.cleanupFailed === true
    };
    if (object(value.coverage)) {
      observer.coverage = {
        limit: 20,
        turnCount: integer(value.coverage.turnCount) ? Math.min(20, value.coverage.turnCount) : 0,
        hasMore: value.coverage.hasMore === true
      };
      if (object(value.coverage.raw)) {
        observer.coverage.raw = {
          available: value.coverage.raw.available === true,
          truncated: value.coverage.raw.truncated === true,
          maxBytes: 2 * 1024 * 1024,
          skippedLines: integer(value.coverage.raw.skippedLines) ? value.coverage.raw.skippedLines : 0
        };
        if (desktopMode === true) {
          observer.coverage.raw.unscopedItems = integer(value.coverage.raw.unscopedItems)
            ? value.coverage.raw.unscopedItems : 0;
        }
      }
    }
  }

  return {
    accept, observe, setObserverStatus,
    snapshot: () => structuredClone({
      current, history, observer,
      displayMode: desktopMode === true ? "desktop" : "advisor", hostCurrent
    })
  };
}

export function createStatusWindow({
  threadId = null,
  desktopMode = false,
  rendererFactory = createNativeRenderer,
  createObserver = createCodexObserver,
  onDiagnostic = message => process.stderr.write(message),
  statusRefreshIntervalMs = 2000
} = {}) {
  const thread = scope(threadId);
  const projection = createStatusProjection({ threadId: thread, desktopMode });
  let renderer;
  let observer;
  let starting;
  let closing;
  let stopped = false;
  let timer;
  const diagnose = () => { try { onDiagnostic(DIAGNOSTIC); } catch { /* display only */ } };

  function fail() {
    diagnose();
    void close();
  }

  function render() {
    if (stopped || !renderer) return;
    try {
      if (observer) projection.setObserverStatus(observer.getStatus());
      const written = renderer.write(projection.snapshot());
      if (written?.then) void written.catch(fail);
    } catch { fail(); }
  }

  function start() {
    if (starting) return starting;
    if (stopped) return Promise.resolve();
    starting = (async () => {
      try {
        renderer = await rendererFactory({ onClose: () => { void close(); } });
        if (stopped) return;
        render();
        if (stopped) return;
        if (thread) {
          observer = createObserver({
            includeMcp: desktopMode === true,
            includeUnscopedTrace: desktopMode === true,
            publish(event) {
              if (stopped) return;
              projection.observe(event);
              render();
            }
          });
          await observer.start({ threadId: thread });
          if (stopped) return;
          render();
          if (!stopped && statusRefreshIntervalMs > 0) {
            timer = setInterval(render, statusRefreshIntervalMs);
            timer.unref?.();
          }
        }
      } catch { fail(); }
    })();
    return starting;
  }

  function close() {
    if (closing) return closing;
    stopped = true;
    clearInterval(timer);
    closing = Promise.resolve().then(async () => {
      // Stop promptly even when the initial observer read is still pending.
      const stop = observer ? Promise.resolve().then(() => observer.stop()) : null;
      if (starting) await starting;
      const outcomes = await Promise.allSettled([
        stop ?? (observer ? Promise.resolve().then(() => observer.stop()) : Promise.resolve()),
        renderer ? Promise.resolve().then(() => renderer.close()) : Promise.resolve()
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected" || outcome.value?.cleanupFailed) diagnose();
      }
    }).catch(diagnose);
    return closing;
  }

  return {
    start, close,
    accept(name, response) {
      if (stopped) return;
      projection.accept(name, response);
      render();
    },
    getSnapshot: () => projection.snapshot()
  };
}

export async function createNativeRenderer({ onClose, mode = "single_chat" }) {
  if (mode !== "single_chat" && mode !== "multi_chat") {
    throw new Error("STATUS_WINDOW_INVALID_MODE");
  }
  if (process.platform !== "win32") throw new Error("STATUS_WINDOW_UNAVAILABLE");
  const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const source = mode === "single_chat"
    ? path.join(project, "src", "status-window", "AgentStatusWindow.cs")
    : path.join(project, "src", "MultiChatWindow.cs");
  const bytes = await readFile(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cache = path.join(project, ".cache", "status-window");
  const directory = path.join(cache, hash);
  await mkdir(directory, { recursive: true });
  const resolvedProject = await realpath(project);
  const resolvedDirectory = await realpath(directory);
  const relative = path.relative(resolvedProject, resolvedDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative) ||
      path.relative(path.join(resolvedProject, ".cache", "status-window"), resolvedDirectory) !== hash) {
    throw new Error("STATUS_WINDOW_CACHE_INVALID");
  }
  const executable = path.join(resolvedDirectory, `AgentStatusWindow-${randomUUID()}.exe`);
  const root = process.env.SystemRoot;
  if (!root || !path.isAbsolute(root)) throw new Error("STATUS_WINDOW_COMPILER_UNAVAILABLE");
  let compiler;
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = path.join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    try { await access(candidate); compiler = candidate; break; } catch { /* fixed fallback */ }
  }
  if (!compiler) throw new Error("STATUS_WINDOW_COMPILER_UNAVAILABLE");
  await new Promise((resolve, reject) => {
    execFile(compiler, [
      "/nologo", "/target:winexe", "/codepage:65001",
      "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
      "/reference:System.Web.Extensions.dll", `/out:${executable}`, source
    ], {
      windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, encoding: "utf8"
    }, error => error ? reject(new Error("STATUS_WINDOW_COMPILE_FAILED")) : resolve());
  });

  const child = spawn(executable, [], { windowsHide: false, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let notified = false;
  let blocked = false;
  let pending = null;
  let closing;
  let exited = false;
  const exit = new Promise(resolve => {
    child.once("close", () => { exited = true; resolve(); notify(); });
  });
  function notify() {
    if (notified) return;
    notified = true;
    onClose();
  }
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.stdout.on("error", notify);
  child.stderr.on("error", notify);
  child.on("error", notify);
  child.stdin.on("error", notify);
  child.stdin.on("drain", () => {
    blocked = false;
    if (pending !== null && !closed && !notified) {
      const line = pending;
      pending = null;
      blocked = !child.stdin.write(line);
    }
  });
  return {
    write(snapshot) {
      if (closed || notified) return;
      const line = `${JSON.stringify(snapshot)}\n`;
      const limit = mode === "single_chat" ? 100 * 1024 : 256 * 1024;
      if (Buffer.byteLength(line, "utf8") > limit) throw new Error("STATUS_WINDOW_SNAPSHOT_LIMIT");
      if (blocked) pending = line;
      else blocked = !child.stdin.write(line);
    },
    close() {
      if (closing) return closing;
      closed = true;
      pending = null;
      closing = (async () => {
        child.stdin.end();
        let timer;
        try {
          await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        } finally { clearTimeout(timer); }
        if (!exited) {
          try { child.kill(); } catch { /* only this owned child */ }
          try {
            await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
          } finally { clearTimeout(timer); }
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        return { cleanupFailed: !exited };
      })();
      return closing;
    }
  };
}
