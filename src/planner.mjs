import { DEFINITIONS } from "./registry.mjs";

function tokenizeMatch(task, keywords) {
  const normalized = String(task).toLowerCase();
  const words = keywords.filter(keyword => normalized.includes(keyword.toLowerCase()));
  return words;
}

// Important: deterministic matching, NOT a language model.
export function recommendTools(task, availableTools) {
  if (typeof task !== "string" || task.trim().length < 3 || task.length > 1500) {
    throw Object.assign(new Error("任务说明需要 3–1500 个字符"), { code: "INVALID_TASK" });
  }
  return availableTools
    .filter(tool => tool.available === true)
    .map(tool => {
      const definition = DEFINITIONS.find(item => item.id === tool.id);
      const matched = tokenizeMatch(task, definition?.keywords ?? []);
      return {
        toolId: tool.id,
        name: tool.name,
        score: matched.length,
        recommended: matched.length > 0,
        reason: matched.length
          ? "规则匹配：任务提到 " + matched.join("、") + "，该工具可用于核实对应环境。"
          : "当前任务与该工具没有明确关联；仅作为可用工具展示。"
      };
    })
    .sort((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId));
}
