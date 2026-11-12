import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, cp, mkdir, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { createMcpHub, MCP_TOOL_ID } from "../src/mcphub-adapter.mjs";
import { chooseTools } from "../src/policy.mjs";

async function start(t, mcp) {
  const app = createApp({ mcp });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close();
  });
  const request = async (route, body) => {
    const res = await fetch(base + route, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
  return { app, base, request };
}
async function wire(mcp) {
  try { return (await readFile(path.join(mcp.runDirectory, "wire.ndjson"), "utf8")).trim().split("\n").map(JSON.parse); }
  catch { return []; }
}
const calls = async mcp => (await wire(mcp)).filter(r => r.method === "tools/call").length;

test("MCPHub: direct denials precede real read, errors, late timeout, SSE and log checks", { timeout: 60000 }, async t => {
  const mcp = createMcpHub();
  const { app, base, request } = await start(t, mcp);
  const discovered = await request("/api/tools");
  const tool = discovered.data.tools.find(t => t.id === MCP_TOOL_ID);
  if (!tool.available) { t.skip("MCPHub 项目内运行资源不可用；真实接入测试未执行"); return; }
  assert.equal(tool.source, "mcphub-local-fixture");
  const initial = await wire(mcp);
  assert.ok(initial.some(r => r.method === "tools/list"));
  const init = initial.find(r => r.method === "initialize");
  assert.equal(init.protocol, "2025-11-25");
  assert.ok(init.envKeys.every(key => ["SYSTEMROOT", "TEMP", "TMP"].includes(key.toUpperCase())));
  const stream = new AbortController();
  const live = await fetch(base + "/api/events", { signal: stream.signal });
  let sse = "";
  const reading = (async () => { try { for await (const chunk of live.body) sse += Buffer.from(chunk); } catch (e) { if (!stream.signal.aborted) throw e; } })();
  t.after(async () => { stream.abort(); await reading; });
  const marker = "sample-" + randomUUID();
  const plan = async () => (await request("/api/plan", { task: "MCP fixture 只读验证" })).data;
  const execute = (p, ids = [MCP_TOOL_ID], mode = "manual", extra = {}) => request("/api/execute", {
    planId: p?.planId ?? marker, mode, toolIds: ids, ...extra
  });
  let p = await plan();
  assert.equal((await execute(null)).status, 404);
  for (const name of [marker, "mcp.unknown.read", "mcp.fixture.disabled", "mcp.fixture.blocked", "mcp.fixture.unselected", "fixture-runtime.node"]) {
    for (const mode of ["manual", "auto", "mixed"]) {
      const denied = await execute(p, [name], mode);
      assert.equal(denied.status, 403);
      assert.equal(JSON.stringify(denied).includes(marker), false);
    }
  }
  assert.equal((await execute(p, [MCP_TOOL_ID, MCP_TOOL_ID])).status, 400);
  assert.equal((await execute(p, [], "manual")).status, 422);
  for (const extra of [{ arguments: { sample: marker } }, { command: marker }, { serviceId: marker }, { approved: true }])
    assert.equal((await execute(p, [MCP_TOOL_ID], "mixed", extra)).status, 400);
  const old = p; p = await plan();
  assert.equal((await execute(old)).data.code, "PLAN_SUPERSEDED");
  const now = Date.now;
  try {
    Date.now = () => now() + 11 * 60 * 1000;
    assert.equal((await execute(p)).data.code, "PLAN_EXPIRED");
  } finally { Date.now = now; }
  assert.throws(() => chooseTools({ id: "expired", candidates: [{ toolId: MCP_TOOL_ID }], expiresAt: Date.now() - 1 }, "manual", [MCP_TOOL_ID]), e => e.code === "PLAN_EXPIRED");

  const settingsFile = path.join(mcp.runDirectory, "settings.json");
  const original = await readFile(settingsFile, "utf8");
  const mutate = async fn => {
    const obj = JSON.parse(original); fn(obj);
    await writeFile(settingsFile, JSON.stringify(obj)); await delay(30);
  };
  // Approved in the old plan, then explicitly denied by the actual Hub policy.
  await mutate(obj => obj.systemConfig.toolPolicies.push({ id: "deny-read", effect: "deny", tool: "read" }));
  assert.equal((await execute(p)).status, 403);
  await mutate(obj => obj.mcpServers.fixture.tools.read = { enabled: false });
  assert.equal((await execute(p)).status, 403);
  await writeFile(settingsFile, "{invalid");
  assert.equal((await execute(p)).status, 403);
  await mutate(obj => obj.systemConfig.toolPolicies = [{ id: "bad", effect: marker }]);
  assert.equal((await execute(p)).status, 403);
  await mutate(obj => obj.systemConfig.toolPolicies = []);
  assert.equal((await execute(p)).status, 403);
  await writeFile(settingsFile, original); await delay(30);
  assert.equal(await calls(mcp), 0, "no denied request reaches downstream tools/call");
  assert.ok(app.getEvents().every(e => e.status === "denied"));
  assert.equal(JSON.stringify(app.getEvents()).includes(marker), false);
  // Keep the bounded history focused on all outcomes below.
  const outcomes = [];
  for (const [mode, code, terminal] of [
    ["ok", null, "succeeded"], ["error", "MCP_TOOL_ERROR", "failed"],
    ["protocol", "MCP_TOOL_ERROR", "failed"], ["unexpected", "MCP_PROTOCOL_ERROR", "failed"],
    ["timeout", "MCP_TIMEOUT", "failed"], ["late", "MCP_TIMEOUT", "failed"]
  ]) {
    await writeFile(path.join(mcp.runDirectory, "fixture-case.json"), JSON.stringify({ mode, marker }));
    p = await plan();
    const results = await Promise.all([execute(p), execute(p)]);
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409], "concurrent replay accepted exactly once");
    const accepted = results.find(r => r.status === 202).data;
    let rows;
    for (let i = 0; i < 100; i++) {
      rows = app.getEvents().filter(e => e.taskId === accepted.taskId);
      if (rows.some(e => e.status === "completed")) break;
      await delay(30);
    }
    const final = rows.find(e => e.toolId === MCP_TOOL_ID && e.status !== "running");
    assert.equal(final?.status, terminal, mode);
    if (code) assert.equal(final.errorCode, code, mode);
    else assert.equal(final.resultSummary, "fixture-ok");
    assert.equal(rows.filter(e => e.status === "running").length, 1);
    assert.equal(rows.find(e => e.status === "running").callId, final.callId);
    assert.equal(final.planId, p.planId);
    outcomes.push(final.status);
    assert.equal(await calls(mcp), outcomes.length);
  }
  await delay(1100); // The final fixture response arrives after the SDK timeout.
  assert.equal(app.getEvents().filter(e => e.status === "succeeded" && e.toolId === MCP_TOOL_ID).length, 1);
  assert.equal((await wire(mcp)).filter(r => r.method === "tools/call").every(r => r.emptyArguments && r.name === "read"), true);
  const history = await request("/api/history");
  for (let i = 0; i < 100 && sse.split("data: ").length <= app.getEvents().length; i++) await delay(10);
  stream.abort(); await reading;
  const messages = sse.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(messages, history.data.events);
  assert.ok(messages.every(e => typeof e.id === "number"));
  assert.match(sse, /event: tool/);
  assert.equal((JSON.stringify(history) + sse + JSON.stringify(await wire(mcp))).includes(marker), false);
  for (const route of ["/api/servers", "/mcp", "/sse", "/mcp/fixture"]) assert.equal((await request(route)).status, 404);
  const evidence = { address: app.server.address(), servicePid: process.pid, workerPid: mcp.pid, fixturePid: init.pid,
    rejectedDownstreamCalls: 0, downstreamCalls: await calls(mcp), outcomes, eventCount: messages.length,
    protocol: init.protocol, markerLeaks: 0, databaseLogging: "disabled / not tested" };
  await writeFile(path.join(mcp.runDirectory, "verification.json"), JSON.stringify(evidence, null, 2));
  t.diagnostic("真实接入证据：" + mcp.runDirectory);
  const beforeDisconnect = await plan();
  await app.close();
  const disconnected = await execute(beforeDisconnect);
  assert.equal(disconnected.status, 403, "an old grant cannot survive a missing upstream process");
  for (const pid of [mcp.pid, init.pid]) assert.throws(() => process.kill(pid, 0), "worker and fixture exit");
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));
});

test("malformed upstream catalog remains unavailable, even when its name matches", { timeout: 30000 }, async t => {
  const mcp = createMcpHub({ fixtureCase: { malformedList: true } });
  t.after(() => mcp.close());
  assert.equal((await mcp.discover()).available, false);
  await assert.rejects(mcp.call("runtime.node"));
  assert.equal(await calls(mcp), 0);
});

test("a copy without ignored MCPHub resources degrades safely and keeps CLI working", { timeout: 30000 }, async t => {
  const root = path.resolve(".cache", "missing-resource-test");
  await mkdir(root, { recursive: true });
  const copy = await mkdtemp(path.join(root, "project-"));
  await cp(path.resolve("src"), path.join(copy, "src"), { recursive: true });
  await cp(path.resolve("public"), path.join(copy, "public"), { recursive: true });
  const { createApp: isolatedApp } = await import(pathToFileURL(path.join(copy, "src", "server.mjs")).href);
  const app = isolatedApp();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.close(); });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const tools = await fetch(base + "/api/tools").then(r => r.json());
  assert.equal(tools.tools.find(t => t.id === MCP_TOOL_ID).available, false);
  assert.ok(tools.tools.filter(t => t.kind === "cli").every(t => t.available));
  const plan = await fetch(base + "/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "MCP 验证" }) }).then(r => r.json());
  assert.equal(plan.candidates.some(t => t.toolId === MCP_TOOL_ID), false);
  const denied = await fetch(base + "/api/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.planId, mode: "mixed", toolIds: [MCP_TOOL_ID] }) });
  assert.equal(denied.status, 403);
  assert.ok(app.getEvents().every(e => e.status === "denied"));
});
