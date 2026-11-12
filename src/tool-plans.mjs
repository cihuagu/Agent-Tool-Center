import { randomUUID } from "node:crypto";
import { createApprovals, approvalFailure } from "./approvals.mjs";
import { PolicyError } from "./policy.mjs";

export const TOOL_PLAN_TOOL = "execute_tool_plan";
export const TOOL_PLAN_NAMES = Object.freeze([
  "git_version", "node_version", "project_git_status"
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFINITIONS = Object.freeze([
  { tool: "git_version", toolId: "runtime.git", label: "Git 版本" },
  { tool: "node_version", toolId: "runtime.node", label: "Node.js 版本" },
  { tool: "project_git_status", toolId: "project_git_status", label: "本项目 Git 工作区摘要" }
]);
const CANCELLED = Object.freeze({
  status: "cancelled", errorCode: "PLAN_CANCELLED",
  error: "计划已请求停止；已启动的步骤保留真实结果，后续步骤不再执行"
});
const DISABLED = Object.freeze({
  status: "denied", errorCode: "CODEX_DISABLED",
  error: "计划所需的 Codex 版本查询授权已禁用"
});

export function validToolPlanArguments(args) {
  return !!args && typeof args === "object" && !Array.isArray(args) &&
    Object.keys(args).length === 1 && Object.hasOwn(args, "steps") &&
    Array.isArray(args.steps) && args.steps.length >= 2 && args.steps.length <= 3 &&
    args.steps.every(name => typeof name === "string" && TOOL_PLAN_NAMES.includes(name)) &&
    new Set(args.steps).size === args.steps.length;
}

export function createToolPlans({ publish, isEnabled, execute, timeoutMs = 30000 }) {
  const approvals = createApprovals({ timeoutMs });
  const active = new Map();
  const terminal = new Map();
  let closed = false;

  function snapshot(plan) {
    return structuredClone({
      planId: plan.planId,
      callId: plan.planId,
      taskId: plan.planId,
      source: "codex",
      toolId: TOOL_PLAN_TOOL,
      purpose: "按冻结顺序查询本机工具版本及本项目 Git 工作区摘要",
      scope: "仅所列固定只读步骤；不接受命令或路径，不返回文件名、内容或原始诊断",
      readOnly: true,
      status: plan.status,
      approvalState: plan.ticket?.state ?? "cancelled",
      expiresAt: plan.expiresAt,
      stopRequested: plan.stopRequested,
      ...(plan.stopReason ? { stopReason: plan.stopReason.errorCode } : {}),
      ...plan.details,
      selectionFinalized: plan.selectionFinalized,
      proposedSteps: plan.proposedSteps,
      excludedSteps: plan.excludedSteps,
      steps: plan.steps.map(step => ({
        ...step,
        grantEnabled: step.tool === "project_git_status" ? null : isEnabled(step.tool)
      }))
    });
  }

  function emit(plan, step, status, details = {}) {
    publish({
      planId: plan.planId, taskId: plan.planId, source: "codex",
      callId: step?.callId ?? plan.planId,
      toolId: step?.toolId ?? TOOL_PLAN_TOOL,
      ...(step ? {
        stepId: step.stepId, stepIndex: step.stepIndex, tool: step.tool,
        ...(step.executionIndex !== undefined ? { executionIndex: step.executionIndex } : {})
      } : {}),
      status, ...details
    });
  }

  function stop(plan, reason = CANCELLED) {
    if (!active.has(plan.planId) || plan.stopRequested) return;
    plan.stopRequested = true;
    plan.stopReason = reason;
    // This controller belongs to the plan and remains useful after consumption.
    plan.controller.abort();
  }

  function finish(plan, status, details = {}) {
    for (const step of plan.steps) {
      if (step.status !== "planned") continue;
      step.status = "cancelled";
      step.errorCode = "PLAN_NOT_RUN";
      step.error = "此步骤未启动；计划已停止";
      emit(plan, step, step.status, {
        errorCode: step.errorCode, error: step.error
      });
    }
    plan.status = status;
    plan.details = details;
    active.delete(plan.planId);
    terminal.set(plan.planId, plan);
    while (terminal.size > 50) terminal.delete(terminal.keys().next().value);
    emit(plan, null, status, details);
    const data = snapshot(plan);
    return {
      isError: status !== "succeeded",
      structuredContent: data,
      content: [{ type: "text", text: JSON.stringify(data) }]
    };
  }

  function missingGrant(plan) {
    return plan.steps.some(step =>
      step.tool !== "project_git_status" && !isEnabled(step.tool));
  }

  async function runSteps(plan) {
    plan.status = "running";
    emit(plan, null, "running");
    for (const step of plan.steps) {
      if (plan.stopRequested) return plan.stopReason;
      if (step.tool !== "project_git_status" && !isEnabled(step.tool)) {
        stop(plan, DISABLED);
        return plan.stopReason;
      }
      const started = Date.now();
      step.status = "running";
      emit(plan, step, "running");
      try {
        // No await between the live authorization check and fixed invocation.
        const result = await execute(step.tool);
        Object.assign(step, result, {
          status: "succeeded", elapsedMs: Date.now() - started
        });
        emit(plan, step, "succeeded", {
          ...result, elapsedMs: step.elapsedMs
        });
      } catch {
        const project = step.tool === "project_git_status";
        const failure = {
          errorCode: project ? "PROJECT_GIT_FAILED" : "TOOL_FAILED",
          error: project
            ? "本项目 Git 工作区检查失败；未记录原始诊断内容"
            : "版本查询失败；未记录原始诊断内容"
        };
        Object.assign(step, failure, {
          status: "failed", elapsedMs: Date.now() - started
        });
        emit(plan, step, "failed", {
          ...failure, elapsedMs: step.elapsedMs
        });
        return { status: "failed", ...failure };
      }
    }
    // A stop request cannot erase the real result of an already-started final step.
    return { status: "succeeded" };
  }

  function getPlan(body, decision) {
    const keys = decision ? ["planId", "decision"] : ["planId"];
    if (decision && body?.decision === "approve" && Object.hasOwn(body, "steps")) {
      keys.push("steps");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== keys.length ||
        keys.some(key => !Object.hasOwn(body, key)) ||
        typeof body.planId !== "string" || !UUID.test(body.planId) ||
        (decision && !["approve", "deny"].includes(body.decision))) {
      throw new PolicyError("仅接受计划 ID 和规定的计划操作", "INVALID_PLAN_INPUT", 400);
    }
    const plan = active.get(body.planId) ?? terminal.get(body.planId);
    if (!plan) throw new PolicyError("计划不存在", "PLAN_NOT_FOUND", 404);
    if (!active.has(body.planId) || plan.stopRequested) {
      throw new PolicyError("计划已处理或停止", "PLAN_CONFLICT", 409);
    }
    return plan;
  }

  return {
    getPlans: () => ({
      plans: [...active.values(), ...terminal.values()].map(snapshot)
    }),
    decidePlan(body) {
      const plan = getPlan(body, true);
      const names = Object.hasOwn(body, "steps") ? body.steps : plan.proposedSteps.map(step => step.tool);
      if (!Array.isArray(names) || names.length < 1 ||
          names.length > plan.proposedSteps.length ||
          !Array.from(names).every(name => typeof name === "string" &&
            plan.proposedSteps.some(step => step.tool === name)) ||
          new Set(names).size !== names.length) {
        throw new PolicyError("仅接受原提案中不重复的非空工具选择", "INVALID_PLAN_INPUT", 400);
      }
      const selected = names.map((name, index) => ({
        ...plan.proposedSteps.find(step => step.tool === name),
        status: "planned", executionIndex: index + 1
      }));
      const excluded = plan.proposedSteps
        .filter(step => !names.includes(step.tool))
        .map(step => ({
          ...step, reasonCode: "PLAN_NOT_SELECTED", reason: "用户未选择，本次不执行"
        }));
      if (plan.status !== "queued") {
        throw new PolicyError("计划已处理", "PLAN_CONFLICT", 409);
      }
      const result = approvals.decide({
        callId: plan.planId, decision: body.decision
      });
      if (body.decision === "approve") {
        plan.steps = Object.freeze(selected);
        plan.excludedSteps = Object.freeze(excluded);
        plan.selectionFinalized = true;
        emit(plan, null, "queued", {
          phase: "approved-selection", approvalState: "approved",
          approvedOrder: selected.map(step => step.tool),
          selectedStepIds: selected.map(step => step.stepId),
          unselectedStepIds: excluded.map(step => step.stepId)
        });
      }
      return { planId: plan.planId, approvalState: result.approvalState };
    },
    cancelPlan(body) {
      const plan = getPlan(body, false);
      if (plan.status === "queued" && !["pending", "approved"].includes(plan.ticket.state)) {
        throw new PolicyError("本次确认已处理或失效", "PLAN_CONFLICT", 409);
      }
      stop(plan);
      return { planId: plan.planId, stopRequested: true };
    },
    revoke(tool) {
      for (const plan of active.values()) {
        if (plan.selectionFinalized && plan.steps.some(step => step.tool === tool &&
            ["planned", "running"].includes(step.status))) stop(plan, DISABLED);
      }
    },
    async dispatch(planId, names, signal) {
      const plan = {
        planId, status: "queued", stopRequested: false, details: {},
        selectionFinalized: false, excludedSteps: Object.freeze([]),
        controller: new AbortController(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        steps: Object.freeze(names.map((name, index) => ({
          ...DEFINITIONS.find(item => item.tool === name),
          stepId: randomUUID(), callId: randomUUID(),
          stepIndex: index + 1, status: "planned"
        })))
      };
      plan.proposedSteps = Object.freeze(plan.steps.map(
        ({ tool, toolId, label, stepId, callId, stepIndex }) =>
          Object.freeze({ tool, toolId, label, stepId, callId, stepIndex })
      ));
      if (closed || active.size >= 20) {
        const failure = closed ? CANCELLED : approvalFailure("full");
        const { status, ...details } = failure;
        return finish(plan, status, details);
      }
      active.set(planId, plan);
      const onAbort = () => stop(plan);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) stop(plan);
      plan.ticket = approvals.request(planId, plan.controller.signal);
      plan.expiresAt = new Date(plan.ticket.deadline).toISOString();
      // The complete frozen order is available before any executor is invoked.
      emit(plan, null, "queued", {
        phase: "approval", approvalState: plan.ticket.state,
        expiresAt: plan.expiresAt
      });
      for (const step of plan.steps) {
        emit(plan, step, "planned", { phase: "proposal", label: step.label });
      }
      try {
        await plan.ticket.ready;
        let result;
        if (plan.stopRequested) {
          result = plan.stopReason;
        } else if (plan.ticket.state === "approved" && missingGrant(plan)) {
          stop(plan, DISABLED);
          result = plan.stopReason;
        }
        if (result) {
          // Retire even an approved ticket without ever entering an executor.
          approvals.consumeAndRun(plan.ticket, () => {});
        } else {
          const execution = approvals.consumeAndRun(plan.ticket, () => runSteps(plan));
          result = execution.executed ? await execution.result : execution.failure;
        }
        const { status, ...details } = result;
        return finish(plan, status, details);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    close() {
      closed = true;
      for (const plan of active.values()) stop(plan);
      approvals.close();
    }
  };
}
