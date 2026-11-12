import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HUB_COMMIT } from "../src/mcphub-adapter.mjs";

const base = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const anchor = "const safeErrorText = unavailable ? unavailable.message : formatErrorForLogging(error);";
const declaration = "\n    const evalTimeout = (error as { code?: string })?.code === 'REQUEST_TIMEOUT';";
const flag = "...(evalTimeout ? { evalTimeout: true } : {}),\n      ";
const toolStart = "const handleCallToolRequestImpl = ";
const promptStart = "\nconst handleGetPromptRequestImpl = ";

test("准备脚本：固定原始源码拒绝异常定位，首次编译成功、再次幂等且无关函数不变", { timeout: 240000 }, async t => {
  const reference = path.join(base, ".cache", "mcphub-v1.2.2");
  const existing = path.join(base, ".cache", "mcphub-eval");
  const dependencies = path.join(existing, "node_modules");
  try {
    await access(path.join(reference, ".git"));
    await access(path.join(dependencies, "typescript", "bin", "tsc"));
  } catch {
    t.skip("固定原始仓库或既有 TypeScript 依赖不可用；准备脚本实测未执行");
    return;
  }
  const originalFiles = [reference, existing].map(root => path.join(root, "src", "services", "mcpService.ts"));
  const originals = await Promise.all(originalFiles.map(file => readFile(file)));
  const cache = path.join(base, ".cache");
  const temporary = await mkdtemp(path.join(cache, "prepare-mcphub-test-"));
  t.after(async () => {
    assert.ok(path.resolve(temporary).startsWith(cache + path.sep));
    await rm(temporary, { recursive: true, force: true });
  });
  const hub = path.join(temporary, ".cache", "mcphub-eval");
  await mkdir(path.dirname(hub), { recursive: true });
  await run("git", ["clone", "--quiet", "--no-local", "--no-checkout", reference, hub], { windowsHide: true });
  await run("git", ["-C", hub, "-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", HUB_COMMIT], { windowsHide: true });
  await symlink(dependencies, path.join(hub, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(path.join(temporary, "scripts"));
  await mkdir(path.join(temporary, "src"));
  const script = path.join(temporary, "scripts", "prepare-mcphub.mjs");
  await cp(path.join(base, "scripts", "prepare-mcphub.mjs"), script);
  await cp(path.join(base, "src", "mcphub-adapter.mjs"), path.join(temporary, "src", "mcphub-adapter.mjs"));
  const source = path.join(hub, "src", "services", "mcpService.ts");
  const original = await readFile(source, "utf8");
  const committed = await run("git", ["-C", reference, "show", HUB_COMMIT + ":src/services/mcpService.ts"], { windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(original, committed.stdout, "临时副本必须来自固定原始提交");
  assert.equal(original.split(anchor).length, 3, "固定源码在两个不同函数中包含相同 anchor");
  const start = original.indexOf(toolStart);
  const end = original.indexOf(promptStart, start);
  assert.ok(start >= 0 && end > start);
  const block = original.slice(start, end);
  const prepare = () => run(process.execPath, [script], { cwd: temporary, windowsHide: true, timeout: 120000 });

  for (const [name, invalid] of [
    ["缺少目标函数", original.replace(toolStart, "const renamedCallToolRequestImpl = ")],
    ["缺少结束边界", original.replace(promptStart, "\nconst renamedGetPromptRequestImpl = ")],
    ["目标块缺少 anchor", original.slice(0, start) + block.replace(anchor, "") + original.slice(end)],
    ["目标块重复 anchor", original.slice(0, start) + block.replace(anchor, anchor + "\n    " + anchor) + original.slice(end)]
  ]) {
    await t.test(name + "时拒绝且不写源码", async () => {
      await writeFile(source, invalid);
      await assert.rejects(prepare(), error => error.code === 1 && /MCPHUB_PREPARE_FAILED/.test(error.stderr));
      assert.ok((await readFile(source)).equals(Buffer.from(invalid)), "拒绝时源码不应发生修改");
    });
  }

  await t.test("固定原始源码首次执行并真实编译", async () => {
    await writeFile(source, original);
    const result = await prepare();
    assert.match(result.stdout, /固定版本后端已准备/);
    const patched = await readFile(source, "utf8");
    const patchedEnd = patched.indexOf(promptStart, start);
    assert.equal(patched.slice(0, start), original.slice(0, start));
    assert.equal(patched.slice(patchedEnd), original.slice(end), "Prompt 及后续所有无关函数保持原样");
    const patchedBlock = patched.slice(start, patchedEnd);
    assert.equal(patchedBlock.split(declaration).length, 2);
    assert.equal(patchedBlock.split(flag).length, 2);
    assert.equal(patchedBlock.replace(declaration, "").replace(flag, ""), block, "目标块仅增加两处超时标记代码");
    const output = path.join(hub, "dist", "services", "mcpService.js");
    const compiled = await readFile(output, "utf8");
    assert.match(compiled, /evalTimeout: true/);
    const repeated = await prepare();
    assert.match(repeated.stdout, /固定版本后端已准备/);
    assert.equal(await readFile(source, "utf8"), patched, "第二次执行源码逐字节相同");
    assert.equal(await readFile(output, "utf8"), compiled, "第二次执行编译产物相同");
  });
  for (let i = 0; i < originalFiles.length; i++) assert.deepEqual(await readFile(originalFiles[i]), originals[i], "两个原有仓库的源码均未改动");
});
