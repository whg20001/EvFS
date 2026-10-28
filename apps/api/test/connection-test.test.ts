import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import { openRepository } from '@sanxing/database';
import type { AiConnectionTestView, AiModelConfiguration, AiModelSelection, LearningEngine, TokenUsageHeatmap, Usage } from '@sanxing/contracts';
import { AiModelRuntime } from '../src/ai-runtime.ts';
import { createApp } from '../src/app.ts';
import { readConfig, type ApiConfig } from '../src/config.ts';
import { EVALUATION_VERSION, evaluationCases } from '@sanxing/learning-agent/evaluations';

const password = 'connection-test-only-password';
const endpoint = '/api/ai/providers/openai-codex/test';
const usage: Usage = { provider: 'offline-test', model: 'offline-test', inputTokens: 9, outputTokens: 4, cost: null };
let repository: Awaited<ReturnType<typeof openRepository>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let credentials: InMemoryCredentialStore;
let config: ApiConfig;
let selection: AiModelSelection;
let cookie = ''; let csrf = ''; let time = new Date('2026-04-01T00:00:00Z');
const execute = vi.fn<LearningEngine['execute']>();
const get = (url: string) => instance.app.inject({ url, headers: { cookie } });
const post = (url: string, payload: object, key = randomUUID()) => instance.app.inject({ method: 'POST', url, payload, headers: { cookie, origin: config.appOrigin, 'x-csrf-token': csrf, 'idempotency-key': key } });
const input = () => ({ confirm: true, expectedSelection: selection });
const evaluationInput = (caseId = 'cache-grade-correct', batchId = randomUUID()) => ({ ...input(), suite: EVALUATION_VERSION, caseId, batchId });
async function assemble() {
  const access = createAiAccessController({ credentials, deviceId: randomUUID() });
  const runtime = new AiModelRuntime({ config, repository, credentials, engineFactory: () => ({ mode: config.mode, execute }) });
  instance = await createApp({ config, repository, engine: runtime, modelRuntime: runtime, aiAccess: access, now: () => time, startWorker: false });
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.appOrigin }, payload: { password } });
  expect(login.statusCode).toBe(200); cookie = String(login.headers['set-cookie']).split(';')[0]!; csrf = login.json().csrfToken;
}
async function setup(overrides: Partial<ApiConfig> = {}) {
  config = { ...readConfig({ AI_MODE: 'live', OWNER_PASSWORD: password, SESSION_SECRET: 'connection-test-secret-'.repeat(3) }), ...overrides };
  repository = await openRepository(':memory:', config.mode);
  credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: 'PRIVATE_ACCESS_SENTINEL', refresh: 'PRIVATE_REFRESH_SENTINEL', expires: Date.now() + 3_600_000 }));
  await assemble();
  const view = (await get('/api/ai/configuration')).json<AiModelConfiguration>();
  selection = { providerId: 'openai-codex', modelId: view.providers.find(p => p.id === 'openai-codex')!.models[0]!.id, authMethod: 'oauth', allowUnboundedOutput: true };
  expect((await post('/api/ai/configuration', { expectedRevision: view.revision, ...selection })).statusCode).toBe(200);
}
async function finished() { await instance.worker.tick(); return (await get(endpoint)).json<{ test: AiConnectionTestView }>().test; }
beforeEach(() => {
  time = new Date('2026-04-01T00:00:00Z');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network forbidden in connection tests'); }));
  execute.mockReset(); execute.mockImplementation(async (_task, options) => {
    await options.onUsage?.(usage); return { output: { kind: 'connection_test', ok: true }, usage };
  });
});
it('runs a fixed synthetic evaluation through app OAuth without touching learning records, and deduplicates after restart', async () => {
  await setup();
  const output = { kind: 'grade' as const, status: 'graded' as const, scores: [{ rubricId: 'r1', score: 1, evidence: '明确说明空结果' }, { rubricId: 'r2', score: 1, evidence: '说明 TTL 与失效' }], feedback: '正确' };
  execute.mockResolvedValue({ output, usage });
  const body = evaluationInput(); const key = randomUUID(); const before = await repository.read();
  const response = await post('/api/ai/evaluations', body, key); expect(response.statusCode).toBe(202);
  await instance.worker.tick(); const id = response.json().runId;
  const view = (await get(`/api/ai/evaluations/${id}`)).json();
  expect(view).toMatchObject({ status: 'succeeded', evaluation: { suite: EVALUATION_VERSION, caseId: body.caseId, output }, usage });
  expect(execute.mock.calls[0]![0]).toEqual({ ...evaluationCases.find(item => item.id === body.caseId)!.task, skills: [] });
  const after = await repository.read();
  for (const map of ['recitations', 'documents', 'sessions', 'quizzes', 'knowledge', 'cards', 'evidence', 'reviewSessions', 'reviewEvents'] as const) expect(after[map]).toEqual(before[map]);
  await repository.replace(after); // export/import schema accepts synthetic references and outputs
  await instance.app.close(); await assemble();
  expect((await post('/api/ai/evaluations', body, key)).json().runId).toBe(id); await instance.worker.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await post('/api/ai/evaluations', body)).statusCode).toBe(409);
  expect((await post(`/api/runs/${id}/retry`, {})).statusCode).toBe(409);
  expect(JSON.stringify(view)).not.toContain('PRIVATE_ACCESS_SENTINEL');
});
it('reads one evaluation without the aggregate and reports final diagnostics still being saved', async () => {
  await setup();
  const request = { provider: selection.providerId, model: selection.modelId, authMethod: 'oauth' as const, cacheRetention: 'none' as const,
    inputChars: 10, inputBytes: 20, estimatedInputTokens: 5, contextWindow: 1000, maxOutputTokens: 100, timeoutMs: 1000, firstResponseTimeoutMs: 500, streamIdleTimeoutMs: 500 };
  const transport = { policy: 'fresh' as const, phase: 'complete' as const, reusedSocket: false, requestCount: 1, bytesWritten: 80, bytesRead: 120, httpStatus: 200 };
  execute.mockImplementationOnce(async (_task, options) => {
    expect(options.connectionPolicy).toBe('fresh'); options.onTransport?.(transport);
    options.onRequest?.(request); options.onProgress?.('request'); options.onProgress?.('text'); options.onProgress?.('generated'); options.onProgress?.('validated');
    return { output: { kind: 'grade', status: 'needs_verification', scores: [], feedback: 'test' }, usage };
  });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const saving = new Promise<void>(resolve => { reached = resolve; });
  const original = instance.service.recordRunProgress.bind(instance.service);
  vi.spyOn(instance.service, 'recordRunProgress').mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
  const queued = await post('/api/ai/evaluations', { ...evaluationInput(), connectionPolicy: 'fresh' }); expect(queued.statusCode).toBe(202);
  const id = queued.json().runId; await saving;
  const read = vi.spyOn(repository, 'read');
  try {
    expect((await instance.app.inject(`/api/ai/evaluations/${id}`)).statusCode).toBe(401);
    const pending = await get(`/api/ai/evaluations/${id}`);
    expect(pending.json()).toMatchObject({ status: 'succeeded', diagnosticsPending: true, request, transport, evaluation: { connectionPolicy: 'fresh' }, progress: { phase: 'saving' } });
    expect(read).not.toHaveBeenCalled();
    release(); await instance.worker.tick();
    expect((await get(`/api/ai/evaluations/${id}`)).json()).toMatchObject({ diagnosticsPending: false, request, transport, progress: { completedMs: expect.any(Number) } });
    expect(read).not.toHaveBeenCalled();
  } finally { release(); await instance.worker.tick(); read.mockRestore(); }
});

it('requires evaluation auth/CSRF/confirmation, rejects arbitrary inputs and pins the selected model', async () => {
  await setup(); const body = evaluationInput();
  expect((await instance.app.inject({ url: '/api/ai/evaluations' })).statusCode).toBe(401);
  expect((await instance.app.inject({ method: 'POST', url: '/api/ai/evaluations', payload: body, headers: { cookie } })).statusCode).toBe(403);
  for (const payload of [{ ...body, confirm: false }, { ...body, connectionPolicy: 'auto' }, { ...body, caseId: 'personal-notes' }, { ...body, task: evaluationCases[0]!.task }, { ...body, suite: 'unknown-version' }]) expect((await post('/api/ai/evaluations', payload)).statusCode).toBe(400);
  expect((await post('/api/ai/evaluations', { ...body, expectedSelection: { ...selection, modelId: 'changed' } })).statusCode).toBe(409);
  expect((await repository.read()).runs).toEqual({}); expect(execute).not.toHaveBeenCalled();
});
afterEach(async () => { await instance?.app.close(); await repository?.close(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

it('keeps GETs read-only and requires authentication, CSRF, exact origin and explicit confirmation', async () => {
  await setup();
  expect((await instance.app.inject({ url: endpoint })).statusCode).toBe(401);
  expect((await get(endpoint)).json()).toEqual({ test: null });
  expect((await instance.app.inject({ method: 'POST', url: endpoint, payload: input(), headers: { cookie, origin: config.appOrigin } })).statusCode).toBe(403);
  expect((await instance.app.inject({ method: 'POST', url: endpoint, payload: input(), headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf, 'idempotency-key': randomUUID() } })).statusCode).toBe(403);
  for (const payload of [{ expectedSelection: selection }, { ...input(), confirm: false }, { ...input(), prompt: 'Do not send this' }]) {
    expect((await post(endpoint, payload)).statusCode).toBe(400);
  }
  expect((await repository.read()).runs).toEqual({}); expect(execute).not.toHaveBeenCalled();
});
it('records one fixed probe without sending or changing any learning records, and includes usage in the heatmap', async () => {
  await setup();
  await repository.transact(data => { data.knowledge.private = { id: 'private', title: 'PRIVATE_LEARNING_SENTINEL', description: 'private notes', understanding: 'private answer', sourceIds: [], version: 1, createdAt: time.toISOString(), updatedAt: time.toISOString() }; });
  const before = await repository.read(); const response = await post(endpoint, input()); expect(response.statusCode).toBe(202);
  const view = await finished(); expect(view).toMatchObject({ providerId: selection.providerId, modelId: selection.modelId, mode: 'live', status: 'succeeded', durationMs: 0, usage });
  expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]![0]).toEqual({ kind: 'connection_test', selection });
  const after = await repository.read();
  const excludeRuntime = ({ runs: _runs, receipts: _receipts, revision: _revision, ...rest }: typeof before) => rest;
  expect(excludeRuntime(after)).toEqual(excludeRuntime(before));
  for (const text of [JSON.stringify(execute.mock.calls[0]![0]), JSON.stringify(view)]) {
    expect(text).not.toContain('PRIVATE_LEARNING_SENTINEL'); expect(text).not.toContain('PRIVATE_ACCESS_SENTINEL'); expect(text).not.toContain('PRIVATE_REFRESH_SENTINEL');
  }
  expect(view).not.toHaveProperty('task');
  const heatmap = (await get('/api/ai/usage?year=2026')).json<TokenUsageHeatmap>();
  expect(heatmap.totals).toMatchObject({ attempts: 1, knownUsageAttempts: 1, inputTokens: 9, outputTokens: 4 });
});
it('deduplicates paid test requests across a host restart and rejects generic retry without confirmation', async () => {
  await setup(); const key = randomUUID(); const body = input();
  const first = await post(endpoint, body, key); expect(first.statusCode).toBe(202); const view = await finished();
  expect((await post(endpoint, body, key)).json<AiConnectionTestView>().id).toBe(view.id);
  await instance.app.close(); await assemble();
  expect((await post(endpoint, body, key)).json<AiConnectionTestView>().id).toBe(view.id); expect(execute).toHaveBeenCalledTimes(1);
  await repository.transact(data => { data.runs[view.id]!.status = 'failed'; });
  expect((await post(`/api/runs/${view.id}/retry`, {})).statusCode).toBeGreaterThanOrEqual(400);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('rejects mock, stale model consent and revoked OAuth without creating a request', async () => {
  await setup({ mode: 'mock' });
  expect((await post(endpoint, input())).statusCode).toBe(400); expect(execute).not.toHaveBeenCalled();
  await instance.app.close(); await repository.close(); await setup();
  expect((await post(endpoint, { ...input(), expectedSelection: { ...selection, modelId: 'different-model' } })).statusCode).toBe(409);
  expect((await post('/api/ai/providers/anthropic/test', input())).statusCode).toBe(400);
  await credentials.delete('openai-codex');
  expect((await post(endpoint, input())).statusCode).toBe(400);
  expect((await repository.read()).runs).toEqual({}); expect(execute).not.toHaveBeenCalled();
});
it('preserves known usage on failure, returns safe errors and never automatically retries', async () => {
  await setup(); execute.mockRejectedValue(Object.assign(new Error('PRIVATE_ACCESS_SENTINEL upstream stack'), { code: 'TIMEOUT', usage }));
  expect((await post(endpoint, input())).statusCode).toBe(202);
  const view = await finished(); expect(view.status).toBe('failed'); expect(view.error).toContain('超时'); expect(view.usage).toEqual(usage);
  expect(JSON.stringify(view)).not.toContain('PRIVATE_ACCESS_SENTINEL'); expect(execute).toHaveBeenCalledTimes(1);
  expect((await post(endpoint, input())).statusCode).toBe(429);
  time = new Date(time.getTime() + 31_000); expect((await post(endpoint, input())).statusCode).toBe(202); await finished();
  expect(execute).toHaveBeenCalledTimes(2);
});
it('keeps unreported test usage unknown instead of displaying zero', async () => {
  await setup(); execute.mockRejectedValue(new Error('untrusted exception'));
  await post(endpoint, input()); const view = await finished(); expect(view).toMatchObject({ status: 'failed', usage: null });
  expect(view.error).not.toContain('untrusted');
  expect((await get('/api/ai/usage?year=2026')).json<TokenUsageHeatmap>().totals).toMatchObject({ attempts: 1, knownUsageAttempts: 0, unknownUsageAttempts: 1 });
});
it('honors an optional budget without sending a rejected probe', async () => {
  await setup({ dailyBudgetUsd: 0.01, requestReservationUsd: 0.1 });
  expect((await post(endpoint, input())).statusCode).toBe(202); const view = await finished();
  expect(view).toMatchObject({ status: 'failed', startedAt: null, usage: null, error: expect.stringContaining('预算不足') }); expect(execute).not.toHaveBeenCalled();
});
it('prevents overlapping tests/model changes and fences a cancelled test while retaining observed usage', async () => {
  await setup(); let release!: () => void;
  execute.mockImplementation(async (_task, options) => {
    await options.onUsage?.(usage); await new Promise<void>(resolve => { release = resolve; });
    return { output: { kind: 'connection_test', ok: true }, usage };
  });
  const first = await post(endpoint, input()); expect(first.statusCode).toBe(202);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect((await post(endpoint, input())).statusCode).toBeGreaterThanOrEqual(400);
  const current = (await get('/api/ai/configuration')).json<AiModelConfiguration>();
  expect((await post('/api/ai/configuration', { expectedRevision: current.revision, ...selection })).statusCode).toBe(409);
  const id = first.json<AiConnectionTestView>().id;
  expect((await post(`/api/runs/${id}/cancel`, {})).statusCode).toBe(202);
  release(); const view = await finished(); expect(view).toMatchObject({ id, status: 'cancelled', usage });
  expect(execute).toHaveBeenCalledTimes(1);
});
