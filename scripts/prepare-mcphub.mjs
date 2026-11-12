// Offline only. Uses the already-authorized isolated checkout and installed compiler.
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HUB_COMMIT } from "../src/mcphub-adapter.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const hub = path.join(base, ".cache", "mcphub-eval");
const run = promisify(execFile);
try {
  const result = await run("git", ["-C", hub, "rev-parse", "HEAD"], { windowsHide: true });
  if (result.stdout.trim() !== HUB_COMMIT) throw Error("VERSION");
  const compiler = path.join(hub, "node_modules", "typescript", "bin", "tsc");
  await access(compiler);
  const source = path.join(hub, "src", "services", "mcpService.ts");
  let content = await readFile(source, "utf8");
  const start = content.indexOf("const handleCallToolRequestImpl = ");
  const end = content.indexOf("\nconst handleGetPromptRequestImpl = ", start);
  if (start < 0 || end < 0) throw Error("SOURCE");
  let block = content.slice(start, end);
  if (!block.includes("...(evalTimeout ? { evalTimeout: true } : {})")) {
    const anchor = "const safeErrorText = unavailable ? unavailable.message : formatErrorForLogging(error);";
    if (block.split(anchor).length !== 2) throw Error("SOURCE");
    block = block.replace(anchor, anchor + "\n    const evalTimeout = (error as { code?: string })?.code === 'REQUEST_TIMEOUT';");
    const errorStart = block.indexOf("isError: true,", block.indexOf(anchor));
    if (errorStart < 0) throw Error("SOURCE");
    block = block.slice(0, errorStart) + "...(evalTimeout ? { evalTimeout: true } : {}),\n      " + block.slice(errorStart);
    content = content.slice(0, start) + block + content.slice(end);
    await writeFile(source, content);
  }
  await mkdir(path.join(hub, "dist"), { recursive: true });
  await run(process.execPath, [compiler, "--pretty", "false"], {
    cwd: hub, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024
  });
  console.log("MCPHub 固定版本后端已准备；没有安装依赖、构建前端或启动管理服务。");
} catch {
  console.error("MCPHUB_PREPARE_FAILED：需要项目内固定提交和原锁文件依赖；详见 CONTRIBUTING.md。没有自动安装或下载。");
  process.exitCode = 1;
}
