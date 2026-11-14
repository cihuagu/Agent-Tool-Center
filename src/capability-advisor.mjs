import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const SAFE_ID_PATTERN = "^[a-z][a-z0-9_]{1,63}$";
const SOURCE_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$";
const NAME_PATTERN = "^[\\p{L}\\p{N} ._()\\-]+$";
const SAFE_ID = new RegExp(SAFE_ID_PATTERN);
const SOURCE_ID = new RegExp(SOURCE_ID_PATTERN);
const NAME = new RegExp(NAME_PATTERN, "u");
const KINDS = ["native", "plugin", "skill", "cli"];
const AVAILABILITY = ["ready", "unavailable", "not_checked"];
const MODES = ["manual", "recommend", "auto"];
const REASONS = ["user_requested", "agent_auto"];
const OUTCOMES = ["succeeded", "failed", "not_run"];
const QUALITY = ["not_assessed", "meets_requirement", "does_not_meet"];
const STATUS_REASONS = {
  running: ["none"],
  waiting: ["awaiting_tool", "awaiting_user", "permission_required", "dependency_unavailable", "tool_error"],
  cancelled: ["user_cancelled"]
};
const UUID_BODY = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_PATTERN = `^${UUID_BODY}$`;
const EVIDENCE_PATTERN = `^(?:${UUID_BODY}|call_[A-Za-z0-9_-]{6,100})$`;
const UUID = new RegExp(UUID_PATTERN);
const EVIDENCE = new RegExp(EVIDENCE_PATTERN);
const identifierSchema = { type: "string", pattern: UUID_PATTERN };
const safeIdSchema = { type: "string", pattern: SAFE_ID_PATTERN };
const sourceIdSchema = { type: "string", minLength: 1, maxLength: 128, pattern: SOURCE_ID_PATTERN };
const recordSchema = {
  type: "object",
  properties: {
    capabilityId: { ...safeIdSchema, not: { enum: ["current_agent"] } },
    name: { type: "string", minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
    kind: { type: "string", enum: [...KINDS] },
    sourceId: { ...sourceIdSchema },
    taskTypes: {
      type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
      items: { ...safeIdSchema }
    },
    availability: { type: "string", enum: [...AVAILABILITY] },
    execution: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["host_tool", "local_cli", "agent_method", "instruction_only"] },
        id: { ...sourceIdSchema }
      },
      required: ["type"],
      additionalProperties: false,
      allOf: [{
        if: { properties: { type: { const: "instruction_only" } }, required: ["type"] },
        then: { not: { required: ["id"] } },
        else: { required: ["id"] }
      }]
    },
    priority: { type: "integer", minimum: 0, maximum: 1000, default: 100 }
  },
  required: ["capabilityId", "name", "kind", "sourceId", "taskTypes", "availability", "execution"],
  additionalProperties: false,
  allOf: [{
    if: {
      properties: {
        execution: { properties: { type: { const: "instruction_only" } }, required: ["type"] }
      },
      required: ["execution"]
    },
    then: {
      properties: {
        kind: { const: "skill" },
        availability: { enum: ["unavailable", "not_checked"] }
      }
    }
  }, {
    if: {
      properties: {
        execution: { properties: { type: { const: "agent_method" } }, required: ["type"] }
      },
      required: ["execution"]
    },
    then: {
      properties: {
        kind: { const: "skill" },
        execution: {
          properties: { id: { const: "current_agent" } },
          required: ["id"]
        }
      }
    }
  }]
};

export const CAPABILITY_ADVISOR_TOOLS = [
  {
    name: "report_task_status",
    description: "记录 Agent 自报的任务状态；不执行、授权或中断宿主调用，时间仅为本服务记录时间。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        selectionId: { ...identifierSchema },
        state: { type: "string", enum: Object.keys(STATUS_REASONS) },
        reason: { type: "string", enum: Object.values(STATUS_REASONS).flat() },
        taskLabel: { type: "string", minLength: 1, maxLength: 80, pattern: NAME_PATTERN }
      },
      required: ["selectionId", "state", "reason"],
      additionalProperties: false,
      oneOf: Object.entries(STATUS_REASONS).map(([state, reasons]) => ({
        properties: { state: { const: state }, reason: { enum: reasons } }
      }))
    }
  },
  {
    name: "list_capabilities",
    description: "分页查看项目默认条目与 Agent 提交的会话快照；来源、可用性与绑定不代表独立核验，不执行或授权。",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "integer", minimum: 0, maximum: 256, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "refresh_capabilities",
    description: "原子替换 Agent 提交的完整外部能力快照，保留项目默认条目；仅接受受限标签，不扫描、执行、授权或持久化。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        capabilities: { type: "array", maxItems: 256, items: recordSchema }
      },
      required: ["capabilities"],
      additionalProperties: false
    }
  },
  {
    name: "compare_capabilities",
    description: "比较当前目录中对本次任务直接适用的入口，按 Agent 自报可用性给出默认选择；只是路由建议，不执行、探测或授权，也不是质量排名。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        taskType: { ...safeIdSchema },
        mode: {
          type: "string", enum: [...MODES],
          description: "当前聊天本次比较模式；省略为 auto。manual 有至少两个直接适用且自报 ready 的候选时等待用户选择；recommend 先解释路由再继续，auto 直接继续；不执行或扩大权限。"
        },
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: {
            type: "object",
            properties: {
              capabilityId: { ...safeIdSchema },
              availability: { type: "string", enum: [...AVAILABILITY] }
            },
            required: ["capabilityId", "availability"],
            additionalProperties: false
          }
        }
      },
      required: ["taskType", "candidates"],
      additionalProperties: false
    }
  },
  {
    name: "select_capability",
    description: "从同一次比较的冻结候选中换选直接适用且自报 ready 的入口，保留原选择；用户要求由 Agent 转述，不独立核验用户原话，不执行或变更授权。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false
    },
    inputSchema: {
      type: "object",
      properties: {
        comparisonId: { ...identifierSchema },
        candidateId: { ...identifierSchema },
        reason: { type: "string", enum: [...REASONS] }
      },
      required: ["comparisonId", "candidateId", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "report_capability_use",
    description: "记录 Agent 自报的实际入口、结果、独立质量评价与可选调用标识；引用标识不代表后端核验，相同报告幂等，冲突报告拒绝。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      type: "object",
      properties: {
        selectionId: { ...identifierSchema },
        actualCapabilityId: {
          anyOf: [
            { ...safeIdSchema },
            { type: "null" }
          ]
        },
        outcome: { type: "string", enum: [...OUTCOMES] },
        evidenceCallId: { type: "string", pattern: EVIDENCE_PATTERN },
        quality: { type: "string", enum: [...QUALITY], default: "not_assessed" }
      },
      required: ["selectionId", "actualCapabilityId", "outcome"],
      additionalProperties: false,
      allOf: [{
        if: { properties: { outcome: { const: "not_run" } }, required: ["outcome"] },
        then: {
          properties: { actualCapabilityId: { type: "null" } },
          not: { required: ["evidenceCallId"] }
        },
        else: { properties: { actualCapabilityId: { ...safeIdSchema } } }
      }]
    }
  }
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictObject(value, required, optional = []) {
  return isObject(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(key => required.includes(key) || optional.includes(key));
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSourceId(value) {
  return typeof value === "string" && SOURCE_ID.test(value);
}

function validRecord(item) {
  if (!strictObject(item,
    ["capabilityId", "name", "kind", "sourceId", "taskTypes", "availability", "execution"],
    ["priority"]) ||
      !isSafeId(item.capabilityId) || item.capabilityId === "current_agent" ||
      typeof item.name !== "string" || item.name.length < 1 || item.name.length > 80 ||
      item.name.trim() !== item.name || !NAME.test(item.name) ||
      !KINDS.includes(item.kind) || !isSourceId(item.sourceId) ||
      !Array.isArray(item.taskTypes) || item.taskTypes.length < 1 || item.taskTypes.length > 8 ||
      !item.taskTypes.every(isSafeId) || new Set(item.taskTypes).size !== item.taskTypes.length ||
      !AVAILABILITY.includes(item.availability) ||
      (Object.hasOwn(item, "priority") &&
        (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 1000))) return false;
  if (item.execution?.type === "instruction_only") {
    return strictObject(item.execution, ["type"]) &&
      item.kind === "skill" && item.availability !== "ready";
  }
  if (item.execution?.type === "agent_method") {
    return strictObject(item.execution, ["type", "id"]) &&
      item.kind === "skill" && item.execution.id === "current_agent";
  }
  return strictObject(item.execution, ["type", "id"]) &&
    ["host_tool", "local_cli"].includes(item.execution.type) && isSourceId(item.execution.id);
}

function asciiOrder(first, second) {
  return first < second ? -1 : first > second ? 1 : 0;
}

function normalizeRecord(item) {
  return {
    capabilityId: item.capabilityId,
    name: item.name,
    kind: item.kind,
    sourceId: item.sourceId,
    taskTypes: [...item.taskTypes].sort(asciiOrder),
    availability: item.availability,
    execution: item.execution.type === "instruction_only"
      ? { type: "instruction_only" }
      : { type: item.execution.type, id: item.execution.id },
    priority: item.priority ?? 100
  };
}

function validSnapshot(args, reservedIds = new Set()) {
  if (!strictObject(args, ["capabilities"]) || !Array.isArray(args.capabilities) ||
      args.capabilities.length > 256 || args.capabilities.length + reservedIds.size > 256) return false;
  const seen = new Set(reservedIds);
  return args.capabilities.every(item => {
    if (!validRecord(item) || seen.has(item.capabilityId)) return false;
    seen.add(item.capabilityId);
    return true;
  });
}

function snapshotMap(items) {
  return new Map(items.map(normalizeRecord)
    .sort((first, second) => asciiOrder(first.capabilityId, second.capabilityId))
    .map(item => [item.capabilityId, item]));
}

function loadSeeds() {
  try {
    const data = JSON.parse(readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"));
    if (!validSnapshot(data)) throw new Error();
    return snapshotMap(data.capabilities);
  } catch {
    throw new Error("能力选择助手默认目录无法加载；请检查项目内能力目录文件。");
  }
}

function validList(args) {
  return strictObject(args, [], ["offset", "limit"]) &&
    (!Object.hasOwn(args, "offset") ||
      (Number.isInteger(args.offset) && args.offset >= 0 && args.offset <= 256)) &&
    (!Object.hasOwn(args, "limit") ||
      (Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50));
}

function validCompare(args, catalog, reservedIds) {
  if (!strictObject(args, ["taskType", "candidates"], ["mode"]) ||
      (Object.hasOwn(args, "mode") && !MODES.includes(args.mode)) ||
      !isSafeId(args.taskType) || !Array.isArray(args.candidates) ||
      args.candidates.length < 1 || args.candidates.length > 4) return false;
  const seen = new Set();
  return args.candidates.every(item => {
    if (!strictObject(item, ["capabilityId", "availability"]) ||
        !isSafeId(item.capabilityId) || !catalog.has(item.capabilityId) ||
        !AVAILABILITY.includes(item.availability) || seen.has(item.capabilityId)) return false;
    const entry = catalog.get(item.capabilityId);
    if ((!reservedIds.has(item.capabilityId) && entry.availability !== item.availability) ||
        (entry.execution.type === "instruction_only" && item.availability === "ready")) return false;
    seen.add(item.capabilityId);
    return true;
  });
}

function isIdentifier(value) {
  return typeof value === "string" && UUID.test(value);
}

function validSelect(args) {
  return strictObject(args, ["comparisonId", "candidateId", "reason"]) &&
    isIdentifier(args.comparisonId) && isIdentifier(args.candidateId) &&
    REASONS.includes(args.reason);
}

function validReport(args) {
  return strictObject(args, ["selectionId", "actualCapabilityId", "outcome"], ["evidenceCallId", "quality"]) &&
    isIdentifier(args.selectionId) && OUTCOMES.includes(args.outcome) &&
    (!Object.hasOwn(args, "quality") || QUALITY.includes(args.quality)) &&
    (!Object.hasOwn(args, "evidenceCallId") ||
      (typeof args.evidenceCallId === "string" && EVIDENCE.test(args.evidenceCallId))) &&
    (args.outcome === "not_run"
      ? args.actualCapabilityId === null && !Object.hasOwn(args, "evidenceCallId")
      : isSafeId(args.actualCapabilityId));
}

function validStatus(args) {
  return strictObject(args, ["selectionId", "state", "reason"], ["taskLabel"]) &&
    isIdentifier(args.selectionId) &&
    typeof args.state === "string" && Object.hasOwn(STATUS_REASONS, args.state) &&
    STATUS_REASONS[args.state].includes(args.reason) &&
    (!Object.hasOwn(args, "taskLabel") ||
      (typeof args.taskLabel === "string" && args.taskLabel.length >= 1 &&
        args.taskLabel.length <= 80 && args.taskLabel.trim() === args.taskLabel &&
        NAME.test(args.taskLabel)));
}

function result(data, isError = false) {
  const snapshot = structuredClone({ controlLevel: "advice_only", ...data });
  return {
    isError,
    structuredContent: snapshot,
    content: [{ type: "text", text: JSON.stringify(snapshot) }]
  };
}

function failure(status, error) {
  return result({ status, error }, true);
}

export function createCapabilityAdvisor() {
  const seeds = loadSeeds();
  const reservedIds = new Set(seeds.keys());
  let external = new Map();
  let catalog = new Map(seeds);
  let catalogRevision = 1;
  const comparisons = new Map();
  const selections = new Map();
  const reports = new Map();
  const statuses = new Map();
  let closed = false;

  function list(args) {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const entries = [...catalog.values()]
      .sort((first, second) => asciiOrder(first.capabilityId, second.capabilityId));
    return result({
      catalogRevision,
      total: entries.length,
      offset,
      limit,
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      capabilities: entries.slice(offset, offset + limit).map(item => ({
        ...item,
        catalogSource: reservedIds.has(item.capabilityId) ? "project_seed" : "agent_reported",
        availabilitySource: "agent_reported",
        bindingSource: "agent_reported"
      })),
      discovery: "agent_supplied_snapshot"
    });
  }

  function refresh(args) {
    const next = snapshotMap(args.capabilities);
    const addedCapabilityIds = [];
    const removedCapabilityIds = [];
    const updatedCapabilityIds = [];
    for (const [id, item] of next) {
      if (!external.has(id)) addedCapabilityIds.push(id);
      else if (JSON.stringify(item) !== JSON.stringify(external.get(id))) updatedCapabilityIds.push(id);
    }
    for (const id of external.keys()) {
      if (!next.has(id)) removedCapabilityIds.push(id);
    }
    const changed = addedCapabilityIds.length + removedCapabilityIds.length + updatedCapabilityIds.length > 0;
    if (changed) {
      external = next;
      catalog = new Map([...seeds, ...external]);
      catalogRevision += 1;
    }
    return result({
      catalogRevision,
      changed,
      total: catalog.size,
      addedCapabilityIds,
      removedCapabilityIds,
      updatedCapabilityIds,
      discovery: "agent_supplied_snapshot",
      verification: "agent_reported"
    });
  }

  function removeSelection(id) {
    selections.delete(id);
    reports.delete(id);
    statuses.delete(id);
  }

  function addSelection(comparisonId, candidate, reason) {
    const selection = {
      selectionId: randomUUID(),
      comparisonId,
      catalogRevision: comparisons.get(comparisonId).catalogRevision,
      candidateId: candidate.candidateId,
      capabilityId: candidate.capabilityId,
      reason,
      selectionSource: reason === "user_requested" ? "agent_reported_user_request" : "agent_auto",
      explanation: reason === "user_requested"
        ? "用户要求由 Agent 转述，未独立核验用户原话；仅记录选择，不执行或变更授权。"
        : "记录 Agent 自动选择；目录默认路由不是质量排名，不执行或变更授权。"
    };
    selections.set(selection.selectionId, selection);
    if (selections.size > 50) removeSelection(selections.keys().next().value);
    return selection;
  }

  function compare(args) {
    const mode = args.mode ?? "auto";
    const candidates = args.candidates.map(item => {
      const entry = catalog.get(item.capabilityId);
      const direct = entry.taskTypes.includes(args.taskType) && entry.execution.type !== "instruction_only";
      return {
        candidateId: randomUUID(),
        capabilityId: item.capabilityId,
        name: entry.name,
        kind: entry.kind,
        execution: structuredClone(entry.execution),
        catalogSource: reservedIds.has(item.capabilityId) ? "project_seed" : "agent_reported",
        bindingSource: "agent_reported",
        availability: item.availability,
        availabilitySource: "agent_reported",
        fit: direct ? "direct" : "not_direct",
        reason: !direct
          ? "本目录未将此入口列为该任务的直接适用能力，不能选用。"
          : item.availability === "ready"
            ? "直接适用，Agent 本次自报就绪，可按任务默认路由选用。"
            : item.availability === "unavailable"
              ? "直接适用，但 Agent 本次自报不可用，不能选用。"
              : "直接适用，但本次可用性尚未核验，需要宿主检查后再比较。",
        limitations: entry.execution.type === "agent_method"
          ? "此 Skill 绑定描述当前 Agent 已读取并采用其指令的方法，不是可调用的 MCP 工具或 CLI；来源、指令加载、绑定、可用性、实际使用与结果均为 Agent 自报，未经本助手核验，不新增执行器或执行权限。比较和报告使用 Skill 自身的能力标识，current_agent 仅为方法绑定标识。"
          : "目录收录与执行绑定仅为描述，不授予执行权限；适用任务、可用性与绑定未经本助手核验，文件操作成功不能证明界面可用。Skill 需要加载指令并核验实际入口。"
      };
    });
    const eligible = candidates.filter(item => item.fit === "direct" && item.availability === "ready");
    const needsSelection = mode === "manual" && eligible.length >= 2;
    const comparisonId = randomUUID();
    comparisons.set(comparisonId, {
      candidates,
      mode,
      needsSelection,
      catalogRevision,
      capabilityIds: new Set(catalog.keys()),
      executableIds: new Set([...catalog.values()]
        .filter(item => item.execution.type !== "instruction_only")
        .map(item => item.capabilityId))
    });
    if (comparisons.size > 20) {
      const oldest = comparisons.keys().next().value;
      comparisons.delete(oldest);
      for (const [id, selection] of selections) {
        if (selection.comparisonId === oldest) removeSelection(id);
      }
    }
    const recommended = eligible
      .sort((first, second) =>
        catalog.get(first.capabilityId).priority - catalog.get(second.capabilityId).priority ||
        asciiOrder(first.capabilityId, second.capabilityId))[0];
    return result({
      comparisonId,
      catalogRevision,
      taskType: args.taskType,
      mode,
      status: needsSelection ? "needs_selection" : recommended ? "ready" : "needs_check",
      candidates,
      recommendedCandidateId: recommended?.candidateId ?? null,
      selection: recommended && !needsSelection ? addSelection(comparisonId, recommended, "agent_auto") : null,
      explanation: `${needsSelection ? "有多个直接适用且自报 ready 的候选，等待用户选择，不执行。" : recommended ? "" : "没有直接适用且自报 ready 的候选，需要宿主检查。"}按目录优先值升序、相同值按能力标识 ASCII 顺序选择；这是路由默认值，不是速度、准确率或质量排名；本助手未探测可用性。`
    });
  }

  function select(args) {
    const comparison = comparisons.get(args.comparisonId);
    const candidate = comparison?.candidates.find(item => item.candidateId === args.candidateId);
    if (!candidate) return failure(404, "比较、候选或选择记录不存在或已过期。");
    if (comparison.catalogRevision !== catalogRevision) {
      return failure(409, "能力目录已变化，请重新比较并沿用用户原换选要求。");
    }
    if (candidate.fit !== "direct") return failure(422, "候选不直接适用于本次任务，不能选择。");
    if (candidate.availability !== "ready") return failure(422, "候选自报不可用或尚未核验，不能选择。");
    if (comparison.mode === "manual" && comparison.needsSelection && args.reason === "agent_auto") {
      return failure(422, "本次手动比较有多个可选入口，需要用户选择，不能自动换选。");
    }
    return result({ selection: addSelection(args.comparisonId, candidate, args.reason) });
  }

  function report(args) {
    const selection = selections.get(args.selectionId);
    if (!selection) return failure(404, "比较、候选或选择记录不存在或已过期。");
    const comparison = comparisons.get(selection.comparisonId);
    if (args.outcome !== "not_run" &&
        (!comparison.capabilityIds.has(args.actualCapabilityId) ||
          !comparison.executableIds.has(args.actualCapabilityId))) {
      return failure(400, "实际能力必须属于比较时的目录，并具有可执行绑定；纯指令不能报告为已执行。");
    }
    const normalized = {
      actualCapabilityId: args.actualCapabilityId,
      outcome: args.outcome,
      quality: args.quality ?? "not_assessed",
      ...(Object.hasOwn(args, "evidenceCallId") ? { evidenceCallId: args.evidenceCallId } : {})
    };
    const previous = reports.get(args.selectionId);
    if (previous) {
      if (["actualCapabilityId", "outcome", "quality", "evidenceCallId"]
        .some(key => previous[key] !== normalized[key])) {
        return failure(409, "此选择已有不同的结果报告，不能覆盖。");
      }
      return result({ report: previous });
    }
    const record = {
      reportId: randomUUID(),
      selectionId: selection.selectionId,
      catalogRevision: selection.catalogRevision,
      selectedCapabilityId: selection.capabilityId,
      ...normalized,
      verification: "agent_reported",
      matchesSelection: args.outcome === "not_run" ? null : selection.capabilityId === args.actualCapabilityId,
      explanation: "实际入口、结果与质量均为 Agent 自报；外部调用标识仅作引用，未经本助手核验。"
    };
    // One report per retained selection bounds reports to 50, below the 100 limit.
    reports.set(selection.selectionId, record);
    return result({ report: record });
  }

  function recordStatus(args) {
    const selection = selections.get(args.selectionId);
    if (!selection) return failure(404, "比较、候选或选择记录不存在或已过期。");
    if (reports.has(args.selectionId)) return failure(409, "此选择已有最终结果报告。");
    const previous = statuses.get(args.selectionId);
    if (previous && ["state", "reason", "taskLabel"].every(key => previous[key] === args[key])) {
      return result({ taskStatus: previous });
    }
    if (previous?.state === "cancelled") return failure(409, "此选择已记录取消，不能覆盖状态。");
    const taskStatus = {
      statusId: randomUUID(),
      selectionId: selection.selectionId,
      comparisonId: selection.comparisonId,
      catalogRevision: selection.catalogRevision,
      capabilityId: selection.capabilityId,
      state: args.state,
      reason: args.reason,
      ...(Object.hasOwn(args, "taskLabel") ? { taskLabel: args.taskLabel } : {}),
      verification: "agent_reported",
      recordedAt: new Date().toISOString()
    };
    statuses.set(args.selectionId, taskStatus);
    return result({ taskStatus });
  }

  return {
    dispatch(rawParams) {
      if (closed) return failure(503, "能力选择助手会话已关闭。");
      if (!strictObject(rawParams, ["name", "arguments"], ["_meta"]) ||
          (Object.hasOwn(rawParams, "_meta") && !isObject(rawParams._meta))) {
        return failure(400, "参数无效；仅接受工具声明的结构化标签与标识。");
      }
      const args = rawParams.arguments;
      if (rawParams.name === "list_capabilities" && validList(args)) return list(args);
      if (rawParams.name === "refresh_capabilities" && validSnapshot(args, reservedIds)) return refresh(args);
      if (rawParams.name === "compare_capabilities" && validCompare(args, catalog, reservedIds)) return compare(args);
      if (rawParams.name === "select_capability" && validSelect(args)) return select(args);
      if (rawParams.name === "report_capability_use" && validReport(args)) return report(args);
      if (rawParams.name === "report_task_status" && validStatus(args)) return recordStatus(args);
      return failure(400, "参数无效；仅接受工具声明的结构化标签与标识。");
    },
    close() {
      closed = true;
      comparisons.clear();
      selections.clear();
      reports.clear();
      statuses.clear();
      external.clear();
      catalog.clear();
    }
  };
}
