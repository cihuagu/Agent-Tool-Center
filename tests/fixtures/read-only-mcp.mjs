// Local synthetic service: real JSON-RPC over stdio, no network or account access.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

for (const key of Object.keys(process.env)) {
  if (!["SYSTEMROOT", "TEMP", "TMP"].includes(key.toUpperCase())) delete process.env[key];
}
const record = value => appendFileSync("wire.ndjson", JSON.stringify(value) + "\n");
const scenario = () => JSON.parse(readFileSync("fixture-case.json", "utf8"));
const input = createInterface({ input: process.stdin });
const timers = new Set();
input.on("close", () => { for (const timer of timers) clearTimeout(timer); process.exit(0); });
for await (const line of input) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const reply = body => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  if (method === "initialize") {
    record({ method, pid: process.pid, protocol: "2025-11-25", envKeys: Object.keys(process.env).sort() });
    reply({ result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  } else if (method === "tools/list") {
    record({ method });
    const schema = { type: "object", properties: {}, additionalProperties: false };
    reply({ result: { tools: ["read", "disabled", "blocked", "unselected", "runtime.node"].map(name => ({
      name, inputSchema: scenario().malformedList && name === "read" ? { type: "string" } : schema
    })) } });
  } else if (method === "tools/call") {
    record({ method, name: params.name === "read" ? "read" : "other", emptyArguments: JSON.stringify(params.arguments) === "{}" });
    const { mode, marker = "" } = scenario();
    process.stderr.write(marker + "\n");
    if (mode === "timeout") continue;
    if (mode === "late") {
      const timer = setTimeout(() => { timers.delete(timer); reply({ result: { content: [{ type: "text", text: "fixture-ok" }] } }); }, 900);
      timers.add(timer); continue;
    }
    if (mode === "protocol") reply({ error: { code: -32603, message: marker } });
    else reply({ result: { isError: mode === "error", content: [{ type: "text", text: mode === "error" || mode === "unexpected" ? marker : "fixture-ok" }] } });
  } else if (method === "ping") reply({ result: {} });
  else reply({ error: { code: -32601, message: "unsupported" } });
}
