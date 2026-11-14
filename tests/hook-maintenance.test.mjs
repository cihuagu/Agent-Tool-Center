import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
const records = path.join(cache, 'hook-maintenance');
const sentinel = 'FOREIGN_COMMAND_MUST_NEVER_APPEAR_IN_PUBLIC_PACKETS';
const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const foreign = () => ({ type: 'command', command: sentinel });
const windowsOnly = {
  skip: process.platform !== 'win32' && '实际应用仅支持 Windows，POSIX ACL 发布尚未验证',
};

test('non-Windows apply refuses before IO and leaves preview and target unchanged', {
  skip: process.platform === 'win32' && '仅验证非 Windows 的应用拒绝路径',
}, async (t) => {
  const f = await fixture(t, '{}\n');
  const packet = await f.prepare('install');
  const record = path.dirname(packet.planPath);
  assert.equal((await fs.stat(record)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(packet.planPath)).mode & 0o777, 0o600);
  const plan = await fs.readFile(packet.planPath);
  const before = await fs.stat(f.target);
  const noIO = new Proxy({}, {
    get() {
      assert.fail('不支持的平台必须在任何文件操作之前拒绝');
    },
  });
  await assert.rejects(() => apply(packet, { fs: noIO }), {
    code: 'unsupported_platform',
    message: '当前仅支持在 Windows 上应用 Hook 维护计划。',
  });
  await assertTarget(f.target, '{}\n');
  assert.equal((await fs.stat(f.target)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  assert.deepEqual(await fs.readdir(record), ['plan.json']);
  assert.deepEqual(await fs.readFile(packet.planPath), plan);
});

test('real Windows secure-temp protects empty files using only DACL access', windowsOnly, async (t) => {
  const f = await fixture(t);
  const temporary = path.join(f.directory, 'private.tmp');
  const copied = path.join(f.directory, 'copied.tmp');
  await fs.writeFile(temporary, '', { flag: 'wx' });
  await fs.writeFile(copied, '', { flag: 'wx' });
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const helper = quote(path.join(root, 'scripts', 'protect-hook-backup.ps1'));
  const windowsPowerShell = quote(path.join(
    process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  ));
  const result = spawnSync(path.join(
    process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  ), ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $temporary = ${quote(temporary)}
    $copied = ${quote(copied)}
    $ack = & ${windowsPowerShell} -NoProfile -NonInteractive -File ${helper} -Mode secure-temp -Path $temporary
    if ($LASTEXITCODE -ne 0 -or $ack -cne 'ok') { throw 'helper failed' }
    $acl = [IO.File]::GetAccessControl(
      $temporary, [Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical) {
      throw 'not private'
    }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'unexpected rules' }
    $identities = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if ($identities.Count -ne 2 -or $current -notin $identities -or
        'S-1-5-18' -notin $identities) { throw 'unexpected identities' }
    foreach ($rule in $rules) {
      if ($rule.IsInherited -or
          $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
          $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
          $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw 'unexpected access'
      }
    }
    $ack = & ${windowsPowerShell} -NoProfile -NonInteractive -File ${helper} -Mode secure-temp -Path $copied -AclSource $temporary
    if ($LASTEXITCODE -ne 0 -or $ack -cne 'ok') { throw 'copy failed' }
    $copyAcl = [IO.File]::GetAccessControl(
      $copied, [Security.AccessControl.AccessControlSections]::Access
    )
    $access = [Security.AccessControl.AccessControlSections]::Access
    if (-not $copyAcl.AreAccessRulesProtected -or
        $copyAcl.GetSecurityDescriptorSddlForm($access) -cne
        $acl.GetSecurityDescriptorSddlForm($access)) { throw 'copy mismatch' }
  `], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  assert.equal((await fs.readFile(temporary)).length, 0);
  assert.equal((await fs.readFile(copied)).length, 0);
});

async function load(relative, exports) {
  let module;
  try {
    module = await import(new URL(relative, import.meta.url));
  } catch (error) {
    assert.fail(`缺少可加载的 Hook 维护实现：${relative} (${error.code ?? 'load_failed'})`);
  }
  for (const name of exports) {
    assert.equal(typeof module[name], 'function', `缺少公共实现：${name}`);
  }
  return module;
}

const store = () => load('../src/hook-maintenance-store.mjs', [
  'prepareOperation', 'applyOperation',
]);
const pure = () => load('../src/hook-maintenance.mjs', ['parseHookConfig']);
const definitions = async () => {
  const { createPreview } = await load('../scripts/preview-multi-chat-hooks.mjs', ['createPreview']);
  return createPreview().hooks;
};

async function ordinaryDirectory(directory) {
  const info = await fs.lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), '测试目录必须是普通目录');
  assert.equal(await fs.realpath(directory), directory);
}

async function fixture(t, initial) {
  const actualRoot = await fs.realpath(root);
  assert.equal(actualRoot, root, '项目根目录必须已规范化');
  await fs.mkdir(cache, { recursive: true });
  await ordinaryDirectory(cache);
  const directory = path.join(cache, `hook-maintenance-test-${randomUUID()}`);
  await fs.mkdir(directory);
  await ordinaryDirectory(directory);
  const target = path.join(directory, 'hooks.json');
  const ownedRecords = new Set();
  t.after(async () => {
    for (const record of ownedRecords) {
      assert.equal(path.dirname(record), records);
      assert.match(path.basename(record), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      await ordinaryDirectory(records);
      await ordinaryDirectory(record);
      await fs.rm(record, { recursive: true });
    }
    assert.equal(path.dirname(directory), cache);
    assert.match(path.basename(directory), /^hook-maintenance-test-[0-9a-f-]{36}$/);
    await ordinaryDirectory(cache);
    await ordinaryDirectory(directory);
    await fs.rm(directory, { recursive: true });
  });
  if (initial !== undefined) await fs.writeFile(target, initial, { flag: 'wx' });
  return {
    directory,
    target,
    async prepare(operation, receiptPath) {
      const api = await store();
      const packet = await api.prepareOperation({ operation, target, receiptPath });
      assert.equal(path.basename(packet.planPath), 'plan.json');
      assert.equal(path.dirname(path.dirname(packet.planPath)), records);
      ownedRecords.add(path.dirname(packet.planPath));
      assert.equal(path.dirname(packet.receiptPath), path.dirname(packet.planPath));
      assert.equal(packet.planSha256, hash(await fs.readFile(packet.planPath)));
      assert.ok(!JSON.stringify(packet).includes(sentinel));
      assert.ok(!(await fs.readFile(packet.planPath, 'utf8')).includes(sentinel));
      return packet;
    },
  };
}

async function apply(packet, options) {
  const api = await store();
  return api.applyOperation({
    planPath: packet.planPath,
    expectedPlanSha256: packet.planSha256,
  }, options);
}

async function readConfig(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

async function assertTarget(target, expected) {
  assert.deepEqual(await fs.readFile(target), Buffer.from(expected));
}

async function editPlan(packet, edit) {
  const document = JSON.parse(await fs.readFile(packet.planPath, 'utf8'));
  edit(document);
  const bytes = json(document);
  await fs.writeFile(packet.planPath, bytes);
  return { ...packet, planSha256: hash(bytes) };
}

function replaceString(value, before, after) {
  let count = 0;
  for (const key of Object.keys(value)) {
    if (value[key] === before) {
      value[key] = after;
      count++;
    } else if (value[key] && typeof value[key] === 'object') {
      count += replaceString(value[key], before, after);
    }
  }
  return count;
}

test('reject invalid operations and explicit target violations without target artifacts', async (t) => {
  const f = await fixture(t, '{}\n');
  const api = await store();
  const before = await fs.readdir(f.directory);
  for (const operation of ['', 'INSTALL', 'delete', 'repair']) {
    await assert.rejects(() => api.prepareOperation({ operation, target: f.target }));
  }
  for (const target of [
    undefined, path.relative(root, f.target),
    path.join(f.directory, 'config.json'),
    path.join(f.directory, 'missing', 'hooks.json'),
  ]) {
    await assert.rejects(() => api.prepareOperation({ operation: 'install', target }));
  }
  await assertTarget(f.target, '{}\n');
  assert.deepEqual(await fs.readdir(f.directory), before);
});

test('parser rejects malformed, duplicate, oversized and excessively nested JSON first', async () => {
  const { parseHookConfig } = await pure();
  const invalid = [
    '', '{', 'null', '[]', 'true', '{"hooks":[]}',
    '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[null]}}',
    '{"hooks":{"Stop":[{"hooks":{}}]}}',
    '{"hooks":{"Stop":[{"hooks":[null]}]}}',
    '{"hooks":{"Stop":[{"hooks":[{"type":3}]}]}}',
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":4}]}]}}',
    '{"hooks":{},"h\\u006foks":{}}',
    '{"metadata":{"x":1,"\\u0078":2}}',
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"a","comm\\u0061nd":"b"}]}]}}',
    `{"nested":${'['.repeat(1024)}0${']'.repeat(1024)}}`,
    `{"padding":"${'x'.repeat(1024 * 1024)}"}`,
  ];
  for (const input of invalid) {
    assert.throws(() => parseHookConfig(Buffer.from(input)), undefined, input.slice(0, 70));
  }
  assert.throws(() => parseHookConfig(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])));
  const safe = '{"__proto__":{"polluted":true},"metadata":{"unicode":"中文"},"hooks":{}}';
  assert.deepEqual(parseHookConfig(Buffer.from(safe)), JSON.parse(safe));
  assert.equal({}.polluted, undefined);
});

test('parser preserves exact decimal values and rejects lossy numeric tokens', async () => {
  const { parseHookConfig } = await pure();
  for (const token of [
    '9007199254740993', '0.123456789012345678901', '1e-400', '1e400', '-0',
  ]) {
    assert.throws(() => parseHookConfig(Buffer.from(`{"metadata":{"value":${token}}}`)), {
      code: 'invalid_config',
      message: 'Hook 配置或所有权记录不符合要求',
    });
  }
  for (const token of ['1.0', '1e3', '0.1', '9007199254740992']) {
    const config = parseHookConfig(Buffer.from(`{"metadata":{"value":${token}}}`));
    assert.equal(config.metadata.value, JSON.parse(token));
  }
});

test('unreceipted current, partial and recognizable old emitter bindings are ambiguous', async (t) => {
  await store();
  const current = await definitions();
  const old = structuredClone(current);
  old.Stop[0].hooks[0].command += ' --old-binding';
  const configurations = [
    { hooks: current },
    { hooks: { Stop: current.Stop } },
    { hooks: { Stop: old.Stop } },
  ];
  for (const config of configurations) {
    const original = json(config);
    const f = await fixture(t, original);
    await assert.rejects(() => f.prepare('install'));
    await assertTarget(f.target, original);
    assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  }
});

test('adoption rejects incomplete, modified and duplicated definitions', async (t) => {
  await store();
  const current = await definitions();
  const partial = structuredClone(current);
  delete partial.Stop;
  const modified = structuredClone(current);
  modified.Stop[0].matcher = 'unreviewed-context';
  const duplicate = structuredClone(current);
  duplicate.Stop.push(structuredClone(duplicate.Stop[0]));
  for (const hooks of [partial, modified, duplicate]) {
    const original = json({ hooks });
    const f = await fixture(t, original);
    await assert.rejects(() => f.prepare('adopt'));
    await assertTarget(f.target, original);
  }
});

test('edited handlers, edited contexts and duplicate owned entries conflict', windowsOnly, async (t) => {
  for (const mutate of [
    (config) => { config.hooks.Stop[0].hooks[0].timeout = 99; },
    (config) => { config.hooks.Stop[0].matcher = 'changed'; },
    (config) => { config.hooks.Stop.push(structuredClone(config.hooks.Stop[0])); },
  ]) {
    const f = await fixture(t, '{}');
    const installed = await f.prepare('install');
    await apply(installed);
    const changed = await readConfig(f.target);
    mutate(changed);
    const bytes = json(changed);
    await fs.writeFile(f.target, bytes);
    for (const operation of ['install', 'update', 'uninstall']) {
      await assert.rejects(() => f.prepare(operation, installed.receiptPath));
      await assertTarget(f.target, bytes);
    }
  }
});

test('plan digest, recomputed paths, source identity and source receipt are verified', windowsOnly, async (t) => {
  const f = await fixture(t, '{}');
  const packet = await f.prepare('install');
  await assert.rejects(() => apply({ ...packet, planSha256: '0'.repeat(64) }));
  const changedPath = await editPlan(packet, (plan) => {
    plan.target = path.join(f.directory, 'unreviewed-hooks.json');
  });
  await assert.rejects(() => apply(changedPath));
  await assertTarget(f.target, '{}');

  const sourcePlan = await f.prepare('install');
  const changedSource = await editPlan(sourcePlan, (plan) => {
    assert.ok(replaceString(plan, process.execPath, `${process.execPath}.tampered`) > 0,
      '计划必须记录绝对 Node 来源身份；测试只修改计划，不修改项目源码');
  });
  await assert.rejects(() => apply(changedSource));
  await assertTarget(f.target, '{}');

  const installed = await f.prepare('install');
  await apply(installed);
  const removal = await f.prepare('uninstall', installed.receiptPath);
  const before = await fs.readFile(f.target);
  await fs.appendFile(installed.receiptPath, '\n');
  await assert.rejects(() => apply(removal));
  await assertTarget(f.target, before);
});

test('baseline drift and pre-existing cooperative lock prevent publication', windowsOnly, async (t) => {
  const f = await fixture(t, '{}');
  const packet = await f.prepare('install');
  const drift = json({ metadata: sentinel });
  await fs.writeFile(f.target, drift);
  await assert.rejects(() => apply(packet));
  await assertTarget(f.target, drift);
  const next = await f.prepare('install');
  const lock = path.join(f.directory, '.atc-hooks.lock');
  await fs.writeFile(lock, 'owned by another operation', { flag: 'wx' });
  await assert.rejects(() => apply(next));
  assert.equal(await fs.readFile(lock, 'utf8'), 'owned by another operation');
  await assertTarget(f.target, drift);
});

test('hardlinks, symlinks and nonregular targets are rejected', async (t) => {
  const f = await fixture(t, '{}');
  const alias = path.join(f.directory, 'alias.json');
  await fs.link(f.target, alias);
  await assert.rejects(() => f.prepare('install'));
  await fs.unlink(alias);
  const other = path.join(f.directory, 'ordinary.json');
  await fs.writeFile(other, '{}');
  await fs.unlink(f.target);
  try {
    await fs.symlink(other, f.target, 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('本机未授予文件符号链接权限；目录 junction 拒绝仍会验证');
  }
  if (await fs.lstat(f.target).catch(() => null)) {
    await assert.rejects(() => f.prepare('install'));
    await fs.unlink(f.target);
  }
  const linkedParent = path.join(f.directory, 'linked-parent');
  await fs.symlink(f.directory, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  const api = await store();
  await assert.rejects(() => api.prepareOperation({
    operation: 'install', target: path.join(linkedParent, 'hooks.json'),
  }));
  await fs.unlink(linkedParent);
  await fs.mkdir(f.target);
  await assert.rejects(() => f.prepare('install'));
});

test('backup failure, denied temp write and rename failure preserve original bytes', windowsOnly, async (t) => {
  for (const failure of ['backup', 'temp', 'rename']) {
    const original = json({ metadata: sentinel });
    const f = await fixture(t, original);
    const packet = await f.prepare('install');
    const record = path.dirname(packet.planPath);
    let injected = false;
    const deny = () => {
      injected = true;
      throw Object.assign(new Error('FOREIGN_INTERNAL_ERROR'), { code: 'EACCES' });
    };
    const isWrite = (flags) => typeof flags === 'number' || /[wax+]/.test(flags ?? '');
    const shouldDeny = (file) => {
      const name = String(file);
      return failure === 'backup'
        ? path.dirname(name) === record
        : failure === 'temp' && path.dirname(name) === f.directory
          && name !== f.target && path.basename(name) !== '.atc-hooks.lock';
    };
    const injectedFs = {
      ...fs,
      async open(file, flags, ...rest) {
        if (isWrite(flags) && shouldDeny(file)) deny();
        return fs.open(file, flags, ...rest);
      },
      async writeFile(file, ...rest) {
        if (shouldDeny(file)) deny();
        return fs.writeFile(file, ...rest);
      },
      async rename(from, to) {
        if (failure === 'rename' && String(to) === f.target) deny();
        return fs.rename(from, to);
      },
    };
    await assert.rejects(() => apply(packet, { fs: injectedFs }));
    assert.ok(injected, `必须实际触发 ${failure} 故障`);
    await assertTarget(f.target, original);
    assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
  }
});

test('interrupted finalization reports recovery and prepared receipt rolls back exact published bytes', windowsOnly, async (t) => {
  const original = `{\r\n  "metadata": "${sentinel}"\r\n}\r\n`;
  const f = await fixture(t, original);
  const packet = await f.prepare('install');
  const record = path.dirname(packet.planPath);
  let published = false;
  let injected = false;
  const denyFinalization = (file) => {
    if (published && path.dirname(String(file)) === record) {
      injected = true;
      throw Object.assign(new Error('injected receipt failure'), { code: 'EIO' });
    }
  };
  const injectedFs = {
    ...fs,
    async rename(from, to) {
      denyFinalization(to);
      await fs.rename(from, to);
      if (String(to) === f.target) published = true;
    },
    async writeFile(file, ...args) {
      denyFinalization(file);
      return fs.writeFile(file, ...args);
    },
    async open(file, flags, ...args) {
      if (typeof flags === 'number' || /[wax+]/.test(flags ?? '')) denyFinalization(file);
      return fs.open(file, flags, ...args);
    },
  };
  await assert.rejects(() => apply(packet, { fs: injectedFs }), (error) => {
    assert.match(`${error.code ?? ''} ${error.message}`, /recovery_required/);
    return true;
  });
  assert.ok(published && injected);
  const receipt = JSON.parse(await fs.readFile(packet.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'prepared');
  const publishedBytes = await fs.readFile(f.target);
  assert.notEqual(hash(publishedBytes), hash(original));

  await fs.writeFile(f.target, json({ metadata: 'drift after interruption' }));
  await assert.rejects(() => f.prepare('rollback', packet.receiptPath));
  await fs.writeFile(f.target, publishedBytes);
  const rollback = await f.prepare('rollback', packet.receiptPath);
  assert.equal((await apply(rollback)).status, 'applied');
  await assertTarget(f.target, original);
});

test('empty and absent installs add exactly the eight fixed definitions; preview is read-only', windowsOnly, async (t) => {
  for (const initial of [undefined, '{}\n', '{"hooks":{}}\n']) {
    const f = await fixture(t, initial);
    const before = await fs.readdir(f.directory);
    const packet = await f.prepare('install');
    assert.deepEqual(await fs.readdir(f.directory), before);
    if (initial === undefined) {
      await assert.rejects(() => fs.stat(f.target), { code: 'ENOENT' });
    } else {
      await assertTarget(f.target, initial);
    }
    const result = await apply(packet);
    assert.equal(result.status, 'applied');
    assert.equal(result.receiptPath, packet.receiptPath);
    assert.equal(result.afterHash, hash(await fs.readFile(f.target)));
    const config = await readConfig(f.target);
    assert.deepEqual(Object.keys(config.hooks).sort(), [...events].sort());
    assert.deepEqual(config.hooks, await definitions());
    assert.equal(JSON.parse(await fs.readFile(packet.receiptPath, 'utf8')).status, 'applied');
  }
});

test('mixed install/uninstall preserves metadata, order, foreign handlers and pre-existing empty groups', windowsOnly, async (t) => {
  const original = {
    metadata: { text: sentinel, nested: ['中文', { enabled: true }] },
    hooks: {
      Stop: [
        { matcher: 'foreign-context', hooks: [foreign(), { type: 'future-handler', value: 7 }] },
        { matcher: 'empty-context', hooks: [] },
      ],
      ForeignEvent: [{ hooks: [foreign()] }],
    },
  };
  const f = await fixture(t, json(original));
  const packet = await f.prepare('install');
  await apply(packet);
  const installed = await readConfig(f.target);
  assert.deepEqual(installed.metadata, original.metadata);
  assert.deepEqual(installed.hooks.Stop.slice(0, 2), original.hooks.Stop);
  assert.deepEqual(installed.hooks.ForeignEvent, original.hooks.ForeignEvent);
  assert.deepEqual(installed.hooks.Stop[2], (await definitions()).Stop[0]);
  installed.hooks.Stop[2].hooks.push(foreign());
  await fs.writeFile(f.target, json(installed));
  const removal = await f.prepare('uninstall', packet.receiptPath);
  await apply(removal);
  const expected = structuredClone(original);
  expected.hooks.Stop.push({ hooks: [foreign()] });
  assert.deepEqual(await readConfig(f.target), expected);
  assert.ok(!(await fs.readFile(removal.receiptPath, 'utf8')).includes(sentinel));
});

test('26 latest-receipt no-ops retain history, reject missing ancestors and allow uninstall', {
  ...windowsOnly,
  timeout: 600_000,
}, async (t) => {
  const f = await fixture(t, '{}');
  const installed = await f.prepare('install');
  await apply(installed);
  const bytes = await fs.readFile(f.target);
  const before = await fs.stat(f.target);
  let latest = installed;
  for (let index = 0; index < 26; index++) {
    const operation = index % 2 === 0 ? 'install' : 'update';
    const packet = await f.prepare(operation, latest.receiptPath);
    assert.equal(packet.noOp, true);
    assert.equal(packet.sourceReceipt.path, latest.receiptPath);
    const failWrite = async () => assert.fail('no-op 不得创建锁、临时文件或备份');
    const isTargetSide = (file) => {
      const resolved = path.resolve(String(file));
      return resolved === f.directory
        || resolved.startsWith(`${f.directory}${path.sep}`);
    };
    const isWrite = (flags) => typeof flags === 'number'
      ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
        | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
      : /[wax+]/.test(flags ?? '');
    const injectedFs = {
      ...fs,
      async open(file, flags, ...rest) {
        if (isWrite(flags) && isTargetSide(file)) return failWrite();
        return fs.open(file, flags, ...rest);
      },
      async writeFile(file, ...rest) {
        if (isTargetSide(file)) return failWrite();
        return fs.writeFile(file, ...rest);
      },
      async rename(from, to) {
        if (isTargetSide(from) || isTargetSide(to)) return failWrite();
        return fs.rename(from, to);
      },
      async link(from, to) {
        if (isTargetSide(from) || isTargetSide(to)) return failWrite();
        return fs.link(from, to);
      },
      async unlink(file) {
        if (isTargetSide(file)) return failWrite();
        return fs.unlink(file);
      },
    };
    assert.equal((await apply(packet, { fs: injectedFs })).status, 'noop');
    await assertTarget(f.target, bytes);
    assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
    assert.deepEqual(
      (await fs.readdir(path.dirname(packet.planPath))).sort(),
      ['plan.json', 'receipt.json'],
    );
    latest = packet;
  }
  const after = await fs.stat(f.target);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);

  const pending = await f.prepare('update', latest.receiptPath);
  const missing = `${installed.receiptPath}.fixture-missing`;
  await fs.rename(installed.receiptPath, missing);
  try {
    await assert.rejects(() => f.prepare('update', latest.receiptPath));
    await assert.rejects(() => apply(pending));
    await assertTarget(f.target, bytes);
    assert.deepEqual(await fs.readdir(f.directory), ['hooks.json']);
    assert.deepEqual(await fs.readdir(path.dirname(pending.planPath)), ['plan.json']);
  } finally {
    await fs.rename(missing, installed.receiptPath);
  }
  const removal = await f.prepare('uninstall', latest.receiptPath);
  assert.equal((await apply(removal)).status, 'applied');
  assert.deepEqual(await readConfig(f.target), {});
});

test('explicit adoption preserves bytes and treats all adopted groups as pre-existing', windowsOnly, async (t) => {
  const hooks = await definitions();
  hooks.Stop.unshift({ matcher: 'foreign', hooks: [foreign()] });
  const original = json({ metadata: sentinel, hooks });
  const f = await fixture(t, original);
  const adopted = await f.prepare('adopt');
  await assertTarget(f.target, original);
  const result = await apply(adopted);
  assert.ok(['applied', 'noop'].includes(result.status));
  await assertTarget(f.target, original);
  assert.equal(JSON.parse(await fs.readFile(adopted.receiptPath, 'utf8')).status, 'applied');
  const removal = await f.prepare('uninstall', adopted.receiptPath);
  await apply(removal);
  const expected = Object.fromEntries(events.map((event) => [event, [{ hooks: [] }]]));
  expected.Stop.unshift({ matcher: 'foreign', hooks: [foreign()] });
  assert.deepEqual(await readConfig(f.target), { metadata: sentinel, hooks: expected });
});

test('rollback restores exact original bytes or deletes an originally absent unchanged target', windowsOnly, async (t) => {
  for (const original of [undefined, `{\r\n "metadata": "${sentinel}"\r\n}\r\n`]) {
    const f = await fixture(t, original);
    const installed = await f.prepare('install');
    await apply(installed);
    const rollback = await f.prepare('rollback', installed.receiptPath);
    await apply(rollback);
    if (original === undefined) {
      await assert.rejects(() => fs.stat(f.target), { code: 'ENOENT' });
    } else {
      await assertTarget(f.target, original);
    }
    assert.ok(await fs.stat(installed.receiptPath));
  }
});

test('install rollback with later foreign edits safely inverts only unchanged owned entries', windowsOnly, async (t) => {
  const f = await fixture(t);
  const installed = await f.prepare('install');
  await apply(installed);
  const changed = await readConfig(f.target);
  changed.metadata = sentinel;
  changed.hooks.Stop[0].hooks.unshift(foreign());
  changed.hooks.ForeignEvent = [{ matcher: 'later', hooks: [foreign()] }];
  await fs.writeFile(f.target, json(changed));
  const rollback = await f.prepare('rollback', installed.receiptPath);
  await apply(rollback);
  assert.deepEqual(await readConfig(f.target), {
    metadata: sentinel,
    hooks: {
      Stop: [{ hooks: [foreign()] }],
      ForeignEvent: [{ matcher: 'later', hooks: [foreign()] }],
    },
  });
});

test('uninstall keeps the file; exact rollback restores it and ambiguous drift conflicts', windowsOnly, async (t) => {
  const f = await fixture(t, '{}');
  const installed = await f.prepare('install');
  await apply(installed);
  const bytes = await fs.readFile(f.target);
  const removed = await f.prepare('uninstall', installed.receiptPath);
  await apply(removed);
  assert.ok((await fs.stat(f.target)).isFile());
  const drift = json({ hooks: { Stop: [{ hooks: [foreign()] }] } });
  await fs.writeFile(f.target, drift);
  await assert.rejects(() => f.prepare('rollback', removed.receiptPath), (error) => {
    assert.match(`${error.code ?? ''} ${error.message}`, /rollback_conflict/);
    return true;
  });
  await assertTarget(f.target, drift);
  const removedConfig = '{}';
  // Use the actual recorded after state, without assuming its whitespace or root shape.
  const second = await fixture(t, removedConfig);
  const secondInstall = await second.prepare('install');
  await apply(secondInstall);
  const secondBytes = await fs.readFile(second.target);
  const secondRemoval = await second.prepare('uninstall', secondInstall.receiptPath);
  await apply(secondRemoval);
  await apply(await second.prepare('rollback', secondRemoval.receiptPath));
  await assertTarget(second.target, secondBytes);
  assert.ok(bytes.length > 0);
});

test('stored backups protect foreign bytes and support real exact-byte recovery', windowsOnly, async (t) => {
  const original = json({ metadata: sentinel });
  const f = await fixture(t, original);
  const packet = await f.prepare('install');
  await apply(packet);
  const record = path.dirname(packet.planPath);
  const files = await fs.readdir(record, { withFileTypes: true });
  const backupFiles = files.filter((entry) => entry.isFile()
    && ![path.basename(packet.planPath), path.basename(packet.receiptPath)].includes(entry.name));
  assert.ok(backupFiles.length > 0, '替换前必须保留备份');
  if (process.platform === 'win32') {
    for (const entry of files.filter((entry) => entry.isFile())) {
      const bytes = await fs.readFile(path.join(record, entry.name));
      assert.ok(!bytes.includes(Buffer.from(sentinel)), 'Windows 普通缓存中不得保存明文外部配置');
    }
  } else {
    assert.equal((await fs.stat(record)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(record)).uid, process.getuid());
    for (const entry of backupFiles) {
      const info = await fs.stat(path.join(record, entry.name));
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.uid, process.getuid());
    }
  }
  await apply(await f.prepare('rollback', packet.receiptPath));
  await assertTarget(f.target, original);
});

test('stored update rollback restores old checkout bindings and remains usable for uninstall', windowsOnly, async (t) => {
  const f = await fixture(t, '{}');
  const oldRoot = path.join(f.directory, 'old-checkout');
  await fs.mkdir(oldRoot);
  await ordinaryDirectory(oldRoot);
  const sources = [
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
  for (const name of sources) {
    const destination = path.join(oldRoot, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, name), destination);
  }
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [
      path.join(oldRoot, 'scripts', 'manage-hooks.mjs'), ...args,
    ], {
      cwd: oldRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      shell: false,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
    cli('preview', 'install', '--target', f.target);
  const oldRecords = path.join(oldRoot, '.cache', 'hook-maintenance');
  const entries = await fs.readdir(oldRecords);
  assert.equal(entries.length, 1);
  const oldRecord = path.join(oldRecords, entries[0]);
  await ordinaryDirectory(oldRecord);
  const oldPlan = path.join(oldRecord, 'plan.json');
    cli('apply', '--plan', oldPlan, '--plan-sha256', hash(await fs.readFile(oldPlan)));
  const oldReceipt = path.join(oldRecord, 'receipt.json');
  assert.equal(JSON.parse(await fs.readFile(oldReceipt, 'utf8')).status, 'applied');
  const oldConfig = await readConfig(f.target);
  for (const event of events) {
    assert.ok(oldConfig.hooks[event][0].hooks[0].command.includes(oldRoot));
  }

  const update = await f.prepare('update', oldReceipt);
  assert.equal(update.noOp, false);
  await apply(update);
  assert.deepEqual((await readConfig(f.target)).hooks, await definitions());
  const changed = await readConfig(f.target);
  changed.metadata = { later: sentinel };
  changed.hooks.Stop[0].hooks.push(foreign());
  await fs.writeFile(f.target, json(changed));

  const rollback = await f.prepare('rollback', update.receiptPath);
  await apply(rollback);
  const restored = structuredClone(oldConfig);
  restored.metadata = changed.metadata;
  restored.hooks.Stop[0].hooks.push(foreign());
  assert.deepEqual(await readConfig(f.target), restored);
  const removal = await f.prepare('uninstall', rollback.receiptPath);
  await apply(removal);
  assert.deepEqual(await readConfig(f.target), {
    metadata: changed.metadata,
    hooks: { Stop: [{ hooks: [foreign()] }] },
  });
});

test('pure ownership updates rebind in place and retain provenance across updates', async () => {
  // This pure signature is the test-selected public contract permitted by the spec.
  const { reconcileHookConfig } = await load('../src/hook-maintenance.mjs', ['reconcileHookConfig']);
  const current = await definitions();
  const old = structuredClone(current);
  for (const groups of Object.values(old)) {
    groups[0].hooks[0].command += ' --old-fixture';
    groups[0].hooks[0].commandWindows += ' --old-fixture';
  }
  const original = {
    metadata: sentinel,
    hooks: { Stop: [{ matcher: 'existing-empty', hooks: [] }] },
  };
  const installed = reconcileHookConfig({
    operation: 'install', config: original, definitions: old,
  });
  assert.deepEqual(original.hooks.Stop, [{ matcher: 'existing-empty', hooks: [] }]);
  const changed = structuredClone(installed.config);
  changed.hooks.Stop[1].hooks.unshift(foreign());
  assert.throws(() => reconcileHookConfig({
    operation: 'install', config: changed, definitions: current, receipt: installed.receipt,
  }));
  const updated = reconcileHookConfig({
    operation: 'update', config: changed, definitions: current, receipt: installed.receipt,
  });
  assert.deepEqual(updated.config.hooks.Stop, [
    original.hooks.Stop[0],
    { hooks: [foreign(), current.Stop[0].hooks[0]] },
  ]);
  const removed = reconcileHookConfig({
    operation: 'uninstall', config: updated.config, definitions: current, receipt: updated.receipt,
  });
  assert.deepEqual(removed.config, {
    metadata: sentinel,
    hooks: { Stop: [original.hooks.Stop[0], { hooks: [foreign()] }] },
  });
});
