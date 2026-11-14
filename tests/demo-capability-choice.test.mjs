import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ids = { A: "demo_read_file", B: "demo_read_stream" };
const summaryKeys = [
  "selected", "actual", "matchesSelection", "outcome",
  "lineCount", "digest", "quality"
].sort();
const promptPattern = /(?:选择|请选择|输入|choose|select|enter|pick)/iu;
const deadline = 8_000;

function expected(lines) {
  return {
    lineCount: lines.length,
    digest: createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")
  };
}

async function fixture(t, readme = "first\nsecond\nthird\nignored\n") {
  const cache = join(projectRoot, ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "demo-capability-choice-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "elsewhere"));
  for (const name of ["capability-advisor.mjs", "capabilities.json"]) {
    await copyFile(join(projectRoot, "src", name), join(root, "src", name));
  }
  const entry = join(root, "scripts", "demo-capability-choice.mjs");
  try {
    await copyFile(join(projectRoot, "scripts", "demo-capability-choice.mjs"), entry);
  } catch (error) {
    // An absent implementation must fail behavioral assertions, not fixture setup.
    if (error.code !== "ENOENT") throw error;
  }
  if (readme !== null) await writeFile(join(root, "README.md"), readme);
  await writeFile(join(root, "elsewhere", "README.md"), "wrong cwd\n");
  return { root, entry, cwd: join(root, "elsewhere") };
}

function launch(t, f, args = []) {
  const child = spawn(process.execPath, [f.entry, ...args], {
    cwd: f.cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let timedOut = false;
  const listeners = new Set();
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    for (const listener of listeners) listener();
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, deadline);
  const done = new Promise((resolve, reject) => {
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      for (const listener of listeners) listener();
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
  t.after(async () => {
    if (!closed) child.kill();
    await done;
  });
  return {
    child,
    done,
    async prompt() {
      await new Promise((resolve, reject) => {
        function check() {
          if (/\bA\b/u.test(stdout) && /\bB\b/u.test(stdout) &&
              promptPattern.test(stdout)) {
            listeners.delete(check);
            resolve();
          } else if (closed) {
            listeners.delete(check);
            reject(new Error(`Exited before A/B prompt:\n${stdout}\n${stderr}`));
          }
        }
        listeners.add(check);
        check();
      });
      assert.equal(closed, false, "manual mode must remain alive awaiting input");
      assert.equal(jsonLines(stdout).length, 0, "no final result before input");
    }
  };
}

function jsonLines(stdout) {
  return stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => {
    if (!line.startsWith("{")) return false;
    try { return typeof JSON.parse(line) === "object"; } catch { return false; }
  });
}

function summary(result) {
  assert.equal(result.timedOut, false, "subprocess must terminate, including stream adapter");
  assert.equal(result.signal, null, `unexpected termination: ${result.stderr}`);
  const lines = result.stdout.trimEnd().split(/\r?\n/u);
  const last = lines.at(-1);
  assert.ok(last?.startsWith("{"), `expected final JSON line:\n${result.stdout}\n${result.stderr}`);
  const value = JSON.parse(last);
  assert.deepEqual(Object.keys(value).sort(), summaryKeys);
  assert.equal(value.quality, "not_assessed");
  assert.equal(jsonLines(result.stdout).filter(line => {
    return Object.hasOwn(JSON.parse(line), "outcome");
  }).length, 1, "exactly one final outcome");
  return value;
}

function explanation(result) {
  const text = result.stdout.slice(0, result.stdout.lastIndexOf("{"));
  assert.match(text, /demo_read_file/u);
  assert.match(text, /demo_read_stream/u);
  assert.match(text, /(?:本地|local)/iu, "identify local demo scope");
  assert.match(text, /(?:演示|demo)/iu);
  assert.match(text, /readFile/u);
  assert.match(text, /(?:createReadStream|readline)/u);
  assert.doesNotMatch(text, /(?:connected to|已连接|连接成功)\s*(?:Codex|RDC)/iu);
}

function succeeded(result, choice, lines) {
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(summary(result), {
    selected: ids[choice],
    actual: ids[choice],
    matchesSelection: true,
    outcome: "succeeded",
    ...expected(lines),
    quality: "not_assessed"
  });
  explanation(result);
}

// Reject paths/options before attempting to read even the fixed README.
for (const args of [
  ["--mode", "unknown"],
  ["--mode"],
  ["--unknown"],
  ["README.md"],
  ["--path", "README.md"],
  ["--mode", "auto", "../README.md"],
  ["--mode", "manual", "--unknown"]
]) {
  test(`reject arguments before execution: ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t, null);
    const run = launch(t, f, args);
    run.child.stdin.end("B\n");
    const result = await run.done;
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /(?:参数|选项|模式|用法|argument|option|mode|usage)/iu);
    assert.doesNotMatch(result.stdout + result.stderr, /ENOENT|MODULE_NOT_FOUND/u);
    assert.equal(jsonLines(result.stdout).some(line => {
      const value = JSON.parse(line);
      return value.actual != null || value.outcome === "succeeded";
    }), false, "invalid arguments must not execute an adapter");
    assert.doesNotMatch(result.stdout, /\bA\b[\s\S]*\bB\b/u);
  });
}

for (const args of [[], ["--mode", "auto"], ["--mode", "recommend"]]) {
  test(`automatic route exits with stdin open: ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t);
    const result = await launch(t, f, args).done;
    succeeded(result, "A", ["first", "second", "third"]);
    assert.doesNotMatch(result.stdout, /(?:等待.*输入|请选择|请输入|choose\s+[AB]|enter\s+[AB])/iu);
    if (args.includes("recommend")) {
      const beforeResult = result.stdout.slice(0, result.stdout.lastIndexOf("{"));
      assert.match(beforeResult, /(?:优先值|优先级|priority)/iu);
      assert.match(beforeResult, /(?:路由|route|routing)/iu);
      assert.match(beforeResult, /(?:不是.*质量.*排名|非.*质量.*排名|not.*quality.*rank)/iu);
    }
  });
}

for (const choice of ["A", "B"]) {
  for (const sample of [
    { text: "一\r\n二\r\n三\r\nfour\r\n", lines: ["一", "二", "三"] },
    { text: "one\n\nthree\nfour", lines: ["one", "", "three"] },
    { text: "one\ntwo", lines: ["one", "two"] },
    { text: "one\n", lines: ["one"] },
    { text: "", lines: [] }
  ]) {
    test(`manual ${choice} normalizes ${JSON.stringify(sample.text)}`, async t => {
      const f = await fixture(t, sample.text);
      const run = launch(t, f, ["--mode", "manual"]);
      await run.prompt();
      run.child.stdin.end(`${choice}\n`);
      succeeded(await run.done, choice, sample.lines);
    });
  }
}

test("manual gate reads replaced README only after B selection", async t => {
  const f = await fixture(t, "old\ncontent\nbefore prompt\n");
  const run = launch(t, f, ["--mode", "manual"]);
  await run.prompt();
  await writeFile(join(f.root, "README.md"), "new\r\n内容\r\nafter prompt\r\nignored\n");
  run.child.stdin.end("B\n");
  succeeded(await run.done, "B", ["new", "内容", "after prompt"]);
});

for (const input of ["q\n", "", "invalid\n"]) {
  test(`manual cancellation without README: ${JSON.stringify(input)}`, async t => {
    const f = await fixture(t, null);
    const run = launch(t, f, ["--mode", "manual"]);
    await run.prompt();
    run.child.stdin.end(input);
    const result = await run.done;
    assert.deepEqual(summary(result), {
      selected: null,
      actual: null,
      matchesSelection: null,
      outcome: "not_run",
      lineCount: 0,
      digest: null,
      quality: "not_assessed"
    });
    assert.doesNotMatch(result.stdout + result.stderr, /ENOENT|selectionId|读取失败|read failed/iu);
    explanation(result);
  });
}

for (const choice of ["A", "B"]) {
  test(`missing fixed README reports attempted ${choice} with sanitized diagnostic`, async t => {
    const f = await fixture(t, null);
    const run = launch(t, f, ["--mode", "manual"]);
    await run.prompt();
    run.child.stdin.end(`${choice}\n`);
    const result = await run.done;
    assert.deepEqual(summary(result), {
      selected: ids[choice],
      actual: ids[choice],
      matchesSelection: true,
      outcome: "failed",
      lineCount: 0,
      digest: null,
      quality: "not_assessed"
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /(?:失败|无法|不存在|failed|cannot|unable|missing|ENOENT)/iu);
    for (const path of [f.root, f.entry, dirname(f.entry), f.cwd]) {
      assert.equal(output.includes(path), false, "must not expose raw filesystem paths");
      assert.equal(output.includes(path.replaceAll("\\", "/")), false);
      assert.equal(output.includes(JSON.stringify(path).slice(1, -1)), false);
    }
    assert.doesNotMatch(output, /(?:[A-Za-z]:[\\/]|file:\/\/\/)/u);
  });
}
