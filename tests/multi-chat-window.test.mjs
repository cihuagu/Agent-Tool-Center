import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMultiChatState, normalizeHookInput } from "../src/multi-chat-state.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const rendererSource = path.join(project, "src", "status-window.mjs");
const multiSource = path.join(project, "src", "MultiChatWindow.cs");
const sessionId = "12345678-1234-1234-1234-123456789abc";
const turnId = "abcdefab-1234-1234-1234-123456789abc";
const at = "2026-11-11T12:34:56.000Z";
const frameLimit = 256 * 1024;

function snapshot() {
  return {
    kind: "multi_chat",
    version: 1,
    generatedAt: at,
    displayRequest: 0,
    sessions: [{
      sessionId,
      project: "测试项目",
      status: "tool_running",
      turnId,
      source: "hook",
      lastSeen: at,
      toolName: "server.tool:read",
      toolUseId: "call_123",
      history: [{
        event: "PostToolUse",
        at,
        toolName: "server.tool:read",
        toolUseId: "call_123"
      }]
    }],
    capacity: { maxSessions: 16, full: false }
  };
}

async function compilerPath() {
  const root = process.env.SystemRoot;
  assert.ok(root && path.isAbsolute(root), "SystemRoot must be an absolute path");
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = path.join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the fixed framework fallback.
    }
  }
  assert.fail("The system C# compiler was not found");
}

function paddedFrame(value, bytes) {
  const json = JSON.stringify(value);
  const padding = bytes - Buffer.byteLength(json, "utf8") - 1;
  assert.ok(padding >= 0);
  return json + " ".repeat(padding);
}

test("invalid renderer modes reject before native setup", async () => {
  const { createNativeRenderer } = await import("../src/status-window.mjs");
  assert.equal(typeof createNativeRenderer, "function");
  for (const mode of ["", "other", "../MultiChatWindow.cs", null, 1, {}, []]) {
    await assert.rejects(
      async () => createNativeRenderer({ onClose() {}, mode }),
      error => error instanceof Error && error.message !== "STATUS_WINDOW_UNAVAILABLE",
      `invalid mode ${JSON.stringify(mode)} must be rejected before platform setup`
    );
  }
});

test("renderer declares fixed sources and bounded UTF-8 frames", async () => {
  const source = await readFile(rendererSource, "utf8");
  assert.match(source, /single_chat/);
  assert.match(source, /multi_chat/);
  assert.match(source, /AgentStatusWindow\.cs/);
  assert.match(source, /MultiChatWindow\.cs/);
  assert.match(source, /(?:100\s*\*\s*1024|102400)/);
  assert.match(source, /(?:256\s*\*\s*1024|262144)/);
  assert.match(source, /Buffer\.byteLength\s*\(/);
  assert.match(source, /STATUS_WINDOW_SNAPSHOT_LIMIT/);
});

test("multi-chat source includes the required honest Chinese labels", async () => {
  const source = await readFile(multiSource, "utf8");
  for (const label of ["等待聊天事件", "请确认 Codex Hooks 已加载并通过审核", "本机 Hook 元数据自报", "不作为身份认证或权限依据"]) {
    assert.ok(source.includes(label), `missing UI label: ${label}`);
  }
  assert.ok(!source.includes("全局 Hooks 尚未接入"));
});

test("hook input rejects Unicode control characters in project names", () => {
  for (const control of ["\u0000", "\u001f", "\u007f", "\u0085", "\u009f"]) {
    assert.equal(normalizeHookInput({
      session_id: sessionId,
      cwd: `project${control}name`,
      hook_event_name: "SessionStart"
    }, () => new Date(at)), null, `control U+${control.charCodeAt(0).toString(16)}`);
  }
});

test("C# parser compiles and rejects invalid snapshots without opening a window", {
  skip: process.platform !== "win32" ? "requires the Windows system C# compiler" : false
}, async () => {
  const compiler = await compilerPath();
  const cache = path.join(project, ".cache");
  await mkdir(cache, { recursive: true });
  const resolvedProject = await realpath(project);
  const resolvedCache = await realpath(cache);
  assert.equal(path.relative(resolvedProject, resolvedCache), ".cache");
  const directory = await mkdtemp(path.join(resolvedCache, "multi-chat-test-"));
  const resolvedDirectory = await realpath(directory);
  const relative = path.relative(resolvedCache, resolvedDirectory);
  assert.ok(/^multi-chat-test-[^\\/]+$/.test(relative));

  try {
    const probe = path.join(resolvedDirectory, "Probe.cs");
    const executable = path.join(resolvedDirectory, "Probe.exe");
    await writeFile(probe, [
      "using System;",
      "using System.Text;",
      "internal static class Probe",
      "{",
      "    private static void Main()",
      "    {",
      "        Console.InputEncoding = new UTF8Encoding(false, true);",
      "        string line;",
      "        while ((line = Console.ReadLine()) != null)",
      "        {",
      "            try { Console.WriteLine(MultiChatWindow.ParseSnapshot(line) == null ? \"0\" : \"1\"); }",
      "            catch { Console.WriteLine(\"exception\"); }",
      "        }",
      "    }",
      "}"
    ].join("\n"), "utf8");
    const compile = spawnSync(compiler, [
      "/nologo", "/target:exe", "/codepage:65001", "/main:Probe",
      "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
      "/reference:System.Web.Extensions.dll", `/out:${executable}`, multiSource, probe
    ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(compile.status, 0, compile.error?.message ?? `${compile.stdout}\n${compile.stderr}`);

    const cases = [];
    const add = (name, value, accepted) => cases.push({ name, line: JSON.stringify(value), accepted });
    const changed = (name, edit) => {
      const value = snapshot();
      edit(value);
      add(name, value, false);
    };

    add("valid snapshot", snapshot(), true);
    const longProject = " []😀@ " + "a".repeat(53);
    assert.equal(longProject.length, 60);
    for (const projectName of ["[]", "😀", "@", " leading and trailing ", longProject]) {
      const clock = () => new Date(at);
      const state = createMultiChatState({ clock });
      for (const eventName of ["UserPromptSubmit", "PreToolUse"]) {
        const event = normalizeHookInput({
          session_id: sessionId,
          cwd: `/parent/${projectName}`,
          hook_event_name: eventName,
          turn_id: turnId,
          tool_name: "mcp/server.tool:read",
          tool_use_id: "call_123"
        }, clock);
        assert.ok(event, `normalize ${JSON.stringify(projectName)} ${eventName}`);
        assert.equal(state.accept(event), true);
      }
      const produced = state.snapshot();
      assert.equal(produced.sessions[0].project, projectName);
      assert.equal(produced.sessions[0].toolName, "mcp/server.tool:read");
      assert.equal(produced.sessions[0].history[1].toolName, "mcp/server.tool:read");
      add(`producer snapshot ${JSON.stringify(projectName)}`, produced, true);
    }
    for (const projectName of [" ", "a".repeat(60), "😀".repeat(30)]) {
      const value = snapshot();
      value.sessions[0].project = projectName;
      add(`valid project ${JSON.stringify(projectName)}`, value, true);
    }
    for (const toolName of ["a/b", "_", "a" + "/".repeat(127)]) {
      const value = snapshot();
      value.sessions[0].toolName = toolName;
      value.sessions[0].history[0].toolName = toolName;
      add(`valid tool ${toolName}`, value, true);
    }
    const empty = snapshot();
    empty.sessions = [];
    add("empty sessions", empty, true);
    const maximum = snapshot();
    maximum.displayRequest = Number.MAX_SAFE_INTEGER;
    maximum.sessions = Array.from({ length: 16 }, (_, index) => ({
      ...snapshot().sessions[0],
      sessionId: `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`,
      history: Array.from({ length: 20 }, () => ({ ...snapshot().sessions[0].history[0] }))
    }));
    maximum.capacity.full = true;
    add("maximum sessions and history", maximum, true);
    for (const status of ["connected", "running", "tool_running", "waiting", "idle", "interrupted", "ended", "unknown"]) {
      const value = snapshot();
      value.sessions[0].status = status;
      value.sessions[0].turnId = null;
      value.sessions[0].toolName = null;
      value.sessions[0].toolUseId = null;
      add(`status ${status}`, value, true);
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"]) {
      const value = snapshot();
      value.sessions[0].history[0].event = event;
      value.sessions[0].history[0].toolName = null;
      value.sessions[0].history[0].toolUseId = null;
      add(`event ${event}`, value, true);
    }

    changed("wrong kind", value => { value.kind = "single_chat"; });
    changed("wrong version", value => { value.version = 2; });
    changed("invalid generated time", value => { value.generatedAt = "not-a-date"; });
    changed("negative display request", value => { value.displayRequest = -1; });
    changed("fractional display request", value => { value.displayRequest = 1.5; });
    changed("unsafe display request", value => { value.displayRequest = 9007199254740992; });
    changed("too many sessions", value => { value.sessions = Array.from({ length: 17 }, () => value.sessions[0]); });
    changed("too much history", value => { value.sessions[0].history = Array.from({ length: 21 }, () => value.sessions[0].history[0]); });
    changed("wrong source", value => { value.sessions[0].source = "agent"; });
    changed("invalid session UUID", value => { value.sessions[0].sessionId = "session-1"; });
    changed("invalid turn UUID", value => { value.sessions[0].turnId = "turn-1"; });
    changed("unknown status", value => { value.sessions[0].status = "succeeded"; });
    changed("unknown event", value => { value.sessions[0].history[0].event = "succeeded"; });
    changed("invalid session time", value => { value.sessions[0].lastSeen = "yesterday"; });
    changed("invalid history time", value => { value.sessions[0].history[0].at = "yesterday"; });
    changed("project path", value => { value.sessions[0].project = "C:\\private\\project"; });
    changed("project forward slash", value => { value.sessions[0].project = "private/project"; });
    changed("empty project", value => { value.sessions[0].project = ""; });
    changed("project dot", value => { value.sessions[0].project = "."; });
    changed("project dotdot", value => { value.sessions[0].project = ".."; });
    changed("project control", value => { value.sessions[0].project = "project\nname"; });
    changed("project Unicode control", value => { value.sessions[0].project = "project\u0085name"; });
    changed("project too long", value => { value.sessions[0].project = "a".repeat(61); });
    changed("project too long in UTF-16 units", value => { value.sessions[0].project = "😀".repeat(30) + "a"; });
    changed("invalid tool name", value => { value.sessions[0].toolName = "tool name"; });
    changed("tool control", value => { value.sessions[0].toolName = "tool\nname"; });
    changed("invalid first tool character", value => { value.sessions[0].toolName = "/tool"; });
    changed("tool name too long", value => { value.sessions[0].toolName = "a".repeat(129); });
    changed("invalid tool use ID", value => { value.sessions[0].toolUseId = "call\nid"; });
    changed("tool use ID too long", value => { value.sessions[0].toolUseId = "a".repeat(161); });
    changed("invalid history tool name", value => { value.sessions[0].history[0].toolName = "../tool"; });
    changed("invalid history tool use ID", value => { value.sessions[0].history[0].toolUseId = "call id"; });
    changed("wrong capacity", value => { value.capacity.maxSessions = 17; });
    changed("invalid capacity flag", value => { value.capacity.full = "false"; });
    cases.push({ name: "malformed JSON", line: "{", accepted: false });
    cases.push({ name: "exact UTF-8 frame limit", line: paddedFrame(snapshot(), frameLimit), accepted: true });
    cases.push({ name: "over UTF-8 frame limit", line: paddedFrame(snapshot(), frameLimit + 1), accepted: false });

    const run = spawnSync(executable, [], {
      input: cases.map(item => item.line).join("\n") + "\n",
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    const results = run.stdout.trim().split(/\r?\n/);
    assert.equal(results.length, cases.length, run.stdout);
    for (let index = 0; index < cases.length; index++) {
      assert.equal(results[index], cases[index].accepted ? "1" : "0", cases[index].name);
    }
  } finally {
    const currentDirectory = await realpath(directory);
    assert.equal(currentDirectory, resolvedDirectory);
    assert.ok(/^multi-chat-test-[^\\/]+$/.test(path.relative(resolvedCache, currentDirectory)));
    await rm(currentDirectory, { recursive: true, force: true });
  }
});
