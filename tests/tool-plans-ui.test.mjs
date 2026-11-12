import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const now = Date.parse("2026-11-11T12:00:00.000Z");
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = data => ({ ok: true, json: async () => data });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  children = [];
  disabled = false;
  value = "";
  className = "";
  attributes = new Map();
  listeners = new Map();
  classList = { add() {}, remove() {} };
  _text = "";

  get textContent() {
    return this._text + this.children.map(child =>
      typeof child === "string" ? child : child.textContent).join("");
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  set innerHTML(_) {
    throw Error("The UI must construct DOM nodes instead of assigning innerHTML");
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this._text = ""; this.children = items; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  click() {
    if (this.disabled) return [];
    const event = { target: this, currentTarget: this, preventDefault() {} };
    return (this.listeners.get("click") || []).map(handler => handler(event));
  }
}

function descendants(root) {
  return [root, ...root.children.flatMap(child =>
    typeof child === "string" ? [] : descendants(child))];
}

function buttons(root) {
  return descendants(root).filter(node => node.tagName === "BUTTON");
}

function plan(overrides = {}) {
  const planId = overrides.planId || "plan-fixture";
  return {
    planId,
    callId: planId,
    source: "codex",
    toolId: "execute_tool_plan",
    purpose: "按计划检查开发环境与本项目状态",
    scope: "仅固定只读工具",
    status: "queued",
    expiresAt: new Date(now + 30000).toISOString(),
    stopRequested: false,
    steps: [
      { stepId: `${planId}-step-git`, callId: `${planId}-call-git`,
        stepIndex: 1, tool: "git_version", toolId: "runtime.git",
        status: "planned", grantEnabled: true },
      { stepId: `${planId}-step-node`, callId: `${planId}-call-node`,
        stepIndex: 2, tool: "node_version", toolId: "runtime.node",
        status: "planned", grantEnabled: false },
      { stepId: `${planId}-step-project`, callId: `${planId}-call-project`,
        stepIndex: 3, tool: "project_git_status", toolId: "project_git_status",
        status: "planned", grantEnabled: null }
    ],
    ...overrides
  };
}

async function page(initialPlans = []) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const intervals = new Map();
  const streams = [];
  const requests = [];
  let currentTime = now;
  let nextTimer = 0;
  let route = async url => {
    if (url === "/api/codex/plans") return reply({ plans: initialPlans });
    return reply({
      tools: [], events: [], pending: [], enabled: false,
      state: "stopped", coverage: { limit: 20, turnCount: 0, hasMore: false }
    });
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  class EventSource {
    listeners = new Map();
    constructor(url) { this.url = url; streams.push(this); }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    emit(type, data) {
      for (const handler of this.listeners.get(type) || []) {
        handler({ data: JSON.stringify(data) });
      }
    }
    close() {}
  }
  const setInterval = (callback, delay) => {
    const id = ++nextTimer;
    intervals.set(id, { callback, delay });
    return id;
  };
  const context = vm.createContext({
    document: {
      getElementById: node,
      createElement(tag) {
        const element = new Element();
        element.tagName = tag.toUpperCase();
        return element;
      },
      querySelector: () => ({ value: "manual" }),
      querySelectorAll: () => []
    },
    Date: FixedDate,
    EventSource,
    window: { EventSource, setInterval, clearInterval: id => intervals.delete(id) },
    setInterval,
    clearInterval: id => intervals.delete(id),
    console,
    fetch: (url, options = {}) => {
      requests.push({ url, method: options.method || "GET",
        body: options.body === undefined ? undefined : JSON.parse(options.body) });
      return route(url, options);
    }
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  // Drain initialization before replacing routes or beginning a controlled race.
  await tick();
  await tick();
  for (const name of ["loadCodexPlans", "decideCodexPlan", "cancelCodexPlan"]) {
    assert.equal(run(`typeof ${name}`), "function", `${name} must be publicly callable`);
  }
  return {
    node, run, requests, intervals, streams,
    advanceTime(milliseconds) { currentTime += milliseconds; },
    route(handler) { route = handler; },
    cards: () => node("codexPlanCards"),
    text: () => node("codexPlanStatus").textContent + " " + node("codexPlanCards").textContent,
    posts: () => requests.filter(request => request.method === "POST")
  };
}

function invoke(ui, snapshot, action) {
  return action === "cancel"
    ? ui.run(`cancelCodexPlan(${JSON.stringify(snapshot.planId)})`)
    : ui.run(`decideCodexPlan(${JSON.stringify(snapshot.planId)}, ${JSON.stringify(action)})`);
}

test("unchanged plan polls preserve card and button identities and keep actions clickable", async () => {
  const snapshot = plan();
  const ui = await page([snapshot]);
  const card = ui.cards().children[0];
  const originalButtons = buttons(card);
  let reads = 0;
  ui.route(async (_url, options) => {
    if (options.method === "POST") return reply({ planId: snapshot.planId });
    reads++;
    return reply({ plans: [JSON.parse(JSON.stringify(snapshot))] });
  });
  for (let index = 0; index < 2; index++) {
    await ui.run("loadCodexPlans()");
    assert.strictEqual(ui.cards().children[0], card);
    buttons(ui.cards()).forEach((button, position) => {
      assert.strictEqual(button, originalButtons[position]);
      assert.equal(button.disabled, false);
    });
  }
  assert.equal(reads, 2, "both polls must read the backend");
  await Promise.all(originalButtons[0].click());
  assert.deepEqual(ui.posts(), [{
    url: "/api/codex/plans/decision",
    method: "POST",
    body: { planId: snapshot.planId, decision: "approve" }
  }]);
});

test("unchanged polls update countdown and expiry without replacing queued DOM nodes", async () => {
  const snapshot = plan();
  const ui = await page([snapshot]);
  const card = ui.cards().children[0];
  const originalButtons = buttons(card);
  const countdown = descendants(card).find(node =>
    node.tagName === "P" && node.textContent.includes("确认截止时间："));
  assert.ok(countdown);
  assert.match(countdown.textContent, /剩余 30 秒（最多 30 秒）/);
  ui.route(async () => reply({ plans: [JSON.parse(JSON.stringify(snapshot))] }));

  for (const [advance, seconds] of [[1000, 29], [28500, 1], [500, 0]]) {
    ui.advanceTime(advance);
    await ui.run("loadCodexPlans()");
    assert.strictEqual(ui.cards().children[0], card);
    assert.ok(descendants(card).includes(countdown));
    assert.ok(countdown.textContent.includes(`剩余 ${seconds} 秒（最多 30 秒）`));
    buttons(ui.cards()).forEach((button, index) => {
      assert.strictEqual(button, originalButtons[index]);
      assert.equal(button.disabled, seconds === 0);
    });
  }
  for (const button of originalButtons) await Promise.all(button.click());
  assert.equal(ui.posts().length, 0, "expired buttons cannot submit actions");
});

test("grant, status and result changes still refresh plan cards after unchanged polls", async () => {
  let snapshot = plan();
  const ui = await page([snapshot]);
  ui.route(async () => reply({ plans: [JSON.parse(JSON.stringify(snapshot))] }));
  await ui.run("loadCodexPlans()");
  snapshot = {
    ...snapshot,
    steps: snapshot.steps.map(step => ({ ...step, grantEnabled: false }))
  };
  await ui.run("loadCodexPlans()");
  assert.doesNotMatch(ui.cards().textContent, /已允许 · 仍受现有版本查询授权开关约束/);
  assert.match(ui.cards().textContent, /已禁用 · 版本查询授权未允许/);

  snapshot = { ...snapshot, status: "running" };
  await ui.run("loadCodexPlans()");
  assert.deepEqual(buttons(ui.cards()).map(button => button.textContent), ["停止后续步骤"]);
  assert.match(ui.cards().textContent, /执行中/);

  snapshot = {
    ...snapshot,
    steps: snapshot.steps.map((step, index) => index === 0
      ? { ...step, status: "succeeded", resultSummary: "git version 9.8.7" }
      : step)
  };
  await ui.run("loadCodexPlans()");
  assert.match(ui.cards().textContent, /git version 9\.8\.7/);
  assert.match(ui.cards().textContent, /已成功 1\/3/);
});

test("queued plans show the complete backend preview, ordered IDs, grants and deadline", async () => {
  const snapshot = plan();
  const ui = await page();
  assert.doesNotMatch(ui.cards().textContent, /plan-fixture|runtime\.git|runtime\.node/);
  ui.route(async () => reply({ plans: [snapshot] }));
  await ui.run("loadCodexPlans()");
  const text = ui.cards().textContent;
  for (const value of [snapshot.planId, snapshot.purpose, snapshot.scope, snapshot.expiresAt]) {
    assert.ok(text.includes(value), `preview must contain ${value}`);
  }
  let previous = -1;
  for (const step of snapshot.steps) {
    const position = text.indexOf(step.stepId);
    assert.ok(position > previous, "steps must retain backend execution order");
    previous = position;
    assert.ok(text.includes(step.callId), "per-step call IDs must remain inspectable");
    assert.ok(text.includes(step.tool) || text.includes(step.toolId));
  }
  assert.match(text, /30\s*秒/);
  assert.match(text, /已允许|已授权|已启用/);
  assert.match(text, /已禁用|未授权|未允许/);
  assert.doesNotMatch(text, /执行中|git version \d|v\d+\.\d+\.\d+/);
  assert.deepEqual(buttons(ui.cards()).map(button => button.textContent), ["允许此计划", "拒绝"]);
  assert.ok(buttons(ui.cards()).every(button => !button.disabled));

  // A one-step backend plan must not acquire locally invented steps.
  const shorter = plan({ planId: "only-backend-step", steps: [snapshot.steps[1]] });
  ui.route(async () => reply({ plans: [shorter] }));
  await ui.run("loadCodexPlans()");
  assert.ok(ui.cards().textContent.includes(snapshot.steps[1].stepId));
  assert.ok(!ui.cards().textContent.includes(snapshot.steps[0].stepId));
  assert.ok(!ui.cards().textContent.includes(snapshot.steps[2].stepId));
});

test("untrusted plan text is literal DOM text", async () => {
  const payload = '<img src=x onerror="PRIVATE-execute()">';
  const snapshot = plan({ purpose: payload });
  const ui = await page([snapshot]);
  await ui.run("loadCodexPlans()");
  assert.ok(ui.cards().textContent.includes(payload));
  assert.equal(descendants(ui.cards()).some(node => node.tagName === "IMG"), false);
});

for (const action of ["approve", "deny", "cancel"]) {
  test(`${action} sends minimal fields once and stays locked through backend reconciliation`, async () => {
    const snapshot = plan({ status: action === "cancel" ? "running" : "queued" });
    const ui = await page([snapshot]);
    await ui.run("loadCodexPlans()");
    const save = deferred();
    const refresh = deferred();
    let reads = 0;
    ui.route((url, options) => {
      if (options.method === "POST") return save.promise;
      assert.equal(url, "/api/codex/plans");
      reads++;
      return refresh.promise;
    });
    const label = action === "approve" ? "允许此计划"
      : action === "deny" ? "拒绝" : "停止后续步骤";
    const button = buttons(ui.cards()).find(item => item.textContent === label);
    assert.ok(button, `missing ${label} button`);
    const handled = button.click();
    const duplicate = invoke(ui, snapshot, action);
    await duplicate;
    assert.equal(ui.posts().length, 1);
    assert.ok(buttons(ui.cards()).every(item => item.disabled));
    save.resolve(reply({ planId: snapshot.planId }));
    await tick();
    assert.equal(reads, 1);
    await invoke(ui, snapshot, action);
    assert.equal(ui.posts().length, 1, "POST completion alone cannot release the action lock");
    assert.ok(buttons(ui.cards()).every(item => item.disabled));
    refresh.resolve(reply({ plans: [snapshot] }));
    await Promise.all(handled);
    await tick();
    assert.ok(buttons(ui.cards()).every(item => !item.disabled),
      "a fresh unchanged backend snapshot permits retry instead of assuming success");
    assert.deepEqual(ui.posts(), [{
      url: action === "cancel" ? "/api/codex/plans/cancel" : "/api/codex/plans/decision",
      method: "POST",
      body: action === "cancel" ? { planId: snapshot.planId }
        : { planId: snapshot.planId, decision: action }
    }]);
  });
}

test("running plans distinguish the actual running step and explain stopping subsequent steps", async () => {
  const snapshot = plan({ status: "running" });
  snapshot.steps[0] = { ...snapshot.steps[0], status: "succeeded",
    version: "git version 9.8.7", resultSummary: "git version 9.8.7" };
  snapshot.steps[1] = { ...snapshot.steps[1], status: "running" };
  const ui = await page([snapshot]);
  await ui.run("loadCodexPlans()");
  const text = ui.cards().textContent;
  assert.match(text, /当前|正在/);
  assert.match(text, /只读/);
  assert.match(text, /完成|结束/);
  assert.deepEqual(buttons(ui.cards()).map(button => button.textContent), ["停止后续步骤"]);
  const stepTexts = snapshot.steps.map(step => {
    const candidates = descendants(ui.cards()).filter(node =>
      node.textContent.includes(step.stepId) &&
      snapshot.steps.every(other => other === step || !node.textContent.includes(other.stepId)));
    assert.ok(candidates.length, `step ${step.stepId} needs an individually readable row`);
    return candidates[0].textContent;
  });
  assert.match(stepTexts[0], /成功|完成/);
  assert.doesNotMatch(stepTexts[0], /执行中/);
  assert.match(stepTexts[1], /执行中|正在执行/);
  assert.doesNotMatch(stepTexts[2], /执行中|正在执行|成功/);
});

test("partial cancellation keeps earlier real results, completed count and unexecuted reasons", async () => {
  const snapshot = plan({ status: "cancelled", stopRequested: true });
  snapshot.steps = snapshot.steps.map((step, index) => index === 0
    ? { ...step, status: "succeeded", version: "git version 9.8.7",
      resultSummary: "git version 9.8.7" }
    : { ...step, status: "cancelled", errorCode: "PLAN_NOT_RUN",
      error: "用户停止后续步骤" });
  const ui = await page([snapshot]);
  await ui.run("loadCodexPlans()");
  assert.match(ui.cards().textContent, /git version 9\.8\.7/);
  assert.match(ui.cards().textContent, /1\s*\/\s*3/);
  assert.match(ui.cards().textContent, /已取消/);
  assert.match(ui.cards().textContent, /未执行/);
  assert.match(ui.cards().textContent, /用户停止后续步骤/);
  assert.doesNotMatch(ui.cards().textContent, /可能继续完成/);
  for (const step of snapshot.steps) assert.ok(ui.cards().textContent.includes(step.stepId));
  assert.equal(buttons(ui.cards()).filter(button => !button.disabled).length, 0);
  await invoke(ui, snapshot, "approve");
  await invoke(ui, snapshot, "cancel");
  assert.equal(ui.posts().length, 0, "terminal snapshots cannot submit another action");
});

test("overlapping polls share a slow GET without starving its eventual render", async () => {
  const ui = await page();
  const snapshot = plan({ planId: "slow-backend-plan" });
  const read = deferred();
  let reads = 0;
  ui.route(url => {
    assert.equal(url, "/api/codex/plans");
    reads++;
    return read.promise;
  });
  const loading = ui.run("loadCodexPlans()");
  const overlapping = Array.from({ length: 12 }, () => ui.run("loadCodexPlans()"));
  assert.equal(reads, 1, "overlapping refreshes must share the in-flight request");
  read.resolve(reply({ plans: [snapshot] }));
  await Promise.all([loading, ...overlapping]);
  assert.equal(reads, 1);
  assert.ok(ui.cards().textContent.includes(snapshot.planId),
    "overlapping refreshes cannot invalidate the only usable response");
  assert.ok(buttons(ui.cards()).every(button => !button.disabled));
});

for (const action of ["approve", "cancel"]) {
  test(`${action} invalidates a pre-action GET and waits for a genuinely new snapshot`, async () => {
    const snapshot = plan({ status: action === "cancel" ? "running" : "queued" });
    const ui = await page([snapshot]);
    await ui.run("loadCodexPlans()");
    const reads = [];
    const save = deferred();
    ui.route((url, options) => {
      if (options.method === "POST") return save.promise;
      assert.equal(url, "/api/codex/plans");
      const read = deferred();
      reads.push(read);
      return read.promise;
    });
    const stale = ui.run("loadCodexPlans()");
    const saving = invoke(ui, snapshot, action);
    save.resolve(reply({ planId: snapshot.planId }));
    await tick();
    assert.ok(buttons(ui.cards()).every(button => button.disabled));
    // Implementations may immediately start a fresh GET or wait for the old
    // shared read to settle; neither may apply this pre-action snapshot.
    reads[0].resolve(reply({ plans: [plan({ ...snapshot, purpose: "STALE-PRE-ACTION" })] }));
    await stale;
    await tick();
    assert.doesNotMatch(ui.cards().textContent, /STALE-PRE-ACTION/);
    assert.equal(reads.length, 2, "reconciliation needs a request started after the action");
    assert.ok(buttons(ui.cards()).every(button => button.disabled));
    await invoke(ui, snapshot, action);
    assert.equal(ui.posts().length, 1);
    const terminal = plan({ ...snapshot, status: action === "cancel" ? "cancelled" : "denied",
      purpose: "FRESH-BACKEND-SNAPSHOT" });
    reads[1].resolve(reply({ plans: [terminal] }));
    await saving;
    assert.match(ui.cards().textContent, /FRESH-BACKEND-SNAPSHOT/);
    assert.equal(buttons(ui.cards()).filter(button => !button.disabled).length, 0);
  });
}

for (const action of ["approve", "cancel"]) {
  test(`${action} POST and reconciliation failures report uncertainty and suspend actions`, async () => {
    const snapshot = plan({ status: action === "cancel" ? "running" : "queued" });
    const ui = await page([snapshot]);
    await ui.run("loadCodexPlans()");
    ui.route(async (_url, options) => {
      throw Error(options.method === "POST" ? "PRIVATE-post-token" : "PRIVATE-read-path");
    });
    await invoke(ui, snapshot, action);
    assert.match(ui.text(), /未确认|无法确认|无法读取|不可用/);
    assert.doesNotMatch(ui.text(), /PRIVATE-|允许成功|已成功允许|停止成功|已成功停止/);
    assert.equal(buttons(ui.cards()).filter(button => !button.disabled).length, 0);
    await invoke(ui, snapshot, action);
    assert.equal(ui.posts().length, 1, "unreadable backend state cannot authorize retry");
    ui.route(async () => reply({ plans: [snapshot] }));
    await ui.run("loadCodexPlans()");
    assert.ok(buttons(ui.cards()).length > 0);
    assert.ok(buttons(ui.cards()).every(button => !button.disabled));
  });
}

test("initialization loads plans, polls every second and refreshes on plan-related SSE", async () => {
  const ui = await page();
  assert.ok(ui.requests.some(request =>
    request.url === "/api/codex/plans" && request.method === "GET"));
  let reads = 0;
  ui.route(async url => {
    if (url === "/api/codex/plans") {
      reads++;
      return reply({ plans: [plan({ planId: "polled-plan" })] });
    }
    return reply({ pending: [] });
  });
  for (const timer of ui.intervals.values()) {
    if (timer.delay === 1000) timer.callback();
  }
  await tick();
  assert.ok(reads > 0, "the one-second timer must refresh plan snapshots");
  assert.ok(ui.cards().textContent.includes("polled-plan"));
  const beforeEvent = reads;
  assert.ok(ui.streams.length > 0);
  for (const stream of ui.streams) {
    stream.emit("tool", {
      id: 901, source: "codex", toolId: "runtime.node",
      planId: "event-plan", stepId: "event-step", stepIndex: 2,
      callId: "event-step-call", status: "running",
      at: new Date(now).toISOString()
    });
  }
  await tick();
  assert.ok(reads > beforeEvent, "a Codex event with planId must refresh the plan area");
});

test("timeline distinguishes aggregate plan IDs, step IDs and legacy Codex calls", async () => {
  const ui = await page();
  const base = { source: "codex", at: new Date(now).toISOString() };
  const events = [
    { ...base, id: 801, toolId: "execute_tool_plan", status: "queued",
      planId: "aggregate-plan-id", callId: "aggregate-plan-id" },
    { ...base, id: 802, toolId: "runtime.node", status: "running",
      planId: "aggregate-plan-id", stepId: "distinct-step-id",
      stepIndex: 2, callId: "distinct-step-call-id" },
    { ...base, id: 803, toolId: "runtime.git", status: "succeeded",
      callId: "legacy-single-call-id", resultSummary: "git version 9.8.7" }
  ];
  for (const event of events) ui.run(`addEvent(${JSON.stringify(event)})`);
  const rows = ui.node("events").children;
  const stepRow = rows.find(row => row.textContent.includes("distinct-step-call-id"));
  assert.ok(stepRow);
  assert.match(stepRow.textContent, /aggregate-plan-id/);
  assert.match(stepRow.textContent, /distinct-step-id/);
  assert.match(stepRow.textContent, /步骤\s*[:：#]?\s*2|第\s*2\s*(?:步|项)|2\s*\/\s*\d+/);
  const aggregate = rows.find(row => row.textContent.includes("execute_tool_plan"));
  assert.ok(aggregate);
  assert.match(aggregate.textContent, /aggregate-plan-id/);
  assert.doesNotMatch(aggregate.textContent, /distinct-step-id|distinct-step-call-id/);
  const legacy = rows.find(row => row.textContent.includes("legacy-single-call-id"));
  assert.ok(legacy);
  assert.match(legacy.textContent, /来源：Codex/);
  assert.match(legacy.textContent, /git version 9\.8\.7/);
  assert.doesNotMatch(legacy.textContent, /undefined|null|aggregate-plan-id|distinct-step-id/);
});

function selectablePlan(overrides = {}) {
  const snapshot = plan();
  const labels = {
    git_version: "Git 版本",
    node_version: "Node.js 版本",
    project_git_status: "项目状态"
  };
  snapshot.steps = snapshot.steps.map(step => ({ ...step, label: labels[step.tool] }));
  return {
    ...snapshot,
    proposedSteps: snapshot.steps.map(({ tool, toolId, label, stepId, callId, stepIndex }) =>
      ({ tool, toolId, label, stepId, callId, stepIndex })),
    selectionFinalized: false,
    excludedSteps: [],
    ...overrides
  };
}

function selectionControl(ui, prefix, step) {
  const names = [step.label, step.tool, step.toolId].filter(Boolean);
  const control = descendants(ui.cards()).find(node =>
    names.some(name => node.getAttribute("aria-label") === prefix + name));
  assert.ok(control, `missing accessible ${prefix} control for ${step.tool}`);
  return control;
}

function selectionAction(ui, label) {
  const button = buttons(ui.cards()).find(item => item.textContent === label);
  assert.ok(button, `missing ${label} button`);
  return button;
}

function toggleSelection(ui, snapshot, tool, enabled) {
  assert.equal(ui.run("typeof toggleCodexPlanStep"), "function");
  return ui.run(`toggleCodexPlanStep(${JSON.stringify(snapshot.planId)}, ${JSON.stringify(tool)}, ${enabled})`);
}

function moveSelection(ui, snapshot, tool, direction) {
  assert.equal(ui.run("typeof moveCodexPlanStep"), "function");
  return ui.run(`moveCodexPlanStep(${JSON.stringify(snapshot.planId)}, ${JSON.stringify(tool)}, ${direction})`);
}

function acceptedSelection(snapshot, tools = ["project_git_status", "node_version"]) {
  return {
    ...snapshot,
    status: "succeeded",
    selectionFinalized: true,
    steps: tools.map((tool, index) => ({
      ...snapshot.steps.find(step => step.tool === tool),
      executionIndex: index + 1,
      status: "succeeded",
      resultSummary: `ACCEPTED-${tool}`
    })),
    excludedSteps: snapshot.proposedSteps.filter(step => !tools.includes(step.tool)).map(step => ({
      ...step,
      reasonCode: "PLAN_NOT_SELECTED",
      reason: "用户未选择"
    }))
  };
}

test("selection-capable cards expose the complete proposal and accessible controls; legacy cards stay read-only", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  for (const step of snapshot.proposedSteps) {
    assert.ok(ui.cards().textContent.includes(step.stepId));
    assert.ok(ui.cards().textContent.includes(step.callId));
    const checkbox = selectionControl(ui, "选择", step);
    assert.equal(checkbox.tagName, "INPUT");
    assert.equal(checkbox.type, "checkbox");
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false);
    assert.equal(selectionControl(ui, "上移", step).tagName, "BUTTON");
    assert.equal(selectionControl(ui, "下移", step).tagName, "BUTTON");
  }
  assert.match(ui.cards().textContent, /(?:已选|选中|选择)[^\d]{0,12}3/);
  assert.equal(selectionAction(ui, "允许此计划").disabled, false);
  assert.equal(ui.posts().length, 0);

  const legacy = plan();
  const old = await page([legacy]);
  assert.equal(descendants(old.cards()).filter(node =>
    node.tagName === "INPUT" && node.type === "checkbox").length, 0);
  assert.deepEqual(buttons(old.cards()).map(button => button.textContent), ["允许此计划", "拒绝"]);
  old.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [plan({ status: "denied" })] }));
  await invoke(old, legacy, "approve");
  assert.deepEqual(old.posts()[0].body, { planId: legacy.planId, decision: "approve" });
});

test("deselecting and reordering changes only the local preview and submits selected tool names in order", async () => {
  const snapshot = selectablePlan();
  const original = JSON.parse(JSON.stringify(snapshot));
  const ui = await page([snapshot]);
  const requestsBeforeEditing = ui.requests.length;
  toggleSelection(ui, snapshot, "git_version", false);
  moveSelection(ui, snapshot, "project_git_status", -1);
  assert.equal(selectionControl(ui, "选择", snapshot.steps[0]).checked, false);
  assert.match(ui.cards().textContent, /(?:已选|选中|选择)[^\d]{0,12}2/);
  const selectedCheckboxes = descendants(ui.cards()).filter(node =>
    node.tagName === "INPUT" && node.type === "checkbox" && node.checked);
  assert.deepEqual(selectedCheckboxes.map(node => node.getAttribute("aria-label")),
    ["选择项目状态", "选择Node.js 版本"]);
  assert.equal(ui.requests.length, requestsBeforeEditing, "draft edits must not call the server");
  assert.deepEqual(snapshot, original, "editing must not mutate the backend proposal or steps");
  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedSelection(snapshot)] }));
  await invoke(ui, snapshot, "approve");
  assert.deepEqual(ui.posts()[0].body, {
    planId: snapshot.planId, decision: "approve",
    steps: ["project_git_status", "node_version"]
  });
  assert.deepEqual(snapshot, original);
});

test("rendered checkbox, move and approve listeners submit the visible selection in order", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  const requestsBeforeEditing = ui.requests.length;
  const git = descendants(ui.cards()).find(node =>
    node.tagName === "INPUT" && node.getAttribute("aria-label") === "选择Git 版本");
  assert.ok(git, "the rendered Git checkbox must be accessible by label");
  assert.equal(git.checked, true);
  assert.equal(git.disabled, false);
  git.checked = false;
  const changeHandlers = git.listeners.get("change") || [];
  assert.ok(changeHandlers.length > 0, "the rendered checkbox must register a change listener");
  for (const handler of changeHandlers) {
    await handler({ target: git, currentTarget: git });
  }
  assert.match(ui.cards().textContent, /已选 2 项 · 拟执行顺序（尚未批准）：Node\.js 版本 → 项目状态/);

  const move = descendants(ui.cards()).find(node =>
    node.tagName === "BUTTON" && node.getAttribute("aria-label") === "上移项目状态");
  assert.ok(move, "the rendered project move button must be accessible by label");
  assert.equal(move.disabled, false);
  await Promise.all(move.click());
  assert.match(ui.cards().textContent, /已选 2 项 · 拟执行顺序（尚未批准）：项目状态 → Node\.js 版本/);
  assert.deepEqual(descendants(ui.cards()).filter(node =>
    node.tagName === "INPUT" && node.type === "checkbox" && node.checked)
    .map(node => node.getAttribute("aria-label")), ["选择项目状态", "选择Node.js 版本"]);
  assert.equal(ui.requests.length, requestsBeforeEditing, "control events only edit the local draft");

  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedSelection(snapshot)] }));
  const approve = buttons(ui.cards()).find(button => button.textContent === "允许此计划");
  assert.ok(approve);
  assert.equal(approve.disabled, false);
  await Promise.all(approve.click());
  assert.deepEqual(ui.posts(), [{
    url: "/api/codex/plans/decision",
    method: "POST",
    body: {
      planId: snapshot.planId, decision: "approve",
      steps: ["project_git_status", "node_version"]
    }
  }]);
  assert.match(ui.cards().textContent, /ACCEPTED-project_git_status/);
  assert.match(ui.cards().textContent, /ACCEPTED-node_version/);
});

test("two plan drafts keep independent selections and orders through saves, polls, SSE and grants", async () => {
  function proposal(planId) {
    const snapshot = selectablePlan();
    const identify = step => ({
      ...step,
      stepId: `${planId}-step-${step.tool}`,
      callId: `${planId}-call-${step.tool}`
    });
    return {
      ...snapshot, planId, callId: planId,
      steps: snapshot.steps.map(identify),
      proposedSteps: snapshot.proposedSteps.map(identify)
    };
  }
  const a = proposal("draft-a");
  const b = proposal("draft-b");
  const ui = await page([a, b]);
  function card(planId) {
    const result = ui.cards().children.find(item => descendants(item).some(node =>
      node.tagName === "P" && node.textContent === "计划 ID：" + planId));
    assert.ok(result, `missing card for ${planId}`);
    return result;
  }
  function control(planId, label) {
    const result = descendants(card(planId)).find(node =>
      node.getAttribute("aria-label") === label);
    assert.ok(result, `missing ${label} in ${planId}`);
    return result;
  }
  async function uncheck(planId, label) {
    const checkbox = control(planId, label);
    assert.equal(checkbox.disabled, false);
    checkbox.checked = false;
    const handlers = checkbox.listeners.get("change") || [];
    assert.ok(handlers.length > 0);
    for (const handler of handlers) {
      await handler({ target: checkbox, currentTarget: checkbox });
    }
  }
  function approve(planId) {
    const button = buttons(card(planId)).find(item => item.textContent === "允许此计划");
    assert.ok(button);
    assert.equal(button.disabled, false);
    return Promise.all(button.click());
  }
  function assertDraft(planId, order, selected, preview) {
    const checkboxes = descendants(card(planId)).filter(node =>
      node.tagName === "INPUT" && node.type === "checkbox");
    assert.deepEqual(checkboxes.map(node => node.getAttribute("aria-label")), order);
    assert.deepEqual(checkboxes.filter(node => node.checked)
      .map(node => node.getAttribute("aria-label")), selected);
    assert.ok(card(planId).textContent.includes(preview));
  }
  const assertA = () => assertDraft(a.planId,
    ["选择Git 版本", "选择项目状态", "选择Node.js 版本"],
    ["选择项目状态", "选择Node.js 版本"],
    "已选 2 项 · 拟执行顺序（尚未批准）：项目状态 → Node.js 版本");
  const assertB = () => assertDraft(b.planId,
    ["选择项目状态", "选择Git 版本", "选择Node.js 版本"],
    ["选择项目状态", "选择Git 版本"],
    "已选 2 项 · 拟执行顺序（尚未批准）：项目状态 → Git 版本");

  await uncheck(a.planId, "选择Git 版本");
  await Promise.all(control(a.planId, "上移项目状态").click());
  await uncheck(b.planId, "选择Node.js 版本");
  await Promise.all(control(b.planId, "上移项目状态").click());
  await Promise.all(control(b.planId, "上移项目状态").click());
  assertA();
  assertB();

  let snapshots = [a, b];
  const saveB = deferred();
  let reads = 0;
  ui.route(async (url, options) => {
    if (options.method === "POST") return saveB.promise;
    assert.equal(url, "/api/codex/plans");
    reads++;
    return reply({ plans: JSON.parse(JSON.stringify(snapshots)) });
  });
  const savingB = approve(b.planId);
  assert.deepEqual(ui.posts()[0].body, {
    planId: b.planId, decision: "approve", steps: ["project_git_status", "git_version"]
  });
  assert.ok(descendants(card(b.planId)).filter(node =>
    node.tagName === "INPUT" || node.tagName === "BUTTON").every(node => node.disabled));
  assert.equal(control(a.planId, "选择Git 版本").disabled, false);

  for (let index = 0; index < 2; index++) {
    await ui.run("loadCodexPlans()");
    assertA();
    assertB();
  }
  snapshots = [a, {
    ...b,
    steps: b.steps.map(step => step.tool === "node_version"
      ? { ...step, grantEnabled: true } : step)
  }];
  const beforeSSE = reads;
  ui.streams[0].emit("tool", {
    source: "codex", id: 994, planId: b.planId,
    ...b.proposedSteps[1], phase: "proposal", status: "planned",
    at: new Date(now).toISOString()
  });
  await tick();
  await tick();
  assert.ok(reads > beforeSSE, "B's SSE must trigger an actual snapshot refresh");
  assert.doesNotMatch(card(b.planId).textContent, /已禁用 · 版本查询授权未允许/);
  assert.match(card(a.planId).textContent, /已禁用 · 版本查询授权未允许/);
  assertA();
  assertB();

  // An unchanged queued reconciliation leaves B's saved draft available for retry.
  saveB.resolve(reply({}));
  await savingB;
  assertA();
  assertB();
  const acceptedA = acceptedSelection(a);
  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedA, snapshots[1]] }));
  await approve(a.planId);
  assert.deepEqual(ui.posts()[1].body, {
    planId: a.planId, decision: "approve", steps: ["project_git_status", "node_version"]
  });
  assert.match(card(a.planId).textContent, /ACCEPTED-project_git_status/);
  assertB();
  for (let index = 0; index < 2; index++) {
    await ui.run("loadCodexPlans()");
    assertB();
  }

  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedA,
      acceptedSelection(b, ["project_git_status", "git_version"])] }));
  await approve(b.planId);
  assert.deepEqual(ui.posts().map(request => request.body), [
    { planId: b.planId, decision: "approve", steps: ["project_git_status", "git_version"] },
    { planId: a.planId, decision: "approve", steps: ["project_git_status", "node_version"] },
    { planId: b.planId, decision: "approve", steps: ["project_git_status", "git_version"] }
  ]);
  assert.match(card(b.planId).textContent, /ACCEPTED-git_version/);
  assert.doesNotMatch(card(b.planId).textContent, /ACCEPTED-node_version/);
});

test("single selection is approvable; empty selection blocks approve through polls but still permits deny", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  toggleSelection(ui, snapshot, "git_version", false);
  toggleSelection(ui, snapshot, "node_version", false);
  assert.equal(selectionAction(ui, "允许此计划").disabled, false);
  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedSelection(snapshot, ["project_git_status"])] }));
  await invoke(ui, snapshot, "approve");
  assert.deepEqual(ui.posts()[0].body, {
    planId: snapshot.planId, decision: "approve", steps: ["project_git_status"]
  });

  const empty = await page([snapshot]);
  for (const step of snapshot.steps) toggleSelection(empty, snapshot, step.tool, false);
  empty.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [JSON.parse(JSON.stringify(snapshot))] }));
  for (let index = 0; index < 2; index++) {
    empty.advanceTime(1000);
    await empty.run("loadCodexPlans()");
    assert.equal(selectionAction(empty, "允许此计划").disabled, true);
    assert.equal(selectionAction(empty, "拒绝").disabled, false);
  }
  await invoke(empty, snapshot, "approve");
  assert.equal(empty.posts().length, 0, "the public action must also reject an empty selection");
  await Promise.all(selectionAction(empty, "拒绝").click());
  await tick();
  assert.deepEqual(empty.posts().map(request => request.body),
    [{ planId: snapshot.planId, decision: "deny" }]);
});

test("unchanged polls, grant updates, SSE and a slow GET preserve the local selection and order", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  toggleSelection(ui, snapshot, "git_version", false);
  moveSelection(ui, snapshot, "project_git_status", -1);
  ui.route(async () => reply({ plans: [JSON.parse(JSON.stringify(snapshot))] }));
  const card = ui.cards().children[0];
  const checkbox = selectionControl(ui, "选择", snapshot.steps[2]);
  const approve = selectionAction(ui, "允许此计划");
  for (let index = 0; index < 2; index++) {
    ui.advanceTime(1000);
    await ui.run("loadCodexPlans()");
    assert.strictEqual(ui.cards().children[0], card);
    assert.strictEqual(selectionControl(ui, "选择", snapshot.steps[2]), checkbox);
    assert.strictEqual(selectionAction(ui, "允许此计划"), approve);
  }
  const changed = {
    ...snapshot,
    steps: snapshot.steps.map(step => ({ ...step, grantEnabled: step.tool === "project_git_status" ? null : true }))
  };
  const slow = deferred();
  let reads = 0;
  ui.route((url, options) => {
    if (options.method === "POST") return reply({});
    assert.equal(url, "/api/codex/plans");
    reads++;
    return slow.promise;
  });
  const loading = ui.run("loadCodexPlans()");
  const overlap = ui.run("loadCodexPlans()");
  ui.streams[0].emit("tool", {
    id: 990, source: "codex", planId: snapshot.planId,
    callId: snapshot.callId, toolId: "execute_tool_plan",
    phase: "proposal", status: "planned", at: new Date(now).toISOString()
  });
  assert.equal(reads, 1);
  slow.resolve(reply({ plans: [changed] }));
  await Promise.all([loading, overlap]);
  await tick();
  assert.equal(selectionControl(ui, "选择", snapshot.steps[0]).checked, false);
  assert.deepEqual(descendants(ui.cards()).filter(node =>
    node.tagName === "INPUT" && node.type === "checkbox" && node.checked)
    .map(node => node.getAttribute("aria-label")), ["选择项目状态", "选择Node.js 版本"]);
  ui.route(async (_url, options) => options.method === "POST"
    ? reply({}) : reply({ plans: [acceptedSelection(snapshot)] }));
  await invoke(ui, snapshot, "approve");
  assert.deepEqual(ui.posts()[0].body.steps, ["project_git_status", "node_version"]);
});

test("in-flight approval locks editing and decisions until reconciliation and sends an independent minimal selection", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  toggleSelection(ui, snapshot, "git_version", false);
  moveSelection(ui, snapshot, "project_git_status", -1);
  const save = deferred();
  const refresh = deferred();
  ui.route((_url, options) => options.method === "POST" ? save.promise : refresh.promise);
  const saving = invoke(ui, snapshot, "approve");
  const assertLocked = () => {
    assert.ok(descendants(ui.cards()).filter(node =>
      node.tagName === "BUTTON" || (node.tagName === "INPUT" && node.type === "checkbox"))
      .every(node => node.disabled));
  };
  assertLocked();
  toggleSelection(ui, snapshot, "git_version", true);
  moveSelection(ui, snapshot, "node_version", -1);
  await invoke(ui, snapshot, "deny");
  assert.equal(ui.posts().length, 1);
  assert.deepEqual(ui.posts()[0].body, {
    planId: snapshot.planId, decision: "approve",
    steps: ["project_git_status", "node_version"]
  });
  save.resolve(reply({}));
  await tick();
  assertLocked();
  toggleSelection(ui, snapshot, "project_git_status", false);
  refresh.resolve(reply({ plans: [acceptedSelection(snapshot)] }));
  await saving;
  assert.match(ui.cards().textContent, /已成功\s*2\s*\/\s*2/);
  assert.deepEqual(ui.posts()[0].body.steps, ["project_git_status", "node_version"]);
  assert.equal(ui.posts().length, 1);
});

test("network failure and conflict requery accepted selection; unreadable reconciliation locks edits until recovery", async () => {
  for (const failure of ["network", "conflict"]) {
    const snapshot = selectablePlan();
    const ui = await page([snapshot]);
    toggleSelection(ui, snapshot, "git_version", false);
    const actual = acceptedSelection(snapshot, ["project_git_status"]);
    let reads = 0;
    ui.route(async (_url, options) => {
      if (options.method === "POST") {
        if (failure === "network") throw Error("PRIVATE-network");
        return { ok: false, status: 409, json: async () => ({ error: "首决定已接受" }) };
      }
      reads++;
      if (failure === "network") throw Error("PRIVATE-read");
      return reply({ plans: [actual] });
    });
    await invoke(ui, snapshot, "approve");
    assert.ok(reads > 0, "failed POST must trigger a fresh backend read");
    if (failure === "network") {
      assert.match(ui.text(), /未确认|不可用|无法读取/);
      assert.ok(descendants(ui.cards()).filter(node =>
        node.tagName === "BUTTON" || (node.tagName === "INPUT" && node.type === "checkbox"))
        .every(node => node.disabled));
      toggleSelection(ui, snapshot, "git_version", true);
      moveSelection(ui, snapshot, "project_git_status", -1);
      await invoke(ui, snapshot, "approve");
      assert.equal(ui.posts().length, 1);
      ui.route(async () => reply({ plans: [actual] }));
      await ui.run("loadCodexPlans()");
    }
    assert.match(ui.cards().textContent, /已成功\s*1\s*\/\s*1/);
    assert.match(ui.cards().textContent, /ACCEPTED-project_git_status/);
    assert.match(ui.cards().textContent, /用户未选择|未选用/);
    assert.doesNotMatch(ui.text(), /PRIVATE-/);
    assert.equal(descendants(ui.cards()).filter(node =>
      node.tagName === "INPUT" && node.type === "checkbox" && !node.disabled).length, 0);
    assert.equal(ui.posts().length, 1);
  }
});

test("deadline is not extended by editing or polling and terminal polls cannot resurrect the draft", async () => {
  const snapshot = selectablePlan();
  const ui = await page([snapshot]);
  ui.advanceTime(29000);
  toggleSelection(ui, snapshot, "git_version", false);
  moveSelection(ui, snapshot, "project_git_status", -1);
  ui.route(async () => reply({ plans: [JSON.parse(JSON.stringify(snapshot))] }));
  await ui.run("loadCodexPlans()");
  assert.match(ui.cards().textContent, /剩余\s*1\s*秒/);
  ui.advanceTime(1000);
  await ui.run("loadCodexPlans()");
  assert.equal(selectionAction(ui, "允许此计划").disabled, true);
  assert.ok(descendants(ui.cards()).filter(node =>
    node.tagName === "BUTTON" || (node.tagName === "INPUT" && node.type === "checkbox"))
    .every(node => node.disabled));
  toggleSelection(ui, snapshot, "git_version", true);
  await invoke(ui, snapshot, "approve");
  assert.equal(ui.posts().length, 0);
  const terminal = acceptedSelection(snapshot);
  ui.route(async () => reply({ plans: [JSON.parse(JSON.stringify(terminal))] }));
  for (let index = 0; index < 2; index++) {
    ui.advanceTime(1000);
    await ui.run("loadCodexPlans()");
    toggleSelection(ui, snapshot, "git_version", true);
    moveSelection(ui, snapshot, "node_version", -1);
    assert.match(ui.cards().textContent, /已成功\s*2\s*\/\s*2/);
    assert.equal(buttons(ui.cards()).filter(button => !button.disabled).length, 0);
    assert.equal(descendants(ui.cards()).filter(node =>
      node.tagName === "INPUT" && node.type === "checkbox" && !node.disabled).length, 0);
  }
  await invoke(ui, snapshot, "approve");
  assert.equal(ui.posts().length, 0);
});

test("actual results and timeline distinguish proposal positions, execution order and exclusions", async () => {
  const snapshot = selectablePlan();
  const actual = acceptedSelection(snapshot);
  const ui = await page([actual]);
  assert.match(ui.cards().textContent, /已成功\s*2\s*\/\s*2/);
  assert.doesNotMatch(ui.cards().textContent, /已成功\s*2\s*\/\s*3/);
  assert.match(ui.cards().textContent, /用户未选择|未选用/);
  assert.doesNotMatch(ui.cards().textContent, /PLAN_NOT_RUN|失败|执行中/);
  for (const step of snapshot.proposedSteps) {
    assert.ok(ui.cards().textContent.includes(step.stepId));
    assert.ok(ui.cards().textContent.includes(step.callId));
  }
  const projectRows = descendants(ui.cards()).filter(node =>
    node.tagName === "LI" && node.textContent.includes("ACCEPTED-project_git_status"));
  assert.ok(projectRows.length);
  assert.ok(projectRows.some(row =>
    /(?:原始|原提案|提案|步骤)\s*(?:位置|顺序)?\s*[:：#]?\s*3/.test(row.textContent) &&
    /(?:执行|实际)\s*(?:步骤|顺序|位置)?\s*[:：#]?\s*1/.test(row.textContent)));
  const base = {
    source: "codex", at: new Date(now).toISOString(),
    planId: snapshot.planId, toolId: "execute_tool_plan", callId: snapshot.callId
  };
  const events = [
    { ...base, ...snapshot.proposedSteps[0],
      id: 951, status: "planned", phase: "proposal" },
    { ...base, id: 952, status: "queued", phase: "approved-selection",
      approvedOrder: ["project_git_status", "node_version"],
      selectedStepIds: actual.steps.map(step => step.stepId),
      unselectedStepIds: actual.excludedSteps.map(step => step.stepId) },
    { ...base, ...actual.steps[0], id: 953, source: "codex",
      at: base.at, planId: snapshot.planId }
  ];
  for (const event of events) ui.run(`addEvent(${JSON.stringify(event)})`);
  const rows = ui.node("events").children;
  assert.ok(rows.some(row => /提案步骤/.test(row.textContent)));
  assert.ok(rows.some(row => /已确认计划/.test(row.textContent)));
  const executed = rows.find(row => row.textContent.includes("ACCEPTED-project_git_status"));
  assert.ok(executed);
  assert.ok(executed.textContent.includes(actual.steps[0].stepId));
  assert.ok(executed.textContent.includes(actual.steps[0].callId));
  assert.match(executed.textContent, /(?:原始|原提案|提案|步骤)\s*(?:位置|顺序)?\s*[:：#]?\s*3/);
  assert.match(executed.textContent, /(?:执行|实际)\s*(?:步骤|顺序|位置)?\s*[:：#]?\s*1/);
});
