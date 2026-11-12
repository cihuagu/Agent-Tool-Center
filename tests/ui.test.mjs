import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/server.mjs";

class Element {
  children = [];
  disabled = false;
  textContent = "";
  value = "";
  classList = { add() {}, remove() {} };
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener() {}
  setAttribute() {}
}
async function page() {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => new Element(), querySelector: () => ({ value: "manual" }), querySelectorAll: () => [] },
    window: {}, console,
    fetch: async () => ({ ok: true, json: async () => ({
      tools: [], events: [], enabled: false, state: "stopped",
      coverage: { limit: 20, turnCount: 0, hasMore: false }
    }) })
  });
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  return { context, node, run: source => vm.runInContext(source, context) };
}

test("202 then history failure keeps plan consumed and reports temporary record failure", async () => {
  const { context, node, run } = await page();
  run('state.plan = { planId: "p", candidates: [{ toolId: "mcp.fixture.read", name: "fixture", recommended: true, kind: "mcp" }] }; state.selected.add("mcp.fixture.read");');
  let executions = 0;
  context.fetch = async url => {
    if (url === "/api/execute") { executions++; return { ok: true, json: async () => ({ toolIds: ["mcp.fixture.read"] }) }; }
    throw Error("history offline");
  };
  await run("executePlan()");
  assert.match(node("feedback").textContent, /执行已接收，记录暂不可用/);
  assert.doesNotMatch(node("feedback").textContent, /执行被阻止/);
  assert.equal(run("state.usedPlan"), true);
  assert.equal(node("runBtn").disabled, true);
  await run("executePlan()");
  assert.equal(executions, 1);
});

test("product event view distinguishes denial, tool error, timeout, protocol error and success", async () => {
  const { node, run } = await page();
  for (const [id, status, errorCode] of [[1, "denied"], [2, "failed", "MCP_TOOL_ERROR"], [3, "failed", "MCP_TIMEOUT"], [4, "succeeded"], [5, "failed", "MCP_PROTOCOL_ERROR"]])
    run(`addEvent(${JSON.stringify({ id, status, errorCode, at: new Date().toISOString(), toolId: "mcp.fixture.read" })})`);
  const labels = node("events").children.map(item => item.children.at(-1).textContent);
  assert.deepEqual(labels, ["协议错误", "成功", "超时", "工具错误", "已拒绝"]);
});

test("Codex success and denial display their own call ID and only success shows a version", async () => {
  const { node, run } = await page();
  for (const event of [
    { id: 1, callId: "allowed-id", source: "codex", status: "succeeded", resultSummary: "git version 9.9.9" },
    { id: 2, callId: "denied-id", source: "codex", status: "denied", error: "Codex Git 查询已禁用" }
  ]) run(`addEvent(${JSON.stringify({ ...event, at: new Date().toISOString(), toolId: "runtime.git" })})`);
  const [denied, success] = node("events").children.map(item => item.children.map(child => child.textContent).join(" "));
  assert.match(success, /来源：Codex · 调用 ID：allowed-id/);
  assert.match(success, /git version 9.9.9/);
  assert.match(denied, /调用 ID：denied-id/);
  assert.match(denied, /已拒绝/);
  assert.doesNotMatch(denied, /git version|allowed-id/);
});

test("observer events display actual metadata, suppress payload fields and dedupe repeated source events", async () => {
  const { node, run } = await page();
  const event = {
    id: 1, source: "codex-observer", toolId: "codex.native.terminal",
    threadId: "selected-thread", turnId: "actual-turn", callId: "exec-actual",
    status: "succeeded", sourceStatus: "completed", exitCode: 0,
    at: "2026-11-11T05:04:42.674Z", recordedAt: "2026-11-11T05:05:00.000Z",
    timestampSource: "source", elapsedMs: 345,
    command: "secret-command", resultSummary: "secret-output", error: "secret-error"
  };
  run(`addEvent(${JSON.stringify(event)})`);
  run(`addEvent(${JSON.stringify({ ...event, id: 2 })})`);
  assert.equal(run("state.events.size"), 1);
  const rendered = node("events").children[0].children.map(child => child.textContent).join(" ");
  assert.match(rendered, /codex-observer · 只读观察/);
  assert.match(rendered, /selected-thread/);
  assert.match(rendered, /actual-turn/);
  assert.match(rendered, /exec-actual/);
  assert.ok(rendered.includes(event.at));
  assert.ok(rendered.includes(event.recordedAt));
  assert.match(rendered, /退出码：0/);
  assert.doesNotMatch(rendered, /secret-/);
});

test("recorded custom and function calls show returned evidence, source IDs and dedupe without success claims", async () => {
  const { node, run } = await page();
  const base = {
    source: "codex-observer", threadId: "selected-thread", turnId: "recent-turn",
    callId: "call-custom", toolId: "codex.recorded.custom",
    rawKind: "custom_tool_call", toolName: "exec", status: "queued",
    at: "2026-11-11T07:05:06.685Z", timestampSource: "source",
    recordedAt: "2026-11-11T07:05:10.000Z",
    input: "PRIVATE-input", output: "PRIVATE-output", body: "PRIVATE-body"
  };
  for (const event of [
    { ...base, id: 1 },
    { ...base, id: 2 },
    { ...base, id: 3, status: "completed" },
    { ...base, id: 4, status: "completed" },
    { ...base, id: 5, callId: "call-function", rawKind: "function_call",
      toolName: "tools.lookup", toolId: "codex.recorded.function", status: "completed" }
  ]) run(`addEvent(${JSON.stringify(event)})`);
  assert.equal(run("state.events.size"), 3);
  const rendered = node("events").children.map(item =>
    item.children.map(child => child.textContent).join(" "));
  assert.match(rendered[0], /Function 工具 · tools.lookup/);
  assert.match(rendered[1], /Custom 工具 · exec/);
  assert.match(rendered[1], /已返回/);
  assert.match(rendered[2], /调用已记录/);
  assert.ok(rendered[1].includes(base.at));
  assert.match(rendered[1], /selected-thread.*recent-turn.*call-custom/);
  assert.doesNotMatch(rendered.join(" "), /成功|PRIVATE|退出码|ms/);
});

test("raw coverage limits and unavailability remain visible beside structured coverage", async () => {
  const { node, run } = await page();
  const status = {
    state: "observing", enabled: true, threadId: "selected-thread",
    lastReadAt: "2026-11-11T07:05:10.000Z",
    coverage: { limit: 20, turnCount: 4, hasMore: true,
      raw: { available: true, truncated: true, skippedLines: 1 } }
  };
  run(`renderObserverStatus(${JSON.stringify(status)})`);
  assert.match(node("observerStatus").textContent, /4\/20 轮/);
  assert.match(node("observerStatus").textContent, /末尾最多 2MiB/);
  assert.match(node("observerStatus").textContent, /截断，记录可能不完整/);
  run(`renderObserverStatus(${JSON.stringify({
    ...status, coverage: { ...status.coverage, raw: { available: false } }
  })})`);
  assert.match(node("observerStatus").textContent, /观察中/);
  assert.match(node("observerStatus").textContent, /补充记录不可用；原生终端仍按结构化历史覆盖/);
});

test("native observer events render by source timestamp before ingestion id", async () => {
  const { node, run } = await page();
  const makeEvent = (id, at, callId) => ({
    id,
    at,
    source: "codex-observer",
    controllability: "observable",
    toolId: "codex.recorded.custom",
    rawKind: "custom_tool_call",
    toolName: "exec",
    status: "completed",
    sourceStatus: "returned",
    threadId: "fixture-thread",
    turnId: "fixture-turn",
    callId,
    timestampSource: "source",
    recordedAt: "2026-11-11T12:00:00.000Z",
  });
  const latest = makeEvent(1, "2026-11-11T11:59:00.000Z", "fixture-call-latest");
  const older = makeEvent(2, "2026-11-11T11:58:00.000Z", "fixture-call-older");
  const rowText = (row) => row.children.map((child) => child.textContent);

  run(`addEvent(${JSON.stringify(latest)})`);
  const latestText = rowText(node("events").children[0]);
  run("state.events.clear()");
  run(`addEvent(${JSON.stringify(older)})`);
  const olderText = rowText(node("events").children[0]);
  assert.notDeepEqual(latestText, olderText);

  run(`addEvent(${JSON.stringify(latest)})`);
  assert.equal(node("events").children.length, 2);
  assert.deepEqual(rowText(node("events").children[0]), latestText);
  assert.deepEqual(rowText(node("events").children[1]), olderText);
});

test("observer start and stop use dedicated APIs and source read failures remain visible", async () => {
  const { context, node, run } = await page();
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({
      state: url.endsWith("/start") ? "error" : "stopped",
      enabled: false, threadId: "selected-thread", lastReadAt: null,
      lastErrorCode: url.endsWith("/start") ? "OBSERVER_READ_FAILED" : null,
      coverage: { limit: 20, turnCount: 0, hasMore: false }
    }) };
  };
  node("observerThread").value = " selected-thread ";
  await run('changeObserver("start")');
  assert.match(node("observerStatus").textContent, /读取失败，观察已停止/);
  assert.match(node("observerStatus").textContent, /尚未完成源读取/);
  assert.equal(node("observerStop").disabled, false);
  await run('changeObserver("stop")');
  assert.match(node("observerStatus").textContent, /已停止/);
  assert.deepEqual(requests, [
    { url: "/api/codex/observer/start", body: { threadId: "selected-thread" } },
    { url: "/api/codex/observer/stop", body: {} }
  ]);
});

test("observer action errors omit raw diagnostics and stale status cannot overwrite a confirmed start", async () => {
  const { context, node, run } = await page();
  let resolveStatus;
  context.fetch = async (url, options) => {
    if (!options.method) return new Promise(resolve => { resolveStatus = resolve; });
    return { ok: true, json: async () => ({
      state: "observing", enabled: true, threadId: "selected-thread",
      lastReadAt: "2026-11-11T05:05:00.000Z",
      coverage: { limit: 20, turnCount: 20, hasMore: true }
    }) };
  };
  const loading = run("loadObserverStatus()");
  node("observerThread").value = "selected-thread";
  await run('changeObserver("start")');
  resolveStatus({ ok: true, json: async () => ({ state: "stopped", enabled: false }) });
  await loading;
  assert.match(node("observerStatus").textContent, /观察中/);
  assert.match(node("observerStatus").textContent, /更早轮次未覆盖/);
  assert.equal(node("observerStart").disabled, true);
  assert.equal(node("observerStop").disabled, false);
  context.fetch = async () => { throw Error("secret-source-diagnostic"); };
  await run('changeObserver("stop")');
  assert.match(node("observerError").textContent, /变更未确认/);
  assert.match(node("observerStatus").textContent, /无法读取只读观察状态/);
  assert.doesNotMatch(node("observerError").textContent + node("observerStatus").textContent, /secret-source/);
  assert.equal(node("observerStop").disabled, false);
});

test("Codex toggle sends only a boolean and renders the confirmed backend policy", async () => {
  const { context, node, run } = await page();
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ enabled: JSON.parse(options.body).enabled }) };
  };
  for (const enabled of [true, false]) {
    node("codexEnabled").checked = enabled;
    await run("changeCodexPolicy()");
    assert.equal(node("codexEnabled").checked, enabled);
    assert.equal(node("codexEnabled").disabled, false);
    assert.match(node("codexStatus").textContent, enabled ? /已允许/ : /已禁用/);
  }
  assert.deepEqual(requests, [
    { url: "/api/codex/policy", body: { enabled: true } },
    { url: "/api/codex/policy", body: { enabled: false } }
  ]);
});

test("Codex policy save failure reloads backend state; unreadable state disables the toggle", async () => {
  const { context, node, run } = await page();
  context.fetch = async (url, options) => {
    if (options.method === "POST") throw Error("offline");
    return { ok: true, json: async () => ({ enabled: true }) };
  };
  node("codexEnabled").checked = false;
  await run("changeCodexPolicy()");
  assert.equal(node("codexEnabled").checked, true);
  assert.match(node("codexStatus").textContent, /更新未确认/);
  context.fetch = async () => { throw Error("offline"); };
  await run("loadCodexPolicy()");
  assert.equal(node("codexEnabled").disabled, true);
  assert.match(node("codexStatus").textContent, /无法读取授权状态/);
  assert.equal(node("codexNodeEnabled").disabled, true);
  assert.match(node("codexNodeStatus").textContent, /无法读取授权状态/);
});

test("Codex toggles render independent backend confirmations and Node uses its explicit grant", async () => {
  const { context, node, run } = await page();
  const requests = [];
  let backend = { git_version: false, node_version: true };
  context.fetch = async (url, options) => {
    if (options.method === "POST") requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({
      enabled: backend.git_version,
      tools: Object.entries(backend).map(([tool, enabled]) => ({ tool, enabled }))
    }) };
  };
  await run("loadCodexPolicy()");
  assert.equal(node("codexEnabled").checked, false);
  assert.equal(node("codexNodeEnabled").checked, true);
  node("codexEnabled").checked = true;
  await run("changeCodexPolicy()");
  assert.equal(node("codexEnabled").checked, false, "requested state cannot replace the backend confirmation");
  assert.equal(node("codexNodeEnabled").checked, true);
  backend = { git_version: true, node_version: false };
  await run("loadCodexPolicy()");
  node("codexNodeEnabled").checked = true;
  await run('changeCodexPolicy("node_version")');
  assert.equal(node("codexEnabled").checked, true);
  assert.equal(node("codexNodeEnabled").checked, false);
  assert.match(node("codexStatus").textContent, /已允许.*git --version/);
  assert.match(node("codexNodeStatus").textContent, /已禁用/);
  backend.node_version = true;
  await run("loadCodexPolicy()");
  assert.match(node("codexNodeStatus").textContent, /已允许.*node --version/);
  assert.deepEqual(requests, [{ enabled: true }, { tool: "node_version", enabled: true }]);
  assert.equal(node("codexEnabled").disabled, false);
  assert.equal(node("codexNodeEnabled").disabled, false);
});

test("Node policy save failure reloads its grant and marks only Node unconfirmed", async () => {
  const { context, node, run } = await page();
  context.fetch = async (url, options) => {
    if (options.method === "POST") throw Error("offline");
    return { ok: true, json: async () => ({ enabled: false,
      tools: [{ tool: "git_version", enabled: false }, { tool: "node_version", enabled: true }]
    }) };
  };
  node("codexNodeEnabled").checked = false;
  await run('changeCodexPolicy("node_version")');
  assert.equal(node("codexEnabled").checked, false);
  assert.equal(node("codexNodeEnabled").checked, true);
  assert.equal(node("codexNodeEnabled").disabled, false);
  assert.match(node("codexNodeStatus").textContent, /更新未确认/);
  assert.match(node("codexStatus").textContent, /已禁用/);
  context.fetch = async () => { throw Error("offline"); };
  await run('changeCodexPolicy("node_version")');
  assert.equal(node("codexNodeEnabled").disabled, true);
  assert.match(node("codexNodeStatus").textContent, /更新未确认/);
  assert.equal(node("codexEnabled").disabled, false);
  assert.match(node("codexStatus").textContent, /已禁用/);
});

test("independent Codex confirmations cannot overwrite the other toggle with an older snapshot", async () => {
  const { context, node, run } = await page();
  const pending = [];
  context.fetch = () => new Promise(resolve => pending.push(resolve));
  node("codexEnabled").checked = true;
  const git = run("changeCodexPolicy()");
  node("codexNodeEnabled").checked = true;
  const nodeVersion = run('changeCodexPolicy("node_version")');
  const reply = enabled => ({ ok: true, json: async () => ({ enabled: true,
    tools: [{ tool: "git_version", enabled: true }, { tool: "node_version", enabled }]
  }) });
  pending[1](reply(true));
  await nodeVersion;
  assert.equal(node("codexNodeEnabled").checked, true);
  pending[0](reply(false));
  await git;
  assert.equal(node("codexEnabled").checked, true);
  assert.equal(node("codexNodeEnabled").checked, true);
});

test("failed Codex save recovery cannot overwrite or unlock another tool's pending save", async () => {
  for (const recoverFirst of [true, false]) {
    const { context, node, run } = await page();
    await run("loadCodexPolicy()");
    let recover, confirmNode;
    context.fetch = (url, options) => {
      if (options.method !== "POST") return new Promise(resolve => { recover = resolve; });
      if (!JSON.parse(options.body).tool) throw Error("offline");
      return new Promise(resolve => { confirmNode = resolve; });
    };
    node("codexEnabled").checked = true;
    const git = run("changeCodexPolicy()");
    node("codexNodeEnabled").checked = true;
    const nodeVersion = run('changeCodexPolicy("node_version")');
    await new Promise(resolve => setImmediate(resolve));
    const reply = enabled => ({ ok: true, json: async () => ({ enabled: false,
      tools: [{ tool: "git_version", enabled: false }, { tool: "node_version", enabled }]
    }) });
    if (!recoverFirst) {
      confirmNode(reply(true));
      await nodeVersion;
    }
    recover(reply(false));
    await git;
    assert.equal(node("codexEnabled").checked, false);
    assert.equal(node("codexEnabled").disabled, false);
    assert.match(node("codexStatus").textContent, /更新未确认/);
    assert.equal(node("codexNodeEnabled").checked, true);
    assert.equal(node("codexNodeEnabled").disabled, recoverFirst);
    if (recoverFirst) {
      confirmNode(reply(true));
      await nodeVersion;
    }
    assert.match(node("codexNodeStatus").textContent, /已允许.*node --version/);
  }
});

for (const [name, toolId, toggleId, invocation, versionPattern] of [
  ["git_version", "runtime.git", "codexEnabled", "changeCodexPolicy()", /^git version /],
  ["node_version", "runtime.node", "codexNodeEnabled", 'changeCodexPolicy("node_version")', /^v\d+\.\d+\.\d+$/]
]) {
  test(`panel ${name} success and denial correlate with real MCP responses and history`, { timeout: 15000 }, async t => {
    const app = createApp({ mcp: { discover: async () => ({ available: false }), close: async () => {} } });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + app.server.address().port;
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
      await app.close();
    });
    const { context, node, run } = await page();
    context.fetch = (url, options) => fetch(base + url, {
      ...options, headers: { ...options.headers, Origin: base }
    });
    await run("loadCodexPolicy()");
    const results = [];
    for (const enabled of [true, false]) {
      node(toggleId).checked = enabled;
      await run(invocation);
      assert.equal(node(toggleId).checked, enabled);
      const reply = await fetch(base + "/mcp/codex", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })
      }).then(r => r.json());
      const data = reply.result.structuredContent;
      assert.equal(data.status, enabled ? "succeeded" : "denied");
      assert.equal(data.toolId, toolId);
      if (enabled) assert.match(data.version, versionPattern);
      else assert.equal(data.errorCode, "CODEX_DISABLED");
      const history = await fetch(base + "/api/history").then(r => r.json());
      const event = history.events.find(event => event.callId === data.callId && event.status === data.status);
      assert.ok(event);
      run(`addEvent(${JSON.stringify(event)})`);
      const rendered = node("events").children[0].children.map(child => child.textContent).join(" ");
      assert.ok(rendered.includes(data.callId));
      assert.ok(rendered.includes(toolId));
      assert.match(rendered, enabled ? /成功/ : /已拒绝/);
      if (enabled) assert.ok(rendered.includes(data.version));
      else assert.equal(rendered.includes(results[0].version), false);
      results.push(data);
    }
    assert.notEqual(results[0].callId, results[1].callId);
    if (name === "node_version") assert.equal(results[0].version, process.version);
  });
}

test("project approval cards show scope, call ID and deadline and send only one decision while saving", async () => {
  const { context, node, run } = await page();
  await run("loadApprovals()");
  const request = {
    callId: "11111111-1111-4111-8111-111111111111",
    purpose: "检查本项目 Git 工作区",
    scope: "仅 Agent Tool Center 项目",
    expiresAt: new Date(Date.now() + 45000).toISOString()
  };
  let queue = [request];
  let save;
  const requests = [];
  context.fetch = async (url, options) => {
    if (options.method === "POST") {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { save = resolve; });
    }
    return { ok: true, json: async () => ({ pending: queue }) };
  };
  await run("loadApprovals()");
  const card = node("approvalCards").children[0];
  const text = card.children.map(child => child.textContent).join(" ");
  assert.match(text, /检查本项目 Git 工作区/);
  assert.match(text, /只读.*Agent Tool Center/);
  assert.ok(text.includes(request.callId));
  assert.ok(text.includes(request.expiresAt));
  assert.match(text, /45 秒/);
  assert.deepEqual(card.children.at(-1).children.map(button => button.textContent), ["允许本次", "拒绝"]);
  const saving = run(`decideApproval("${request.callId}", "approve")`);
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => button.disabled));
  await run(`decideApproval("${request.callId}", "approve")`);
  assert.equal(requests.length, 1);
  queue = [];
  save({ ok: true, json: async () => ({ callId: request.callId, approvalState: "approved" }) });
  await saving;
  assert.deepEqual(requests, [{
    url: "/api/codex/approvals/decision",
    body: { callId: request.callId, decision: "approve" }
  }]);
  assert.match(node("approvalCards").children[0].textContent, /暂无待确认请求.*project_git_status/);
});

test("approval failures requery backend instead of assuming approval and unreadable state disables decisions", async () => {
  const { context, node, run } = await page();
  await run("loadApprovals()");
  const request = {
    callId: "22222222-2222-4222-8222-222222222222",
    purpose: "检查工作区", scope: "本项目",
    expiresAt: new Date(Date.now() + 45000).toISOString()
  };
  let readable = true;
  let saves = 0;
  context.fetch = async (url, options) => {
    if (options.method === "POST") { saves++; throw Error("PRIVATE-network"); }
    if (!readable) throw Error("PRIVATE-backend");
    return { ok: true, json: async () => ({ pending: [request] }) };
  };
  await run("loadApprovals()");
  await run(`decideApproval("${request.callId}", "deny")`);
  assert.match(node("approvalStatus").textContent, /决定未确认，已尝试重新查询后端/);
  assert.equal(node("approvalCards").children[0].children.at(-1).children[0].disabled, false);
  readable = false;
  await run(`decideApproval("${request.callId}", "approve")`);
  assert.equal(run("approvalsReadable"), false);
  assert.match(node("approvalCards").children[0].textContent, /状态不可用/);
  assert.match(node("approvalStatus").textContent, /已尝试重新查询后端/);
  await run(`decideApproval("${request.callId}", "approve")`);
  assert.equal(saves, 2);
  assert.doesNotMatch(node("approvalStatus").textContent, /PRIVATE/);
});

test("stale approval polling cannot resurrect a card after a confirmed decision refresh", async () => {
  const { context, node, run } = await page();
  await run("loadApprovals()");
  const request = {
    callId: "stale", purpose: "检查工作区", scope: "本项目",
    expiresAt: new Date(Date.now() + 45000).toISOString()
  };
  context.fetch = async () => ({ ok: true, json: async () => ({ pending: [request] }) });
  await run("loadApprovals()");
  const reads = [];
  let save;
  context.fetch = (url, options) => {
    if (options.method === "POST") return new Promise(resolve => { save = resolve; });
    return new Promise(resolve => reads.push(resolve));
  };
  const older = run("loadApprovals()");
  const saving = run('decideApproval("stale", "approve")');
  save({ ok: true, json: async () => ({ approvalState: "approved" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1, "the decision must wait for the existing read");
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => button.disabled));
  reads[0]({ ok: true, json: async () => ({ pending: [] }) });
  await older;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, "the decision must start a fresh read after the stale read settles");
  assert.equal(run("approvalPending.length"), 1, "the invalidated response cannot update the cards");
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => button.disabled));
  reads[1]({ ok: true, json: async () => ({ pending: [] }) });
  await saving;
  assert.match(node("approvalCards").children[0].textContent, /暂无待确认请求/);
  assert.equal(run("approvalSaving.size"), 0);
});

test("overlapping approval polls share a delayed read and eventually display the pending card", async () => {
  const { context, node, run } = await page();
  await run("loadApprovals()");
  const request = {
    callId: "delayed", purpose: "检查工作区", scope: "本项目",
    expiresAt: new Date(Date.now() + 45000).toISOString()
  };
  const reads = [];
  let save;
  context.fetch = (url, options) => {
    if (options.method === "POST") return new Promise(resolve => { save = resolve; });
    return new Promise(resolve => reads.push(resolve));
  };
  const loading = run("loadApprovals()");
  const polls = Array.from({ length: 12 }, () => run("loadApprovals()"));
  assert.ok(polls.every(poll => poll === loading));
  assert.equal(reads.length, 1);
  reads[0]({ ok: true, json: async () => ({ pending: [request] }) });
  await Promise.all([loading, ...polls]);
  assert.equal(reads.length, 1);
  assert.ok(node("approvalCards").children[0].children.some(child =>
    child.textContent.includes(request.callId)));
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => !button.disabled));

  const stale = run("loadApprovals()");
  const saving = run('decideApproval("delayed", "deny")');
  save({ ok: true, json: async () => ({ approvalState: "denied" }) });
  await new Promise(resolve => setImmediate(resolve));
  const overlapping = Array.from({ length: 12 }, () => run("loadApprovals()"));
  assert.ok(overlapping.every(poll => poll === stale));
  assert.equal(reads.length, 2);
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => button.disabled));
  reads[1]({ ok: true, json: async () => ({ pending: [request] }) });
  await Promise.all([stale, ...overlapping]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 3);
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => button.disabled));
  reads[2]({ ok: true, json: async () => ({ pending: [] }) });
  await saving;
  assert.match(node("approvalCards").children[0].textContent, /暂无待确认请求/);
  assert.equal(run("approvalSaving.size"), 0);
});

test("two approval decisions stay independently locked until their fresh backend reads settle", async () => {
  const { context, node, run } = await page();
  await run("loadApprovals()");
  const requests = ["first", "second"].map(callId => ({
    callId, purpose: "检查工作区", scope: "本项目",
    expiresAt: new Date(Date.now() + 45000).toISOString()
  }));
  context.fetch = async () => ({ ok: true, json: async () => ({ pending: requests }) });
  await run("loadApprovals()");
  const saves = new Map();
  const reads = [];
  context.fetch = (url, options) => {
    if (options.method === "POST") {
      return new Promise(resolve => saves.set(JSON.parse(options.body).callId, resolve));
    }
    return new Promise(resolve => reads.push(resolve));
  };
  const first = run('decideApproval("first", "approve")');
  const second = run('decideApproval("second", "deny")');
  assert.equal(saves.size, 2);
  assert.ok(node("approvalCards").children.every(card =>
    card.children.at(-1).children.every(button => button.disabled)));

  saves.get("first")({ ok: true, json: async () => ({ approvalState: "approved" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1);
  reads[0]({ ok: true, json: async () => ({ pending: requests }) });
  await first;
  assert.ok(node("approvalCards").children[0].children.at(-1).children.every(button => !button.disabled),
    "a confirmed POST cannot remove a card still present in the backend queue");
  assert.ok(node("approvalCards").children[1].children.at(-1).children.every(button => button.disabled));
  assert.equal(run('approvalSaving.has("second")'), true);

  saves.get("second")({ ok: true, json: async () => ({ approvalState: "denied" }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2);
  assert.ok(node("approvalCards").children[1].children.at(-1).children.every(button => button.disabled));
  reads[1]({ ok: true, json: async () => ({ pending: [requests[0]] }) });
  await second;
  assert.equal(node("approvalCards").children.length, 1);
  assert.ok(node("approvalCards").children[0].children.some(child =>
    child.textContent.includes("调用 ID：first")));
  assert.equal(run("approvalSaving.size"), 0);
});

test("approval timeline labels waiting and expiry with the same call ID", async () => {
  const { node, run } = await page();
  const base = {
    source: "codex", toolId: "project_git_status",
    callId: "same-project-call", at: new Date().toISOString()
  };
  run(`addEvent(${JSON.stringify({ ...base, id: 1, status: "queued", phase: "approval" })})`);
  run(`addEvent(${JSON.stringify({ ...base, id: 2, status: "denied", errorCode: "APPROVAL_EXPIRED" })})`);
  const rows = node("events").children;
  assert.deepEqual(rows.map(row => row.children.at(-1).textContent), ["确认已过期", "等待你确认"]);
  for (const row of rows) {
    assert.ok(row.children.some(child => child.textContent.includes("same-project-call")));
  }
});
