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
    left.append(el("div", "registry-sub", tool.version || tool.unavailableReason || "未验证"));
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
    title.append(el("div", "candidate-meta", candidate.toolId + " · CLI"));
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
    tags.append(el("span", "tag", "真实本机命令"));
    tags.append(el("span", "tag", "仅只读"));
    item.append(tags);
    root.append(item);
  }

  refreshRunButton();
}

function renderEvents() {
  const root = $("events");
  root.replaceChildren();
  const items = [...state.events.values()].sort((a, b) => b.id - a.id).slice(0, 35);
  $("eventCount").textContent = String(state.events.size);
  if (!items.length) {
    root.append(el("div", "mini-empty", "尚无实际工具调用。开始执行后会显示后端事件。"));
    return;
  }

  const translation = {
    queued: "等待执行", running: "执行中", succeeded: "成功", failed: "失败",
    denied: "已拒绝", completed: "任务结束", cancelled: "已取消"
  };

  for (const event of items) {
    const item = el("div", "event-item " + event.status);
    const name = event.toolId || "任务控制";
    item.append(el("div", "event-name", name));
    const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    item.append(el("div", "event-details", time + (event.elapsedMs !== undefined ? " · " + event.elapsedMs + "ms" : "")));
    if (event.resultSummary) item.append(el("div", "event-details", event.resultSummary));
    if (event.error) item.append(el("div", "event-details", event.error));
    item.append(el("div", "event-status", translation[event.status] || event.status));
    root.append(item);
  }
}

function addEvent(event) {
  if (typeof event.id !== "number") return;
  state.events.set(event.id, event);
  while (state.events.size > 150) {
    state.events.delete(state.events.keys().next().value);
  }
  renderEvents();
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
    const history = await api("/api/history");
    history.events.forEach(addEvent);
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
  document.querySelectorAll('input[name="mode"]').forEach(option =>
    option.addEventListener("change", renderRecommendations));

  loadTools();
  api("/api/history").then(data => data.events.forEach(addEvent)).catch(() => {});
  connectStream();
}

init();
