import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTraceReader, parseTraceTail, TRACE_MAX_BYTES } from "../src/codex-trace.mjs";

const THREAD = "01a1b903-df4b-7fa2-becf-0f84ea899391";
const TURN = "01a1c96c-a246-7162-9cf3-21c660fb38db";
const CALL = "call_9171c4792c7f4379983c193b6f8d7a3c";
const SECRET = "PRIVATE-input-output-body-path";
const start = id => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
const call = (overrides = {}) => ({
  timestamp: "2026-11-11T07:05:06.685Z", type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", call_id: CALL,
    input: SECRET, arguments: SECRET, body: SECRET, status: "completed", ...overrides }
});
const output = (overrides = {}) => ({
  timestamp: "2026-11-11T07:05:06.788Z", type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: CALL,
    output: [{ type: "text", text: SECRET + " success error" }], ...overrides }
});
const encode = records => Buffer.from(records.map(record =>
  typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
const parse = records => parseTraceTail(encode(records), { turnIds: [TURN] });

test("latest code-mode regression preserves only real call metadata and returned is not success", () => {
  const result = parse([
    { ...start(TURN), timestamp: "2026-11-11T07:05:02.428Z" },
    call(), output(),
    { timestamp: "2026-11-11T07:05:11.211Z", type: "event_msg",
      payload: { type: "task_complete", turn_id: TURN } }
  ]);
  assert.deepEqual(result.items, [{
    type: "observedToolCall", id: CALL, turnId: TURN,
    rawKind: "custom_tool_call", toolName: "exec",
    sourceTimestamp: "2026-11-11T07:05:06.685Z", status: "completed"
  }]);
  assert.equal(result.coverage.available, true);
  assert.equal(result.coverage.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|success|error|input|arguments|output|body/);
  assert.equal(parse([start(TURN), call()]).items[0].status, "queued",
    "a completed field on the call itself does not prove a returned output");
});

test("turn and output kind isolate pairing; unknown, malformed and unsafe records are ignored", () => {
  const result = parse([
    start("older-turn"), call(), output(),
    { type: "turn_context", payload: { turn_id: TURN } },
    call(),
    output({ type: "function_call_output" }),
    call({ type: "function_call", call_id: "function-id", name: "tools.lookup" }),
    output({ type: "function_call_output", call_id: "function-id" }),
    call({ call_id: "unsafe-name", name: "../" + SECRET }),
    call({ call_id: "unsafe\nid" }),
    "{malformed " + SECRET,
    { type: "response_item", payload: { type: "agent_message", body: SECRET } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: TURN } },
    output()
  ]);
  assert.deepEqual(result.items.map(item => [item.id, item.status]), [
    [CALL, "queued"], ["function-id", "completed"]
  ]);
  assert.equal(result.coverage.skippedLines, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|older-turn/);
  const crossed = parse([
    start(TURN), call(), start("other-turn"), output(), start(TURN)
  ]);
  assert.equal(crossed.items[0].status, "queued");
});

test("tail skips partial first and last lines and never attributes an unanchored tool to a turn", () => {
  const bytes = Buffer.from(JSON.stringify(call()) + "\n" +
    encode([call(), start(TURN), call()]).toString() + JSON.stringify(output()));
  const result = parseTraceTail(bytes, { turnIds: [TURN], truncated: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, "queued");
  assert.equal(result.coverage.truncated, true);
  assert.equal(parseTraceTail(encode([start(TURN), call()]), {
    turnIds: Array.from({ length: 20 }, (_, i) => "recent-" + i).concat(TURN)
  }).items.length, 0, "only the API's latest twenty turn IDs are accepted");
});

function filesystemFixture(bytes = encode([start(TURN), call(), output()])) {
  const home = path.resolve("trace-fixture-home");
  const sessions = path.join(home, "sessions");
  const file = path.join(sessions, "2026", "11", "07",
    "rollout-2026-11-07T21-36-46-" + THREAD + ".jsonl");
  const reads = [];
  const opens = [];
  let closed = 0;
  const fileSystem = {
    realpath: async value => value,
    open: async (value, flag) => {
      opens.push([value, flag]);
      return {
        stat: async () => ({ size: bytes.length, isFile: () => true }),
        read: async (target, offset, length, position) => {
          reads.push({ length, position });
          const bytesRead = bytes.copy(target, offset, position, position + length);
          return { bytesRead };
        },
        close: async () => { closed++; }
      };
    }
  };
  return {
    home, sessions, file, fileSystem, reads, opens, closed: () => closed,
    options: { codexHome: home, threadId: THREAD, thread: { id: THREAD, path: file }, turnIds: [TURN] }
  };
}

test("reads Windows namespace metadata paths and rejects namespace paths outside sessions", {
  skip: process.platform !== "win32",
}, async () => {
  const f = filesystemFixture();
  const reader = createTraceReader({ fileSystem: f.fileSystem });
  const namespacedFile = path.toNamespacedPath(f.file);

  await reader({
    ...f.options,
    thread: { ...f.options.thread, path: namespacedFile },
  });
  assert.equal(f.opens.length, 1);
  assert.deepEqual(f.opens[0], [namespacedFile, "r"]);

  f.opens.length = 0;
  const outsideFile = path.toNamespacedPath(
    path.join(f.home, "outside-sessions", path.basename(f.file)),
  );
  await reader({
    ...f.options,
    thread: { ...f.options.thread, path: outsideFile },
  });
  assert.deepEqual(f.opens, []);
});

test("rejects wrong thread, traversal, relative paths and outside sessions before opening a file", async () => {
  const f = filesystemFixture();
  const read = createTraceReader({ fileSystem: f.fileSystem });
  for (const thread of [
    { id: "another-thread", path: f.file },
    { id: THREAD, path: path.join(f.home, "outside-" + THREAD + ".jsonl") },
    { id: THREAD, path: "relative-" + THREAD + ".jsonl" },
    { id: THREAD, path: f.sessions + path.sep + ".." + path.sep + "rollout-" + THREAD + ".jsonl" },
    { id: THREAD, path: f.file.replace(THREAD, "another-thread") }
  ]) {
    const result = await read({ ...f.options, thread });
    assert.equal(result.coverage.available, false);
    assert.doesNotMatch(JSON.stringify(result), /trace-fixture|rollout/);
  }
  assert.equal(f.opens.length, 0);
  f.fileSystem.realpath = async value => value === f.file
    ? path.join(f.home, "outside-" + THREAD + ".jsonl") : value;
  assert.equal((await read(f.options)).coverage.available, false);
  assert.equal(f.opens.length, 0, "realpath escape is rejected before open");
});

test("reader opens only the metadata-selected named file read-only and enforces the tail bound", async () => {
  const prefix = Buffer.alloc(TRACE_MAX_BYTES + 100, 120);
  const f = filesystemFixture(Buffer.concat([prefix, Buffer.from("\n"), encode([start(TURN), call(), output()])]));
  const result = await createTraceReader({ fileSystem: f.fileSystem })(f.options);
  assert.deepEqual(f.opens, [[f.file, "r"]]);
  assert.equal(f.reads.reduce((sum, read) => sum + read.length, 0), TRACE_MAX_BYTES);
  assert.ok(f.reads[0].position > 0);
  assert.equal(f.closed(), 1);
  assert.equal(result.items[0].id, CALL);
  assert.equal(result.coverage.truncated, true);
});

test("filesystem failures expose availability only and close opened handles", async () => {
  const f = filesystemFixture();
  f.fileSystem.open = async () => ({
    stat: async () => { throw Error(SECRET + f.file); },
    close: async () => { f.opens.push("closed"); }
  });
  const result = await createTraceReader({ fileSystem: f.fileSystem })(f.options);
  assert.equal(result.coverage.available, false);
  assert.deepEqual(f.opens, ["closed"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|trace-fixture|rollout/);
});

test("desktop tail opt-in retains only pre-anchor metadata without inventing a turn", () => {
  const records = [
    output({ call_id: "output-without-call" }),
    call(), output(),
    start("outside-recent-twenty"),
    call({ call_id: "old-call" }),
    start(TURN), call({ call_id: "scoped-call" }),
    { type: "event_msg", payload: { type: "task_complete", turn_id: TURN } },
    call({ call_id: "orphan-after-complete" })
  ];
  const strict = parseTraceTail(encode(records), { turnIds: [TURN] });
  assert.deepEqual(strict.items.map(item => item.id), ["scoped-call"]);
  assert.equal(Object.hasOwn(strict.coverage, "unscopedItems"), false);
  const desktop = parseTraceTail(encode(records), { turnIds: [TURN], allowUnscoped: true });
  assert.deepEqual(desktop.items, [{
    type: "observedToolCall", id: CALL, turnId: null, scope: "thread_tail",
    rawKind: "custom_tool_call", toolName: "exec",
    sourceTimestamp: "2026-11-11T07:05:06.685Z", status: "completed"
  }, strict.items[0]]);
  assert.equal(desktop.coverage.unscopedItems, 1);
  assert.doesNotMatch(JSON.stringify(desktop), /PRIVATE|outside-recent|old-call|orphan|output-without/);
});

test("desktop tail opt-in keeps partial-line and twenty-turn boundaries", () => {
  const bytes = Buffer.concat([
    encode([call({ call_id: "partial-first" }), call(), output(), start(TURN),
      call({ call_id: "outside-window" })]),
    Buffer.from(JSON.stringify(call({ call_id: "partial-last" })))
  ]);
  const result = parseTraceTail(bytes, {
    truncated: true, allowUnscoped: true,
    turnIds: Array.from({ length: 20 }, (_, index) => `recent-${index}`).concat(TURN)
  });
  assert.deepEqual(result.items.map(item => [item.id, item.turnId, item.status]), [
    [CALL, null, "completed"]
  ]);
  assert.equal(result.coverage.unscopedItems, 1);
  assert.equal(result.coverage.truncated, true);
});

test("a task completion without a start closes the unknown-turn prefix", () => {
  const result = parseTraceTail(encode([
    call({ call_id: "prefix" }),
    { type: "event_msg", payload: { type: "task_complete", turn_id: "outside" } },
    call({ call_id: "orphan" }), output({ call_id: "prefix" })
  ]), { turnIds: [TURN], allowUnscoped: true });
  assert.deepEqual(result.items.map(item => [item.id, item.turnId, item.status]), [
    ["prefix", null, "queued"]
  ]);
  assert.equal(result.coverage.unscopedItems, 1);
});

test("desktop reader forwards opt-in only after verified metadata and preserves the 2MiB bound", async () => {
  const f = filesystemFixture(Buffer.concat([
    Buffer.alloc(TRACE_MAX_BYTES + 100, 120), Buffer.from("\n"),
    encode([call(), output(), start(TURN), call({ call_id: "scoped" })])
  ]));
  const read = createTraceReader({ fileSystem: f.fileSystem, allowUnscoped: true });
  const result = await read(f.options);
  assert.deepEqual(result.items.map(item => [item.id, item.turnId]), [[CALL, null], ["scoped", TURN]]);
  assert.equal(result.coverage.unscopedItems, 1);
  assert.equal(f.reads.reduce((sum, value) => sum + value.length, 0), TRACE_MAX_BYTES);
  assert.deepEqual(f.opens, [[f.file, "r"]]);
  assert.equal(f.closed(), 1);
  f.opens.length = 0;
  for (const thread of [
    { id: "wrong-thread", path: f.file },
    { id: THREAD, path: path.join(f.home, `outside-${THREAD}.jsonl`) },
    { id: THREAD, path: `relative-${THREAD}.jsonl` }
  ]) {
    assert.equal((await read({ ...f.options, thread })).coverage.available, false);
  }
  f.fileSystem.realpath = async value => value === f.file
    ? path.join(f.home, `escaped-${THREAD}.jsonl`) : value;
  assert.equal((await read(f.options)).coverage.available, false);
  assert.deepEqual(f.opens, []);
});
test('matching call IDs cannot pair across unknown-prefix and known-turn boundaries', () => {
  const options = { turnIds: [TURN], allowUnscoped: true };
  const prefix = parseTraceTail(encode([
    call(),
    start(TURN),
    output(),
  ]), options).items;
  const known = parseTraceTail(encode([
    output(),
    start(TURN),
    call(),
  ]), options).items;

  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].turnId, null);
  assert.equal(prefix[0].scope, 'thread_tail');
  assert.equal(prefix[0].status, 'queued');
  assert.equal(known.length, 1);
  assert.equal(known[0].turnId, TURN);
  assert.equal(known[0].status, 'queued');
  assert.equal([...prefix, ...known].some(item => item.status === 'completed'), false);
});
