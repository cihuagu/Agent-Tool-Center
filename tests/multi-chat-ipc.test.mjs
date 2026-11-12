import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManager, endpointFor, requestManager } from '../src/multi-chat-manager.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
const execFileAsync = promisify(execFile);

function endpoint() {
  mkdirSync(cache, { recursive: true });
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\atc-test-${randomUUID()}`
    : path.join(cache, `t-${randomBytes(6).toString('hex')}.sock`);
}

function bounded(promise, ms = 2000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('rejects arbitrary operations and fields; secondary asks primary to display', async () => {
  const address = endpoint();
  const frames = [];
  let factories = 0;
  let onClose;
  const factory = async (options) => {
    factories++;
    onClose = options.onClose;
    return { write: (frame) => frames.push(frame), close: async () => ({ cleanupFailed: false }) };
  };
  const first = createManager({ endpoint: address, rendererFactory: factory });
  const second = createManager({ endpoint: address, rendererFactory: factory });
  try {
    assert.deepEqual(await first.start(), { primary: true });
    assert.equal((await requestManager({ op: 'quit' }, { endpoint: address })).ok, false);
    assert.equal((await requestManager({ op: 'ping', command: 'anything' }, { endpoint: address })).ok, false);
    assert.deepEqual(await second.start(), { primary: false });
    assert.equal(factories, 1);
    assert.equal((await requestManager({ op: 'snapshot' }, { endpoint: address })).snapshot.displayRequest, 1);
    assert.equal(frames.at(-1).displayRequest, 1);
    onClose();
    await first.close();
    await assert.rejects(requestManager({ op: 'ping' }, { endpoint: address }));
  } finally {
    await second.close();
    await first.close();
  }
});

test('concurrent starts elect one primary and request its display', async () => {
  const address = endpoint();
  let factories = 0;
  const factory = async () => {
    factories++;
    return { write() {}, close: async () => ({ cleanupFailed: false }) };
  };
  const managers = [
    createManager({ endpoint: address, rendererFactory: factory }),
    createManager({ endpoint: address, rendererFactory: factory }),
  ];
  try {
    const results = await bounded(Promise.all(managers.map((manager) => manager.start())));
    assert.deepEqual(results.map((result) => result.primary).sort(), [false, true]);
    assert.equal(factories, 1);
    assert.equal((await requestManager({ op: 'snapshot' }, { endpoint: address })).snapshot.displayRequest, 1);
    const primary = managers[results.findIndex((result) => result.primary)];
    const secondary = managers[results.findIndex((result) => !result.primary)];
    await bounded(secondary.close());
    assert.equal((await requestManager({ op: 'ping' }, { endpoint: address })).ok, true);
    await bounded(primary.close());
    await assert.rejects(requestManager({ op: 'ping' }, { endpoint: address }));
  } finally {
    await bounded(Promise.all(managers.map((manager) => manager.close())));
  }
});

test('immediate close waits for startup cleanup and leaves no listener or late renderer', async () => {
  const address = endpoint();
  const managerUrl = pathToFileURL(path.join(root, 'src', 'multi-chat-manager.mjs')).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createManager, requestManager } from ${JSON.stringify(managerUrl)};
    const address = ${JSON.stringify(address)};
    let rendererClosed = 0;
    let closed = false;
    let appearedAfterClose = false;
    const manager = createManager({ endpoint: address, rendererFactory: async () => {
      if (closed) appearedAfterClose = true;
      return { write() {}, close: async () => { rendererClosed++; return { cleanupFailed: false }; } };
    } });
    const start = manager.start();
    const close = manager.close().then((result) => { closed = true; return result; });
    const [started, result] = await Promise.allSettled([start, close]);
    assert.equal(result.status, 'fulfilled');
    assert.deepEqual(result.value, { cleanupFailed: false });
    assert.equal(appearedAfterClose, false);
    if (started.status === 'fulfilled' && started.value.primary) assert.equal(rendererClosed, 1);
    await assert.rejects(requestManager({ op: 'ping' }, { endpoint: address, timeoutMs: 200 }));
    assert.deepEqual(await manager.close(), result.value);
    await assert.rejects(manager.start());
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    timeout: 2500, windowsHide: true,
  });
});

test('close aggregates cleanup failure from a pending renderer exactly once', async () => {
  const address = endpoint();
  let release;
  let entered;
  const factoryEntered = new Promise((resolve) => { entered = resolve; });
  const pendingRenderer = new Promise((resolve) => { release = resolve; });
  let closeCount = 0;
  const manager = createManager({ endpoint: address, rendererFactory: async () => {
    entered();
    return pendingRenderer;
  } });
  const start = manager.start();
  try {
    await bounded(factoryEntered);
    let closeSettled = false;
    const closing = manager.close().then((result) => {
      closeSettled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    release({ write() {}, close: async () => {
      closeCount++;
      return { cleanupFailed: true };
    } });
    const [, result] = await bounded(Promise.all([start, closing]));
    assert.deepEqual(result, { cleanupFailed: true });
    assert.equal(closeCount, 1);
    assert.deepEqual(await bounded(manager.close()), result);
    await assert.rejects(manager.start());
    await assert.rejects(requestManager({ op: 'ping' }, { endpoint: address }));
  } finally {
    release?.({ write() {}, close: async () => ({ cleanupFailed: true }) });
    await bounded(Promise.allSettled([start, manager.close()]));
  }
});

test('malformed frames are rejected and disconnects do not stop the service', async () => {
  const address = endpoint();
  const manager = createManager({ endpoint: address, rendererFactory: async () => ({
    write() {}, close: async () => ({ cleanupFailed: false }),
  }) });
  try {
    await manager.start();
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(address, () => socket.write('{bad}\n'));
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(JSON.parse(data)));
      socket.on('error', reject);
    });
    assert.deepEqual(response, { ok: false, error: 'invalid request' });
    assert.equal((await requestManager({ op: 'ping' }, { endpoint: address })).ok, true);
  } finally {
    await manager.close();
  }
});

test('endpoint is deterministic and scoped by user and project', () => {
  const first = endpointFor('C:\\project', 'alice', 'win32');
  assert.equal(first, endpointFor('c:\\PROJECT', 'alice', 'win32'));
  assert.notEqual(first, endpointFor('C:\\project', 'bob', 'win32'));
});
