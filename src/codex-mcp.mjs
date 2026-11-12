import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runTool } from "./registry.mjs";
import { PolicyError } from "./policy.mjs";
import { runProjectGit, validateProjectGitSummary, projectGitSummaryText } from "./project-git.mjs";
import {
  createApprovals, approvalFailure, PROJECT_GIT_TOOL, PROJECT_GIT_PURPOSE, PROJECT_GIT_SCOPE
} from "./approvals.mjs";
import { createToolPlans, validToolPlanArguments, TOOL_PLAN_TOOL, TOOL_PLAN_NAMES } from "./tool-plans.mjs";

// Use the project SDK; never load the Hub or install dependencies here.
const require = createRequire(new URL("../package.json", import.meta.url));
const CAPABILITIES = Object.freeze([
  { name: "git_version", toolId: "runtime.git", label: "Git", version: /^git version \d+\.\d+[0-9A-Za-z.+-]*$/ },
  { name: "node_version", toolId: "runtime.node", label: "Node.js", version: /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/ }
]);
const TOOLS = CAPABILITIES.map(({ name, label }) => ({
  name,
  description: `通过 Agent Tool Center 查询本机 ${label} 版本；需用户先在面板允许对应的 Codex 查询，返回调用 ID 和真实结果。`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}));
TOOLS.push({
  name: PROJECT_GIT_TOOL,
  description: `${PROJECT_GIT_PURPOSE}。${PROJECT_GIT_SCOPE}。每次调用须在面板点击“允许本次”，45 秒内未确认则拒绝；不接受参数。`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});
TOOLS.push({
  name: TOOL_PLAN_TOOL,
  description: "提交 2 至 3 个固定只读步骤的有序提案；用户可在工作台选择非空子集并重排，批准后按选定顺序执行，30 秒内未确认则拒绝。最终结果 steps 为实际批准步骤及结果，proposedSteps 为原始提案元数据，excludedSteps 为未选用步骤。",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array", items: { type: "string", enum: [...TOOL_PLAN_NAMES] },
        minItems: 2, maxItems: 3, uniqueItems: true
      }
    },
    required: ["steps"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

function versionDetails(capability, result) {
  if (typeof result?.text !== "string" || result.text.length > 200 ||
      result.text !== result.text.trim() || !capability.version.test(result.text)) {
    throw Error("INVALID_VERSION_RESULT");
  }
  return { version: result.text, resultSummary: result.text };
}

export function createCodexMcp({ publish, run = runTool, projectRunner = runProjectGit, approvalTimeoutMs = 45000, planApprovalTimeoutMs = 30000 }) {
  const grants = new Map(CAPABILITIES.map(tool => [tool.name, false]));
  const connections = new Set();
  const sessions = new Map();
  const approvals = createApprovals({ timeoutMs: approvalTimeoutMs });
  const toolPlans = createToolPlans({
    publish,
    timeoutMs: planApprovalTimeoutMs,
    isEnabled: name => grants.get(name) === true,
    execute: async name => {
      if (name === PROJECT_GIT_TOOL) {
        const summary = validateProjectGitSummary(await projectRunner());
        return { summary, resultSummary: projectGitSummaryText(summary) };
      }
      const capability = CAPABILITIES.find(tool => tool.name === name);
      return versionDetails(capability, await run(capability.toolId));
    }
  });
  let closed = false;
  const getPolicy = () => ({
    enabled: grants.get("git_version"), tool: "git_version", scope: "codex", persistence: "memory",
    tools: CAPABILITIES.map(({ name }) => ({ tool: name, enabled: grants.get(name) }))
  });

  async function dispatch(params, signal, initialized = true) {
    const callId = randomUUID();
    const capability = CAPABILITIES.find(tool => tool.name === params?.name);
    const isProject = params?.name === PROJECT_GIT_TOOL;
    const isPlan = params?.name === TOOL_PLAN_TOOL;
    const context = { callId, taskId: callId, source: "codex", toolId: isPlan ? TOOL_PLAN_TOOL : isProject ? PROJECT_GIT_TOOL : capability?.toolId ?? null };
    function finish(status, details) {
      publish({ ...context, status, ...details });
      const data = { ...context, status, ...details };
      return { isError: status !== "succeeded", structuredContent: data,
        content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    const args = params?.arguments;
    if (!params || typeof params !== "object" || Array.isArray(params) ||
        Object.keys(params).some(key => !["name", "arguments", "_meta"].includes(key)) ||
        (params._meta !== undefined && (!params._meta || typeof params._meta !== "object" || Array.isArray(params._meta))) ||
        (isPlan ? !validToolPlanArguments(args) :
          (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)))) {
      return finish("denied", { errorCode: "INVALID_ARGUMENTS", error: isPlan ? "工具计划仅接受2至3个不重复的固定工具步骤，不接受命令、路径或授权字段" : "仅接受空参数对象，不接受命令、参数或授权字段" });
    }
    if (isPlan) {
      if (!initialized) {
        return finish("denied", {
          errorCode: "SESSION_REQUIRED", error: "工具计划需要先初始化 MCP 会话"
        });
      }
      return toolPlans.dispatch(callId, args.steps, signal);
    }
    if (isProject) {
      if (!initialized) {
        return finish("denied", {
          errorCode: "SESSION_REQUIRED",
          error: "本项目 Git 检查需要先初始化 MCP 会话"
        });
      }
      const ticket = approvals.request(callId, signal);
      if (ticket.state !== "pending") {
        const { status, ...details } = approvalFailure(ticket.state);
        return finish(status, details);
      }
      publish({
        ...context, status: "queued", phase: "approval", approvalState: "pending",
        expiresAt: new Date(ticket.deadline).toISOString()
      });
      await ticket.ready;
      const started = Date.now();
      try {
        const execution = approvals.consumeAndRun(ticket, () => {
          publish({ ...context, status: "running" });
          return projectRunner();
        });
        if (!execution.executed) {
          const { status, ...details } = execution.failure;
          return finish(status, details);
        }
        const summary = validateProjectGitSummary(await execution.result);
        return finish("succeeded", {
          elapsedMs: Date.now() - started, summary, resultSummary: projectGitSummaryText(summary)
        });
      } catch {
        return finish("failed", {
          elapsedMs: Date.now() - started,
          errorCode: "PROJECT_GIT_FAILED",
          error: "本项目 Git 工作区检查失败；未记录原始诊断内容"
        });
      }
    }
    if (!capability) {
      return finish("denied", { errorCode: "TOOL_NOT_ALLOWED", error: "Codex 入口仅允许固定的 Git / Node.js 版本查询" });
    }
    // Check the live grant at dispatch, including calls from clients with an old tools/list.
    if (!grants.get(capability.name)) return finish("denied", { errorCode: "CODEX_DISABLED", error: `Codex ${capability.label} 查询已禁用，请由用户在面板允许` });
    const started = Date.now();
    publish({ ...context, status: "running" });
    try {
      const result = await run(capability.toolId);
      const details = versionDetails(capability, result);
      return finish("succeeded", { elapsedMs: Date.now() - started, ...details });
    } catch {
      return finish("failed", { elapsedMs: Date.now() - started, errorCode: "TOOL_FAILED", error: `${capability.label} 版本查询失败；未记录原始诊断内容` });
    }
  }

  function endCancelledResponse(res) {
    if (res.destroyed || res.writableEnded) return;
    res.destroy();
  }

  function releaseConnection(connection) {
    connections.delete(connection);
    const id = connection.transport.sessionId;
    if (id && sessions.get(id) === connection) sessions.delete(id);
    for (const request of connection.active.values()) {
      request.controller.abort();
      endCancelledResponse(request.res);
    }
    connection.active.clear();
  }

  function closeConnection(connection) {
    if (!connection.closing) {
      releaseConnection(connection);
      connection.closing = Promise.resolve().then(() => connection.server.close());
    }
    return connection.closing;
  }

  async function route(connection, req, res, body) {
    if (body?.method === "notifications/cancelled") {
      // Keep number and string IDs distinct, including the valid numeric ID zero.
      const request = connection.active.get(body.params?.requestId);
      if (request) {
        request.controller.abort();
        endCancelledResponse(request.res);
      }
    }

    let active;
    const isCall = req.method === "POST" && body?.method === "tools/call" &&
      (typeof body.id === "string" || typeof body.id === "number");
    if (isCall) {
      if (connection.active.has(body.id)) {
        res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: body.id,
          error: { code: -32600, message: "请求 ID 已有未完成的工具调用" }
        }));
        return;
      }
      active = { controller: new AbortController(), res };
      active.onClose = () => {
        if (connection.active.get(body.id) === active) connection.active.delete(body.id);
        active.controller.abort();
      };
      connection.active.set(body.id, active);
      res.once("close", active.onClose);
    }

    // Only this server-created envelope is unwrapped by the SDK handler.
    // Client-supplied fields remain inside the untouched raw params.
    const routed = body?.method === "tools/call" ? {
      ...body,
      params: { name: "git_version", arguments: { internalRawParams: body.params } }
    } : body;
    try {
      await connection.transport.handleRequest(req, res, routed);
    } catch (error) {
      if (active) {
        res.removeListener("close", active.onClose);
        if (connection.active.get(body.id) === active) connection.active.delete(body.id);
        active.controller.abort();
      }
      throw error;
    }
  }

  return {
    getPolicy,
    dispatch,
    getApprovals: () => ({ pending: approvals.pending() }),
    decideApproval: body => approvals.decide(body),
    getPlans: () => toolPlans.getPlans(),
    decidePlan: body => toolPlans.decidePlan(body),
    cancelPlan: body => toolPlans.cancelPlan(body),
    setPolicy(body) {
      const keys = Object.keys(body);
      const legacy = keys.length === 1 && keys[0] === "enabled";
      if (typeof body.enabled !== "boolean" || (!legacy &&
          (keys.length !== 2 || !keys.includes("tool") || !grants.has(body.tool)))) {
        throw new PolicyError("仅接受 enabled 布尔值；指定 tool 时只允许 git_version 或 node_version，省略时仅控制 Git", "INVALID_CODEX_POLICY", 400);
      }
      const name = legacy ? "git_version" : body.tool;
      grants.set(name, body.enabled);
      if (!body.enabled) toolPlans.revoke(name);
      return getPolicy();
    },
    async handle(req, res, body) {
      if (closed) throw new PolicyError("Codex 入口已关闭", "APPROVAL_CANCELLED", 503);
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId !== undefined) {
        const connection = sessions.get(sessionId);
        if (!connection) throw new PolicyError("MCP 会话不存在", "SESSION_NOT_FOUND", 404);
        try {
          await route(connection, req, res, body);
        } finally {
          if (req.method === "DELETE") await closeConnection(connection);
        }
        return;
      }
      if (req.method !== "POST") {
        throw new PolicyError("未初始化会话的 MCP 入口仅接受 POST", "METHOD_NOT_ALLOWED", 405);
      }
      // Include entries still awaiting initialization; never evict live sessions.
      if (connections.size >= 100) {
        throw new PolicyError("MCP 会话数量已达上限", "SESSION_LIMIT", 503);
      }
      let Server, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
      try {
        ({ Server } = require("@modelcontextprotocol/sdk-v1/server/index.js"));
        ({ StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk-v1/server/streamableHttp.js"));
        ({ ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk-v1/types.js"));
      } catch {
        throw new PolicyError("项目内官方 MCP SDK 缺失；未自动安装，详见 Codex 接入文档", "CODEX_SDK_UNAVAILABLE", 503);
      }
      const server = new Server({ name: "agent-tool-center", version: "0.1.0" }, { capabilities: { tools: {} } });
      const stateful = body?.method === "initialize";
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: stateful ? randomUUID : undefined,
        enableJsonResponse: true,
        onsessioninitialized: id => {
          if (closed || !connections.has(connection)) return;
          sessions.set(id, connection);
        },
        onsessionclosed: () => { void closeConnection(connection).catch(() => {}); }
      });
      const connection = { server, transport, active: new Map(), closing: null };
      connections.add(connection);
      server.onclose = () => releaseConnection(connection);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const active = connection.active.get(extra.requestId);
        const signal = active
          ? AbortSignal.any([extra.signal, active.controller.signal])
          : extra.signal;
        try {
          return await dispatch(
            request.params.arguments.internalRawParams,
            signal,
            stateful && sessions.get(transport.sessionId) === connection
          );
        } finally {
          if (active) {
            active.res.removeListener("close", active.onClose);
            if (connection.active.get(extra.requestId) === active) {
              connection.active.delete(extra.requestId);
            }
            // Abort only the owned POST; the SDK owns response headers and body.
            if (signal.aborted) endCancelledResponse(active.res);
          }
        }
      });
      if (!stateful) {
        res.once("close", () => { void closeConnection(connection).catch(() => {}); });
      }
      try {
        await server.connect(transport);
        if (closed) throw new PolicyError("Codex 入口已关闭", "APPROVAL_CANCELLED", 503);
        await route(connection, req, res, body);
      } finally {
        if (!stateful || !sessions.has(transport.sessionId)) await closeConnection(connection);
      }
    },
    async close() {
      closed = true;
      toolPlans.close();
      approvals.close();
      for (const name of grants.keys()) grants.set(name, false);
      await Promise.all([...connections].map(closeConnection));
      connections.clear();
      sessions.clear();
    }
  };
}
