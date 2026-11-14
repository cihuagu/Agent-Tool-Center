import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir, mkdtemp, readFile, writeFile, readdir, rename, rm, symlink, link
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDesktopChatSession } from "../src/desktop-chat-session.mjs";

const run = promisify(execFile);
const CACHE = fileURLToPath(new URL("../.cache/", import.meta.url));
const ENTRY = new URL("../src/desktop-chat-session.mjs", import.meta.url).href;
const THREAD = "18610d20-1848-4d5c-9a60-a479b8e7ebcc";
const OTHER = "01a1b903-df4b-7fa2-becf-0f84ea899391";
const SECRET = "PRIVATE_MODE_STATE_DIAGNOSTIC";
const TOOLS = [
  "list_capabilities", "refresh_capabilities", "compare_capabilities",
  "select_capability", "report_capability_use", "report_task_status"
];
const snapshot = (mode, threadId = THREAD) => ({
  mode, scope: "current_chat", threadId
});

async function workspace(t) {
  await mkdir(CACHE, { recursive: true });
  const root = await mkdtemp(join(CACHE, "desktop-mode-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "modes");
  await mkdir(directory);
  return { root, directory, record: join(directory, `${THREAD}.json`) };
}

function session(t, directory, threadId = THREAD) {
  const calls = [];
  const response = { isError: false, structuredContent: { accepted: true } };
  const value = createDesktopChatSession({
    threadId,
    modeStateDirectory: directory,
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: TOOLS.map(name => ({ name })) }; },
      async callTool(request) { calls.push(request); return response; },
      async close() {}
    }),
    transportFactory: () => ({ async close() {} })
  });
  t.after(() => value.close());
  return { value, calls, response };
}

async function rejected(operation) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "the operation must reject with an error");
  assert.equal(typeof caught.code, "string");
  assert.ok(caught.code.length > 0);
  assert.ok(caught.message.length > 0);
  assert.doesNotMatch(caught.message, /PRIVATE|18610d20|[A-Za-z]:\\|\/|\\|ENOENT|EACCES|EPERM|SyntaxError/);
  assert.equal(caught.cause, undefined, "raw filesystem diagnostics must not escape");
  return { code: caught.code, message: caught.message };
}

test("missing mode defaults to auto without writing a record or starting MCP", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory, THREAD.toUpperCase());
  assert.deepEqual(await f.value.getMode(), snapshot("auto"));
  assert.deepEqual(await f.value.getMode(), snapshot("auto"));
  assert.deepEqual(await readdir(w.directory), []);
  assert.deepEqual(f.calls, []);
});

test("only the three modes are accepted; invalid input preserves the saved mode", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  await f.value.setMode("manual");
  const before = await readFile(w.record);
  const errors = [];
  for (const mode of [undefined, null, "", "AUTO", "automatic", SECRET, {}, [], 0]) {
    errors.push(await rejected(() => f.value.setMode(mode)));
    assert.deepEqual(await readFile(w.record), before);
    assert.deepEqual(await f.value.getMode(), snapshot("manual"));
  }
  assert.ok(errors.every(error => JSON.stringify(error) === JSON.stringify(errors[0])));
  assert.deepEqual(f.calls, []);
});

test("mode switches persist only version and mode and affect every new comparison", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  for (const mode of ["manual", "recommend", "auto"]) {
    assert.deepEqual(await f.value.setMode(mode), snapshot(mode));
    const state = JSON.parse(await readFile(w.record, "utf8"));
    assert.deepEqual(Object.keys(state).sort(), ["mode", "version"]);
    assert.equal(state.mode, mode);
    assert.equal(Number.isInteger(state.version), true);
    assert.deepEqual(await f.value.getMode(), snapshot(mode));
    for (let index = 0; index < 2; index++) {
      const args = Object.freeze({
        taskType: "research",
        candidates: Object.freeze([{ capabilityId: SECRET }])
      });
      const before = JSON.stringify(args);
      assert.deepEqual(await f.value.call("compare_capabilities", args), f.response);
      assert.deepEqual(f.calls.at(-1), {
        name: "compare_capabilities", arguments: { ...args, mode }
      });
      assert.equal(JSON.stringify(args), before);
    }
    const args = Object.freeze({ mode, taskType: "research" });
    await f.value.call("compare_capabilities", args);
    assert.deepEqual(f.calls.at(-1).arguments, args);
  }
  assert.deepEqual(await readdir(w.directory), [`${THREAD}.json`]);
});

test("conflicting explicit modes reject without forwarding or mutating arguments", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  for (const saved of ["manual", "recommend", "auto"]) {
    await f.value.setMode(saved);
    for (const mode of ["manual", "recommend", "auto", SECRET, null]) {
      if (mode === saved) continue;
      const args = Object.freeze({ mode, taskType: "research" });
      const before = f.calls.length;
      await rejected(() => f.value.call("compare_capabilities", args));
      assert.equal(f.calls.length, before);
      assert.deepEqual(args, { mode, taskType: "research" });
      assert.deepEqual(await f.value.getMode(), snapshot(saved));
    }
  }
});

test("other five tools retain their arguments and MCP result under manual mode", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  await f.value.setMode("manual");
  for (const name of TOOLS.filter(name => name !== "compare_capabilities")) {
    const args = Object.freeze({ mode: SECRET, payload: SECRET });
    assert.deepEqual(await f.value.call(name, args), f.response);
    assert.deepEqual(f.calls.at(-1), { name, arguments: args });
  }
});

test("close and reconstruction retain mode; existing bridges reread changes; UUIDs isolate state", async t => {
  const w = await workspace(t);
  const first = session(t, w.directory);
  const second = session(t, w.directory, THREAD.toUpperCase());
  const other = session(t, w.directory, OTHER);
  await first.value.setMode("manual");
  assert.deepEqual(await second.value.getMode(), snapshot("manual"));
  await second.value.setMode("recommend");
  await first.value.call("compare_capabilities", {});
  assert.equal(first.calls.at(-1).arguments.mode, "recommend");
  await first.value.close();
  const rebuilt = session(t, w.directory);
  assert.deepEqual(await rebuilt.value.getMode(), snapshot("recommend"));
  assert.deepEqual(await other.value.getMode(), snapshot("auto", OTHER));
  await other.value.setMode("auto");
  assert.deepEqual(await rebuilt.value.getMode(), snapshot("recommend"));
});

test("independent Node processes read and update the same chat record with mocked factories", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  await f.value.setMode("manual");
  const source = `
    import { createDesktopChatSession } from ${JSON.stringify(ENTRY)};
    const session = createDesktopChatSession({
      threadId: ${JSON.stringify(THREAD)},
      modeStateDirectory: ${JSON.stringify(w.directory)},
      clientFactory: () => { throw Error("MCP must remain lazy"); },
      transportFactory: () => { throw Error("No real session"); }
    });
    const before = await session.getMode();
    await session.setMode("recommend");
    console.log(JSON.stringify({ before, after: await session.getMode() }));
    await session.close();
  `;
  const result = await run(process.execPath, ["--input-type=module", "--eval", source]);
  assert.deepEqual(JSON.parse(result.stdout), {
    before: snapshot("manual"), after: snapshot("recommend")
  });
  assert.deepEqual(await f.value.getMode(), snapshot("recommend"));
});

test("malformed and unsupported records fail closed with fixed sanitized errors", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  const errors = [];
  for (const content of [
    SECRET, "{", "null", "[]", "{}",
    JSON.stringify({ version: 1, mode: SECRET }),
    JSON.stringify({ version: 999, mode: "auto" }),
    JSON.stringify({ version: 1, mode: "manual", credential: SECRET })
  ]) {
    await writeFile(w.record, content);
    errors.push(await rejected(() => f.value.getMode()));
    const before = f.calls.length;
    await rejected(() => f.value.call("compare_capabilities", {}));
    assert.equal(f.calls.length, before);
    assert.equal(await readFile(w.record, "utf8"), content);
  }
  assert.ok(errors.every(error => JSON.stringify(error) === JSON.stringify(errors[0])));
});

test("non-file and linked records cannot be read, overwritten, or used for comparison", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  await mkdir(w.record);
  await rejected(() => f.value.getMode());
  await rejected(() => f.value.setMode("manual"));
  await rejected(() => f.value.call("compare_capabilities", {}));
  await rm(w.record, { recursive: true });
  const target = join(w.root, "target.json");
  const original = JSON.stringify({ version: 1, mode: "manual" });
  await writeFile(target, original);
  try {
    await symlink(target, w.record, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.diagnostic("File symlink coverage unavailable under this host's permissions");
      return;
    }
    throw error;
  }
  await rejected(() => f.value.getMode());
  await rejected(() => f.value.setMode("auto"));
  await rejected(() => f.value.call("compare_capabilities", {}));
  assert.equal(await readFile(target, "utf8"), original);
  assert.deepEqual(f.calls, []);
});

test("hard-linked mode records reject reads, writes, and comparisons without changing either file", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  const target = join(w.root, "target.json");
  const original = Buffer.from(JSON.stringify({ version: 1, mode: "manual" }));
  await writeFile(target, original);
  await link(target, w.record);
  for (const operation of [
    () => f.value.getMode(),
    () => f.value.setMode("auto"),
    () => f.value.call("compare_capabilities", {})
  ]) {
    await rejected(operation);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(await readFile(w.record), original);
  }
});

test("trusted directory injection rejects paths escaping project .cache before forwarding", async t => {
  const w = await workspace(t);
  for (const directory of [
    resolve(CACHE, ".."),
    resolve(CACHE, "..", ".cache-escape", SECRET),
    join(w.directory, "..", "..", "..", SECRET)
  ]) {
    let forwarded = false;
    await rejected(async () => {
      const value = createDesktopChatSession({
        threadId: THREAD,
        modeStateDirectory: directory,
        clientFactory: () => { forwarded = true; throw Error(SECRET); },
        transportFactory: () => { forwarded = true; throw Error(SECRET); }
      });
      try {
        await value.getMode();
        await value.setMode("manual");
      } finally {
        await value.close();
      }
    });
    assert.equal(forwarded, false);
  }
});

test("directory links are rejected even when their destination is inside project .cache", async t => {
  const w = await workspace(t);
  const alias = join(w.root, "alias");
  try {
    await symlink(w.directory, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Directory links unavailable under this host's permissions");
      return;
    }
    throw error;
  }
  await rejected(async () => {
    const f = session(t, alias);
    await f.value.getMode();
    await f.value.setMode("manual");
  });
  assert.deepEqual(await readdir(w.directory), []);
});

test("failed storage writes preserve the previous record and never permit comparisons", async t => {
  const w = await workspace(t);
  const f = session(t, w.directory);
  await f.value.setMode("manual");
  const original = await readFile(w.record);
  const backup = join(w.root, "saved-modes");
  await rename(w.directory, backup);
  await writeFile(w.directory, SECRET);
  const errors = [];
  for (const mode of ["auto", "recommend"]) {
    errors.push(await rejected(() => f.value.setMode(mode)));
    await rejected(() => f.value.call("compare_capabilities", {}));
    assert.deepEqual(await readFile(join(backup, `${THREAD}.json`)), original);
  }
  assert.deepEqual(errors[0], errors[1]);
  assert.deepEqual(f.calls, []);
  await rm(w.directory);
  await rename(backup, w.directory);
  assert.deepEqual(await f.value.getMode(), snapshot("manual"));
  assert.deepEqual(await readFile(w.record), original);
  assert.deepEqual(await readdir(w.directory), [`${THREAD}.json`]);
});
