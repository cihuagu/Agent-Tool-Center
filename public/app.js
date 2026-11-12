const state = {
  plan: null,
  selected: new Set(),
  tools: [],
  events: new Map(),
  running: false,
  usedPlan: false
};

const $ = id => document.getElementById(id);

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("服务返回了非 JSON 数据"); }
  if (!response.ok) throw new Error(data.error || "请求失败（" + response.status + "）");
  return data;
}

function feedback(text, kind = "") {
  const target = $("feedback");
  target.textContent = text;
  target.className = "feedback" + (kind ? " " + kind : "");
}

function mode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "mixed";
}

function refreshRunButton() {
  const hasTools = state.plan && state.plan.candidates.some(item => item.recommended);
  const canRun = mode() === "auto" ? hasTools
    : mode() === "manual" ? state.selected.size > 0
    : hasTools || state.selected.size > 0;
  $("runBtn").disabled = !canRun || state.running || state.usedPlan;
}

function renderTools() {
  const root = $("toolRegistry");
  root.replaceChildren();
  const available = state.tools.filter(item => item.available);
  $("toolCount").textContent = String(available.length);

  if (!state.tools.length) {
    root.append(el("div", "mini-empty", "暂无已发现的工具。"));
    return;
  }

  for (const tool of state.tools) {
    const item = el("div", "registry-item");
    const left = el("div");
    left.append(el("div", "registry-name", tool.name));
    left.append(el("div", "registry-sub", tool.provider));
    left.append(el("div", "registry-sub", tool.version || tool.unavailableReason || "未验证"));
    if (tool.dependency) left.append(el("div", "registry-sub", tool.dependency));
    item.append(left);
    item.append(el("span", tool.available ? "status-ok" : "status-off", tool.available ? "可用" : "不可用"));
    root.append(item);
  }
}

function renderRecommendations() {
  const root = $("recommendations");
  root.replaceChildren();
  const plan = state.plan;
  $("engineLabel").textContent = plan ? "规则推荐 · 非 AI" : "等待分析";

  if (!plan) {
    const placeholder = el("div", "empty-state");
    placeholder.append(el("div", "empty-visual", "⊞"));
    placeholder.append(el("strong", "", "等待生成工具方案"));
    placeholder.append(el("p", "", "点击“分析可用工具”，查看推荐原因、可用性和真实控制范围。"));
    root.append(placeholder);
    refreshRunButton();
    return;
  }

  if (!plan.candidates.length) {
    root.append(el("div", "mini-empty", "没有可用的本地工具，请检查环境。"));
    refreshRunButton();
    return;
  }

  for (const candidate of plan.candidates) {
    const item = el("div", "candidate" + (candidate.recommended ? " recommended" : ""));
    const top = el("div", "candidate-top");
    const main = el("div", "candidate-main");
    main.append(el("span", "tool-box", "◇"));
    const title = el("div");
    title.append(el("div", "candidate-name", candidate.name));
    title.append(el("div", "candidate-meta", candidate.toolId + " · " + (candidate.kind === "mcp" ? "MCPHub / 本地 fixture" : "CLI")));
    main.append(title);
    const checkbox = el("input", "tool-checkbox");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "选择" + candidate.name);
    checkbox.checked = mode() === "auto" ? candidate.recommended : state.selected.has(candidate.toolId);
    checkbox.disabled = mode() === "auto" || state.usedPlan || state.running;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(candidate.toolId);
      else state.selected.delete(candidate.toolId);
      refreshRunButton();
    });
    top.append(main, checkbox);
    item.append(top);
    item.append(el("p", "candidate-reason", candidate.reason));
    const tags = el("div", "candidate-tags");
    tags.append(el("span", "tag" + (candidate.recommended ? " highlight" : ""),
      candidate.recommended ? "推荐候选" : "非推荐候选"));
    tags.append(el("span", "tag", candidate.kind === "mcp" ? "真实 MCP 调用 · 测试服务" : "真实本机命令"));
    tags.append(el("span", "tag", "仅只读"));
    item.append(tags);
    root.append(item);
  }

  refreshRunButton();
}

function renderEvents() {
  const root = $("events");
  root.replaceChildren();
  const items = [...state.events.values()].sort((a, b) => ((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)) || b.id - a.id).slice(0, 35);
  $("eventCount").textContent = String(state.events.size);
  if (!items.length) {
    root.append(el("div", "mini-empty", "尚无实际工具调用。开始执行后会显示后端事件。"));
    return;
  }

  const translation = {
    queued: "等待执行", planned: "待执行", running: "执行中", succeeded: "成功", failed: "失败",
    denied: "已拒绝", completed: "任务结束", cancelled: "已取消"
  };

  for (const event of items) {
    const item = el("div", "event-item " + event.status);
    const recordedTool = event.source === "codex-observer" &&
      ["custom_tool_call", "function_call"].includes(event.rawKind);
    const name = recordedTool
      ? (event.rawKind === "custom_tool_call" ? "Custom 工具" : "Function 工具") + " · " + event.toolName
      : event.toolId || "任务控制";
    item.append(el("div", "event-name", name));
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    item.append(el("div", "event-details", time + (event.elapsedMs !== undefined ? " · " + event.elapsedMs + "ms" : "")));
    if (event.source === "codex") item.append(el("div", "event-details", "来源：Codex · 调用 ID：" + event.callId));
    if (event.source === "codex" && event.planId) {
      item.append(el("div", "event-details", "计划 ID：" + event.planId));
      if (event.stepId) {
        item.append(el("div", "event-details",
          (event.executionIndex !== undefined
            ? "执行顺序 " + event.executionIndex + " · 原提案位置 " + event.stepIndex
            : "步骤 " + event.stepIndex) + " · 步骤 ID：" + event.stepId));
      }
      if (event.phase === "approved-selection") {
        item.append(el("div", "event-details", "已确认顺序：" + (event.approvedOrder || []).join(" → ")));
        item.append(el("div", "event-details", "选中步骤 ID：" + (event.selectedStepIds || []).join("、")));
        item.append(el("div", "event-details", "未选用步骤 ID：" + (event.unselectedStepIds || []).join("、")));
      }
    }
    if (event.source === "codex-observer") {
      item.append(el("div", "event-details", "来源：codex-observer · 只读观察"));
      item.append(el("div", "event-details", "聊天 ID：" + event.threadId));
      item.append(el("div", "event-details", "轮次 ID：" + event.turnId + " · 调用 ID：" + event.callId));
      item.append(el("div", "event-details", (event.timestampSource === "source" ? "源时间：" : "观察时间：") + event.at));
      item.append(el("div", "event-details", "记录时间：" + event.recordedAt));
      if (event.sourceStatus) item.append(el("div", "event-details", "源状态：" + event.sourceStatus));
      if (event.exitCode !== undefined) item.append(el("div", "event-details", "退出码：" + event.exitCode));
    } else {
      if (event.resultSummary) item.append(el("div", "event-details", event.resultSummary));
      if (event.error) item.append(el("div", "event-details", event.error));
    }
    const statusLabel = recordedTool && event.status === "queued" ? "调用已记录"
      : recordedTool && event.status === "completed" ? "已返回"
      : event.phase === "proposal" ? "提案步骤"
      : event.phase === "approved-selection" ? "已确认计划"
      : event.status === "queued" && event.phase === "approval" ? "等待你确认"
      : event.errorCode === "PLAN_NOT_RUN" ? "未执行"
      : event.errorCode === "APPROVAL_EXPIRED" ? "确认已过期"
      : event.errorCode === "MCP_TIMEOUT" ? "超时"
      : event.errorCode === "MCP_TOOL_ERROR" ? "工具错误"
      : event.errorCode === "MCP_PROTOCOL_ERROR" ? "协议错误" : translation[event.status] || event.status;
    item.append(el("div", "event-status", statusLabel));
    root.append(item);
  }
}

function addEvent(event) {
  if (typeof event.id !== "number") return;
  if (event.source === "codex-observer" && [...state.events.values()].some(previous =>
    previous.source === event.source && previous.threadId === event.threadId &&
    previous.turnId === event.turnId && previous.callId === event.callId &&
    previous.status === event.status)) return;
  state.events.set(event.id, event);
  while (state.events.size > 150) {
    state.events.delete(state.events.keys().next().value);
  }
  renderEvents();
  if (event.source === "codex" && event.planId) void loadCodexPlans();
  if (event.source === "codex" && event.toolId === "project_git_status") void loadApprovals();
}

async function loadTools() {
  try {
    const data = await api("/api/tools");
    state.tools = data.tools;
    renderTools();
  } catch (error) {
    $("toolRegistry").replaceChildren(el("div", "mini-empty", "工具发现失败：" + error.message));
  }
}

const codexControls = [
  { tool: "git_version", toggleId: "codexEnabled", statusId: "codexStatus", command: "git --version" },
  { tool: "node_version", toggleId: "codexNodeEnabled", statusId: "codexNodeStatus", command: "node --version" }
];

function renderCodexPolicy(policy, tool) {
  for (const control of codexControls) {
    if (tool && control.tool !== tool) continue;
    const enabled = policy.tools?.find(item => item.tool === control.tool)?.enabled
      ?? (control.tool === "git_version" ? policy.enabled : false);
    $(control.toggleId).checked = enabled;
    $(control.statusId).textContent = enabled ? "已允许 · 仅固定 " + control.command : "已禁用 · 后端将拒绝此项 Codex 查询";
  }
}

async function loadCodexPolicy(tool) {
  const controls = codexControls.filter(control => !tool || control.tool === tool);
  try {
    renderCodexPolicy(await api("/api/codex/policy"), tool);
    for (const control of controls) $(control.toggleId).disabled = false;
  } catch {
    for (const control of controls) {
      $(control.toggleId).disabled = true;
      $(control.statusId).textContent = "无法读取授权状态，请刷新后重试";
    }
  }
}

async function changeCodexPolicy(tool = "git_version") {
  const control = codexControls.find(item => item.tool === tool);
  const toggle = $(control.toggleId);
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    const body = tool === "git_version" ? { enabled } : { tool, enabled };
    renderCodexPolicy(await api("/api/codex/policy", { method: "POST", body }), tool);
  } catch {
    await loadCodexPolicy(tool);
    $(control.statusId).textContent = "授权更新未确认，请刷新核对后端状态";
    return;
  }
  toggle.disabled = false;
}

let approvalRevision = 0;
let approvalRead = null;
let approvalPending = [];
let approvalsReadable = false;
const approvalSaving = new Set();

function renderApprovals() {
  const root = $("approvalCards");
  root.replaceChildren();
  if (!approvalsReadable) {
    root.append(el("div", "mini-empty", "待确认状态不可用，请等待重新读取。"));
    return;
  }
  if (!approvalPending.length) {
    root.append(el("div", "mini-empty", "暂无待确认请求。在 Codex 中请求使用 project_git_status 检查本项目 Git 工作区后，这里会显示本次确认卡片。"));
    return;
  }
  for (const request of approvalPending) {
    const card = el("div", "candidate");
    card.append(el("strong", "", "等待你确认 · 本项目 Git 工作区检查"));
    card.append(el("p", "candidate-reason", request.purpose));
    card.append(el("p", "candidate-meta", "只读 · " + request.scope));
    card.append(el("p", "candidate-meta", "调用 ID：" + request.callId));
    const seconds = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000));
    card.append(el("p", "candidate-meta", "截止时间：" + request.expiresAt + " · 剩余 " + seconds + " 秒（最多 45 秒）"));
    const actions = el("div", "actions");
    for (const [decision, label] of [["approve", "允许本次"], ["deny", "拒绝"]]) {
      const button = el("button", "secondary-btn", label);
      button.type = "button";
      button.disabled = approvalSaving.has(request.callId) || seconds === 0;
      button.addEventListener("click", () => decideApproval(request.callId, decision));
      actions.append(button);
    }
    card.append(actions);
    root.append(card);
  }
}

function loadApprovals() {
  if (approvalRead) return approvalRead;
  const revision = approvalRevision;
  approvalRead = (async () => {
    try {
      const data = await api("/api/codex/approvals");
      if (revision !== approvalRevision) return;
      approvalPending = data.pending || [];
      approvalsReadable = true;
      $("approvalStatus").textContent = "待确认 " + approvalPending.length + " 项 · 每次仅允许一次";
    } catch {
      if (revision !== approvalRevision) return;
      approvalsReadable = false;
      $("approvalStatus").textContent = "无法读取待确认状态，确认按钮已暂停；正在等待重新核对后端。";
    } finally {
      approvalRead = null;
    }
    renderApprovals();
  })();
  return approvalRead;
}

async function decideApproval(callId, decision) {
  if (!approvalsReadable || approvalSaving.has(callId) ||
      !approvalPending.some(request => request.callId === callId) ||
      !["approve", "deny"].includes(decision)) return;
  approvalSaving.add(callId);
  ++approvalRevision;
  renderApprovals();
  let failed = false;
  try {
    await api("/api/codex/approvals/decision", {
      method: "POST", body: { callId, decision }
    });
  } catch {
    failed = true;
  }
  // The refreshed server queue decides whether the card still exists.
  await approvalRead;
  await loadApprovals();
  approvalSaving.delete(callId);
  if (failed) $("approvalStatus").textContent = "本次决定未确认，已尝试重新查询后端；请核对待确认卡片和同一调用 ID 的时间线。";
  renderApprovals();
}

let codexPlanRevision = 0;
let codexPlanRead = null;
let codexPlans = [];
let codexPlansReadable = false;
const codexPlanSaving = new Set();
let codexPlanRenderFingerprint = null;
const codexPlanCountdowns = new Map();
const codexPlanDrafts = new Map();

function pendingCodexSelection(plan) {
  return Array.isArray(plan.proposedSteps) && plan.status === "queued" &&
    plan.selectionFinalized === false;
}

function editableCodexSelection(planId) {
  const plan = codexPlans.find(item => item.planId === planId);
  return plan && pendingCodexSelection(plan) && codexPlansReadable &&
    !codexPlanSaving.has(planId) && !plan.stopRequested &&
    Date.parse(plan.expiresAt) > Date.now() ? plan : null;
}

function selectedCodexSteps(planId) {
  const draft = codexPlanDrafts.get(planId);
  return draft ? draft.order.filter(tool => draft.selected.has(tool)) : [];
}

function toggleCodexPlanStep(planId, tool, enabled) {
  if (!editableCodexSelection(planId) || typeof enabled !== "boolean") return;
  const draft = codexPlanDrafts.get(planId);
  if (!draft || !draft.order.includes(tool)) return;
  if (enabled) draft.selected.add(tool);
  else draft.selected.delete(tool);
  renderCodexPlans();
}

function moveCodexPlanStep(planId, tool, direction) {
  if (!editableCodexSelection(planId) || ![-1, 1].includes(direction)) return;
  const draft = codexPlanDrafts.get(planId);
  if (!draft) return;
  const index = draft.order.indexOf(tool);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= draft.order.length) return;
  [draft.order[index], draft.order[next]] = [draft.order[next], draft.order[index]];
  renderCodexPlans();
}

function renderCodexProposal(card, plan) {
  card.append(el("p", "candidate-meta", "原始提案顺序（批准前的完整提案）："));
  const list = el("ol", "candidate-list");
  for (const step of plan.proposedSteps) {
    list.append(el("li", "candidate-meta", "原提案位置 " + step.stepIndex + " · " +
      (step.label || step.tool || step.toolId) + " · 步骤 ID：" + step.stepId +
      " · 调用 ID：" + step.callId));
  }
  card.append(list);
}

function codexPlanLabel(item) {
  if (item.errorCode === "PLAN_NOT_RUN") return "未执行";
  if (item.errorCode === "APPROVAL_EXPIRED") return "确认已过期";
  const labels = {
    queued: "等待你确认", planned: "待执行", running: "执行中",
    succeeded: "成功", failed: "失败", denied: "已拒绝", cancelled: "已取消"
  };
  return labels[item.status] || "状态待核对";
}

function renderCodexPlans() {
  const root = $("codexPlanCards");
  for (const [planId] of codexPlanDrafts) {
    const plan = codexPlans.find(item => item.planId === planId);
    if (!plan || !pendingCodexSelection(plan)) codexPlanDrafts.delete(planId);
  }
  for (const plan of codexPlans) {
    if (pendingCodexSelection(plan) && !codexPlanDrafts.has(plan.planId)) {
      const order = plan.proposedSteps.map(step => step.tool);
      codexPlanDrafts.set(plan.planId, { order, selected: new Set(order) });
    }
  }
  const fingerprint = JSON.stringify([codexPlans, codexPlansReadable, [...codexPlanSaving],
    [...codexPlanDrafts].map(([id, draft]) => [id, draft.order, [...draft.selected]])]);
  if (fingerprint === codexPlanRenderFingerprint) {
    for (const { plan, countdown, buttons } of codexPlanCountdowns.values()) {
      const seconds = Math.max(0, Math.ceil((Date.parse(plan.expiresAt) - Date.now()) / 1000));
      if (countdown) countdown.textContent = "确认截止时间：" + plan.expiresAt +
        " · 剩余 " + seconds + " 秒（最多 30 秒）";
      for (const { button, blocked } of buttons) {
        button.disabled = !codexPlansReadable || codexPlanSaving.has(plan.planId) ||
          plan.stopRequested || !(seconds > 0) || blocked;
      }
    }
    return;
  }
  codexPlanRenderFingerprint = fingerprint;
  codexPlanCountdowns.clear();
  root.replaceChildren();
  if (!codexPlansReadable) {
    root.append(el("div", "mini-empty", "计划状态不可用，操作已暂停；正在等待重新读取。"));
  }
  if (!codexPlans.length) {
    if (codexPlansReadable) root.append(el("div", "mini-empty", "暂无 Codex 多步骤工具计划。"));
    return;
  }
  const active = plan => ["queued", "running"].includes(plan.status);
  const plans = [...codexPlans].sort((a, b) =>
    Number(active(b)) - Number(active(a)) ||
    (Date.parse(b.expiresAt) || 0) - (Date.parse(a.expiresAt) || 0));
  for (const plan of plans) {
    const steps = plan.steps || [];
    const draft = codexPlanDrafts.get(plan.planId);
    const buttons = [];
    const locked = !codexPlansReadable || codexPlanSaving.has(plan.planId) ||
      plan.stopRequested || (plan.status === "queued" && !(Date.parse(plan.expiresAt) > Date.now()));
    function trackControl(button, blocked = false) {
      button.disabled = Boolean(locked || blocked);
      buttons.push({ button, blocked });
    }
    const card = el("div", "candidate");
    const completed = steps.filter(step => step.status === "succeeded").length;
    card.append(el("strong", "", codexPlanLabel(plan) + " · 已成功 " + completed + "/" + steps.length));
    card.append(el("p", "candidate-reason", plan.purpose));
    card.append(el("p", "candidate-meta", "只读范围：" + plan.scope));
    card.append(el("p", "candidate-meta", "计划 ID：" + plan.planId));
    const seconds = Math.max(0, Math.ceil((Date.parse(plan.expiresAt) - Date.now()) / 1000));
    let countdown = null;
    if (plan.expiresAt) {
      countdown = el("p", "candidate-meta", "确认截止时间：" + plan.expiresAt +
        (plan.status === "queued" ? " · 剩余 " + seconds + " 秒（最多 30 秒）" : ""));
      card.append(countdown);
    }
    if (Array.isArray(plan.proposedSteps)) renderCodexProposal(card, plan);
    if (draft) {
      const selected = selectedCodexSteps(plan.planId);
      card.append(el("p", "candidate-meta", "已选 " + selected.length +
        " 项 · 拟执行顺序（尚未批准）：" +
        (selected.map(tool => {
          const step = plan.proposedSteps.find(item => item.tool === tool);
          return step.label || step.tool;
        }).join(" → ") || "无")));
    }
    const list = el("ol", "candidate-list");
    const displayedSteps = draft
      ? draft.order.map(tool => steps.find(step => step.tool === tool) ||
        plan.proposedSteps.find(step => step.tool === tool))
      : steps;
    for (const step of displayedSteps) {
      const row = el("li", "registry-item");
      const details = el("div");
      details.append(el("strong", "",
        (step.executionIndex !== undefined
          ? "执行顺序 " + step.executionIndex + " · 原提案位置 " + step.stepIndex
          : "步骤 " + step.stepIndex) + " · " +
        (step.label || step.tool || step.toolId) + " · " + codexPlanLabel(step)));
      if (draft) {
        const label = step.label || step.tool || step.toolId;
        const checkbox = el("input", "tool-checkbox");
        checkbox.type = "checkbox";
        checkbox.checked = draft.selected.has(step.tool);
        checkbox.setAttribute("aria-label", "选择" + label);
        trackControl(checkbox);
        checkbox.addEventListener("change", () =>
          toggleCodexPlanStep(plan.planId, step.tool, checkbox.checked));
        details.append(checkbox);
        for (const [direction, text] of [[-1, "上移"], [1, "下移"]]) {
          const button = el("button", "secondary-btn", text);
          button.type = "button";
          button.setAttribute("aria-label", text + label);
          const next = draft.order.indexOf(step.tool) + direction;
          trackControl(button, next < 0 || next >= draft.order.length);
          button.addEventListener("click", () =>
            moveCodexPlanStep(plan.planId, step.tool, direction));
          details.append(button);
        }
      }
      if (step.tool) details.append(el("p", "candidate-meta", "工具：" + step.tool));
      details.append(el("p", "candidate-meta", "步骤 ID：" + step.stepId));
      details.append(el("p", "candidate-meta", "调用 ID：" + step.callId));
      const grant = step.grantEnabled === null ? "本次计划审批覆盖此项目检查步骤"
        : step.grantEnabled === true ? "已允许 · 仍受现有版本查询授权开关约束"
        : "已禁用 · 版本查询授权未允许";
      details.append(el("p", "candidate-meta", "当前授权：" + grant));
      if (step.resultSummary) details.append(el("p", "candidate-reason", step.resultSummary));
      if (step.version && step.version !== step.resultSummary) {
        details.append(el("p", "candidate-reason", step.version));
      }
      if (step.errorCode) details.append(el("p", "candidate-meta", "原因代码：" + step.errorCode));
      if (step.error) details.append(el("p", "candidate-reason", step.error));
      row.append(details);
      list.append(row);
    }
    card.append(list);
    if (plan.excludedSteps?.length) {
      card.append(el("strong", "", "未选用 · 用户未选择"));
      const excluded = el("ol", "candidate-list");
      for (const step of plan.excludedSteps) {
        excluded.append(el("li", "candidate-meta", "原提案位置 " + step.stepIndex +
          " · " + (step.label || step.tool || step.toolId) +
          " · 步骤 ID：" + step.stepId + " · 调用 ID：" + step.callId +
          " · " + (step.reason || "用户未选择") +
          (step.reasonCode ? " · " + step.reasonCode : "")));
      }
      card.append(excluded);
    }
    if (plan.errorCode) card.append(el("p", "candidate-meta", "原因代码：" + plan.errorCode));
    if (plan.error) card.append(el("p", "candidate-reason", plan.error));
    if (plan.stopReason) card.append(el("p", "candidate-meta", "停止原因：" + plan.stopReason));
    if (plan.status === "running") {
      card.append(el("p", "candidate-reason",
        (plan.stopRequested ? "后端已记录停止请求。" : "") +
        "停止仅作用于后续步骤；当前已启动的只读步骤可能继续完成并保留真实结果。"));
    } else if (plan.stopRequested && ["succeeded", "failed", "denied", "cancelled"].includes(plan.status)) {
      card.append(el("p", "candidate-reason", "停止请求已生效，计划已结束；实际执行结果以上方步骤记录为准。"));
    }
    const actions = el("div", "actions");
    const choices = plan.status === "queued" && plan.selectionFinalized !== true
      ? [["approve", "允许此计划"], ["deny", "拒绝"]]
      : plan.status === "running" ? [["cancel", "停止后续步骤"]] : [];
    for (const [action, label] of choices) {
      const button = el("button", "secondary-btn", label);
      button.type = "button";
      trackControl(button, action === "approve" && Boolean(draft) &&
        selectedCodexSteps(plan.planId).length === 0);
      button.addEventListener("click", () => action === "cancel"
        ? cancelCodexPlan(plan.planId) : decideCodexPlan(plan.planId, action));
      actions.append(button);
    }
    if (plan.status === "queued") codexPlanCountdowns.set(plan.planId, { plan, countdown, buttons });
    card.append(actions);
    root.append(card);
  }
}

function loadCodexPlans() {
  if (codexPlanRead) return codexPlanRead;
  const revision = codexPlanRevision;
  codexPlanRead = (async () => {
    try {
      const data = await api("/api/codex/plans", { cache: "no-store" });
      if (revision !== codexPlanRevision) return false;
      codexPlans = data.plans || [];
      codexPlansReadable = true;
      $("codexPlanStatus").textContent = "计划 " + codexPlans.length + " 项 · 批准后顺序冻结 · 每份计划仅允许一次";
    } catch {
      if (revision !== codexPlanRevision) return false;
      codexPlansReadable = false;
      $("codexPlanStatus").textContent = "无法读取计划状态，操作已暂停；正在等待重新核对后端。";
    } finally {
      codexPlanRead = null;
    }
    renderCodexPlans();
    return true;
  })();
  return codexPlanRead;
}

async function submitCodexPlanAction(planId, action) {
  const plan = codexPlans.find(item => item.planId === planId);
  if (!codexPlansReadable || !plan || codexPlanSaving.has(planId) || plan.stopRequested) return;
  if (action === "cancel") {
    if (plan.status !== "running") return;
  } else if (!["approve", "deny"].includes(action) || plan.status !== "queued" ||
      plan.selectionFinalized === true || !(Date.parse(plan.expiresAt) > Date.now())) return;
  const body = action === "cancel" ? { planId } : { planId, decision: action };
  if (action === "approve" && pendingCodexSelection(plan)) {
    const selected = selectedCodexSteps(planId);
    if (!selected.length) return;
    body.steps = [...selected];
  }
  codexPlanSaving.add(planId);
  ++codexPlanRevision;
  renderCodexPlans();
  let failed = false;
  try {
    await api(action === "cancel" ? "/api/codex/plans/cancel" : "/api/codex/plans/decision", {
      method: "POST",
      body
    });
  } catch {
    failed = true;
  }
  // Discard a pre-action read, then reconcile using a genuinely fresh snapshot.
  await codexPlanRead;
  while (!(await loadCodexPlans())) {
    // Another plan action invalidated this read; keep this plan locked.
  }
  codexPlanSaving.delete(planId);
  if (failed) {
    $("codexPlanStatus").textContent = "计划操作未确认，已尝试重新查询后端；请核对计划卡片和同一计划 ID 的时间线。";
  }
  renderCodexPlans();
}

function decideCodexPlan(planId, decision) {
  if (!["approve", "deny"].includes(decision)) return;
  return submitCodexPlanAction(planId, decision);
}

function cancelCodexPlan(planId) {
  return submitCodexPlanAction(planId, "cancel");
}

let observerBusy = false;
let observerRevision = 0;

function renderObserverStatus(status) {
  const labels = { stopped: "已停止", starting: "正在连接", observing: "观察中", stopping: "正在停止", error: "读取失败，观察已停止" };
  if (!Object.hasOwn(labels, status.state)) throw Error("观察状态无效");
  $("observerThread").disabled = observerBusy || status.enabled || status.state === "stopping";
  $("observerStart").disabled = observerBusy || status.enabled || status.state === "stopping" || status.cleanupFailed;
  $("observerStop").disabled = observerBusy || !(status.enabled || status.state === "error");
  const coverage = status.lastReadAt
    ? " · 本次读取 " + status.coverage.turnCount + "/20 轮" + (status.coverage.hasMore ? "，更早轮次未覆盖" : "")
    : " · 尚未完成源读取";
  const raw = status.coverage?.raw;
  const rawCoverage = status.lastReadAt
    ? (raw?.available
      ? " · 工具补充记录可读（末尾最多 2MiB）" +
        (raw.truncated ? "，读取范围截断，记录可能不完整" : "") +
        (raw.skippedLines ? "，已跳过无法解析的记录" : "")
      : " · 工具补充记录不可用；原生终端仍按结构化历史覆盖")
    : "";
  $("observerStatus").textContent = "只读观察 · " + labels[status.state] +
    (status.threadId ? " · 聊天 ID：" + status.threadId : "") + coverage + rawCoverage +
    (status.lastReadAt ? " · 最近读取：" + status.lastReadAt : "") +
    (status.skippedItems ? " · " + status.skippedItems + " 项状态或退出码不足，未生成事件" : "") +
    (status.lastErrorCode ? " · 源读取失败；诊断内容未展示" : "") +
    (status.cleanupFailed ? " · 进程清理未确认，请重启服务后核对" : "");
}

async function loadObserverStatus() {
  if (observerBusy) return;
  const revision = observerRevision;
  try {
    const status = await api("/api/codex/observer/status");
    if (revision === observerRevision && !observerBusy) renderObserverStatus(status);
  } catch {
    if (revision !== observerRevision || observerBusy) return;
    $("observerStart").disabled = true;
    $("observerStop").disabled = false;
    $("observerStatus").textContent = "无法读取只读观察状态；可尝试停止观察，请刷新核对";
  }
}

async function changeObserver(action) {
  if (observerBusy || !["start", "stop"].includes(action)) return;
  observerBusy = true;
  observerRevision++;
  $("observerStart").disabled = true;
  $("observerStop").disabled = true;
  $("observerThread").disabled = true;
  $("observerError").textContent = "";
  try {
    const status = await api("/api/codex/observer/" + action, {
      method: "POST",
      body: action === "start" ? { threadId: $("observerThread").value.trim() } : {}
    });
    observerBusy = false;
    renderObserverStatus(status);
  } catch {
    observerBusy = false;
    $("observerError").textContent = "观察变更未确认，请核对聊天 UUID、同源连接和后端状态后重试。";
    await loadObserverStatus();
  }
}

async function createPlan() {
  if (state.running) return;
  const task = $("taskInput").value.trim();
  state.plan = null;
  state.usedPlan = false;
  $("planBtn").disabled = true;
  $("runBtn").disabled = true;
  feedback("正在检查真实可用工具并匹配任务…");
  try {
    const data = await api("/api/plan", { method: "POST", body: { task } });
    state.plan = data;
    state.selected = new Set(data.candidates.filter(c => c.recommended).map(c => c.toolId));
    feedback(data.notice, data.candidates.some(c => c.recommended) ? "success" : "");
    renderRecommendations();
  } catch (error) {
    feedback(error.message, "error");
    renderRecommendations();
  } finally {
    $("planBtn").disabled = false;
  }
}

async function executePlan() {
  if (!state.plan || state.running || state.usedPlan) return;
  state.running = true;
  refreshRunButton();
  feedback("已提交任务，等待真实执行器事件…");
  try {
    const data = await api("/api/execute", {
      method: "POST",
      body: {
        planId: state.plan.planId,
        mode: mode(),
        toolIds: [...state.selected]
      }
    });
    state.usedPlan = true;
    feedback("已提交 " + data.toolIds.length + " 项真实工具调用。可以在右侧查看执行事件。", "success");
    renderRecommendations();
    try {
      const history = await api("/api/history");
      history.events.forEach(addEvent);
    } catch {
      feedback("执行已接收，记录暂不可用；请等待实时事件或稍后刷新，请勿重复执行。", "error");
    }
  } catch (error) {
    feedback("执行被阻止：" + error.message, "error");
  } finally {
    state.running = false;
    refreshRunButton();
  }
}

function connectStream() {
  if (!window.EventSource) {
    $("connectionText").textContent = "浏览器不支持实时事件";
    return;
  }
  const stream = new EventSource("/api/events");
  stream.onopen = () => {
    $("connectionDot").classList.add("ok");
    $("connectionText").textContent = "实时连接已建立";
  };
  stream.onerror = () => {
    $("connectionDot").classList.remove("ok");
    $("connectionText").textContent = "连接中断 · 自动重连";
  };
  stream.addEventListener("tool", message => {
    try { addEvent(JSON.parse(message.data)); } catch { /* ignore broken data */ }
  });
}

function init() {
  const input = $("taskInput");
  function count() { $("charCount").textContent = input.value.length + " / 1500"; }
  input.addEventListener("input", count);
  count();

  $("refreshBtn").addEventListener("click", loadTools);
  $("planBtn").addEventListener("click", createPlan);
  $("runBtn").addEventListener("click", executePlan);
  for (const control of codexControls) {
    $(control.toggleId).addEventListener("change", () => changeCodexPolicy(control.tool));
  }
  $("observerStart").addEventListener("click", () => changeObserver("start"));
  $("observerStop").addEventListener("click", () => changeObserver("stop"));
  document.querySelectorAll('input[name="mode"]').forEach(option =>
    option.addEventListener("change", renderRecommendations));

  loadTools();
  loadCodexPolicy();
  loadApprovals();
  window.setInterval?.(loadApprovals, 1000);
  loadCodexPlans();
  window.setInterval?.(loadCodexPlans, 1000);
  loadObserverStatus();
  window.setInterval?.(loadObserverStatus, 2000);
  api("/api/history").then(data => data.events.forEach(addEvent)).catch(() => {});
  connectStream();
}

init();
