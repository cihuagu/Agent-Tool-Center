import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHookInput } from './multi-chat-state.mjs';
import { requestManager } from './multi-chat-manager.mjs';

export async function runHook({ input = process.stdin, output = process.stdout, timeoutMs = 800,
  request = requestManager, clock } = {}) {
  output.on('error', () => {});
  const started = Date.now();
  const raw = await new Promise((resolve) => {
    let size = 0;
    let chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        chunks = [];
        finish(null);
      } else chunks.push(chunk);
    }
    function onEnd() { finish(Buffer.concat(chunks).toString('utf8')); }
    function onError() { finish(null); }
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
  try {
    const event = raw === null ? null : normalizeHookInput(JSON.parse(raw), clock);
    const remaining = timeoutMs - (Date.now() - started);
    if (event && remaining > 0) {
      await request({ op: 'hook', event }, { timeoutMs: remaining });
    }
  } catch {}
  try { output.write('{}\n'); } catch {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runHook().catch(() => {
    try { process.stdout.write('{}\n'); } catch {}
  });
}
