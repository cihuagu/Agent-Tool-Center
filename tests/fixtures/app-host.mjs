// Test host for the real product server, with no additional HTTP routes.
import { createApp } from "../../src/server.mjs";
import { createMcpHub } from "../../src/mcphub-adapter.mjs";
import { writeFile } from "node:fs/promises";

let app, mcp;
async function boot(fixtureCase = {}) {
  mcp = createMcpHub({ fixtureCase });
  app = createApp({ mcp });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  await mcp.discover();
  const info = { address: app.server.address(), pid: process.pid, workerPid: mcp.pid, runDirectory: mcp.runDirectory };
  if (process.send) process.send({ started: true, ...info });
  else { await writeFile(".cache/integration-evidence/browser-host.json", JSON.stringify(info)); console.log(JSON.stringify(info)); }
}
async function close() {
  app?.server.closeAllConnections();
  app?.server.close();
  await app?.close();
  process.exit(0);
}
if (process.send) {
  process.on("message", m => { if (m?.method === "boot") boot(m.fixtureCase); if (m?.method === "stop") close(); });
  process.on("disconnect", close);
  process.send({ ready: true });
} else await boot();
process.once("SIGINT", close);
process.once("SIGTERM", close);
