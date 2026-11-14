import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseHookConfig, canonical, reconcileHookConfig } from './hook-maintenance.mjs';
import { createPreview } from '../scripts/preview-multi-chat-hooks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
];
const OPERATIONS = ['install', 'update', 'uninstall', 'rollback', 'adopt'];
const SOURCES = [
  'package.json',
  'package-lock.json',
  'src/hook-maintenance.mjs',
  'src/hook-maintenance-store.mjs',
  'scripts/manage-hooks.mjs',
  'scripts/protect-hook-backup.ps1',
  'scripts/preview-multi-chat-hooks.mjs',
  'src/multi-chat-hook.mjs',
  'src/multi-chat-manager.mjs',
  'src/multi-chat-state.mjs',
];
const PLAN_KEYS = [
  'schema', 'version', 'id', 'operation', 'target', 'beforeHash', 'afterHash',
  'noOp', 'beforeOwned', 'afterOwned', 'changeKind', 'sourceIdentity',
  'sourceReceipt', 'beforeFile', 'planPath', 'receiptPath', 'backupPath',
  'tempPath', 'lockPath',
];
const IO_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EIO', 'EBUSY',
  'EROFS', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EXDEV',
]);
const STORE_CODES = new Set([
  'invalid_operation', 'invalid_path', 'unsafe_file', 'invalid_packet',
  'source_changed', 'baseline_changed', 'receipt_conflict', 'rollback_conflict',
  'backup_failed', 'lock_conflict', 'cleanup_failed', 'recovery_required',
  'io_failed', 'unsupported_platform',
]);

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const equal = (a, b) => canonical(a) === canonical(b);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileHash = (bytes) => bytes === null ? null : digest(bytes);
const clone = (value) => structuredClone(value);

function fail(code = 'invalid_packet') {
  const error = new Error(code === 'unsupported_platform'
    ? '当前仅支持在 Windows 上应用 Hook 维护计划。'
    : code === 'recovery_required'
    ? '目标可能已经变化，必须单独预览恢复操作。'
    : code === 'rollback_conflict'
      ? '回滚存在冲突，已停止操作。'
      : 'Hook 维护校验或文件操作失败。');
  error.code = code;
  throw error;
}

function sanitized(error, replacement) {
  const code = replacement ?? (STORE_CODES.has(error?.code)
    ? error.code
    : IO_CODES.has(error?.code) ? error.code : 'io_failed');
  try {
    fail(code);
  } catch (safe) {
    if (replacement && IO_CODES.has(error?.code)) safe.ioCode = error.code;
    return safe;
  }
}

function keys(value, names) {
  if (!object(value) || !equal(Object.keys(value).sort(), [...names].sort())) fail();
}

function absolute(value) {
  if (typeof value !== 'string' || value.includes('\0')
    || !path.isAbsolute(value) || path.resolve(value) !== value) fail('invalid_path');
  return value;
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function ordinary(info, systemRuntime = false) {
  if (!info.isFile() || info.isSymbolicLink()
    || (systemRuntime ? !(info.nlink >= 1) : info.nlink !== 1)) fail('unsafe_file');
}

function windowsPowerShell() {
  const systemRoot = absolute(process.env.SystemRoot);
  if (!/^[A-Za-z]:\\/.test(systemRoot)) fail('invalid_path');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function maybeStat(io, file) {
  try {
    return await io.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Check every existing ancestor; realpath also detects Windows junctions.
async function directory(io, name) {
  absolute(name);
  const chain = [];
  for (let entry = name; ; entry = path.dirname(entry)) {
    chain.push(entry);
    if (path.dirname(entry) === entry) break;
  }
  for (const entry of chain.reverse()) {
    const info = await io.lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink()
      || await io.realpath(entry) !== entry) fail('unsafe_file');
  }
}

async function read(io, file, {
  absent = false, limit = LIMIT, systemRuntime = false,
} = {}) {
  absolute(file);
  if (systemRuntime
    && (process.platform !== 'win32' || file !== windowsPowerShell())) fail('unsafe_file');
  await directory(io, path.dirname(file));
  const first = await maybeStat(io, file);
  if (!first) {
    if (absent) return { bytes: null, info: null };
    fail('unsafe_file');
  }
  ordinary(first, systemRuntime);
  if (first.size > limit) fail('unsafe_file');
  const handle = await io.open(file, 'r');
  try {
    const opened = await handle.stat();
    ordinary(opened, systemRuntime);
    if (!sameInode(first, opened) || opened.size > limit) fail('unsafe_file');
    // A bounded read avoids allocating according to a concurrently enlarged file.
    const chunks = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) fail('unsafe_file');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const last = await handle.stat();
    const named = await io.lstat(file);
    ordinary(last, systemRuntime);
    ordinary(named, systemRuntime);
    if (!sameInode(opened, named) || last.size !== length
      || opened.size !== last.size || opened.mtimeMs !== last.mtimeMs
      || opened.ctimeMs !== last.ctimeMs) fail('unsafe_file');
    await directory(io, path.dirname(file));
    return { bytes: Buffer.concat(chunks, length), info: last };
  } finally {
    await handle.close();
  }
}

function fileIdentity(info) {
  return info === null ? null : {
    dev: String(info.dev),
    ino: String(info.ino),
    mode: info.mode & 0o777,
    uid: info.uid,
  };
}

async function targetState(io, target) {
  absolute(target);
  if (path.basename(target) !== 'hooks.json') fail('invalid_path');
  const state = await read(io, target, { absent: true });
  state.config = state.bytes === null ? {} : parseHookConfig(state.bytes);
  return state;
}

function definitionsFor(identity) {
  const entry = path.join(identity.root, 'src', 'multi-chat-hook.mjs');
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const handler = {
    type: 'command',
    command: `"${identity.node.path}" "${entry}"`,
    commandWindows: `& ${quote(identity.node.path)} ${quote(entry)}`,
    timeout: 2,
    async: false,
  };
  return Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [clone(handler)] }]]));
}

function validateIdentity(identity) {
  keys(identity, ['root', 'disposition', 'files', 'node', 'runtime']);
  absolute(identity.root);
  if (identity.disposition !== 'reviewed-working-tree-bytes') fail();
  keys(identity.files, SOURCES);
  for (const hash of Object.values(identity.files)) if (!SHA.test(hash)) fail();
  keys(identity.node, ['path', 'version', 'sha256']);
  absolute(identity.node.path);
  if (typeof identity.node.version !== 'string'
    || !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(identity.node.version)
    || !SHA.test(identity.node.sha256)) fail();
  if (process.platform === 'win32') {
    keys(identity.runtime, ['path', 'sha256']);
    if (identity.runtime.path !== windowsPowerShell()
      || !SHA.test(identity.runtime.sha256)) fail();
  } else if (identity.runtime !== null) {
    fail();
  }
}

async function runtimeIdentity(io) {
  if (process.platform !== 'win32') return null;
  const executable = windowsPowerShell();
  return {
    path: executable,
    sha256: digest((await read(io, executable, {
      limit: 512 * LIMIT, systemRuntime: true,
    })).bytes),
  };
}

async function sourceIdentity(io) {
  await directory(io, ROOT);
  const files = {};
  for (const name of SOURCES) files[name] = digest((await read(io, path.join(ROOT, name))).bytes);
  const identity = {
    root: ROOT,
    disposition: 'reviewed-working-tree-bytes',
    files,
    node: {
      path: process.execPath,
      version: process.version,
      sha256: digest((await read(io, process.execPath, { limit: 512 * LIMIT })).bytes),
    },
    runtime: await runtimeIdentity(io),
  };
  validateIdentity(identity);
  if (!equal(createPreview().hooks, definitionsFor(identity))) fail('source_changed');
  return identity;
}

function paths(root, id, target) {
  const record = path.join(root, '.cache', 'hook-maintenance', id);
  return {
    planPath: path.join(record, 'plan.json'),
    receiptPath: path.join(record, 'receipt.json'),
    backupPath: path.join(record, 'backup.bin'),
    tempPath: path.join(path.dirname(target), `.atc-hooks-${id}.tmp`),
    lockPath: path.join(path.dirname(target), '.atc-hooks.lock'),
  };
}

function ownership(value, identity) {
  if (value === null) return;
  keys(value, ['items', 'hooksAbsent', 'absentEvents']);
  if (!Array.isArray(value.items) || value.items.length !== EVENTS.length
    || typeof value.hooksAbsent !== 'boolean' || !Array.isArray(value.absentEvents)
    || new Set(value.absentEvents).size !== value.absentEvents.length
    || value.absentEvents.some((event) => !EVENTS.includes(event))) fail('receipt_conflict');
  const fixed = definitionsFor(identity);
  const seen = new Set();
  for (const item of value.items) {
    keys(item, ['event', 'context', 'handler', 'createdGroup']);
    if (!EVENTS.includes(item.event) || seen.has(item.event)
      || typeof item.createdGroup !== 'boolean' || !equal(item.context, {})
      || !equal(item.handler, fixed[item.event][0].hooks[0])) fail('receipt_conflict');
    seen.add(item.event);
  }
}

function rebound(receipt, identity) {
  if (receipt === null) return null;
  const fixed = definitionsFor(identity);
  return {
    ...clone(receipt),
    items: receipt.items.map((item) => ({
      ...clone(item), handler: clone(fixed[item.event][0].hooks[0]),
    })),
  };
}

function validatePacket(packet) {
  keys(packet, PLAN_KEYS);
  if (packet.schema !== 'atc-hook-maintenance' || packet.version !== 1
    || !UUID.test(packet.id) || !OPERATIONS.includes(packet.operation)) fail();
  absolute(packet.target);
  if (path.basename(packet.target) !== 'hooks.json') fail('invalid_path');
  validateIdentity(packet.sourceIdentity);
  for (const field of ['beforeHash', 'afterHash']) {
    if (packet[field] !== null && !SHA.test(packet[field])) fail();
  }
  if (typeof packet.noOp !== 'boolean'
    || packet.noOp !== (packet.beforeHash === packet.afterHash)
    || packet.changeKind !== (packet.noOp ? 'ownership-only'
      : packet.afterHash === null ? 'delete'
        : packet.beforeHash === null ? 'create' : 'replace')) fail();
  if (packet.beforeHash === null) {
    if (packet.beforeFile !== null) fail();
  } else {
    keys(packet.beforeFile, ['dev', 'ino', 'mode', 'uid']);
    if (!/^\d+$/.test(packet.beforeFile.dev) || !/^\d+$/.test(packet.beforeFile.ino)
      || !Number.isInteger(packet.beforeFile.mode) || packet.beforeFile.mode < 0
      || packet.beforeFile.mode > 0o777 || !Number.isInteger(packet.beforeFile.uid)) fail();
  }
  const expected = paths(packet.sourceIdentity.root, packet.id, packet.target);
  for (const [key, value] of Object.entries(expected)) if (packet[key] !== value) fail();
  if (packet.sourceReceipt !== null) {
    keys(packet.sourceReceipt, ['path', 'sha256']);
    absolute(packet.sourceReceipt.path);
    if (!SHA.test(packet.sourceReceipt.sha256)) fail();
  }
  // Rollback ownership is checked against its source receipt's computed inverse
  // in loadReceipt, or the freshly rebuilt packet in applyOperation.
  // Before ownership is likewise anchored to the supplied source receipt.
  if (packet.operation !== 'rollback') ownership(packet.afterOwned, packet.sourceIdentity);
}

function planOf(receipt) {
  keys(receipt, [...PLAN_KEYS, 'status']);
  if (!['prepared', 'applied'].includes(receipt.status)) fail('receipt_conflict');
  const { status, ...packet } = receipt;
  validatePacket(packet);
  return packet;
}

async function privateRecord(io, record) {
  await directory(io, record);
  if (process.platform !== 'win32') {
    const info = await io.lstat(record);
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) fail('unsafe_file');
  }
}

async function helper(io, identity, mode, input, temp, aclSource) {
  validateIdentity(identity);
  const script = path.join(ROOT, 'scripts', 'protect-hook-backup.ps1');
  if (digest((await read(io, script)).bytes) !== identity.files['scripts/protect-hook-backup.ps1']) {
    fail('source_changed');
  }
  const args = ['-NoProfile', '-NonInteractive', '-File', script, '-Mode', mode];
  if (temp) args.push('-Path', temp);
  if (aclSource) args.push('-AclSource', aclSource);
  const runtime = await runtimeIdentity(io);
  if (runtime === null || !equal(runtime, identity.runtime)) fail('source_changed');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(runtime.path, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let size = 0;
    let stderrSize = 0;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const stop = () => {
      child.kill();
      finish(Object.assign(new Error('备份保护失败。'), { code: 'backup_failed' }));
    };
    const timer = setTimeout(stop, 15_000);
    child.on('error', stop);
    child.stdin.on('error', stop);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * LIMIT) return stop();
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > 4096) stop();
    });
    child.on('close', (code) => {
      if (code !== 0 || stderrSize) return stop();
      finish(null, Buffer.concat(chunks).toString('ascii').trim());
    });
    child.stdin.end(input ? input.toString('base64') : undefined);
  });
  if (mode === 'secure-temp') {
    // The trusted fixed helper emits only a bounded, fixed success acknowledgement.
    if (!/^[A-Za-z][A-Za-z _-]{0,63}$/.test(output)) fail('backup_failed');
    return null;
  }
  if (!output || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output)) {
    fail('backup_failed');
  }
  const bytes = Buffer.from(output, 'base64');
  if (bytes.toString('base64') !== output || bytes.length > LIMIT + 65536) fail('backup_failed');
  return bytes;
}

async function backupBytes(io, packet) {
  if (packet.noOp || packet.beforeHash === null) {
    if (await maybeStat(io, packet.backupPath)) fail('receipt_conflict');
    return null;
  }
  await privateRecord(io, path.dirname(packet.backupPath));
  const saved = await read(io, packet.backupPath, { limit: LIMIT + 65536 });
  if (process.platform !== 'win32'
    && (saved.info.uid !== process.getuid() || (saved.info.mode & 0o777) !== 0o600)) {
    fail('unsafe_file');
  }
  const bytes = process.platform === 'win32'
    ? await helper(io, await sourceIdentity(io), 'unprotect', saved.bytes)
    : saved.bytes;
  if (bytes.length > LIMIT || digest(bytes) !== packet.beforeHash) fail('receipt_conflict');
  parseHookConfig(bytes);
  return bytes;
}

function forward(packet, config, source) {
  const result = reconcileHookConfig({
    operation: packet.operation,
    config,
    definitions: definitionsFor(packet.sourceIdentity),
    ...(source?.packet.afterOwned ? { receipt: source.packet.afterOwned } : {}),
  });
  return {
    config: result.config,
    owned: packet.operation === 'uninstall' ? null : result.receipt,
  };
}

function bytesFor(config, beforeBytes, beforeConfig) {
  return beforeBytes !== null && equal(config, beforeConfig) ? beforeBytes : encode(config);
}

function inverse(packet, state, source) {
  if (!source) fail('rollback_conflict');
  const original = source.packet;
  if (source.status === 'prepared' && fileHash(state.bytes) !== original.afterHash) {
    fail('rollback_conflict');
  }
  if (fileHash(state.bytes) === original.afterHash) {
    return {
      bytes: original.noOp ? state.bytes : source.beforeBytes,
      owned: clone(original.beforeOwned),
    };
  }
  if (original.operation === 'install' && original.beforeOwned === null) {
    const result = reconcileHookConfig({
      operation: 'uninstall', config: state.config,
      definitions: definitionsFor(original.sourceIdentity), receipt: original.afterOwned,
    });
    return { bytes: bytesFor(result.config, state.bytes, state.config), owned: null };
  }
  if (original.operation === 'update' && original.beforeOwned && original.afterOwned) {
    const definitions = Object.fromEntries(original.beforeOwned.items.map((item) => [
      item.event, [{ ...clone(item.context), hooks: [clone(item.handler)] }],
    ]));
    const result = reconcileHookConfig({
      operation: 'update', config: state.config, definitions, receipt: original.afterOwned,
    });
    return {
      bytes: bytesFor(result.config, state.bytes, state.config),
      owned: result.receipt,
    };
  }
  fail('rollback_conflict');
}

function transformation(packet, state, source) {
  if (packet.operation === 'rollback') return inverse(packet, state, source);
  const result = forward(packet, state.config, source);
  return {
    bytes: bytesFor(result.config, state.bytes, state.config),
    owned: result.owned,
  };
}

async function loadReceipt(io, receiptPath, target, seen = new Set()) {
  absolute(receiptPath);
  if (seen.has(receiptPath) || path.basename(receiptPath) !== 'receipt.json') {
    fail('receipt_conflict');
  }
  seen.add(receiptPath);
  const readResult = await read(io, receiptPath);
  const receipt = parseHookConfig(readResult.bytes);
  const packet = planOf(receipt);
  if (packet.receiptPath !== receiptPath || packet.target !== target) fail('receipt_conflict');
  await privateRecord(io, path.dirname(receiptPath));
  let source = null;
  if (packet.sourceReceipt) {
    source = await loadReceipt(io, packet.sourceReceipt.path, target, seen);
    if (source.sha256 !== packet.sourceReceipt.sha256) fail('receipt_conflict');
  }
  const expectedBefore = source?.packet.afterOwned ?? null;
  if (!equal(packet.beforeOwned, expectedBefore)) fail('receipt_conflict');
  if (packet.beforeOwned !== null && !source) fail('receipt_conflict');
  if (['update', 'uninstall', 'rollback'].includes(packet.operation) && !source) {
    fail('receipt_conflict');
  }
  if (packet.operation === 'adopt' && source) fail('receipt_conflict');
  const beforeBytes = await backupBytes(io, packet);
  if (!packet.noOp) {
    const config = beforeBytes === null ? {} : parseHookConfig(beforeBytes);
    const result = transformation(packet, { bytes: beforeBytes, config }, source);
    if (fileHash(result.bytes) !== packet.afterHash || !equal(result.owned, packet.afterOwned)) {
      fail('receipt_conflict');
    }
    if (packet.afterHash === null
      && !(packet.operation === 'rollback' && source.packet.operation === 'install'
        && source.packet.beforeHash === null
        && packet.beforeHash === source.packet.afterHash)) fail('rollback_conflict');
  } else if (packet.operation === 'adopt') {
    if (packet.beforeOwned !== null || packet.afterOwned === null
      || packet.afterOwned.hooksAbsent || packet.afterOwned.absentEvents.length
      || packet.afterOwned.items.some((item) => item.createdGroup)) fail('receipt_conflict');
  } else {
    const expected = packet.operation === 'rollback'
      ? source?.packet.beforeOwned
      : packet.operation === 'uninstall' ? null
        : rebound(expectedBefore, packet.sourceIdentity);
    if (!source || !equal(packet.afterOwned, expected)) fail('receipt_conflict');
  }
  return { packet, status: receipt.status, sha256: digest(readResult.bytes), beforeBytes };
}

async function build(io, { operation, target, receiptPath, id }) {
  if (!OPERATIONS.includes(operation)) fail('invalid_operation');
  const state = await targetState(io, target);
  const identity = await sourceIdentity(io);
  const source = receiptPath ? await loadReceipt(io, receiptPath, target) : null;
  if (['update', 'uninstall', 'rollback'].includes(operation) && !source) {
    fail('receipt_conflict');
  }
  if (operation === 'adopt' && source) fail('receipt_conflict');
  if (source?.status === 'prepared' && fileHash(state.bytes) !== source.packet.afterHash) {
    fail(operation === 'rollback' ? 'rollback_conflict' : 'receipt_conflict');
  }
  const seed = { operation, sourceIdentity: identity };
  let result;
  try {
    result = transformation(seed, state, source);
  } catch (error) {
    if (operation === 'rollback') fail('rollback_conflict');
    throw error;
  }
  if (result.bytes !== null && result.bytes.length > LIMIT) fail('invalid_packet');
  const beforeHash = fileHash(state.bytes);
  const afterHash = fileHash(result.bytes);
  const noOp = beforeHash === afterHash;
  const packet = {
    schema: 'atc-hook-maintenance',
    version: 1,
    id,
    operation,
    target,
    beforeHash,
    afterHash,
    noOp,
    beforeOwned: clone(source?.packet.afterOwned ?? null),
    afterOwned: clone(result.owned),
    changeKind: noOp ? 'ownership-only'
      : afterHash === null ? 'delete' : beforeHash === null ? 'create' : 'replace',
    sourceIdentity: identity,
    sourceReceipt: source ? { path: receiptPath, sha256: source.sha256 } : null,
    beforeFile: fileIdentity(state.info),
    ...paths(ROOT, id, target),
  };
  // Rollback may legitimately restore bindings from an older checkout.
  if (operation !== 'rollback') ownership(packet.afterOwned, identity);
  return { packet, state, candidate: result.bytes };
}

async function ensureChild(io, parent, name, mode) {
  await directory(io, parent);
  const child = path.join(parent, name);
  try {
    await io.mkdir(child, { mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await directory(io, child);
  return child;
}

async function removeOwned(io, file, owner) {
  await directory(io, path.dirname(file));
  const info = await io.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !sameInode(info, owner.info)
    || (info.nlink !== 1 && !(owner.linked && info.nlink === 2))) fail('cleanup_failed');
  if (owner.content && !equal((await read(io, file)).bytes.toString('hex'), owner.content)) {
    fail('cleanup_failed');
  }
  await io.unlink(file);
}

async function cleanup(io, owned) {
  let failed = false;
  for (const [file, owner] of [...owned].reverse()) {
    try {
      await removeOwned(io, file, owner);
      owned.delete(file);
    } catch {
      failed = true;
    }
  }
  if (failed) fail('cleanup_failed');
}

async function createFile(io, file, bytes, owned, identity, { mode = 0o600, aclSource } = {}) {
  await directory(io, path.dirname(file));
  const handle = await io.open(file, 'wx', 0o600);
  try {
    const info = await handle.stat();
    ordinary(info);
    if (info.size !== 0) fail('unsafe_file');
    owned.set(file, { info });
    if (process.platform === 'win32') {
      await helper(io, identity, 'secure-temp', null, file, aclSource);
    } else {
      if (info.uid !== process.getuid()) fail('unsafe_file');
      await handle.chmod(mode);
    }
    const named = await io.lstat(file);
    ordinary(named);
    if (!sameInode(info, named) || named.size !== 0) fail('unsafe_file');
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeReceipt(io, packet, status, owned, preparedHash) {
  const stage = path.join(path.dirname(packet.receiptPath), `receipt.${status}.tmp`);
  const bytes = encode({ ...packet, status });
  await createFile(io, stage, bytes, owned, packet.sourceIdentity);
  if (preparedHash) {
    if (digest((await read(io, packet.receiptPath)).bytes) !== preparedHash) {
      fail('receipt_conflict');
    }
  } else if (await maybeStat(io, packet.receiptPath)) {
    fail('receipt_conflict');
  }
  await io.rename(stage, packet.receiptPath);
  owned.delete(stage);
  if (digest((await read(io, packet.receiptPath)).bytes) !== digest(bytes)) {
    fail('receipt_conflict');
  }
  return digest(bytes);
}

async function verifyAgain(io, packet) {
  const fresh = await build(io, {
    operation: packet.operation,
    target: packet.target,
    receiptPath: packet.sourceReceipt?.path,
    id: packet.id,
  });
  if (!equal(fresh.packet, packet)) fail('baseline_changed');
  return fresh;
}

/**
 * Preview writes only a private project record. A digest binds reviewed bytes;
 * it does not authenticate approval. The cooperative lock is not an OS-wide CAS.
 */
export async function prepareOperation({ operation, target, receiptPath } = {}) {
  const owned = new Map();
  try {
    if (!OPERATIONS.includes(operation)) fail('invalid_operation');
    if (receiptPath !== undefined) absolute(receiptPath);
    const id = randomUUID();
    const { packet } = await build(nativeFs, { operation, target, receiptPath, id });
    await ensureChild(nativeFs, ROOT, '.cache', 0o700);
    const records = await ensureChild(nativeFs, path.join(ROOT, '.cache'), 'hook-maintenance', 0o700);
    const record = path.join(records, id);
    await nativeFs.mkdir(record, { mode: 0o700 });
    await privateRecord(nativeFs, record);
    const bytes = encode(packet);
    await createFile(nativeFs, packet.planPath, bytes, owned, packet.sourceIdentity);
    owned.delete(packet.planPath);
    return { ...packet, planSha256: digest(bytes) };
  } catch (error) {
    try {
      await cleanup(nativeFs, owned);
    } catch (cleanupError) {
      throw sanitized(cleanupError);
    }
    throw sanitized(error);
  }
}

export async function applyOperation(
  { planPath, expectedPlanSha256 } = {},
  { fs: io = nativeFs } = {},
) {
  if (process.platform !== 'win32') fail('unsupported_platform');
  const owned = new Map();
  let packet;
  let attemptedPublish = false;
  let published = false;
  let failure;
  let output;
  try {
    absolute(planPath);
    if (!SHA.test(expectedPlanSha256)) fail('invalid_packet');
    const saved = await read(io, planPath);
    if (digest(saved.bytes) !== expectedPlanSha256) fail('invalid_packet');
    packet = parseHookConfig(saved.bytes);
    validatePacket(packet);
    if (packet.planPath !== planPath || packet.sourceIdentity.root !== ROOT) fail('invalid_packet');
    await privateRecord(io, path.dirname(planPath));
    const initial = await verifyAgain(io, packet);
    if (await maybeStat(io, packet.receiptPath) || await maybeStat(io, packet.backupPath)) {
      fail('receipt_conflict');
    }
    if (packet.noOp) {
      await verifyAgain(io, packet);
      await writeReceipt(io, packet, 'applied', owned);
      output = { status: 'noop', receiptPath: packet.receiptPath, afterHash: packet.afterHash };
    } else {
      // Never steal an existing lock, including an apparently stale one.
      const lockHandle = await io.open(packet.lockPath, 'wx', 0o600);
      try {
        const info = await lockHandle.stat();
        ordinary(info);
        owned.set(packet.lockPath, { info });
        const token = Buffer.from(`${packet.id}\n`);
        await lockHandle.writeFile(token);
        await lockHandle.sync();
        owned.get(packet.lockPath).content = token.toString('hex');
      } finally {
        await lockHandle.close();
      }
      await verifyAgain(io, packet);
      if (await maybeStat(io, packet.tempPath)) fail('unsafe_file');
      if (initial.state.bytes !== null) {
        const protectedBytes = process.platform === 'win32'
          ? await helper(io, packet.sourceIdentity, 'protect', initial.state.bytes)
          : initial.state.bytes;
        const roundtrip = process.platform === 'win32'
          ? await helper(io, packet.sourceIdentity, 'unprotect', protectedBytes)
          : protectedBytes;
        if (digest(roundtrip) !== packet.beforeHash) fail('backup_failed');
        await createFile(io, packet.backupPath, protectedBytes, owned, packet.sourceIdentity);
        // Backups remain available even when later transaction steps fail.
        owned.delete(packet.backupPath);
        const verified = await backupBytes(io, packet);
        if (digest(verified) !== packet.beforeHash) fail('backup_failed');
      }
      const preparedHash = await writeReceipt(io, packet, 'prepared', owned);
      if (initial.candidate !== null) {
        await createFile(io, packet.tempPath, initial.candidate, owned, packet.sourceIdentity, {
          mode: packet.beforeFile?.mode ?? 0o600,
          ...(packet.beforeHash !== null ? { aclSource: packet.target } : {}),
        });
        if (digest((await read(io, packet.tempPath)).bytes) !== packet.afterHash) {
          fail('baseline_changed');
        }
      }
      // Recompute fixed commands, source receipt and baseline immediately before publication.
      await verifyAgain(io, packet);
      const lock = owned.get(packet.lockPath);
      const lockState = await read(io, packet.lockPath);
      if (!sameInode(lockState.info, lock.info)
        || lockState.bytes.toString('hex') !== lock.content) fail('lock_conflict');
      attemptedPublish = true;
      if (initial.candidate === null) {
        await io.unlink(packet.target);
      } else if (packet.beforeHash === null) {
        // link is exclusive: a concurrently created destination is never replaced.
        await io.link(packet.tempPath, packet.target);
        owned.get(packet.tempPath).linked = true;
        await removeOwned(io, packet.tempPath, owned.get(packet.tempPath));
        owned.delete(packet.tempPath);
      } else {
        await io.rename(packet.tempPath, packet.target);
        owned.delete(packet.tempPath);
      }
      published = true;
      const result = await read(io, packet.target, { absent: true });
      if (fileHash(result.bytes) !== packet.afterHash) fail('recovery_required');
      await writeReceipt(io, packet, 'applied', owned, preparedHash);
      output = { status: 'applied', receiptPath: packet.receiptPath, afterHash: packet.afterHash };
    }
  } catch (error) {
    if (attemptedPublish && !published) {
      try {
        published = fileHash((await read(io, packet.target, { absent: true })).bytes)
          !== packet.beforeHash;
      } catch {
        published = true;
      }
    }
    failure = sanitized(error, published ? 'recovery_required' : undefined);
  }
  try {
    await cleanup(io, owned);
  } catch (error) {
    failure = sanitized(error, published ? 'recovery_required' : 'cleanup_failed');
  }
  if (failure) throw failure;
  return output;
}
