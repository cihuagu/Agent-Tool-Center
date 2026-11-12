import { PolicyError } from "./policy.mjs";

export const PROJECT_GIT_TOOL = "project_git_status";
export const PROJECT_GIT_PURPOSE = "检查本项目 Git 工作区，返回变更数量摘要";
export const PROJECT_GIT_SCOPE = "仅 Agent Tool Center 项目；只读，不返回路径、文件名、内容或分支";

const REASONS = Object.freeze({
  denied: ["denied", "APPROVAL_DENIED", "你已拒绝本次检查"],
  expired: ["denied", "APPROVAL_EXPIRED", "本次确认已过期"],
  cancelled: ["cancelled", "APPROVAL_CANCELLED", "本次检查已取消"],
  full: ["denied", "APPROVAL_QUEUE_FULL", "待确认请求已满，请稍后重新请求"]
});

export function approvalFailure(state) {
  const [status, errorCode, error] = REASONS[state];
  return { status, errorCode, error };
}

export function createApprovals({ timeoutMs = 45000 } = {}) {
  const active = new Map();
  const recent = new Map();
  let closed = false;

  function remember(callId) {
    recent.set(callId, true);
    while (recent.size > 100) recent.delete(recent.keys().next().value);
  }

  function retire(ticket, state) {
    if (!["pending", "approved"].includes(ticket.state)) return;
    ticket.state = state;
    clearTimeout(ticket.timer);
    ticket.signal?.removeEventListener("abort", ticket.onAbort);
    active.delete(ticket.callId);
    remember(ticket.callId);
    ticket.wake();
  }

  function check(ticket) {
    if (!["pending", "approved"].includes(ticket.state)) return;
    if (closed || ticket.signal?.aborted) retire(ticket, "cancelled");
    else if (Date.now() >= ticket.deadline) retire(ticket, "expired");
  }

  return {
    request(callId, signal) {
      const ticket = {
        callId, signal, state: "pending", deadline: Date.now() + timeoutMs
      };
      ticket.ready = new Promise(resolve => { ticket.wake = resolve; });
      ticket.onAbort = () => retire(ticket, "cancelled");
      if (closed || signal?.aborted) {
        ticket.state = "cancelled";
        ticket.wake();
      } else if (active.size >= 20) {
        ticket.state = "full";
        ticket.wake();
      } else {
        active.set(callId, ticket);
        ticket.timer = setTimeout(() => retire(ticket, "expired"), timeoutMs);
        signal?.addEventListener("abort", ticket.onAbort, { once: true });
      }
      return ticket;
    },
    pending() {
      for (const ticket of active.values()) check(ticket);
      return [...active.values()].filter(ticket => ticket.state === "pending").map(ticket => ({
        callId: ticket.callId,
        tool: PROJECT_GIT_TOOL,
        purpose: PROJECT_GIT_PURPOSE,
        scope: PROJECT_GIT_SCOPE,
        readOnly: true,
        approvalState: "pending",
        expiresAt: new Date(ticket.deadline).toISOString()
      }));
    },
    decide(body) {
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 2 ||
          !Object.hasOwn(body, "callId") || !Object.hasOwn(body, "decision") ||
          typeof body.callId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.callId) ||
          !["approve", "deny"].includes(body.decision)) {
        throw new PolicyError("仅接受调用 ID 和本次允许或拒绝决定", "INVALID_APPROVAL_DECISION", 400);
      }
      const ticket = active.get(body.callId);
      if (ticket) check(ticket);
      if (!ticket && !recent.has(body.callId)) {
        throw new PolicyError("待确认请求不存在", "APPROVAL_NOT_FOUND", 404);
      }
      if (!ticket || ticket.state !== "pending") {
        throw new PolicyError("本次确认已处理或失效", "APPROVAL_CONFLICT", 409);
      }
      if (body.decision === "deny") retire(ticket, "denied");
      else {
        ticket.state = "approved";
        ticket.wake();
      }
      return { callId: ticket.callId, approvalState: ticket.state };
    },
    consumeAndRun(ticket, runner) {
      check(ticket);
      if (ticket.state !== "approved") {
        if (ticket.state === "pending") retire(ticket, "cancelled");
        return { executed: false, failure: approvalFailure(
          Object.hasOwn(REASONS, ticket.state) ? ticket.state : "cancelled"
        ) };
      }
      // No asynchronous boundary between the final checks, consumption and invocation.
      ticket.state = "consumed";
      clearTimeout(ticket.timer);
      ticket.signal?.removeEventListener("abort", ticket.onAbort);
      active.delete(ticket.callId);
      remember(ticket.callId);
      return { executed: true, result: runner() };
    },
    close() {
      closed = true;
      for (const ticket of active.values()) retire(ticket, "cancelled");
    }
  };
}
