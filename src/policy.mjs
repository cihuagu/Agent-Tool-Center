const MODES = new Set(["manual", "auto", "mixed"]);

export class PolicyError extends Error {
  constructor(message, code = "DENIED", status = 403) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.status = status;
  }
}

// Deliberately pure: choices are rechecked server-side.
export function chooseTools(plan, requestedMode, requestedIds) {
  if (!plan || !Array.isArray(plan.candidates)) {
    throw new PolicyError("计划不存在", "UNKNOWN_PLAN", 404);
  }
  if (plan.used) {
    throw new PolicyError("计划已经执行过，不能重复提交", "PLAN_ALREADY_USED", 409);
  }
  if (Date.now() > plan.expiresAt) {
    throw new PolicyError("计划已过期，请重新生成", "PLAN_EXPIRED", 410);
  }
  if (!MODES.has(requestedMode)) {
    throw new PolicyError("无效的工具选择模式", "INVALID_MODE", 400);
  }
  if (!Array.isArray(requestedIds) || requestedIds.length > 20 ||
      requestedIds.some(item => typeof item !== "string") ||
      new Set(requestedIds).size !== requestedIds.length) {
    throw new PolicyError("工具列表格式错误或重复", "INVALID_SELECTION", 400);
  }

  const allowed = new Set(plan.candidates.map(item => item.toolId));
  for (const id of requestedIds) {
    if (!allowed.has(id)) {
      throw new PolicyError("工具未包含在此计划或不可用：" + id, "TOOL_NOT_ALLOWED", 403);
    }
  }

  const recommended = plan.candidates.filter(item => item.recommended).map(item => item.toolId);
  const chosen = requestedMode === "manual" ? requestedIds
    : requestedMode === "auto" ? recommended
    : [...new Set([...recommended, ...requestedIds])];

  if (!chosen.length) {
    throw new PolicyError("当前没有适合执行的工具，请调整任务或人工选择", "NO_TOOL_SELECTED", 422);
  }

  for (const id of chosen) {
    if (!allowed.has(id)) {
      throw new PolicyError("执行器拒绝未经授权的工具：" + id, "TOOL_NOT_ALLOWED");
    }
  }

  // Phase 0 contains read-only tools ONLY. A future write tool requires an
  // explicit approval grant beyond being present in plan.candidates.
  return chosen;
}
