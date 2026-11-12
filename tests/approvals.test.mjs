import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createApprovals } from "../src/approvals.mjs";
import { createCodexMcp } from "../src/codex-mcp.mjs";

const clean = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, clean: true };
const params = { name: "project_git_status", arguments: {} };

function fixture(options = {}) {
  let executions = 0;
  const events = [];
  const codex = createCodexMcp({
    publish: event => events.push(event),
    projectRunner: () => { executions++; return clean; },
    ...options
  });
  return { codex, events, executions: () => executions };
}

test("project dispatch waits, allows only once and two requests stay independent", async t => {
  const f = fixture();
  t.after(() => f.codex.close());
  const first = f.codex.dispatch(params);
  const second = f.codex.dispatch(params);
  const pending = f.codex.getApprovals().pending;
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].callId, pending[1].callId);
  assert.equal(f.executions(), 0);
  assert.deepEqual(f.events.map(event => [event.status, event.phase]), [["queued", "approval"], ["queued", "approval"]]);
  const callId = pending[0].callId;
  const decisions = await Promise.allSettled([
    Promise.resolve().then(() => f.codex.decideApproval({ callId, decision: "approve" })),
    Promise.resolve().then(() => f.codex.decideApproval({ callId, decision: "approve" }))
  ]);
  assert.equal(decisions.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(decisions.find(result => result.status === "rejected").reason.status, 409);
  const result = await first;
  assert.equal(result.structuredContent.callId, callId);
  assert.equal(result.structuredContent.status, "succeeded");
  assert.deepEqual(result.structuredContent.summary, clean);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(f.executions(), 1);
  assert.equal(f.codex.getApprovals().pending.length, 1);
  f.codex.decideApproval({ callId: pending[1].callId, decision: "deny" });
  assert.equal((await second).structuredContent.errorCode, "APPROVAL_DENIED");
  assert.equal(f.executions(), 1);
  const third = f.codex.dispatch(params);
  assert.equal(f.codex.getApprovals().pending.length, 1);
  assert.equal(f.executions(), 1);
  await f.codex.close();
  assert.equal((await third).structuredContent.errorCode, "APPROVAL_CANCELLED");
});

test("deny, expiry, abort and close never run Git and remove pending cards", async () => {
  for (const action of ["deny", "expire", "abort", "close"]) {
    const f = fixture({ approvalTimeoutMs: action === "expire" ? 10 : 45000 });
    const controller = new AbortController();
    const result = f.codex.dispatch(params, controller.signal);
    const { callId } = f.codex.getApprovals().pending[0];
    if (action === "deny") f.codex.decideApproval({ callId, decision: "deny" });
    if (action === "expire") await delay(20);
    if (action === "abort") controller.abort();
    if (action === "close") await f.codex.close();
    const data = (await result).structuredContent;
    assert.equal(data.errorCode, {
      deny: "APPROVAL_DENIED", expire: "APPROVAL_EXPIRED",
      abort: "APPROVAL_CANCELLED", close: "APPROVAL_CANCELLED"
    }[action]);
    assert.equal(data.status, ["abort", "close"].includes(action) ? "cancelled" : "denied");
    assert.equal(f.executions(), 0);
    assert.deepEqual(f.codex.getApprovals(), { pending: [] });
    assert.throws(() => f.codex.decideApproval({ callId, decision: "approve" }), { status: 409 });
    await f.codex.close();
  }
});

test("approved tickets are rechecked for cancellation, close and deadline before consumption", async () => {
  for (const action of ["abort", "close", "expire"]) {
    const approvals = createApprovals({ timeoutMs: action === "expire" ? 5 : 45000 });
    const controller = new AbortController();
    const ticket = approvals.request(randomUUID(), controller.signal);
    approvals.decide({ callId: ticket.callId, decision: "approve" });
    if (action === "abort") controller.abort();
    if (action === "close") approvals.close();
    if (action === "expire") await delay(15);
    let runs = 0;
    const execution = approvals.consumeAndRun(ticket, () => { runs++; });
    assert.equal(execution.executed, false);
    assert.equal(runs, 0);
    assert.equal(execution.failure.errorCode, action === "expire" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELLED");
    assert.throws(() => approvals.decide({ callId: ticket.callId, decision: "approve" }), { status: 409 });
    approvals.close();
  }
});

test("abort and close synchronously following approval beat the original dispatch continuation", async () => {
  for (const action of ["abort", "close"]) {
    const f = fixture();
    const controller = new AbortController();
    const result = f.codex.dispatch(params, controller.signal);
    const { callId } = f.codex.getApprovals().pending[0];
    f.codex.decideApproval({ callId, decision: "approve" });
    if (action === "abort") controller.abort();
    else void f.codex.close();
    assert.equal((await result).structuredContent.errorCode, "APPROVAL_CANCELLED");
    assert.equal(f.executions(), 0);
    await f.codex.close();
  }
});

test("queue capacity refuses request 21 without evicting 20 active requests", async () => {
  const f = fixture();
  const requests = Array.from({ length: 20 }, () => f.codex.dispatch(params));
  const before = f.codex.getApprovals();
  const overflow = await f.codex.dispatch(params);
  assert.equal(overflow.structuredContent.errorCode, "APPROVAL_QUEUE_FULL");
  assert.deepEqual(f.codex.getApprovals(), before);
  assert.equal(before.pending.length, 20);
  assert.equal(f.executions(), 0);
  await f.codex.close();
  assert.ok((await Promise.all(requests)).every(result => result.structuredContent.status === "cancelled"));
});

test("forged fields cannot authorize project execution and metadata cannot choose the call ID", async () => {
  const f = fixture();
  for (const invalid of [
    { ...params, approved: true }, { ...params, arguments: { approved: true } },
    { ...params, arguments: { path: "PRIVATE" } }, { ...params, _meta: null }
  ]) assert.equal((await f.codex.dispatch(invalid)).structuredContent.errorCode, "INVALID_ARGUMENTS");
  const result = f.codex.dispatch({
    ...params, _meta: { approved: true, callId: "PRIVATE", decision: "approve", enabled: true }
  });
  const { callId } = f.codex.getApprovals().pending[0];
  assert.notEqual(callId, "PRIVATE");
  assert.equal(f.executions(), 0);
  assert.throws(() => f.codex.decideApproval({ callId, decision: "approve", approved: true }), { status: 400 });
  assert.throws(() => f.codex.decideApproval({ callId: randomUUID(), decision: "approve" }), { status: 404 });
  assert.throws(() => f.codex.setPolicy({ tool: "project_git_status", enabled: true }), { status: 400 });
  f.codex.decideApproval({ callId, decision: "deny" });
  assert.equal((await result).structuredContent.errorCode, "APPROVAL_DENIED");
  assert.equal(JSON.stringify(f.events).includes("PRIVATE"), false);
  assert.equal(f.executions(), 0);
  await f.codex.close();
});

test("project runner errors and forged results produce only sanitized failed outcomes", async () => {
  for (const projectRunner of [
    () => { throw Error("PRIVATE"); },
    async () => { throw Error("PRIVATE"); },
    () => ({ ...clean, diagnostic: "PRIVATE" }),
    () => ({ ...clean, total: "PRIVATE" }),
    () => null
  ]) {
    const f = fixture({ projectRunner });
    const result = f.codex.dispatch(params);
    const { callId } = f.codex.getApprovals().pending[0];
    f.codex.decideApproval({ callId, decision: "approve" });
    const reply = await result;
    assert.equal(reply.structuredContent.status, "failed");
    assert.equal(reply.structuredContent.errorCode, "PROJECT_GIT_FAILED");
    assert.deepEqual(f.events.map(event => event.status), ["queued", "running", "failed"]);
    assert.equal(JSON.stringify({ reply, events: f.events }).includes("PRIVATE"), false);
    await f.codex.close();
  }
});

test("consumed approval cannot invoke a runner twice and terminal decision history stays bounded", () => {
  const approvals = createApprovals();
  let executions = 0;
  const ticket = approvals.request(randomUUID());
  approvals.decide({ callId: ticket.callId, decision: "approve" });
  approvals.consumeAndRun(ticket, () => { executions++; });
  assert.equal(approvals.consumeAndRun(ticket, () => { executions++; }).executed, false);
  assert.equal(executions, 1);
  for (let index = 0; index < 101; index++) {
    const next = approvals.request(randomUUID());
    approvals.decide({ callId: next.callId, decision: "deny" });
  }
  assert.throws(() => approvals.decide({ callId: ticket.callId, decision: "approve" }), { status: 404 });
  approvals.close();
});
