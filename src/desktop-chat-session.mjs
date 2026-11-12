import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
  transportFactory = createTransport
} = {}) {
  if (typeof threadId !== "string" || threadId.length !== 36 || !UUID.test(threadId)) {
    throw failure("INVALID_DESKTOP_THREAD");
  }
  const id = threadId.toLowerCase();
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
    getBinding, start, close,
    async call(name, args) {
      if (typeof name !== "string" || !TOOLS.has(name)) {
        throw failure("DESKTOP_TOOL_NOT_ALLOWED");
      }
      if (closed) throw failure("DESKTOP_SESSION_CLOSED");
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
