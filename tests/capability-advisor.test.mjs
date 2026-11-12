import test from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityAdvisor,
  CAPABILITY_ADVISOR_TOOLS,
} from "../src/capability-advisor.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_ID = "18610d20-1848-4d5c-9a60-a479b8e7ebcc";
const MARKER = "REJECTED_SECRET_MARKER";
const CAPABILITIES = [
  "local_cli",
  "remote_desktop_commander",
  "computer_use",
  "agent_desktop",
];

function advisor(t) {
  const instance = createCapabilityAdvisor();
  t.after(() => instance.close());
  return instance;
}

function candidate(capabilityId, availability = "ready") {
  return { capabilityId, availability };
}

function compare(instance, candidates = [
  candidate("local_cli"),
  candidate("remote_desktop_commander"),
], taskType = "file_read") {
  return instance.dispatch({
    name: "compare_capabilities",
    arguments: { taskType, candidates },
  });
}

function select(instance, comparisonId, candidateId, reason = "agent_auto") {
  return instance.dispatch({
    name: "select_capability",
    arguments: { comparisonId, candidateId, reason },
  });
}

function report(instance, selectionId, actualCapabilityId, extra = {}) {
  return instance.dispatch({
    name: "report_capability_use",
    arguments: {
      selectionId,
      actualCapabilityId,
      outcome: "succeeded",
      ...extra,
    },
  });
}

function success(result) {
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  const text = result.content.filter(item => item.type === "text");
  assert.equal(text.length, 1);
  assert.deepEqual(JSON.parse(text[0].text), result.structuredContent);
  return result.structuredContent;
}

function findStatus(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["status", "statusCode"]) {
    if (typeof value[key] === "number") return value[key];
  }
  for (const child of Object.values(value)) {
    const status = findStatus(child);
    if (status !== undefined) return status;
  }
  return undefined;
}

function denied(result, expectedStatus) {
  assert.equal(result.isError, true);
  assert.ok(result.structuredContent);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  const text = result.content.filter(item => item.type === "text");
  assert.equal(text.length, 1);
  assert.deepEqual(JSON.parse(text[0].text), result.structuredContent);
  assert.equal(JSON.stringify(result).includes(MARKER), false);
  if (expectedStatus !== undefined) {
    assert.equal(findStatus(result.structuredContent), expectedStatus);
  }
}

function assertSelection(selection, comparison, selected, source) {
  assert.match(selection.selectionId, UUID);
  assert.equal(selection.comparisonId, comparison.comparisonId);
  assert.equal(selection.candidateId, selected.candidateId);
  assert.equal(selection.capabilityId, selected.capabilityId);
  assert.equal(selection.selectionSource, source);
}

test("denies unknown tools, malformed envelopes, and non-object metadata without echoing input", async t => {
  const instance = advisor(t);
  const valid = {
    name: "compare_capabilities",
    arguments: { taskType: "file_read", candidates: [candidate("local_cli")] },
  };
  for (const raw of [
    null,
    [],
    {},
    { ...valid, name: MARKER },
    { ...valid, [MARKER]: true },
    { ...valid, _meta: null },
    { ...valid, _meta: [] },
    { ...valid, _meta: MARKER },
    { ...valid, arguments: null },
    { ...valid, arguments: [] },
  ]) {
    denied(await instance.dispatch(raw));
  }
});

test("compare rejects unknown tasks, invalid readiness, duplicate candidates, and open input fields", async t => {
  const instance = advisor(t);
  const valid = { taskType: "file_read", candidates: [candidate("local_cli")] };
  const invalid = [
    { ...valid, taskType: MARKER },
    { ...valid, taskType: null },
    { ...valid, candidates: [] },
    { ...valid, candidates: CAPABILITIES.concat("local_cli").map(id => candidate(id)) },
    { ...valid, candidates: [candidate("local_cli"), candidate("local_cli")] },
    { ...valid, candidates: [candidate(MARKER)] },
    { ...valid, candidates: [candidate("local_cli", MARKER)] },
    { ...valid, candidates: [{ capabilityId: "local_cli" }] },
    { ...valid, candidates: [null] },
    { ...valid, candidates: [{ ...candidate("local_cli"), command: MARKER }] },
    ...["description", "commands", "path", "taskText", "url"].map(key => ({
      ...valid,
      [key]: MARKER,
    })),
  ];
  for (const args of invalid) {
    denied(await instance.dispatch({ name: "compare_capabilities", arguments: args }));
  }
});

test("select rejects malformed identifiers, missing reasons, and forged verification fields", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const valid = {
    comparisonId: comparison.comparisonId,
    candidateId: comparison.candidates[0].candidateId,
    reason: "user_requested",
  };
  for (const args of [
    { ...valid, comparisonId: MARKER },
    { ...valid, candidateId: MARKER },
    { comparisonId: valid.comparisonId, candidateId: valid.candidateId },
    { ...valid, reason: MARKER },
    { ...valid, verified: true },
    { ...valid, userConfirmed: true },
    { ...valid, selectionSource: MARKER },
    { ...valid, description: MARKER },
  ]) {
    denied(await instance.dispatch({ name: "select_capability", arguments: args }));
  }
});

test("report rejects malformed fields, unsafe evidence identifiers, and forged provenance", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const valid = {
    selectionId: comparison.selection.selectionId,
    actualCapabilityId: "local_cli",
    outcome: "succeeded",
  };
  for (const args of [
    { ...valid, selectionId: MARKER },
    { ...valid, actualCapabilityId: MARKER },
    { ...valid, actualCapabilityId: null },
    { ...valid, outcome: MARKER },
    { ...valid, quality: MARKER },
    { ...valid, evidenceCallId: null },
    { ...valid, evidenceCallId: `https://example.invalid/${MARKER}` },
    { ...valid, evidenceCallId: `C:\\private\\${MARKER}` },
    { ...valid, evidenceCallId: `Bearer ${MARKER}` },
    { ...valid, evidenceCallId: "call_short" },
    { ...valid, evidenceCallId: `call_${"a".repeat(101)}` },
    { ...valid, evidenceCallId: `call_${MARKER}/unsafe` },
    { ...valid, verified: true },
    { ...valid, userConfirmed: true },
    { ...valid, verification: MARKER },
    { ...valid, output: MARKER },
    { ...valid, outcome: "not_run" },
    { ...valid, outcome: "not_run", actualCapabilityId: null, evidenceCallId: "call_abcdef" },
  ]) {
    denied(await instance.dispatch({ name: "report_capability_use", arguments: args }));
  }
});

test("unknown and cross-instance identifiers return 404, including candidates from another comparison", async t => {
  const first = advisor(t);
  const second = advisor(t);
  const a = success(await compare(first));
  const b = success(await compare(first));
  denied(await select(first, UNKNOWN_ID, a.candidates[0].candidateId), 404);
  denied(await select(first, a.comparisonId, UNKNOWN_ID), 404);
  denied(await select(first, a.comparisonId, b.candidates[0].candidateId), 404);
  denied(await select(second, a.comparisonId, a.candidates[0].candidateId), 404);
  denied(await report(first, UNKNOWN_ID, "local_cli"), 404);
  denied(await report(second, a.selection.selectionId, "local_cli"), 404);
});

test("unavailable, unchecked, and non-direct candidates cannot be selected", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance, [
    candidate("local_cli", "unavailable"),
    candidate("remote_desktop_commander", "not_checked"),
    candidate("computer_use"),
    candidate("agent_desktop"),
  ]));
  assert.equal(comparison.status, "needs_check");
  assert.equal(comparison.recommendedCandidateId, null);
  assert.equal(comparison.selection, null);
  for (const item of comparison.candidates) {
    assert.ok(item.reason);
    assert.ok(item.limitations);
    denied(await select(instance, comparison.comparisonId, item.candidateId));
  }
});

test("advertises exactly the six advisor tools and ignores object metadata", async t => {
  assert.deepEqual(
    CAPABILITY_ADVISOR_TOOLS.map(tool => tool.name).sort(),
    ["compare_capabilities", "list_capabilities", "refresh_capabilities",
      "report_capability_use", "report_task_status", "select_capability"].sort(),
  );
  const instance = advisor(t);
  const result = await instance.dispatch({
    name: "compare_capabilities",
    arguments: { taskType: "file_read", candidates: [candidate("local_cli")] },
    _meta: { verified: true, userConfirmed: true, arbitrary: MARKER },
  });
  const comparison = success(result);
  assert.equal(comparison.status, "ready");
  assert.equal(JSON.stringify(result).includes(MARKER), false);
  assert.equal(comparison.candidates[0].availabilitySource, "agent_reported");
});

test("file and terminal defaults prefer local CLI regardless of caller ordering", async t => {
  const instance = advisor(t);
  for (const taskType of ["file_read", "file_search", "terminal"]) {
    const comparison = success(await compare(instance, [
      candidate("remote_desktop_commander"),
      candidate("local_cli"),
    ], taskType));
    assert.match(comparison.comparisonId, UUID);
    assert.equal(comparison.status, "ready");
    assert.equal(new Set(comparison.candidates.map(item => item.candidateId)).size, 2);
    for (const item of comparison.candidates) {
      assert.match(item.candidateId, UUID);
      assert.ok(item.name);
      assert.ok(item.kind);
      assert.equal(item.availability, "ready");
      assert.equal(item.availabilitySource, "agent_reported");
      assert.equal(item.fit, "direct");
      assert.ok(item.reason);
      assert.ok(item.limitations);
    }
    const local = comparison.candidates.find(item => item.capabilityId === "local_cli");
    assert.equal(comparison.recommendedCandidateId, local.candidateId);
    assertSelection(comparison.selection, comparison, local, "agent_auto");
  }
});

test("GUI routing prefers computer use and never treats ready RDC as a GUI capability", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance, [
    candidate("remote_desktop_commander"),
    candidate("agent_desktop"),
    candidate("computer_use"),
  ], "desktop_ui"));
  const computer = comparison.candidates.find(item => item.capabilityId === "computer_use");
  const rdc = comparison.candidates.find(item => item.capabilityId === "remote_desktop_commander");
  assert.equal(comparison.status, "ready");
  assert.equal(rdc.fit, "not_direct");
  assert.ok(rdc.reason);
  assert.equal(comparison.recommendedCandidateId, computer.candidateId);
  assertSelection(comparison.selection, comparison, computer, "agent_auto");

  const unchecked = success(await compare(instance, [
    candidate("remote_desktop_commander"),
    candidate("computer_use", "not_checked"),
  ], "desktop_ui"));
  assert.equal(unchecked.status, "needs_check");
  assert.equal(unchecked.recommendedCandidateId, null);
  assert.equal(unchecked.selection, null);
  assert.equal(
    unchecked.candidates.find(item => item.capabilityId === "computer_use").availability,
    "not_checked",
  );
});

test("each task falls back only to its directly applicable ready capability", async t => {
  const instance = advisor(t);
  for (const taskType of ["file_read", "file_search", "terminal"]) {
    const comparison = success(await compare(instance, [
      candidate("local_cli", "unavailable"),
      candidate("remote_desktop_commander"),
      candidate("computer_use"),
      candidate("agent_desktop"),
    ], taskType));
    assert.equal(comparison.selection.capabilityId, "remote_desktop_commander");
    for (const item of comparison.candidates) {
      assert.equal(
        item.fit,
        ["local_cli", "remote_desktop_commander"].includes(item.capabilityId)
          ? "direct" : "not_direct",
      );
    }
  }
  const gui = success(await compare(instance, [
    candidate("local_cli"),
    candidate("remote_desktop_commander"),
    candidate("computer_use", "unavailable"),
    candidate("agent_desktop"),
  ], "desktop_ui"));
  assert.equal(gui.selection.capabilityId, "agent_desktop");
  assert.equal(gui.candidates.find(item => item.capabilityId === "local_cli").fit, "not_direct");
});

test("switching from default A to RDC B creates independent selections and preserves A", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const original = structuredClone(comparison.selection);
  const rdc = comparison.candidates.find(item => item.capabilityId === "remote_desktop_commander");
  const switched = success(await select(
    instance, comparison.comparisonId, rdc.candidateId, "user_requested",
  )).selection;
  assertSelection(switched, comparison, rdc, "agent_reported_user_request");
  assert.notEqual(switched.selectionId, original.selectionId);
  const automatic = success(await select(
    instance, comparison.comparisonId, rdc.candidateId, "agent_auto",
  )).selection;
  assertSelection(automatic, comparison, rdc, "agent_auto");
  assert.notEqual(automatic.selectionId, switched.selectionId);
  assert.deepEqual(comparison.selection, original);
  const originalReport = success(await report(instance, original.selectionId, "local_cli")).report;
  assert.equal(originalReport.selectedCapabilityId, "local_cli");
  assert.equal(originalReport.matchesSelection, true);
  const switchedReport = success(await report(instance, switched.selectionId, "local_cli")).report;
  assert.equal(switchedReport.selectedCapabilityId, "remote_desktop_commander");
  assert.equal(switchedReport.actualCapabilityId, "local_cli");
  assert.equal(switchedReport.matchesSelection, false);
});

test("input and returned snapshot mutations cannot change frozen candidates or selections", async t => {
  const instance = advisor(t);
  const input = {
    taskType: "file_read",
    candidates: [candidate("local_cli"), candidate("remote_desktop_commander", "unavailable")],
  };
  const comparison = success(await instance.dispatch({
    name: "compare_capabilities",
    arguments: input,
  }));
  const comparisonId = comparison.comparisonId;
  const localId = comparison.candidates[0].candidateId;
  const unavailableId = comparison.candidates[1].candidateId;
  const originalSelectionId = comparison.selection.selectionId;
  input.taskType = "desktop_ui";
  input.candidates[1].availability = "ready";
  comparison.candidates[1].availability = "ready";
  comparison.candidates[1].fit = "direct";
  comparison.selection.capabilityId = "agent_desktop";
  denied(await select(instance, comparisonId, unavailableId));
  const selected = success(await select(instance, comparisonId, localId)).selection;
  assert.equal(selected.capabilityId, "local_cli");
  const selectedId = selected.selectionId;
  selected.capabilityId = "remote_desktop_commander";
  const originalReport = success(await report(instance, originalSelectionId, "local_cli")).report;
  const laterReport = success(await report(instance, selectedId, "local_cli")).report;
  assert.equal(originalReport.selectedCapabilityId, "local_cli");
  assert.equal(laterReport.selectedCapabilityId, "local_cli");
  assert.equal(laterReport.matchesSelection, true);
});

test("reports keep agent provenance even with plausible call evidence and retain distinct quality", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const local = comparison.candidates.find(item => item.capabilityId === "local_cli");
  const cases = [
    { outcome: "succeeded", quality: "meets_requirement", evidenceCallId: "call_abc123_DEF-456" },
    { outcome: "succeeded", quality: "does_not_meet", evidenceCallId: UNKNOWN_ID },
    { outcome: "failed", quality: "not_assessed" },
  ];
  for (const fields of cases) {
    const selection = success(await select(
      instance, comparison.comparisonId, local.candidateId,
    )).selection;
    const record = success(await report(instance, selection.selectionId, "local_cli", fields)).report;
    assert.match(record.reportId, UUID);
    assert.equal(record.selectionId, selection.selectionId);
    assert.equal(record.selectedCapabilityId, "local_cli");
    assert.equal(record.actualCapabilityId, "local_cli");
    assert.equal(record.outcome, fields.outcome);
    assert.equal(record.quality, fields.quality);
    assert.equal(record.verification, "agent_reported");
    assert.equal(record.matchesSelection, true);
    assert.equal(record.evidenceCallId, fields.evidenceCallId);
  }
});

test("not_run has null actual capability and match, with quality defaulted independently", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const record = success(await report(
    instance, comparison.selection.selectionId, null, { outcome: "not_run" },
  )).report;
  assert.match(record.reportId, UUID);
  assert.equal(record.selectedCapabilityId, "local_cli");
  assert.equal(record.actualCapabilityId, null);
  assert.equal(record.outcome, "not_run");
  assert.equal(record.quality, "not_assessed");
  assert.equal(record.verification, "agent_reported");
  assert.equal(record.matchesSelection, null);
  assert.equal(record.evidenceCallId, undefined);
});

test("identical reports are idempotent, returned reports are isolated, and conflicts return 409", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const selectionId = comparison.selection.selectionId;
  const fields = { evidenceCallId: "call_abcdef" };
  const first = success(await report(instance, selectionId, "local_cli", fields)).report;
  const expected = structuredClone(first);
  first.actualCapabilityId = "agent_desktop";
  first.quality = "does_not_meet";
  const repeated = success(await report(instance, selectionId, "local_cli", fields)).report;
  assert.deepEqual(repeated, expected);
  const explicitDefault = success(await report(instance, selectionId, "local_cli", {
    ...fields, quality: "not_assessed",
  })).report;
  assert.deepEqual(explicitDefault, expected);
  for (const args of [
    { actualCapabilityId: "remote_desktop_commander", ...fields },
    { outcome: "failed", ...fields },
    { quality: "meets_requirement", ...fields },
    { evidenceCallId: "call_ghijkl" },
  ]) {
    const { actualCapabilityId = "local_cli", ...extra } = args;
    denied(await report(instance, selectionId, actualCapabilityId, extra), 409);
  }
  assert.deepEqual(
    success(await report(instance, selectionId, "local_cli", fields)).report,
    expected,
  );
});

test("the twenty-first comparison evicts the oldest comparison and its related state", async t => {
  const instance = advisor(t);
  const oldest = success(await compare(instance));
  const originalReport = success(await report(
    instance, oldest.selection.selectionId, "local_cli",
  )).report;
  const rdc = oldest.candidates.find(item => item.capabilityId === "remote_desktop_commander");
  const switched = success(await select(
    instance, oldest.comparisonId, rdc.candidateId, "user_requested",
  )).selection;
  const switchedReport = success(await report(
    instance, switched.selectionId, "remote_desktop_commander",
  )).report;
  let recent;
  for (let index = 0; index < 19; index += 1) {
    recent = success(await compare(instance));
  }
  success(await select(instance, oldest.comparisonId, oldest.candidates[0].candidateId));
  recent = success(await compare(instance));
  denied(await select(instance, oldest.comparisonId, oldest.candidates[0].candidateId), 404);
  denied(await report(instance, originalReport.selectionId, "local_cli"), 404);
  denied(await report(
    instance, switchedReport.selectionId, "remote_desktop_commander",
  ), 404);
  const selected = success(await select(
    instance, recent.comparisonId, recent.candidates[0].candidateId,
  )).selection;
  assert.equal(selected.comparisonId, recent.comparisonId);
  success(await report(instance, recent.selection.selectionId, "local_cli"));
  success(await report(instance, selected.selectionId, "local_cli"));
});

test("selection retention evicts the oldest after fifty while retaining its comparison and recent selections", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  const oldestId = comparison.selection.selectionId;
  success(await report(instance, oldestId, "local_cli"));
  let recent;
  for (let index = 0; index < 49; index += 1) {
    recent = success(await select(
      instance, comparison.comparisonId, comparison.candidates[0].candidateId,
    )).selection;
  }
  const fiftiethId = recent.selectionId;
  const retainedReport = success(await report(instance, fiftiethId, "local_cli")).report;
  recent = success(await select(
    instance, comparison.comparisonId, comparison.candidates[0].candidateId,
  )).selection;
  denied(await report(instance, oldestId, "local_cli"), 404);
  assert.deepEqual(
    success(await report(instance, fiftiethId, "local_cli")).report,
    retainedReport,
  );
  success(await report(instance, recent.selectionId, "local_cli"));
});

test("close invalidates session state and prevents subsequent successful dispatch", async t => {
  const instance = advisor(t);
  const comparison = success(await compare(instance));
  success(await report(instance, comparison.selection.selectionId, "local_cli"));
  await instance.close();
  denied(await select(instance, comparison.comparisonId, comparison.candidates[0].candidateId));
  denied(await report(instance, comparison.selection.selectionId, "local_cli"));
  denied(await compare(instance));
  await instance.close();
});
