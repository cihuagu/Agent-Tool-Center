import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
const records = path.join(cache, 'hook-maintenance');
const script = path.join(root, 'scripts', 'manage-hooks.mjs');
const sentinel = 'CLI_FOREIGN_COMMAND_SECRET_DO_NOT_PRINT';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const windowsOnly = {
  skip: process.platform !== 'win32' && '实际应用仅支持 Windows，POSIX ACL 发布尚未验证',
};

async function setFixtureOwner(target) {
  if (process.platform !== 'win32') return;
  const quoted = `'${target.replace(/'/g, "''")}'`;
  let result;
  try {
    result = await execFileAsync(path.join(
      process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    ), ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      try {
        $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $before = [IO.File]::GetAccessControl(
          ${quoted}, [Security.AccessControl.AccessControlSections]::Owner
        )
        if ($before.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne
            $current.Value) {
          $acl = New-Object Security.AccessControl.FileSecurity
          $acl.SetOwner($current)
          [IO.File]::SetAccessControl(${quoted}, $acl)
        }
        $actual = [IO.File]::GetAccessControl(
          ${quoted}, [Security.AccessControl.AccessControlSections]::Owner
        )
        if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne
            $current.Value) { throw 'invalid' }
      } catch {
        [Console]::Error.Write('fixture owner setup failed')
        exit 1
      }
    `], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4096,
    });
  } catch {
    assert.fail('测试文件所有者设置失败');
  }
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

async function fixture(t) {
  let api;
  try {
    api = await import('../src/hook-maintenance-store.mjs');
  } catch (error) {
    assert.fail(`缺少 Hook 维护实现，CLI 测试尚不能运行 (${error.code ?? 'load_failed'})`);
  }
  assert.equal(typeof api.prepareOperation, 'function', '缺少 prepareOperation 实现');
  assert.ok((await fs.stat(script).catch(() => null))?.isFile(), '缺少 scripts/manage-hooks.mjs 实现');
  assert.equal(await fs.realpath(root), root);
  await fs.mkdir(cache, { recursive: true });
  assert.ok(!(await fs.lstat(cache)).isSymbolicLink());
  assert.equal(await fs.realpath(cache), cache);
  const directory = path.join(cache, `hook-maintenance-cli-test-${randomUUID()}`);
  await fs.mkdir(directory);
  const target = path.join(directory, 'hooks.json');
  const original = `{\r\n "metadata": "${sentinel}", "hooks": {}\r\n}\r\n`;
  await fs.writeFile(target, original, { flag: 'wx' });
  const ownRecords = new Set();
  t.after(async () => {
    for (const record of ownRecords) {
      assert.equal(path.dirname(record), records);
      assert.match(path.basename(record), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      assert.equal(await fs.realpath(records), records);
      assert.equal(await fs.realpath(record), record);
      assert.ok(!(await fs.lstat(record)).isSymbolicLink());
      await fs.rm(record, { recursive: true });
    }
    assert.equal(path.dirname(directory), cache);
    assert.match(path.basename(directory), /^hook-maintenance-cli-test-[0-9a-f-]{36}$/);
    assert.equal(await fs.realpath(directory), directory);
    assert.ok(!(await fs.lstat(directory)).isSymbolicLink());
    await fs.rm(directory, { recursive: true });
  });
  await setFixtureOwner(target);
  async function run(args) {
    try {
      const result = await execFileAsync(process.execPath, [script, ...args], {
        cwd: root,
        env: { ...process.env, CODEX_HOME: directory },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      });
      return { ...result, code: 0 };
    } catch (error) {
      assert.equal(typeof error.code, 'number', 'CLI 必须正常退出，不能超时或启动失败');
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }
  async function preview(operation, receiptPath) {
    const args = ['preview', operation, '--target', target];
    if (receiptPath) args.push('--receipt', receiptPath);
    const result = await run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(sentinel));
    const packet = JSON.parse(result.stdout);
    assert.equal(path.dirname(path.dirname(packet.planPath)), records);
    ownRecords.add(path.dirname(packet.planPath));
    assert.equal(packet.planSha256, hash(await fs.readFile(packet.planPath)));
    assert.ok(!(await fs.readFile(packet.planPath, 'utf8')).includes(sentinel));
    return packet;
  }
  async function apply(packet) {
    const result = await run([
      'apply', '--plan', packet.planPath, '--plan-sha256', packet.planSha256,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(sentinel));
    const output = JSON.parse(result.stdout);
    assert.ok(['applied', 'noop'].includes(output.status));
    assert.ok(!(await fs.readFile(packet.receiptPath, 'utf8')).includes(sentinel));
    return output;
  }
  return { directory, target, original, run, preview, apply };
}

function assertSanitizedFailure(result, forbidden = []) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /[\u3400-\u9fff]/, '公开错误消息应为中文');
  assert.doesNotMatch(result.stderr, /\bat\s+.+:\d+:\d+|Error:|node:internal/);
  for (const value of [sentinel, ...forbidden]) {
    assert.ok(!result.stderr.includes(value), '错误不能回显外部参数、路径或正文');
  }
}

test('CLI rejects aliases, unknown/repeated flags and missing explicit arguments first', async (t) => {
  const f = await fixture(t);
  const invalid = [
    [],
    ['install', '--target', f.target],
    ['preview', 'delete', '--target', f.target],
    ['preview', 'install'],
    ['preview', 'install', '--target', f.target, '--target', f.target],
    ['preview', 'install', '--target', f.target, '--unknown', sentinel],
    ['preview', 'install', '--target', f.target, '--receipt'],
    ['preview', 'install', '--target', f.target, '--receipt', f.target, '--receipt', f.target],
    ['apply', '--target', f.target],
    ['apply', '--plan', f.target],
    ['apply', '--plan', f.target, '--plan-sha256', 'bad'],
    ['apply', '--plan', f.target, '--plan-sha256', '0'.repeat(64), '--fs', sentinel],
    ['apply', '--plan', f.target, '--plan', f.target, '--plan-sha256', '0'.repeat(64)],
    ['apply', '--plan', f.target, '--plan-sha256', '0'.repeat(64), '--plan-sha256', '0'.repeat(64)],
  ];
  for (const args of invalid) {
    assertSanitizedFailure(await f.run(args), [f.target]);
    assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
    assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  }
});

test('CLI help is read-only JSON and explains explicit approval and cooperative locking', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const help = JSON.stringify(JSON.parse(result.stdout));
  assert.match(help, /preview/);
  assert.match(help, /--plan-sha256/);
  assert.match(help, /[\u3400-\u9fff]/);
  assert.match(help, /审批|批准|同意/);
  assert.match(help, /协作/);
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
});

test('CLI refuses non-Windows apply with a fixed sanitized message', {
  skip: process.platform === 'win32' && '仅验证非 Windows 的应用拒绝路径',
}, async (t) => {
  const f = await fixture(t);
  const packet = await f.preview('install');
  const plan = await fs.readFile(packet.planPath);
  const result = await f.run([
    'apply', '--plan', packet.planPath, '--plan-sha256', packet.planSha256,
  ]);
  assertSanitizedFailure(result, [packet.planPath, f.target]);
  assert.deepEqual(JSON.parse(result.stderr), {
    code: 'unsupported_platform',
    message: '当前仅支持在 Windows 上应用 Hook 维护计划。',
  });
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  assert.deepEqual(await fs.readdir(path.dirname(packet.planPath)), ['plan.json']);
  assert.deepEqual(await fs.readFile(packet.planPath), plan);
});

test('CLI binds apply to reviewed plan bytes and refuses baseline drift without leaking data', windowsOnly, async (t) => {
  const f = await fixture(t);
  const packet = await f.preview('install');
  const wrongDigest = packet.planSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  assertSanitizedFailure(await f.run([
    'apply', '--plan', packet.planPath, '--plan-sha256', wrongDigest,
  ]), [packet.planPath, f.target]);
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
  const drift = JSON.stringify({ metadata: sentinel, later: true });
  await fs.writeFile(f.target, drift);
  assertSanitizedFailure(await f.run([
    'apply', '--plan', packet.planPath, '--plan-sha256', packet.planSha256,
  ]), [packet.planPath, f.target]);
  assert.equal(await fs.readFile(f.target, 'utf8'), drift);
});

test('real CLI previews, installs, uninstalls and rolls back only fixture hooks.json', windowsOnly, async (t) => {
  const f = await fixture(t);
  const installed = await f.preview('install');
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  const result = await f.apply(installed);
  assert.equal(result.status, 'applied');
  const installedBytes = await fs.readFile(f.target);
  assert.equal(result.afterHash, hash(installedBytes));
  const config = JSON.parse(installedBytes);
  assert.equal(config.metadata, sentinel);
  assert.equal(Object.keys(config.hooks).length, 8);
  assert.equal(Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks)).length, 8);

  const repeated = await f.preview('install', installed.receiptPath);
  assert.equal((await f.apply(repeated)).status, 'noop');
  assert.deepEqual(await fs.readFile(f.target), installedBytes);

  const removal = await f.preview('uninstall', installed.receiptPath);
  await f.apply(removal);
  assert.ok((await fs.stat(f.target)).isFile());
  assert.equal((await readJson(f.target)).metadata, sentinel);
  const restoreRemoval = await f.preview('rollback', removal.receiptPath);
  await f.apply(restoreRemoval);
  assert.deepEqual(await fs.readFile(f.target), installedBytes);

  const restoreInstall = await f.preview('rollback', installed.receiptPath);
  await f.apply(restoreInstall);
  assert.equal(await fs.readFile(f.target, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
});

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
