import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMultiChatState, validateHookEvent } from './multi-chat-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FRAME = 16 * 1024;
const MAX_RESPONSE = 256 * 1024;

export function endpointFor(projectRoot, username = os.userInfo().username, platform = process.platform) {
  const resolved = platform === 'win32'
    ? path.win32.resolve(projectRoot).toLowerCase()
    : path.resolve(projectRoot);
  const hash = createHash('sha256').update(`${username}\0${resolved}`).digest('hex').slice(0, 24);
  return platform === 'win32'
    ? `\\\\.\\pipe\\agent-tool-center-${hash}`
    : path.join(projectRoot, '.cache', `atc-${hash}.sock`);
}

function validMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const keys = Object.keys(message);
  if (message.op === 'hook') {
    return keys.length === 2 && keys.includes('event') && validateHookEvent(message.event);
  }
  return keys.length === 1 && ['ping', 'display', 'snapshot'].includes(message.op);
}

export function requestManager(message, { endpoint = endpointFor(root), timeoutMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let data = Buffer.alloc(0);
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => finish(new Error('manager unavailable')), timeoutMs);
    timer.unref();
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_RESPONSE) return finish(new Error('invalid response'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        if (newline !== data.length - 1) throw new Error();
        const response = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (!response || typeof response !== 'object' || Array.isArray(response) ||
          typeof response.ok !== 'boolean' ||
          (response.ok === false && response.error !== 'invalid request') ||
          (response.ok && message.op === 'snapshot' &&
            (!response.snapshot || response.snapshot.kind !== 'multi_chat'))) throw new Error();
        finish(null, response);
      } catch {
        finish(new Error('invalid response'));
      }
    });
    socket.on('error', () => finish(new Error('manager unavailable')));
    socket.on('end', () => finish(new Error('invalid response')));
  });
}

export function createManager({
  endpoint = endpointFor(root),
  rendererFactory = async (options) => {
    const { createNativeRenderer } = await import('./status-window.mjs');
    return createNativeRenderer(options);
  },
  clock,
} = {}) {
  const state = createMultiChatState({ clock });
  const sockets = new Set();
  let server;
  let renderer;
  let timer;
  let closing;
  let startup;
  let started = false;
  let closeRequested = false;

  function render() {
    if (!renderer || closeRequested) return;
    try {
      const result = renderer.write(state.snapshot());
      if (result && typeof result.catch === 'function') result.catch(() => void close());
    } catch {
      void close();
    }
  }

  async function close() {
    if (closing) return closing;
    closeRequested = true;
    closing = (async () => {
      if (startup) await startup.catch(() => {});
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      let cleanupFailed = false;
      if (renderer) {
        try {
          const result = await renderer.close();
          cleanupFailed = !!result?.cleanupFailed;
        } catch {
          cleanupFailed = true;
        }
      }
      return { cleanupFailed };
    })();
    return closing;
  }

  function connection(socket) {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let data = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(1000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(10);
      if (data.length > MAX_FRAME || (newline >= 0 && newline !== data.length - 1)) {
        handled = true;
        socket.end('{"ok":false,"error":"invalid request"}\n');
        return;
      }
      if (newline < 0) return;
      handled = true;
      let message;
      try { message = JSON.parse(data.subarray(0, newline).toString('utf8')); } catch {}
      if (!validMessage(message)) {
        socket.end('{"ok":false,"error":"invalid request"}\n');
        return;
      }
      if (message.op === 'hook') {
        state.accept(message.event);
        render();
      } else if (message.op === 'display') {
        state.display();
        render();
      }
      const response = message.op === 'snapshot'
        ? { ok: true, snapshot: state.snapshot() }
        : { ok: true };
      const encoded = `${JSON.stringify(response)}\n`;
      socket.end(Buffer.byteLength(encoded) <= MAX_RESPONSE
        ? encoded : '{"ok":false,"error":"invalid request"}\n');
    });
  }

  async function start() {
    if (started || closeRequested) throw new Error('manager already started or closed');
    started = true;
    startup = startResources();
    return startup;
  }

  async function startResources() {
    const cache = path.join(root, '.cache');
    if (process.platform !== 'win32' && path.dirname(path.resolve(endpoint)) === cache) {
      await mkdir(cache, { recursive: true });
    }
    if (closeRequested) throw new Error('manager closed');
    server = net.createServer(connection);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: endpoint, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const response = await requestManager({ op: 'display' }, { endpoint });
      if (!response.ok) throw new Error('manager unavailable');
      return { primary: false };
    }
    server.on('error', () => void close());
    if (closeRequested) throw new Error('manager closed');
    try {
      const created = await rendererFactory({ mode: 'multi_chat', onClose: () => void close() });
      renderer = created;
      if (closeRequested) return { primary: true };
      render();
      timer = setInterval(render, 1000);
      timer.unref();
      return { primary: true };
    } catch (error) {
      void close();
      throw error;
    }
  }

  return { start, close, snapshot: state.snapshot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manager = createManager();
  manager.start().catch(() => {
    process.stderr.write('Unable to start multi-chat manager.\n');
    process.exitCode = 1;
  });
}
