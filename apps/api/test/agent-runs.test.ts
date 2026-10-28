import { afterEach, expect, it, vi } from 'vitest';
import { openRepository, type Repository } from '@sanxing/database';
import { createLearningEngine, describeLearningPrompt } from '@sanxing/learning-agent';
import type { LearningEngine, PublicState } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const config = readConfig({ OWNER_PASSWORD: 'agent-test-password', SESSION_SECRET: 'agent-test-secret-'.repeat(4), AI_MODE: 'mock' });
let repository: Repository;
let instance: Awaited<ReturnType<typeof createApp>>;
afterEach(async () => { await instance?.app.close(); await repository?.close(); vi.unstubAllGlobals(); });

async function setup(execute?: LearningEngine['execute']) {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
  repository = await openRepository(':memory:', 'mock');
  const engine = createLearningEngine();
  const spy = vi.fn(execute ?? engine.execute);
  instance = await createApp({ config, repository, engine: { mode: 'mock', execute: spy }, startWorker: false });
  const queued = await repository.transact(data => {
    const draft = instance.service.createRecitation(data, {});
    instance.service.saveDraft(data, draft.id!, { version: 1, learned: '队列按先入先出的规则移除元素。', unclear: '', application: '', topic: '' });
    return instance.service.submitRecitation(data, draft.id!, { version: 2 });
  });
  return { queued, spy };
}

async function publicState() {
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const response = await instance.app.inject({ url: '/api/state', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return { state: response.json<PublicState>(), cookie, csrf: login.json().csrfToken };
}

it.each([['MODEL_HTTP_429', '限流'], ['MODEL_CONNECTION_RESET', '网络'], ['MODEL_STREAM_INTERRUPTED', '终态'], ['MODEL_AUTH_FAILED', '授权']])('binds the prepared task and exposes safe %s guidance through state', async (code, message) => {
  const usage = { provider: 'offline', model: 'offline', inputTokens: 10, outputTokens: 1, cost: null };
  const { queued, spy } = await setup(async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { code, usage }); });
  const pending = (await repository.read()).runs[queued.runId!]!;
  expect({ version: pending.promptVersion, hash: pending.promptHash }).toEqual(describeLearningPrompt(pending.task));
  await instance.worker.tick();
  const { state } = await publicState();
  expect(state.runs[0]).toMatchObject({ status: 'failed', errorCode: code, error: expect.stringContaining(message) });
  expect(JSON.stringify(state)).not.toContain('PRIVATE_PROVIDER_BODY');
  expect(JSON.stringify(state)).not.toContain(pending.promptHash!);
  expect((await repository.read()).runs[queued.runId!]!.usage).toEqual(usage);
  expect(spy).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it.each(['version', 'hash', 'legacy'] as const)('keeps an obsolete %s task unexecuted after startup, and an idempotent explicit retry uses the current prompt', async changed => {
  const { queued, spy } = await setup();
  await repository.transact(data => {
    const run = data.runs[queued.runId!]!;
    if (changed === 'version') run.promptVersion = 'learning-v5';
    if (changed === 'hash') run.promptHash = '0'.repeat(64);
    if (changed === 'legacy') delete run.promptHash;
  });
  const old = (await repository.read()).runs[queued.runId!]!;
  await instance.worker.start(); await instance.worker.tick();
  const { state, cookie, csrf } = await publicState();
  expect(state.runs[0]).toMatchObject({ errorCode: 'PROMPT_CHANGED', error: expect.stringContaining('重试将使用当前提示词') });
  expect(spy).not.toHaveBeenCalled();
  const request = { method: 'POST' as const, url: `/api/runs/${old.id}/retry`,
    headers: { cookie, origin: config.appOrigin, 'x-csrf-token': csrf, 'idempotency-key': 'stage1-explicit-retry' }, payload: {} };
  const first = await instance.app.inject(request); expect(first.statusCode).toBe(202);
  await instance.worker.tick();
  const second = await instance.app.inject(request); expect(second.json()).toEqual(first.json());
  await instance.worker.tick();
  const data = await repository.read(); const retried = data.runs[first.json().runId]!;
  expect(retried.status).toBe('succeeded'); expect(retried.task).toEqual(old.task);
  expect({ version: retried.promptVersion, hash: retried.promptHash }).toEqual(describeLearningPrompt(retried.task));
  expect(data.runs[old.id]).toMatchObject({ status: 'failed', errorCode: 'PROMPT_CHANGED', promptVersion: old.promptVersion, attempt: 0, startedAt: null });
  expect(spy).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it('serves authenticated live progress without repository transactions and persists final timings', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const { queued, spy } = await setup(async (task, options) => {
    if (task.kind !== 'extract') throw new Error('fixture');
    options.onProgress?.('request'); began(); await blocked;
    options.onProgress?.('generated'); options.onProgress?.('validated');
    return { output: { kind: 'extract', candidates: [{ title: 'Queue', description: 'FIFO', sourceIds: [task.sources[0]!.id] }] }, usage: null };
  });
  expect((await instance.app.inject('/api/runs/progress')).statusCode).toBe(401);
  const { cookie } = await publicState();
  const suite = await instance.app.inject({ url: '/api/ai/evaluations', headers: { cookie } });
  expect(suite.json().timeoutMs).toBe(120_000);
  const work = instance.worker.tick(); await started;
  try {
    const revision = (await repository.read()).revision;
    const read = vi.spyOn(repository, 'read'); const transact = vi.spyOn(repository, 'transact');
    const first = await instance.app.inject({ url: '/api/runs/progress', headers: { cookie } });
    expect(first.json()[queued.runId!]).toMatchObject({ phase: 'waiting', totalTimeoutMs: 60_000 });
    spy.mock.calls[0]![1].onProgress!('text');
    const second = await instance.app.inject({ url: '/api/runs/progress', headers: { cookie } });
    expect(second.json()[queued.runId!]).toMatchObject({ phase: 'generating', firstTextMs: expect.any(Number), lastContentMs: expect.any(Number) });
    expect(read).not.toHaveBeenCalled(); expect(transact).not.toHaveBeenCalled();
    expect((await repository.read()).revision).toBe(revision);
    expect(first.body + second.body).not.toContain('队列');
    release(); await work;
    const finished = (await repository.read()).runs[queued.runId!]!;
    expect(finished).toMatchObject({ status: 'succeeded', progress: { completedMs: expect.any(Number), saveStartedMs: expect.any(Number), generationCompletedMs: expect.any(Number) } });
    expect((await instance.app.inject({ url: '/api/runs/progress', headers: { cookie } })).json()).toEqual({});
    expect((await publicState()).state.runs[0]!.progress).toEqual(finished.progress);
    expect(fetch).not.toHaveBeenCalled();
  } finally { release(); await work; }
});
