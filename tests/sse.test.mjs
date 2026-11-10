import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";

test("SSE actually delivers a real tool execution result", async t => {
  const { server } = createApp();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = "http://127.0.0.1:" + server.address().port;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  t.after(async () => {
    clearTimeout(timer);
    controller.abort();
    await new Promise(resolve => server.close(resolve));
  });

  const sse = await fetch(root + "/api/events", { signal: controller.signal });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const reader = sse.body.getReader();

  const planned = await fetch(root + "/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "检查本机 Node.js 运行环境" })
  }).then(res => res.json());
  const selected = planned.candidates.find(tool => tool.toolId === "runtime.node");
  assert.equal(selected.recommended, true);

  const started = await fetch(root + "/api/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: planned.planId,
      mode: "manual",
      toolIds: ["runtime.node"]
    })
  }).then(res => res.json());

  const decoder = new TextDecoder();
  let buffer = "";
  let receivedSuccess = false;
  try {
    while (!receivedSuccess) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";
      for (const block of messages) {
        const line = block.split("\n").find(part => part.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.taskId === started.taskId && event.toolId === "runtime.node" && event.status === "succeeded") {
          assert.match(event.resultSummary, /^v\d/);
          receivedSuccess = true;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  assert.equal(receivedSuccess, true, "browser-compatible event stream must receive actual tool success");
});
