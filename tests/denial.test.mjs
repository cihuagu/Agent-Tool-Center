import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server.mjs";

test("direct rejection never echoes untrusted tool, plan or argument text", async t => {
  const app = createApp();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close?.();
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const marker = "sample-" + randomUUID();
  const post = body => fetch(base + "/api/execute", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const planned = await fetch(base + "/api/plan", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "检查 Node.js" })
  }).then(r => r.json());
  const denied = await post({ planId: planned.planId, mode: "manual", toolIds: [marker], arguments: { sample: marker } });
  assert.equal(denied.status, 403);
  const raw = await denied.text();
  await post({ planId: marker, mode: "mixed", toolIds: [marker] });
  const history = await fetch(base + "/api/history").then(r => r.text());
  assert.equal((raw + history).includes(marker), false, "rejection must omit arbitrary caller text");
  assert.ok(app.getEvents().every(e => e.status === "denied"));
});
