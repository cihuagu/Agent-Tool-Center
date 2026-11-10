import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverTools, runTool } from "./registry.mjs";
import { recommendTools } from "./planner.mjs";
import { chooseTools, PolicyError } from "./policy.mjs";

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

export function createApp() {
  const plans = new Map();
  const events = [];
  const subscribers = new Set();
  let counter = 0;

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

  async function executeTask(plan, taskId, toolIds) {
    for (const toolId of toolIds) {
      const callId = randomUUID();
      const started = Date.now();
      publish({ taskId, planId: plan.id, callId, toolId, status: "running" });
      try {
        const outcome = await runTool(toolId);
        publish({
          taskId, planId: plan.id, callId, toolId, status: "succeeded",
          elapsedMs: Date.now() - started,
          resultSummary: outcome.text
        });
      } catch (error) {
        publish({
          taskId, planId: plan.id, callId, toolId, status: "failed",
          elapsedMs: Date.now() - started,
          error: "命令执行失败：" + String(error.code || error.message).slice(0, 120)
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
      if (req.method === "GET" && pathname === "/api/health") {
        return json(res, 200, {
          status: "ok", service: "Agent Tool Center", version: "0.1.0",
          stage: "phase-0-local-proof", modelConnected: false
        });
      }

      if (req.method === "GET" && pathname === "/api/tools") {
        return json(res, 200, {
          discovery: "verified-local-cli",
          tools: await discoverTools()
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
        const tools = await discoverTools();
        const candidates = recommendTools(task, tools);
        const id = randomUUID();
        const plan = {
          id, candidates, used: false,
          expiresAt: Date.now() + 10 * 60 * 1000
        };
        // Bounded temporary plan storage.
        if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
        plans.set(id, plan);
        return json(res, 200, {
          planId: id, candidates, discovery: "verified-local-cli",
          recommendationEngine: "keyword-rules-not-ai",
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
          toolIds = chooseTools(plan, body.mode, body.toolIds);
        } catch (error) {
          publish({
            taskId: null, planId: typeof body.planId === "string" ? body.planId : null,
            status: "denied", error: error.message
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
          executeTask(plan, taskId, toolIds).catch(error =>
            publish({ taskId, planId: plan.id, status: "failed", error: "调度器错误：" + error.message }));
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
      if (error instanceof PolicyError || error.code === "INVALID_TASK") {
        return json(res, error.status || 400, { error: error.message, code: error.code });
      }
      console.error("request error:", error);
      return json(res, 500, { error: "服务发生错误" });
    }
  });

  return {
    server,
    getEvents: () => [...events]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    console.log("Agent Tool Center local: http://127.0.0.1:" + port);
    console.log("Phase 0: only verified read-only CLI; AI/MCP/ChatGPT interception NOT connected.");
  });
}
