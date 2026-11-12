import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server.mjs";
import { createToolPlans } from "../src/tool-plans.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk-v1/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk-v1/client/streamableHttp.js");
const noMcp = { discover: async () => ({ available: false }), close: async () => {} };
const names = ["git_version", "node_version", "project_git_status"];
const toolIds = ["runtime.git", "runtime.node", "project_git_status"];
const versions = { "runtime.git": "git version 9.9.9", "runtime.node": "v24.21.0" };
const clean = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, clean: true };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const marker = "PRIVATE-PLAN-INPUT-OR-DIAGNOSTIC";

async function bounded(promise, label = "operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} did not settle`)), 1500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(read, predicate, label) {
  const deadline = Date.now() + 1500;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${label}`);
}

async function start(t, options = {}) {
  const calls = [];
  const releases = [];
  const controllers = [];
  const pending = [];
  // These runners are deterministic test fixtures, never native execution.
  const app = createApp({
    mcp: noMcp,
    codexRunner: async (...args) => {
      calls.push(args);
      assert.equal(args.length, 1);
      assert.ok(Object.hasOwn(versions, args[0]));
      return { text: versions[args[0]] };
    },
    projectGitRunner: async (...args) => {
      calls.push(["project_git_status", ...args]);
      assert.deepEqual(args, []);
      return clean;
    },
    ...options
  });
  const client = new Client({ name: "tool-plan-fixture-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp/codex")
  );
  let clients = [client];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const release of releases) release();
    try {
      await bounded(app.close(), "application cleanup");
    } finally {
      await bounded(Promise.allSettled(clients.map(item => item.close())), "client cleanup");
      app.server.closeAllConnections();
      if (app.server.listening) {
        await bounded(new Promise(resolve => app.server.close(resolve)), "HTTP cleanup");
      }
      await bounded(Promise.allSettled(pending), "outstanding requests");
    }
  });
  await bounded(new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve)));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const actualTransport = new StreamableHTTPClientTransport(new URL(base + "/mcp/codex"));
  await bounded(client.connect(actualTransport), "SDK initialization");
  assert.ok(actualTransport.sessionId);

  function track(promise) {
    // Attach a rejection observer immediately, including when an assertion fails.
    promise.catch(() => {});
    pending.push(promise);
    return promise;
  }
  function controller() {
    const value = new AbortController();
    controllers.push(value);
    return value;
  }
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    releases.push(release);
    return { promise, release };
  }
  const request = (route, init = {}) => fetch(base + route, {
    ...init, signal: init.signal ?? AbortSignal.timeout(1200)
  });
  const get = async route => {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const post = (route, body, origin = base) => request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body)
  });
  const plans = async () => {
    const data = await get("/api/codex/plans");
    assert.ok(Array.isArray(data.plans));
    return data.plans;
  };
  const waitPlan = (predicate, label = "plan state") => until(
    plans, rows => rows.some(predicate), label
  ).then(rows => rows.find(predicate));
  const call = (steps = names, extra = {}, sdk = client, signal) => {
    const owned = signal ?? controller().signal;
    return track(sdk.callTool(
      { name: "execute_tool_plan", arguments: { steps }, ...extra },
      undefined,
      { signal: owned }
    ));
  };
  let rawId = 1000;
  const raw = (params, sessionId = actualTransport.sessionId, signal) => {
    const id = ++rawId;
    const owned = signal ?? controller().signal;
    return track(request("/mcp/codex", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(sessionId === null ? {} : { "Mcp-Session-Id": sessionId })
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }),
      signal: owned
    }).then(async response => {
      assert.equal(response.status, 200);
      const reply = await response.json();
      assert.equal(reply.id, id);
      assert.ok(reply.result);
      return reply.result;
    }));
  };
  const decide = (planId, decision = "approve") =>
    post("/api/codex/plans/decision", { planId, decision });
  const cancel = planId => post("/api/codex/plans/cancel", { planId });
  const grant = async (tool, enabled) => {
    assert.equal((await post("/api/codex/policy", { tool, enabled })).status, 200);
  };
  const enable = async () => {
    await grant("git_version", true);
    await grant("node_version", true);
  };
  const another = async () => {
    const other = new Client({ name: "other-plan-fixture-test", version: "1" });
    clients.push(other);
    await bounded(other.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp/codex"))));
    return other;
  };
  // Keep only the connected transport; no network operation uses the placeholder.
  void transport;
  return {
    app, base, client, transport: actualTransport, calls, controller, gate,
    track, get, post, plans, waitPlan, call, raw, decide, cancel, grant, enable, another
  };
}

function snapshot(data, expectedNames = names) {
  assert.match(data.planId, uuid);
  assert.equal(data.callId, data.planId);
  assert.equal(data.source, "codex");
  assert.equal(data.toolId, "execute_tool_plan");
  assert.ok(["queued", "running", "succeeded", "failed", "denied", "cancelled"].includes(data.status));
  assert.ok(Number.isFinite(Date.parse(data.expiresAt)));
  assert.equal(typeof data.stopRequested, "boolean");
  assert.equal(data.steps.length, expectedNames.length);
  const ids = [data.planId];
  for (const [index, step] of data.steps.entries()) {
    assert.match(step.stepId, uuid);
    assert.match(step.callId, uuid);
    ids.push(step.stepId, step.callId);
    assert.equal(step.stepIndex, index + 1);
    assert.equal(step.tool, expectedNames[index]);
    assert.equal(step.toolId, toolIds[names.indexOf(step.tool)]);
    assert.ok(["planned", "running", "succeeded", "failed", "denied", "cancelled"].includes(step.status));
    assert.ok(step.grantEnabled === null || typeof step.grantEnabled === "boolean");
  }
  assert.equal(new Set(data.steps.map(step => step.stepId)).size, expectedNames.length);
  assert.equal(new Set([data.planId, ...data.steps.map(step => step.callId)]).size, expectedNames.length + 1);
  return data;
}

function outcome(reply, status, expectedNames = names) {
  const data = snapshot(reply.structuredContent, expectedNames);
  assert.equal(data.status, status);
  assert.equal(reply.isError, status !== "succeeded");
  assert.deepEqual(JSON.parse(reply.content[0].text), data);
  return data;
}

function notRun(steps) {
  for (const step of steps) {
    assert.equal(step.status, "cancelled");
    assert.equal(step.errorCode, "PLAN_NOT_RUN");
    assert.equal(Object.hasOwn(step, "version"), false);
    assert.equal(Object.hasOwn(step, "summary"), false);
  }
}

function componentPlans(t, execute) {
  const calls = [];
  const pending = [];
  const releases = [];
  // Fixed component fixtures only; no native commands or SDK sessions.
  const plans = createToolPlans({
    publish: () => {},
    isEnabled: () => true,
    execute: async name => {
      calls.push(name);
      return execute ? execute(name) : { version: versions[`runtime.${name.split("_")[0]}`] };
    }
  });
  t.after(async () => {
    plans.close();
    for (const release of releases) release();
    await bounded(Promise.allSettled(pending), "component cleanup");
  });
  function dispatch(signal) {
    const planId = randomUUID();
    const result = plans.dispatch(planId, names.slice(0, 2), signal);
    result.catch(() => {});
    pending.push(result);
    return { planId, result };
  }
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    releases.push(release);
    return { promise, release };
  }
  return { plans, calls, dispatch, gate };
}

function planConflict(action) {
  assert.throws(action, error =>
    (error.status ?? error.statusCode) === 409
  );
}

for (const stop of ["cancel", "abort", "close"]) {
  test(`approved plan ${stop} before consumption starts zero fixture executors`, { timeout: 4000 }, async t => {
    const f = componentPlans(t);
    const controller = new AbortController();
    const { planId, result } = f.dispatch(controller.signal);
    assert.deepEqual(f.plans.decidePlan({ planId, decision: "approve" }), {
      planId, approvalState: "approved"
    });
    // Intentionally synchronous: the approval continuation has not run yet.
    if (stop === "cancel") {
      assert.deepEqual(f.plans.cancelPlan({ planId }), {
        planId, stopRequested: true
      });
      planConflict(() => f.plans.cancelPlan({ planId }));
    } else if (stop === "abort") {
      controller.abort();
    } else {
      f.plans.close();
    }
    assert.deepEqual(f.calls, []);
    const data = outcome(await bounded(result), "cancelled", names.slice(0, 2));
    assert.equal(data.planId, planId);
    assert.equal(data.errorCode, "PLAN_CANCELLED");
    notRun(data.steps);
    assert.deepEqual(f.calls, []);
    planConflict(() => f.plans.cancelPlan({ planId }));
    planConflict(() => f.plans.decidePlan({ planId, decision: "approve" }));
  });
}

test("running and pending plans share twenty active slots until execution finishes", { timeout: 5000 }, async t => {
  let hold;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = componentPlans(t, async name => {
    entered();
    await hold.promise;
    return { version: versions[`runtime.${name.split("_")[0]}`] };
  });
  hold = f.gate();
  const original = Array.from({ length: 20 }, () => f.dispatch());
  assert.equal(f.plans.getPlans().plans.filter(row => row.status === "queued").length, 20);
  assert.deepEqual(f.calls, []);
  const first = original[0];
  f.plans.decidePlan({ planId: first.planId, decision: "approve" });
  await bounded(started, "first fixture executor");
  assert.deepEqual(f.calls, ["git_version"]);
  const overflow = f.dispatch();
  const rejected = outcome(await bounded(overflow.result), "denied", names.slice(0, 2));
  assert.equal(rejected.errorCode, "APPROVAL_QUEUE_FULL");
  notRun(rejected.steps);
  const retained = f.plans.getPlans().plans;
  for (const [index, item] of original.entries()) {
    const row = retained.find(plan => plan.planId === item.planId);
    assert.ok(row, "every original active plan remains retained");
    assert.equal(row.status, index === 0 ? "running" : "queued");
    assert.equal(row.stopRequested, false);
    assert.equal(row.approvalState, index === 0 ? "consumed" : "pending");
  }
  assert.deepEqual(f.calls, ["git_version"]);
  for (const item of original) {
    assert.deepEqual(f.plans.cancelPlan({ planId: item.planId }), {
      planId: item.planId, stopRequested: true
    });
  }
  hold.release();
  const results = await bounded(Promise.all(original.map(item => item.result)));
  for (const [index, reply] of results.entries()) {
    const data = outcome(reply, "cancelled", names.slice(0, 2));
    notRun(data.steps.slice(index === 0 ? 1 : 0));
  }
  assert.deepEqual(f.calls, ["git_version"]);
});

test("terminal retention keeps fifty results without evicting a live plan", { timeout: 5000 }, async t => {
  let hold;
  let entered;
  let holding = false;
  const started = new Promise(resolve => { entered = resolve; });
  const f = componentPlans(t, async name => {
    if (holding) {
      entered();
      await hold.promise;
    }
    return { version: versions[`runtime.${name.split("_")[0]}`] };
  });
  hold = f.gate();
  const completed = f.dispatch();
  f.plans.decidePlan({ planId: completed.planId, decision: "approve" });
  outcome(await bounded(completed.result), "succeeded", names.slice(0, 2));
  holding = true;
  const live = f.dispatch();
  f.plans.decidePlan({ planId: live.planId, decision: "approve" });
  await bounded(started, "held live fixture executor");
  const deniedIds = [];
  for (let index = 0; index < 50; index++) {
    if (index === 49) {
      const retained = f.plans.getPlans().plans;
      assert.equal(retained.filter(row => row.status !== "running").length, 50);
      assert.ok(retained.some(row => row.planId === completed.planId));
      planConflict(() => f.plans.decidePlan({
        planId: completed.planId, decision: "approve"
      }));
    }
    const denied = f.dispatch();
    deniedIds.push(denied.planId);
    f.plans.decidePlan({ planId: denied.planId, decision: "deny" });
    const data = outcome(await bounded(denied.result), "denied", names.slice(0, 2));
    notRun(data.steps);
  }
  const retained = f.plans.getPlans().plans;
  assert.equal(retained.length, 51);
  assert.equal(retained.some(row => row.planId === completed.planId), false);
  assert.deepEqual(retained.filter(row => row.status === "denied").map(row => row.planId), deniedIds);
  assert.equal(retained.find(row => row.planId === live.planId)?.status, "running");
  assert.deepEqual(f.calls, ["git_version", "node_version", "git_version"]);
  assert.deepEqual(f.plans.cancelPlan({ planId: live.planId }), {
    planId: live.planId, stopRequested: true
  });
  hold.release();
  const data = outcome(await bounded(live.result), "cancelled", names.slice(0, 2));
  notRun(data.steps.slice(1));
  assert.equal(f.plans.getPlans().plans.length, 50);
  assert.ok(f.plans.getPlans().plans.some(row => row.planId === live.planId));
  assert.deepEqual(f.calls, ["git_version", "node_version", "git_version"]);
});

test("plan discovery, strict input validation and missing sessions execute nothing", { timeout: 10000 }, async t => {
  const f = await start(t);
  const listed = await bounded(f.client.listTools());
  assert.deepEqual(listed.tools.map(tool => tool.name), [...names, "execute_tool_plan"]);
  const schema = listed.tools.find(tool => tool.name === "execute_tool_plan").inputSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["steps"]);
  assert.deepEqual(Object.keys(schema.properties), ["steps"]);
  assert.equal(schema.properties.steps.type, "array");
  assert.equal(schema.properties.steps.minItems, 2);
  assert.equal(schema.properties.steps.maxItems, 3);
  assert.equal(schema.properties.steps.uniqueItems, true);
  assert.equal(schema.properties.steps.items.type, "string");
  assert.deepEqual([...schema.properties.steps.items.enum].sort(), [...names].sort());
  assert.deepEqual(await f.plans(), []);
  await f.enable();
  const invalidArguments = [
    undefined, null, [], marker, {}, { steps: [] }, { steps: [names[0]] },
    { steps: [...names, names[0]] }, { steps: [names[0], names[0]] },
    { steps: [names[0], marker] }, { steps: [names[0], "__proto__"] },
    { steps: [names[0], { tool: names[1], approved: true, args: marker }] },
    { steps: [names[0], null] }, { steps: marker },
    { steps: names, approved: true }, { steps: names, planId: marker },
    { steps: names, command: marker }, { steps: names, arguments: {} }
  ];
  for (const args of invalidArguments) {
    const reply = await bounded(f.raw({ name: "execute_tool_plan", arguments: args }));
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.errorCode, "INVALID_ARGUMENTS");
    assert.equal(JSON.stringify(reply).includes(marker), false);
  }
  for (const extra of [
    { approved: true }, { planId: marker }, { task: marker },
    { _meta: null }, { _meta: [] }, { _meta: marker }
  ]) {
    const reply = await bounded(f.raw({ name: "execute_tool_plan", arguments: { steps: names }, ...extra }));
    assert.equal(reply.structuredContent.errorCode, "INVALID_ARGUMENTS");
  }
  const unknown = await bounded(f.raw({ name: marker, arguments: {} }));
  assert.equal(unknown.structuredContent.errorCode, "TOOL_NOT_ALLOWED");
  const noSession = await bounded(f.raw({
    name: "execute_tool_plan", arguments: { steps: names }
  }, null));
  assert.equal(noSession.structuredContent.errorCode, "SESSION_REQUIRED");
  assert.deepEqual(await f.plans(), []);
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.stringify({ unknown, events: f.app.getEvents() }).includes(marker), false);
});

for (const action of ["deny", "expire", "cancel"]) {
  test(`pending plan ${action} runs zero fixture executors`, { timeout: 6000 }, async t => {
    const f = await start(t, { planApprovalTimeoutMs: action === "expire" ? 150 : 1000 });
    await f.enable();
    const result = f.call(names, {
      _meta: { approved: true, enabled: true, planId: marker, steps: [marker], secret: marker }
    });
    const plan = snapshot(await f.waitPlan(row => row.status === "queued"));
    assert.equal(plan.stopRequested, false);
    assert.ok(plan.steps.every(step => step.status === "planned"));
    assert.deepEqual(await f.get("/api/codex/approvals"), { pending: [] });
    assert.deepEqual(f.calls, []);
    assert.equal((await f.client.listTools()).tools.length, 4);
    assert.deepEqual(f.calls, []);
    if (action === "deny") assert.equal((await f.decide(plan.planId, "deny")).status, 200);
    if (action === "cancel") assert.equal((await f.cancel(plan.planId)).status, 200);
    const data = outcome(await bounded(result), action === "cancel" ? "cancelled" : "denied");
    assert.equal(data.planId, plan.planId);
    assert.equal((await f.decide(plan.planId)).status, 409);
    assert.equal((await f.cancel(plan.planId)).status, 409);
    assert.deepEqual(f.calls, []);
    assert.ok(data.steps.every(step => !["running", "succeeded"].includes(step.status)));
    assert.equal(JSON.stringify({ data, plans: await f.plans(), events: f.app.getEvents() }).includes(marker), false);
  });
}

test("approval with any missing required grant fails preflight before the first executor", { timeout: 8000 }, async t => {
  for (const enabled of [[], ["git_version"], ["node_version"]]) {
    const f = await start(t);
    for (const tool of enabled) await f.grant(tool, true);
    const result = f.call();
    const plan = await f.waitPlan(row => row.status === "queued");
    assert.deepEqual(f.calls, []);
    assert.equal((await f.decide(plan.planId)).status, 200);
    const data = outcome(await bounded(result), "denied");
    assert.equal(data.errorCode, "CODEX_DISABLED");
    assert.deepEqual(f.calls, []);
    assert.ok(data.steps.every(step => step.status !== "succeeded"));
    const policy = await f.get("/api/codex/policy");
    assert.deepEqual(policy.tools, names.slice(0, 2).map(tool => ({
      tool, enabled: enabled.includes(tool)
    })));
  }
});

test("same-origin plan APIs reject malformed decisions and tampering without consuming approval", { timeout: 8000 }, async t => {
  const f = await start(t);
  await f.enable();
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  for (const route of ["/api/codex/plans/decision", "/api/codex/plans/cancel"]) {
    const body = route.endsWith("decision")
      ? { planId: plan.planId, decision: "approve" } : { planId: plan.planId };
    for (const origin of [null, "http://untrusted.example"]) {
      assert.equal((await f.post(route, body, origin)).status, 403);
    }
    for (const invalid of [
      {}, { ...body, planId: null }, { ...body, planId: marker },
      { ...body, approved: true }, { ...body, steps: [marker] },
      { ...body, _meta: { approved: true } }, { ...body, callId: plan.planId }
    ]) {
      assert.equal((await f.post(route, invalid)).status, 400);
    }
    assert.equal((await f.post(route, { ...body, planId: randomUUID() })).status, 404);
  }
  for (const decision of [true, null, "allow", "cancel"]) {
    assert.equal((await f.post("/api/codex/plans/decision", {
      planId: plan.planId, decision
    })).status, 400);
  }
  const crossOriginRead = await fetch(f.base + "/api/codex/plans", {
    headers: { Origin: "http://untrusted.example" }, signal: AbortSignal.timeout(1200)
  });
  assert.equal(crossOriginRead.status, 403);
  assert.deepEqual(f.calls, []);
  const unchanged = (await f.plans()).find(row => row.planId === plan.planId);
  assert.deepEqual(unchanged.steps.map(step => step.tool), names);
  assert.equal(unchanged.status, "queued");
  assert.equal((await f.decide(plan.planId, "deny")).status, 200);
  outcome(await bounded(result), "denied");
  assert.deepEqual(f.calls, []);
});

test("one approval executes frozen order once and correlates SDK, snapshots and history IDs", { timeout: 8000 }, async t => {
  const f = await start(t);
  await f.enable();
  const policy = await f.get("/api/codex/policy");
  const result = f.call(names, { _meta: { approved: true, callId: marker, secret: marker } });
  const queued = snapshot(await f.waitPlan(row => row.status === "queued"));
  assert.deepEqual(f.calls, []);
  const decisions = await Promise.all([f.decide(queued.planId), f.decide(queued.planId)]);
  assert.deepEqual(decisions.map(response => response.status).sort(), [200, 409]);
  const data = outcome(await bounded(result), "succeeded");
  assert.equal(data.planId, queued.planId);
  assert.deepEqual(data.steps.map(step => [step.stepId, step.callId]),
    queued.steps.map(step => [step.stepId, step.callId]));
  assert.deepEqual(f.calls, toolIds.map(id => [id]));
  assert.deepEqual(data.steps.map(step => step.status), ["succeeded", "succeeded", "succeeded"]);
  assert.equal(data.steps[0].version, versions["runtime.git"]);
  assert.equal(data.steps[1].version, versions["runtime.node"]);
  assert.deepEqual(data.steps[2].summary, clean);
  assert.deepEqual(await f.get("/api/codex/approvals"), { pending: [] });
  assert.deepEqual(await f.get("/api/codex/policy"), policy);
  assert.equal((await f.decide(data.planId)).status, 409);
  assert.deepEqual(f.calls, toolIds.map(id => [id]));
  const terminal = snapshot((await f.plans()).find(row => row.planId === data.planId));
  assert.equal(terminal.status, data.status);
  assert.deepEqual(terminal.steps, data.steps);
  const history = await f.get("/api/history");
  const events = history.events.filter(event => event.planId === data.planId);
  assert.ok(events.length);
  const outer = events.filter(event => event.callId === data.planId);
  assert.equal(outer[0].status, "queued");
  assert.equal(outer.at(-1).status, "succeeded");
  assert.equal(outer.at(-1).toolId, "execute_tool_plan");
  let priorSuccess = -1;
  for (const step of data.steps) {
    const related = events.filter(event => event.stepId === step.stepId);
    assert.ok(related.some(event => event.status === "running"));
    assert.equal(related.at(-1).status, "succeeded");
    for (const event of related) {
      assert.equal(event.callId, step.callId);
      assert.equal(event.stepIndex, step.stepIndex);
      assert.equal(event.toolId, step.toolId);
      assert.equal(event.source, "codex");
    }
    const runningIndex = events.findIndex(event => event.stepId === step.stepId && event.status === "running");
    assert.ok(runningIndex > priorSuccess);
    priorSuccess = events.findIndex(event => event.stepId === step.stepId && event.status === "succeeded");
  }
  assert.equal(JSON.stringify({ data, terminal, history }).includes(marker), false);
});

for (const failure of ["throw", "invalid-version", "project"]) {
  test(`plan ${failure} failure is sanitized and preserves earlier fixture results`, { timeout: 6000 }, async t => {
    const calls = [];
    const f = await start(t, {
      codexRunner: async toolId => {
        calls.push(toolId);
        if (toolId === "runtime.node" && failure === "throw") throw Error(marker);
        return { text: toolId === "runtime.node" && failure === "invalid-version" ? marker : versions[toolId] };
      },
      projectGitRunner: async () => {
        calls.push("project_git_status");
        throw Error(marker);
      }
    });
    await f.enable();
    const result = f.call();
    const plan = await f.waitPlan(row => row.status === "queued");
    assert.equal((await f.decide(plan.planId)).status, 200);
    const data = outcome(await bounded(result), "failed");
    assert.equal(data.steps[0].version, versions["runtime.git"]);
    assert.equal(data.steps[0].status, "succeeded");
    const failedIndex = failure === "project" ? 2 : 1;
    assert.equal(data.steps[failedIndex].status, "failed");
    assert.equal(data.steps[failedIndex].errorCode, failedIndex === 2 ? "PROJECT_GIT_FAILED" : "TOOL_FAILED");
    notRun(data.steps.slice(failedIndex + 1));
    assert.deepEqual(calls, toolIds.slice(0, failedIndex + 1));
    assert.equal(JSON.stringify({ data, events: f.app.getEvents(), plans: await f.plans() }).includes(marker), false);
  });
}

for (const revoked of ["git_version", "node_version"]) {
  test(`revoking ${revoked} during step one latches denial despite re-enabling`, { timeout: 6000 }, async t => {
    const calls = [];
    let hold;
    const f = await start(t, {
      codexRunner: async id => {
        calls.push(id);
        await hold.promise;
        return { text: versions[id] };
      }
    });
    hold = f.gate();
    await f.enable();
    const result = f.call();
    const plan = await f.waitPlan(row => row.status === "queued");
    assert.equal((await f.decide(plan.planId)).status, 200);
    await f.waitPlan(row => row.planId === plan.planId && row.steps[0].status === "running");
    await f.grant(revoked, false);
    await f.grant(revoked, true);
    hold.release();
    const data = outcome(await bounded(result), "denied");
    assert.equal(data.errorCode, "CODEX_DISABLED");
    assert.equal(data.steps[0].status, "succeeded");
    assert.equal(data.steps[0].version, versions["runtime.git"]);
    notRun(data.steps.slice(1));
    assert.deepEqual(calls, ["runtime.git"]);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.decide(plan.planId)).status, 409);
  });
}

for (const stop of ["panel", "sdk", "delete", "disconnect", "close"]) {
  test(`${stop} cancellation during step one preserves its result and stops future steps`, { timeout: 7000 }, async t => {
    const calls = [];
    let hold;
    const f = await start(t, {
      codexRunner: async id => {
        calls.push(id);
        await hold.promise;
        return { text: versions[id] };
      }
    });
    hold = f.gate();
    await f.enable();
    const controller = f.controller();
    const result = stop === "disconnect"
      ? f.raw({ name: "execute_tool_plan", arguments: { steps: names } }, f.transport.sessionId, controller.signal)
      : f.call(names, {}, f.client, controller.signal);
    const settled = result.then(value => ({ value }), error => ({ error }));
    const plan = await f.waitPlan(row => row.status === "queued");
    assert.equal((await f.decide(plan.planId)).status, 200);
    await f.waitPlan(row => row.planId === plan.planId && row.steps[0].status === "running");
    let closing;
    if (stop === "panel") {
      assert.equal((await f.cancel(plan.planId)).status, 200);
      assert.equal((await f.cancel(plan.planId)).status, 409);
    } else if (stop === "sdk" || stop === "disconnect") {
      controller.abort();
    } else if (stop === "delete") {
      const response = await fetch(f.base + "/mcp/codex", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": f.transport.sessionId },
        signal: AbortSignal.timeout(1200)
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    } else {
      closing = f.track(f.app.close());
    }
    await f.waitPlan(row => row.planId === plan.planId && row.stopRequested);
    hold.release();
    const terminal = snapshot(await f.waitPlan(row =>
      row.planId === plan.planId && row.status === "cancelled" && row.steps[0].status === "succeeded"
    ));
    assert.equal(terminal.steps[0].version, versions["runtime.git"]);
    notRun(terminal.steps.slice(1));
    assert.deepEqual(calls, ["runtime.git"]);
    assert.deepEqual(f.calls, []);
    const response = await bounded(settled);
    if (stop === "panel") outcome(response.value, "cancelled");
    if (closing) await bounded(closing);
    assert.equal((await f.decide(plan.planId)).status, 409);
    const events = f.app.getEvents().filter(event => event.planId === plan.planId);
    assert.ok(events.some(event => event.callId === terminal.steps[0].callId && event.status === "succeeded"));
    assert.equal(events.some(event => terminal.steps.slice(1).some(step =>
      event.callId === step.callId && event.status === "running"
    )), false);
  });
}

test("Node and project plan does not require the Git version grant", { timeout: 6000 }, async t => {
  const f = await start(t);
  await f.grant("node_version", true);
  const selected = ["node_version", "project_git_status"];
  const result = f.call(selected);
  const plan = snapshot(await f.waitPlan(row => row.status === "queued"), selected);
  assert.equal(plan.steps[0].grantEnabled, true);
  assert.equal(plan.steps[1].grantEnabled, null);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.decide(plan.planId)).status, 200);
  const data = outcome(await bounded(result), "succeeded", selected);
  assert.deepEqual(f.calls, [["runtime.node"], ["project_git_status"]]);
  assert.equal(data.steps[0].version, versions["runtime.node"]);
  assert.deepEqual(data.steps[1].summary, clean);
  assert.deepEqual((await f.get("/api/codex/policy")).tools, [
    { tool: "git_version", enabled: false },
    { tool: "node_version", enabled: true }
  ]);
  assert.deepEqual(await f.get("/api/codex/approvals"), { pending: [] });
});

test("concurrent sessions keep plans, decisions and ordered results isolated", { timeout: 8000 }, async t => {
  const f = await start(t);
  await f.enable();
  const other = await f.another();
  const first = f.call([names[0], names[1]]);
  const a = await f.waitPlan(row => row.status === "queued");
  const second = f.call([names[1], names[0]], {}, other);
  const b = await f.waitPlan(row => row.status === "queued" && row.planId !== a.planId);
  assert.notEqual(a.planId, b.planId);
  const ids = [...a.steps, ...b.steps].map(step => step.callId);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.decide(a.planId, "deny")).status, 200);
  outcome(await bounded(first), "denied", [names[0], names[1]]);
  assert.equal((await f.plans()).find(row => row.planId === b.planId).status, "queued");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.decide(b.planId)).status, 200);
  const data = outcome(await bounded(second), "succeeded", [names[1], names[0]]);
  assert.equal(data.planId, b.planId);
  assert.deepEqual(f.calls, [["runtime.node"], ["runtime.git"]]);
  assert.equal((await f.decide(a.planId)).status, 409);
  assert.equal((await f.decide(b.planId)).status, 409);
});

const proposalKeys = ["tool", "toolId", "label", "stepId", "callId", "stepIndex"];

function proposalMetadata(step) {
  return Object.fromEntries(proposalKeys.map(key => [key, step[key]]));
}

function selectionPending(data) {
  snapshot(data);
  assert.equal(data.selectionFinalized, false);
  assert.deepEqual(data.excludedSteps, []);
  assert.deepEqual(data.proposedSteps, data.steps.map(proposalMetadata));
  for (const step of data.proposedSteps) {
    assert.deepEqual(Object.keys(step).sort(), [...proposalKeys].sort());
    assert.equal(Object.hasOwn(step, "executionIndex"), false);
  }
  return structuredClone(data.proposedSteps);
}

function selectionOutcome(reply, proposed, selected, status = "succeeded") {
  const data = reply.structuredContent;
  assert.equal(data.status, status);
  assert.equal(reply.isError, status !== "succeeded");
  assert.deepEqual(JSON.parse(reply.content[0].text), data);
  assert.equal(data.selectionFinalized, true);
  assert.deepEqual(data.proposedSteps, proposed);
  assert.deepEqual(data.steps.map(step => step.tool), selected);
  for (const [index, step] of data.steps.entries()) {
    assert.deepEqual(proposalMetadata(step), proposed.find(item => item.tool === selected[index]));
    assert.equal(step.executionIndex, index + 1);
    assert.ok(["planned", "running", "succeeded", "failed", "denied", "cancelled"].includes(step.status));
    assert.ok(step.grantEnabled === null || typeof step.grantEnabled === "boolean");
    if (status === "succeeded") assert.equal(step.status, "succeeded");
  }
  const excluded = proposed.filter(step => !selected.includes(step.tool));
  assert.equal(data.excludedSteps.length, excluded.length);
  for (const [index, step] of data.excludedSteps.entries()) {
    assert.deepEqual(Object.keys(step).sort(),
      [...proposalKeys, "reasonCode", "reason"].sort());
    assert.deepEqual(proposalMetadata(step), excluded[index]);
    assert.equal(step.reasonCode, "PLAN_NOT_SELECTED");
    assert.equal(typeof step.reason, "string");
    assert.match(step.reason, /[\u3400-\u9fff]/u);
    assert.equal(step.reason, data.excludedSteps[0].reason);
    assert.equal(step.reason.includes(marker), false);
  }
  return data;
}

function selectionPlans(t, { execute, timeoutMs = 1000 } = {}) {
  const calls = [];
  const events = [];
  const pending = [];
  const releases = [];
  const grants = new Map(names.slice(0, 2).map(name => [name, true]));
  // These are injected component results, not evidence of native execution.
  const plans = createToolPlans({
    timeoutMs,
    publish: event => events.push(structuredClone(event)),
    isEnabled: name => grants.get(name) === true,
    execute: async name => {
      calls.push(name);
      if (execute) return execute(name);
      return name === "project_git_status"
        ? { summary: structuredClone(clean), resultSummary: "测试夹具：干净工作区" }
        : { version: versions[toolIds[names.indexOf(name)]] };
    }
  });
  t.after(async () => {
    plans.close();
    for (const release of releases) release();
    await bounded(Promise.allSettled(pending), "selection fixture cleanup");
  });
  function dispatch() {
    const planId = randomUUID();
    const result = plans.dispatch(planId, names.slice());
    result.catch(() => {});
    pending.push(result);
    return { planId, result };
  }
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    releases.push(release);
    return { promise, release };
  }
  function grant(name, enabled) {
    grants.set(name, enabled);
    if (!enabled) plans.revoke(name);
  }
  const read = planId => plans.getPlans().plans.find(row => row.planId === planId);
  return { plans, calls, events, dispatch, gate, grant, read };
}

test("invalid approval selections and steps on deny or cancel leave approval pending and execute nothing", { timeout: 8000 }, async t => {
  const f = await start(t);
  await f.enable();
  const offered = names.slice(0, 2);
  const result = f.call(offered);
  const plan = await f.waitPlan(row => row.status === "queued");
  const body = { planId: plan.planId, decision: "approve" };
  const invalid = [
    { steps: [] },
    { steps: [names[0], names[0]] },
    { steps: [null] },
    { steps: [1] },
    { steps: [{ tool: names[0] }] },
    { steps: {} },
    { steps: marker },
    { steps: [marker] },
    { steps: [names[2]] },
    { steps: [names[0]], arguments: {} },
    { steps: [names[0]], args: [] },
    { steps: [names[0]], stepId: plan.steps[0].stepId },
    { steps: [names[0]], callId: plan.steps[0].callId },
    { steps: [names[0]], _meta: { approved: true } }
  ];
  for (const extra of invalid) {
    const response = await f.post("/api/codex/plans/decision", { ...body, ...extra });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes(marker), false);
    assert.equal(JSON.stringify(f.app.getEvents()).includes(marker), false);
    const current = (await f.plans()).find(row => row.planId === plan.planId);
    assert.equal(current.approvalState, "pending");
    assert.equal(current.selectionFinalized, false);
    assert.equal(current.stopRequested, false);
    assert.deepEqual(current.steps, plan.steps);
    assert.deepEqual(f.calls, []);
  }
  for (const decision of ["deny", "cancel"]) {
    const route = decision === "deny" ? "/api/codex/plans/decision" : "/api/codex/plans/cancel";
    const input = decision === "deny"
      ? { planId: plan.planId, decision, steps: [names[0]] }
      : { planId: plan.planId, steps: [names[0]] };
    assert.equal((await f.post(route, input)).status, 400);
    assert.equal((await f.plans()).find(row => row.planId === plan.planId).approvalState, "pending");
    assert.deepEqual(f.calls, []);
  }
  for (const origin of [null, "http://untrusted.example"]) {
    assert.equal((await f.post("/api/codex/plans/decision",
      { ...body, steps: [names[1]] }, origin)).status, 403);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post("/api/codex/plans/decision",
    { ...body, steps: [names[1]] })).status, 200);
  selectionOutcome(await bounded(result), plan.steps.map(proposalMetadata), [names[1]]);
  assert.deepEqual(f.calls, [["runtime.node"]]);
});

test("project-first selection with a disabled Node grant fails preflight before any executor", { timeout: 6000 }, async t => {
  const f = await start(t);
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  const proposed = selectionPending(plan);
  const selected = [names[2], names[1]];
  assert.deepEqual((await f.get("/api/codex/policy")).tools, [
    { tool: names[0], enabled: false }, { tool: names[1], enabled: false }
  ]);
  assert.deepEqual(f.calls, []);
  const response = await f.post("/api/codex/plans/decision", {
    planId: plan.planId, decision: "approve", steps: selected
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    planId: plan.planId, approvalState: "approved"
  });
  const data = selectionOutcome(await bounded(result), proposed, selected, "denied");
  assert.equal(data.errorCode, "CODEX_DISABLED");
  notRun(data.steps);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.plans()).find(row => row.planId === plan.planId), data);
  const events = f.app.getEvents().filter(event => event.planId === plan.planId);
  assert.equal(events.some(event => event.status === "running"), false);
  const approved = events.filter(event => event.phase === "approved-selection");
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0].approvedOrder, selected);
  for (const step of data.steps) {
    const related = events.filter(event => event.stepId === step.stepId);
    assert.deepEqual(related.map(event => event.status), ["planned", "cancelled"]);
    assert.equal(related.at(-1).errorCode, "PLAN_NOT_RUN");
  }
});

test("project-only selection from three proposed steps succeeds with both version grants closed", { timeout: 6000 }, async t => {
  const f = await start(t);
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  const proposed = selectionPending(plan);
  assert.deepEqual((await f.get("/api/codex/policy")).tools, [
    { tool: names[0], enabled: false }, { tool: names[1], enabled: false }
  ]);
  assert.equal((await f.post("/api/codex/plans/decision", {
    planId: plan.planId, decision: "approve", steps: [names[2]]
  })).status, 200);
  const data = selectionOutcome(await bounded(result), proposed, [names[2]]);
  assert.deepEqual(data.steps[0].summary, clean);
  assert.deepEqual(f.calls, [["project_git_status"]]);
  const events = f.app.getEvents().filter(event => event.planId === plan.planId);
  for (const excluded of data.excludedSteps) {
    assert.deepEqual(events.filter(event => event.stepId === excluded.stepId)
      .map(event => event.status), ["planned"]);
  }
  assert.equal(events.some(event => event.errorCode === "PLAN_NOT_RUN"), false);
});

test("reordered subset preserves proposal identities in MCP results, snapshots and execution events", { timeout: 7000 }, async t => {
  const f = await start(t);
  await f.grant(names[1], true);
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  const proposed = selectionPending(plan);
  const selected = [names[2], names[1]];
  assert.equal((await f.post("/api/codex/plans/decision", {
    planId: plan.planId, decision: "approve", steps: selected
  })).status, 200);
  const data = selectionOutcome(await bounded(result), proposed, selected);
  assert.deepEqual(f.calls, [["project_git_status"], ["runtime.node"]]);
  assert.deepEqual(data.steps.map(step => step.stepIndex), [3, 2]);
  assert.deepEqual(data.steps[0].summary, clean);
  assert.equal(data.steps[1].version, versions["runtime.node"]);
  assert.deepEqual((await f.plans()).find(row => row.planId === plan.planId), data);
  const events = (await f.get("/api/history")).events.filter(event => event.planId === plan.planId);
  const planned = events.filter(event => event.status === "planned");
  assert.equal(planned.length, 3);
  for (const [index, event] of planned.entries()) {
    assert.equal(event.phase, "proposal");
    assert.equal(event.stepId, proposed[index].stepId);
    assert.equal(event.callId, proposed[index].callId);
    assert.equal(event.stepIndex, proposed[index].stepIndex);
    assert.equal(event.tool, proposed[index].tool);
  }
  const approvals = events.filter(event => event.phase === "approved-selection");
  assert.equal(approvals.length, 1);
  const approval = approvals[0];
  assert.equal(approval.status, "queued");
  assert.equal(approval.callId, plan.planId);
  assert.deepEqual(approval.approvedOrder, selected);
  assert.deepEqual(approval.selectedStepIds, data.steps.map(step => step.stepId));
  assert.deepEqual(approval.unselectedStepIds, [proposed[0].stepId]);
  const actual = events.filter(event => event.stepId && event.status !== "planned");
  assert.deepEqual(actual.map(event => [event.tool, event.status]), [
    [names[2], "running"], [names[2], "succeeded"],
    [names[1], "running"], [names[1], "succeeded"]
  ]);
  assert.ok(events.indexOf(approval) < events.indexOf(actual[0]));
  for (const event of actual) {
    const step = data.steps.find(item => item.stepId === event.stepId);
    assert.ok(step);
    assert.equal(event.callId, step.callId);
    assert.equal(event.toolId, step.toolId);
    assert.equal(event.stepIndex, step.stepIndex);
    assert.equal(event.executionIndex, step.executionIndex);
    assert.equal(event.source, "codex");
  }
  assert.equal(events.some(event => event.errorCode === "PLAN_NOT_RUN"), false);
  assert.deepEqual(events.filter(event => event.stepId === proposed[0].stepId)
    .map(event => event.status), ["planned"]);
});

test("concurrent different HTTP selections accept one decision and retain exactly its selection", { timeout: 6000 }, async t => {
  const f = await start(t);
  await f.enable();
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  const choices = [[names[2], names[1]], [names[0]]];
  const responses = await Promise.all(choices.map(steps =>
    f.post("/api/codex/plans/decision", {
      planId: plan.planId, decision: "approve", steps
    })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = choices[responses.findIndex(response => response.status === 200)];
  const data = selectionOutcome(await bounded(result), plan.steps.map(proposalMetadata), winner);
  assert.deepEqual(f.calls, winner.map(name => [toolIds[names.indexOf(name)]]));
  assert.deepEqual((await f.plans()).find(row => row.planId === plan.planId), data);
  const approved = f.app.getEvents().filter(event =>
    event.planId === plan.planId && event.phase === "approved-selection");
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0].approvedOrder, winner);
});

test("synchronous different approvals preserve the first selection before consumption", { timeout: 4000 }, async t => {
  const f = selectionPlans(t);
  const { planId, result } = f.dispatch();
  const proposed = selectionPending(f.read(planId));
  const selected = [names[2]];
  assert.deepEqual(f.plans.decidePlan({
    planId, decision: "approve", steps: selected
  }), { planId, approvalState: "approved" });
  // No await: both decisions occur before the approval continuation can execute.
  planConflict(() => f.plans.decidePlan({
    planId, decision: "approve", steps: [names[1], names[2]]
  }));
  assert.deepEqual(f.calls, []);
  const approvedSnapshot = f.read(planId);
  assert.equal(approvedSnapshot.approvalState, "approved");
  assert.equal(approvedSnapshot.selectionFinalized, true);
  assert.deepEqual(approvedSnapshot.proposedSteps, proposed);
  assert.deepEqual(approvedSnapshot.steps.map(step => step.tool), selected);
  assert.deepEqual(approvedSnapshot.steps.map(proposalMetadata), [proposed[2]]);
  assert.deepEqual(approvedSnapshot.steps.map(step => step.executionIndex), [1]);
  const approvedEvents = f.events.filter(event => event.phase === "approved-selection");
  assert.equal(approvedEvents.length, 1);
  assert.deepEqual(approvedEvents[0].approvedOrder, selected);
  assert.deepEqual(approvedEvents[0].selectedStepIds, [proposed[2].stepId]);
  assert.deepEqual(approvedEvents[0].unselectedStepIds,
    proposed.slice(0, 2).map(step => step.stepId));
  assert.equal(f.events.some(event => event.status === "running"), false);
  const data = selectionOutcome(await bounded(result), proposed, selected);
  assert.deepEqual(f.calls, selected);
  assert.deepEqual(data.steps[0].summary, clean);
  assert.deepEqual(f.read(planId), data);
  assert.deepEqual(f.events.filter(event => event.phase === "approved-selection"),
    approvedEvents);
  assert.deepEqual(f.events.filter(event => event.stepId && event.status !== "planned")
    .map(event => [event.stepId, event.tool, event.status]), [
    [proposed[2].stepId, names[2], "running"],
    [proposed[2].stepId, names[2], "succeeded"]
  ]);
});

test("synchronous approval freezes caller selection and isolates pending, approved and terminal snapshots", { timeout: 4000 }, async t => {
  const f = selectionPlans(t);
  const { planId, result } = f.dispatch();
  const pending = f.read(planId);
  const proposed = selectionPending(pending);
  pending.proposedSteps[0].tool = marker;
  pending.steps.reverse();
  pending.excludedSteps.push({ tool: marker });
  assert.deepEqual(f.read(planId).proposedSteps, proposed);
  const selected = [names[2], names[1]];
  assert.deepEqual(f.plans.decidePlan({ planId, decision: "approve", steps: selected }), {
    planId, approvalState: "approved"
  });
  assert.deepEqual(f.calls, []);
  selected.splice(0, selected.length, names[0]);
  const approved = f.read(planId);
  assert.equal(approved.selectionFinalized, true);
  assert.deepEqual(approved.steps.map(step => step.tool), [names[2], names[1]]);
  approved.steps[0].tool = marker;
  approved.steps[1].executionIndex = 99;
  approved.proposedSteps[0].stepId = marker;
  approved.excludedSteps[0].reason = marker;
  approved.excludedSteps.length = 0;
  const data = selectionOutcome(await bounded(result), proposed, [names[2], names[1]]);
  assert.deepEqual(f.calls, [names[2], names[1]]);
  const terminal = f.read(planId);
  terminal.steps.length = 0;
  terminal.proposedSteps[0].callId = marker;
  terminal.excludedSteps[0].tool = marker;
  assert.deepEqual(f.read(planId), data);
  assert.equal(JSON.stringify({ data, events: f.events }).includes(marker), false);
});

test("direct approve versus deny competition freezes the first legal decision in either order", { timeout: 4000 }, async t => {
  for (const first of ["approve", "deny"]) {
    const f = selectionPlans(t);
    const { planId, result } = f.dispatch();
    const proposed = selectionPending(f.read(planId));
    const approve = { planId, decision: "approve", steps: [names[2]] };
    const deny = { planId, decision: "deny" };
    const accepted = first === "approve" ? approve : deny;
    const rejected = first === "approve" ? deny : approve;
    assert.deepEqual(f.plans.decidePlan(accepted), {
      planId, approvalState: first === "approve" ? "approved" : "denied"
    });
    planConflict(() => f.plans.decidePlan(rejected));
    assert.deepEqual(f.calls, []);
    if (first === "approve") {
      selectionOutcome(await bounded(result), proposed, [names[2]]);
      assert.deepEqual(f.calls, [names[2]]);
    } else {
      const data = outcome(await bounded(result), "denied");
      assert.equal(data.selectionFinalized, false);
      assert.deepEqual(data.proposedSteps, proposed);
      assert.deepEqual(data.excludedSteps, []);
      assert.deepEqual(f.calls, []);
      assert.equal(f.events.some(event => event.phase === "approved-selection"), false);
    }
    planConflict(() => f.plans.decidePlan(rejected));
  }
});

test("selected approval immediately cancelled before consumption starts no fixture executors", { timeout: 4000 }, async t => {
  const f = selectionPlans(t);
  const { planId, result } = f.dispatch();
  const proposed = selectionPending(f.read(planId));
  f.plans.decidePlan({ planId, decision: "approve", steps: [names[2], names[1]] });
  assert.deepEqual(f.plans.cancelPlan({ planId }), { planId, stopRequested: true });
  assert.deepEqual(f.calls, []);
  const data = selectionOutcome(await bounded(result), proposed,
    [names[2], names[1]], "cancelled");
  assert.equal(data.errorCode, "PLAN_CANCELLED");
  notRun(data.steps);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.some(event => event.status === "running"), false);
  assert.deepEqual(f.events.filter(event => event.stepId === proposed[0].stepId)
    .map(event => event.status), ["planned"]);
});

test("disabling a pending proposal grant keeps approval available for the remaining Node and project selection", { timeout: 6000 }, async t => {
  const f = await start(t);
  await f.enable();
  const result = f.call();
  const plan = await f.waitPlan(row => row.status === "queued");
  const proposed = selectionPending(plan);
  await f.grant(names[0], false);
  const pending = (await f.plans()).find(row => row.planId === plan.planId);
  assert.equal(pending.status, "queued");
  assert.equal(pending.approvalState, "pending");
  assert.equal(pending.selectionFinalized, false);
  assert.equal(pending.stopRequested, false);
  assert.equal(pending.expiresAt, plan.expiresAt);
  assert.deepEqual(pending.proposedSteps, proposed);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post("/api/codex/plans/decision", {
    planId: plan.planId, decision: "approve", steps: [names[1], names[2]]
  })).status, 200);
  selectionOutcome(await bounded(result), proposed, [names[1], names[2]]);
  assert.deepEqual(f.calls, [["runtime.node"], ["project_git_status"]]);
});

test("selected grant revocation after approval but before consumption latches even when reopened", { timeout: 4000 }, async t => {
  const f = selectionPlans(t);
  const { planId, result } = f.dispatch();
  const proposed = selectionPending(f.read(planId));
  f.plans.decidePlan({ planId, decision: "approve", steps: [names[2], names[1]] });
  f.grant(names[1], false);
  f.grant(names[1], true);
  assert.equal(f.read(planId).stopRequested, true);
  assert.deepEqual(f.calls, []);
  const data = selectionOutcome(await bounded(result), proposed,
    [names[2], names[1]], "denied");
  assert.equal(data.errorCode, "CODEX_DISABLED");
  notRun(data.steps);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.some(event => event.status === "running"), false);
});

test("running selections distinguish current, future, excluded and completed grant revocations", { timeout: 10000 }, async t => {
  for (const scenario of ["current", "future", "excluded", "completed"]) {
    let hold;
    const selected = scenario === "current"
      ? [names[1], names[2]]
      : scenario === "completed" ? [names[1], names[2]] : [names[2], names[1]];
    const held = scenario === "completed" ? names[2] : selected[0];
    const f = selectionPlans(t, {
      execute: async name => {
        if (name === held) await hold.promise;
        return name === names[2]
          ? { summary: structuredClone(clean) }
          : { version: versions[toolIds[names.indexOf(name)]] };
      }
    });
    hold = f.gate();
    const { planId, result } = f.dispatch();
    const proposed = selectionPending(f.read(planId));
    f.plans.decidePlan({ planId, decision: "approve", steps: selected });
    await until(() => f.read(planId),
      row => row.steps.some(step => step.tool === held && step.status === "running"),
      `${scenario} selected fixture gate`);
    const before = f.read(planId);
    const revoked = scenario === "excluded" ? names[0] : names[1];
    if (scenario === "completed") assert.equal(before.steps[0].status, "succeeded");
    f.grant(revoked, false);
    const stopped = scenario === "current" || scenario === "future";
    assert.equal(f.read(planId).stopRequested, stopped, scenario);
    f.grant(revoked, true);
    assert.equal(f.read(planId).stopRequested, stopped, scenario);
    hold.release();
    const data = selectionOutcome(await bounded(result), proposed, selected,
      stopped ? "denied" : "succeeded");
    if (stopped) {
      assert.equal(data.errorCode, "CODEX_DISABLED");
      assert.equal(data.steps[0].status, "succeeded");
      notRun(data.steps.slice(1));
      assert.deepEqual(f.calls, [selected[0]]);
    } else {
      assert.deepEqual(f.calls, selected);
      assert.equal(data.stopRequested, false);
    }
    if (scenario === "current" || scenario === "completed") {
      assert.equal(data.steps[0].version, versions["runtime.node"]);
    }
    if (scenario === "completed") {
      assert.deepEqual(proposalMetadata(data.steps[0]), proposalMetadata(before.steps[0]));
      assert.equal(data.steps[0].version, before.steps[0].version);
      assert.equal(data.steps[0].status, before.steps[0].status);
    }
    const excluded = data.excludedSteps.map(step => step.stepId);
    assert.equal(f.events.some(event =>
      excluded.includes(event.stepId) && event.status !== "planned"), false);
    assert.equal(f.events.some(event =>
      event.stepId === data.steps[1].stepId && event.status === "running"), !stopped);
  }
});

test("pending grant changes and invalid late choices do not extend the original approval deadline", { timeout: 4000 }, async t => {
  const f = selectionPlans(t, { timeoutMs: 120 });
  const { planId, result } = f.dispatch();
  const pending = f.read(planId);
  const proposed = selectionPending(pending);
  f.grant(names[0], false);
  assert.throws(() => f.plans.decidePlan({
    planId, decision: "approve", steps: []
  }), error => (error.status ?? error.statusCode) === 400);
  const unchanged = f.read(planId);
  assert.equal(unchanged.approvalState, "pending");
  assert.equal(unchanged.stopRequested, false);
  assert.equal(unchanged.expiresAt, pending.expiresAt);
  // Wait past the recorded deadline, rather than relying on an exact timer tick.
  await delay(Math.max(0, Date.parse(pending.expiresAt) - Date.now()) + 30);
  planConflict(() => f.plans.decidePlan({
    planId, decision: "approve", steps: [names[2]]
  }));
  const data = outcome(await bounded(result), "denied");
  assert.equal(data.approvalState, "expired");
  assert.equal(data.selectionFinalized, false);
  assert.equal(data.expiresAt, pending.expiresAt);
  assert.deepEqual(data.proposedSteps, proposed);
  assert.deepEqual(data.excludedSteps, []);
  notRun(data.steps);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.some(event =>
    event.phase === "approved-selection" || event.status === "running"), false);
});
