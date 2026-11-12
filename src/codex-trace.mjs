import * as fs from "node:fs/promises";
import path from "node:path";

export const TRACE_MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const SAFE_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/;
const OUTPUT_KIND = {
  function_call_output: "function_call",
  custom_tool_call_output: "custom_tool_call"
};

function timestamp(value) {
  if (typeof value !== "string" || value.length > 32 ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// Only metadata escapes this function. Parsed request and response bodies are discarded.
export function parseTraceTail(bytes, { turnIds, truncated = false, allowUnscoped = false } = {}) {
  const allowed = new Set((turnIds || []).slice(0, 20).filter(id => SAFE_ID.test(id)));
  const calls = new Map();
  const outputs = new Set();
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  if (truncated) lines.shift();
  const partialLastLine = lines.pop();
  let turnId;
  let sawTurnAnchor = false;
  let skippedLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { skippedLines++; continue; }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (record.type === "turn_context" ||
        (record.type === "event_msg" && payload.type === "task_started")) {
      sawTurnAnchor = true;
      turnId = allowed.has(payload.turn_id) ? payload.turn_id : undefined;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      sawTurnAnchor = true;
      if (payload.turn_id === turnId) turnId = undefined;
      continue;
    }
    const unscoped = allowUnscoped === true && !sawTurnAnchor;
    if ((!turnId && !unscoped) || record.type !== "response_item" ||
        typeof payload.call_id !== "string" || !SAFE_ID.test(payload.call_id)) continue;
    const rawKind = OUTPUT_KIND[payload.type] || payload.type;
    if (rawKind !== "function_call" && rawKind !== "custom_tool_call") continue;
    const key = JSON.stringify([unscoped ? null : turnId, payload.call_id, rawKind]);
    if (OUTPUT_KIND[payload.type]) {
      if (calls.has(key)) outputs.add(key);
      continue;
    }
    if (typeof payload.name !== "string" || !SAFE_NAME.test(payload.name) || calls.has(key)) continue;
    const at = timestamp(record.timestamp);
    calls.set(key, {
      type: "observedToolCall", id: payload.call_id, turnId: unscoped ? null : turnId,
      ...(unscoped ? { scope: "thread_tail" } : {}),
      rawKind, toolName: payload.name,
      ...(at ? { sourceTimestamp: at } : {})
    });
  }

  return {
    items: [...calls].map(([key, item]) => ({
      ...item, status: outputs.has(key) ? "completed" : "queued"
    })),
    coverage: {
      available: true, truncated: truncated || Boolean(partialLastLine),
      maxBytes: TRACE_MAX_BYTES, skippedLines,
      ...(allowUnscoped === true ? {
        unscopedItems: [...calls.values()].filter(item => item.turnId === null).length
      } : {})
    }
  };
}

function inside(root, file) {
  const relative = path.relative(
    path.toNamespacedPath(root),
    path.toNamespacedPath(file),
  );
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function namedTrace(file, threadId) {
  return typeof file === "string" && path.isAbsolute(file) &&
    !file.split(/[\\/]/).includes("..") &&
    path.basename(file).toLowerCase().endsWith("-" + threadId.toLowerCase() + ".jsonl");
}

// The only input path comes from thread/read, never from an HTTP path option.
export function createTraceReader({ fileSystem = fs, allowUnscoped = false } = {}) {
  return async ({ codexHome, threadId, thread, turnIds }) => {
    const unavailable = {
      items: [],
      coverage: { available: false, truncated: false, maxBytes: TRACE_MAX_BYTES }
    };
    let handle;
    try {
      if (!UUID.test(threadId || "") || thread?.id !== threadId ||
          typeof codexHome !== "string" || !path.isAbsolute(codexHome) ||
          !namedTrace(thread.path, threadId)) return unavailable;
      const sessions = path.join(codexHome, "sessions");
      if (!inside(sessions, thread.path)) return unavailable;
      const root = await fileSystem.realpath(sessions);
      const file = await fileSystem.realpath(thread.path);
      if (!path.isAbsolute(root) || !inside(root, file) || !namedTrace(file, threadId)) return unavailable;
      handle = await fileSystem.open(file, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) return unavailable;
      const start = Math.max(0, stat.size - TRACE_MAX_BYTES);
      const bytes = Buffer.alloc(Math.min(stat.size, TRACE_MAX_BYTES));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return parseTraceTail(bytes.subarray(0, offset), {
        turnIds, truncated: start > 0, allowUnscoped
      });
    } catch {
      // Do not expose OS errors, metadata paths, or file contents.
      return unavailable;
    } finally {
      try { await handle?.close(); } catch { /* read-only handle cleanup */ }
    }
  };
}
