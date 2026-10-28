import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preserveGeneratedFile, runSteps, verificationSteps } from './verify.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-verify-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, announce: () => {} };
}
const command = (id, code) => ({ id, command: [process.execPath, '-e', code] });

test('records stage exit codes and both output streams, and never reports unrun stages as passed', async t => {
  const options = await fixture(t);
  const report = await runSteps([
    command('ok', 'console.log("stdout evidence"); console.error("stderr evidence")'),
    command('failed', 'process.exitCode = 7'),
    command('unrun', 'throw new Error("must never run")'),
  ], options);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.steps.map(step => step.status), ['passed', 'failed', 'not_run']);
  assert.equal(report.steps[1].exitCode, 7);
  assert.equal(typeof report.steps[0].durationMs, 'number');
  assert.match(await readFile(join(options.directory, 'ok.log'), 'utf8'), /stdout evidence[\s\S]*stderr evidence/);
  assert.deepEqual(JSON.parse(await readFile(join(options.directory, 'summary.json'), 'utf8')), report);
});

test('a missing executable fails with a diagnostic instead of hanging or passing', async t => {
  const options = await fixture(t);
  const result = await runSteps([{ id: 'missing', command: [join(options.directory, 'missing-command')] }], options);
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0].errorCode, 'ENOENT');
});

test('cancellation terminates an active process and preserves the cancelled diagnostic', { timeout: 10000 }, async t => {
  const options = await fixture(t); const controller = new AbortController();
  const result = runSteps([command('waiting', 'setInterval(() => {}, 1000)'), command('unrun', '')], { ...options, signal: controller.signal,
    announce: message => { if (message.startsWith('START')) setTimeout(() => controller.abort(), 50); } });
  const report = await result;
  assert.equal(report.status, 'cancelled');
  assert.equal(report.steps[0].status, 'cancelled');
  assert.equal(report.steps[1].status, 'not_run');
});

test('restores existing generated files after failure, and removes files originally absent', async t => {
  const { directory } = await fixture(t); const file = join(directory, 'next-env.d.ts');
  await writeFile(file, 'local original\r\n');
  await assert.rejects(preserveGeneratedFile(file, async () => { await writeFile(file, 'generated'); throw new Error('build failed'); }), /build failed/);
  assert.equal(await readFile(file, 'utf8'), 'local original\r\n');
  await rm(file);
  assert.equal(await preserveGeneratedFile(file, async () => { await writeFile(file, 'generated'); return 42; }), 42);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('both CI suites cover the full local plan with offline evaluation and no focused tests', () => {
  const directory = join(tmpdir(), 'output with spaces');
  const core = verificationSteps('core', directory, '/npm-cli.js');
  const browser = verificationSteps('browser', directory, '/npm-cli.js');
  assert.deepEqual(verificationSteps('all', directory, '/npm-cli.js'), [...core, ...browser]);
  assert.deepEqual(core.map(step => step.id), ['check', 'tooling', 'tests', 'proxy', 'evaluation']);
  assert.deepEqual(browser.map(step => step.id), ['python-assets', 'e2e', 'local-first-e2e', 'build']);
  assert.ok(core.find(step => step.id === 'tests').command.includes('--allowOnly=false'));
  assert.ok(browser.find(step => step.id === 'e2e').command.includes('--forbid-only'));
  assert.deepEqual(core.at(-1).command.slice(-4), ['--mode', 'offline', '--output', join(directory, 'evaluation.json')]);
  assert.equal(browser.at(-1).env.SANXING_NEXT_PROFILE, 'validation');
  assert.throws(() => verificationSteps('live', directory, '/npm-cli.js'), /suite must/);
});
