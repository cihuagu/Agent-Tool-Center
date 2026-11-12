import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const HUB_COMMIT = "de0b22a5eca99180cdd18deb3be4a057678ed00d";
export const MCP_TOOL_ID = "mcp.fixture.read";
export const MCP_INFO = Object.freeze({
  id: MCP_TOOL_ID, name: "MCP 本地只读验证", kind: "mcp",
  provider: "MCPHub v1.2.2 / 本地 fixture", source: "mcphub-local-fixture",
  serviceId: "fixture", upstreamTool: "read", commit: HUB_COMMIT,
  description: "经 MCPHub 读取固定测试值；测试服务不代表第三方账户已接入",
  risk: "read", controllability: "controlled",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  dependency: ".cache/mcphub-eval 的固定版本、已安装依赖及编译产物；新克隆需先准备"
});
const BASE = fileURLToPath(new URL("../", import.meta.url));
const HUB = path.join(BASE, ".cache", "mcphub-eval");
const WORKER = fileURLToPath(new URL("./mcphub-worker.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

function mcpError(code) {
  return Object.assign(new Error("MCP 调用未完成"), { code });
}

// Options are for trusted in-process tests only; HTTP never supplies them.
export function createMcpHub({ fixtureCase = {} } = {}) {
  let child, starting, closed = false, directory, sequence = 0;
  const pending = new Map();
  const failPending = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(mcpError("MCP_UNAVAILABLE")); }
    pending.clear();
  };
  async function stopWorker() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ method: "stop" }, () => {}); else child.kill();
    });
  }
  function request(method) {
    if (!child?.connected) return Promise.reject(mcpError("MCP_UNAVAILABLE"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(mcpError("MCP_TIMEOUT"));
      }, method === "boot" ? 12000 : 2500);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, method, ...(method === "boot" ? { fixtureCase } : {}) }, error => {
        if (error && pending.has(id)) {
          clearTimeout(timer); pending.delete(id); reject(mcpError("MCP_UNAVAILABLE"));
        }
      });
    });
  }
  async function start() {
    if (closed) throw mcpError("MCP_UNAVAILABLE");
    if (!starting) starting = (async () => {
      const { stdout } = await execFileAsync("git", ["-C", HUB, "rev-parse", "HEAD"], {
        windowsHide: true, timeout: 3000, maxBuffer: 1024
      });
      if (stdout.trim() !== HUB_COMMIT) throw mcpError("MCP_UNAVAILABLE");
      await access(path.join(HUB, "dist", "services", "mcpService.js"));
      await access(path.join(HUB, "node_modules", "@modelcontextprotocol", "client", "package.json"));
      const runs = path.join(BASE, ".cache", "mcphub-integration");
      await mkdir(runs, { recursive: true });
      directory = await mkdtemp(path.join(runs, "run-"));
      child = fork(WORKER, [], {
        cwd: directory, execPath: process.execPath, execArgv: [], silent: true, windowsHide: true,
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), TEMP: directory, TMP: directory }
      });
      // Raw upstream diagnostics are never relayed to the application or its logs.
      child.stdout.resume(); child.stderr.resume();
      child.on("error", failPending);
      child.on("exit", failPending);
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(mcpError("MCP_UNAVAILABLE")), 3000);
        child.on("message", message => {
          if (message?.ready === true) { clearTimeout(timer); resolve(); }
        });
        child.once("exit", () => { clearTimeout(timer); reject(mcpError("MCP_UNAVAILABLE")); });
      });
      child.on("message", message => {
        const item = pending.get(message?.id);
        if (!item) return; // Late replies cannot create an execution event.
        clearTimeout(item.timer); pending.delete(message.id);
        if (message.ok === true) item.resolve(message);
        else item.reject(mcpError(["MCP_TIMEOUT", "MCP_TOOL_ERROR", "MCP_PROTOCOL_ERROR", "MCP_DENIED"].includes(message.code)
          ? message.code : "MCP_UNAVAILABLE"));
      });
      await ready;
      await request("boot");
    })().catch(async () => {
      await stopWorker();
      throw mcpError("MCP_UNAVAILABLE");
    });
    return starting;
  }
  async function check() {
    await start();
    await request("check");
  }
  return {
    async discover() {
      try {
        await check();
        return { ...MCP_INFO, available: true, executable: true, version: "真实 initialize + tools/list 已完成" };
      } catch {
        return { ...MCP_INFO, available: false, executable: false,
          unavailableReason: "MCPHub 运行资源缺失、连接失败或策略拒绝；按 CLI 交接准备后重启面板" };
      }
    },
    async authorize(id) {
      if (id !== MCP_TOOL_ID) throw mcpError("MCP_DENIED");
      await check();
    },
    async call(id) {
      if (id !== MCP_TOOL_ID) throw mcpError("MCP_DENIED");
      await start();
      const result = await request("call");
      if (result.value !== "fixture-ok") throw mcpError("MCP_PROTOCOL_ERROR");
      return { toolId: id, text: "fixture-ok" };
    },
    get runDirectory() { return directory; },
    get pid() { return child?.pid; },
    async close() {
      closed = true;
      if (starting) await starting.catch(() => {});
      failPending();
      await stopWorker();
    }
  };
}
