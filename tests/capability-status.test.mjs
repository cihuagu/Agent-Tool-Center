import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityAdvisor,
  CAPABILITY_ADVISOR_TOOLS,
} from "../src/capability-advisor.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_ID = "18610d20-1848-4d5c-9a60-a479b8e7ebcc";
const MARKER = "REJECTED_SECRET_MARKER";

function advisor(t) {
  const instance = createCapabilityAdvisor();
  t.after(() => instance.close());
  return instance;
}

function dispatch(instance, name, args) {
  return instance.dispatch({ name, arguments: args });
}

function success(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  assert.deepEqual(result.content, [{
    type: "text", text: JSON.stringify(result.structuredContent),
  }]);
  return result.structuredContent;
}

function denied(result, status) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  assert.equal(result.structuredContent.status, status);
  assert.equal(JSON.stringify(result).includes(MARKER), false);
}

function compare(instance) {
  return success(dispatch(instance, "compare_capabilities", {
    taskType: "file_read",
    candidates: [
      { capabilityId: "local_cli", availability: "ready" },
      { capabilityId: "remote_desktop_commander", availability: "ready" },
    ],
  }));
}

function status(instance, selectionId, state = "running", reason = "none", extra = {}) {
  return dispatch(instance, "report_task_status", {
    selectionId, state, reason, ...extra,
  });
}

function report(instance, selectionId) {
  return dispatch(instance, "report_capability_use", {
    selectionId, actualCapabilityId: "local_cli", outcome: "succeeded",
  });
}

test("task status rejects invalid combinations and undeclared fields without echoing input", t => {
  const instance = advisor(t);
  const { selection } = compare(instance);
  const valid = { selectionId: selection.selectionId, state: "running", reason: "none" };
  const invalid = [
    null, [], {},
    { ...valid, selectionId: MARKER },
    { selectionId: valid.selectionId, state: "running" },
    { selectionId: valid.selectionId, reason: "none" },
    { ...valid, state: "succeeded" },
    { ...valid, state: "waiting" },
    { ...valid, state: "cancelled" },
    { ...valid, state: ["running"], reason: "none", taskLabel: MARKER },
    { ...valid, state: ["waiting"], reason: "awaiting_tool", taskLabel: MARKER },
    { ...valid, state: ["cancelled"], reason: "user_cancelled", taskLabel: MARKER },
    { ...valid, reason: "awaiting_tool" },
    { ...valid, state: "waiting", reason: "user_cancelled" },
    { ...valid, state: "cancelled", reason: "tool_error" },
    ...["timestamp", "recordedAt", "threadId", "path", "cmd", "verified",
      "verification", "output", "description"].map(key => ({
      ...valid, [key]: MARKER,
    })),
    ...["", " ", " leading", "trailing ", "x".repeat(81),
      `C:\\private\\${MARKER}`, `https://example.invalid/${MARKER}`,
      `first\n${MARKER}`, null, 1].map(taskLabel => ({ ...valid, taskLabel })),
  ];
  for (const args of invalid) {
    denied(dispatch(instance, "report_task_status", args), 400);
  }
  assert.equal(success(status(instance, selection.selectionId)).taskStatus.state, "running");
});

test("task status rejects unknown, foreign and closed selection records", t => {
  const first = advisor(t);
  const second = advisor(t);
  const { selection } = compare(first);
  denied(status(first, UNKNOWN_ID), 404);
  denied(status(second, selection.selectionId), 404);
  first.close();
  denied(status(first, selection.selectionId), 503);
});

test("sixth tool declares strict status fields and metadata-only idempotent annotations", () => {
  const tool = CAPABILITY_ADVISOR_TOOLS.find(item => item.name === "report_task_status");
  assert.ok(tool);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual([...tool.inputSchema.required].sort(), ["reason", "selectionId", "state"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),
    ["reason", "selectionId", "state", "taskLabel"]);
  assert.deepEqual([...tool.inputSchema.properties.state.enum].sort(),
    ["cancelled", "running", "waiting"]);
  assert.equal(tool.inputSchema.properties.taskLabel.minLength, 1);
  assert.equal(tool.inputSchema.properties.taskLabel.maxLength, 80);
});

test("status records contain only associated IDs, explicit state and agent provenance", t => {
  const instance = advisor(t);
  const comparison = compare(instance);
  const before = Date.now();
  const data = success(status(instance, comparison.selection.selectionId));
  const record = data.taskStatus;
  assert.deepEqual(Object.keys(data).sort(), ["controlLevel", "taskStatus"]);
  assert.deepEqual(Object.keys(record).sort(), [
    "capabilityId", "catalogRevision", "comparisonId", "reason", "recordedAt",
    "selectionId", "state", "statusId", "verification",
  ]);
  assert.match(record.statusId, UUID);
  assert.equal(record.selectionId, comparison.selection.selectionId);
  assert.equal(record.comparisonId, comparison.comparisonId);
  assert.equal(record.catalogRevision, comparison.catalogRevision);
  assert.equal(record.capabilityId, "local_cli");
  assert.equal(record.state, "running");
  assert.equal(record.reason, "none");
  assert.equal(record.verification, "agent_reported");
  assert.equal(new Date(record.recordedAt).toISOString(), record.recordedAt);
  assert.ok(Date.parse(record.recordedAt) >= before);
  assert.ok(Date.parse(record.recordedAt) <= Date.now());
  assert.equal(Object.hasOwn(record, "taskLabel"), false);
});

test("identical statuses preserve ID and time while transitions and label changes create records", t => {
  const instance = advisor(t);
  const { selection } = compare(instance);
  const first = success(status(instance, selection.selectionId)).taskStatus;
  const expected = structuredClone(first);
  first.state = "cancelled";
  first.capabilityId = "agent_desktop";
  assert.deepEqual(success(status(instance, selection.selectionId)).taskStatus, expected);

  const seen = new Set([expected.statusId]);
  for (const reason of [
    "awaiting_tool", "awaiting_user", "permission_required",
    "dependency_unavailable", "tool_error",
  ]) {
    const args = { taskLabel: "检查中文任务 (1)" };
    const next = success(status(instance, selection.selectionId, "waiting", reason, args)).taskStatus;
    assert.equal(next.state, "waiting");
    assert.equal(next.reason, reason);
    assert.equal(next.taskLabel, args.taskLabel);
    assert.equal(seen.has(next.statusId), false);
    seen.add(next.statusId);
    assert.deepEqual(
      success(status(instance, selection.selectionId, "waiting", reason, args)).taskStatus,
      next,
    );
  }
  const resumed = success(status(instance, selection.selectionId)).taskStatus;
  assert.equal(seen.has(resumed.statusId), false);
  assert.notEqual(resumed.statusId, expected.statusId);
  const labelled = success(status(instance, selection.selectionId, "running", "none", {
    taskLabel: "x".repeat(80),
  })).taskStatus;
  assert.notEqual(labelled.statusId, resumed.statusId);
  assert.equal(labelled.taskLabel.length, 80);
});

test("cancelled status is terminal for statuses but permits a final actual-use report", t => {
  const instance = advisor(t);
  const { selection } = compare(instance);
  const cancelled = success(status(
    instance, selection.selectionId, "cancelled", "user_cancelled",
  )).taskStatus;
  denied(status(instance, selection.selectionId), 409);
  denied(status(instance, selection.selectionId, "waiting", "awaiting_user"), 409);
  denied(status(instance, selection.selectionId, "cancelled", "user_cancelled", {
    taskLabel: "不同标签",
  }), 409);
  assert.deepEqual(success(status(
    instance, selection.selectionId, "cancelled", "user_cancelled",
  )).taskStatus, cancelled);
  assert.equal(success(report(instance, selection.selectionId)).report.outcome, "succeeded");
  denied(status(instance, selection.selectionId, "cancelled", "user_cancelled"), 409);
});

test("a final report blocks all subsequent task statuses without changing the report", t => {
  const instance = advisor(t);
  const { selection } = compare(instance);
  const final = success(report(instance, selection.selectionId));
  denied(status(instance, selection.selectionId), 409);
  assert.deepEqual(success(report(instance, selection.selectionId)), final);
});

test("catalog refresh retains old selection status and its original catalog revision", t => {
  const instance = advisor(t);
  const comparison = compare(instance);
  const first = success(status(instance, comparison.selection.selectionId)).taskStatus;
  success(dispatch(instance, "refresh_capabilities", { capabilities: [{
    capabilityId: "status_fixture", name: "状态示例", kind: "plugin",
    sourceId: "Status:fixture", taskTypes: ["file_read"], availability: "ready",
    execution: { type: "host_tool", id: "Status:read" },
  }] }));
  assert.deepEqual(success(status(instance, comparison.selection.selectionId)).taskStatus, first);
  const next = success(status(
    instance, comparison.selection.selectionId, "waiting", "awaiting_tool",
  )).taskStatus;
  assert.equal(next.catalogRevision, comparison.catalogRevision);
  assert.equal(next.comparisonId, comparison.comparisonId);
});

test("comparison and selection eviction cascade to their status records", t => {
  const instance = advisor(t);
  const oldest = compare(instance);
  success(status(instance, oldest.selection.selectionId));
  for (let index = 0; index < 20; index += 1) compare(instance);
  denied(status(instance, oldest.selection.selectionId), 404);

  const retained = compare(instance);
  success(status(instance, retained.selection.selectionId));
  let latest;
  for (let index = 0; index < 49; index += 1) {
    latest = success(dispatch(instance, "select_capability", {
      comparisonId: retained.comparisonId,
      candidateId: retained.candidates[0].candidateId,
      reason: "agent_auto",
    })).selection;
  }
  const kept = success(status(instance, latest.selectionId)).taskStatus;
  success(status(instance, retained.selection.selectionId));
  const newest = success(dispatch(instance, "select_capability", {
    comparisonId: retained.comparisonId,
    candidateId: retained.candidates[0].candidateId,
    reason: "agent_auto",
  })).selection;
  denied(status(instance, retained.selection.selectionId), 404);
  assert.deepEqual(success(status(instance, latest.selectionId)).taskStatus, kept);
  success(status(instance, newest.selectionId));
});
