import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createCodexObserver, createCodexSource, selectedThread } from "../src/codex-observer.mjs";
import { createApp } from "../src/server.mjs";
import { parseTraceTail } from "../src/codex-trace.mjs";

const THREAD = "01a1b903-df4b-7fa2-becf-0f84ea899391";
const TURN = "01a1c947-9c60-7b32-bb9c-77c8a9ed85ad";
const CALL = "exec-e4747794-b41b-414e-b4a1-6d1311eead43";
const SECRET = "fixture-secret-command-output-path-message";
const item = overrides => ({
  id: CALL, type: "commandExecution", status: "completed",
  exitCode: 0, durationMs: 345,
  startedAtMs: 1794378282328, completedAtMs: 1794378282674,
  command: SECRET, aggregatedOutput: SECRET, cwd: SECRET,
  ...overrides
});
const turns = items => ({
  data: [{ id: TURN, items: [...items, { type: "reasoning", text: SECRET }] }],
  nextCursor: SECRET
});

function fixture(initial = turns([item()]), options = {}) {
  let response = initial;
  let reads = 0;
  let closes = 0;
  const events = [];
  const observer = createCodexObserver({
    publish: event => events.push(event),
    createSource: () => ({
      readTurns: async id => {
        assert.equal(id, THREAD);
        reads++;
        if (response instanceof Error) throw response;
        return response;
      },
      close: async () => { closes++; }
    }),
    pollIntervalMs: 60000,
    ...options
  });
  return {
    observer, events,
    respond: value => { response = value; },
    reads: () => reads, closes: () => closes
  };
}

test("selection accepts only explicit local UUIDs and invalid input never creates a source", async () => {
  let spawns = 0;
  const observer = createCodexObserver({
    publish() {}, createSource() { spawns++; throw Error(SECRET); }
  });
  assert.equal(selectedThread(THREAD), THREAD);
  assert.equal(selectedThread("thread://" + THREAD + "?hostId=local"), THREAD);
  for (const threadId of [
    "", "all", "../sessions", "thread://" + THREAD + "?hostId=remote",
    "https://example.com/" + THREAD, THREAD + "\n", THREAD + " & whoami"
  ]) await assert.rejects(observer.start({ threadId }), { code: "INVALID_OBSERVER_THREAD" });
  await assert.rejects(observer.start({ threadId: THREAD, command: SECRET }), { code: "INVALID_OBSERVER_INPUT" });
  assert.equal(spawns, 0);
  assert.equal(observer.getStatus().enabled, false);
});

test("historical outcomes publish once, redact fixtures and preserve actual IDs and timestamps across reattach", async t => {
  const f = fixture();
  t.after(() => f.observer.stop());
  await f.observer.start({ threadId: THREAD });
  assert.equal(f.events.length, 1);
  const event = f.events[0];
  assert.equal(event.status, "succeeded");
  assert.equal(event.source, "codex-observer");
  assert.equal(event.controllability, "observable");
  assert.equal(event.toolId, "codex.native.terminal");
  assert.equal(event.threadId, THREAD);
  assert.equal(event.turnId, TURN);
  assert.equal(event.callId, CALL);
  assert.equal(event.exitCode, 0);
  assert.equal(event.durationMs, 345);
  assert.equal(event.at, new Date(1794378282674).toISOString());
  assert.equal(event.timestampSource, "source");
  assert.ok(event.recordedAt);
  await f.observer.poll();
  await f.observer.stop();
  await f.observer.start({ threadId: "thread://" + THREAD + "?hostId=local" });
  assert.equal(f.events.length, 1);
  f.respond(turns([item({ status: "inProgress", exitCode: null, completedAtMs: null })]));
  await f.observer.poll();
  assert.equal(f.events.at(-1).status, "running");
  assert.equal(f.events.at(-1).at, new Date(1794378282328).toISOString());
  await f.observer.poll();
  assert.equal(f.events.length, 2);
  assert.equal(f.observer.getStatus().coverage.turnCount, 1);
  assert.equal(f.observer.getStatus().coverage.hasMore, true);
  assert.doesNotMatch(JSON.stringify({ events: f.events, status: f.observer.getStatus() }), new RegExp(SECRET));
});

test("running to completed is a real status update and terminal mappings skip insufficient evidence", async t => {
  const f = fixture(turns([item({ status: "inProgress", exitCode: null, completedAtMs: null })]));
  t.after(() => f.observer.stop());
  await f.observer.start({ threadId: THREAD });
  f.respond(turns([
    item(),
    item({ id: "nonzero", exitCode: 7 }),
    item({ id: "failed", status: "failed", exitCode: null }),
    item({ id: "declined", status: "declined", exitCode: null }),
    item({ id: "missing-exit", exitCode: null }),
    item({ id: "unknown", status: "unknown", exitCode: 0 }),
    item({ id: "no-source-time", startedAtMs: null, completedAtMs: null })
  ]));
  await f.observer.poll();
  await f.observer.poll();
  assert.deepEqual(f.events.map(event => event.status), [
    "running", "succeeded", "failed", "failed", "denied", "succeeded"
  ]);
  assert.equal(f.observer.getStatus().skippedItems, 2);
  assert.equal(f.events.at(-1).timestampSource, "observation");
  assert.equal(Object.hasOwn(f.events.at(-1), "at"), false);
});

test("reads are serial, stop invalidates pending data and closes only the owned source", async () => {
  let resolveRead;
  let reads = 0;
  let closes = 0;
  const events = [];
  const observer = createCodexObserver({
    publish: event => events.push(event),
    createSource: () => ({
      readTurns: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); },
      close: async () => { closes++; }
    }),
    pollIntervalMs: 5, readTimeoutMs: 100
  });
  const starting = observer.start({ threadId: THREAD });
  await new Promise(resolve => setImmediate(resolve));
  const pollA = observer.poll();
  const pollB = observer.poll();
  assert.equal(pollA, pollB);
  assert.equal(reads, 1);
  await assert.rejects(observer.start({ threadId: THREAD }), { code: "OBSERVER_BUSY" });
  const stopping = observer.stop();
  resolveRead(turns([item()]));
  await Promise.all([starting, stopping, pollA, pollB]);
  assert.equal(events.length, 0);
  assert.equal(closes, 1);
  assert.equal(observer.getStatus().state, "stopped");
  await observer.stop();
  assert.equal(closes, 1);
});

test("read errors and timeouts stop the source and expose only bounded fixed diagnostics", async () => {
  const failure = fixture(new Error(SECRET));
  await failure.observer.start({ threadId: THREAD });
  assert.equal(failure.closes(), 1);
  assert.equal(failure.observer.getStatus().state, "error");
  assert.equal(failure.observer.getStatus().lastErrorCode, "OBSERVER_READ_FAILED");
  assert.equal(failure.events.length, 0);
  assert.doesNotMatch(JSON.stringify(failure.observer.getStatus()), new RegExp(SECRET));
  await failure.observer.stop();

  let closed = 0;
  const timeout = createCodexObserver({
    publish() { assert.fail("timed out reads cannot publish"); },
    readTimeoutMs: 15,
    createSource: () => ({
      readTurns: () => new Promise(() => {}),
      close: async () => { closed++; }
    })
  });
  await timeout.start({ threadId: THREAD });
  assert.equal(timeout.getStatus().lastErrorCode, "OBSERVER_RPC_TIMEOUT");
  assert.equal(closed, 1);
  await timeout.stop();
});

test("injected oversized responses are refused and dedupe storage has a finite retention window", async t => {
  const f = fixture(turns([item({ aggregatedOutput: "x".repeat(8 * 1024 * 1024) })]));
  await f.observer.start({ threadId: THREAD });
  assert.equal(f.observer.getStatus().lastErrorCode, "OBSERVER_RESPONSE_LIMIT");
  assert.equal(f.events.length, 0);
  assert.equal(f.closes(), 1);
  await f.observer.stop();

  const small = fixture(turns([item({ id: "one" }), item({ id: "two" })]), { maxSeen: 2 });
  t.after(() => small.observer.stop());
  await small.observer.start({ threadId: THREAD });
  await small.observer.poll();
  assert.equal(small.events.length, 2);
  small.respond(turns([item({ id: "three" })]));
  await small.observer.poll();
  small.respond(turns([item({ id: "one" })]));
  await small.observer.poll();
  assert.equal(small.events.length, 4, "only evicted entries can be observed again");
});

function fakeProcess(onMessage) {
  const child = new EventEmitter();
  child.pid = 123456;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; return true; };
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      try {
        for (const line of chunk.toString().trim().split("\n")) {
          const message = JSON.parse(line);
          queueMicrotask(() => onMessage(message, child));
        }
        done();
      } catch (error) { done(error); }
    }
  });
  return child;
}

function windowsClient(onMessage, options = {}) {
  const launches = [];
  const child = fakeProcess(onMessage);
  const source = createCodexSource({
    platform: "win32",
    spawnProcess(command, args, settings) {
      launches.push({ command, args, settings });
      if (command === "cmd.exe") return child;
      const killer = new EventEmitter();
      killer.kill = () => true;
      queueMicrotask(() => killer.emit("exit", 0));
      return killer;
    },
    ...options
  });
  return { source, launches, child };
}

const mcpItem = overrides => ({
  type: "mcpToolCall", id: "mcp-call-fixture",
  server: "fixture.server", tool: "tools.lookup", status: "completed",
  startedAtMs: 1794378282328, completedAtMs: 1794378282674, durationMs: 346,
  arguments: { input: SECRET }, result: SECRET, error: { message: SECRET },
  ...overrides
});

test("desktop MCP observation maps actual source status and numeric time without business bodies", async t => {
  const f = fixture(turns([
    mcpItem({ id: "running", status: "inProgress", completedAtMs: null }),
    mcpItem(),
    mcpItem({ id: "failed", status: "failed" }),
    mcpItem({
      id: "unknown-time", startedAtMs: "1794378282328",
      completedAtMs: null, durationMs: -1
    })
  ]), { includeMcp: true });
  t.after(() => f.observer.stop());
  await f.observer.start({ threadId: THREAD });
  assert.deepEqual(f.events.map(event => [event.callId, event.status, event.sourceStatus]), [
    ["running", "running", "inProgress"],
    ["mcp-call-fixture", "completed", "completed"],
    ["failed", "failed", "failed"],
    ["unknown-time", "completed", "completed"]
  ]);
  for (const event of f.events) {
    assert.equal(event.source, "codex-observer");
    assert.equal(event.controllability, "observable");
    assert.equal(event.toolId, "codex.native.mcp");
    assert.equal(event.serverName, "fixture.server");
    assert.equal(event.toolName, "tools.lookup");
    assert.equal(event.turnId, TURN);
    assert.equal(event.threadId, THREAD);
  }
  assert.equal(f.events[0].at, new Date(1794378282328).toISOString());
  assert.equal(f.events[1].at, new Date(1794378282674).toISOString());
  assert.equal(f.events[1].startedAt, new Date(1794378282328).toISOString());
  assert.equal(f.events[1].completedAt, new Date(1794378282674).toISOString());
  assert.equal(f.events[1].durationMs, 346);
  for (const key of ["at", "startedAt", "completedAt", "durationMs"]) {
    assert.equal(Object.hasOwn(f.events[3], key), false);
  }
  await f.observer.poll();
  assert.equal(f.events.length, 4);
  assert.doesNotMatch(JSON.stringify(f.events), /fixture-secret|arguments|result|error/);
});

test("MCP observation is opt-in and rejects unsafe or coerced metadata", async t => {
  const records = [
    mcpItem(),
    mcpItem({ id: "bad-server", server: "../" + SECRET }),
    mcpItem({ id: "array-server", server: ["fixture.server"] }),
    mcpItem({ id: "array-tool", tool: ["tools.lookup"] }),
    mcpItem({ id: "long-tool", tool: "x".repeat(129) }),
    mcpItem({ id: "array-status", status: ["completed"] }),
    mcpItem({ id: "unknown-status", status: "succeeded" }),
    mcpItem({ id: "bad\nid" })
  ];
  const strict = fixture(turns(records));
  const desktop = fixture(turns(records), { includeMcp: true });
  t.after(async () => { await strict.observer.stop(); await desktop.observer.stop(); });
  await strict.observer.start({ threadId: THREAD });
  assert.deepEqual(strict.events, []);
  assert.equal(Object.hasOwn(strict.observer.getStatus().coverage.raw, "unscopedItems"), false);
  await desktop.observer.start({ threadId: THREAD });
  assert.deepEqual(desktop.events.map(event => event.callId), ["mcp-call-fixture"]);
  assert.equal(desktop.observer.getStatus().skippedItems, 7);
  assert.doesNotMatch(JSON.stringify(desktop.events), new RegExp(SECRET));
});

test("desktop source separates unknown-turn trace items without manufacturing or borrowing turns", async () => {
  const raw = {
    type: "observedToolCall", id: "tail-call", turnId: null, scope: "thread_tail",
    rawKind: "custom_tool_call", toolName: "exec", status: "completed"
  };
  for (const includeUnscopedTrace of [false, true]) {
    const f = windowsClient((message, child) => {
      if (!message.id) return;
      const result = message.method === "initialize" ? { codexHome: SECRET }
        : message.method === "thread/read" ? { thread: { id: THREAD, path: SECRET } }
        : turns([item()]);
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }, {
      includeUnscopedTrace,
      traceReader: async () => ({
        items: [raw, { ...raw, id: "known-call", turnId: TURN, scope: undefined }],
        coverage: { available: true, unscopedItems: 1 }
      })
    });
    try {
      const response = await f.source.readTurns(THREAD);
      assert.equal(response.data.length, 1);
      assert.deepEqual(response.data[0].items.filter(value =>
        value.type === "observedToolCall").map(value => value.id), ["known-call"]);
      assert.equal(Object.hasOwn(response, "unscopedTraceItems"), includeUnscopedTrace);
      if (includeUnscopedTrace) assert.deepEqual(response.unscopedTraceItems, [raw]);
    } finally {
      await f.source.close();
    }
  }
});

test("desktop observer accepts only explicitly unknown-turn raw trace metadata and reports its coverage", async t => {
  const raw = {
    type: "observedToolCall", id: "tail-call", turnId: null, scope: "thread_tail",
    rawKind: "function_call", toolName: "tools.lookup", status: "completed",
    sourceTimestamp: "2026-11-11T07:05:06.685Z", arguments: SECRET, output: SECRET
  };
  const response = {
    data: [{ id: TURN, items: [{ ...raw, id: "known-call", turnId: TURN, scope: undefined }] }],
    unscopedTraceItems: [
      raw,
      { ...raw, id: "wrong-turn", turnId: TURN },
      { ...raw, id: "wrong-scope", scope: "recent_turns" },
      { ...raw, id: "unsafe-tool", toolName: "../" + SECRET },
      { ...raw, id: "wrong-kind", rawKind: "mcpToolCall" }
    ],
    traceCoverage: { available: true, truncated: true, unscopedItems: 1 }
  };
  const strict = fixture(response);
  const desktop = fixture(response, { includeUnscopedTrace: true });
  t.after(async () => { await strict.observer.stop(); await desktop.observer.stop(); });
  await strict.observer.start({ threadId: THREAD });
  assert.deepEqual(strict.events.map(event => event.callId), ["known-call"]);
  assert.equal(Object.hasOwn(strict.observer.getStatus().coverage.raw, "unscopedItems"), false);
  await desktop.observer.start({ threadId: THREAD });
  assert.deepEqual(desktop.events.map(event => event.callId).sort(), ["known-call", "tail-call"]);
  const event = desktop.events.find(value => value.callId === "tail-call");
  assert.equal(event.turnId, null);
  assert.equal(event.scope, "thread_tail");
  assert.equal(event.toolId, "codex.recorded.function");
  assert.equal(event.sourceStatus, "returned");
  assert.equal(event.at, raw.sourceTimestamp);
  assert.equal(desktop.events.find(value => value.callId === "known-call").turnId, TURN);
  const status = desktop.observer.getStatus();
  assert.equal(status.skippedItems, 4);
  assert.equal(status.coverage.raw.unscopedItems, 1);
  assert.match(status.notice, /轮次未知|未知轮次/);
  assert.match(status.notice, /末尾|thread_tail/);
  assert.doesNotMatch(JSON.stringify({ events: desktop.events, status }), new RegExp(SECRET));
});

test("source retains handshake home and supplements only selected recent turns without duplicate structured calls", async () => {
  const latest = "01a1c96c-a246-7162-9cf3-21c660fb38db";
  const callId = "call_9171c4792c7f4379983c193b6f8d7a3c";
  const messages = [];
  const traceInputs = [];
  const f = windowsClient((message, child) => {
    messages.push(message);
    if (!message.id) return;
    const result = message.method === "initialize" ? { codexHome: SECRET }
      : message.method === "thread/read" ? { thread: { id: THREAD, path: SECRET } }
      : { data: [
        { id: latest, items: [{ type: "userMessage", text: SECRET }, { type: "agentMessage", text: SECRET }] },
        { id: TURN, items: [item()] }
      ] };
    child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
  }, {
    traceReader: async input => {
      traceInputs.push(input);
      return {
        items: [
          { type: "observedToolCall", id: callId, turnId: latest,
            rawKind: "custom_tool_call", toolName: "exec", status: "completed" },
          { type: "observedToolCall", id: CALL, turnId: TURN,
            rawKind: "function_call", toolName: "exec", status: "completed" },
          { type: "observedToolCall", id: "old-call", turnId: "old-turn",
            rawKind: "function_call", toolName: "exec", status: "completed" }
        ],
        coverage: { available: true, truncated: true }
      };
    }
  });
  try {
    const result = await f.source.readTurns(THREAD);
    assert.equal(result.data[0].items.at(-1).id, callId);
    assert.equal(result.data[1].items.length, 1);
    assert.equal(result.data[1].items[0].id, CALL);
    assert.equal(result.traceCoverage.available, true);
    assert.equal(result.traceCoverage.truncated, true);
    assert.deepEqual(traceInputs[0], {
      codexHome: SECRET, threadId: THREAD, thread: { id: THREAD, path: SECRET },
      turnIds: [latest, TURN]
    });
    assert.deepEqual(messages.map(message => message.method), [
      "initialize", "initialized", "thread/turns/list", "thread/read"
    ]);
    assert.deepEqual(messages.at(-1).params, { threadId: THREAD });
  } finally {
    await f.source.close();
  }
});

test("missing raw pointer and rejected metadata preserve structured native terminal coverage", async () => {
  for (const rejected of [false, true]) {
    let traceReads = 0;
    const f = windowsClient((message, child) => {
      if (!message.id) return;
      const response = message.method === "thread/read" && rejected
        ? { error: { message: SECRET } }
        : { result: message.method === "initialize" ? { codexHome: SECRET }
          : message.method === "thread/read" ? { thread: { id: THREAD } } : turns([item()]) };
      child.stdout.write(JSON.stringify({ id: message.id, ...response }) + "\n");
    }, {
      traceReader: async () => {
        traceReads++;
        return { items: [], coverage: { available: false } };
      }
    });
    try {
      for (let i = 0; i < 2; i++) {
        const result = await f.source.readTurns(THREAD);
        assert.equal(result.data[0].items[0].id, CALL);
        assert.equal(result.traceCoverage.available, false);
        assert.doesNotMatch(JSON.stringify(result.traceCoverage), new RegExp(SECRET));
      }
      assert.equal(traceReads, rejected ? 0 : 2);
    } finally {
      await f.source.close();
    }
  }
});

test("real-shaped custom trace publishes recorded then returned, remains redacted and dedupes reattach", async t => {
  const latest = "01a1c96c-a246-7162-9cf3-21c660fb38db";
  const callId = "call_9171c4792c7f4379983c193b6f8d7a3c";
  const records = [
    { timestamp: "2026-11-11T07:05:02.428Z", type: "event_msg",
      payload: { type: "task_started", turn_id: latest } },
    { timestamp: "2026-11-11T07:05:06.685Z", type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: callId,
        input: SECRET, body: SECRET, status: "completed" } }
  ];
  const response = returned => {
    const trace = parseTraceTail(Buffer.from([...records, ...(returned ? [{
      timestamp: "2026-11-11T07:05:06.788Z", type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: callId,
        output: [{ type: "text", text: SECRET + " succeeded" }] }
    }] : [])].map(record => JSON.stringify(record)).join("\n") + "\n"), { turnIds: [latest, TURN] });
    return {
      data: [{ id: latest, items: trace.items }, { id: TURN, items: [item()] }],
      traceCoverage: { ...trace.coverage, truncated: true }
    };
  };
  const f = fixture(response(false));
  t.after(() => f.observer.stop());
  await f.observer.start({ threadId: THREAD });
  assert.deepEqual(f.events.map(event => event.status), ["queued", "succeeded"]);
  f.respond(response(true));
  await f.observer.poll();
  await f.observer.poll();
  await f.observer.stop();
  await f.observer.start({ threadId: THREAD });
  assert.deepEqual(f.events.map(event => event.status), ["queued", "succeeded", "completed"]);
  const returned = f.events.at(-1);
  assert.equal(returned.callId, callId);
  assert.equal(returned.turnId, latest);
  assert.equal(returned.rawKind, "custom_tool_call");
  assert.equal(returned.toolName, "exec");
  assert.equal(returned.sourceStatus, "returned");
  assert.equal(returned.source, "codex-observer");
  assert.equal(returned.controllability, "observable");
  assert.equal(returned.at, "2026-11-11T07:05:06.685Z");
  for (const key of ["durationMs", "elapsedMs", "exitCode", "startedAt", "completedAt"])
    assert.equal(Object.hasOwn(returned, key), false);
  assert.equal(f.events[1].callId, CALL);
  assert.equal(f.observer.getStatus().coverage.raw.truncated, true);
  assert.doesNotMatch(JSON.stringify({ events: f.events, status: f.observer.getStatus() }), new RegExp(SECRET));
  f.respond({ data: [{ id: TURN, items: [item()] }], traceCoverage: { available: false } });
  await f.observer.poll();
  assert.equal(f.observer.getStatus().state, "observing");
  assert.equal(f.observer.getStatus().coverage.raw.available, false);
});

test("observer validates supplementary metadata and gives structured calls precedence", async t => {
  const raw = {
    type: "observedToolCall", id: CALL, turnId: TURN, rawKind: "function_call",
    toolName: "tools.lookup", status: "completed", input: SECRET, output: SECRET
  };
  const f = fixture(turns([
    raw, item(),
    { ...raw, id: "wrong-turn", turnId: "another-turn" },
    { ...raw, id: "bad-name", toolName: "../" + SECRET },
    { ...raw, id: "bad-status", status: "succeeded" },
    { ...raw, id: "bad-kind", rawKind: SECRET },
    { ...raw, id: "function-only" }
  ]));
  t.after(() => f.observer.stop());
  await f.observer.start({ threadId: THREAD });
  assert.deepEqual(f.events.map(event => [event.callId, event.status]), [
    [CALL, "succeeded"], ["function-only", "completed"]
  ]);
  assert.equal(f.observer.getStatus().skippedItems, 4);
  assert.doesNotMatch(JSON.stringify(f.events), new RegExp(SECRET));
});

test("stdio uses only the verified handshake and selected thread listing with fixed Windows commands", async () => {
  const messages = [];
  const f = windowsClient((message, child) => {
    messages.push(message);
    if (message.id) {
      const result = message.method === "initialize" ? {} : turns([item()]);
      const bytes = JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n";
      child.stdout.write(bytes.slice(0, 17));
      child.stdout.write(bytes.slice(17));
    }
  });
  assert.equal((await f.source.readTurns(THREAD)).data[0].items[0].id, CALL);
  await f.source.readTurns(THREAD);
  await f.source.close();
  await f.source.close();
  assert.deepEqual(messages.map(message => message.method), [
    "initialize", "initialized", "thread/turns/list", "thread/turns/list"
  ]);
  assert.deepEqual(messages[0].params, {
    clientInfo: { name: "agent_tool_center_observer", version: "0.1.0" }, capabilities: {}
  });
  assert.deepEqual(messages[2].params, {
    threadId: THREAD, limit: 20, sortDirection: "desc", itemsView: "full"
  });
  assert.equal(f.launches[0].command, "cmd.exe");
  assert.deepEqual(f.launches[0].args, ["/d", "/s", "/c", "codex.cmd app-server --stdio"]);
  assert.equal(f.launches[0].settings.windowsHide, true);
  assert.equal(f.launches[1].command, "taskkill.exe");
  assert.deepEqual(f.launches[1].args, ["/PID", "123456", "/T", "/F"]);
  assert.equal(f.launches[1].settings.windowsHide, true);
  assert.equal(f.launches.length, 2);
});

test("stdio RPC accepts absent jsonrpc and rejects explicitly invalid protocol versions", async () => {
  const { source } = windowsClient((message, child) => {
    if (message.id !== undefined) {
      child.stdout.write(JSON.stringify({
        id: message.id,
        result: message.method === "initialize" ? {} : turns([item()]),
      }) + "\n");
    }
  });
  try {
    const data = await source.readTurns(THREAD);
    assert.ok(data);
  } finally {
    await source.close();
  }

  for (const jsonrpc of ["1.0", null, 2, false, ""]) {
    const { source: invalidSource } = windowsClient((message, child) => {
      if (message.id !== undefined) {
        child.stdout.write(JSON.stringify({
          jsonrpc,
          id: message.id,
          result: message.method === "initialize" ? {} : turns([item()]),
        }) + "\n");
      }
    });
    try {
      await assert.rejects(
        () => invalidSource.readTurns(THREAD),
        { code: "OBSERVER_PROTOCOL_ERROR" },
      );
    } finally {
      await invalidSource.close();
    }
  }
});

test("stdio RPC timeout, malformed and oversized frames trigger owned tree cleanup without raw diagnostics", async () => {
  for (const kind of ["timeout", "malformed", "oversized", "rpc-error"]) {
    const f = windowsClient((message, child) => {
      if (kind === "malformed") child.stdout.write(SECRET + "\n");
      if (kind === "oversized") child.stdout.write("x".repeat(1025));
      if (kind === "rpc-error") child.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id, error: { code: -1, message: SECRET }
      }) + "\n");
      child.stderr.write(SECRET);
    }, { rpcTimeoutMs: 15, maxResponseBytes: 1024 });
    await assert.rejects(f.source.readTurns(THREAD), error => {
      assert.match(error.code, /^OBSERVER_/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });
    await f.source.close();
    assert.equal(f.launches.filter(launch => launch.command === "taskkill.exe").length, 1);
    assert.equal(f.child.stdin.destroyed, true);
  }
});

test("same-origin API starts selected source, streams redacted metadata, and leaves MCP grants independent", { timeout: 10000 }, async t => {
  let sources = 0;
  let closes = 0;
  const app = createApp({
    mcp: { discover: async () => ({ available: false }), close: async () => {} },
    observerSource: () => {
      sources++;
      return {
        readTurns: async id => { assert.equal(id, THREAD); return turns([item()]); },
        close: async () => { closes++; }
      };
    }
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close();
  });
  const post = (route, body, origin = base) => fetch(base + route, {
    method: "POST", headers: {
      "Content-Type": "application/json", ...(origin ? { Origin: origin } : {})
    },
    body: JSON.stringify(body)
  });
  const start = "/api/codex/observer/start";
  const stop = "/api/codex/observer/stop";
  const status = await fetch(base + "/api/codex/observer/status").then(response => response.json());
  assert.equal(status.enabled, false);
  assert.equal(sources, 0);
  for (const origin of ["https://example.com", null]) {
    assert.equal((await post(start, { threadId: THREAD }, origin)).status, 403);
    assert.equal((await post(stop, {}, origin)).status, 403);
  }
  assert.equal((await post(start, { threadId: "all" })).status, 400);
  assert.equal((await post(start, { threadId: THREAD, command: SECRET })).status, 400);
  assert.equal(sources, 0);

  const stream = await fetch(base + "/api/events", { signal: abort.signal });
  const reader = stream.body.getReader();
  await reader.read();
  const policyBefore = await fetch(base + "/api/codex/policy").then(response => response.json());
  const started = await post(start, { threadId: THREAD }).then(response => response.json());
  assert.equal(started.state, "observing");
  assert.equal(started.coverage.limit, 20);
  let sse = "";
  while (!sse.includes("event: tool")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    sse += new TextDecoder().decode(chunk.value);
  }
  assert.ok(sse.includes(CALL));
  assert.ok(sse.includes("codex.native.terminal"));
  assert.doesNotMatch(sse, new RegExp(SECRET));
  const history = await fetch(base + "/api/history").then(response => response.json());
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].callId, CALL);
  assert.equal(history.events[0].turnId, TURN);
  assert.equal(history.events[0].at, new Date(1794378282674).toISOString());
  assert.doesNotMatch(JSON.stringify(history), new RegExp(SECRET));
  assert.equal((await post(start, { threadId: THREAD })).status, 409);
  assert.equal((await post(stop, { threadId: THREAD })).status, 400);
  assert.equal((await post(stop, {})).status, 200);
  assert.equal(closes, 1);
  assert.equal((await post(start, { threadId: THREAD })).status, 200);
  assert.equal(app.getEvents().length, 1, "stop and reattach retains dedupe");
  assert.deepEqual(await fetch(base + "/api/codex/policy").then(response => response.json()), policyBefore);
  await post(stop, {});
  assert.equal(sources, 2);
  assert.equal(closes, 2);
  abort.abort();
});
