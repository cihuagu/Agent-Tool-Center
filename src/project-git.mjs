import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const executeFile = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PREFIX = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const COUNT_KEYS = ["total", "staged", "unstaged", "untracked", "conflicts"];
const MAX_OUTPUT = 256 * 1024;

function failure() {
  return Object.assign(new Error("本项目 Git 工作区检查失败；未记录原始诊断内容"), {
    code: "PROJECT_GIT_FAILED"
  });
}

export function validateProjectGitSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== COUNT_KEYS.length + 1 ||
      Object.keys(value).some(key => ![...COUNT_KEYS, "clean"].includes(key)) ||
      COUNT_KEYS.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
      COUNT_KEYS.some(key => value[key] > value.total) ||
      typeof value.clean !== "boolean" || value.clean !== (value.total === 0) ||
      value.untracked + value.conflicts + Math.max(value.staged, value.unstaged) > value.total ||
      (value.total > 0 && value.staged + value.unstaged + value.untracked + value.conflicts < value.total)) {
    throw failure();
  }
  return Object.fromEntries([...COUNT_KEYS, "clean"].map(key => [key, value[key]]));
}

export function projectGitSummaryText(value) {
  const summary = validateProjectGitSummary(value);
  return `工作区${summary.clean ? "干净" : "存在变更"}：共 ${summary.total} 项，已暂存 ${summary.staged} 项，未暂存 ${summary.unstaged} 项，未跟踪 ${summary.untracked} 项，冲突 ${summary.conflicts} 项。同一路径可同时有已暂存和未暂存变更；未跟踪项可能为目录。`;
}

export function parsePorcelain(output) {
  if (!Buffer.isBuffer(output) || output.length > MAX_OUTPUT ||
      (output.length && output.at(-1) !== 0)) throw failure();
  const summary = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, clean: true };
  if (!output.length) return summary;
  // Latin-1 preserves byte boundaries; file names are never decoded or returned.
  const records = output.toString("latin1").split("\0");
  records.pop();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") throw failure();
    const status = record.slice(0, 2);
    const conflict = CONFLICTS.has(status);
    if (status !== "??" && !conflict &&
        (!/^[ MTADRC][ MTADRC]$/.test(status) || status === "  ")) throw failure();
    summary.total++;
    if (status === "??") {
      summary.untracked++;
    } else if (conflict) {
      summary.conflicts++;
    } else {
      if (status[0] !== " ") summary.staged++;
      if (status[1] !== " ") summary.unstaged++;
      if (/[RC]/.test(status)) {
        index++;
        if (index >= records.length || !records[index].length) throw failure();
      }
    }
  }
  summary.clean = summary.total === 0;
  return validateProjectGitSummary(summary);
}

function normalized(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Injection is for local tests only. Neither HTTP nor MCP selects a directory or command.
export function createProjectGitRunner({ execute = executeFile, resolveRealpath = realpath, env = process.env } = {}) {
  return async function runProjectGit() {
    try {
      const options = {
        cwd: PROJECT_ROOT,
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: MAX_OUTPUT,
        encoding: "buffer",
        env: Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)))
      };
      const root = await resolveRealpath(PROJECT_ROOT);
      const top = await execute("git", [...PREFIX, "rev-parse", "--show-toplevel"], options);
      if (!Buffer.isBuffer(top.stdout) || top.stdout.length > MAX_OUTPUT ||
          !top.stdout.length || top.stdout.includes(0)) throw failure();
      const topText = new TextDecoder("utf-8", { fatal: true }).decode(top.stdout);
      if (!topText.endsWith("\n")) throw failure();
      const reportedRoot = topText.replace(/\r?\n$/, "");
      if (!path.isAbsolute(reportedRoot) ||
          normalized(await resolveRealpath(reportedRoot)) !== normalized(root)) throw failure();
      const result = await execute("git", [
        ...PREFIX, "status", "--porcelain=v1", "-z", "--untracked-files=normal"
      ], options);
      return parsePorcelain(result.stdout);
    } catch {
      throw failure();
    }
  };
}

export const runProjectGit = createProjectGitRunner();
