import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopChatSession } from "../src/desktop-chat-session.mjs";

const CACHE = fileURLToPath(new URL("../.cache/", import.meta.url));
const THREAD = "18610d20-1848-4d5c-9a60-a479b8e7ebcc";
const OTHER_THREAD = "01a1b903-df4b-7fa2-becf-0f84ea899391";
const MARKER = "PRIVATE_SESSION_DIAGNOSTIC";
const TOOLS = [
  "list_capabilities", "refresh_capabilities", "compare_capabilities",
  "select_capability", "report_capability_use", "report_task_status"
];
const binding = threadId => ({
  threadId, bindingSource: "host_tool_context", controlLevel: "advice_only"
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ threadId = THREAD, connect, names = TOOLS } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const modeStateDirectory = mkdtempSync(join(CACHE, "desktop-session-test-"));
  const calls = [];
  const response = {
    isError: true,
    content: [{ type: "text", text: "server validation result" }],
    structuredContent: { error: { code: "INVALID_INPUT" } }
  };
  const transport = { async close() { calls.push(["transport.close"]); } };
  const client = {
    async connect(value) {
      calls.push(["connect", value]);
      if (connect) await connect();
    },
    async listTools() {
      calls.push(["listTools"]);
      return { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) };
    },
    async callTool(request) { calls.push(["callTool", request]); return response; },
    async close() { calls.push(["client.close"]); }
  };
  const session = createDesktopChatSession({
    threadId,
    modeStateDirectory,
    clientFactory() { calls.push(["clientFactory"]); return client; },
    transportFactory(options) {
      calls.push(["transportFactory", options]);
      return transport;
    }
  });
  const close = session.close;
  session.close = async () => {
    try {
      return await close();
    } finally {
      rmSync(modeStateDirectory, { recursive: true, force: true });
    }
  };
  return { session, calls, response, client, transport };
}

test("desktop session rejects invalid host UUIDs before creating either resource", async () => {
  const messages = [];
  for (const threadId of [
    undefined, null, "", [], { threadId: THREAD }, MARKER,
    `thread://${THREAD}?hostId=local`, THREAD + "\n"
  ]) {
    let created = 0;
    await assert.rejects(async () => {
      const session = createDesktopChatSession({
        threadId,
        clientFactory() { created++; throw Error(MARKER); },
        transportFactory() { created++; throw Error(MARKER); }
      });
      await session.start();
    }, error => {
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0);
      assert.doesNotMatch(error.message, /PRIVATE|thread:\/\/|18610d20/);
      messages.push(error.message);
      return true;
    });
    assert.equal(created, 0);
  }
  assert.equal(new Set(messages).size, 1, "invalid host bindings use a fixed diagnostic");
});

test("desktop session rejects unknown and nonstring tools before lazy creation", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.calls, []);
    for (const name of ["unknown_tool", "../" + MARKER, "", null, undefined, [], ["list_capabilities"]]) {
      await assert.rejects(async () => f.session.call(name, {}));
    }
    assert.deepEqual(f.calls, []);
    await f.session.start();
    const before = f.calls.length;
    await assert.rejects(async () => f.session.call("unknown_tool", {}));
    assert.equal(f.calls.length, before, "a connected session must enforce the same allowlist");
  } finally {
    await f.session.close();
  }
});

test("desktop session shares concurrent startup and returns isolated host bindings", async () => {
  const ready = deferred();
  const f = fixture({ connect: () => ready.promise });
  try {
    const first = f.session.start();
    const second = f.session.start();
    ready.resolve();
    const values = await Promise.all([first, second]);
    assert.deepEqual(values, [binding(THREAD), binding(THREAD)]);
    assert.deepEqual(await f.session.start(), binding(THREAD));
    assert.equal(f.calls.filter(([name]) => name === "clientFactory").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "transportFactory").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "connect").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "listTools").length, 1);
    assert.deepEqual(f.calls.find(([name]) => name === "transportFactory")[1], { threadId: THREAD });
    assert.equal(f.calls.find(([name]) => name === "connect")[1], f.transport);
    values[0].threadId = OTHER_THREAD;
    const snapshot = f.session.getBinding();
    assert.deepEqual(snapshot, binding(THREAD));
    snapshot.controlLevel = MARKER;
    assert.deepEqual(f.session.getBinding(), binding(THREAD));
  } finally {
    await f.session.close();
  }
});

test("desktop session permits exactly six tools and preserves server validation and full MCP results", async () => {
  const f = fixture();
  try {
    for (const name of TOOLS) {
      const args = { unknownBusinessField: { value: MARKER }, capabilities: [] };
      const response = await f.session.call(name, args);
      assert.deepEqual(response, f.response);
      assert.deepEqual(f.calls.at(-1), ["callTool", {
        name,
        arguments: name === "compare_capabilities" ? { ...args, mode: "auto" } : args
      }]);
      assert.deepEqual(args, { unknownBusinessField: { value: MARKER }, capabilities: [] });
    }
    assert.equal(f.calls.filter(([name]) => name === "connect").length, 1);
  } finally {
    await f.session.close();
  }
});

test("desktop session refuses missing, extra and duplicate handshake tool names and cleans resources", async () => {
  for (const names of [
    TOOLS.slice(1),
    [...TOOLS, "unexpected_tool"],
    [...TOOLS.slice(0, -1), TOOLS[0]]
  ]) {
    const f = fixture({ names });
    await assert.rejects(f.session.start(), error => {
      assert.doesNotMatch(error.message, /unexpected_tool|PRIVATE/);
      return true;
    });
    await f.session.close();
    await f.session.close();
    assert.equal(f.calls.filter(([name]) => name === "client.close").length, 1);
    assert.ok(f.calls.some(([name]) => name === "transport.close" || name === "client.close"));
    assert.equal(f.calls.filter(([name]) => name === "callTool").length, 0);
  }
});

test("desktop session close immediately reclaims resources and prevents late handshake work", async () => {
  for (const fail of [false, true]) {
    const ready = deferred();
    const entered = deferred();
    const f = fixture({
      connect: () => { entered.resolve(); return ready.promise; }
    });
    const starting = f.session.start();
    const outcome = starting.then(
      () => ({ ok: true }),
      error => ({ ok: false, message: error.message })
    );
    await entered.promise;
    let closed = false;
    const closing = f.session.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, "resource cleanup is asynchronous");
    if (fail) ready.reject(Error(MARKER));
    else ready.resolve();
    const result = await outcome;
    await closing;
    await f.session.close();
    if (!result.ok) assert.doesNotMatch(result.message, /PRIVATE_SESSION_DIAGNOSTIC/);
    if (fail) assert.equal(result.ok, false);
    assert.equal(f.calls.filter(([name]) => name === "client.close").length, 1);
    assert.equal(f.calls.filter(([name]) => name === "listTools").length, 0);
    const before = f.calls.length;
    await assert.rejects(async () => f.session.call("list_capabilities", {}));
    assert.equal(f.calls.length, before);
  }
});

test("desktop session close interrupts a connect that cannot settle without resource closure", {
  timeout: 1000
}, async () => {
  const ready = deferred();
  const entered = deferred();
  const f = fixture({
    connect: () => { entered.resolve(); return ready.promise; }
  });
  const originalClose = f.client.close;
  f.client.close = async () => {
    await originalClose();
    ready.reject(Error(MARKER));
  };
  const starting = f.session.start();
  const outcome = assert.rejects(starting, error => {
    assert.doesNotMatch(error.message, /PRIVATE_SESSION_DIAGNOSTIC/);
    return true;
  });
  await entered.promise;
  const cleanup = await f.session.close();
  await outcome;
  assert.deepEqual(cleanup, { cleanupFailed: false });
  assert.equal(f.calls.filter(([name]) => name === "client.close").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "transport.close").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "listTools").length, 0);
  assert.equal(f.calls.filter(([name]) => name === "callTool").length, 0);
  await assert.rejects(f.session.start());
});

test("desktop sessions own separate clients and transport bindings across host threads", async () => {
  const first = fixture();
  const second = fixture({ threadId: OTHER_THREAD });
  try {
    await Promise.all([first.session.start(), second.session.start()]);
    assert.deepEqual(first.session.getBinding(), binding(THREAD));
    assert.deepEqual(second.session.getBinding(), binding(OTHER_THREAD));
    assert.notEqual(first.client, second.client);
    assert.notEqual(first.transport, second.transport);
    await first.session.close();
    await second.session.call("list_capabilities", {});
    assert.deepEqual(second.calls.find(([name]) => name === "transportFactory")[1], {
      threadId: OTHER_THREAD
    });
    assert.equal(second.calls.filter(([name]) => name === "client.close").length, 0);
  } finally {
    await Promise.all([first.session.close(), second.session.close()]);
  }
});
