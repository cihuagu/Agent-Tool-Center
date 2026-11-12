import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverTools, runTool } from "./registry.mjs";
import { planTools } from "./planner.mjs";
import { chooseTools, PolicyError } from "./policy.mjs";
import { createMcpHub, MCP_TOOL_ID } from "./mcphub-adapter.mjs";
import { DEFINITIONS } from "./registry.mjs";
import { createCodexMcp } from "./codex-mcp.mjs";
import { createCodexObserver } from "./codex-observer.mjs";

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"]
});
const MAX_PLANS = 100;
const MAX_EVENTS = 150;

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

async function readJSON(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new PolicyError("需要 application/json 请求", "CONTENT_TYPE", 415);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) {
      throw new PolicyError("请求过大", "BODY_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw Error("object");
    return obj;
  } catch {
    throw new PolicyError("非法 JSON 请求体", "INVALID_JSON", 400);
  }
}

export function createApp({ mcp = createMcpHub(), recommender, codexRunner, observerSource, projectGitRunner, approvalTimeoutMs, planApprovalTimeoutMs } = {}) {
  const plans = new Map();
  const events = [];
  const subscribers = new Set();
  let counter = 0;
  let currentPlanId;
  const fixedIds = new Set([...DEFINITIONS.map(tool => tool.id), MCP_TOOL_ID]);
  const catalog = async () => [...await discoverTools(), await mcp.discover()];

  async function authorize(toolIds) {
    for (const id of toolIds) {
      if (!fixedIds.has(id)) throw new PolicyError("执行器拒绝未经授权的工具", "TOOL_NOT_ALLOWED");
      if (id === MCP_TOOL_ID) {
        try { await mcp.authorize(id); }
        catch { throw new PolicyError("MCP 工具不可用或未获执行授权", "MCP_DENIED"); }
      }
    }
  }

  function publish(event) {
    const entry = {
      id: ++counter,
      at: new Date().toISOString(),
      ...event
    };
    events.push(entry);
    if (events.length > MAX_EVENTS) events.shift();
    const bytes = "id: " + entry.id + "\nevent: tool\ndata: " + JSON.stringify(entry) + "\n\n";
    for (const sub of subscribers) {
      try { sub.write(bytes); } catch { subscribers.delete(sub); }
    }
    return entry;
  }

  const codex = createCodexMcp({
    publish, run: codexRunner, projectRunner: projectGitRunner, approvalTimeoutMs, planApprovalTimeoutMs
  });
  const observer = createCodexObserver({ publish, createSource: observerSource });

  async function executeTask(plan, taskId, toolIds) {
    for (const toolId of toolIds) {
      const callId = randomUUID();
      const started = Date.now();
      publish({ taskId, planId: plan.id, callId, toolId, status: "running" });
      try {
        const outcome = toolId === MCP_TOOL_ID ? await mcp.call(toolId) : await runTool(toolId);
        publish({
          taskId, planId: plan.id, callId, toolId, status: "succeeded",
          elapsedMs: Date.now() - started,
          resultSummary: outcome.text
        });
      } catch (error) {
        publish({
          taskId, planId: plan.id, callId, toolId, status: "failed",
          elapsedMs: Date.now() - started,
          errorCode: ["MCP_TIMEOUT", "MCP_TOOL_ERROR", "MCP_PROTOCOL_ERROR", "MCP_DENIED", "MCP_UNAVAILABLE"].includes(error.code)
            ? error.code : "TOOL_FAILED",
          error: error.code === "MCP_TIMEOUT" ? "MCP 调用超时" : "工具调用失败；未记录原始诊断内容"
        });
      }
    }
    publish({ taskId, planId: plan.id, status: "completed", toolCount: toolIds.length });
  }

  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return json(res, 403, { error: "只接受本地请求" });
    }
    const origin = req.headers.origin;
    if (origin && origin !== "http://" + host) {
      return json(res, 403, { error: "跨站请求未获允许" });
    }

    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    try {
      if (req.method === "GET" && pathname === "/api/codex/plans") {
        return json(res, 200, codex.getPlans());
      }

      if (req.method === "POST" &&
          ["/api/codex/plans/decision", "/api/codex/plans/cancel"].includes(pathname)) {
        if (origin !== "http://" + host) {
          throw new PolicyError("计划操作仅接受本机面板同源请求", "PLAN_ORIGIN", 403);
        }
        const body = await readJSON(req);
        return json(res, 200, pathname.endsWith("/decision")
          ? codex.decidePlan(body) : codex.cancelPlan(body));
      }

      if (req.method === "GET" && pathname === "/api/codex/approvals") {
        return json(res, 200, codex.getApprovals());
      }

      if (req.method === "POST" && pathname === "/api/codex/approvals/decision") {
        if (origin !== "http://" + host) {
          throw new PolicyError("本次确认仅接受本机面板同源请求", "APPROVAL_ORIGIN", 403);
        }
        return json(res, 200, codex.decideApproval(await readJSON(req)));
      }

      if (req.method === "GET" && pathname === "/api/codex/observer/status") {
        return json(res, 200, observer.getStatus());
      }

      if (req.method === "POST" &&
          ["/api/codex/observer/start", "/api/codex/observer/stop"].includes(pathname)) {
        if (origin !== "http://" + host) {
          throw new PolicyError("观察变更仅接受本机面板同源请求", "OBSERVER_ORIGIN", 403);
        }
        const body = await readJSON(req);
        if (pathname.endsWith("/start")) return json(res, 200, await observer.start(body));
        if (Object.keys(body).length) {
          throw new PolicyError("停止观察仅接受空对象", "INVALID_OBSERVER_INPUT", 400);
        }
        return json(res, 200, await observer.stop());
      }

      if (pathname === "/mcp/codex") {
        if (!["POST", "GET", "DELETE"].includes(req.method)) {
          return json(res, 405, { error: "此 MCP 入口仅接受 POST、GET 或 DELETE" });
        }
        await codex.handle(req, res, req.method === "POST" ? await readJSON(req) : undefined);
        return;
      }

      if (req.method === "GET" && pathname === "/api/codex/policy") {
        return json(res, 200, codex.getPolicy());
      }

      if (req.method === "POST" && pathname === "/api/codex/policy") {
        if (origin !== "http://" + host) throw new PolicyError("授权变更仅接受本机面板同源请求", "CODEX_POLICY_ORIGIN");
        return json(res, 200, codex.setPolicy(await readJSON(req)));
      }

      if (req.method === "GET" && pathname === "/api/health") {
        return json(res, 200, {
          status: "ok", service: "Agent Tool Center", version: "0.1.0",
          stage: "phase-0-local-proof", modelConnected: false
        });
      }

      if (req.method === "GET" && pathname === "/api/tools") {
        return json(res, 200, {
          discovery: "verified-local-cli",
          tools: await catalog(),
          mcpIntegration: "mcphub-local-fixture"
        });
      }

      if (req.method === "GET" && pathname === "/api/history") {
        return json(res, 200, { events: events.slice(-MAX_EVENTS) });
      }

      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(": connected\n\n");
        subscribers.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { clearInterval(heartbeat); subscribers.delete(res); }
        }, 20000);
        res.on("close", () => {
          clearInterval(heartbeat);
          subscribers.delete(res);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/plan") {
        const body = await readJSON(req);
        const task = body.task;
        const tools = await catalog();
        const { candidates, recommendationEngine } = await planTools(task, tools, recommender);
        const id = randomUUID();
        const plan = {
          id, candidates, used: false,
          expiresAt: Date.now() + 10 * 60 * 1000
        };
        // Bounded temporary plan storage.
        if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
        plans.set(id, plan);
        currentPlanId = id;
        return json(res, 200, {
          planId: id, candidates, discovery: "verified-local-cli",
          recommendationEngine,
          expiresAt: new Date(plan.expiresAt).toISOString(),
          notice: candidates.some(item => item.recommended)
            ? "当前推荐为关键词规则，不是模型决策。"
            : "当前接入工具与该任务不匹配，自动模式不会执行任何工具。"
        });
      }

      if (req.method === "POST" && pathname === "/api/execute") {
        const body = await readJSON(req);
        const plan = plans.get(body.planId);
        let toolIds;
        try {
          if (plan && plan.id !== currentPlanId) throw new PolicyError("计划已被新方案替代，请重新生成", "PLAN_SUPERSEDED", 409);
          toolIds = chooseTools(plan, body.mode, body.toolIds);
          if (Object.keys(body).some(key => !["planId", "mode", "toolIds"].includes(key))) {
            throw new PolicyError("执行接口不接受命令、参数或额外授权", "INVALID_EXECUTION_INPUT", 400);
          }
          await authorize(toolIds);
          // Authorization is asynchronous: recheck one-time use and current-plan identity.
          if (plan.id !== currentPlanId) throw new PolicyError("计划已被新方案替代", "PLAN_SUPERSEDED", 409);
          chooseTools(plan, body.mode, body.toolIds);
        } catch (error) {
          publish({
            taskId: null, planId: plan?.id ?? null,
            status: "denied", error: error instanceof PolicyError ? error.message : "执行授权检查失败",
            errorCode: error instanceof PolicyError ? error.code : "TOOL_NOT_ALLOWED"
          });
          throw error;
        }
        plan.used = true;
        const taskId = randomUUID();
        publish({
          taskId, planId: plan.id, status: "queued", toolCount: toolIds.length,
          mode: body.mode
        });
        json(res, 202, { taskId, planId: plan.id, status: "accepted", toolIds });
        setImmediate(() => {
          executeTask(plan, taskId, toolIds).catch(() =>
            publish({ taskId, planId: plan.id, status: "failed", errorCode: "SCHEDULER_FAILED", error: "调度器错误" }));
        });
        return;
      }

      if (req.method === "GET" && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        const body = await readFile(path.join(BASE, "public", file));
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        });
        res.end(body);
        return;
      }

      return json(res, 404, { error: "路径不存在" });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof PolicyError || error.code === "INVALID_TASK") {
        return json(res, error.status || 400, { error: error.message, code: error.code });
      }
      console.error("request error: INTERNAL_ERROR");
      return json(res, 500, { error: "服务发生错误" });
    }
  });
  server.once("close", () => { void codex.close(); void observer.stop(); void mcp.close(); });

  return {
    server,
    getEvents: () => [...events],
    close: async () => { await codex.close(); await observer.stop(); await mcp.close(); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    console.log("Agent Tool Center local: http://127.0.0.1:" + port);
    console.log("本机只读 CLI + MCPHub fixture；Codex MCP：/mcp/codex（默认禁用）。未接入大模型或宿主内置工具。");
  });
  const shutdown = async () => {
    const closing = app.close();
    app.server.closeAllConnections();
    app.server.close();
    await closing;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
