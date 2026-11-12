import test from "node:test";
import assert from "node:assert/strict";
import { recommendTools } from "../src/planner.mjs";
import { chooseTools, PolicyError } from "../src/policy.mjs";
import { discoverTools } from "../src/registry.mjs";
import { createApp } from "../src/server.mjs";

function planWith(two = true) {
  return {
    id: "demo", used: false, expiresAt: Date.now() + 60000,
    candidates: [
      { toolId: "runtime.node", recommended: true },
      ...(two ? [{ toolId: "runtime.git", recommended: false }] : [])
    ]
  };
}

test("tool discovery reports true availability without invented provider", async () => {
  const tools = await discoverTools();
  assert.equal(tools.length, 2);
  assert.ok(tools.every(t => t.source === "verified-local" && t.kind === "cli"));
  assert.ok(tools.every(t => typeof t.available === "boolean"));
});

test("planner is explicit keyword matching, not a model", () => {
  const tools = [
    { id: "runtime.node", name: "Node.js", available: true },
    { id: "runtime.git", name: "Git", available: true }
  ];
  const picks = recommendTools("检查 Node.js 和 Git 环境", tools);
  assert.equal(picks.filter(p => p.recommended).length, 2);
  const unknown = recommendTools("绘制一只鲸鱼", tools);
  assert.equal(unknown.filter(p => p.recommended).length, 0);
  assert.throws(() => recommendTools("", tools));
});

test("manual mode respects the exact allowed subset", () => {
  assert.deepEqual(chooseTools(planWith(), "manual", ["runtime.git"]), ["runtime.git"]);
  assert.deepEqual(chooseTools(planWith(), "auto", []), ["runtime.node"]);
  assert.deepEqual(chooseTools(planWith(), "mixed", ["runtime.git"]), ["runtime.node", "runtime.git"]);
});

test("policy rejects unauthorized and duplicated tools", () => {
  const plan = planWith();
  assert.throws(
    () => chooseTools(plan, "manual", ["runtime.node", "system.delete"]),
    error => error instanceof PolicyError && error.code === "TOOL_NOT_ALLOWED"
  );
  assert.throws(
    () => chooseTools(plan, "manual", ["runtime.node", "runtime.node"]),
    error => error.code === "INVALID_SELECTION"
  );
  assert.throws(() => chooseTools(plan, "bad-mode", []));
  assert.throws(() => chooseTools(plan, "manual", []));
});

test("policy rejects reused and expired plans", () => {
  const used = planWith(); used.used = true;
  assert.throws(() => chooseTools(used, "auto", []), e => e.code === "PLAN_ALREADY_USED");
  const expired = planWith(); expired.expiresAt = Date.now() - 1;
  assert.throws(() => chooseTools(expired, "auto", []), e => e.code === "PLAN_EXPIRED");
});

test("local HTTP server: real tools, denial, execution and one-time plan", async t => {
  const app = createApp();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const port = app.server.address().port;
  const base = "http://127.0.0.1:" + port;

  async function get(path) {
    const response = await fetch(base + path);
    return [response.status, await response.json()];
  }

  async function post(path, body) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return [response.status, await response.json()];
  }

  assert.equal((await get("/api/health"))[1].modelConnected, false);
  const [listStatus, catalog] = await get("/api/tools");
  assert.equal(listStatus, 200);
  assert.equal(catalog.discovery, "verified-local-cli");
  assert.equal(catalog.tools.length, 3);
  assert.equal(catalog.tools.find(t => t.id === "mcp.fixture.read").kind, "mcp");

  const [planStatus, generated] = await post("/api/plan", { task: "检查 Node.js 和 Git 版本" });
  assert.equal(planStatus, 200);
  assert.equal(generated.recommendationEngine, "keyword-rules-not-ai");
  const planId = generated.planId;
  assert.ok(generated.candidates.some(item => item.toolId === "runtime.node"));

  const [deniedCode, denied] = await post("/api/execute", {
    planId, mode: "manual", toolIds: ["runtime.node", "system.delete"]
  });
  assert.equal(deniedCode, 403);
  assert.equal(denied.code, "TOOL_NOT_ALLOWED");

  const [acceptedCode, accepted] = await post("/api/execute", {
    planId, mode: "manual", toolIds: ["runtime.node"]
  });
  assert.equal(acceptedCode, 202);
  assert.deepEqual(accepted.toolIds, ["runtime.node"]);

  const [replayCode, replay] = await post("/api/execute", {
    planId, mode: "manual", toolIds: ["runtime.node"]
  });
  assert.equal(replayCode, 409);
  assert.equal(replay.code, "PLAN_ALREADY_USED");

  let observed = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 80));
    const [status, history] = await get("/api/history");
    assert.equal(status, 200);
    observed = history.events.some(event =>
      event.taskId === accepted.taskId &&
      event.toolId === "runtime.node" &&
      event.status === "succeeded" &&
      /^v\d/.test(event.resultSummary || "")
    );
    if (observed) break;
  }
  assert.ok(observed, "real Node version execution must be observed");
  assert.ok(!app.getEvents().some(e => e.toolId === "system.delete" && e.status === "running"),
    "unauthorized executable never ran");

  const sseResponse = await fetch(base + "/api/events");
  assert.equal(sseResponse.status, 200);
  assert.match(sseResponse.headers.get("content-type"), /text\/event-stream/);
  await sseResponse.body.cancel();
});

test("rejects malformed requests and cross-site origins", async t => {
  const { server } = createApp();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const badOrigin = await fetch(base + "/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ task: "检查 Node.js" })
  });
  assert.equal(badOrigin.status, 403);
  const notJson = await fetch(base + "/api/plan", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "test"
  });
  assert.equal(notJson.status, 415);
});
