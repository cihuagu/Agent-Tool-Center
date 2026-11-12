import test from "node:test";
import assert from "node:assert/strict";
import { createCapabilityAdvisor } from "../src/capability-advisor.mjs";

const MARKER = "REJECTED_SECRET_MARKER";
const defaults = ["agent_desktop", "computer_use", "local_cli", "remote_desktop_commander"];
const record = (capabilityId = "sample_plugin", extra = {}) => ({
  capabilityId,
  name: "示例 Plugin (CLI)-1",
  kind: "plugin",
  sourceId: "Plugin:sample.v1",
  taskTypes: ["custom_task"],
  availability: "ready",
  execution: { type: "host_tool", id: "Plugin:read_v1" },
  ...extra,
});
const candidate = (capabilityId, availability = "ready") => ({ capabilityId, availability });

function advisor(t) {
  const instance = createCapabilityAdvisor();
  t.after(() => instance.close());
  return instance;
}

function invoke(instance, name, args = {}) {
  return instance.dispatch({ name, arguments: args });
}

function success(result) {
  assert.notEqual(result.isError, true);
  const data = result.structuredContent;
  assert.equal(data.controlLevel, "advice_only");
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(data) }]);
  return data;
}

function denied(result, status) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  assert.equal(JSON.stringify(result).includes(MARKER), false);
  if (status !== undefined) assert.equal(result.structuredContent.status, status);
}

const list = (instance, args = {}) => success(invoke(instance, "list_capabilities", args));
const refresh = (instance, capabilities) =>
  success(invoke(instance, "refresh_capabilities", { capabilities }));
const compare = (instance, candidates, taskType = "custom_task") =>
  success(invoke(instance, "compare_capabilities", { taskType, candidates }));
const select = (instance, comparison) => invoke(instance, "select_capability", {
  comparisonId: comparison.comparisonId,
  candidateId: comparison.candidates[0].candidateId,
  reason: "user_requested",
});
const report = (instance, selectionId, actualCapabilityId, extra = {}) =>
  invoke(instance, "report_capability_use", {
    selectionId, actualCapabilityId, outcome: "succeeded", ...extra,
  });

test("refresh rejects open envelopes and records without echoing secrets or changing state", t => {
  const instance = advisor(t);
  const before = list(instance);
  const missing = Object.keys(record()).map(key => {
    const value = record();
    delete value[key];
    return { capabilities: [value] };
  });
  for (const args of [
    null, [], {}, { capabilities: null }, { capabilities: {} },
    { capabilities: [], verified: MARKER },
    { capabilities: [], task: MARKER },
    ...missing,
    ...["description", "schema", "command", "path", "url", "verified", "trusted",
      "catalogSource", "availabilitySource", "bindingSource"].map(key => ({
      capabilities: [record("sample_plugin", { [key]: MARKER })],
    })),
  ]) {
    denied(invoke(instance, "refresh_capabilities", args), 400);
    assert.deepEqual(list(instance), before);
  }
});

test("refresh validates identifier, label, kind, readiness and priority boundaries atomically", t => {
  const instance = advisor(t);
  const before = list(instance);
  const invalid = [
    ...[null, 1, "a", "A_bad", "aa-bb", "aa/bb", "a".repeat(65)].map(capabilityId => ({ capabilityId })),
    ...["", " name", "name ", "a".repeat(81), `Name ${MARKER}!`, "a\nb", "a/b"].map(name => ({ name })),
    ...[null, "", "extension", MARKER].map(kind => ({ kind })),
    ...["", "1source", "a/b", "a\\b", "a b", "a".repeat(129)].map(sourceId => ({ sourceId })),
    ...[null, "verified", MARKER].map(availability => ({ availability })),
    ...[null, -1, 1001, 1.5, "1"].map(priority => ({ priority })),
  ];
  for (const extra of invalid) {
    denied(invoke(instance, "refresh_capabilities", { capabilities: [record("sample_plugin", extra)] }), 400);
    assert.deepEqual(list(instance), before);
  }
  refresh(instance, [
    record("ab", { name: "中".repeat(80), sourceId: "A".repeat(128), priority: 0 }),
    record("a".repeat(64), { priority: 1000 }),
  ]);
  assert.equal(list(instance).total, 6);
});

test("refresh rejects unsafe task identifiers and execution bindings", t => {
  const instance = advisor(t);
  const before = list(instance);
  const invalid = [
    ...[null, "custom_task", [], ["aa", "aa"], ["a"], ["Bad"], ["aa/bb"],
      ["a".repeat(65)], Array.from({ length: 9 }, (_, i) => `task_${i}`)].map(taskTypes => ({ taskTypes })),
    ...[null, {}, { type: "shell", id: "safe" }, { type: "host_tool" },
      { type: "host_tool", id: "safe", command: MARKER },
      ...["", "1bad", "a/b", "a\\b", "a b", `a;${MARKER}`, "a".repeat(129)]
        .map(id => ({ type: "local_cli", id })),
      { type: "instruction_only" }].map(execution => ({ execution })),
    { kind: "skill", availability: "ready", execution: { type: "instruction_only" } },
    { kind: "skill", availability: "not_checked", execution: { type: "instruction_only", id: "bad" } },
  ];
  for (const extra of invalid) {
    denied(invoke(instance, "refresh_capabilities", { capabilities: [record("sample_plugin", extra)] }), 400);
    assert.deepEqual(list(instance), before);
  }
  refresh(instance, [record("valid_cli", {
    kind: "cli", taskTypes: Array.from({ length: 8 }, (_, i) => `task_${i}`),
    execution: { type: "local_cli", id: "A".repeat(128) },
  })]);
});

test("duplicates, default collisions and mixed invalid batches preserve snapshot and revision", t => {
  const instance = advisor(t);
  refresh(instance, [record("retained_plugin")]);
  const before = list(instance);
  for (const capabilities of [
    [record(), record()],
    ...defaults.map(id => [record(id)]),
    [record("new_plugin"), record("bad_plugin", { description: MARKER })],
    [record("new_plugin"), null],
  ]) {
    denied(invoke(instance, "refresh_capabilities", { capabilities }), 400);
    assert.deepEqual(list(instance), before);
  }
});

test("total capacity includes defaults and never silently truncates", t => {
  const instance = advisor(t);
  const entries = Array.from({ length: 252 }, (_, i) => record(`plugin_${i}`));
  const accepted = refresh(instance, entries);
  assert.equal(accepted.total, 256);
  const before = list(instance);
  for (const count of [253, 256, 257]) {
    denied(invoke(instance, "refresh_capabilities", {
      capabilities: Array.from({ length: count }, (_, i) => record(`replacement_${i}`)),
    }), 400);
    assert.deepEqual(list(instance), before);
  }
});

test("refresh replaces snapshots, canonicalizes ordering and defaults, and clears idempotently", t => {
  const instance = advisor(t);
  assert.equal(list(instance).catalogRevision, 1);
  const a = record("alpha_plugin", { taskTypes: ["zz_task", "aa_task"] });
  const b = record("beta_plugin");
  const first = refresh(instance, [b, a]);
  assert.equal(first.catalogRevision, 2);
  assert.equal(first.changed, true);
  assert.equal(first.total, 6);
  assert.deepEqual(first.addedCapabilityIds, ["alpha_plugin", "beta_plugin"]);
  assert.deepEqual(first.removedCapabilityIds, []);
  assert.deepEqual(first.updatedCapabilityIds, []);
  assert.equal(first.discovery, "agent_supplied_snapshot");
  assert.equal(first.verification, "agent_reported");
  const repeat = refresh(instance, [
    { ...a, taskTypes: ["aa_task", "zz_task"], priority: 100 }, { ...b, priority: 100 },
  ]);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.catalogRevision, 2);
  for (const key of ["addedCapabilityIds", "removedCapabilityIds", "updatedCapabilityIds"]) {
    assert.deepEqual(repeat[key], []);
  }
  const replacement = refresh(instance, [record("alpha_plugin", { priority: 2 })]);
  assert.equal(replacement.catalogRevision, 3);
  assert.deepEqual(replacement.updatedCapabilityIds, ["alpha_plugin"]);
  assert.deepEqual(replacement.removedCapabilityIds, ["beta_plugin"]);
  const cleared = refresh(instance, []);
  assert.equal(cleared.catalogRevision, 4);
  assert.deepEqual(cleared.removedCapabilityIds, ["alpha_plugin"]);
  assert.equal(cleared.total, 4);
  assert.equal(refresh(instance, []).catalogRevision, 4);
  assert.equal(refresh(instance, []).changed, false);
});

test("list paginates the entire catalog with bounded strict inputs and fixed provenance", t => {
  const instance = advisor(t);
  refresh(instance, Array.from({ length: 103 }, (_, i) => record(`plugin_${i}`)));
  const first = list(instance);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 50);
  assert.equal(first.total, 107);
  const all = [];
  let offset = 0;
  do {
    const page = list(instance, { offset, limit: 50 });
    assert.equal(page.catalogRevision, first.catalogRevision);
    assert.equal(page.discovery, "agent_supplied_snapshot");
    assert.equal(page.offset, offset);
    assert.equal(page.limit, 50);
    assert.equal(page.capabilities.length, Math.min(50, 107 - offset));
    all.push(...page.capabilities);
    offset = page.nextOffset;
    if (offset !== null) assert.equal(offset, all.length);
  } while (offset !== null);
  assert.equal(new Set(all.map(item => item.capabilityId)).size, 107);
  for (const item of all) {
    assert.equal(item.catalogSource, defaults.includes(item.capabilityId) ? "project_seed" : "agent_reported");
    assert.equal(item.availabilitySource, "agent_reported");
    assert.equal(item.bindingSource, "agent_reported");
    if (defaults.includes(item.capabilityId)) assert.equal(item.availability, "not_checked");
  }
  for (const id of defaults) assert.ok(all.some(item => item.capabilityId === id));
  for (const offset of [107, 256]) {
    const page = list(instance, { offset, limit: 1 });
    assert.deepEqual(page.capabilities, []);
    assert.equal(page.nextOffset, null);
  }
  assert.equal(list(instance, { limit: 1 }).capabilities.length, 1);
  for (const args of [
    null, [], { offset: -1 }, { offset: 257 }, { offset: 0.5 }, { offset: "0" },
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: null },
    { verified: MARKER }, { task: MARKER },
  ]) denied(invoke(instance, "list_capabilities", args), 400);
});

test("new plugin and generic task identifiers support automatic and explicit selection", t => {
  const instance = advisor(t);
  refresh(instance, [record("new_plugin", { taskTypes: ["brand_new_task"] })]);
  const comparison = compare(instance, [candidate("new_plugin")], "brand_new_task");
  assert.equal(comparison.status, "ready");
  assert.equal(comparison.catalogRevision, 2);
  assert.equal(comparison.candidates[0].fit, "direct");
  assert.equal(comparison.candidates[0].availabilitySource, "agent_reported");
  assert.equal(comparison.selection.capabilityId, "new_plugin");
  assert.equal(comparison.selection.catalogRevision, 2);
  const selected = success(select(instance, comparison)).selection;
  assert.equal(selected.catalogRevision, 2);
  const reported = success(report(instance, selected.selectionId, "new_plugin")).report;
  assert.equal(reported.catalogRevision, 2);
  assert.equal(reported.verification, "agent_reported");
  const unrelated = compare(instance, [candidate("new_plugin")], "other_task");
  assert.equal(unrelated.status, "needs_check");
  assert.equal(unrelated.selection, null);
  denied(select(instance, unrelated));
});

test("priority then ASCII ID determines routing independently of candidate and refresh order", t => {
  const instance = advisor(t);
  const entries = [
    record("zeta_plugin", { priority: 1 }),
    record("alpha_plugin", { priority: 1 }),
    record("early_plugin", { priority: 0 }),
    record("last_plugin", { priority: 1000 }),
  ];
  refresh(instance, entries);
  for (const ids of [
    ["last_plugin", "zeta_plugin", "alpha_plugin", "early_plugin"],
    ["early_plugin", "alpha_plugin", "zeta_plugin", "last_plugin"],
  ]) assert.equal(compare(instance, ids.map(id => candidate(id))).selection.capabilityId, "early_plugin");
  assert.equal(compare(instance, ["zeta_plugin", "alpha_plugin"].map(id => candidate(id))).selection.capabilityId,
    "alpha_plugin");
  assert.equal(refresh(instance, [...entries].reverse()).changed, false);
  assert.equal(compare(instance, ["alpha_plugin", "zeta_plugin"].map(id => candidate(id))).selection.capabilityId,
    "alpha_plugin");
});

test("instruction-only skills are listed but cannot be upgraded, selected or reported as executed", t => {
  const instance = advisor(t);
  refresh(instance, [
    record("guide_skill", {
      kind: "skill", availability: "not_checked", execution: { type: "instruction_only" },
    }),
    record("bound_skill", { kind: "skill", execution: { type: "local_cli", id: "Skill:run" } }),
  ]);
  assert.deepEqual(list(instance).capabilities.find(item => item.capabilityId === "guide_skill").execution,
    { type: "instruction_only" });
  denied(invoke(instance, "compare_capabilities", {
    taskType: "custom_task", candidates: [candidate("guide_skill")],
  }), 400);
  const guide = compare(instance, [candidate("guide_skill", "not_checked")]);
  assert.equal(guide.status, "needs_check");
  assert.equal(guide.selection, null);
  denied(select(instance, guide));
  const bound = compare(instance, [candidate("bound_skill")]);
  assert.equal(bound.selection.capabilityId, "bound_skill");
  for (const outcome of ["succeeded", "failed"]) {
    denied(report(instance, bound.selection.selectionId, "guide_skill", { outcome }));
  }
  success(report(instance, bound.selection.selectionId, "bound_skill"));
});

test("external availability must match the snapshot while defaults retain per-call readiness", t => {
  const instance = advisor(t);
  refresh(instance, ["ready", "unavailable", "not_checked"].map((availability, i) =>
    record(`plugin_${i}`, { availability })));
  for (const [i, stored] of ["ready", "unavailable", "not_checked"].entries()) {
    for (const supplied of ["ready", "unavailable", "not_checked"]) {
      const response = invoke(instance, "compare_capabilities", {
        taskType: "custom_task", candidates: [candidate(`plugin_${i}`, supplied)],
      });
      if (stored !== supplied) denied(response, 400);
      else assert.equal(success(response).status, stored === "ready" ? "ready" : "needs_check");
    }
  }
  assert.equal(compare(instance, [candidate("local_cli")], "file_read").status, "ready");
  assert.equal(compare(instance, [candidate("local_cli", "not_checked")], "file_read").status, "needs_check");
});

test("real refresh invalidates new selections but preserves frozen reports and idempotency after removal", t => {
  const instance = advisor(t);
  refresh(instance, [record()]);
  const comparison = compare(instance, [candidate("sample_plugin")]);
  refresh(instance, [record("sample_plugin", { priority: 100 })]);
  const switched = success(select(instance, comparison)).selection;
  const existing = success(report(instance, comparison.selection.selectionId, "sample_plugin")).report;
  refresh(instance, []);
  denied(select(instance, comparison), 409);
  assert.deepEqual(success(report(instance, comparison.selection.selectionId, "sample_plugin")).report, existing);
  const lateReport = success(report(instance, switched.selectionId, "sample_plugin")).report;
  assert.equal(lateReport.catalogRevision, comparison.catalogRevision);
  assert.equal(lateReport.matchesSelection, true);
  denied(report(instance, switched.selectionId, "sample_plugin", { outcome: "failed" }), 409);
});

test("reports freeze the entire old catalog and executable membership rather than only candidates", t => {
  const instance = advisor(t);
  refresh(instance, [record("selected_plugin"), record("other_plugin")]);
  const comparison = compare(instance, [candidate("selected_plugin")]);
  const otherSelection = success(select(instance, comparison)).selection;
  refresh(instance, [record("future_plugin")]);
  denied(report(instance, comparison.selection.selectionId, "future_plugin"));
  const mismatch = success(report(instance, comparison.selection.selectionId, "other_plugin")).report;
  assert.equal(mismatch.actualCapabilityId, "other_plugin");
  assert.equal(mismatch.matchesSelection, false);
  assert.equal(mismatch.catalogRevision, comparison.catalogRevision);
  const defaultMismatch = success(report(instance, otherSelection.selectionId, "local_cli")).report;
  assert.equal(defaultMismatch.matchesSelection, false);
});

test("input and output mutations cannot change the catalog or its revision", t => {
  const instance = advisor(t);
  const input = [record()];
  const changed = refresh(instance, input);
  const expected = list(instance);
  input[0].taskTypes.push("future_task");
  input[0].execution.id = "Changed:binding";
  input[0].availability = "unavailable";
  changed.addedCapabilityIds.push("forged_plugin");
  const output = list(instance);
  const item = output.capabilities.find(item => item.capabilityId === "sample_plugin");
  item.taskTypes.push("future_task");
  item.execution.type = "instruction_only";
  item.availability = "unavailable";
  output.capabilities.pop();
  output.catalogRevision = 999;
  assert.deepEqual(list(instance), expected);
  assert.equal(refresh(instance, [record()]).changed, false);
  assert.equal(compare(instance, [candidate("sample_plugin")]).status, "ready");
  assert.equal(compare(instance, [candidate("sample_plugin")], "future_task").status, "needs_check");
});

test("catalogs are isolated between instances and close rejects catalog operations", t => {
  const first = advisor(t);
  const second = advisor(t);
  refresh(first, [record()]);
  assert.equal(list(first).catalogRevision, 2);
  assert.equal(list(second).catalogRevision, 1);
  assert.deepEqual(list(second).capabilities.map(item => item.capabilityId).sort(), defaults);
  denied(invoke(second, "compare_capabilities", {
    taskType: "custom_task", candidates: [candidate("sample_plugin")],
  }));
  first.close();
  denied(invoke(first, "list_capabilities", {}));
  denied(invoke(first, "refresh_capabilities", { capabilities: [] }));
  assert.equal(list(second).total, 4);
  const third = advisor(t);
  assert.equal(list(third).catalogRevision, 1);
  assert.equal(list(third).total, 4);
});

test("agent_method skills compare, select and report under their own Skill ID with Agent provenance", t => {
  const instance = advisor(t);
  const skill = record("rewrite_skill", {
    kind: "skill", taskTypes: ["text_rewrite"],
    execution: { type: "agent_method", id: "current_agent" },
  });
  const refreshed = refresh(instance, [skill]);
  assert.equal(refreshed.verification, "agent_reported");
  const snapshot = list(instance);
  const listed = snapshot.capabilities.find(item => item.capabilityId === skill.capabilityId);
  assert.ok(listed);
  assert.equal(listed.kind, "skill");
  assert.equal(listed.availability, "ready");
  assert.deepEqual(listed.taskTypes, ["text_rewrite"]);
  assert.deepEqual(listed.execution, skill.execution);
  assert.equal(listed.catalogSource, "agent_reported");
  assert.equal(listed.availabilitySource, "agent_reported");
  assert.equal(listed.bindingSource, "agent_reported");
  assert.equal(snapshot.capabilities.some(item => item.capabilityId === "current_agent"), false);

  const comparison = compare(instance, [candidate(skill.capabilityId)], "text_rewrite");
  assert.equal(comparison.status, "ready");
  assert.equal(comparison.candidates[0].capabilityId, skill.capabilityId);
  assert.equal(comparison.candidates[0].fit, "direct");
  assert.equal(comparison.candidates[0].availabilitySource, "agent_reported");
  assert.equal(comparison.selection.capabilityId, skill.capabilityId);
  const selected = success(select(instance, comparison)).selection;
  assert.equal(selected.capabilityId, skill.capabilityId);
  denied(report(instance, selected.selectionId, "current_agent"));
  const reported = success(report(instance, selected.selectionId, skill.capabilityId)).report;
  assert.equal(reported.actualCapabilityId, skill.capabilityId);
  assert.equal(reported.matchesSelection, true);
  assert.equal(reported.outcome, "succeeded");
  assert.equal(reported.verification, "agent_reported");
  assert.deepEqual(list(instance), snapshot);
  assert.equal(list(instance).capabilities.find(item => item.capabilityId === skill.capabilityId).bindingSource,
    "agent_reported");
});

test("current_agent cannot be registered as a capability ID in any record shape", t => {
  const instance = advisor(t);
  refresh(instance, [record("retained_plugin")]);
  const before = list(instance);
  const comparison = compare(instance, [candidate("retained_plugin")]);
  const invalid = [
    record("current_agent", {
      kind: "skill", execution: { type: "agent_method", id: "current_agent" },
    }),
    ...["native", "plugin", "skill", "cli"].flatMap(kind =>
      ["host_tool", "local_cli"].map(type =>
        record("current_agent", { kind, execution: { type, id: "Sample:run" } }))),
    record("current_agent", {
      kind: "skill", availability: "not_checked", execution: { type: "instruction_only" },
    }),
  ];
  for (const entry of invalid) {
    for (const capabilities of [[entry], [record("replacement_plugin"), entry]]) {
      denied(invoke(instance, "refresh_capabilities", { capabilities }), 400);
      assert.deepEqual(list(instance), before);
      denied(invoke(instance, "compare_capabilities", {
        taskType: "custom_task", candidates: [candidate("current_agent")],
      }), 400);
      denied(report(instance, comparison.selection.selectionId, "current_agent"), 400);
    }
  }
  success(select(instance, comparison));
  success(report(instance, comparison.selection.selectionId, "retained_plugin"));
  assert.deepEqual(list(instance), before);
});

test("agent_method rejects non-Skills, invalid bindings and forged fields atomically", t => {
  const instance = advisor(t);
  const skill = record("review_skill", {
    kind: "skill", taskTypes: ["code_review"],
    execution: { type: "agent_method", id: "current_agent" },
  });
  refresh(instance, [skill]);
  const before = list(instance);
  const invalid = [
    ...["plugin", "cli", "native"].map(kind => ({ ...skill, kind })),
    ...[
      { type: "agent_method" },
      { type: "agent_method", id: null },
      { type: "agent_method", id: "" },
      { type: "agent_method", id: "other_agent" },
      { type: "agent_method", id: skill.capabilityId },
      ...["command", "path", "loaded", "verified"].map(key => ({
        type: "agent_method", id: "current_agent", [key]: MARKER,
      })),
    ].map(execution => ({ ...skill, execution })),
    ...["command", "path", "loaded", "verified"].map(key => ({ ...skill, [key]: MARKER })),
    { ...skill, execution: { type: "instruction_only" } },
  ];
  for (const entry of invalid) {
    denied(invoke(instance, "refresh_capabilities", {
      capabilities: [record("replacement_plugin"), entry],
    }), 400);
    assert.deepEqual(list(instance), before);
  }
  assert.equal(compare(instance, [candidate(skill.capabilityId)], "code_review").status, "ready");
});
