import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOLS = new Set([
  "list_capabilities", "refresh_capabilities", "compare_capabilities",
  "select_capability", "report_capability_use", "report_task_status"
]);
const project = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("./capability-mcp.mjs", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const failure = code => Object.assign(new Error("当前桌面聊天助手不可用；未记录原始诊断内容"), { code });

function createClient() {
  const { Client } = require("@modelcontextprotocol/sdk-v1/client/index.js");
  return new Client(
    { name: "agent-tool-center-desktop-chat", version: "0.1.0" },
    { capabilities: {} }
  );
}

function createTransport({ threadId }) {
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk-v1/client/stdio.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [entry],
    cwd: project,
    env: {
      ATC_STATUS_WINDOW: "1",
      ATC_STATUS_THREAD_ID: threadId,
      ATC_STATUS_DESKTOP_CONTEXT: "1"
    },
    stderr: "pipe"
  });
  transport.stderr?.on("data", () => {});
  transport.stderr?.on("error", () => {});
  return transport;
}

export function createDesktopChatSession({
  threadId,
  clientFactory = createClient,
  transportFactory = createTransport,
  modeStateDirectory = join(project, ".cache", "desktop-chat-modes")
} = {}) {
  if (typeof threadId !== "string" || threadId.length !== 36 || !UUID.test(threadId)) {
    throw failure("INVALID_DESKTOP_THREAD");
  }
  const id = threadId.toLowerCase();
  const modes = new Set(["manual", "recommend", "auto"]);
  const cache = resolve(project, ".cache");
  if (typeof modeStateDirectory !== "string") {
    throw failure("DESKTOP_MODE_STORAGE_FAILED");
  }
  const directory = resolve(modeStateDirectory);
  const withinCache = relative(cache, directory);
  if (isAbsolute(withinCache) || withinCache === ".." || withinCache.startsWith(`..${sep}`)) {
    throw failure("DESKTOP_MODE_STORAGE_FAILED");
  }
  const record = join(directory, `${id}.json`);
  const modeSnapshot = mode => ({ mode, scope: "current_chat", threadId: id });

  async function checkDirectory(create) {
    let current = project;
    for (const part of relative(project, directory).split(sep)) {
      current = join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        try {
          await fs.mkdir(current);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw failure("DESKTOP_MODE_STORAGE_FAILED");
      }
    }
    return true;
  }

  async function readMode() {
    if (!await checkDirectory(false)) return "auto";
    let stat;
    try {
      stat = await fs.lstat(record);
    } catch (error) {
      if (error.code === "ENOENT") return "auto";
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw failure("DESKTOP_MODE_STORAGE_FAILED");
    }
    const state = JSON.parse(await fs.readFile(record, "utf8"));
    if (!state || Array.isArray(state) || state.version !== 1 ||
        !modes.has(state.mode) || Object.keys(state).length !== 2) {
      throw failure("DESKTOP_MODE_STORAGE_FAILED");
    }
    return state.mode;
  }

  async function getMode() {
    try {
      return modeSnapshot(await readMode());
    } catch {
      throw failure("DESKTOP_MODE_STORAGE_FAILED");
    }
  }

  async function setMode(mode) {
    if (!modes.has(mode)) throw failure("DESKTOP_MODE_INVALID");
    let temporary;
    let handle;
    try {
      await checkDirectory(true);
      await readMode();
      const candidate = join(directory, `.${id}.${randomUUID()}.tmp`);
      handle = await fs.open(candidate, "wx", 0o600);
      temporary = candidate;
      await handle.writeFile(JSON.stringify({ version: 1, mode }), "utf8");
      await handle.close();
      handle = undefined;
      // Recheck the destination before replacing an existing record.
      await readMode();
      await fs.rename(temporary, record);
      temporary = undefined;
      return modeSnapshot(mode);
    } catch {
      throw failure("DESKTOP_MODE_STORAGE_FAILED");
    } finally {
      let cleanupFailed = false;
      if (handle) {
        try { await handle.close(); } catch { cleanupFailed = true; }
      }
      if (temporary) {
        try { await fs.unlink(temporary); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw failure("DESKTOP_MODE_STORAGE_FAILED");
    }
  }

  const getBinding = () => ({
    threadId: id, bindingSource: "host_tool_context", controlLevel: "advice_only"
  });
  let client;
  let transport;
  let starting;
  let closing;
  let closed = false;
  let cancelStart;
  let connectTimer;

  function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(connectTimer);
    cancelStart?.();
    // Begin resource reclamation before waiting for any handshake operation.
    const resources = [client, transport].filter(Boolean);
    closing = (async () => {
      let timer;
      try {
        return await Promise.race([
          Promise.allSettled(resources.map(resource =>
            Promise.resolve().then(() => resource.close())
          )).then(results => ({
            cleanupFailed: results.some(result =>
              result.status === "rejected" || result.value?.cleanupFailed === true)
          })),
          new Promise(resolve => {
            timer = setTimeout(() => resolve({ cleanupFailed: true }), 4500);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  }

  function start() {
    if (closed) return Promise.reject(failure("DESKTOP_SESSION_CLOSED"));
    if (starting) return starting;
    const cancelled = new Promise((_, reject) => {
      cancelStart = () => reject(failure("DESKTOP_SESSION_CLOSED"));
    });
    const timeout = new Promise((_, reject) => {
      connectTimer = setTimeout(() => reject(failure("DESKTOP_CONNECT_TIMEOUT")), 10000);
    });
    const handshake = Promise.resolve().then(async () => {
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      client = clientFactory();
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      transport = transportFactory({ threadId: id });
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      await client.connect(transport);
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      const result = await client.listTools();
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      const names = result?.tools;
      if (!Array.isArray(names) || names.length !== TOOLS.size ||
          !names.every(tool => typeof tool?.name === "string" && TOOLS.has(tool.name)) ||
          new Set(names.map(tool => tool.name)).size !== TOOLS.size) {
        throw failure("DESKTOP_TOOL_SET_INVALID");
      }
      return getBinding();
    });
    starting = Promise.race([handshake, cancelled, timeout])
      .catch(async () => {
        const code = closed ? "DESKTOP_SESSION_CLOSED" : "DESKTOP_START_FAILED";
        await close();
        throw failure(code);
      })
      .finally(() => {
        clearTimeout(connectTimer);
        cancelStart = undefined;
      });
    return starting;
  }

  return {
    getBinding, start, close, getMode, setMode,
    async call(name, args) {
      if (typeof name !== "string" || !TOOLS.has(name)) {
        throw failure("DESKTOP_TOOL_NOT_ALLOWED");
      }
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      if (name === "compare_capabilities") {
        const { mode } = await getMode();
        if (args != null && Object.hasOwn(args, "mode") && args.mode !== mode) {
          throw failure("DESKTOP_MODE_CONFLICT");
        }
        args = { ...args, mode };
      }
      await start();
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
      try {
        return await client.callTool({ name, arguments: args });
      } catch {
        throw failure("DESKTOP_CALL_FAILED");
      }
    }
  };
}
