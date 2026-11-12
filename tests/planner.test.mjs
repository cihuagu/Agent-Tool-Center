import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { recommendTools } from "../src/planner.mjs";
import { createApp } from "../src/server.mjs";
import { MCP_INFO, MCP_TOOL_ID } from "../src/mcphub-adapter.mjs";

async function start(t, options = {}) {
  // Synthetic unavailable MCP discovery; CLI discovery and HTTP routes are real.
  const mcp = {
    discover: async () => ({ ...MCP_INFO, available: false }),
    authorize: async () => assert.fail("不可用 MCP 不应进入授权"),
    call: async () => assert.fail("不可用 MCP 不应被调用"),
    close: async () => {}
  };
  const app = createApp({ mcp, ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close();
  });
  assert.equal(app.server.address().address, "127.0.0.1");
  const base = "http://127.0.0.1:" + app.server.address().port;
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  return { app, request };
}

test("plan route excludes every injected unknown or unavailable candidate", async t => {
  let calls = 0;
  const unknownId = "invented.tool";
  const candidate = { toolId: "runtime.node", recommended: false, reason: "本地测试推荐器" };
  const recommender = {
    engine: "test-local-recommender",
    async recommend(task, tools) {
      calls++;
      assert.equal(task, "检查 Node.js");
      assert.ok(tools.some(tool => tool.id === "runtime.node"));
      assert.ok(tools.every(tool => tool.available === true));
      assert.equal(tools.some(tool => tool.id === MCP_TOOL_ID), false);
      tools.push({ id: unknownId, available: true });
      return [candidate, ...[unknownId, MCP_TOOL_ID].flatMap(toolId =>
        [true, false].map(recommended => ({ toolId, recommended, reason: "无效候选" })))];
    }
  };
  const { app, request } = await start(t, { recommender });
  const planned = await request("/api/plan", { task: "检查 Node.js" });
  assert.equal(planned.status, 200);
  assert.equal(calls, 1, "实际 plan 路由必须使用注入的推荐器");
  assert.equal(planned.data.recommendationEngine, recommender.engine);
  assert.deepEqual(planned.data.candidates, [candidate]);
  for (const toolId of [unknownId, MCP_TOOL_ID]) {
    for (const mode of ["manual", "auto", "mixed"]) {
      const denied = await request("/api/execute", {
        planId: planned.data.planId, mode, toolIds: [toolId]
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.data.code, "TOOL_NOT_ALLOWED");
    }
  }
  const empty = await request("/api/execute", {
    planId: planned.data.planId, mode: "auto", toolIds: []
  });
  assert.equal(empty.status, 422);
  assert.equal(empty.data.code, "NO_TOOL_SELECTED");
  assert.ok(app.getEvents().every(event => event.status === "denied"));
});

test("plan route validates tasks before invoking an injected recommender", async t => {
  let calls = 0;
  const { request } = await start(t, {
    recommender: { engine: "test-local-recommender", recommend() { calls++; return []; } }
  });
  for (const task of [undefined, null, 123, "", "  ", "x".repeat(1501)]) {
    const invalid = await request("/api/plan", { task });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, "INVALID_TASK");
  }
  assert.equal(calls, 0);
});

test("local rules do not invent missing tools or recommend unrelated available tools", () => {
  const task = "检查 Node.js 和 MCP fixture 只读验证";
  assert.deepEqual(recommendTools(task, []), []);
  const tools = [
    { id: "runtime.node", name: "Node.js", available: false },
    { ...MCP_INFO, available: false },
    { id: "runtime.git", name: "Git", available: true }
  ];
  const candidates = recommendTools(task, tools);
  assert.deepEqual(candidates.map(item => item.toolId), ["runtime.git"]);
  assert.equal(candidates[0].recommended, false);
  assert.equal(candidates[0].score, 0);
  assert.equal(candidates[0].reason, "当前任务与该工具没有明确关联；仅作为可用工具展示。");
  assert.deepEqual(recommendTools(task, tools), candidates);
});

test("local API rejects automatic execution for missing or unrelated tools", async t => {
  const { app, request } = await start(t);
  const catalog = await request("/api/tools");
  const availableIds = catalog.data.tools.filter(tool => tool.available).map(tool => tool.id).sort();
  for (const task of ["MCP fixture 只读验证", "绘制一只鲸鱼"]) {
    const planned = await request("/api/plan", { task });
    assert.equal(planned.status, 200);
    assert.equal(planned.data.recommendationEngine, "keyword-rules-not-ai");
    assert.deepEqual(planned.data.candidates.map(item => item.toolId).sort(), availableIds);
    assert.ok(planned.data.candidates.every(item => item.recommended === false));
    assert.equal(planned.data.notice, "当前接入工具与该任务不匹配，自动模式不会执行任何工具。");
    const denied = await request("/api/execute", {
      planId: planned.data.planId, mode: "auto", toolIds: []
    });
    assert.equal(denied.status, 422);
    assert.equal(denied.data.code, "NO_TOOL_SELECTED");
  }
  assert.ok(app.getEvents().every(event => event.status === "denied"));
});

test("local API defaults to deterministic rules without keys and executes real Node", async t => {
  const originalEnv = process.env;
  // Keep only command lookup and Windows runtime variables; never read credentials.
  process.env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    .filter(key => originalEnv[key] !== undefined).map(key => [key, originalEnv[key]]));
  t.after(() => { process.env = originalEnv; });
  const { request } = await start(t);
  const health = await request("/api/health");
  assert.equal(health.data.modelConnected, false);
  const catalog = await request("/api/tools");
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.tools.some(tool => tool.id === "runtime.node" && tool.available === true));
  const task = "检查 Node.js";
  const planned = await request("/api/plan", { task });
  assert.equal(planned.status, 200);
  assert.equal(planned.data.recommendationEngine, "keyword-rules-not-ai");
  assert.equal(planned.data.discovery, "verified-local-cli");
  assert.equal(planned.data.notice, "当前推荐为关键词规则，不是模型决策。");
  assert.deepEqual(planned.data.candidates, recommendTools(task, catalog.data.tools));
  assert.equal(planned.data.candidates.find(item => item.toolId === "runtime.node").reason,
    "规则匹配：任务提到 node、node.js、js，该工具可用于核实对应环境。");
  assert.ok(Number.isFinite(Date.parse(planned.data.expiresAt)));
  const execution = { planId: planned.data.planId, mode: "auto", toolIds: [] };
  const accepted = await request("/api/execute", execution);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.data.toolIds, ["runtime.node"]);
  const replay = await request("/api/execute", execution);
  assert.equal(replay.status, 409);
  assert.equal(replay.data.code, "PLAN_ALREADY_USED");
  let events = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const history = await request("/api/history");
    events = history.data.events.filter(event => event.taskId === accepted.data.taskId);
    if (events.some(event => event.status === "completed")) break;
    await delay(50);
  }
  assert.deepEqual(events.map(event => event.status), ["queued", "running", "succeeded", "completed"]);
  assert.equal(events.find(event => event.status === "succeeded").resultSummary, process.version);
});
