import cp from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const base = fileURLToPath(new URL("../", import.meta.url));
const hubBase = path.join(base, ".cache", "mcphub-eval");
const run = process.cwd();
const fixture = path.join(base, "tests", "fixtures", "read-only-mcp.mjs");
if (!process.send || path.dirname(run) !== path.join(base, ".cache", "mcphub-integration")) process.exit(1);
// Windows may restore profile variables at process creation; remove them before loading Hub code.
for (const key of Object.keys(process.env)) {
  if (!["SYSTEMROOT", "TEMP", "TMP"].includes(key.toUpperCase())) delete process.env[key];
}
for (const level of ["log", "info", "debug", "error", "warn"]) console[level] = () => {};

// All dependency-initiated process creation is limited to the one trusted fixture.
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (command !== process.execPath || args?.length !== 1 || args[0] !== fixture || options?.shell) throw Error("DENIED");
  return spawn(command, [fixture], { ...options, cwd: run, shell: false, windowsHide: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), TEMP: run, TMP: run } });
};
for (const method of ["exec", "execSync", "execFile", "execFileSync", "fork", "spawnSync"])
  cp[method] = () => { throw Error("DENIED"); };
syncBuiltinESMExports();

let hub, stopping = false;
const context = { sessionId: "agent-tool-center-local" };
const settingsPath = path.join(run, "settings.json");
async function check() {
  // A corrupt/missing config must not inherit the upstream cache's permissive fallback.
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (Object.keys(settings.mcpServers).length !== 1 ||
      settings.mcpServers.fixture.command !== process.execPath ||
      JSON.stringify(settings.mcpServers.fixture.args) !== JSON.stringify([fixture]) ||
      !Array.isArray(settings.systemConfig.toolPolicies) || !settings.systemConfig.toolPolicies.length)
    throw Error("DENIED");
  const server = hub.getServerByName("fixture");
  if (server?.status !== "connected" || server.name !== "fixture") throw Error("DENIED");
  const result = await hub.handleListToolsRequest({ params: {} }, context);
  const matches = result?.tools?.filter(t => t.name === "fixture-read");
  if (matches?.length !== 1 || matches[0].inputSchema?.type !== "object" ||
      matches[0].inputSchema.additionalProperties !== false ||
      Object.keys(matches[0].inputSchema.properties ?? {}).length !== 0) throw Error("DENIED");
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 1000);
  await hub?.getServerByName("fixture")?.client?.close().catch(() => {});
  clearTimeout(timer);
  process.exit(0);
}
process.on("disconnect", shutdown);
process.on("uncaughtException", shutdown);
process.on("unhandledRejection", shutdown);
process.on("message", async message => {
  if (message?.method === "stop") return shutdown();
  const reply = body => process.send?.({ id: message.id, ...body });
  try {
    if (message.method === "boot" && !hub) {
      writeFileSync(path.join(run, "fixture-case.json"), JSON.stringify(message.fixtureCase ?? {}), { flag: "wx" });
      writeFileSync(settingsPath, JSON.stringify({ mcpServers: { fixture: {
        type: "stdio", command: process.execPath, args: [fixture], visibility: "public",
        options: { timeout: 500 }, tools: { disabled: { enabled: false } }
      } }, users: [], systemConfig: { oauthServer: { enabled: false },
        activityLog: { storeToolPayload: false }, toolPolicies: [
          { id: "read-only", effect: "allow", tool: "read" },
          { id: "blocked", effect: "deny", tool: "blocked" }
        ] } }), { flag: "wx" });
      process.env.MCPHUB_SETTING_PATH = settingsPath;
      const require = createRequire(path.join(hubBase, "package.json"));
      await import(pathToFileURL(require.resolve("reflect-metadata")).href);
      hub = await import(pathToFileURL(path.join(hubBase, "dist", "services", "mcpService.js")).href);
      await hub.initializeClientsFromSettings(true);
      for (let i = 0; i < 160 && !hub.getServerByName("fixture")?.tools?.length; i++) await delay(50);
      await check();
      return reply({ ok: true });
    }
    if (!hub || !["check", "call"].includes(message.method)) return reply({ ok: false, code: "MCP_DENIED" });
    await check();
    if (message.method === "check") return reply({ ok: true });
    const result = await hub.handleCallToolRequest({ params: { name: "fixture-read", arguments: {} } }, context);
    if (result?.isError === true) return reply({ ok: false, code: result.evalTimeout === true ? "MCP_TIMEOUT" : "MCP_TOOL_ERROR" });
    if (result?.isError !== undefined && result.isError !== false || result?.content?.length !== 1 ||
        result.content[0].type !== "text" || result.content[0].text !== "fixture-ok")
      return reply({ ok: false, code: "MCP_PROTOCOL_ERROR" });
    reply({ ok: true, value: "fixture-ok" });
  } catch {
    reply({ ok: false, code: "MCP_DENIED" });
  }
});
process.send({ ready: true });
