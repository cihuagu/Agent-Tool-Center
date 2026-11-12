import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/capability-launcher-probe.mjs", import.meta.url));
const launcherName = "启动能力选择聊天.cmd";
const prefix = "mcp_servers.capability_advisor.";
const userArgs = ["--model", "fake model", "Read README.md & keep (three lines) !"];

function parseValue(value) {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  const json = value.startsWith("[")
    ? value.replace(/'([^']*)'/g, (_, text) => JSON.stringify(text))
    : value;
  return JSON.parse(json);
}

function sessionConfig(args) {
  const overrides = {};
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") {
      forwarded.push(args[index]);
      continue;
    }
    const override = args[++index];
    assert.equal(typeof override, "string", "each session override has a value");
    const separator = override.indexOf("=");
    assert.ok(separator > 0, "session overrides use key=value");
    const key = override.slice(0, separator).trim();
    assert.equal(Object.hasOwn(overrides, key), false, "session overrides are unambiguous");
    overrides[key] = parseValue(override.slice(separator + 1).trim());
  }
  return { overrides, forwarded };
}

function sameWindowsPath(actual, expected) {
  assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase());
}

test("Windows launcher forwards quoted arguments, scopes MCP config and preserves the wrapper exit code", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, async t => {
  const cache = path.resolve(root, ".cache");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(path.join(cache, "capability-launcher-test-"));
  t.after(() => {
    assert.equal(path.dirname(scratch), cache);
    rmSync(scratch, { recursive: true, force: true });
  });

  const fakeBin = path.join(scratch, "fake bin");
  const caller = path.join(scratch, "unrelated caller directory");
  const stagedProject = path.join(scratch, "project with spaces & 中文");
  mkdirSync(fakeBin);
  mkdirSync(caller);
  mkdirSync(path.join(stagedProject, "src"), { recursive: true });
  copyFileSync(path.join(root, launcherName), path.join(stagedProject, launcherName));
  writeFileSync(path.join(stagedProject, "src", "capability-mcp.mjs"),
    "// Launcher fixture; the fake Codex wrapper does not execute this entry.\n");

  for (const role of ["codex", "node"]) {
    writeFileSync(path.join(fakeBin, `${role}.cmd`), [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      `"%CAPABILITY_TEST_NODE_EXE%" "%CAPABILITY_TEST_PROBE%" ${role} %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"), "ascii");
  }

  const runner = path.join(scratch, "invoke launcher.cmd");
  writeFileSync(runner, [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'call "%CAPABILITY_TEST_LAUNCHER%" --model "fake model" "Read README.md & keep (three lines) !"',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"), "ascii");

  for (const [label, project] of [
    ["actual project launcher", root],
    ["launcher in a path containing spaces, shell punctuation and Chinese", stagedProject],
  ]) {
    await t.test(label, () => {
      const capture = path.join(scratch, label === "actual project launcher" ? "actual" : "staged");
      mkdirSync(capture);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      Object.assign(env, {
        PATH: `${fakeBin}${path.delimiter}${path.join(process.env.SystemRoot, "System32")}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CAPABILITY_TEST_NODE_EXE: process.execPath,
        CAPABILITY_TEST_PROBE: probe,
        CAPABILITY_TEST_LAUNCHER: path.join(project, launcherName),
        CAPABILITY_TEST_CAPTURE: capture,
        CAPABILITY_TEST_EXIT: "37",
      });

      const child = spawnSync(process.env.ComSpec || "cmd.exe", [
        "/d", "/s", "/c", `""${runner}""`,
      ], {
        cwd: caller,
        env,
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 10000,
      });
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      assert.equal(child.status, 37, `wrapper exit code must survive:\n${child.stdout}\n${child.stderr}`);

      const captured = JSON.parse(readFileSync(path.join(capture, "codex.json"), "utf8"));
      sameWindowsPath(captured.cwd, project);
      const { overrides, forwarded } = sessionConfig(captured.args);
      assert.deepEqual(forwarded, userArgs, "quoted user arguments reach Codex unchanged");
      assert.deepEqual(Object.keys(overrides).sort(), [
        `${prefix}args`,
        `${prefix}command`,
        `${prefix}enabled`,
        `${prefix}enabled_tools`,
        `${prefix}tools.compare_capabilities.approval_mode`,
        `${prefix}tools.select_capability.approval_mode`,
        `${prefix}tools.report_capability_use.approval_mode`,
        `${prefix}tools.report_task_status.approval_mode`,
        `${prefix}tools.list_capabilities.approval_mode`,
        `${prefix}tools.refresh_capabilities.approval_mode`,
      ].sort());
      assert.equal(Object.hasOwn(overrides, "approval_policy"), false,
        "launcher must not override the general approval policy");
      for (const tool of ["compare_capabilities", "select_capability", "report_capability_use",
        "report_task_status", "list_capabilities", "refresh_capabilities"]) {
        assert.equal(overrides[`${prefix}tools.${tool}.approval_mode`], "approve");
      }
      assert.equal(overrides[`${prefix}command`], "node");
      assert.equal(overrides[`${prefix}enabled`], true);
      const entryArgs = overrides[`${prefix}args`];
      assert.ok(Array.isArray(entryArgs));
      assert.equal(entryArgs.length, 1);
      assert.equal(path.isAbsolute(entryArgs[0]), true);
      sameWindowsPath(entryArgs[0], path.join(project, "src", "capability-mcp.mjs"));
      const enabledTools = overrides[`${prefix}enabled_tools`];
      assert.ok(Array.isArray(enabledTools));
      assert.deepEqual([...enabledTools].sort(), [
        "compare_capabilities", "list_capabilities", "refresh_capabilities",
        "report_capability_use", "report_task_status", "select_capability",
      ]);
      assert.equal(Object.keys(overrides).length, 10);
      assert.equal(Object.hasOwn(overrides, `${prefix}env.ATC_STATUS_WINDOW`), false,
        "the original launcher does not opt into a status window");
    });
  }
});

test("floating launcher delegates to the existing launcher with only a session window override", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, async t => {
  const cache = path.resolve(root, ".cache");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(path.join(cache, "capability-launcher-test-"));
  t.after(() => {
    assert.equal(path.dirname(scratch), cache);
    rmSync(scratch, { recursive: true, force: true });
  });
  const project = path.join(scratch, "project with spaces & 中文");
  const caller = path.join(scratch, "unrelated caller directory");
  const capture = path.join(scratch, "capture");
  for (const directory of [project, caller, capture]) mkdirSync(directory);
  const floatingName = "启动悬浮状态聊天.cmd";
  copyFileSync(path.join(root, floatingName), path.join(project, floatingName));
  writeFileSync(path.join(project, launcherName), [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `"%CAPABILITY_TEST_NODE_EXE%" "%CAPABILITY_TEST_PROBE%" codex %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"), "ascii");
  const runner = path.join(scratch, "invoke floating launcher.cmd");
  writeFileSync(runner, [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'call "%CAPABILITY_TEST_LAUNCHER%" --model "fake model" "Read README.md & keep (three lines) !"',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"), "ascii");
  const child = spawnSync(process.env.ComSpec || "cmd.exe", [
    "/d", "/s", "/c", `""${runner}""`,
  ], {
    cwd: caller,
    env: {
      ...process.env,
      CAPABILITY_TEST_NODE_EXE: process.execPath,
      CAPABILITY_TEST_PROBE: probe,
      CAPABILITY_TEST_LAUNCHER: path.join(project, floatingName),
      CAPABILITY_TEST_CAPTURE: capture,
      CAPABILITY_TEST_EXIT: "37",
    },
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: 10000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 37, `${child.stdout}\n${child.stderr}`);
  const captured = JSON.parse(readFileSync(path.join(capture, "codex.json"), "utf8"));
  const { overrides, forwarded } = sessionConfig(captured.args);
  assert.deepEqual(forwarded, userArgs);
  assert.deepEqual(overrides, { [`${prefix}env.ATC_STATUS_WINDOW`]: "1" });
  sameWindowsPath(captured.cwd, project);
});
