import { DEFINITIONS } from "./registry.mjs";

function tokenizeMatch(task, keywords) {
  const normalized = String(task).toLowerCase();
  const words = keywords.filter(keyword => normalized.includes(keyword.toLowerCase()));
  return words;
}

function validateTask(task) {
  if (typeof task !== "string" || task.trim().length < 3 || task.length > 1500) {
    throw Object.assign(new Error("任务说明需要 3–1500 个字符"), { code: "INVALID_TASK" });
  }
}

// Important: deterministic matching, NOT a language model.
export function recommendTools(task, availableTools) {
  validateTask(task);
  return availableTools
    .filter(tool => tool.available === true)
    .map(tool => {
      const definition = DEFINITIONS.find(item => item.id === tool.id);
      const matched = tokenizeMatch(task, definition?.keywords ?? (tool.id === "mcp.fixture.read" ? ["mcp", "fixture", "只读验证"] : []));
      return {
        toolId: tool.id,
        name: tool.name,
        kind: tool.kind,
        provider: tool.provider,
        score: matched.length,
        recommended: matched.length > 0,
        reason: matched.length
          ? "规则匹配：任务提到 " + matched.join("、") + (tool.kind === "mcp" ? "，该工具可用于验证本地 MCP 链路。" : "，该工具可用于核实对应环境。")
          : "当前任务与该工具没有明确关联；仅作为可用工具展示。"
      };
    })
    .sort((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId));
}

export const localRecommender = Object.freeze({
  engine: "keyword-rules-not-ai",
  recommend: recommendTools
});

export async function planTools(task, discoveredTools, recommender = localRecommender) {
  validateTask(task);
  const availableTools = discoveredTools.filter(tool => tool.available === true);
  // Capture discovery before the recommender can change its input.
  const availableIds = new Set(availableTools.map(tool => tool.id));
  const candidates = await recommender.recommend(task, availableTools);
  return {
    candidates: candidates.filter(candidate => availableIds.has(candidate.toolId)),
    recommendationEngine: recommender.engine
  };
}
