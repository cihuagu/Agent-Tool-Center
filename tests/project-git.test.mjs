import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createProjectGitRunner, parsePorcelain, validateProjectGitSummary } from "../src/project-git.mjs";

const clean = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, clean: true };
const parse = text => parsePorcelain(Buffer.from(text));

test("porcelain counts logical records, consumes rename/copy sources and preserves newline boundaries", () => {
  assert.deepEqual(parse(""), clean);
  assert.deepEqual(parse("R  new\nname\0old\nname\0 C copy\0source\0MM both\0?? directory/\0"), {
    total: 4, staged: 2, unstaged: 2, untracked: 1, conflicts: 0, clean: false
  });
  for (const conflict of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.deepEqual(parse(conflict + " private\0"), {
      total: 1, staged: 0, unstaged: 0, untracked: 0, conflicts: 1, clean: false
    });
  }
});

test("malformed and truncated porcelain fails instead of claiming a clean workspace", () => {
  for (const text of [" M missing-terminator", "\0", "?? \0", "  file\0", "!! ignored\0",
    "ZZ file\0", "U  file\0", "R  target\0", "R  target\0\0", "?? path\0\0", "M file\0"]) {
    assert.throws(() => parse(text), { code: "PROJECT_GIT_FAILED" });
  }
  assert.throws(() => parsePorcelain(Buffer.alloc(256 * 1024 + 1)), { code: "PROJECT_GIT_FAILED" });
});

test("fixed runner uses only project cwd, bounded non-shell Git calls and removes every GIT_ override", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const calls = [];
  const runner = createProjectGitRunner({
    env: { PATH: "fixed-path", GIT_DIR: "private", git_work_tree: "private", GiT_CONFIG_COUNT: "9", OTHER: "keep" },
    resolveRealpath: async value => value,
    execute: async (...args) => {
      calls.push(args);
      return { stdout: Buffer.from(calls.length === 1 ? root + "\n" : "?? private-file\0"), stderr: "private" };
    }
  });
  assert.deepEqual(await runner(), {
    total: 1, staged: 0, unstaged: 0, untracked: 1, conflicts: 0, clean: false
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([command, args]) => [command, args]), [
    ["git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"]],
    ["git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]]
  ]);
  for (const [, , options] of calls) {
    assert.deepEqual(options, {
      cwd: root, shell: false, windowsHide: true, timeout: 5000,
      maxBuffer: 256 * 1024, encoding: "buffer", env: { PATH: "fixed-path", OTHER: "keep" }
    });
  }
});

test("root mismatch, command failures and invalid stdout stop with generic diagnostics", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const mode of ["different-root", "root-failure", "git-failure", "truncated", "bad-utf8", "status-failure"]) {
    let calls = 0;
    const runner = createProjectGitRunner({
      resolveRealpath: async value => {
        if (mode === "root-failure") throw Error("PRIVATE-path");
        return value;
      },
      execute: async () => {
        calls++;
        if (mode === "git-failure" || (mode === "status-failure" && calls === 2)) {
          throw Object.assign(Error("PRIVATE-output"), { stderr: "PRIVATE-stderr" });
        }
        if (calls === 2) return { stdout: Buffer.from("") };
        if (mode === "different-root") return { stdout: Buffer.from(root + "other\n") };
        if (mode === "truncated") return { stdout: Buffer.from(root) };
        if (mode === "bad-utf8") return { stdout: Buffer.from([255, 10]) };
        return { stdout: Buffer.from(root + "\n") };
      }
    });
    await assert.rejects(runner(), error => {
      assert.equal(error.code, "PROJECT_GIT_FAILED");
      assert.doesNotMatch(error.message, /PRIVATE|stderr|other/);
      return true;
    });
    assert.equal(calls, mode === "root-failure" ? 0 : mode === "status-failure" ? 2 : 1);
  }
});

test("summary validation rejects injected diagnostics and impossible counts", () => {
  for (const summary of [
    { ...clean, stdout: "PRIVATE" }, { ...clean, total: "PRIVATE" },
    { ...clean, clean: false }, { ...clean, total: -1 },
    { ...clean, total: Number.MAX_SAFE_INTEGER + 1 }, { ...clean, conflicts: 1 },
    { ...clean, total: 1, clean: false },
    { ...clean, total: 1, staged: 1, untracked: 1, clean: false },
    { ...clean, total: 1, staged: 1, conflicts: 1, clean: false }
  ]) assert.throws(() => validateProjectGitSummary(summary), { code: "PROJECT_GIT_FAILED" });
  assert.deepEqual(validateProjectGitSummary(clean), clean);
});
