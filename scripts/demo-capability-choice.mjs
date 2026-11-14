import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createCapabilityAdvisor } from "../src/capability-advisor.mjs";

const args = process.argv.slice(2);
const mode = args.length === 0 ? "auto" : args[1];
const validArgs = args.length === 0 ||
  (args.length === 2 && args[0] === "--mode" &&
    ["auto", "recommend", "manual"].includes(mode));
const readme = new URL("../README.md", import.meta.url);
const summary = {
  selected: null,
  actual: null,
  matchesSelection: null,
  outcome: "not_run",
  lineCount: 0,
  digest: null,
  quality: "not_assessed"
};

async function readFileLines() {
  const text = await readFile(readme, "utf8");
  if (text === "") return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(0, 3);
}

async function readStreamLines() {
  const source = createReadStream(readme, { encoding: "utf8" });
  let sourceError;
  source.on("error", error => { sourceError = error; });
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  const lines = [];
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length === 3) break;
    }
    if (sourceError) throw sourceError;
    return lines;
  } finally {
    reader.close();
    source.destroy();
  }
}

async function promptChoice() {
  console.log("请选择 A / B，输入 q 取消：");
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    return await new Promise(resolve => {
      reader.once("line", resolve);
      reader.once("close", () => resolve(null));
    });
  } finally {
    reader.close();
    process.stdin.pause();
  }
}

async function run() {
  const advisor = createCapabilityAdvisor();
  function call(name, arguments_) {
    const result = advisor.dispatch({ name, arguments: arguments_ });
    if (result.isError) throw new Error("本地演示流程失败。");
    return result.structuredContent;
  }
  try {
    call("list_capabilities", {});
    const candidates = [
      {
        capabilityId: "demo_read_file",
        name: "LOCAL demo A readFile",
        execution: { type: "local_cli", id: "demo_read_file" },
        priority: 10
      },
      {
        capabilityId: "demo_read_stream",
        name: "LOCAL demo B createReadStream readline",
        execution: { type: "local_cli", id: "demo_read_stream" },
        priority: 20
      }
    ].map(candidate => ({
      ...candidate,
      kind: "cli",
      sourceId: "local_demo",
      taskTypes: ["demo_read"],
      availability: "ready"
    }));
    call("refresh_capabilities", { capabilities: candidates });
    console.log("本地 LOCAL demo 演示候选：");
    console.log("A demo_read_file — readFile，优先值 10");
    console.log("B demo_read_stream — createReadStream + readline，优先值 20");
    const comparison = call("compare_capabilities", {
      taskType: "demo_read",
      mode,
      candidates: candidates.map(({ capabilityId, availability }) => ({
        capabilityId, availability
      }))
    });
    if (mode === "recommend") console.log(comparison.explanation);
    let selection = comparison.selection;
    if (mode === "manual") {
      const choice = await promptChoice();
      const capabilityId = {
        A: "demo_read_file",
        B: "demo_read_stream"
      }[choice];
      if (!capabilityId) return;
      const candidate = comparison.candidates.find(item =>
        item.capabilityId === capabilityId);
      selection = call("select_capability", {
        comparisonId: comparison.comparisonId,
        candidateId: candidate.candidateId,
        reason: "user_requested"
      }).selection;
    }
    if (!selection) return;
    call("report_task_status", {
      selectionId: selection.selectionId,
      state: "running",
      reason: "none"
    });
    summary.selected = selection.capabilityId;
    summary.actual = selection.capabilityId;
    summary.matchesSelection = true;
    summary.outcome = "failed";
    try {
      const lines = await (selection.capabilityId === "demo_read_file"
        ? readFileLines() : readStreamLines());
      summary.lineCount = lines.length;
      summary.digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
      summary.outcome = "succeeded";
    } catch {
      console.error("本地演示读取失败。");
      process.exitCode = 1;
    }
    const { report } = call("report_capability_use", {
      selectionId: selection.selectionId,
      actualCapabilityId: summary.actual,
      outcome: summary.outcome,
      quality: "not_assessed"
    });
    summary.matchesSelection = report.matchesSelection;
  } finally {
    advisor.close();
  }
}

if (!validArgs) {
  console.error("参数无效；用法：node scripts/demo-capability-choice.mjs [--mode auto|recommend|manual]");
  process.exitCode = 1;
} else {
  try {
    await run();
  } catch {
    console.error("本地演示流程失败。");
    process.exitCode = 1;
  }
  console.log(JSON.stringify(summary));
}
