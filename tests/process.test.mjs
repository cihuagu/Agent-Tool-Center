import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

test("real server output, enabled file logs, OS listener and process shutdown are safe", { timeout: 30000 }, async t => {
  const marker = "sample-" + randomUUID();
  const child = fork(path.resolve("tests/fixtures/app-host.mjs"), [], {
    execArgv: [], silent: true, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PARENT_ONLY: marker }
  });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.connected) child.send({ method: "stop" });
    const timer = setTimeout(() => child.kill(), 2000);
    await exited; clearTimeout(timer);
  });
  const message = () => once(child, "message", { signal: AbortSignal.timeout(15000) }).then(r => r[0]);
  await message();
  const started = message(); child.send({ method: "boot", fixtureCase: { mode: "protocol", marker } });
  const info = await started;
  const base = "http://127.0.0.1:" + info.address.port;
  assert.equal(info.address.address, "127.0.0.1");
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const plan = await post("/api/plan", { task: "MCP fixture" }).then(r => r.json());
  if (!plan.candidates.some(c => c.toolId === "mcp.fixture.read")) { t.skip("MCPHub 不可用，进程实测未执行"); return; }
  const denied = await post("/api/execute", { planId: plan.planId, mode: "mixed", toolIds: [marker] });
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes(marker), false);
  assert.equal((await post("/api/execute", { planId: plan.planId, mode: "manual", toolIds: ["mcp.fixture.read"] })).status, 202);
  let history;
  for (let i = 0; i < 80; i++) {
    history = await fetch(base + "/api/history").then(r => r.json());
    if (history.events.some(e => e.status === "completed")) break;
    await delay(30);
  }
  assert.ok(history.events.some(e => e.errorCode === "MCP_TOOL_ERROR"));
  assert.equal(JSON.stringify(history).includes(marker), false);
  const cliPlan = await post("/api/plan", { task: "检查 Node.js 和 Git 版本" }).then(r => r.json());
  const cliResponse = await post("/api/execute", { planId: cliPlan.planId, mode: "manual", toolIds: ["runtime.node", "runtime.git"] });
  assert.equal(cliResponse.status, 202);
  const cliTask = await cliResponse.json();
  let cliEvents;
  for (let i = 0; i < 80; i++) {
    const latest = await fetch(base + "/api/history").then(r => r.json());
    cliEvents = latest.events.filter(e => e.taskId === cliTask.taskId);
    if (cliEvents.some(e => e.status === "completed")) break;
    await delay(30);
  }
  const cliResults = cliEvents.filter(e => e.status === "succeeded");
  assert.equal(cliResults.length, 2);
  assert.match(cliResults.find(e => e.toolId === "runtime.node").resultSummary, /^v\d/);
  assert.match(cliResults.find(e => e.toolId === "runtime.git").resultSummary, /^git version /);
  const wire = await readFile(path.join(info.runDirectory, "wire.ndjson"), "utf8");
  const fixturePid = JSON.parse(wire.split("\n")[0]).pid;
  const evidence = path.resolve(".cache/integration-evidence");
  await mkdir(evidence, { recursive: true });
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true });
    const rows = stdout.split(/\r?\n/).filter(row => /LISTENING/.test(row) && [child.pid, info.workerPid, fixturePid].includes(Number(row.trim().split(/\s+/).at(-1))));
    assert.equal(rows.length, 1, "only the product HTTP server listens");
    assert.ok(rows[0].includes("127.0.0.1:" + info.address.port));
    await writeFile(path.join(evidence, "netstat.txt"), rows.join("\n") + "\n");
  }
  child.send({ method: "stop" });
  assert.equal((await exited)[0], 0);
  for (const pid of [child.pid, info.workerPid, fixturePid]) assert.throws(() => process.kill(pid, 0));
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));
  assert.equal(output.includes(marker), false, "raw service/worker diagnostics must not escape");
  assert.equal(wire.includes(marker), false, "fixture log only contains method metadata");
  await writeFile(path.join(evidence, "process-output.txt"), output);
  await writeFile(path.join(evidence, "process-verification.json"), JSON.stringify({ ...info, fixturePid, exited: true,
    markerLeaks: 0, cliResults: cliResults.map(e => ({ toolId: e.toolId, resultSummary: e.resultSummary })),
    fileLogsChecked: ["wire.ndjson", "process-output.txt"], databaseLogging: "disabled / not tested" }, null, 2));
});
