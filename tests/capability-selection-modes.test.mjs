import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createCapabilityAdvisor } from "../src/capability-advisor.mjs";
import { createStatusProjection } from "../src/status-window.mjs";

const require = createRequire(import.meta.url);
const MARKER = "REJECTED_SECRET_MARKER";
const TASK = "mode_test";
const START = "2026-11-13T12:00:00.000Z";
const END = "2026-11-13T12:00:12.000Z";

function records() {
  return [
    {
      capabilityId: "mode_alpha", name: "Alpha", kind: "cli",
      sourceId: "mode.alpha", taskTypes: [TASK], availability: "ready",
      execution: { type: "local_cli", id: "mode.alpha" }, priority: 20,
    },
    {
      capabilityId: "mode_beta", name: "Beta", kind: "plugin",
      sourceId: "mode.beta", taskTypes: [TASK], availability: "ready",
      execution: { type: "host_tool", id: "mode.beta" }, priority: 10,
    },
    {
      capabilityId: "mode_unrelated", name: "Unrelated", kind: "cli",
      sourceId: "mode.unrelated", taskTypes: ["other_task"], availability: "ready",
      execution: { type: "local_cli", id: "mode.unrelated" }, priority: 0,
    },
    {
      capabilityId: "mode_unchecked", name: "Unchecked", kind: "cli",
      sourceId: "mode.unchecked", taskTypes: [TASK], availability: "not_checked",
      execution: { type: "local_cli", id: "mode.unchecked" }, priority: 0,
    },
  ];
}

function candidates() {
  return [
    { capabilityId: "mode_alpha", availability: "ready" },
    { capabilityId: "mode_beta", availability: "ready" },
  ];
}

function success(response) {
  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.controlLevel, "advice_only");
  assert.deepEqual(
    JSON.parse(response.content[0].text), response.structuredContent,
  );
  return response.structuredContent;
}

function denied(response, status) {
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.controlLevel, "advice_only");
  assert.equal(response.structuredContent.status, status);
  assert.equal(JSON.stringify(response).includes(MARKER), false);
  assert.deepEqual(
    JSON.parse(response.content[0].text), response.structuredContent,
  );
}

function dispatch(instance, name, args) {
  return instance.dispatch({ name, arguments: args });
}

function setup(t) {
  const instance = createCapabilityAdvisor();
  t.after(() => instance.close());
  success(dispatch(instance, "refresh_capabilities", { capabilities: records() }));
  return instance;
}

function compare(instance, mode, choices = candidates()) {
  return success(dispatch(instance, "compare_capabilities", {
    taskType: TASK, candidates: choices,
    ...(mode === undefined ? {} : { mode }),
  }));
}

function choose(instance, comparison, capabilityId, reason) {
  const candidate = comparison.candidates.find(item => item.capabilityId === capabilityId);
  assert.ok(candidate);
  return dispatch(instance, "select_capability", {
    comparisonId: comparison.comparisonId,
    candidateId: candidate.candidateId,
    reason,
  });
}

test("invalid modes are rejected without reflecting input", t => {
  const instance = setup(t);
  for (const mode of [null, { private: MARKER }, MARKER]) {
    denied(dispatch(instance, "compare_capabilities", {
      taskType: TASK, candidates: candidates(), mode,
    }), 400);
  }
});

test("agent_auto cannot bypass a manual gate, including after user selection", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual");
  const rejected = choose(instance, comparison, "mode_beta", "agent_auto");
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.controlLevel, "advice_only");
  success(choose(instance, comparison, "mode_alpha", "user_requested"));
  assert.equal(
    choose(instance, comparison, "mode_beta", "agent_auto").isError, true,
  );
});

test("catalog changes invalidate a pending manual comparison", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual");
  const changed = records();
  changed[0].priority = 5;
  success(dispatch(instance, "refresh_capabilities", { capabilities: changed }));
  denied(choose(instance, comparison, "mode_beta", "user_requested"), 409);
});

test("irrelevant ready and direct unchecked candidates neither count nor become selectable", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual", [
    { capabilityId: "mode_alpha", availability: "ready" },
    { capabilityId: "mode_unrelated", availability: "ready" },
    { capabilityId: "mode_unchecked", availability: "not_checked" },
  ]);
  assert.equal(comparison.status, "ready");
  assert.equal(comparison.selection.capabilityId, "mode_alpha");
  denied(choose(instance, comparison, "mode_unrelated", "user_requested"), 422);
  denied(choose(instance, comparison, "mode_unchecked", "user_requested"), 422);
});

test("manual with two eligible entries returns a recommendation without a selection", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual");
  assert.equal(comparison.mode, "manual");
  assert.equal(comparison.status, "needs_selection");
  assert.equal(comparison.selection, null);
  assert.equal(comparison.candidates.length, 2);
  assert.equal(
    comparison.candidates.find(item =>
      item.candidateId === comparison.recommendedCandidateId).capabilityId,
    "mode_beta",
  );
});

test("manual with one eligible entry selects it immediately", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual", [candidates()[0]]);
  assert.equal(comparison.mode, "manual");
  assert.equal(comparison.status, "ready");
  assert.equal(comparison.selection.capabilityId, "mode_alpha");
  assert.equal(comparison.selection.reason, "agent_auto");
});

test("zero eligible entries need checking in every mode", t => {
  const instance = setup(t);
  for (const mode of ["manual", "recommend", "auto"]) {
    const comparison = compare(instance, mode, [
      { capabilityId: "mode_unrelated", availability: "ready" },
      { capabilityId: "mode_unchecked", availability: "not_checked" },
    ]);
    assert.equal(comparison.mode, mode);
    assert.equal(comparison.status, "needs_check");
    assert.equal(comparison.selection, null);
    assert.equal(comparison.recommendedCandidateId, null);
  }
});

test("recommend, auto and omitted mode select by priority and allow automatic switching", t => {
  const instance = setup(t);
  for (const mode of ["recommend", "auto", undefined]) {
    const comparison = compare(instance, mode);
    assert.equal(comparison.mode, mode ?? "auto");
    assert.equal(comparison.status, "ready");
    assert.equal(comparison.selection.capabilityId, "mode_beta");
    assert.equal(comparison.selection.reason, "agent_auto");
    const switched = success(choose(instance, comparison, "mode_alpha", "agent_auto"));
    assert.equal(switched.selection.capabilityId, "mode_alpha");
  }
});

test("a user can choose either manual candidate and then record running and actual use", t => {
  const instance = setup(t);
  const comparison = compare(instance, "manual");
  for (const capabilityId of ["mode_alpha", "mode_beta"]) {
    const { selection } = success(
      choose(instance, comparison, capabilityId, "user_requested"),
    );
    assert.equal(selection.capabilityId, capabilityId);
    assert.equal(selection.reason, "user_requested");
    assert.equal(selection.selectionSource, "agent_reported_user_request");
    const { taskStatus } = success(dispatch(instance, "report_task_status", {
      selectionId: selection.selectionId, state: "running", reason: "none",
    }));
    assert.equal(taskStatus.capabilityId, capabilityId);
    const { report } = success(dispatch(instance, "report_capability_use", {
      selectionId: selection.selectionId, actualCapabilityId: capabilityId,
      outcome: "succeeded", quality: "meets_requirement",
    }));
    assert.equal(report.outcome, "succeeded");
    assert.equal(report.matchesSelection, true);
    assert.equal(report.verification, "agent_reported");
  }
});

function protocol(data) {
  const structuredContent = { controlLevel: "advice_only", ...data };
  return {
    isError: false, structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

test("projection retains a literal pending comparison through selection, running and report", () => {
  const projection = createStatusProjection({ now: () => new Date(END) });
  const comparisonId = "11111111-1111-4111-8111-111111111111";
  const candidateId = "22222222-2222-4222-8222-222222222222";
  const selectionId = "44444444-4444-4444-8444-444444444444";
  projection.accept("compare_capabilities", protocol({
    comparisonId, catalogRevision: 2, taskType: "mode_test", mode: "manual",
    status: "needs_selection", selection: null,
    recommendedCandidateId: candidateId,
    explanation: "按目录优先值推荐，等待用户选择，不执行。",
    candidates: [
      {
        candidateId, capabilityId: "mode_beta", name: "Beta", kind: "plugin",
        execution: { type: "host_tool", id: "mode.beta" },
        catalogSource: "agent_reported", bindingSource: "agent_reported",
        availability: "ready", availabilitySource: "agent_reported", fit: "direct",
        reason: "直接适用且自报就绪。", limitations: "不授予执行权限。",
      },
      {
        candidateId: "33333333-3333-4333-8333-333333333333",
        capabilityId: "mode_alpha", name: "Alpha", kind: "cli",
        execution: { type: "local_cli", id: "mode.alpha" },
        catalogSource: "agent_reported", bindingSource: "agent_reported",
        availability: "ready", availabilitySource: "agent_reported", fit: "direct",
        reason: "直接适用且自报就绪。", limitations: "不授予执行权限。",
      },
    ],
  }));
  const pending = projection.snapshot();
  assert.equal(pending.current.comparisonId, comparisonId);
  assert.equal(pending.current.state, "waiting");
  assert.equal(pending.current.reason, "awaiting_user");
  assert.equal(pending.current.selectionId, null);
  assert.equal(pending.current.selectedCapabilityId, null);
  assert.equal(pending.current.selectedCapabilityName, null);
  assert.equal(pending.current.startedAt, null);
  assert.equal(pending.history.some(item => item.state === "selected"), false);

  projection.accept("select_capability", protocol({ selection: {
    selectionId, comparisonId, catalogRevision: 2, candidateId,
    capabilityId: "mode_beta", reason: "user_requested",
    selectionSource: "agent_reported_user_request",
    explanation: "记录用户要求，不执行。",
  } }));
  assert.equal(projection.snapshot().current.state, "selected");
  assert.equal(projection.snapshot().current.selectionId, selectionId);
  assert.equal(projection.snapshot().current.selectedCapabilityId, "mode_beta");
  assert.equal(projection.snapshot().current.startedAt, null);

  projection.accept("report_task_status", protocol({ taskStatus: {
    statusId: "55555555-5555-4555-8555-555555555555",
    selectionId, comparisonId, catalogRevision: 2, capabilityId: "mode_beta",
    state: "running", reason: "none", verification: "agent_reported",
    recordedAt: START,
  } }));
  assert.equal(projection.snapshot().current.state, "running");
  assert.equal(projection.snapshot().current.startedAt, START);

  projection.accept("report_capability_use", protocol({ report: {
    reportId: "66666666-6666-4666-8666-666666666666",
    selectionId, catalogRevision: 2, selectedCapabilityId: "mode_beta",
    actualCapabilityId: "mode_beta", outcome: "succeeded",
    quality: "meets_requirement", verification: "agent_reported",
    matchesSelection: true, explanation: "实际采用结果由 Agent 自报。",
  } }));
  const finished = projection.snapshot().current;
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.actualCapabilityId, "mode_beta");
  assert.equal(finished.matchesSelection, true);
  assert.equal(finished.endedAt, END);
});

test("stdio advertises six tools and supports manual, recommend and auto modes", {
  timeout: 15000,
}, async t => {
  const { Client } = require("@modelcontextprotocol/sdk-v1/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk-v1/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/capability-mcp.mjs", import.meta.url))],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, ATC_STATUS_WINDOW: "0" },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "capability-selection-modes-test", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "compare_capabilities", "list_capabilities", "refresh_capabilities",
    "report_capability_use", "report_task_status", "select_capability",
  ]);
  const schema = tools.find(tool => tool.name === "compare_capabilities").inputSchema;
  assert.deepEqual(
    [...schema.properties.mode.enum].sort(), ["auto", "manual", "recommend"],
  );
  assert.equal(schema.required.includes("mode"), false);
  const call = async (name, args) => success(await client.callTool({
    name, arguments: args,
  }));
  await call("refresh_capabilities", { capabilities: records() });
  const pending = await call("compare_capabilities", {
    taskType: TASK, candidates: candidates(), mode: "manual",
  });
  assert.equal(pending.mode, "manual");
  assert.equal(pending.status, "needs_selection");
  assert.equal(pending.selection, null);
  const beta = pending.candidates.find(item => item.capabilityId === "mode_beta");
  const chosen = await call("select_capability", {
    comparisonId: pending.comparisonId, candidateId: beta.candidateId,
    reason: "user_requested",
  });
  assert.equal(chosen.selection.capabilityId, "mode_beta");
  assert.equal(chosen.selection.reason, "user_requested");
  for (const mode of ["recommend", "auto"]) {
    const comparison = await call("compare_capabilities", {
      taskType: TASK, candidates: candidates(), mode,
    });
    assert.equal(comparison.mode, mode);
    assert.equal(comparison.status, "ready");
    assert.equal(comparison.selection.capabilityId, "mode_beta");
    assert.equal(comparison.selection.reason, "agent_auto");
  }
});
