import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk-v1/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk-v1/client/streamableHttp.js");
const noMcp = { discover: async () => ({ available: false }), close: async () => {} };
const tools = [
  { name: "git_version", toolId: "runtime.git", version: "git version 9.9.9", command: "git" },
  { name: "node_version", toolId: "runtime.node", version: "v24.21.0", command: "node" }
];

async function start(t, codexRunner, projectOptions = {}) {
  const app = createApp({ mcp: noMcp, codexRunner, ...projectOptions });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const client = new Client({ name: "codex-integration-test", version: "1" });
  t.after(async () => {
    await client.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close();
  });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp/codex"));
  await client.connect(transport);
  const policy = (body, origin = base) => fetch(base + "/api/codex/policy", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });
  const rawCall = async params => {
    const response = await fetch(base + "/mcp/codex", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params })
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, 42);
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result;
  };
  return { app, base, client, transport, policy, rawCall };
}

function sessionPost(base, sessionId, body, signal) {
  return fetch(base + "/mcp/codex", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId })
    },
    body: JSON.stringify(body),
    signal
  });
}

function projectCall(id) {
  return {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "project_git_status", arguments: {} }
  };
}

function cancelledResponse(response) {
  // Observe fetch and body rejection immediately, before cancellation can occur.
  return response.then(res => res.arrayBuffer()).catch(error => {
    assert.ok(error instanceof TypeError || error.name === "AbortError", String(error));
  });
}

async function waitForPending(base, count) {
  for (let index = 0; index < 200; index++) {
    const data = await fetch(base + "/api/codex/approvals").then(response => response.json());
    if (data.pending.length === count) return data.pending;
    await delay(10);
  }
  assert.fail(`expected ${count} pending approvals`);
}

async function waitForCancellation(app, callId) {
  for (let index = 0; index < 200; index++) {
    if (app.getEvents().some(event =>
      event.callId === callId && event.errorCode === "APPROVAL_CANCELLED")) return;
    await delay(10);
  }
  assert.fail("expected a correlated cancellation event");
}

async function anotherSession(t, base) {
  const client = new Client({ name: "second-session-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp/codex"));
  await client.connect(transport);
  t.after(() => client.close());
  assert.ok(transport.sessionId);
  return { client, transport };
}

function outcome(result, app, expected, toolId = "runtime.git") {
  const data = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.match(data.callId, /^[0-9a-f-]{36}$/);
  assert.equal(data.status, expected);
  assert.equal(data.taskId, data.callId);
  assert.equal(data.toolId, toolId);
  assert.equal(result.isError, expected !== "succeeded");
  const events = app.getEvents().filter(event => event.callId === data.callId);
  assert.equal(events.at(-1).status, expected);
  assert.equal(events.at(-1).toolId, toolId);
  assert.equal(events.at(-1).source, "codex");
  if (expected === "denied") assert.deepEqual(events.map(event => event.status), ["denied"]);
  if (expected !== "succeeded") {
    assert.equal(Object.hasOwn(data, "version"), false);
    assert.equal(Object.hasOwn(data, "resultSummary"), false);
  }
  if (expected === "succeeded") assert.equal(events.at(-1).resultSummary, data.version);
  return data;
}

test("Codex default deny, stale discovery, invalid args and policy access execute zero times", { timeout: 15000 }, async t => {
  let executions = 0;
  const { app, base, client, policy, rawCall } = await start(t, async () => {
    executions++;
    return { text: "git version 9.9.9" };
  });
  assert.equal(app.server.address().address, "127.0.0.1");
  const initialPolicy = await fetch(base + "/api/codex/policy").then(r => r.json());
  assert.deepEqual(initialPolicy, {
    enabled: false, tool: "git_version", scope: "codex", persistence: "memory",
    tools: tools.map(({ name }) => ({ tool: name, enabled: false }))
  });
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), [...tools.map(tool => tool.name), "project_git_status", "execute_tool_plan"]);
  for (const tool of listed.tools.filter(tool => tool.name !== "execute_tool_plan")) {
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    if (tool.name === "project_git_status") continue;
    const { toolId } = tools.find(item => item.name === tool.name);
    outcome(await client.callTool({ name: tool.name, arguments: {} }), app, "denied", toolId);
    outcome(await rawCall({ name: tool.name, arguments: {}, _meta: { enabled: true } }), app, "denied", toolId);
  }
  assert.equal(executions, 0, "discovery and default denial must never reach the runner");

  for (const origin of [null, "http://untrusted.example"]) {
    assert.equal((await policy({ enabled: true }, origin)).status, 403);
    for (const tool of tools) assert.equal((await policy({ tool: tool.name, enabled: true }, origin)).status, 403);
  }
  for (const body of [{}, { enabled: "true" }, { enabled: true, toolId: "runtime.node" },
    { tool: "node_version" }, { tool: "node_version", enabled: "true" },
    { tool: "unknown", enabled: true }, { tool: null, enabled: true },
    { tool: "__proto__", enabled: true }, { tool: "toString", enabled: true },
    { tool: "node_version", enabled: true, approved: true }]) {
    assert.equal((await policy(body)).status, 400);
  }
  assert.deepEqual(await fetch(base + "/api/codex/policy").then(r => r.json()), initialPolicy);
  assert.equal((await policy({ enabled: true })).status, 200);
  assert.equal((await policy({ tool: "node_version", enabled: true })).status, 200);
  const marker = "sample-secret-do-not-echo";
  for (const { name, toolId } of tools) {
    for (const _meta of [null, [], marker, true, 1]) {
      const result = await rawCall({ name, arguments: {}, _meta });
      assert.equal(outcome(result, app, "denied", toolId).errorCode, "INVALID_ARGUMENTS");
      assert.equal(JSON.stringify(result).includes(marker), false);
    }
    for (const params of [
      { name, arguments: { command: marker } },
      { name, arguments: { args: ["--version"] } },
      { name, arguments: { enabled: true } },
      { name, arguments: ["--version"] },
      { name, arguments: null },
      { name, arguments: marker },
      { name, arguments: {}, approved: true },
      { name, arguments: {}, task: { ttl: 1000 } },
      { name, arguments: { command: marker }, _meta: {} },
      { name, arguments: {}, _meta: {}, approved: true }
    ]) {
      const result = await rawCall(params);
      assert.equal(outcome(result, app, "denied", toolId).errorCode, "INVALID_ARGUMENTS");
      assert.equal(JSON.stringify(result).includes(marker), false);
    }
  }
  for (const params of [
    { name: "runtime.node", arguments: {} },
    { name: marker, arguments: {} },
    { name: "__proto__", arguments: {} },
    { name: "toString", arguments: {} },
    { name: "set_policy", arguments: { enabled: true } },
    {}, null, [], marker
  ]) {
    const result = await rawCall(params);
    outcome(result, app, "denied", null);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  assert.equal(executions, 0, "all malformed and unauthorized tools stop before execution");
  await client.listTools();
  const deniedIds = [];
  for (const { name, toolId } of tools) {
    assert.equal((await policy({ tool: name, enabled: false })).status, 200);
    const denied = outcome(await client.callTool({ name, arguments: {} }), app, "denied", toolId);
    assert.equal(denied.errorCode, "CODEX_DISABLED");
    deniedIds.push(denied.callId);
  }
  assert.equal(executions, 0, "revocation after tools/list must be checked at dispatch");
  const history = await fetch(base + "/api/history").then(r => r.json());
  for (const callId of deniedIds) assert.ok(history.events.some(event => event.callId === callId));
  assert.equal(JSON.stringify(history).includes(marker), false);
  const blockedHost = await new Promise((resolve, reject) => {
    const req = httpRequest(base + "/mcp/codex", { method: "POST", headers: { Host: "untrusted.example" } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(blockedHost, 403);
  assert.equal((await fetch(base + "/mcp/codex")).status, 405);
  assert.equal(executions, 0);
});

test("Codex policy leaves panel Git execution independent and a fresh service defaults to deny", { timeout: 15000 }, async t => {
  const { base, policy } = await start(t);
  const post = (route, body) => fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const plan = await post("/api/plan", { task: "检查 Git 版本" }).then(r => r.json());
  const execution = await post("/api/execute", { planId: plan.planId, mode: "manual", toolIds: ["runtime.git"] });
  assert.equal(execution.status, 202);
  const { taskId } = await execution.json();
  let events = [];
  for (let i = 0; i < 100; i++) {
    const history = await fetch(base + "/api/history").then(r => r.json());
    events = history.events.filter(event => event.taskId === taskId);
    if (events.some(event => event.status === "completed")) break;
    await delay(10);
  }
  assert.ok(events.some(event => event.status === "succeeded" && /^git version /.test(event.resultSummary)));
  await policy({ enabled: true });
  await policy({ tool: "node_version", enabled: true });
  const fresh = await start(t);
  const freshPolicy = await fetch(fresh.base + "/api/codex/policy").then(r => r.json());
  assert.equal(freshPolicy.enabled, false);
  assert.deepEqual(freshPolicy.tools, tools.map(({ name }) => ({ tool: name, enabled: false })));
  for (const { name, toolId } of tools) outcome(await fresh.client.callTool({ name, arguments: {} }), fresh.app, "denied", toolId);
});

test("Codex crossed grants stay independent and legacy policy remains Git-only", { timeout: 15000 }, async t => {
  const executions = [];
  const { app, base, client, policy } = await start(t, async (...args) => {
    executions.push(args);
    return { text: tools.find(tool => tool.toolId === args[0]).version };
  });
  const checkPolicy = async (response, git, node) => {
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data, {
      enabled: git, tool: "git_version", scope: "codex", persistence: "memory",
      tools: [{ tool: "git_version", enabled: git }, { tool: "node_version", enabled: node }]
    });
    assert.deepEqual(await fetch(base + "/api/codex/policy").then(r => r.json()), data);
  };
  const checkCalls = async (git, node) => {
    for (const [index, { name, toolId }] of tools.entries()) {
      const enabled = index === 0 ? git : node;
      const before = executions.length;
      const data = outcome(await client.callTool({ name, arguments: {} }), app, enabled ? "succeeded" : "denied", toolId);
      assert.equal(executions.length, before + Number(enabled));
      if (enabled) assert.deepEqual(executions.at(-1), [toolId]);
      else assert.equal(data.errorCode, "CODEX_DISABLED");
    }
  };
  await client.listTools();
  await checkPolicy(await policy({ enabled: true }), true, false);
  await checkCalls(true, false);
  await checkPolicy(await policy({ tool: "git_version", enabled: false }), false, false);
  await checkPolicy(await policy({ tool: "node_version", enabled: true }), false, true);
  await checkCalls(false, true);
  await checkPolicy(await policy({ enabled: true }), true, true);
  await checkCalls(true, true);
  await checkPolicy(await policy({ enabled: false }), false, true);
  await checkCalls(false, true);
  await checkPolicy(await policy({ tool: "node_version", enabled: false }), false, false);
  await checkCalls(false, false);
  assert.equal(executions.length, 5);
});

test("Codex accepts optional object metadata without trusting or exposing its contents", { timeout: 15000 }, async t => {
  let executions = 0;
  const logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, method, (...args) => logs.push(args));
  }
  const { app, base, policy, rawCall } = await start(t, async (...args) => {
    const tool = tools.find(tool => tool.toolId === args[0]);
    assert.deepEqual(args, [tool.toolId]);
    executions++;
    return { text: tool.version };
  });
  const marker = "sample-private-codex-metadata";
  const clientCallId = "00000000-0000-4000-8000-000000000000";
  const metadata = {
    callId: clientCallId, enabled: true, name: "runtime.node",
    arguments: { command: marker }, nested: { marker }
  };
  const results = [];
  for (const { name, toolId } of tools) {
    results.push(await rawCall({ name, arguments: {}, _meta: metadata }));
    const denied = outcome(results.at(-1), app, "denied", toolId);
    assert.equal(denied.errorCode, "CODEX_DISABLED");
  }
  assert.equal(executions, 0);
  for (const { name, toolId } of tools) {
    await policy({ tool: name, enabled: true });
    for (const _meta of [{}, metadata]) {
      const result = await rawCall({ name, arguments: {}, _meta });
      results.push(result);
      const data = outcome(result, app, "succeeded", toolId);
      assert.notEqual(data.callId, clientCallId);
      assert.deepEqual(app.getEvents().filter(event => event.callId === data.callId).map(event => event.status), ["running", "succeeded"]);
    }
  }
  assert.equal(executions, 4);
  const history = await fetch(base + "/api/history").then(r => r.json());
  const output = JSON.stringify({ results, events: app.getEvents(), history, logs });
  assert.equal(output.includes(marker), false);
  assert.equal(output.includes(clientCallId), false);
  assert.equal(output.includes('"_meta"'), false);
});

for (const { name, toolId, version, command } of tools) {
  test(`Codex ${name} dispatch uses the fixed runner ID and sanitizes failures`, { timeout: 15000 }, async t => {
    let executions = 0;
    const marker = "sample-private-diagnostic";
    const invalidResults = [marker, tools.find(tool => tool.name !== name).version, version + "\n", "v1", "x".repeat(201), null, 42];
    const { app, client, policy } = await start(t, async (...args) => {
      assert.deepEqual(args, [toolId]);
      executions++;
      if (executions === 1) return { text: version };
      if (executions === 2) throw Error(marker);
      return { text: invalidResults[executions - 3] };
    });
    await policy({ tool: name, enabled: true });
    outcome(await client.callTool({ name, _meta: { progressToken: "local-test" } }), app, "succeeded", toolId);
    for (let i = 0; i < invalidResults.length + 1; i++) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(outcome(result, app, "failed", toolId).errorCode, "TOOL_FAILED");
      assert.equal(JSON.stringify(result).includes(marker), false);
    }
    assert.equal(executions, invalidResults.length + 2);
    assert.equal(JSON.stringify(app.getEvents()).includes(marker), false);
  });

  test(`real ${name} result correlates across MCP response, history and SSE`, { timeout: 15000 }, async t => {
    const { app, base, client, policy } = await start(t);
    const abort = new AbortController();
    const response = await fetch(base + "/api/events", { signal: abort.signal });
    const reader = response.body.getReader();
    t.after(async () => { abort.abort(); await reader.cancel().catch(() => {}); });
    await reader.read();
    const marker = "sample-private-sse-metadata";
    const metadata = { secret: marker, callId: marker, enabled: true };
    await policy({ tool: name, enabled: true });
    const result = await client.callTool({ name, arguments: {}, _meta: metadata });
    const data = outcome(result, app, "succeeded", toolId);
    const direct = await promisify(execFile)(command, ["--version"], { windowsHide: true, shell: false });
    assert.equal(data.version, direct.stdout.trim());
    if (name === "node_version") assert.equal(data.version, process.version);
    let sse = "";
    while (!sse.includes('"status":"succeeded"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      sse += new TextDecoder().decode(chunk.value);
    }
    const entries = sse.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.ok(entries.some(event => event.callId === data.callId && event.resultSummary === data.version));
    const history = await fetch(base + "/api/history").then(r => r.json());
    assert.ok(history.events.some(event => event.callId === data.callId && event.resultSummary === data.version));
    await policy({ tool: name, enabled: false });
    const denied = outcome(await client.callTool({ name, arguments: {}, _meta: metadata }), app, "denied", toolId);
    while (!sse.includes(denied.callId)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      sse += new TextDecoder().decode(chunk.value);
    }
    assert.ok(sse.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      .some(event => event.callId === denied.callId && event.status === "denied"));
    assert.equal(JSON.stringify({ result, denied, history, sse }).includes(marker), false);
  });
}

test("project Git real SDK call waits for same-origin allow-once and correlates a sanitized result", { timeout: 15000 }, async t => {
  let runs = 0;
  const summary = { total: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0, clean: false };
  const { app, base, client, policy, rawCall } = await start(t, undefined, {
    projectGitRunner: (...args) => {
      assert.deepEqual(args, []);
      runs++;
      return summary;
    }
  });
  const pending = () => fetch(base + "/api/codex/approvals").then(response => response.json());
  const decide = (body, origin = base) => fetch(base + "/api/codex/approvals/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });
  await client.listTools();
  await fetch(base + "/api/tools");
  assert.equal(runs, 0, "neither MCP listing nor registry discovery executes project Git");
  assert.equal((await policy({ tool: "project_git_status", enabled: true })).status, 400);
  const policyState = await fetch(base + "/api/codex/policy").then(response => response.json());
  assert.deepEqual(policyState.tools.map(item => item.tool), ["git_version", "node_version"]);
  const resultPromise = client.callTool({
    name: "project_git_status", arguments: {},
    _meta: { approved: true, callId: "PRIVATE", command: "PRIVATE" }
  });
  let request;
  for (let index = 0; index < 100; index++) {
    request = (await pending()).pending[0];
    if (request) break;
    await delay(10);
  }
  assert.ok(request);
  assert.equal(request.readOnly, true);
  assert.equal(request.approvalState, "pending");
  assert.ok(Date.parse(request.expiresAt) > Date.now());
  assert.equal(runs, 0);
  const body = { callId: request.callId, decision: "approve" };
  for (const origin of [null, "http://untrusted.example"]) {
    assert.equal((await decide(body, origin)).status, 403);
  }
  assert.equal((await fetch(base + "/api/codex/approvals", {
    headers: { Origin: "http://untrusted.example" }
  })).status, 403);
  assert.equal((await decide({ ...body, enabled: true })).status, 400);
  assert.equal(runs, 0);
  const decisions = await Promise.all([decide(body), decide(body)]);
  assert.deepEqual(decisions.map(response => response.status).sort(), [200, 409]);
  const result = await resultPromise;
  const data = result.structuredContent;
  assert.equal(data.callId, request.callId);
  assert.equal(data.taskId, request.callId);
  assert.equal(data.status, "succeeded");
  assert.equal(data.toolId, "project_git_status");
  assert.deepEqual(data.summary, summary);
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(result.isError, false);
  assert.equal(runs, 1);
  assert.deepEqual(await pending(), { pending: [] });
  const events = app.getEvents().filter(event => event.callId === request.callId);
  assert.deepEqual(events.map(event => event.status), ["queued", "running", "succeeded"]);
  assert.equal(events[0].phase, "approval");
  assert.equal(events.at(-1).resultSummary, data.resultSummary);
  assert.equal(JSON.stringify({ result, events, request }).includes("PRIVATE"), false);
  const malformed = await rawCall({ name: "project_git_status", arguments: {}, approved: true });
  assert.equal(malformed.structuredContent.errorCode, "INVALID_ARGUMENTS");
  assert.equal(runs, 1);
});

test("SDK cancellation removes a pending approval without dispatching Git", { timeout: 15000 }, async t => {
  let runs = 0;
  const logs = [];
  const originalError = console.error;
  t.mock.method(console, "error", (...args) => {
    logs.push(args.map(value => value?.stack ?? String(value)).join(" "));
    originalError.apply(console, args);
  });
  const { base, client, app } = await start(t, undefined, {
    projectGitRunner: () => { runs++; throw Error("must not run"); }
  });
  const controller = new AbortController();
  const result = client.callTool(
    { name: "project_git_status", arguments: {} },
    undefined,
    { signal: controller.signal }
  );
  const settled = result.catch(() => null);
  let request;
  for (let index = 0; index < 100; index++) {
    const data = await fetch(base + "/api/codex/approvals").then(response => response.json());
    request = data.pending[0];
    if (request) break;
    await delay(10);
  }
  assert.ok(request);
  controller.abort();
  await settled;
  for (let index = 0; index < 100; index++) {
    if (app.getEvents().some(event => event.callId === request.callId && event.status === "cancelled")) break;
    await delay(10);
  }
  assert.ok(app.getEvents().some(event =>
    event.callId === request.callId && event.errorCode === "APPROVAL_CANCELLED"));
  assert.deepEqual(await fetch(base + "/api/codex/approvals").then(response => response.json()), { pending: [] });
  assert.equal(runs, 0);
  assert.equal((await client.listTools()).tools.length, 4);
  const followup = client.callTool({ name: "project_git_status", arguments: {} });
  const [next] = await waitForPending(base, 1);
  const decision = await fetch(base + "/api/codex/approvals/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ callId: next.callId, decision: "deny" })
  });
  assert.equal(decision.status, 200);
  assert.equal((await followup).structuredContent.errorCode, "APPROVAL_DENIED");
  assert.equal(runs, 0);
  assert.equal(logs.some(line => line.includes("ERR_HTTP_HEADERS_SENT")), false);
});

for (const id of [71, 0]) {
  test(`session cancellation isolates identical request IDs, including ${id}`, { timeout: 15000 }, async t => {
    let runs = 0;
    const { app, base, client, transport } = await start(t, undefined, {
      projectGitRunner: () => { runs++; throw Error("must not run"); }
    });
    const other = await anotherSession(t, base);
    assert.notEqual(transport.sessionId, other.transport.sessionId);
    const first = cancelledResponse(sessionPost(base, transport.sessionId, projectCall(id)));
    const [firstApproval] = await waitForPending(base, 1);
    const second = sessionPost(base, other.transport.sessionId, projectCall(id));
    const approvals = await waitForPending(base, 2);
    const secondApproval = approvals.find(item => item.callId !== firstApproval.callId);

    const cancellation = await sessionPost(base, transport.sessionId, {
      jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: id, reason: "PRIVATE-CANCELLATION-REASON" }
    });
    assert.equal(cancellation.status, 202);
    await cancellation.arrayBuffer();
    await first;
    await waitForCancellation(app, firstApproval.callId);
    assert.deepEqual((await waitForPending(base, 1)).map(item => item.callId), [secondApproval.callId]);
    assert.equal(app.getEvents().some(event =>
      event.callId === secondApproval.callId && event.status === "cancelled"), false);
    assert.equal((await client.listTools()).tools.length, 4);
    assert.equal((await other.client.listTools()).tools.length, 4);

    const decision = await fetch(base + "/api/codex/approvals/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ callId: secondApproval.callId, decision: "deny" })
    });
    assert.equal(decision.status, 200);
    const reply = await (await second).json();
    assert.equal(reply.id, id);
    assert.equal(reply.result.structuredContent.errorCode, "APPROVAL_DENIED");
    await waitForPending(base, 0);
    assert.equal(runs, 0);
    assert.equal(JSON.stringify(app.getEvents()).includes("PRIVATE-CANCELLATION-REASON"), false);
  });
}

test("closing a tool HTTP response cancels only that request and preserves the session", { timeout: 15000 }, async t => {
  let runs = 0;
  const { app, base, client, transport } = await start(t, undefined, {
    projectGitRunner: () => { runs++; throw Error("must not run"); }
  });
  const controller = new AbortController();
  const response = sessionPost(base, transport.sessionId, projectCall("disconnected"), controller.signal);
  const settled = response.catch(() => null);
  const [approval] = await waitForPending(base, 1);
  controller.abort();
  await settled;
  await waitForCancellation(app, approval.callId);
  await waitForPending(base, 0);
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(runs, 0);
});

test("GET stream closure and unrelated responses preserve pending tool requests", { timeout: 15000 }, async t => {
  const { base, app } = await start(t);
  const initialized = await sessionPost(base, undefined, {
    jsonrpc: "2.0", id: "initialize-stream", method: "initialize",
    params: {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "raw-stream-test", version: "1" }
    }
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await initialized.arrayBuffer();
  const ready = await sessionPost(base, sessionId, {
    jsonrpc: "2.0", method: "notifications/initialized"
  });
  assert.equal(ready.status, 202);
  await ready.arrayBuffer();
  const call = sessionPost(base, sessionId, projectCall("keep-pending"));
  const [approval] = await waitForPending(base, 1);
  const controller = new AbortController();
  const stream = await fetch(base + "/mcp/codex", {
    headers: { Accept: "text/event-stream", "Mcp-Session-Id": sessionId },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  controller.abort();
  await reader.cancel().catch(() => {});
  const listed = await sessionPost(base, sessionId, {
    jsonrpc: "2.0", id: "stream-list", method: "tools/list"
  });
  assert.equal(listed.status, 200);
  const listing = await listed.json();
  assert.equal(listing.id, "stream-list");
  assert.equal(listing.result.tools.length, 4);
  assert.deepEqual((await waitForPending(base, 1)).map(item => item.callId), [approval.callId]);
  const decision = await fetch(base + "/api/codex/approvals/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ callId: approval.callId, decision: "deny" })
  });
  assert.equal(decision.status, 200);
  const reply = await (await call).json();
  assert.equal(reply.id, "keep-pending");
  assert.equal(reply.result.structuredContent.callId, approval.callId);
  assert.equal(reply.result.structuredContent.errorCode, "APPROVAL_DENIED");
  assert.ok(app.getEvents().some(event =>
    event.callId === approval.callId && event.errorCode === "APPROVAL_DENIED"));
  await waitForPending(base, 0);
});

test("DELETE cancels its pending zero-ID request and removes only its session", { timeout: 15000 }, async t => {
  let runs = 0;
  const { app, base, transport } = await start(t, undefined, {
    projectGitRunner: () => { runs++; throw Error("must not run"); }
  });
  const other = await anotherSession(t, base);
  const call = cancelledResponse(sessionPost(base, transport.sessionId, projectCall(0)));
  const [approval] = await waitForPending(base, 1);
  const otherCall = cancelledResponse(sessionPost(base, other.transport.sessionId, projectCall(0)));
  const both = await waitForPending(base, 2);
  const otherApproval = both.find(item => item.callId !== approval.callId);
  const deleted = await fetch(base + "/mcp/codex", {
    method: "DELETE", headers: { "Mcp-Session-Id": transport.sessionId }
  });
  assert.equal(deleted.status, 200);
  await deleted.arrayBuffer();
  await call;
  await waitForCancellation(app, approval.callId);
  assert.deepEqual((await waitForPending(base, 1)).map(item => item.callId), [otherApproval.callId]);
  const stale = await sessionPost(base, transport.sessionId, {
    jsonrpc: "2.0", id: 12, method: "tools/list"
  });
  assert.equal(stale.status, 404);
  await stale.arrayBuffer();
  assert.equal((await other.client.listTools()).tools.length, 4);
  await app.close();
  await otherCall;
  await waitForCancellation(app, otherApproval.callId);
  await waitForPending(base, 0);
  assert.equal(runs, 0);
});

test("unknown sessions never fall back; raw versions and listing retain stateless compatibility", { timeout: 15000 }, async t => {
  const executions = [];
  let projectRuns = 0;
  const { app, base, policy, rawCall } = await start(t, async toolId => {
    executions.push(toolId);
    return { text: tools.find(tool => tool.toolId === toolId).version };
  }, {
    projectGitRunner: () => { projectRuns++; throw Error("must not run"); }
  });
  for (const method of ["GET", "DELETE", "POST"]) {
    const response = method === "POST"
      ? await sessionPost(base, "unknown-session", projectCall(0))
      : await fetch(base + "/mcp/codex", {
        method, headers: { "Mcp-Session-Id": "unknown-session", Accept: "text/event-stream" }
      });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  for (const method of ["GET", "DELETE", "PUT"]) {
    assert.equal((await fetch(base + "/mcp/codex", { method })).status, 405);
  }
  const denied = await rawCall({ name: "project_git_status", arguments: {} });
  assert.equal(outcome(denied, app, "denied", "project_git_status").errorCode, "SESSION_REQUIRED");
  await waitForPending(base, 0);
  assert.equal(projectRuns, 0);
  assert.deepEqual(executions, []);
  const listed = await sessionPost(base, undefined, {
    jsonrpc: "2.0", id: "raw-list", method: "tools/list"
  });
  assert.equal(listed.status, 200);
  const listing = await listed.json();
  assert.equal(listing.id, "raw-list");
  assert.deepEqual(listing.result.tools.map(tool => tool.name), [
    "git_version", "node_version", "project_git_status", "execute_tool_plan"
  ]);
  for (const { name, toolId } of tools) {
    await policy({ tool: name, enabled: true });
    outcome(await rawCall({ name, arguments: {} }), app, "succeeded", toolId);
  }
  assert.deepEqual(executions, ["runtime.git", "runtime.node"]);
});

test("duplicate active request IDs are rejected without replacing the original controller", { timeout: 15000 }, async t => {
  let runs = 0;
  const { app, base, client, transport } = await start(t, undefined, {
    projectGitRunner: () => { runs++; throw Error("must not run"); }
  });
  const id = "duplicate";
  const original = cancelledResponse(sessionPost(base, transport.sessionId, projectCall(id)));
  const [approval] = await waitForPending(base, 1);
  const duplicate = await sessionPost(base, transport.sessionId, projectCall(id));
  assert.equal(duplicate.status, 409);
  const error = await duplicate.json();
  assert.equal(error.id, id);
  assert.equal(error.error.code, -32600);
  assert.deepEqual((await waitForPending(base, 1)).map(item => item.callId), [approval.callId]);
  const cancelled = await sessionPost(base, transport.sessionId, {
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id }
  });
  assert.equal(cancelled.status, 202);
  await cancelled.arrayBuffer();
  await original;
  await waitForCancellation(app, approval.callId);
  await waitForPending(base, 0);
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(runs, 0);
});

test("stateful routing validates each original call and rejects forged internal envelopes", { timeout: 15000 }, async t => {
  const executions = [];
  const { app, base, client, transport, policy } = await start(t, async toolId => {
    executions.push(toolId);
    return { text: tools.find(tool => tool.toolId === toolId).version };
  });
  for (const tool of tools) await policy({ tool: tool.name, enabled: true });
  const marker = "PRIVATE-ROUTING-MARKER";
  for (const [index, params] of [
    { name: "git_version", arguments: { internalRawParams: { name: "node_version", arguments: {} } } },
    { name: "project_git_status", arguments: {}, task: { ttl: 1000 } },
    { name: "project_git_status", arguments: {}, approved: true },
    { name: "project_git_status", arguments: {}, _meta: marker },
    { name: "node_version", arguments: {}, approval: { approved: true } }
  ].entries()) {
    const response = await sessionPost(base, transport.sessionId, {
      jsonrpc: "2.0", id: `invalid-${index}`, method: "tools/call", params
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, `invalid-${index}`);
    assert.equal(reply.result.structuredContent.errorCode, "INVALID_ARGUMENTS");
  }
  await waitForPending(base, 0);
  assert.deepEqual(executions, []);
  for (const { name, toolId } of tools) {
    outcome(await client.callTool({ name, arguments: {} }), app, "succeeded", toolId);
  }
  assert.deepEqual(executions, ["runtime.git", "runtime.node"]);
  assert.equal(JSON.stringify(app.getEvents()).includes(marker), false);
});

test("session capacity includes initialization and DELETE releases a slot", { timeout: 30000 }, async t => {
  const { base, transport } = await start(t);
  const initialize = id => sessionPost(base, undefined, {
    jsonrpc: "2.0", id, method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "capacity-test", version: "1" }
    }
  });
  const ids = [];
  for (let index = 0; index < 99; index++) {
    const response = await initialize(index);
    assert.equal(response.status, 200);
    const id = response.headers.get("mcp-session-id");
    assert.ok(id);
    ids.push(id);
    await response.arrayBuffer();
  }
  assert.equal(new Set([transport.sessionId, ...ids]).size, 100);
  const overflow = await initialize("overflow");
  assert.equal(overflow.status, 503);
  assert.equal((await overflow.json()).code, "SESSION_LIMIT");
  const existing = await sessionPost(base, transport.sessionId, {
    jsonrpc: "2.0", id: "still-live", method: "tools/list"
  });
  assert.equal(existing.status, 200);
  assert.equal((await existing.json()).result.tools.length, 4);
  const deleted = await fetch(base + "/mcp/codex", {
    method: "DELETE", headers: { "Mcp-Session-Id": ids[0] }
  });
  assert.equal(deleted.status, 200);
  await deleted.arrayBuffer();
  const replacement = await initialize("replacement");
  assert.equal(replacement.status, 200);
  assert.ok(replacement.headers.get("mcp-session-id"));
  await replacement.arrayBuffer();
});
