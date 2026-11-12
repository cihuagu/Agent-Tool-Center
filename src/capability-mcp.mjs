import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createCapabilityAdvisor, CAPABILITY_ADVISOR_TOOLS } from "./capability-advisor.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));

async function main() {
  let Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
  try {
    ({ Server } = require("@modelcontextprotocol/sdk-v1/server/index.js"));
    ({ StdioServerTransport } = require("@modelcontextprotocol/sdk-v1/server/stdio.js"));
    ({ ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk-v1/types.js"));
  } catch {
    process.stderr.write("项目内官方 MCP SDK 缺失；未自动安装，请查阅聊天内能力选择助手文档。\n");
    process.exitCode = 1;
    return;
  }

  let advisor;
  try {
    advisor = createCapabilityAdvisor();
  } catch {
    process.stderr.write("能力选择助手默认目录无法加载；请检查项目内能力目录文件。\n");
    process.exitCode = 1;
    return;
  }
  let bridge;
  if (process.env.ATC_STATUS_WINDOW === "1") {
    try {
      const { createStatusWindow } = await import("./status-window.mjs");
      const { selectedThread } = await import("./codex-observer.mjs");
      let threadId = null;
      if (process.env.ATC_STATUS_THREAD_ID !== undefined) {
        try { threadId = selectedThread(process.env.ATC_STATUS_THREAD_ID); }
        catch { process.stderr.write("原生状态窗观察范围无效；宿主观察未连接。\n"); }
      }
      bridge = createStatusWindow({
        threadId, desktopMode: process.env.ATC_STATUS_DESKTOP_CONTEXT === "1"
      });
      void bridge.start().catch(() => {
        process.stderr.write("原生状态窗显示通道不可用；聊天仍可继续。\n");
      });
    } catch {
      process.stderr.write("原生状态窗显示通道不可用；聊天仍可继续。\n");
    }
  }
  const input = new PassThrough();
  const transport = new StdioServerTransport(input, process.stdout);
  const server = new Server(
    { name: "agent-tool-center-capability-advisor", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  let lines;
  let closing;

  function close(code = 0) {
    if (closing) return closing;
    process.exitCode = code;
    advisor.close();
    process.removeListener("SIGINT", onEnd);
    process.removeListener("SIGTERM", onEnd);
    closing = Promise.resolve().then(async () => {
      lines?.close();
      const results = await Promise.allSettled([bridge?.close(), server.close()]);
      if (results.some(result => result.status === "rejected")) process.exitCode = 1;
    }).catch(() => {
      process.exitCode = 1;
    }).finally(() => {
      input.destroy();
      process.stdin.pause();
    });
    return closing;
  }

  function onEnd() {
    void close();
  }

  function onFailure() {
    process.stderr.write("能力选择助手运行失败；未记录原始诊断内容。\n");
    void close(1);
  }

  server.onclose = onEnd;
  server.onerror = () => {};
  process.once("SIGINT", onEnd);
  process.once("SIGTERM", onEnd);

  try {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: structuredClone(CAPABILITY_ADVISOR_TOOLS)
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const rawParams = request.params.arguments.rawParams;
      const result = advisor.dispatch(rawParams);
      try { bridge?.accept(rawParams?.name, result); }
      catch { process.stderr.write("原生状态窗显示通道不可用；聊天仍可继续。\n"); }
      return result;
    });
    await server.connect(transport);
    if (closing) return;
    lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    lines.on("line", line => {
      if (closing) return;
      let routed = line;
      try {
        const message = JSON.parse(line);
        if (message?.method === "tools/call") {
          // Preserve raw params before SDK metadata validation or field stripping.
          // Only this server-created envelope is unwrapped by the handler.
          routed = JSON.stringify({
            ...message,
            params: {
              name: "compare_capabilities",
              arguments: { rawParams: message.params ?? null }
            }
          });
        }
      } catch {
        // Leave malformed JSON to the SDK without printing the rejected input.
      }
      input.write(`${routed}\n`);
    });
    lines.once("close", onEnd);
    lines.on("error", onFailure);
  } catch {
    onFailure();
    await closing;
  }
}

await main();
