import path from 'node:path';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
];

export function createPreview() {
  const entry = path.join(root, 'src', 'multi-chat-hook.mjs');
  const command = `"${process.execPath}" "${entry}"`;
  const quotePowerShell = (value) => `'${value.replace(/'/g, "''")}'`;
  const commandWindows = `& ${quotePowerShell(process.execPath)} ${quotePowerShell(entry)}`;
  return {
    description: 'Multi-chat hooks preview for review; not installed automatically.',
    hooks: Object.fromEntries(events.map((event) => [event, [{
      hooks: [{ type: 'command', command, commandWindows, timeout: 2, async: false }],
    }]])),
  };
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--write-preview')) {
    throw new Error('Unsupported option');
  }
  const content = `${JSON.stringify(createPreview(), null, 2)}\n`;
  if (process.argv.includes('--write-preview')) {
    const directory = path.join(root, '.cache');
    await mkdir(directory, { recursive: true });
    const actualRoot = await realpath(root);
    const actualDirectory = await realpath(directory);
    const relative = path.relative(actualRoot, actualDirectory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Invalid cache directory');
    }
    const target = path.join(actualDirectory, 'multi-chat-hooks.preview.json');
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Invalid preview file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(actualDirectory, `.multi-chat-hooks-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  process.stdout.write(content);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('Unable to create hook preview.\n');
    process.exitCode = 1;
  });
}
