import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doctorUrl = new URL('../scripts/doctor.mjs', import.meta.url);
const execFileAsync = promisify(execFile);
const sdkSpecifier = '@modelcontextprotocol/sdk-v1/client/index.js';
const systemRoot = 'C:\\Windows';
const frameworks = ['Framework64', 'Framework'].map((name) =>
  path.win32.join(systemRoot, 'Microsoft.NET', name, 'v4.0.30319'));
const assemblies = [
  'System.Windows.Forms.dll',
  'System.Drawing.dll',
  'System.Web.Extensions.dll',
];
const sources = [
  path.join(root, 'src', 'MultiChatWindow.cs'),
  path.join(root, 'src', 'status-window', 'AgentStatusWindow.cs'),
];
const privateText = 'PRIVATE_USER_CONTENT_AND_ERROR_DETAIL';

function failure(code) {
  return Object.assign(new Error(privateText), { code });
}

// Contract: runDoctor returns only { checks }; these are injectable observations,
// not executable commands. Omit requestManager to exercise the existing IPC client.
function options(overrides = {}) {
  return {
    nodeVersion: '22.0.0',
    platform: 'win32',
    env: { SystemRoot: systemRoot },
    access: async () => {},
    importSdk: async () => ({}),
    requestManager: async () => ({ ok: true }),
    ...overrides,
  };
}

async function diagnose(overrides = {}) {
  const { runDoctor } = await import(doctorUrl.href);
  return runDoctor(options(overrides));
}

function check(report, id) {
  const matches = report.checks.filter((item) => item.id === id);
  assert.equal(matches.length, 1, `expected exactly one ${id} check`);
  return matches[0];
}

function status(report, id, expected) {
  assert.equal(check(report, id).status, expected);
}

function sanitized(report) {
  const encoded = JSON.stringify(report);
  for (const secret of [privateText, systemRoot, root]) {
    assert.equal(encoded.includes(secret), false, 'report must omit private details');
  }
}

function bounded(promise, ms = 2500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function withPeer(onFrame, action) {
  const cache = path.join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const ownedDirectory = await mkdtemp(path.join(cache, 'doctor-test-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\atc-doctor-test-${randomUUID()}`
    : path.join(ownedDirectory, 'peer.sock');
  const sockets = new Set();
  const frames = [];
  let resolveClosed;
  const clientClosed = new Promise((resolve) => { resolveClosed = resolve; });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      resolveClosed();
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      const frame = data.slice(0, newline);
      data = data.slice(newline + 1);
      frames.push(JSON.parse(frame));
      onFrame(socket);
    });
  });
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    }));
    await action({ endpoint, frames, clientClosed, sockets });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await bounded(new Promise((resolve) => server.close(resolve)));
    }
    await rm(ownedDirectory, { recursive: true, force: true });
  }
}

test('import has no CLI output or process-lifetime side effects', async () => {
  const result = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(doctorUrl.href)});`,
  ], { cwd: root, timeout: 3000, windowsHide: true });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI rejects every supplied argument with one fixed sanitized error', async () => {
  for (const args of [['--help'], ['--endpoint', privateText], [privateText], ['--']]) {
    let result;
    try {
      await execFileAsync(process.execPath, [
        fileURLToPath(doctorUrl), ...args,
      ], { cwd: root, timeout: 3000, windowsHide: true });
      assert.fail('arguments must produce a nonzero exit');
    } catch (error) {
      result = error;
    }
    assert.equal(typeof result.code, 'number');
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Doctor does not accept arguments.\n');
  }
});

test('nodeVersion seam: missing and unsupported Node versions are not_ready', async () => {
  for (const nodeVersion of [undefined, '', '18.20.0', '21.9.0']) {
    status(await diagnose({ nodeVersion }), 'node', 'not_ready');
  }
});

test('nodeVersion seam: malformed versions are unknown rather than accepted by a prefix', async () => {
  for (const nodeVersion of ['22', '22.0', '22.0.0junk', 'garbage', '22.0.0.1']) {
    status(await diagnose({ nodeVersion }), 'node', 'unknown');
  }
});

test('importSdk(specifier) seam: missing official SDK is not_ready', async () => {
  const report = await diagnose({
    importSdk: async (specifier) => {
      assert.equal(specifier, sdkSpecifier);
      throw failure('ERR_MODULE_NOT_FOUND');
    },
  });
  status(report, 'sdk', 'not_ready');
  sanitized(report);
});

test('SDK access denial and unrecognized import failures remain unknown', async () => {
  for (const code of ['EACCES', 'ERR_UNKNOWN_FILE_EXTENSION']) {
    const report = await diagnose({
      importSdk: async () => { throw failure(code); },
    });
    status(report, 'sdk', 'unknown');
    sanitized(report);
  }
});

test('platform/env seams: unsupported native UI and invalid SystemRoot are distinguished', async () => {
  status(await diagnose({ platform: 'linux' }), 'native_compiler', 'not_ready');
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'relative' }]) {
    status(await diagnose({ env }), 'native_compiler', 'unknown');
  }
});

test('access(path) seam: missing compiler candidates fail; denied access stays unknown', async () => {
  for (const firstCode of ['ENOENT', 'EACCES']) {
    const report = await diagnose({
      access: async (target) => {
        if (target === path.win32.join(frameworks[0], 'csc.exe')) {
          throw failure(firstCode);
        }
        if (target === path.win32.join(frameworks[1], 'csc.exe')) {
          throw failure('ENOENT');
        }
      },
    });
    status(report, 'native_compiler', firstCode === 'ENOENT' ? 'not_ready' : 'unknown');
    sanitized(report);
  }
});

test('an existing first compiler with a missing assembly must not use the fallback', async () => {
  const visited = [];
  const report = await diagnose({
    access: async (target) => {
      visited.push(target);
      if (target === path.win32.join(frameworks[0], assemblies[0])) {
        throw failure('ENOENT');
      }
    },
  });
  status(report, 'native_compiler', 'not_ready');
  assert.equal(visited.some((target) => target.startsWith(frameworks[1])), false);
});

test('assembly denial is unknown; both fixed project sources must be accessible', async () => {
  const deniedAssembly = await diagnose({
    access: async (target) => {
      if (target === path.win32.join(frameworks[0], assemblies[1])) {
        throw failure('EACCES');
      }
    },
  });
  status(deniedAssembly, 'native_compiler', 'unknown');
  for (const source of sources) {
    for (const code of ['ENOENT', 'EACCES']) {
      const report = await diagnose({
        access: async (target) => {
          if (target === source) throw failure(code);
        },
      });
      status(report, 'native_sources', code === 'ENOENT' ? 'not_ready' : 'unknown');
      sanitized(report);
    }
  }
});

for (const group of [
  { id: 'native_sources', targets: sources.slice(0, 2) },
  {
    id: 'native_compiler',
    targets: assemblies.slice(0, 2).map((name) => path.win32.join(frameworks[0], name)),
  },
]) {
  test(`${group.id}: a missing file dominates denied access in either order`, async () => {
    for (const codes of [['ENOENT', 'EACCES'], ['EACCES', 'ENOENT']]) {
      const report = await diagnose({
        access: async (target) => {
          const index = group.targets.indexOf(target);
          if (index >= 0) throw failure(codes[index]);
        },
      });
      status(report, group.id, 'not_ready');
      for (const id of ['node', 'sdk', 'native_compiler', 'native_sources', 'manager']) {
        if (id !== group.id) status(report, id, 'ready');
      }
      status(report, 'hook_trust', 'unknown');
      status(report, 'event_source', 'unknown');
      sanitized(report);
    }
  });
}

test('default Windows probe requires regular compiler and assembly files', {
  skip: process.platform !== 'win32',
}, async () => {
  const cache = path.resolve(root, '.cache');
  await mkdir(cache, { recursive: true });
  const ownedDirectory = await mkdtemp(path.join(cache, 'doctor-files-test-'));
  const directory = path.join(ownedDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(directory, 'csc.exe');
  const directoryAssembly = path.join(directory, assemblies[0]);
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(compiler);
    for (const assembly of assemblies) {
      await writeFile(path.join(directory, assembly), '');
    }
    const overrides = { env: { SystemRoot: ownedDirectory }, access: undefined };
    status(await diagnose(overrides), 'native_compiler', 'not_ready');

    await rmdir(compiler);
    await writeFile(compiler, '');
    await rm(directoryAssembly);
    await mkdir(directoryAssembly);
    status(await diagnose(overrides), 'native_compiler', 'not_ready');

    await rmdir(directoryAssembly);
    await writeFile(directoryAssembly, '');
    status(await diagnose(overrides), 'native_compiler', 'ready');
  } finally {
    const relative = path.relative(cache, path.resolve(ownedDirectory));
    assert.ok(relative && relative !== '..'
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'recursive cleanup must remain inside the project cache');
    await rm(ownedDirectory, { recursive: true, force: true });
  }
});

test('requestManager seam: unavailable, timeout, and unexpected responses are unknown', async () => {
  const observations = [
    async () => { throw failure('ECONNREFUSED'); },
    async () => { throw failure('ETIMEDOUT'); },
    async () => null,
    async () => [],
    async () => ({ ok: 'true', content: privateText }),
    async () => ({ content: privateText }),
  ];
  for (const requestManager of observations) {
    const report = await diagnose({ requestManager });
    status(report, 'manager', 'unknown');
    assert.match(check(report, 'manager').nextStep, /manager/i);
    sanitized(report);
  }
});

test('an explicit negative manager response is not_ready without exposing its content', async () => {
  const report = await diagnose({
    requestManager: async () => ({ ok: false, error: privateText }),
  });
  status(report, 'manager', 'not_ready');
  sanitized(report);
});

test('endpoint seam: real hanging IPC peer times out and the client socket is cleaned', async () => {
  await withPeer(() => {}, async ({ endpoint, frames, clientClosed, sockets }) => {
    const report = await bounded(diagnose({ endpoint, requestManager: undefined }));
    status(report, 'manager', 'unknown');
    assert.match(check(report, 'manager').nextStep, /manager/i);
    await bounded(clientClosed);
    assert.equal(sockets.size, 0);
    assert.deepEqual(frames, [{ op: 'ping' }]);
    sanitized(report);
  });
});

test('real IPC invalid response is unknown; valid ping proves reachability only', async () => {
  for (const response of ['not-json\n', '{"ok":true}\n']) {
    await withPeer((socket) => socket.end(response), async ({ endpoint, frames }) => {
      const report = await bounded(diagnose({ endpoint, requestManager: undefined }));
      status(report, 'manager', response.startsWith('{') ? 'ready' : 'unknown');
      status(report, 'hook_trust', 'unknown');
      status(report, 'event_source', 'unknown');
      assert.deepEqual(frames, [{ op: 'ping' }]);
    });
  }
});

test('native fallback is allowed only after the preferred compiler is missing', async () => {
  const visited = [];
  const report = await diagnose({
    access: async (target) => {
      visited.push(target);
      if (target === path.win32.join(frameworks[0], 'csc.exe')) {
        throw failure('ENOENT');
      }
    },
  });
  status(report, 'native_compiler', 'ready');
  const preferred = visited.indexOf(path.win32.join(frameworks[0], 'csc.exe'));
  const fallback = visited.indexOf(path.win32.join(frameworks[1], 'csc.exe'));
  assert.ok(preferred >= 0 && fallback > preferred);
  for (const assembly of assemblies) {
    assert.ok(visited.includes(path.win32.join(frameworks[1], assembly)));
  }
});

test('ready observations produce bounded English JSON, exact SDK import, and ping only', async () => {
  const accessed = [];
  const imports = [];
  const requests = [];
  const endpoint = 'test-only-endpoint';
  const report = await diagnose({
    endpoint,
    access: async (target) => { accessed.push(target); },
    importSdk: async (specifier) => { imports.push(specifier); return {}; },
    requestManager: async (...args) => { requests.push(args); return { ok: true }; },
  });
  assert.deepEqual(Object.keys(report), ['checks']);
  assert.deepEqual(report.checks.map((item) => item.id).sort(), [
    'event_source', 'hook_trust', 'manager', 'native_compiler',
    'native_sources', 'node', 'sdk',
  ]);
  for (const item of report.checks) {
    assert.deepEqual(Object.keys(item).sort(), ['detail', 'id', 'nextStep', 'status']);
    assert.ok(['ready', 'not_ready', 'unknown'].includes(item.status));
    for (const field of ['detail', 'nextStep']) {
      assert.equal(typeof item[field], 'string');
      assert.ok(item[field].trim().length > 0);
      assert.doesNotMatch(item[field], /[\u3400-\u9fff]/u);
    }
  }
  for (const id of ['node', 'sdk', 'native_compiler', 'native_sources', 'manager']) {
    status(report, id, 'ready');
  }
  status(report, 'hook_trust', 'unknown');
  status(report, 'event_source', 'unknown');
  assert.match(check(report, 'manager').detail, /reachab/i);
  assert.deepEqual(imports, [sdkSpecifier]);
  assert.deepEqual(requests, [[{ op: 'ping' }, { timeoutMs: 500, endpoint }]]);
  const allowed = new Set([
    ...sources,
    ...frameworks.flatMap((directory) =>
      ['csc.exe', ...assemblies].map((name) => path.win32.join(directory, name))),
  ]);
  assert.ok(accessed.every((target) => allowed.has(target)),
    'no hook configuration, authentication, logs, or directory scans');
  for (const source of sources) assert.ok(accessed.includes(source));
  sanitized(report);
});

test('trusted project root is module-relative even when cwd differs', async () => {
  const originalDirectory = process.cwd();
  const accessed = [];
  try {
    process.chdir(path.dirname(root));
    const report = await diagnose({
      access: async (target) => { accessed.push(target); },
    });
    status(report, 'native_sources', 'ready');
    for (const source of sources) assert.ok(accessed.includes(source));
  } finally {
    process.chdir(originalDirectory);
  }
});

test('Node minimum boundary and newer releases are ready', async () => {
  for (const nodeVersion of ['22.0.0', '22.12.0', '24.1.0']) {
    status(await diagnose({ nodeVersion }), 'node', 'ready');
  }
});
