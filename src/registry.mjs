import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Fixed, read-only commands. Never accept client-supplied command or arguments.
export const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "runtime.node",
    name: "Node.js 版本",
    kind: "cli",
    provider: "本机命令行",
    description: "读取 Node.js 版本，用于确认 JavaScript 运行环境",
    command: "node",
    args: ["--version"],
    risk: "read",
    controllability: "controlled",
    keywords: ["node", "nodejs", "node.js", "npm", "javascript", "js", "运行环境", "开发环境"]
  }),
  Object.freeze({
    id: "runtime.git",
    name: "Git 版本",
    kind: "cli",
    provider: "本机命令行",
    description: "读取 Git 版本，用于确认代码版本管理工具是否可用",
    command: "git",
    args: ["--version"],
    risk: "read",
    controllability: "controlled",
    keywords: ["git", "仓库", "版本管理", "commit", "提交", "分支"]
  })
]);

export async function runTool(toolId) {
  const definition = DEFINITIONS.find(item => item.id === toolId);
  if (!definition) {
    throw Object.assign(new Error("UNKNOWN_TOOL: 不存在的工具"), { code: "UNKNOWN_TOOL" });
  }
  const { stdout, stderr } = await execFileAsync(definition.command, definition.args, {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 32 * 1024,
    shell: false,
    env: process.env
  });
  return {
    toolId,
    text: String(stdout || stderr || "").trim().slice(0, 500)
  };
}

export async function discoverTools() {
  return Promise.all(DEFINITIONS.map(async ({ command, args, keywords, ...publicInfo }) => {
    try {
      const result = await runTool(publicInfo.id);
      return {
        ...publicInfo,
        source: "verified-local",
        available: true,
        version: result.text
      };
    } catch (error) {
      return {
        ...publicInfo,
        source: "verified-local",
        available: false,
        version: null,
        unavailableReason: error.code === "ENOENT" ? "未找到命令" : "命令执行失败"
      };
    }
  }));
}
