import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const entry = fileURLToPath(new URL("../src/capability-mcp.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
const toolNames = ["compare_capabilities", "list_capabilities", "refresh_capabilities",
  "report_capability_use", "report_task_status", "select_capability"];
const availability = ["ready", "unavailable", "not_checked"];
const readyFiles = {
  taskType: "file_read",
  candidates: [
    { capabilityId: "local_cli", availability: "ready" },
    { capabilityId: "remote_desktop_commander", availability: "ready" }
  ]
};

async function bounded(promise, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP operation timed out")), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 1200;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(alive(pid), false, "owned stdio server must exit");
}

async function stopOwned(pid, close) {
  try {
    await bounded(Promise.resolve().then(close), 700);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await waitForExit(pid);
  }
}

async function sdkSession(t) {
  const { Client } = require("@modelcontextprotocol/sdk-v1/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk-v1/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd,
    stderr: "pipe"
  });
  const client = new Client(
    { name: "capability-advisor-integration-test", version: "1.0.0" },
    { capabilities: {} }
  );
  let ownedPid;
  t.after(async () => {
    ownedPid ??= transport.pid;
    await stopOwned(ownedPid, () => client.close());
  });
  await bounded(client.connect(transport), 2000);
  ownedPid = transport.pid;
  assert.ok(Number.isInteger(ownedPid), "SDK transport exposes its owned child PID");
  return { client, transport, pid: ownedPid };
}

function resultData(result) {
  assert.notEqual(result.isError, true, "tool call must succeed");
  assert.ok(result.structuredContent, "successful calls provide structuredContent");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.controlLevel, "advice_only");
  return result.structuredContent;
}

async function call(client, name, args) {
  return resultData(await bounded(client.callTool({ name, arguments: args })));
}

function candidate(comparison, capabilityId) {
  const found = comparison.candidates.find(item => item.capabilityId === capabilityId);
  assert.ok(found, `comparison contains ${capabilityId}`);
  assert.equal(typeof found.candidateId, "string");
  assert.ok(found.candidateId.length > 0);
  return found;
}

function selectionOf(data) {
  const selection = data.selection ?? data;
  assert.equal(typeof selection.selectionId, "string");
  assert.ok(selection.selectionId.length > 0);
  return selection;
}

async function rejected(client, name, args) {
  let response;
  let protocolRejection = false;
  try {
    response = await bounded(client.callTool({ name, arguments: args }));
  } catch (error) {
    assert.ok(
      [-32602, -32601].includes(error.code),
      "only deliberate invalid-params or unknown-method MCP errors are accepted"
    );
    protocolRejection = true;
  }
  if (!protocolRejection) {
    assert.equal(response.isError, true, "invalid calls must be rejected");
  }
  const listed = await bounded(client.listTools());
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), toolNames,
    "the same connection remains usable after rejection");
}

function rawSession(t) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const pid = child.pid;
  const lines = [];
  const invalidLines = [];
  const pending = new Map();
  let remainder = "";
  let sequence = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf("\n")) !== -1) {
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        assert.ok(
          typeof message.method === "string" ||
          (Object.hasOwn(message, "id") &&
            (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")))
        );
        lines.push(message);
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          request.resolve(message);
        }
      } catch {
        invalidLines.push(line);
      }
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const request of pending.values()) {
        request.reject(new Error("stdio server exited before responding"));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });
  // Keep a spawn failure observed even when initialization fails first.
  void exited.catch(() => {});
  t.after(() => stopOwned(pid, async () => {
    child.stdin.end();
    await exited;
  }));
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async function request(method, params) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ jsonrpc: "2.0", id, method, params });
    try {
      return await bounded(response);
    } finally {
      pending.delete(id);
    }
  }
  return {
    child, pid, exited, request,
    async initialize() {
      const response = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "raw-capability-test", version: "1.0.0" }
      });
      assert.ok(response.result, "raw initialize succeeds");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    assertProtocolOnly() {
      assert.deepEqual(invalidLines, [], "every stdout line must be a JSON-RPC message");
      assert.equal(remainder, "", "stdout must not contain trailing non-protocol output");
      assert.ok(lines.length >= 3, "initialize, list and call produced protocol responses");
      assert.doesNotMatch(stderr, /UNTRUSTED_CAPABILITY_PAYLOAD/);
    }
  };
}

test("official SDK lists exactly six strict tools and completes compare, replace, status and report", { timeout: 10000 }, async t => {
  const { client, pid } = await sdkSession(t);
  const { tools } = await bounded(client.listTools());
  assert.deepEqual(tools.map(tool => tool.name).sort(), toolNames);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: tool.name === "list_capabilities",
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: ["list_capabilities", "refresh_capabilities", "report_capability_use",
        "report_task_status"].includes(tool.name)
    });
  }
  const schema = tools.find(tool => tool.name === "compare_capabilities").inputSchema;
  assert.deepEqual([...schema.required].sort(), ["candidates", "taskType"]);
  for (const identifier of [
    schema.properties.taskType,
    schema.properties.candidates.items.properties.capabilityId
  ]) {
    assert.equal(identifier.type, "string");
    assert.equal(identifier.enum, undefined);
    assert.equal(identifier.pattern, "^[a-z][a-z0-9_]{1,63}$");
  }
  assert.equal(schema.properties.candidates.minItems, 1);
  assert.equal(schema.properties.candidates.maxItems, 4);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);
  assert.deepEqual([...schema.properties.candidates.items.properties.availability.enum].sort(),
    [...availability].sort());
  const refreshSchema = tools.find(tool => tool.name === "refresh_capabilities").inputSchema;
  assert.deepEqual(refreshSchema.required, ["capabilities"]);
  assert.equal(refreshSchema.properties.capabilities.maxItems, 256);
  assert.equal(refreshSchema.properties.capabilities.items.additionalProperties, false);
  assert.equal(refreshSchema.properties.capabilities.items.properties.execution.additionalProperties, false);
  const listSchema = tools.find(tool => tool.name === "list_capabilities").inputSchema;
  assert.equal(listSchema.properties.offset.maximum, 256);
  assert.equal(listSchema.properties.limit.maximum, 50);

  const comparison = await call(client, "compare_capabilities", readyFiles);
  assert.equal(typeof comparison.comparisonId, "string");
  assert.ok(comparison.comparisonId.length > 0);
  assert.equal(comparison.candidates.length, 2);
  const local = candidate(comparison, "local_cli");
  const remote = candidate(comparison, "remote_desktop_commander");
  assert.notEqual(local.candidateId, remote.candidateId);
  assert.equal(comparison.recommendedCandidateId, local.candidateId);
  const original = selectionOf(comparison);
  assert.equal(original.candidateId, local.candidateId);

  const selected = selectionOf(await call(client, "select_capability", {
    comparisonId: comparison.comparisonId,
    candidateId: remote.candidateId,
    reason: "user_requested"
  }));
  assert.notEqual(selected.selectionId, original.selectionId);
  assert.equal(selected.candidateId, remote.candidateId);
  assert.equal(selected.reason, "user_requested");
  const statusSchema = tools.find(tool => tool.name === "report_task_status").inputSchema;
  assert.deepEqual([...statusSchema.required].sort(), ["reason", "selectionId", "state"]);
  assert.deepEqual(Object.keys(statusSchema.properties).sort(),
    ["reason", "selectionId", "state", "taskLabel"]);
  const statusArgs = {
    selectionId: selected.selectionId,
    state: "running",
    reason: "none",
    taskLabel: "读取项目文件",
  };
  await rejected(client, "report_task_status", { ...statusArgs, verified: true });
  const statusData = await call(client, "report_task_status", statusArgs);
  const taskStatus = statusData.taskStatus;
  assert.deepEqual(Object.keys(statusData).sort(), ["controlLevel", "taskStatus"]);
  assert.deepEqual(Object.keys(taskStatus).sort(), [
    "capabilityId", "catalogRevision", "comparisonId", "reason", "recordedAt",
    "selectionId", "state", "statusId", "taskLabel", "verification",
  ]);
  assert.match(taskStatus.statusId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(taskStatus.selectionId, selected.selectionId);
  assert.equal(taskStatus.comparisonId, comparison.comparisonId);
  assert.equal(taskStatus.catalogRevision, comparison.catalogRevision);
  assert.equal(taskStatus.capabilityId, "remote_desktop_commander");
  assert.equal(taskStatus.state, "running");
  assert.equal(taskStatus.reason, "none");
  assert.equal(taskStatus.taskLabel, statusArgs.taskLabel);
  assert.equal(taskStatus.verification, "agent_reported");
  assert.equal(new Date(taskStatus.recordedAt).toISOString(), taskStatus.recordedAt);
  assert.deepEqual(await call(client, "report_task_status", statusArgs), statusData);
  const reportArgs = {
    selectionId: selected.selectionId,
    actualCapabilityId: "remote_desktop_commander",
    outcome: "succeeded",
    evidenceCallId: randomUUID()
  };
  const reported = await call(client, "report_capability_use", reportArgs);
  const report = reported.report ?? reported;
  assert.equal(report.selectionId, selected.selectionId);
  assert.equal(report.actualCapabilityId, "remote_desktop_commander");
  assert.equal(report.outcome, "succeeded");
  assert.equal(report.evidenceCallId, reportArgs.evidenceCallId);
  assert.equal(report.quality, "not_assessed");
  assert.equal(report.verification, "agent_reported");
  assert.deepEqual(await call(client, "report_capability_use", reportArgs), reported);
  await rejected(client, "report_capability_use", { ...reportArgs, outcome: "failed" });
  await client.close();
  await waitForExit(pid);
});

test("raw call envelopes reject unknown fields and forged verification without echoing input", { timeout: 10000 }, async t => {
  const raw = rawSession(t);
  await raw.initialize();
  assert.ok((await raw.request("tools/list", {})).result);
  const marker = "UNTRUSTED_CAPABILITY_PAYLOAD";
  const invalid = [
    { name: "list_capabilities", arguments: { verified: marker } },
    { name: "list_capabilities", arguments: {}, task: { ttl: 60000 } },
    { name: "list_capabilities", arguments: {}, verified: marker },
    { name: "refresh_capabilities", arguments: { capabilities: [], description: marker } },
    { name: "refresh_capabilities", arguments: { capabilities: [], verified: marker } },
    { name: "refresh_capabilities", arguments: { capabilities: [] }, task: { ttl: 60000 } },
    { name: "refresh_capabilities", arguments: { capabilities: [] }, verified: marker },
    { name: "refresh_capabilities", arguments: { capabilities: [{
      ...externalCapability(), verified: marker
    }] } },
    { name: marker, arguments: {} },
    { name: "compare_capabilities", arguments: { ...readyFiles, description: marker } },
    { name: "compare_capabilities", arguments: { ...readyFiles, verified: marker } },
    { name: "compare_capabilities", arguments: readyFiles, verified: marker },
    { name: "compare_capabilities", arguments: readyFiles, _meta: marker },
    { name: "compare_capabilities", arguments: {
      taskType: "file_read",
      candidates: [{ capabilityId: marker, availability: "ready" }]
    } },
    { name: "compare_capabilities", arguments: {
      taskType: "file_read",
      candidates: [readyFiles.candidates[0], readyFiles.candidates[0]]
    } },
    { name: "compare_capabilities", arguments: {
      taskType: "file_read",
      candidates: []
    } },
    { name: "compare_capabilities", arguments: {
      taskType: "file_read",
      candidates: [{ capabilityId: "local_cli", availability: "verified" }]
    } }
  ];
  for (const params of invalid) {
    const response = await raw.request("tools/call", params);
    assert.ok(response.error || response.result?.isError === true, "raw invalid params are rejected");
    assert.ok(!JSON.stringify(response).includes(marker), "rejected input is never echoed");
    const unchanged = resultData((await raw.request("tools/call", {
      name: "list_capabilities", arguments: {}
    })).result);
    assert.equal(unchanged.catalogRevision, 1);
    assert.equal(unchanged.total, 4);
  }
  const comparison = resultData((await raw.request("tools/call", {
    name: "compare_capabilities",
    arguments: readyFiles,
    _meta: { verified: true, userConfirmed: true, grant: true }
  })).result);
  const selectArgs = {
    comparisonId: comparison.comparisonId,
    candidateId: candidate(comparison, "remote_desktop_commander").candidateId,
    reason: "user_requested"
  };
  let fixedRejection;
  for (const params of [
    ...[{ verified: true }, { userConfirmed: true }, { description: marker }].map(extra => ({
      name: "select_capability",
      arguments: { ...selectArgs, ...extra }
    })),
    { name: "select_capability", arguments: selectArgs, task: { ttl: 60000 } },
    { name: "select_capability", arguments: selectArgs, verified: marker }
  ]) {
    const response = await raw.request("tools/call", params);
    assert.equal(response.result?.isError, true, "unsupported fields return a tool rejection");
    assert.equal(response.result.structuredContent?.controlLevel, "advice_only");
    assert.ok(!JSON.stringify(response).includes(marker), "rejected input is never echoed");
    fixedRejection ??= response.result;
    assert.deepEqual(response.result, fixedRejection, "unsupported fields use a fixed rejection");
  }
  const selected = selectionOf(resultData((await raw.request("tools/call", {
    name: "select_capability",
    arguments: selectArgs
  })).result));
  assert.equal(selected.comparisonId, comparison.comparisonId);
  assert.equal(selected.candidateId, selectArgs.candidateId);
  assert.equal(selected.capabilityId, "remote_desktop_commander");
  assert.equal(selected.selectionSource, "agent_reported_user_request");
  assert.notEqual(selected.selectionId, selectionOf(comparison).selectionId);
  const reportArgs = {
    selectionId: selectionOf(comparison).selectionId,
    actualCapabilityId: "local_cli",
    outcome: "succeeded"
  };
  for (const field of ["verified", "userConfirmed"]) {
    const response = await raw.request("tools/call", {
      name: "report_capability_use",
      arguments: { ...reportArgs, [field]: marker }
    });
    assert.ok(response.error || response.result?.isError === true);
    assert.ok(!JSON.stringify(response).includes(marker));
  }
  const data = resultData((await raw.request("tools/call", {
    name: "report_capability_use",
    arguments: reportArgs,
    _meta: { verified: true, userConfirmed: true, grant: true }
  })).result);
  assert.equal((data.report ?? data).verification, "agent_reported");
  raw.child.stdin.end();
  assert.equal((await bounded(raw.exited)).code, 0);
  raw.assertProtocolOnly();
});

test("independent SDK stdio sessions reject foreign comparison, candidate and selection IDs", { timeout: 10000 }, async t => {
  const first = await sdkSession(t);
  const second = await sdkSession(t);
  assert.notEqual(first.pid, second.pid);
  const a = await call(first.client, "compare_capabilities", readyFiles);
  const b = await call(second.client, "compare_capabilities", readyFiles);
  assert.notEqual(a.comparisonId, b.comparisonId);
  await rejected(second.client, "select_capability", {
    comparisonId: a.comparisonId,
    candidateId: candidate(a, "local_cli").candidateId,
    reason: "agent_auto"
  });
  await rejected(second.client, "select_capability", {
    comparisonId: b.comparisonId,
    candidateId: candidate(a, "local_cli").candidateId,
    reason: "agent_auto"
  });
  await rejected(second.client, "report_capability_use", {
    selectionId: selectionOf(a).selectionId,
    actualCapabilityId: "local_cli",
    outcome: "succeeded"
  });
  await rejected(second.client, "select_capability", {
    comparisonId: randomUUID(),
    candidateId: randomUUID(),
    reason: "user_requested"
  });
  await rejected(second.client, "report_capability_use", {
    selectionId: randomUUID(),
    actualCapabilityId: null,
    outcome: "not_run"
  });
  const valid = await call(first.client, "report_capability_use", {
    selectionId: selectionOf(a).selectionId,
    actualCapabilityId: null,
    outcome: "not_run"
  });
  assert.equal((valid.report ?? valid).verification, "agent_reported");
});

test("file readiness cannot establish GUI availability and unavailable candidates cannot be selected", { timeout: 10000 }, async t => {
  const { client } = await sdkSession(t);
  await call(client, "compare_capabilities", {
    taskType: "file_read",
    candidates: [{ capabilityId: "remote_desktop_commander", availability: "ready" }]
  });
  const gui = await call(client, "compare_capabilities", {
    taskType: "desktop_ui",
    candidates: [
      { capabilityId: "remote_desktop_commander", availability: "ready" },
      { capabilityId: "computer_use", availability: "not_checked" },
      { capabilityId: "agent_desktop", availability: "unavailable" }
    ]
  });
  assert.equal(gui.status, "needs_check");
  assert.ok(gui.recommendedCandidateId == null);
  assert.ok(gui.selection == null);
  for (const item of gui.candidates) {
    await rejected(client, "select_capability", {
      comparisonId: gui.comparisonId,
      candidateId: item.candidateId,
      reason: "user_requested"
    });
  }
  const readyGui = await call(client, "compare_capabilities", {
    taskType: "desktop_ui",
    candidates: [
      { capabilityId: "agent_desktop", availability: "ready" },
      { capabilityId: "computer_use", availability: "ready" }
    ]
  });
  assert.equal(readyGui.recommendedCandidateId,
    candidate(readyGui, "computer_use").candidateId);
});

test("SDK initialization and calls finish on stdin EOF with strictly protocol stdout", { timeout: 10000 }, async t => {
  const raw = rawSession(t);
  await raw.initialize();
  const listed = await raw.request("tools/list", {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), toolNames);
  resultData((await raw.request("tools/call", {
    name: "compare_capabilities",
    arguments: readyFiles
  })).result);
  raw.child.stdin.end();
  assert.equal((await bounded(raw.exited)).code, 0);
  await waitForExit(raw.pid);
  raw.assertProtocolOnly();
});

test("an initialized owned stdio child exits when signalled", { timeout: 10000 }, async t => {
  const raw = rawSession(t);
  await raw.initialize();
  assert.ok(alive(raw.pid));
  assert.equal(raw.child.kill("SIGTERM"), true);
  await bounded(raw.exited);
  await waitForExit(raw.pid);
});

function externalCapability(capabilityId = "sdk_plugin", extra = {}) {
  return {
    capabilityId, name: "SDK 示例插件", kind: "plugin", sourceId: "Sdk:plugin",
    taskTypes: ["sdk_new_task"], availability: "ready",
    execution: { type: "host_tool", id: "Sdk:read" }, ...extra
  };
}

test("official SDK refreshes new IDs and tasks, binds skills, and preserves old reports after refresh", { timeout: 10000 }, async t => {
  const { client } = await sdkSession(t);
  const initial = await call(client, "list_capabilities", {});
  assert.equal(initial.catalogRevision, 1);
  assert.equal(initial.total, 4);
  const entries = [
    externalCapability(),
    externalCapability("sdk_guide", {
      kind: "skill", availability: "not_checked", execution: { type: "instruction_only" }
    }),
    externalCapability("sdk_skill", {
      kind: "skill", execution: { type: "local_cli", id: "Sdk:skill" }
    })
  ];
  const refreshed = await call(client, "refresh_capabilities", { capabilities: entries });
  assert.equal(refreshed.catalogRevision, 2);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.verification, "agent_reported");
  const page = await call(client, "list_capabilities", { limit: 3 });
  const rest = await call(client, "list_capabilities", { offset: page.nextOffset, limit: 50 });
  const members = [...page.capabilities, ...rest.capabilities];
  assert.equal(members.length, 7);
  assert.equal(new Set(members.map(item => item.capabilityId)).size, 7);
  assert.equal(rest.nextOffset, null);
  for (const entry of entries) {
    const listed = members.find(item => item.capabilityId === entry.capabilityId);
    assert.ok(listed);
    assert.equal(listed.catalogSource, "agent_reported");
    assert.equal(listed.bindingSource, "agent_reported");
    assert.equal(listed.availabilitySource, "agent_reported");
    assert.deepEqual(listed.execution, entry.execution);
  }
  const comparison = await call(client, "compare_capabilities", {
    taskType: "sdk_new_task",
    candidates: [{ capabilityId: "sdk_plugin", availability: "ready" }]
  });
  assert.equal(selectionOf(comparison).capabilityId, "sdk_plugin");
  assert.equal(comparison.catalogRevision, 2);
  const selected = selectionOf(await call(client, "select_capability", {
    comparisonId: comparison.comparisonId,
    candidateId: candidate(comparison, "sdk_plugin").candidateId,
    reason: "user_requested"
  }));
  const guide = await call(client, "compare_capabilities", {
    taskType: "sdk_new_task",
    candidates: [{ capabilityId: "sdk_guide", availability: "not_checked" }]
  });
  assert.equal(guide.status, "needs_check");
  assert.equal(guide.selection, null);
  await rejected(client, "compare_capabilities", {
    taskType: "sdk_new_task",
    candidates: [{ capabilityId: "sdk_guide", availability: "ready" }]
  });
  const skill = await call(client, "compare_capabilities", {
    taskType: "sdk_new_task",
    candidates: [{ capabilityId: "sdk_skill", availability: "ready" }]
  });
  await rejected(client, "report_capability_use", {
    selectionId: selectionOf(skill).selectionId, actualCapabilityId: "sdk_guide", outcome: "succeeded"
  });
  const skillReport = await call(client, "report_capability_use", {
    selectionId: selectionOf(skill).selectionId, actualCapabilityId: "sdk_skill", outcome: "succeeded"
  });
  assert.equal(skillReport.report.verification, "agent_reported");
  await call(client, "refresh_capabilities", { capabilities: [] });
  const stale = await bounded(client.callTool({
    name: "select_capability",
    arguments: {
      comparisonId: comparison.comparisonId,
      candidateId: candidate(comparison, "sdk_plugin").candidateId,
      reason: "user_requested"
    }
  }));
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.status, 409);
  const reportArgs = {
    selectionId: selected.selectionId, actualCapabilityId: "sdk_plugin", outcome: "succeeded"
  };
  const reported = await call(client, "report_capability_use", reportArgs);
  assert.equal(reported.report.catalogRevision, 2);
  assert.equal(reported.report.matchesSelection, true);
  assert.deepEqual(await call(client, "report_capability_use", reportArgs), reported);
});

test("official SDK catalogs are isolated between real stdio processes", { timeout: 10000 }, async t => {
  const first = await sdkSession(t);
  const second = await sdkSession(t);
  await call(first.client, "refresh_capabilities", { capabilities: [externalCapability()] });
  assert.equal((await call(first.client, "list_capabilities", {})).total, 5);
  const untouched = await call(second.client, "list_capabilities", {});
  assert.equal(untouched.total, 4);
  assert.equal(untouched.catalogRevision, 1);
  await rejected(second.client, "compare_capabilities", {
    taskType: "sdk_new_task",
    candidates: [{ capabilityId: "sdk_plugin", availability: "ready" }]
  });
  await call(second.client, "refresh_capabilities", {
    capabilities: [externalCapability("second_plugin")]
  });
  const retained = await call(first.client, "list_capabilities", {});
  assert.ok(retained.capabilities.some(item => item.capabilityId === "sdk_plugin"));
  assert.equal(retained.capabilities.some(item => item.capabilityId === "second_plugin"), false);
});

test("unresolvable SDK exits with fixed stderr and creates no installation", { timeout: 10000 }, async t => {
  const cache = path.resolve(cwd, ".cache");
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(path.join(cache, "oss-sdk-missing-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(scratch)), cache);
    assert.ok(path.basename(scratch).startsWith("oss-sdk-missing-"));
    await rm(scratch, { recursive: true, force: true });
  });
  const source = path.join(scratch, "src");
  await mkdir(source);
  const unavailable = path.join(scratch, "node_modules", "@modelcontextprotocol", "sdk-v1");
  await mkdir(unavailable, { recursive: true });
  await writeFile(path.join(unavailable, "package.json"), '{"exports":{}}');
  await Promise.all([
    copyFile(entry, path.join(source, "capability-mcp.mjs")),
    copyFile(path.join(cwd, "src", "capability-advisor.mjs"),
      path.join(source, "capability-advisor.mjs")),
    copyFile(path.join(cwd, "src", "capabilities.json"),
      path.join(source, "capabilities.json"))
  ]);
  const child = spawnSync(process.execPath, [path.join(source, "capability-mcp.mjs")], {
    cwd: scratch,
    env: { ...process.env, NODE_PATH: "" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr,
    "项目内官方 MCP SDK 缺失；未自动安装，请查阅聊天内能力选择助手文档。\n");
  assert.deepEqual((await readdir(scratch)).sort(), ["node_modules", "src"], "no installer files were created");
  assert.deepEqual(await readdir(unavailable), ["package.json"], "unavailable fixture was not installed over");
  assert.deepEqual((await readdir(source)).sort(),
    ["capabilities.json", "capability-advisor.mjs", "capability-mcp.mjs"]);
});

for (const staleCache of [false, true]) test(`isolated project uses root SDK ${staleCache ? "with an unresolvable old cache" : "without an SDK cache"}`, { timeout: 10000 }, async t => {
  const scratch = await mkdtemp(path.join(cwd, ".cache", "oss-sdk-root-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, "src");
  const stale = path.join(scratch, ".cache", "mcphub-eval", "node_modules", "@modelcontextprotocol", "sdk-v1");
  await mkdir(source);
  if (staleCache) {
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "package.json"), '{"exports":{}}');
  }
  await symlink(path.join(cwd, "node_modules"), path.join(scratch, "node_modules"), "junction");
  await Promise.all([
    copyFile(entry, path.join(source, "capability-mcp.mjs")),
    copyFile(path.join(cwd, "src", "capability-advisor.mjs"), path.join(source, "capability-advisor.mjs")),
    copyFile(path.join(cwd, "src", "capabilities.json"), path.join(source, "capabilities.json")),
    copyFile(path.join(cwd, "package.json"), path.join(scratch, "package.json"))
  ]);
  const child = spawnSync(process.execPath, [path.join(source, "capability-mcp.mjs")], {
    cwd: scratch, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", windowsHide: true,
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" }
    } }) + "\n", timeout: 5000
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).id, 1);
});

test("official SDK supports agent_method Skills without converting their identity or provenance", { timeout: 10000 }, async t => {
  const { client } = await sdkSession(t);
  const skill = externalCapability("sdk_method_skill", {
    kind: "skill", taskTypes: ["text_rewrite"],
    execution: { type: "agent_method", id: "current_agent" }
  });
  const refreshed = await call(client, "refresh_capabilities", { capabilities: [skill] });
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.verification, "agent_reported");
  const snapshot = await call(client, "list_capabilities", {});
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

  for (const invalid of [
    { ...skill, kind: "plugin" },
    { ...skill, execution: { type: "agent_method", id: "other_agent" } }
  ]) {
    await rejected(client, "refresh_capabilities", {
      capabilities: [externalCapability("sdk_replacement"), invalid]
    });
    assert.deepEqual(await call(client, "list_capabilities", {}), snapshot);
  }

  const comparison = await call(client, "compare_capabilities", {
    taskType: "text_rewrite",
    candidates: [{ capabilityId: skill.capabilityId, availability: "ready" }]
  });
  assert.equal(comparison.status, "ready");
  assert.equal(candidate(comparison, skill.capabilityId).fit, "direct");
  assert.equal(candidate(comparison, skill.capabilityId).availabilitySource, "agent_reported");
  assert.equal(selectionOf(comparison).capabilityId, skill.capabilityId);
  const selected = selectionOf(await call(client, "select_capability", {
    comparisonId: comparison.comparisonId,
    candidateId: candidate(comparison, skill.capabilityId).candidateId,
    reason: "user_requested"
  }));
  assert.equal(selected.capabilityId, skill.capabilityId);
  await rejected(client, "report_capability_use", {
    selectionId: selected.selectionId,
    actualCapabilityId: "current_agent",
    outcome: "succeeded"
  });
  const reported = await call(client, "report_capability_use", {
    selectionId: selected.selectionId,
    actualCapabilityId: skill.capabilityId,
    outcome: "succeeded"
  });
  assert.equal(reported.report.actualCapabilityId, skill.capabilityId);
  assert.equal(reported.report.matchesSelection, true);
  assert.equal(reported.report.outcome, "succeeded");
  assert.equal(reported.report.verification, "agent_reported");
  assert.deepEqual(await call(client, "list_capabilities", {}), snapshot);
});
