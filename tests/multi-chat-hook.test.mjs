import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHook } from '../src/multi-chat-hook.mjs';
import { createPreview } from '../scripts/preview-multi-chat-hooks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache');
const execFileAsync = promisify(execFile);

async function fixture(t, projectBasename = 'project') {
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'preview-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(cache));
    assert.ok(path.basename(directory).startsWith('preview-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const project = path.join(directory, projectBasename);
  const outside = path.join(directory, 'outside');
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await mkdir(outside);
  const script = path.join(project, 'scripts', 'preview-multi-chat-hooks.mjs');
  await copyFile(path.join(root, 'scripts', 'preview-multi-chat-hooks.mjs'), script);
  return { project, outside, script };
}

function runPreview(script) {
  return execFileAsync(process.execPath, [script, '--write-preview'], {
    timeout: 2500, windowsHide: true,
  });
}

function windowsCommand(node, script) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  return `& ${quote(node)} ${quote(script)}`;
}

function runPowerShell(command) {
  assert.ok(process.env.SystemRoot, 'SystemRoot is required to locate Windows PowerShell');
  const powershell = path.join(
    process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell, ['-NoProfile', '-Command', command],
      { timeout: 2500, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end('{}');
  });
}

function outputCapture() {
  let text = '';
  return {
    output: new Writable({ write(chunk, encoding, callback) { text += chunk; callback(); } }),
    get text() { return text; },
  };
}

test('hook forwards only allowed metadata and always returns empty object', async () => {
  const input = new PassThrough();
  const capture = outputCapture();
  let sent;
  const task = runHook({ input, output: capture.output, request: async (message) => { sent = message; } });
  input.end(JSON.stringify({
    session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    turn_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    cwd: 'C:\\private\\project', hook_event_name: 'UserPromptSubmit',
    prompt: 'PRIVATE', tool_response: 'PRIVATE',
  }));
  await task;
  assert.equal(capture.text, '{}\n');
  assert.equal(sent.event.project, 'project');
  assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(sent).includes('private'), false);
});

test('malformed, oversized, and unavailable manager never change hook result', async () => {
  for (const value of ['{', 'x'.repeat(1024 * 1024 + 1)]) {
    const input = new PassThrough();
    const capture = outputCapture();
    let calls = 0;
    const task = runHook({ input, output: capture.output, request: async () => { calls++; } });
    input.end(value);
    await task;
    assert.equal(capture.text, '{}\n');
    assert.equal(calls, 0);
  }
  const input = new PassThrough();
  const capture = outputCapture();
  const task = runHook({ input, output: capture.output, request: async () => { throw new Error('absent'); } });
  input.end(JSON.stringify({
    session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: '/project',
    hook_event_name: 'SessionStart',
  }));
  await task;
  assert.equal(capture.text, '{}\n');
});

test('hook read deadline settles without EOF and emits one empty object', async () => {
  const input = new PassThrough();
  const capture = outputCapture();
  let calls = 0;
  let timer;
  try {
    const task = runHook({
      input, output: capture.output, timeoutMs: 30,
      request: async () => { calls++; },
    });
    input.write('PRIVATE');
    await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('hook deadline exceeded')), 1000);
      }),
    ]);
    assert.equal(capture.text, '{}\n');
    assert.equal(calls, 0);
  } finally {
    clearTimeout(timer);
    input.destroy();
    capture.output.destroy();
  }
});

test('hook read deadline keeps an isolated process alive until it settles', async () => {
  const hookUrl = pathToFileURL(path.join(root, 'src', 'multi-chat-hook.mjs')).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { runHook } from ${JSON.stringify(hookUrl)};
    const input = new PassThrough();
    await runHook({ input, timeoutMs: 30 });
  `;
  const { stdout, stderr } = await execFileAsync(
    process.execPath, ['--input-type=module', '--eval', script],
    { timeout: 2500, windowsHide: true },
  );
  assert.equal(stdout, '{}\n');
  assert.equal(stderr, '');
});

test('real hook exits with empty output while its stdin remains open', async (t) => {
  const child = spawn(process.execPath, [path.join(root, 'src', 'multi-chat-hook.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write('PRIVATE');
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error('child hook deadline exceeded'));
      }, 2500);
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stdout, '{}\n');
    assert.equal(stderr, '');
  } finally {
    clearTimeout(timer);
  }
});

test('preview lists only supported hooks with fixed synchronous commands', () => {
  const preview = createPreview();
  assert.match(preview.description, /^[\x20-\x7e]+$/);
  assert.match(preview.description, /preview/i);
  assert.match(preview.description, /review/i);
  assert.match(preview.description, /not.*install/i);
  assert.deepEqual(Object.keys(preview.hooks), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
  ]);
  for (const groups of Object.values(preview.hooks)) {
    const hook = groups[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.async, false);
    assert.equal(hook.timeout, 2);
    assert.equal(hook.command, `"${process.execPath}" "${path.join(root, 'src', 'multi-chat-hook.mjs')}"`);
    assert.equal(hook.commandWindows, windowsCommand(process.execPath, path.join(root, 'src', 'multi-chat-hook.mjs')));
    assert.doesNotMatch(hook.command, /dangerously-bypass-hook-trust/);
  }
});

test('generated command runs the real hook in Windows PowerShell with invalid input', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell 5.1' : false,
}, async () => {
  const hook = createPreview().hooks.SessionStart[0].hooks[0];
  const result = await runPowerShell(hook.commandWindows ?? hook.command);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
});

test('generated Windows commands preserve literal fixture paths in PowerShell', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell 5.1' : false,
}, async (t) => {
  const { project, script } = await fixture(t, "project space ' $value &");
  const entry = path.join(project, 'src', 'multi-chat-hook.mjs');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "process.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('{}\\n'));\n");
  const fixedNode = process.execPath;
  const { stdout, stderr } = await runPreview(script);
  assert.equal(stderr, '');
  const preview = JSON.parse(stdout);
  const firstHook = preview.hooks.SessionStart[0].hooks[0];
  const result = await runPowerShell(firstHook.commandWindows ?? firstHook.command);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const command = `"${fixedNode}" "${entry}"`;
  const commandWindows = windowsCommand(fixedNode, entry);
  for (const groups of Object.values(preview.hooks)) {
    const hook = groups[0].hooks[0];
    assert.equal(hook.command, command);
    assert.equal(hook.commandWindows, commandWindows);
  }
});

test('preview writes the same JSON only to the intended fixture cache', async (t) => {
  const { project, script } = await fixture(t);
  const { stdout, stderr } = await runPreview(script);
  assert.equal(stderr, '');
  const written = await readFile(path.join(project, '.cache', 'multi-chat-hooks.preview.json'), 'utf8');
  assert.equal(written, stdout);
  const preview = JSON.parse(stdout);
  const command = `"${process.execPath}" "${path.join(project, 'src', 'multi-chat-hook.mjs')}"`;
  for (const groups of Object.values(preview.hooks)) {
    assert.equal(groups[0].hooks[0].command, command);
    assert.equal(groups[0].hooks[0].commandWindows, windowsCommand(process.execPath, path.join(project, 'src', 'multi-chat-hook.mjs')));
  }
});

test('preview rejects a cache directory link outside its project', async (t) => {
  const { project, outside, script } = await fixture(t);
  const target = path.join(outside, 'multi-chat-hooks.preview.json');
  await writeFile(target, 'preserve');
  await symlink(outside, path.join(project, '.cache'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runPreview(script), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Unable to create hook preview.\n');
    assert.notEqual(error.code, 0);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), 'preserve');
});

test('preview rejects an existing output file link when supported', async (t) => {
  const { project, outside, script } = await fixture(t);
  const directory = path.join(project, '.cache');
  const target = path.join(outside, 'multi-chat-hooks.preview.json');
  await mkdir(directory);
  await writeFile(target, 'preserve');
  try {
    await symlink(target, path.join(directory, 'multi-chat-hooks.preview.json'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.diagnostic(`File symlink unavailable on Windows (${error.code}); rejection case not exercised.`);
      return;
    }
    throw error;
  }
  await assert.rejects(runPreview(script), (error) => {
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Unable to create hook preview.\n');
    assert.notEqual(error.code, 0);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), 'preserve');
});
