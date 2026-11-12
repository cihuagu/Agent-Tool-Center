import { spawn } from "node:child_process";
import { PolicyError } from "./policy.mjs";
import { createTraceReader, TRACE_MAX_BYTES } from "./codex-trace.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SELECTION = new RegExp(`^(?:(${UUID})|thread://(${UUID})\\?hostId=local)$`, "i");
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const SAFE_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/;
const safe = (pattern, value) => typeof value === "string" && pattern.test(value);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function selectedThread(value) {
  const match = typeof value === "string" && value.length <= 120 && SELECTION.exec(value);
  if (!match) {
    throw new PolicyError("请输入明确选定的聊天 UUID 或 thread://UUID?hostId=local 链接", "INVALID_OBSERVER_THREAD", 400);
  }
  return (match[1] || match[2]).toLowerCase();
}

function sourceError(code) {
  const error = new Error("Codex 只读观察源不可用；未记录原始诊断内容");
  error.code = code;
  return error;
}

function bounded(operation, milliseconds, code) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(sourceError(code)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

// This client owns only its app-server process. No user input enters a command.
export function createCodexSource({
  spawnProcess = spawn,
  platform = process.platform,
  rpcTimeoutMs = 5000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  cleanupTimeoutMs = 1500,
  includeUnscopedTrace = false,
  traceReader = createTraceReader({ allowUnscoped: includeUnscopedTrace === true })
} = {}) {
  const windows = platform === "win32";
  const child = windows
    ? spawnProcess("cmd.exe", ["/d", "/s", "/c", "codex.cmd app-server --stdio"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    })
    : spawnProcess("codex", ["app-server", "--stdio"], {
      detached: true, stdio: ["pipe", "pipe", "pipe"]
    });
  const pending = new Map();
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let failure;
  let closing;
  let initialization;
  let codexHome;

  function fail(code) {
    if (!failure) failure = sourceError(code);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
    void close();
  }

  child.on("error", () => fail("OBSERVER_SOURCE_UNAVAILABLE"));
  child.on("exit", () => {
    if (!closed) fail("OBSERVER_SOURCE_CLOSED");
  });
  child.stdin.on("error", () => fail("OBSERVER_SOURCE_CLOSED"));
  // Drain diagnostics without storing or forwarding their contents.
  child.stderr.on("data", () => {});
  child.stderr.on("error", () => fail("OBSERVER_SOURCE_CLOSED"));
  child.stdout.on("error", () => fail("OBSERVER_SOURCE_CLOSED"));
  child.stdout.on("data", chunk => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length + bytes.length > maxResponseBytes) {
      fail("OBSERVER_RESPONSE_LIMIT");
      return;
    }
    buffer = Buffer.concat([buffer, bytes]);
    let newline;
    while (!closed && (newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (!line.toString("utf8").trim()) continue;
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        fail("OBSERVER_PROTOCOL_ERROR");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || (Object.hasOwn(message, "jsonrpc") && message.jsonrpc !== "2.0")) {
        fail("OBSERVER_PROTOCOL_ERROR");
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error || !Object.hasOwn(message, "result")) {
        entry.reject(sourceError("OBSERVER_READ_FAILED"));
        if (!entry.optional) {
          fail("OBSERVER_READ_FAILED");
          return;
        }
        continue;
      }
      entry.resolve(message.result);
    }
  });

  function send(message) {
    if (closed || failure) throw failure || sourceError("OBSERVER_SOURCE_CLOSED");
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  function rpc(method, params, optional = false) {
    if (closed || failure) return Promise.reject(failure || sourceError("OBSERVER_SOURCE_CLOSED"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail("OBSERVER_RPC_TIMEOUT"), rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer, optional });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch {
        fail("OBSERVER_SOURCE_CLOSED");
      }
    });
  }

  async function close() {
    if (closing) return closing;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure || sourceError("OBSERVER_SOURCE_CLOSED"));
    }
    pending.clear();
    buffer = Buffer.alloc(0);
    closing = (async () => {
      let cleanupFailed = false;
      try {
        if (Number.isSafeInteger(child.pid) && child.pid > 0) {
          if (windows) {
            // Kill the owned wrapper and descendants, including codex.cmd's child.
            await new Promise(resolve => {
              let settled = false;
              let killer;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(() => {
                cleanupFailed = true;
                try { killer?.kill(); } catch { /* owned helper already exited */ }
                finish();
              }, cleanupTimeoutMs);
              try {
                killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
                  windowsHide: true, stdio: "ignore"
                });
                killer.once("error", () => { cleanupFailed = true; finish(); });
                killer.once("exit", code => {
                  // taskkill reports failure when the owned process already exited.
                  if (code !== 0 && child.exitCode === null) cleanupFailed = true;
                  finish();
                });
              } catch {
                cleanupFailed = true;
                finish();
              }
            });
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") cleanupFailed = true;
            }
          }
        }
      } finally {
        try { child.kill(); } catch { /* owned process already exited */ }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      return { cleanupFailed };
    })();
    return closing;
  }

  return {
    async readTurns(threadId) {
      // Validate again at the source boundary, including direct injected-client use.
      const id = selectedThread(threadId);
      if (!initialization) {
        initialization = rpc("initialize", {
          clientInfo: { name: "agent_tool_center_observer", version: "0.1.0" },
          capabilities: {}
        }).then(result => {
          codexHome = typeof result?.codexHome === "string" ? result.codexHome : undefined;
          send({ jsonrpc: "2.0", method: "initialized" });
        });
      }
      await initialization;
      const result = await rpc("thread/turns/list", {
        threadId: id, limit: 20, sortDirection: "desc", itemsView: "full"
      });
      let supplement;
      if (codexHome && Array.isArray(result?.data) && result.data.length <= 20) {
        try {
          const metadata = await rpc("thread/read", { threadId: id }, true);
          supplement = await traceReader({
            codexHome, threadId: id, thread: metadata?.thread,
            turnIds: result.data.map(turn => turn.id)
          });
        } catch {
          // Missing raw history must not suppress structured terminal coverage.
        }
      }
      if (!Array.isArray(result?.data)) return result;
      const rawItems = Array.isArray(supplement?.items) ? supplement.items : [];
      return {
        ...result,
        traceCoverage: traceCoverage(supplement?.coverage, includeUnscopedTrace === true),
        ...(includeUnscopedTrace === true ? {
          unscopedTraceItems: rawItems.filter(item =>
            item?.turnId === null && item.scope === "thread_tail")
        } : {}),
        data: result.data.map(turn => {
          if (!Array.isArray(turn.items)) return turn;
          const represented = new Set(turn.items.flatMap(item =>
            [item?.id, item?.callId, item?.call_id].filter(value => typeof value === "string")));
          const extra = rawItems.filter(item => {
            if (item?.turnId !== turn.id || represented.has(item.id)) return false;
            represented.add(item.id);
            return true;
          });
          return { ...turn, items: [...turn.items, ...extra] };
        })
      };
    },
    close
  };
}

function traceCoverage(value, includeUnscoped = false) {
  return {
    available: value?.available === true,
    truncated: value?.truncated === true,
    maxBytes: TRACE_MAX_BYTES,
    skippedLines: Number.isSafeInteger(value?.skippedLines) && value.skippedLines >= 0
      ? value.skippedLines : 0,
    ...(includeUnscoped ? {
      unscopedItems: Number.isSafeInteger(value?.unscopedItems) && value.unscopedItems >= 0
        ? value.unscopedItems : 0
    } : {})
  };
}

function milliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sourceTime(value) {
  const ms = milliseconds(value);
  if (ms === undefined || ms > 8640000000000000) return undefined;
  return new Date(ms).toISOString();
}

function mcpMetadata(threadId, turnId, item) {
  if (item?.type !== "mcpToolCall" || !safe(SAFE_ID, item.id) ||
      !safe(SAFE_NAME, item.server) || !safe(SAFE_NAME, item.tool)) return null;
  let status;
  if (item.status === "inProgress") status = "running";
  else if (item.status === "completed") status = "completed";
  else if (item.status === "failed") status = "failed";
  else return null;
  const at = sourceTime(status === "running" ? item.startedAtMs : item.completedAtMs);
  const startedAt = sourceTime(item.startedAtMs);
  const completedAt = sourceTime(item.completedAtMs);
  const durationMs = milliseconds(item.durationMs);
  return {
    source: "codex-observer", controllability: "observable",
    toolId: "codex.native.mcp", threadId, turnId, callId: item.id,
    serverName: item.server, toolName: item.tool,
    status, sourceStatus: item.status,
    ...(at ? { at } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs, elapsedMs: durationMs } : {}),
    timestampSource: at ? "source" : "observation"
  };
}

function terminalMetadata(threadId, turnId, item) {
  if (item?.type !== "commandExecution" || !SAFE_ID.test(item.id || "")) return null;
  const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
  let status;
  if (item.status === "inProgress") status = "running";
  else if (item.status === "declined") status = "denied";
  else if (item.status === "failed") status = "failed";
  else if (item.status === "completed" && exitCode !== undefined) {
    status = exitCode === 0 ? "succeeded" : "failed";
  } else return null;
  const at = sourceTime(status === "running" ? item.startedAtMs : item.completedAtMs);
  const durationMs = milliseconds(item.durationMs) ?? milliseconds(item.duration);
  return {
    source: "codex-observer", controllability: "observable",
    toolId: "codex.native.terminal", threadId, turnId, callId: item.id,
    status, sourceStatus: item.status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs, elapsedMs: durationMs } : {}),
    ...(at ? { at } : {}),
    ...(sourceTime(item.startedAtMs) ? { startedAt: sourceTime(item.startedAtMs) } : {}),
    ...(sourceTime(item.completedAtMs) ? { completedAt: sourceTime(item.completedAtMs) } : {}),
    timestampSource: at ? "source" : "observation"
  };
}

function observedMetadata(threadId, turnId, item, turnScoped = true) {
  if (item?.type !== "observedToolCall" || item.turnId !== turnId ||
      (!turnScoped && (turnId !== null || item.scope !== "thread_tail")) ||
      (turnScoped && item.scope === "thread_tail") ||
      !safe(SAFE_ID, item.id) ||
      !["function_call", "custom_tool_call"].includes(item.rawKind) ||
      !safe(SAFE_NAME, item.toolName) ||
      !["queued", "completed"].includes(item.status)) return null;
  const value = item.sourceTimestamp;
  const at = typeof value === "string" && value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString() : undefined;
  return {
    source: "codex-observer", controllability: "observable",
    toolId: item.rawKind === "custom_tool_call" ? "codex.recorded.custom" : "codex.recorded.function",
    threadId, turnId, callId: item.id, rawKind: item.rawKind, toolName: item.toolName,
    ...(!turnScoped ? { scope: "thread_tail" } : {}),
    status: item.status, sourceStatus: item.status === "completed" ? "returned" : "recorded",
    ...(at ? { at } : {}),
    timestampSource: at ? "source" : "observation"
  };
}

const SOURCE_CODES = new Set([
  "OBSERVER_SOURCE_UNAVAILABLE", "OBSERVER_SOURCE_CLOSED", "OBSERVER_RESPONSE_LIMIT",
  "OBSERVER_PROTOCOL_ERROR", "OBSERVER_READ_FAILED", "OBSERVER_RPC_TIMEOUT"
]);

export function createCodexObserver({
  publish,
  includeMcp = false,
  includeUnscopedTrace = false,
  createSource = () => createCodexSource({ includeUnscopedTrace }),
  pollIntervalMs = 2000,
  readTimeoutMs = 10000,
  maxSeen = 4000
}) {
  const seen = new Set();
  let state = "stopped";
  let threadId = null;
  let source;
  let timer;
  let generation = 0;
  let inFlight;
  let closing;
  let lastErrorCode = null;
  let lastReadAt = null;
  let coverage = { limit: 20, turnCount: 0, hasMore: false };
  let skippedItems = 0;
  let cleanupFailed = false;

  const getStatus = () => ({
    source: "codex-observer", controllability: "observable",
    state, enabled: state === "starting" || state === "observing",
    threadId, pollIntervalMs, lastReadAt, lastErrorCode, cleanupFailed,
    coverage: { ...coverage }, skippedItems,
    notice: "只读观察：覆盖选定聊天最近 20 轮的原生终端及已记录 function/custom 工具元数据；补充记录最多读取末尾 2MiB，可能不完整。已返回不代表成功；不能阻止 Codex 原生调用。" +
      (includeMcp === true ? " 桌面模式还观察真实 MCP 调用元数据。" : "") +
      (includeUnscopedTrace === true ? " 本聊天末尾首个轮次锚点之前的记录标为轮次未知，不归入最近 20 轮。" : "")
  });

  async function closeSource() {
    if (closing) return closing;
    const owned = source;
    source = undefined;
    closing = (async () => {
      if (!owned) return;
      try {
        const result = await bounded(Promise.resolve().then(() => owned.close()), 3000, "OBSERVER_CLEANUP_FAILED");
        cleanupFailed = Boolean(result?.cleanupFailed);
      } catch {
        cleanupFailed = true;
      }
    })();
    try { await closing; } finally { closing = undefined; }
  }

  async function readOnce(token) {
    try {
      const result = await bounded(
        Promise.resolve().then(() => source.readTurns(threadId)),
        readTimeoutMs, "OBSERVER_RPC_TIMEOUT"
      );
      if (token !== generation) return;
      // Bound injected sources as well as the stdio transport.
      const encoded = JSON.stringify(result);
      if (!encoded || Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw sourceError("OBSERVER_RESPONSE_LIMIT");
      if (!result || !Array.isArray(result.data) || result.data.length > 20 ||
          result.data.some(turn => !turn || !SAFE_ID.test(turn.id || "") || !Array.isArray(turn.items))) {
        throw sourceError("OBSERVER_PROTOCOL_ERROR");
      }
      const recordedAt = new Date().toISOString();
      let skipped = 0;
      for (const turn of result.data) {
        for (const item of turn.items) {
          if (!["commandExecution", "observedToolCall"].includes(item?.type) &&
              !(includeMcp === true && item?.type === "mcpToolCall")) continue;
          // Structured items take precedence if an injected source also supplies a duplicate.
          if (item.type === "observedToolCall" && turn.items.some(other =>
            other?.type !== "observedToolCall" &&
            [other?.id, other?.callId, other?.call_id].includes(item.id))) continue;
          const event = item.type === "commandExecution"
            ? terminalMetadata(threadId, turn.id, item)
            : item.type === "mcpToolCall"
            ? mcpMetadata(threadId, turn.id, item)
            : observedMetadata(threadId, turn.id, item);
          if (!event) { skipped++; continue; }
          const key = JSON.stringify([threadId, turn.id, event.callId, event.status]);
          if (seen.has(key)) continue;
          seen.add(key);
          while (seen.size > maxSeen) seen.delete(seen.values().next().value);
          publish({ ...event, recordedAt });
        }
      }
      if (includeUnscopedTrace === true && Array.isArray(result.unscopedTraceItems)) {
        for (const item of result.unscopedTraceItems) {
          const event = observedMetadata(threadId, null, item, false);
          if (!event) { skipped++; continue; }
          const key = JSON.stringify([threadId, null, event.callId, event.status]);
          if (seen.has(key)) continue;
          seen.add(key);
          while (seen.size > maxSeen) seen.delete(seen.values().next().value);
          publish({ ...event, recordedAt });
        }
      }
      lastReadAt = recordedAt;
      lastErrorCode = null;
      skippedItems = skipped;
      coverage = {
        limit: 20, turnCount: result.data.length, hasMore: Boolean(result.nextCursor),
        raw: traceCoverage(result.traceCoverage, includeUnscopedTrace === true)
      };
      state = "observing";
    } catch (error) {
      if (token !== generation) return;
      lastErrorCode = SOURCE_CODES.has(error?.code) ? error.code : "OBSERVER_READ_FAILED";
      state = "error";
      await closeSource();
    }
  }

  function poll() {
    if (inFlight) return inFlight;
    if (state !== "observing" && state !== "starting") return Promise.resolve();
    clearTimeout(timer);
    const token = generation;
    inFlight = readOnce(token).finally(() => {
      inFlight = undefined;
      if (token === generation && state === "observing") {
        timer = setTimeout(() => { void poll(); }, pollIntervalMs);
        timer.unref?.();
      }
    });
    return inFlight;
  }

  return {
    getStatus,
    poll,
    async start(body) {
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, "threadId")) {
        throw new PolicyError("观察接口仅接受 threadId", "INVALID_OBSERVER_INPUT", 400);
      }
      const selected = selectedThread(body.threadId);
      if (state === "starting" || state === "observing" || state === "stopping" || inFlight || closing) {
        throw new PolicyError("请先停止当前观察，再选择聊天", "OBSERVER_BUSY", 409);
      }
      if (cleanupFailed) {
        throw new PolicyError("上次观察进程清理未确认，请重启服务后重试", "OBSERVER_CLEANUP_FAILED", 409);
      }
      generation++;
      threadId = selected;
      lastErrorCode = null;
      lastReadAt = null;
      skippedItems = 0;
      coverage = { limit: 20, turnCount: 0, hasMore: false };
      state = "starting";
      try {
        source = createSource();
      } catch {
        state = "error";
        lastErrorCode = "OBSERVER_SOURCE_UNAVAILABLE";
        return getStatus();
      }
      await poll();
      return getStatus();
    },
    async stop() {
      generation++;
      clearTimeout(timer);
      state = "stopping";
      await closeSource();
      // An injected read may ignore close; its bounded read still owns the slot.
      if (inFlight) await inFlight;
      state = "stopped";
      return getStatus();
    }
  };
}
