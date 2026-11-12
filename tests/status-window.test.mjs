import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCapabilityAdvisor } from "../src/capability-advisor.mjs";
import { createStatusProjection, createStatusWindow } from "../src/status-window.mjs";

const THREAD = "18610d20-1848-4d5c-9a60-a479b8e7ebcc";
const MARKER = "PRIVATE_OUTPUT_MARKER";
const START = "2026-11-11T12:00:00.000Z";
const END = "2026-11-11T12:00:12.000Z";

function result(data) {
  const structuredContent = { controlLevel: "advice_only", ...data };
  return {
    isError: false,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

function setup(t, options = {}) {
  const advisor = createCapabilityAdvisor();
  t.after(() => advisor.close());
  const projection = createStatusProjection(options);
  function call(name, args) {
    const response = advisor.dispatch({ name, arguments: args });
    assert.notEqual(response.isError, true);
    projection.accept(name, response);
    return response.structuredContent;
  }
  function compare(availability = "ready") {
    return call("compare_capabilities", {
      taskType: "file_read",
      candidates: [
        { capabilityId: "local_cli", availability },
        { capabilityId: "remote_desktop_commander", availability },
      ],
    });
  }
  return { advisor, projection, call, compare };
}

function status(comparison, state = "running", reason = "none", extra = {}) {
  return result({ taskStatus: {
    statusId: randomUUID(),
    selectionId: comparison.selection.selectionId,
    comparisonId: comparison.comparisonId,
    catalogRevision: comparison.catalogRevision,
    capabilityId: comparison.selection.capabilityId,
    state, reason, verification: "agent_reported", recordedAt: START, ...extra,
  } });
}

function hostEvent(kind, extra = {}) {
  const terminal = kind === "terminal";
  return {
    source: "codex-observer", controllability: "observable",
    threadId: THREAD, turnId: "turn_fixture", callId: "call_abcdef",
    toolId: terminal ? "codex.native.terminal" : `codex.recorded.${kind}`,
    ...(terminal ? { status: "succeeded", sourceStatus: "completed", exitCode: 0 } : {
      rawKind: kind === "custom" ? "custom_tool_call" : "function_call",
      toolName: "fixture.read", status: "completed", sourceStatus: "returned",
    }),
    ...extra,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("status window lifecycle timed out")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test("projection ignores errors, unknown tools and catalog operations as execution signals", t => {
  const { projection, compare, call } = setup(t);
  assert.equal(projection.snapshot().current, null);
  projection.accept("unknown_tool", result({ output: MARKER }));
  projection.accept("compare_capabilities", {
    isError: true, structuredContent: { error: MARKER },
  });
  assert.equal(projection.snapshot().current, null);
  const comparison = compare();
  const selected = projection.snapshot().current;
  assert.equal(selected.state, "selected");
  assert.equal(selected.taskLabel, "file_read");
  assert.equal(selected.selectedCapabilityId, comparison.selection.capabilityId);
  assert.equal(selected.actualCapabilityId, null);
  assert.equal(selected.verification, "agent_reported");
  assert.equal(selected.startedAt, null);
  assert.equal(selected.endedAt, null);
  call("list_capabilities", {});
  call("refresh_capabilities", { capabilities: [] });
  assert.deepEqual(projection.snapshot().current, selected);
  compare("not_checked");
  assert.equal(projection.snapshot().current.state, "needs_check");
  assert.equal(projection.snapshot().current.selectionId, null);
  assert.equal(projection.snapshot().current.startedAt, null);
  assert.equal(projection.snapshot().current.selectedCapabilityName, null);
  assert.equal(projection.snapshot().current.actualCapabilityName, null);
  assert.equal(projection.snapshot().current.switchFromName, null);
});

test("display names use frozen matching candidates without exposing bindings or paths", () => {
  const projection = createStatusProjection();
  const comparisonId = randomUUID();
  const candidates = [
    {
      candidateId: randomUUID(), capabilityId: "local_cli", name: "本地工具",
      execution: { type: "local_cli", id: MARKER }, path: MARKER,
    },
    {
      candidateId: randomUUID(), capabilityId: "remote_desktop_commander", name: "远程桌面",
      execution: { type: "local_cli", id: MARKER }, path: MARKER,
    },
  ];
  const selection = {
    selectionId: randomUUID(), comparisonId, catalogRevision: 1,
    candidateId: candidates[1].candidateId, capabilityId: candidates[1].capabilityId,
    name: MARKER, path: MARKER,
  };
  projection.accept("compare_capabilities", result({
    comparisonId, catalogRevision: 1, taskType: "file_read",
    status: "ready", candidates, selection,
  }));
  assert.equal(projection.snapshot().current.selectedCapabilityName, "远程桌面");
  assert.equal(projection.snapshot().current.actualCapabilityName, null);
  assert.equal(projection.snapshot().current.switchFromName, null);

  candidates[0].name = "已修改本地";
  candidates[1].name = "已修改远程";
  const switched = {
    ...selection, selectionId: randomUUID(),
    candidateId: candidates[0].candidateId, capabilityId: candidates[0].capabilityId,
  };
  projection.accept("select_capability", result({ selection: switched }));
  const current = projection.snapshot().current;
  assert.equal(current.selectedCapabilityId, "local_cli");
  assert.equal(current.selectedCapabilityName, "本地工具");
  assert.equal(current.switchFrom, "remote_desktop_commander");
  assert.equal(current.switchFromName, "远程桌面");

  function report(actualCapabilityId, outcome = "succeeded") {
    projection.accept("report_capability_use", result({ report: {
      reportId: randomUUID(), selectionId: switched.selectionId, catalogRevision: 1,
      selectedCapabilityId: "local_cli", actualCapabilityId, outcome,
      matchesSelection: outcome === "not_run" ? null : actualCapabilityId === "local_cli",
      quality: "not_assessed", verification: "agent_reported",
      actualCapabilityName: MARKER, execution: { id: MARKER }, path: MARKER,
    } }));
  }
  report("remote_desktop_commander");
  assert.equal(projection.snapshot().current.actualCapabilityId, "remote_desktop_commander");
  assert.equal(projection.snapshot().current.actualCapabilityName, "远程桌面");
  report("other_tool");
  assert.equal(projection.snapshot().current.actualCapabilityName, "other_tool");
  report(null, "not_run");
  assert.equal(projection.snapshot().current.actualCapabilityName, null);
  assert.equal(JSON.stringify(projection.snapshot()).includes(MARKER), false);

  const before = projection.snapshot();
  const invalidComparisonId = randomUUID();
  projection.accept("compare_capabilities", result({
    comparisonId: invalidComparisonId, catalogRevision: 1, taskType: "file_read",
    status: "ready",
    candidates: [{ ...candidates[0], name: `C:\\${MARKER}` }],
    selection: {
      ...switched, selectionId: randomUUID(), comparisonId: invalidComparisonId,
    },
  }));
  assert.deepEqual(projection.snapshot(), before);
});

test("projection ignores array states from associated task statuses and scoped terminal events", t => {
  const { projection, compare } = setup(t, {
    threadId: THREAD, now: () => new Date(END),
  });
  const comparison = compare();
  const before = projection.snapshot();

  projection.accept("report_task_status", status(comparison, ["running"], "none"));
  assert.deepEqual(projection.snapshot(), before);

  projection.observe(hostEvent("terminal", {
    status: ["succeeded"], sourceStatus: "completed", exitCode: 0,
  }));
  assert.deepEqual(projection.snapshot(), before);
});

test("explicit running starts once, waiting retains that start, and terminal receipt ends elapsed time", t => {
  let clock = new Date(START);
  const { projection, compare, call } = setup(t, { now: () => clock });
  const comparison = compare();
  const running = status(comparison, "running", "none", { taskLabel: "读取项目文件" });
  projection.accept("report_task_status", running);
  assert.equal(projection.snapshot().current.startedAt, START);
  assert.equal(projection.snapshot().current.taskLabel, "读取项目文件");
  projection.accept("report_task_status", status(comparison, "waiting", "awaiting_tool", {
    recordedAt: "2026-11-11T12:00:03.000Z",
  }));
  assert.equal(projection.snapshot().current.state, "waiting");
  assert.equal(projection.snapshot().current.reason, "awaiting_tool");
  assert.equal(projection.snapshot().current.startedAt, START);
  projection.accept("report_task_status", status(comparison, "running", "none", {
    recordedAt: "2026-11-11T12:00:08.000Z",
  }));
  assert.equal(projection.snapshot().current.startedAt, START);
  clock = new Date(END);
  call("report_capability_use", {
    selectionId: comparison.selection.selectionId,
    actualCapabilityId: "local_cli",
    outcome: "succeeded",
    quality: "does_not_meet",
    evidenceCallId: "call_abcdef",
  });
  const current = projection.snapshot().current;
  assert.equal(current.state, "succeeded");
  assert.equal(current.startedAt, START);
  assert.equal(current.endedAt, END);
  assert.equal(Date.parse(current.endedAt) - Date.parse(current.startedAt), 12000);
  assert.equal(current.quality, "does_not_meet");
  assert.equal(current.matchesSelection, true);
  assert.equal(current.verification, "agent_reported");
});

test("reports without running keep elapsed unknown for success, failure and not_run", t => {
  const { projection, compare, call } = setup(t, { now: () => new Date(END) });
  for (const outcome of ["succeeded", "failed", "not_run"]) {
    const comparison = compare();
    call("report_capability_use", {
      selectionId: comparison.selection.selectionId,
      actualCapabilityId: outcome === "not_run" ? null : "local_cli",
      outcome,
    });
    const current = projection.snapshot().current;
    assert.equal(current.state, outcome);
    assert.equal(current.startedAt, null);
    assert.equal(current.endedAt, null);
  }
});

test("switching records A to B and late old selection events cannot replace the current card", t => {
  const { projection, compare, call } = setup(t);
  const first = compare();
  const remote = first.candidates.find(item => item.capabilityId === "remote_desktop_commander");
  const switched = call("select_capability", {
    comparisonId: first.comparisonId, candidateId: remote.candidateId,
    reason: "user_requested",
  }).selection;
  assert.equal(projection.snapshot().current.switchFrom, "local_cli");
  assert.equal(projection.snapshot().current.selectedCapabilityId, "remote_desktop_commander");
  projection.accept("report_task_status", status(first));
  assert.equal(projection.snapshot().current.selectionId, switched.selectionId);
  assert.equal(projection.snapshot().current.state, "selected");
  call("report_capability_use", {
    selectionId: switched.selectionId, actualCapabilityId: "local_cli", outcome: "succeeded",
  });
  assert.equal(projection.snapshot().current.matchesSelection, false);
  assert.equal(projection.snapshot().current.actualCapabilityId, "local_cli");

  const latest = compare();
  const expected = structuredClone(projection.snapshot().current);
  call("report_capability_use", {
    selectionId: first.selection.selectionId,
    actualCapabilityId: "local_cli", outcome: "failed",
  });
  assert.deepEqual(projection.snapshot().current, expected);
  assert.equal(expected.selectionId, latest.selection.selectionId);
  assert.ok(projection.snapshot().history.some(item =>
    item.selectionId === first.selection.selectionId && item.state === "failed"));
});

test("status and report IDs deduplicate and snapshots isolate all nested state", t => {
  const { projection, compare, advisor } = setup(t, { now: () => new Date(END) });
  const comparison = compare();
  const running = status(comparison);
  projection.accept("report_task_status", running);
  const afterRunning = projection.snapshot();
  projection.accept("report_task_status", structuredClone(running));
  assert.deepEqual(projection.snapshot(), afterRunning);
  running.structuredContent.taskStatus.taskLabel = MARKER;
  assert.equal(JSON.stringify(projection.snapshot()).includes(MARKER), false);

  const reported = advisor.dispatch({
    name: "report_capability_use",
    arguments: {
      selectionId: comparison.selection.selectionId,
      actualCapabilityId: "local_cli", outcome: "succeeded",
    },
  });
  projection.accept("report_capability_use", reported);
  const expected = projection.snapshot();
  projection.accept("report_capability_use", structuredClone(reported));
  assert.deepEqual(projection.snapshot(), expected);
  const mutated = projection.snapshot();
  mutated.current.state = MARKER;
  mutated.history[0].state = MARKER;
  mutated.observer.state = MARKER;
  assert.deepEqual(projection.snapshot(), expected);
});

test("cancelled stops a started task at receipt and a later final report remains agent reported", t => {
  const { projection, compare, call } = setup(t, { now: () => new Date(END) });
  const comparison = compare();
  projection.accept("report_task_status", status(comparison));
  projection.accept("report_task_status", status(comparison, "cancelled", "user_cancelled"));
  assert.equal(projection.snapshot().current.state, "cancelled");
  assert.equal(projection.snapshot().current.endedAt, END);
  assert.equal(projection.snapshot().current.cancelledAt, END);
  call("report_capability_use", {
    selectionId: comparison.selection.selectionId,
    actualCapabilityId: "local_cli", outcome: "failed",
  });
  assert.equal(projection.snapshot().current.state, "failed");
  assert.equal(projection.snapshot().current.verification, "agent_reported");
  assert.equal(projection.snapshot().current.cancelledAt, END);
});

test("projection exposes bounded safe history without bindings, prose, output or unknown fields", t => {
  const { projection, compare } = setup(t);
  const first = compare();
  const decorated = status(first);
  Object.assign(decorated.structuredContent.taskStatus, {
    execution: { type: "local_cli", id: MARKER },
    explanation: MARKER, path: MARKER, output: MARKER, unknown: MARKER,
  });
  projection.accept("report_task_status", decorated);
  assert.equal(JSON.stringify(projection.snapshot()).includes(MARKER), false);
  for (let index = 0; index < 130; index += 1) {
    const comparison = compare();
    projection.accept("report_task_status", status(comparison));
  }
  const snapshot = projection.snapshot();
  assert.equal(snapshot.history.length, 100);
  assert.ok(snapshot.history.every(item =>
    item.source === "agent_reported" && typeof item.state === "string" &&
    Object.hasOwn(item, "capabilityId")));
  assert.equal(snapshot.history.some(item => item.selectionId === first.selection.selectionId), false);
  assert.equal(JSON.stringify(snapshot).includes("execution"), false);
  assert.equal(JSON.stringify(snapshot).includes("limitations"), false);
});

test("observer ignores absent or mismatched explicit scope and filters unsafe status metadata", () => {
  const event = hostEvent("function", { output: MARKER, error: MARKER, path: MARKER });
  const unscoped = createStatusProjection();
  const initial = unscoped.snapshot();
  unscoped.observe(event);
  assert.deepEqual(unscoped.snapshot(), initial);

  const scoped = createStatusProjection({ threadId: THREAD });
  const before = scoped.snapshot();
  for (const invalid of [
    null, [], {}, { ...event, threadId: randomUUID() },
    { ...event, threadId: undefined },
    { ...event, source: undefined },
    { ...event, callId: `C:\\${MARKER}` },
  ]) scoped.observe(invalid);
  assert.deepEqual(scoped.snapshot(), before);
  scoped.setObserverStatus({
    state: "error", threadId: THREAD,
    notice: MARKER, error: MARKER, output: MARKER, path: MARKER,
  });
  assert.equal(scoped.snapshot().observer.threadId, THREAD);
  assert.equal(JSON.stringify(scoped.snapshot()).includes(MARKER), false);
});

test("observer returned events and evidence IDs never promote agent results to verified success", t => {
  const { projection, compare, call } = setup(t, {
    threadId: THREAD, now: () => new Date(END),
  });
  const comparison = compare();
  call("report_capability_use", {
    selectionId: comparison.selection.selectionId,
    actualCapabilityId: "local_cli", outcome: "failed", evidenceCallId: "call_abcdef",
  });
  for (const kind of ["function", "custom"]) {
    projection.observe(hostEvent(kind, {
      callId: kind === "function" ? "call_abcdef" : "call_ghijkl", output: MARKER,
    }));
  }
  const snapshot = projection.snapshot();
  const observed = snapshot.history.filter(item => item.source === "codex-observer");
  assert.equal(observed.length, 2);
  assert.ok(observed.every(item => item.state === "returned"));
  assert.ok(observed.every(item => !item.startedAt && !item.durationMs));
  assert.equal(snapshot.current.state, "failed");
  assert.equal(snapshot.current.verification, "agent_reported");
  assert.equal(JSON.stringify(snapshot).includes(MARKER), false);
});

test("observer requires exit code zero before displaying terminal success", () => {
  const projection = createStatusProjection({ threadId: THREAD });
  for (const [index, exitCode] of [undefined, 1, 0].entries()) {
    projection.observe(hostEvent("terminal", {
      callId: `call_terminal${index}`,
      exitCode,
    }));
  }
  const observed = projection.snapshot().history.filter(item => item.source === "codex-observer");
  assert.equal(observed.length, 3);
  assert.notEqual(observed[0].state, "succeeded");
  assert.notEqual(observed[1].state, "succeeded");
  assert.equal(observed[2].state, "succeeded");
});

function windowFakes(extra = {}) {
  const writes = [];
  const calls = [];
  let userClose;
  let publish;
  const observer = {
    async start(options) { calls.push(["observer.start", options]); },
    async stop() { calls.push(["observer.stop"]); },
    getStatus() { return { state: "observing", threadId: THREAD }; },
  };
  const renderer = {
    write(snapshot) { writes.push(structuredClone(snapshot)); },
    async close() { calls.push(["renderer.close"]); },
  };
  const controller = createStatusWindow({
    threadId: THREAD,
    rendererFactory: async ({ onClose }) => {
      calls.push(["renderer.ready"]);
      userClose = onClose;
      return renderer;
    },
    createObserver: ({ publish: callback }) => {
      calls.push(["observer.create"]);
      publish = callback;
      return observer;
    },
    ...extra,
  });
  return {
    controller, renderer, observer, writes, calls,
    userClose: () => userClose(),
    publish: event => publish(event),
  };
}

test("controller starts scoped observer only after renderer readiness and closes resources once", async () => {
  const fake = windowFakes();
  try {
    await bounded(fake.controller.start());
    assert.deepEqual(fake.calls.slice(0, 3), [
      ["renderer.ready"], ["observer.create"], ["observer.start", { threadId: THREAD }],
    ]);
    assert.ok(fake.writes.length > 0);
    const snapshot = fake.controller.getSnapshot();
    assert.equal(snapshot.observer.state, "observing");
    snapshot.observer.state = MARKER;
    assert.equal(JSON.stringify(fake.controller.getSnapshot()).includes(MARKER), false);
  } finally {
    await bounded(fake.controller.close());
    await bounded(fake.controller.close());
  }
  assert.equal(fake.calls.filter(([name]) => name === "observer.stop").length, 1);
  assert.equal(fake.calls.filter(([name]) => name === "renderer.close").length, 1);
});

test("controller without an explicit thread never creates an observer", async () => {
  const fake = windowFakes({
    threadId: null,
    createObserver() { assert.fail("unscoped controller must not create an observer"); },
  });
  try {
    await bounded(fake.controller.start());
    assert.equal(fake.controller.getSnapshot().observer.threadId, null);
  } finally {
    await bounded(fake.controller.close());
  }
});

test("user closing the display stops observation while advisor dispatch remains usable", async t => {
  const advisor = createCapabilityAdvisor();
  t.after(() => advisor.close());
  const fake = windowFakes();
  try {
    await bounded(fake.controller.start());
    fake.userClose();
    const writeCount = fake.writes.length;
    await settle();
    assert.equal(fake.calls.filter(([name]) => name === "observer.stop").length, 1);
    assert.equal(fake.writes.length, writeCount);
    const response = advisor.dispatch({
      name: "compare_capabilities",
      arguments: {
        taskType: "file_read",
        candidates: [{ capabilityId: "local_cli", availability: "ready" }],
      },
    });
    assert.notEqual(response.isError, true);
    fake.controller.accept("compare_capabilities", response);
    fake.publish(hostEvent("function"));
    await settle();
    assert.equal(fake.writes.length, writeCount);
  } finally {
    await bounded(fake.controller.close());
  }
  assert.equal(fake.calls.filter(([name]) => name === "observer.stop").length, 1);
});

test("renderer failure and write failure produce fixed diagnostics without disabling advisor", async t => {
  const advisor = createCapabilityAdvisor();
  t.after(() => advisor.close());
  for (const failure of ["start", "write"]) {
    const diagnostics = [];
    let observerCreated = false;
    let rendererClosed = 0;
    const controller = createStatusWindow({
      threadId: THREAD,
      rendererFactory: async () => {
        if (failure === "start") throw new Error(MARKER);
        return {
          write() { throw new Error(MARKER); },
          async close() { rendererClosed += 1; },
        };
      },
      createObserver() {
        observerCreated = true;
        return {
          async start() {}, async stop() {},
          getStatus: () => ({ state: "observing", threadId: THREAD }),
        };
      },
      onDiagnostic: message => diagnostics.push(message),
    });
    try {
      await bounded(controller.start());
      const response = advisor.dispatch({ name: "list_capabilities", arguments: {} });
      assert.notEqual(response.isError, true);
      controller.accept("list_capabilities", response);
      await settle();
      if (failure === "start") assert.equal(observerCreated, false);
      if (failure === "write") assert.equal(rendererClosed, 1);
      assert.ok(diagnostics.length > 0);
      assert.ok(diagnostics.every(message => typeof message === "string" && message.length > 0));
      assert.equal(JSON.stringify(diagnostics).includes(MARKER), false);
    } finally {
      await bounded(controller.close());
    }
  }
});

test("closing during pending renderer creation disposes the late renderer without starting observer", async () => {
  const ready = deferred();
  let closed = 0;
  let writes = 0;
  const controller = createStatusWindow({
    threadId: THREAD,
    rendererFactory: () => ready.promise,
    createObserver() { assert.fail("closed display must not create an observer"); },
  });
  const starting = controller.start();
  const closing = controller.close();
  ready.resolve({
    write() { writes += 1; },
    async close() { closed += 1; },
  });
  await bounded(Promise.all([starting, closing]));
  await bounded(controller.close());
  assert.equal(closed, 1);
  assert.equal(writes, 0);
});

test("closing during observer start waits for bounded cleanup and prevents later display writes", async () => {
  const started = deferred();
  const release = deferred();
  let stops = 0;
  let closes = 0;
  let writes = 0;
  const controller = createStatusWindow({
    threadId: THREAD,
    rendererFactory: async () => ({
      write() { writes += 1; },
      async close() { closes += 1; },
    }),
    createObserver: () => ({
      async start() { started.resolve(); await release.promise; },
      async stop() { stops += 1; },
      getStatus: () => ({ state: "observing", threadId: THREAD }),
    }),
  });
  const starting = controller.start();
  await bounded(started.promise);
  const closing = controller.close();
  release.resolve();
  await bounded(Promise.all([starting, closing]));
  const count = writes;
  controller.accept("list_capabilities", result({ capabilities: [] }));
  await bounded(controller.close());
  assert.equal(writes, count);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
});

function desktopMcp(extra = {}) {
  return {
    source: "codex-observer", controllability: "observable",
    threadId: THREAD, turnId: "turn_fixture", callId: "call_mcp_fixture",
    toolId: "codex.native.mcp", serverName: "fixture.server", toolName: "tools.lookup",
    status: "completed", sourceStatus: "completed",
    at: END, startedAt: START, completedAt: END, durationMs: 12000,
    ...extra
  };
}

test("desktop host summary is separate from the self-reported card and contains safe source metadata", t => {
  const { projection, compare } = setup(t, {
    threadId: THREAD, desktopMode: true, now: () => new Date(END)
  });
  assert.equal(projection.snapshot().displayMode, "desktop");
  assert.equal(projection.snapshot().hostCurrent, null);
  compare();
  const self = projection.snapshot().current;
  projection.observe(desktopMcp({
    arguments: MARKER, result: MARKER, error: MARKER, path: MARKER
  }));
  const snapshot = projection.snapshot();
  assert.deepEqual(snapshot.current, self);
  assert.equal(snapshot.hostCurrent.source, "codex-observer");
  assert.equal(snapshot.hostCurrent.capabilityId, "codex.native.mcp");
  assert.equal(snapshot.hostCurrent.serverName, "fixture.server");
  assert.equal(snapshot.hostCurrent.toolName, "tools.lookup");
  assert.equal(snapshot.hostCurrent.threadId, THREAD);
  assert.equal(snapshot.hostCurrent.turnId, "turn_fixture");
  assert.equal(snapshot.hostCurrent.callId, "call_mcp_fixture");
  assert.equal(snapshot.hostCurrent.state, "returned");
  assert.equal(snapshot.hostCurrent.at, END);
  assert.equal(snapshot.hostCurrent.durationMs, 12000);
  assert.equal(snapshot.hostCurrent.scope, "recent_turns");
  assert.equal(snapshot.hostCurrent.ordering, "source_time");
  assert.equal(snapshot.hostCurrent.receivedAt, END);
  assert.equal(JSON.stringify(snapshot).includes(MARKER), false);
  snapshot.hostCurrent.toolName = MARKER;
  snapshot.history[0].state = MARKER;
  assert.equal(JSON.stringify(projection.snapshot()).includes(MARKER), false);
});

test("desktop projection rejects unsafe MCP metadata and default projection ignores desktop-only events", () => {
  const projection = createStatusProjection({ threadId: THREAD, desktopMode: true });
  const before = projection.snapshot();
  for (const extra of [
    { serverName: ["fixture.server"] }, { toolName: ["tools.lookup"] },
    { serverName: "../" + MARKER }, { toolName: "x".repeat(129) },
    { status: ["completed"] }, { sourceStatus: ["completed"] },
    { status: "succeeded" }, { status: "completed", sourceStatus: "inProgress" },
    { source: "agent_reported" }, { controllability: "controllable" },
    { threadId: randomUUID() }, { turnId: null },
    { scope: "thread_tail" }, { callId: "../" + MARKER }
  ]) projection.observe(desktopMcp(extra));
  assert.deepEqual(projection.snapshot(), before);
  const advisor = createStatusProjection({ threadId: THREAD });
  const initial = advisor.snapshot();
  advisor.observe(desktopMcp());
  advisor.observe(hostEvent("function", { turnId: null, scope: "thread_tail" }));
  assert.deepEqual(advisor.snapshot(), initial);
  advisor.observe(hostEvent("function"));
  assert.equal(advisor.snapshot().history.at(-1).state, "returned");
  assert.equal(advisor.snapshot().current, null);
});

test("desktop summary uses source-time maximum and prevents same-call terminal regression", () => {
  const projection = createStatusProjection({
    threadId: THREAD, desktopMode: true, now: () => new Date(END)
  });
  projection.observe(desktopMcp());
  projection.observe(desktopMcp({
    callId: "older-history", at: START, completedAt: START, durationMs: 0
  }));
  assert.equal(projection.snapshot().hostCurrent.callId, "call_mcp_fixture");
  projection.observe(desktopMcp({
    status: "running", sourceStatus: "inProgress", at: START,
    completedAt: undefined, durationMs: undefined
  }));
  assert.equal(projection.snapshot().hostCurrent.state, "returned");
  assert.equal(projection.snapshot().hostCurrent.at, END);
  projection.observe(desktopMcp({
    callId: "latest-running", status: "running", sourceStatus: "inProgress",
    at: "2026-11-11T12:00:15.000Z", durationMs: undefined
  }));
  assert.equal(projection.snapshot().hostCurrent.callId, "latest-running");
  assert.equal(projection.snapshot().hostCurrent.state, "running");
  projection.observe(desktopMcp({
    callId: "latest-running", status: "failed", sourceStatus: "failed",
    at: "2026-11-11T12:00:16.000Z"
  }));
  assert.equal(projection.snapshot().hostCurrent.state, "failed");
});

test("desktop summary preserves unknown source ordering without inventing time or duration", () => {
  const projection = createStatusProjection({
    threadId: THREAD, desktopMode: true, now: () => new Date(END)
  });
  const untimed = {
    at: undefined, startedAt: undefined, completedAt: undefined, durationMs: undefined
  };
  projection.observe(desktopMcp({
    ...untimed, status: "running", sourceStatus: "inProgress"
  }));
  let current = projection.snapshot().hostCurrent;
  assert.equal(current.state, "running");
  assert.equal(current.at, null);
  assert.equal(current.durationMs, null);
  assert.equal(current.ordering, "unknown");
  assert.equal(current.receivedAt, END);
  projection.observe(desktopMcp(untimed));
  current = projection.snapshot().hostCurrent;
  assert.equal(current.state, "returned", "same-call state may advance without a new timestamp");
  assert.equal(current.at, null);
  assert.equal(current.ordering, "unknown");
  projection.observe(desktopMcp({ callId: "timed-call" }));
  assert.equal(projection.snapshot().hostCurrent.ordering, "source_time");
  projection.observe(desktopMcp({ ...untimed, callId: "different-untimed-call" }));
  current = projection.snapshot().hostCurrent;
  assert.equal(current.ordering, "unknown", "a different untimed call makes latest ordering uncertain");
  assert.ok(["timed-call", "different-untimed-call"].includes(current.callId));
  if (current.callId === "different-untimed-call") {
    assert.equal(current.at, null);
    assert.equal(current.durationMs, null);
  } else {
    assert.equal(current.at, END);
  }
});

test("desktop terminal guards survive intervening calls and late running records", () => {
  const projection = createStatusProjection({ threadId: THREAD, desktopMode: true });
  projection.observe(desktopMcp());
  projection.observe(desktopMcp({
    callId: "intervening", at: "2026-11-11T12:00:15.000Z"
  }));
  const before = projection.snapshot();
  projection.observe(desktopMcp({
    status: "running", sourceStatus: "inProgress",
    at: "2026-11-11T12:00:20.000Z"
  }));
  assert.deepEqual(projection.snapshot(), before);
});

test("desktop unknown-turn projection accepts only raw function/custom tails and keeps bounded history", () => {
  const projection = createStatusProjection({
    threadId: THREAD, desktopMode: true, now: () => new Date(END)
  });
  const before = projection.snapshot();
  for (const event of [
    hostEvent("terminal", { turnId: null, scope: "thread_tail" }),
    desktopMcp({ turnId: null, scope: "thread_tail" }),
    hostEvent("function", { turnId: null }),
    hostEvent("function", { turnId: null, scope: "recent_turns" }),
    hostEvent("custom", { turnId: null, scope: "thread_tail", rawKind: "function_call" })
  ]) projection.observe(event);
  assert.deepEqual(projection.snapshot(), before);
  for (let index = 0; index < 105; index++) {
    projection.observe(hostEvent(index % 2 ? "function" : "custom", {
      callId: `tail-call-${index}`, turnId: null, scope: "thread_tail",
      at: new Date(Date.parse(START) + index).toISOString(), output: MARKER
    }));
  }
  const snapshot = projection.snapshot();
  assert.equal(snapshot.history.length, 100);
  assert.equal(snapshot.hostCurrent.callId, "tail-call-104");
  assert.equal(snapshot.hostCurrent.turnId, null);
  assert.equal(snapshot.hostCurrent.scope, "thread_tail");
  assert.equal(snapshot.hostCurrent.state, "returned");
  assert.ok(snapshot.history.every(entry => entry.turnId === null && entry.scope === "thread_tail"));
  assert.equal(JSON.stringify(snapshot).includes(MARKER), false);
  snapshot.hostCurrent.state = MARKER;
  snapshot.history[0].scope = MARKER;
  assert.equal(JSON.stringify(projection.snapshot()).includes(MARKER), false);
});

test("desktop controller opts observer into MCP and unknown-turn traces while normal controller stays default", async () => {
  for (const desktopMode of [false, true]) {
    let observerOptions;
    let publish;
    let stops = 0;
    let closes = 0;
    const writes = [];
    const controller = createStatusWindow({
      threadId: THREAD, desktopMode, statusRefreshIntervalMs: 0,
      rendererFactory: async () => ({
        write(snapshot) { writes.push(structuredClone(snapshot)); },
        async close() { closes++; }
      }),
      createObserver(options) {
        observerOptions = options;
        publish = options.publish;
        return {
          async start(input) { assert.deepEqual(input, { threadId: THREAD }); },
          async stop() { stops++; },
          getStatus: () => ({
            state: "observing", threadId: THREAD,
            coverage: {
              turnCount: 1,
              raw: { available: true, truncated: true, unscopedItems: 2 }
            }
          })
        };
      }
    });
    try {
      await bounded(controller.start());
      assert.equal(observerOptions.includeMcp === true, desktopMode);
      assert.equal(observerOptions.includeUnscopedTrace === true, desktopMode);
      publish(desktopMcp());
      const snapshot = controller.getSnapshot();
      if (desktopMode) {
        assert.equal(snapshot.displayMode, "desktop");
        assert.equal(snapshot.hostCurrent.callId, "call_mcp_fixture");
        assert.equal(snapshot.observer.coverage.raw.unscopedItems, 2);
        assert.equal(writes.at(-1).hostCurrent.state, "returned");
      } else {
        assert.equal(snapshot.history.length, 0);
        assert.equal(Object.hasOwn(snapshot.observer.coverage.raw, "unscopedItems"), false);
      }
    } finally {
      await bounded(controller.close());
      await bounded(controller.close());
    }
    assert.equal(stops, 1);
    assert.equal(closes, 1);
  }
});
