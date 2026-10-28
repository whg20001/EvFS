import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { CredentialStore } from '@sanxing/ai-access';
import { createExplicitProvider, LIVE_PROVIDER_IDS, type LiveProviderId } from '@sanxing/ai-access/providers';
import type { AgentRun, AiModelSelection, AiResponse, AiTask, LearningEngine } from '@sanxing/contracts';
import { emptyData, openRepository, type Repository } from '@sanxing/database';
import { describeLearningPrompt, type createLearningEngine } from '@sanxing/learning-agent';
import { DomainError } from '@sanxing/learning-domain';
import { AiModelRuntime } from '../src/ai-runtime.ts';
import { readConfig, type ApiConfig } from '../src/config.ts';

const task: AiTask = { kind: 'extract', recitation: { topic: '测试', learned: '学习内容', unclear: '', application: '' }, sources: [] };
const response: AiResponse = { output: { kind: 'extract', candidates: [{ title: '知识', description: '描述', sourceIds: [] }] }, usage: { provider: 'test-only', model: 'test-only', inputTokens: 12, outputTokens: 8, cost: null } };
const environment = { OWNER_PASSWORD: 'runtime-test-password', SESSION_SECRET: 'runtime-test-secret-'.repeat(4), AI_MODE: 'live' };
const config = (patch: Partial<ApiConfig> = {}): ApiConfig => ({ ...readConfig(environment), ...patch });
function selection(providerId: LiveProviderId = 'openai', index = 0): AiModelSelection {
  const model = createExplicitProvider(providerId).getModels().filter(model => model.input.includes('text'))[index];
  if (!model) throw new Error('Test requires a text chat model in the local catalog');
  return { providerId, modelId: model.id, authMethod: 'oauth', allowUnboundedOutput: true };
}
const options = (): Parameters<LearningEngine['execute']>[1] => ({ signal: new AbortController().signal });
let repository: Repository;
let credentials: InMemoryCredentialStore;
let engineExecute: ReturnType<typeof vi.fn<LearningEngine['execute']>>;
let engineFactory: ReturnType<typeof vi.fn<typeof createLearningEngine>>;
function runtime(patch: Partial<ApiConfig> = {}, store: CredentialStore | undefined = credentials, repo = repository) {
  return new AiModelRuntime({ config: config(patch), repository: repo, credentials: store, engineFactory });
}
async function connect(id: LiveProviderId = 'openai') {
  // Expiry is deliberately past: local connection status is not a refresh or an account check.
  await credentials.modify(id, async () => ({ type: 'oauth', access: 'secret-test-access', refresh: 'secret-test-refresh', expires: 1 }));
}
async function save(subject: AiModelRuntime, choice = selection()) {
  return subject.save({ ...choice, expectedRevision: (await repository.read()).revision });
}
function run(status: AgentRun['status']): AgentRun {
  return { id: 'run', status, task, sessionId: null, reviewSessionId: null, quizId: null, questionId: null,
    attempt: 0, attemptId: null, expectedVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', startedAt: null,
    finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'test' };
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in runtime tests'); }));
  repository = await openRepository(':memory:', 'live');
  credentials = new InMemoryCredentialStore();
  engineExecute = vi.fn<LearningEngine['execute']>(async (_task, opts) => {
    if (response.usage !== null) await opts.onUsage?.(response.usage);
    return response;
  });
  engineFactory = vi.fn<typeof createLearningEngine>((input = { mode: 'mock' }) => ({ mode: input.mode, execute: engineExecute }));
});
afterEach(async () => {
  await repository?.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('rejects an obsolete queued prompt before reading credentials or constructing an engine', async () => {
  const read = vi.spyOn(credentials, 'read');
  const expectedPrompt = { ...describeLearningPrompt(task), version: 'learning-v5' };
  await expect(runtime().execute(task, { ...options(), expectedPrompt })).rejects.toMatchObject({ code: 'PROMPT_CHANGED' });
  expect(read).not.toHaveBeenCalled(); expect(engineFactory).not.toHaveBeenCalled();
});

it('reads only the selected OAuth credential on each execution and uses narrow settings', async () => {
  await connect(); const subject = runtime(); await save(subject);
  const originalRead = credentials.read.bind(credentials);
  const read = vi.spyOn(credentials, 'read').mockImplementation(async id => {
    if (id !== 'openai') throw new Error('Unrelated vault unavailable');
    return originalRead(id);
  });
  const fullRead = vi.spyOn(repository, 'read').mockRejectedValue(new Error('Full read forbidden'));
  const opts = { ...options(), onRequest: vi.fn() };
  await subject.execute(task, opts); await subject.execute(task, options());
  expect(read.mock.calls).toEqual([['openai'], ['openai']]); expect(fullRead).not.toHaveBeenCalled();
  expect(engineExecute.mock.calls[0]![1]).toBe(opts);
  await credentials.delete('openai');
  await expect(subject.execute(task, options())).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  expect(engineExecute).toHaveBeenCalledTimes(2);
});

it('does not consult OAuth for API keys and protects the cached catalog from returned-view mutations', async () => {
  const choice = { ...selection(), authMethod: 'api_key' as const };
  const subject = runtime({ provider: 'openai', model: choice.modelId, apiKey: 'test-only-key', modelAuthMethod: 'api_key' });
  const first = await subject.configuration();
  first.providers.find(provider => provider.id === 'openai')!.models.length = 0;
  const read = vi.spyOn(credentials, 'read').mockRejectedValue(new Error('OAuth vault unavailable'));
  const fullRead = vi.spyOn(repository, 'read').mockRejectedValue(new Error('Full read forbidden'));
  await subject.execute(task, options());
  expect(read).not.toHaveBeenCalled(); expect(fullRead).not.toHaveBeenCalled(); expect(engineExecute).toHaveBeenCalledTimes(1);
  read.mockRestore();
  expect((await subject.configuration()).providers.find(provider => provider.id === 'openai')!.models.some(model => model.id === choice.modelId)).toBe(true);
});

it('uses an explicit cache preference and purpose-scoped opaque affinity without caching connection probes', async () => {
  await connect(); const subject = runtime(); await save(subject);
  await subject.execute(task, { ...options(), cacheScope: 'private-session-identifier' });
  expect(engineFactory.mock.calls.at(-1)?.[0]?.cacheRetention).toBe('none');
  expect(engineExecute.mock.calls.at(-1)?.[1]).not.toHaveProperty('cacheScope');
  await repository.transact(data => { data.learningPreferences = { schedulingEnabled: false, promptCacheRetention: 'short' }; });
  await subject.execute(task, { ...options(), cacheScope: 'private-session-identifier' });
  const first = engineExecute.mock.calls.at(-1)![1].cacheScope;
  expect(engineFactory.mock.calls.at(-1)?.[0]?.cacheRetention).toBe('short');
  expect(first).toMatch(/^[a-f0-9]{64}$/); expect(first).not.toContain('private-session');
  await subject.execute(task, { ...options(), cacheScope: 'private-session-identifier' });
  expect(engineExecute.mock.calls.at(-1)![1].cacheScope).toBe(first);
  await subject.execute(task, { ...options(), cacheScope: 'other-session' });
  expect(engineExecute.mock.calls.at(-1)![1].cacheScope).not.toBe(first);
  await subject.execute({ kind: 'connection_test', selection: selection() }, { ...options(), cacheScope: 'private-session-identifier' });
  expect(engineFactory.mock.calls.at(-1)?.[0]?.cacheRetention).toBe('none');
  expect(engineExecute.mock.calls.at(-1)?.[1]).not.toHaveProperty('cacheScope');
});

it('starts live without a model or budget, exposes configuration, and refuses doomed work', async () => {
  const subject = runtime();
  expect(subject.mode).toBe('live');
  expect(config()).toMatchObject({ dailyBudgetUsd: null, requestReservationUsd: 0 });
  expect(await subject.configuration()).toMatchObject({ revision: 0, selection: null, source: 'none', ready: false,
    problem: '请先在 AI 配置页面选择并保存模型', budget: { enabled: false, dailyUsd: null, reservationUsd: null } });
  await expect(subject.assertCanQueue(await repository.read())).rejects.toMatchObject({ name: 'DomainError', status: 400, message: '请先在 AI 配置页面选择并保存模型' });
  await expect(subject.execute(task, options())).rejects.toMatchObject({ code: 'AI_MODEL_REQUIRED' });
  expect(engineFactory).not.toHaveBeenCalled();
  expect(engineExecute).not.toHaveBeenCalled();
});

it('lists only explicit local text chat models, without choosing an authorized provider or exposing secrets', async () => {
  await connect();
  await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'secret-test-stored-key' }));
  const subject = runtime({ provider: 'openai', apiKey: 'secret-test-config-key' });
  const view = await subject.configuration();
  expect(view.providers.map(provider => provider.id)).toEqual([...LIVE_PROVIDER_IDS]);
  expect(view.selection).toBeNull();
  expect(view.source).toBe('none');
  for (const provider of view.providers) {
    expect(provider.models).toEqual(createExplicitProvider(provider.id as LiveProviderId).getModels()
      .filter(model => model.input.includes('text')).map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })));
    expect(provider.models.length).toBeGreaterThan(0);
  }
  expect(view.providers[0]).toMatchObject({ oauthConnected: true, apiKeyAvailable: true, requiresOAuthOutputAcknowledgement: true });
  expect(view.providers[1]).toMatchObject({ oauthConnected: false, apiKeyAvailable: false, requiresOAuthOutputAcknowledgement: false });
  expect(view.providers[2]).toMatchObject({ oauthConnected: false, apiKeyAvailable: false, requiresOAuthOutputAcknowledgement: true });
  expect(JSON.stringify(view)).not.toContain('secret-test');
  expect(engineFactory).not.toHaveBeenCalled();
});

it('uses an environment fallback only when both provider and model are explicit; saved selection wins', async () => {
  await connect();
  const candidate = selection();
  const subject = runtime({ provider: 'openai', model: candidate.modelId, modelAuthMethod: 'oauth', allowUnboundedOAuthOutput: true });
  expect(await subject.configuration()).toMatchObject({ source: 'environment', selection: candidate, ready: true });
  expect((await runtime({ model: candidate.modelId }).configuration()).selection).toBeNull();
  const other = selection('openai', 1);
  expect(await save(subject, other)).toMatchObject({ source: 'saved', selection: other, revision: 1, ready: true });
  expect((await repository.read()).aiModel).toEqual(other);
  expect((await runtime({ provider: 'anthropic', model: 'invalid-environment-model' }).configuration()).selection).toEqual(other);
  expect((await repository.read()).aiModel).not.toHaveProperty('expectedRevision');
  expect(JSON.stringify(await repository.read())).not.toContain('secret-test');
  expect(engineFactory).not.toHaveBeenCalled();
});

it('reports unavailable environment authentication without silently falling back', async () => {
  const candidate = selection();
  const subject = runtime({ provider: 'openai', model: candidate.modelId, modelAuthMethod: 'oauth', allowUnboundedOAuthOutput: true });
  expect(await subject.configuration()).toMatchObject({ source: 'environment', ready: false, problem: expect.stringContaining('授权') });
  await expect(subject.assertCanQueue(await repository.read())).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
});

it('reports a configured budget only in live mode', async () => {
  const budget = { dailyBudgetUsd: 3, requestReservationUsd: 0.2 };
  expect((await runtime(budget).configuration()).budget).toEqual({ enabled: true, dailyUsd: 3, reservationUsd: 0.2 });
  expect((await runtime({ ...budget, mode: 'mock' }).configuration()).budget).toEqual({ enabled: false, dailyUsd: null, reservationUsd: null });
});

it.each([
  ['provider', { providerId: 'not-registered' }, 'AI_PROVIDER_UNSUPPORTED'],
  ['model', { modelId: 'not-a-chat-model' }, 'AI_MODEL_UNSUPPORTED'],
  ['auth method', { authMethod: 'ambient' }, 'AI_MODEL_INVALID'],
  ['unconfirmed output limit', { allowUnboundedOutput: false }, 'AI_OUTPUT_ACK_REQUIRED'],
  ['missing key', { authMethod: 'api_key' }, 'AI_API_KEY_UNAVAILABLE'],
  ['key injection', { apiKey: 'secret-test-injected' }, 'AI_MODEL_INVALID'],
  ['token injection', { access: 'secret-test-injected' }, 'AI_MODEL_INVALID'],
  ['nested credentials injection', { credentials: { refresh: 'secret-test-injected' } }, 'AI_MODEL_INVALID'],
  ['missing revision', { expectedRevision: undefined }, 'AI_MODEL_INVALID'],
  ['negative revision', { expectedRevision: -1 }, 'AI_MODEL_INVALID'],
  ['fractional revision', { expectedRevision: 0.5 }, 'AI_MODEL_INVALID'],
])('rejects %s without mutating data or calling a model', async (_name, patch, code) => {
  await connect();
  const subject = runtime();
  await expect(subject.save({ ...selection(), expectedRevision: 0, ...patch })).rejects.toMatchObject({ name: 'DomainError', code, status: 400 });
  expect(await repository.read()).toMatchObject({ revision: 0, aiModel: null });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('requires the selected provider OAuth credential, not another provider or a stored key', async () => {
  await connect('anthropic');
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'secret-test-stored-key' }));
  await expect(save(runtime())).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  const noStore = new AiModelRuntime({ config: config(), repository, engineFactory });
  await expect(save(noStore, selection('anthropic'))).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('requires Codex output acknowledgement and never offers Codex API-key authentication', async () => {
  await connect('openai-codex');
  const subject = runtime({ provider: 'openai-codex', apiKey: 'secret-test-config-key' });
  expect((await subject.configuration()).providers.find(provider => provider.id === 'openai-codex')?.apiKeyAvailable).toBe(false);
  await expect(save(subject, { ...selection('openai-codex'), allowUnboundedOutput: false })).rejects.toMatchObject({ code: 'AI_OUTPUT_ACK_REQUIRED' });
  await expect(save(subject, { ...selection('openai-codex'), authMethod: 'api_key' })).rejects.toMatchObject({ code: 'AI_API_KEY_UNAVAILABLE' });
  expect((await save(subject, selection('openai-codex'))).ready).toBe(true);
});

it.each(['anthropic', 'xai'] as const)('allows %s OAuth without the OpenAI/Codex output acknowledgement', async id => {
  await connect(id);
  expect((await save(runtime(), { ...selection(id), allowUnboundedOutput: false })).ready).toBe(true);
});

it('offers xAI API-key authentication only when MODEL_PROVIDER=xai has a server key', async () => {
  expect((await runtime({ provider: 'xai', apiKey: 'secret-test-config-key' }).configuration()).providers.find(provider => provider.id === 'xai')).toMatchObject({ name: 'xAI', apiKeyAvailable: true, requiresOAuthOutputAcknowledgement: false });
  expect((await runtime({ provider: 'openai', apiKey: 'secret-test-config-key' }).configuration()).providers.find(provider => provider.id === 'xai')?.apiKeyAvailable).toBe(false);
});

it('allows only the explicitly configured provider API key and passes it only to API-key calls', async () => {
  const subject = runtime({ provider: 'openai', apiKey: 'secret-test-config-key' });
  const candidate = { ...selection(), authMethod: 'api_key' as const, allowUnboundedOutput: false };
  await expect(save(subject, { ...selection('anthropic'), authMethod: 'api_key' })).rejects.toMatchObject({ code: 'AI_API_KEY_UNAVAILABLE' });
  expect((await save(subject, candidate)).ready).toBe(true);
  await subject.execute(task, options());
  expect(engineFactory).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai', model: candidate.modelId, authMethod: 'api_key', apiKey: 'secret-test-config-key' }), expect.objectContaining({ credentials }));
  await connect();
  await save(subject);
  await subject.execute(task, options());
  expect(engineFactory.mock.calls.at(-1)?.[0]).not.toHaveProperty('apiKey');
  expect(engineFactory.mock.calls.at(-1)?.[0]?.authMethod).toBe('oauth');
});

it('rejects stale revisions atomically', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  await expect(subject.save({ ...selection('openai', 1), expectedRevision: 0 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
  expect(await repository.read()).toMatchObject({ revision: 1, aiModel: selection() });
});

it.each(['pending', 'running'] as const)('prevents changing selection while a task is %s', async status => {
  await connect();
  await repository.transact(data => { data.runs.run = run(status); });
  const subject = runtime();
  await expect(save(subject)).rejects.toMatchObject({ code: 'AI_MODEL_BUSY', status: 409 });
  expect(await repository.read()).toMatchObject({ revision: 1, aiModel: null });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('allows changing selection after tasks finish', async () => {
  await connect();
  await repository.transact(data => { data.runs.run = run('succeeded'); });
  expect((await save(runtime())).selection).toEqual(selection());
});

it('rechecks OAuth credentials inside the save transaction', async () => {
  await connect();
  const subject = runtime();
  expect((await subject.configuration()).providers[0]?.oauthConnected).toBe(true);
  const transact = repository.transact.bind(repository);
  vi.spyOn(repository, 'transact').mockImplementation(async fn => {
    await credentials.delete('openai');
    return transact(fn);
  });
  await expect(save(subject)).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  expect(await repository.read()).toMatchObject({ revision: 0, aiModel: null });
});

it('validates queueing against the supplied transaction draft without nested reads and rolls back rejection', async () => {
  const subject = runtime();
  await expect(repository.transact(async data => {
    data.receipts.test = { hash: 'test', result: null, createdAt: '2026-01-01T00:00:00.000Z' };
    await subject.assertCanQueue(data);
  })).rejects.toBeInstanceOf(DomainError);
  expect(await repository.read()).toMatchObject({ revision: 0, receipts: {} });
  await connect();
  await repository.transact(async data => {
    data.aiModel = selection();
    await subject.assertCanQueue(data);
  });
  expect((await repository.read()).aiModel).toEqual(selection());
  expect(engineFactory).not.toHaveBeenCalled();
});

it('captures each task selection anew and forwards signal/onUsage without creating a shared engine', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  const firstOptions = { ...options(), onProgress: vi.fn(), onUsage: vi.fn(async () => undefined) };
  expect(await subject.execute(task, firstOptions)).toEqual(response);
  expect(engineExecute).toHaveBeenLastCalledWith(task, firstOptions);
  expect(engineExecute.mock.calls[0]?.[1]).toBe(firstOptions);
  expect(firstOptions.onUsage).toHaveBeenCalledExactlyOnceWith(response.usage);
  expect(engineFactory).toHaveBeenLastCalledWith({ mode: 'live', provider: 'openai', model: selection().modelId,
    connectionPolicy: 'pooled', authMethod: 'oauth', allowUnboundedOAuthOutput: true, maxOutputTokens: config().maxOutputTokens, timeoutMs: config().runTimeoutMs, firstResponseTimeoutMs: config().firstResponseTimeoutMs, streamIdleTimeoutMs: config().streamIdleTimeoutMs, cacheRetention: 'none' }, expect.objectContaining({ credentials }));
  await save(subject, selection('openai', 1));
  await subject.execute(task, options());
  expect(engineFactory.mock.calls.map(([input]) => input?.model)).toEqual([selection().modelId, selection('openai', 1).modelId]);
  expect(engineFactory).toHaveBeenCalledTimes(2);
  expect(engineExecute).toHaveBeenCalledTimes(2);
});

it('holds a task snapshot immutable while a later selection is saved', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  let started!: () => void;
  const executing = new Promise<void>(resolve => { started = resolve; });
  let complete!: (result: AiResponse) => void;
  engineExecute.mockImplementationOnce(async () => {
    started();
    return new Promise<AiResponse>(resolve => { complete = resolve; });
  });
  const inFlight = subject.execute(task, options());
  await executing;
  // Direct engine calls do not create runs; the host owns pending/running records.
  await save(subject, selection('openai', 1));
  complete(response);
  await inFlight;
  await subject.execute(task, options());
  expect(engineFactory.mock.calls[0]?.[0]?.model).toBe(selection().modelId);
  expect(engineFactory.mock.calls[1]?.[0]?.model).toBe(selection('openai', 1).modelId);
});

it('rejects revoked credentials for new queueing and execution without falling back or retrying', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  await credentials.delete('openai');
  expect(await subject.configuration()).toMatchObject({ source: 'saved', ready: false });
  await expect(subject.assertCanQueue(await repository.read())).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  await expect(subject.execute(task, options())).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('checks cancellation before constructing an engine, including cancellation during credential checks', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(subject.execute(task, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
  const controller = new AbortController();
  const read = credentials.read.bind(credentials);
  vi.spyOn(credentials, 'read').mockImplementation(async (...args) => {
    controller.abort();
    return read(...args);
  });
  await expect(subject.execute(task, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('propagates model errors and usage options without retries', async () => {
  await connect();
  const subject = runtime();
  await save(subject);
  const error = new Error('test engine failure');
  engineExecute.mockRejectedValueOnce(error);
  await expect(subject.execute(task, options())).rejects.toBe(error);
  expect(engineExecute).toHaveBeenCalledTimes(1);
  expect(engineFactory).toHaveBeenCalledTimes(1);
});

it('keeps mock independent and faux-only, while candidate saving still requires authorization and acknowledgement', async () => {
  await repository.close();
  repository = await openRepository(':memory:', 'mock');
  const subject = runtime({ mode: 'mock', provider: 'openai', apiKey: 'secret-test-config-key', dailyBudgetUsd: 3 });
  expect(await subject.configuration()).toMatchObject({ mode: 'mock', ready: true, problem: null, selection: null });
  await subject.assertCanQueue(await repository.read());
  await subject.execute(task, options());
  await expect(save(subject)).rejects.toMatchObject({ code: 'AI_MODEL_UNAUTHORIZED' });
  await connect();
  await expect(save(subject, { ...selection(), allowUnboundedOutput: false })).rejects.toMatchObject({ code: 'AI_OUTPUT_ACK_REQUIRED' });
  expect((await save(subject)).selection).toEqual(selection());
  await credentials.delete('openai');
  expect((await subject.configuration()).ready).toBe(true);
  await subject.assertCanQueue(await repository.read());
  await subject.execute(task, options());
  for (const args of engineFactory.mock.calls) {
    expect(args).toEqual([{ mode: 'mock', maxOutputTokens: config().maxOutputTokens, timeoutMs: config().runTimeoutMs, firstResponseTimeoutMs: config().firstResponseTimeoutMs, streamIdleTimeoutMs: config().streamIdleTimeoutMs }]);
  }
  const liveRepository = await openRepository(':memory:', 'live');
  try { expect((await runtime({}, credentials, liveRepository).configuration()).selection).toBeNull(); }
  finally { await liveRepository.close(); }
});

it('binds connection tests to the consented saved OAuth model and rechecks the binding at execution', async () => {
  await connect(); const subject = runtime(); const chosen = selection(); await save(subject, chosen);
  const probe: AiTask = { kind: 'connection_test', selection: chosen };
  expect(await subject.assertConnectionTest(await repository.read(), 'openai', chosen)).toEqual(chosen);
  engineExecute.mockResolvedValueOnce({ output: { kind: 'connection_test', ok: true }, usage: response.usage });
  expect((await subject.execute(probe, options())).output).toEqual({ kind: 'connection_test', ok: true });
  expect(engineFactory).toHaveBeenCalledTimes(1);
  await save(subject, selection('openai', 1));
  await expect(subject.execute(probe, options())).rejects.toMatchObject({ code: 'AI_TEST_MODEL_CHANGED' });
  expect(engineFactory).toHaveBeenCalledTimes(1);
  await expect(runtime({ mode: 'mock' }).execute(probe, options())).rejects.toMatchObject({ code: 'AI_TEST_LIVE_REQUIRED' });
});

it('does not test an API key under the name of an OAuth connection', async () => {
  await connect(); const subject = runtime({ provider: 'openai', apiKey: 'test-server-key' });
  const chosen = { ...selection(), authMethod: 'api_key' as const }; await save(subject, chosen);
  await expect(subject.assertConnectionTest(await repository.read(), 'openai', chosen)).rejects.toMatchObject({ code: 'AI_TEST_OAUTH_REQUIRED' });
  expect(engineFactory).not.toHaveBeenCalled();
});

it('accepts old schema-v1 snapshots without adding a default choice', async () => {
  const legacy = emptyData('live');
  delete legacy.aiModel;
  await repository.replace(legacy);
  const subject = runtime();
  expect(await subject.configuration()).toMatchObject({ source: 'none', selection: null, ready: false });
  expect(await repository.read()).not.toHaveProperty('aiModel');
  await connect();
  expect((await save(subject)).source).toBe('saved');
});

it('persists the non-secret selection across a temporary database reopen and backup restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-ai-runtime-test-'));
  let disk: Repository | undefined;
  try {
    await connect();
    disk = await openRepository(directory, 'live');
    const subject = runtime({}, credentials, disk);
    await subject.save({ ...selection(), expectedRevision: 0 });
    const backup = await disk.read();
    expect(JSON.stringify(backup)).not.toContain('secret-test');
    await disk.close();
    disk = await openRepository(directory, 'live');
    expect(await runtime({}, credentials, disk).configuration()).toMatchObject({ source: 'saved', revision: 1, selection: selection() });
    await repository.replace(backup);
    expect((await runtime().configuration()).selection).toEqual(selection());
  } finally {
    await disk?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('passes task-specific deadlines and stream limits to each engine', async () => {
  await connect(); const subject = runtime(); await save(subject);
  for (const [input, deadline] of [
    [task, 60_000],
    [{ kind: 'quiz', points: [], sources: [], count: 1 }, 120_000],
    [{ kind: 'connection_test', selection: selection() }, 30_000],
  ] as [AiTask, number][]) {
    await subject.execute(input, options());
    expect(engineFactory.mock.calls.at(-1)?.[0]).toMatchObject({ timeoutMs: deadline, firstResponseTimeoutMs: 60_000, streamIdleTimeoutMs: 45_000 });
  }
});
