import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

export function verificationSteps(suite, directory, npmPath) {
  if (!['all', 'core', 'browser'].includes(suite)) throw new Error('suite must be all, core or browser');
  const npm = (id, args, env) => ({ id, command: [process.execPath, npmPath, 'run', ...args], env });
  const core = [
    npm('check', ['check']),
    npm('tooling', ['test:tooling']),
    { id: 'tests', command: [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${join(directory, 'vitest.json')}`] },
    npm('proxy', ['test:proxy']),
    npm('evaluation', ['evaluate:learning', '--', '--mode', 'offline', '--output', join(directory, 'evaluation.json')]),
  ];
  const browser = [
    npm('python-assets', ['code-runner:packages']),
    { id: 'e2e', command: [process.execPath, 'node_modules/@playwright/test/cli.js', 'test', '--forbid-only', '--reporter=list,html,json', '--output', join(directory, 'traces')],
      env: { PLAYWRIGHT_HTML_REPORT: join(directory, 'playwright'), PLAYWRIGHT_HTML_OPEN: 'never', PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'playwright.json') } },
    { id: 'local-first-e2e', command: [process.execPath, 'node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.local-first.config.ts', '--forbid-only', '--reporter=list,html,json', '--output', join(directory, 'local-traces')],
      env: { PLAYWRIGHT_HTML_REPORT: join(directory, 'local-playwright'), PLAYWRIGHT_HTML_OPEN: 'never', PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'local-playwright.json') } },
    npm('build', ['build'], { SANXING_NEXT_PROFILE: 'validation', NEXT_TELEMETRY_DISABLED: '1' }),
  ];
  return suite === 'core' ? core : suite === 'browser' ? browser : [...core, ...browser];
}

// Next rewrites this file even with an isolated distDir. Restore the exact local
// contents (or absence) after verification, including failures and cancellation.
export async function preserveGeneratedFile(path, action) {
  const original = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  try { return await action(); }
  finally {
    if (original === null) await rm(path, { force: true });
    else await writeFile(path, original);
  }
}

async function executeStep(step, { cwd, directory, env, signal }) {
  const fd = openSync(join(directory, `${step.id}.log`), 'wx', 0o600);
  try {
    return await new Promise(resolveResult => {
      const grouped = process.platform !== 'win32';
      const child = spawn(step.command[0], step.command.slice(1), {
        cwd, env: { ...env, ...step.env }, stdio: ['ignore', fd, fd], detached: grouped,
      });
      let failure = null;
      let escalation;
      const kill = kind => {
        if (!child.pid) return;
        try { if (grouped) process.kill(-child.pid, kind); else child.kill(kind); }
        catch (error) { if (error.code !== 'ESRCH') failure = error.code ?? 'KILL_FAILED'; }
      };
      const cancel = () => {
        kill('SIGTERM');
        escalation ??= setTimeout(() => kill('SIGKILL'), 5000);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.once('error', error => { failure = error.code ?? 'SPAWN_FAILED'; });
      child.once('close', (exitCode, terminationSignal) => {
        clearTimeout(escalation);
        signal?.removeEventListener('abort', cancel);
        resolveResult({ exitCode, signal: terminationSignal, errorCode: failure });
      });
    });
  } finally { closeSync(fd); }
}

export async function runSteps(steps, { cwd = root, directory, env = process.env, signal, announce = console.log }) {
  await mkdir(directory, { recursive: true });
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, status: 'running', steps: steps.map(step => ({ id: step.id, command: step.command, status: 'not_run', log: `${step.id}.log` })) };
  const save = async () => {
    await writeFile(join(directory, 'summary.json.tmp'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(join(directory, 'summary.json.tmp'), join(directory, 'summary.json'));
  };
  await save();
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) break;
    const item = report.steps[index];
    item.status = 'running'; item.startedAt = new Date().toISOString();
    await save(); announce(`START ${step.id} — ${join(directory, item.log)}`);
    const start = performance.now();
    try { Object.assign(item, await executeStep(step, { cwd, directory, env, signal })); }
    catch (error) { Object.assign(item, { exitCode: null, signal: null, errorCode: error.code ?? 'RUNNER_FAILED' }); }
    item.durationMs = Math.round(performance.now() - start);
    item.status = signal?.aborted ? 'cancelled' : item.exitCode === 0 && !item.errorCode ? 'passed' : 'failed';
    await save(); announce(`${item.status.toUpperCase()} ${step.id} (${item.durationMs} ms)`);
    if (item.status !== 'passed') break;
  }
  report.status = signal?.aborted ? 'cancelled' : report.steps.every(step => step.status === 'passed') ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();
  await save();
  return report;
}

async function main() {
  const { values } = parseArgs({ options: { suite: { type: 'string', default: 'all' } }, strict: true });
  if (!process.env.npm_execpath) throw new Error('Use npm run verify [-- --suite core|browser|all]');
  // Reject misspelled suites before creating artifacts or starting a command.
  verificationSteps(values.suite, '', process.env.npm_execpath);
  const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, `verify-${values.suite}-`));
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const execute = () => runSteps(verificationSteps(values.suite, directory, process.env.npm_execpath), { directory, signal: controller.signal });
    const report = values.suite === 'core' ? await execute() : await preserveGeneratedFile(join(root, 'apps/web/next-env.d.ts'), execute);
    console.log(`Verification ${report.status}: ${join(directory, 'summary.json')}`);
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'cancelled' ? controller.signal.reason === 'SIGTERM' ? 143 : 130 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
