import path from 'node:path';

const operations = ['install', 'update', 'uninstall', 'rollback', 'adopt'];

function invalid() {
  throw Object.assign(new Error('参数无效'), { code: 'invalid_arguments' });
}

function flags(args, allowed, required) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.includes(key) || Object.hasOwn(result, key)
      || !value || value.startsWith('--')) invalid();
    result[key] = value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    return {
      usage: [
        'node scripts/manage-hooks.mjs preview install|update|uninstall|rollback|adopt --target ABSOLUTE/hooks.json [--receipt ABSOLUTE/receipt.json]',
        'node scripts/manage-hooks.mjs apply --plan ABSOLUTE/plan.json --plan-sha256 HEX64',
      ],
      notice: [
        '预览只在项目缓存中生成计划；应用会执行计划中的写入。',
        '全局使用前须取得操作者明确审批；摘要只校验完整性，不能证明用户同意。',
        '协作锁只约束遵守该锁的写入者，不提供操作系统级比较交换保证。',
        '必须显式提供绝对路径，不读取环境中的默认目标。',
      ],
    };
  }
  let request;
  if (args[0] === 'preview' && operations.includes(args[1])) {
    const parsed = flags(args.slice(2), ['--target', '--receipt'], ['--target']);
    if (!path.isAbsolute(parsed['--target'])
      || path.basename(parsed['--target']) !== 'hooks.json'
      || (parsed['--receipt'] && !path.isAbsolute(parsed['--receipt']))) invalid();
    request = {
      operation: args[1],
      target: parsed['--target'],
      ...(parsed['--receipt'] ? { receiptPath: parsed['--receipt'] } : {}),
    };
  } else if (args[0] === 'apply') {
    const parsed = flags(
      args.slice(1), ['--plan', '--plan-sha256'], ['--plan', '--plan-sha256'],
    );
    if (!path.isAbsolute(parsed['--plan'])
      || !/^[a-fA-F0-9]{64}$/.test(parsed['--plan-sha256'])) invalid();
    request = {
      planPath: parsed['--plan'],
      expectedPlanSha256: parsed['--plan-sha256'],
    };
  } else {
    invalid();
  }
  const { prepareOperation, applyOperation } = await import('../src/hook-maintenance-store.mjs');
  return args[0] === 'preview' ? prepareOperation(request) : applyOperation(request);
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  const messages = {
    invalid_arguments: '参数无效，请使用 --help 查看用法。',
    unsupported_platform: '当前仅支持在 Windows 上应用 Hook 维护计划。',
    recovery_required: '目标可能已经改变，请保留记录并预览恢复操作。',
    rollback_conflict: '恢复存在冲突，已停止操作，请检查目标及记录。',
  };
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'operation_failed';
  process.stderr.write(`${JSON.stringify({
    code,
    message: messages[code] ?? '操作失败，请检查配置、计划、记录及权限。',
  })}\n`);
  process.exitCode = 1;
});
