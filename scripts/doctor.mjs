import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requestManager } from '../src/multi-chat-manager.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkSpecifier = '@modelcontextprotocol/sdk-v1/client/index.js';
const assemblies = [
  'System.Windows.Forms.dll',
  'System.Drawing.dll',
  'System.Web.Extensions.dll',
];

function check(id, status, detail, nextStep) {
  return { id, status, detail, nextStep };
}

function checkNode(version) {
  const nextStep = 'Use Node.js 22 or newer; verify other prerequisites separately.';
  if (version === undefined || version === '') {
    return check('node', 'not_ready', 'Node.js version is missing.', nextStep);
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return check('node', 'unknown', 'Node.js version could not be classified.', nextStep);
  }
  const supported = Number(version.split('.')[0]) >= 22;
  return check('node', supported ? 'ready' : 'not_ready',
    supported ? 'Node.js meets the minimum version.' : 'Node.js is below version 22.',
    nextStep);
}

async function checkSdk(importSdk) {
  const nextStep = 'Run npm ls @modelcontextprotocol/sdk-v1 in the checkout; for missing locked dependencies, see docs/USAGE.md#install-and-check.';
  try {
    await importSdk(sdkSpecifier);
    return check('sdk', 'ready', 'The project SDK can be imported.', nextStep);
  } catch (error) {
    const missing = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code);
    return check('sdk', missing ? 'not_ready' : 'unknown',
      missing ? 'The project SDK dependency is missing.' : 'The SDK import could not be verified.',
      nextStep);
  }
}

async function fileStatus(target, accessFile) {
  try {
    return await accessFile(target) === false ? 'not_ready' : 'ready';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'not_ready' : 'unknown';
  }
}

async function filesStatus(targets, accessFile) {
  let result = 'ready';
  for (const target of targets) {
    const status = await fileStatus(target, accessFile);
    if (status === 'not_ready') return 'not_ready';
    if (status === 'unknown') result = 'unknown';
  }
  return result;
}

async function checkCompiler(platform, env, accessFile) {
  const nextStep = 'See docs/USAGE.md#read-only-diagnostics to manually verify the existing .NET 4 compiler and required assemblies.';
  if (platform !== 'win32') {
    return check('native_compiler', 'not_ready',
      'The Windows native UI is unavailable on this platform.', nextStep);
  }
  const systemRoot = env?.SystemRoot;
  if (typeof systemRoot !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\0:]/.test(systemRoot.slice(2))) {
    return check('native_compiler', 'unknown',
      'A valid local absolute Windows SystemRoot is required.', nextStep);
  }
  let denied = false;
  for (const framework of ['Framework64', 'Framework']) {
    const directory = path.win32.join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319');
    const compilerStatus = await fileStatus(path.win32.join(directory, 'csc.exe'), accessFile);
    if (compilerStatus !== 'ready') {
      if (compilerStatus === 'unknown') denied = true;
      continue;
    }
    const status = await filesStatus(
      assemblies.map((name) => path.win32.join(directory, name)), accessFile);
    const detail = status === 'ready'
      ? 'Compiler and required assembly regular files are present; permissions, compilation and GUI runtime are unverified.'
      : status === 'not_ready'
        ? 'The selected compiler is missing required assembly files.'
        : 'Required assembly regular file presence could not be verified.';
    return check('native_compiler', status, detail, nextStep);
  }
  return check('native_compiler', denied ? 'unknown' : 'not_ready',
    denied ? 'Compiler regular file presence could not be verified.' : 'The fixed compiler candidates are missing or are not regular files.',
    nextStep);
}

async function checkSources(accessFile) {
  const status = await filesStatus([
    path.join(root, 'src', 'MultiChatWindow.cs'),
    path.join(root, 'src', 'status-window', 'AgentStatusWindow.cs'),
  ], accessFile);
  const detail = status === 'ready'
    ? 'Both required project native source regular files are present; permissions and compilation are unverified.'
    : status === 'not_ready'
      ? 'Required project native source files are missing.'
      : 'Project native source regular file presence could not be verified.';
  return check('native_sources', status, detail,
    status === 'not_ready'
      ? 'Restore src/MultiChatWindow.cs and src/status-window/AgentStatusWindow.cs from a trusted checkout.'
      : 'See docs/USAGE.md#read-only-diagnostics to separately verify native source prerequisites and compilation.');
}

async function checkManager(options) {
  const nextStep = 'See docs/USAGE.md#choose-an-entrypoint; manually start the intended resident manager if desired, then rerun doctor.';
  const requestOptions = { timeoutMs: 500 };
  if (Object.hasOwn(options, 'endpoint')) requestOptions.endpoint = options.endpoint;
  try {
    const response = await (options.requestManager ?? requestManager)(
      { op: 'ping' }, requestOptions);
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      if (response.ok === true) {
        return check('manager', 'ready', 'The local manager is reachable by ping.', nextStep);
      }
      if (response.ok === false) {
        return check('manager', 'not_ready', 'The local manager rejected the reachability ping.', nextStep);
      }
    }
  } catch {
    // The IPC client owns its timeout and socket cleanup.
  }
  return check('manager', 'unknown', 'Local manager reachability could not be verified.', nextStep);
}

export async function runDoctor(options = {}) {
  const nodeVersion = Object.hasOwn(options, 'nodeVersion')
    ? options.nodeVersion : process.versions.node;
  const accessFile = options.access ?? (async (target) => (await stat(target)).isFile());
  const checks = [
    checkNode(nodeVersion),
    await checkSdk(options.importSdk ?? ((specifier) => import(specifier))),
    await checkCompiler(options.platform ?? process.platform, options.env ?? process.env, accessFile),
    await checkSources(accessFile),
    await checkManager(options),
    check('hook_trust', 'unknown', 'Hook trust has not been inspected.',
      'Use the target host official supported review mechanism to verify hook trust.'),
    check('event_source', 'unknown', 'Actual target host event delivery has not been verified.',
      'Verify actual lifecycle events from the intended target host; ping does not establish event delivery.'),
  ];
  return { checks };
}

async function main() {
  if (process.argv.length > 2) {
    process.stderr.write('Doctor does not accept arguments.\n');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await runDoctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.checks.some((item) => item.status === 'not_ready') ? 1 : 0;
  } catch {
    process.stderr.write('Doctor could not complete its checks.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
