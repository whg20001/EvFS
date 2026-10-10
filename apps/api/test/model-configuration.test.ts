import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import { openRepository } from '@sanxing/database';
import type { AiModelConfiguration, AiResponse, AiTask, CommandResult } from '@sanxing/contracts';
import { AiModelRuntime } from '../src/ai-runtime.ts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const password = 'model-settings-test-password';
const config = readConfig({ AI_MODE: 'live', OWNER_PASSWORD: password, SESSION_SECRET: 'model-settings-test-secret-'.repeat(3) });
let repository: Awaited<ReturnType<typeof openRepository>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let cookie: string; let csrf: string;
const execute = vi.fn<(task: AiTask) => Promise<AiResponse>>();
const get = (url: string) => instance.app.inject({ url, headers: { cookie } });
const write = (url: string, body: object, method: 'POST' | 'PUT' = 'POST', key = randomUUID()) => instance.app.inject({ method, url, headers: { cookie, origin: config.appOrigin, 'x-csrf-token': csrf, 'idempotency-key': key }, payload: body });
const settings = async () => (await get('/api/ai/configuration')).json<AiModelConfiguration>();
async function choice() {
  const data = await settings(); const provider = data.providers.find(p => p.id === 'openai-codex')!;
  return { expectedRevision: data.revision, providerId: provider.id, modelId: provider.models[0]!.id, authMethod: 'oauth' as const, allowUnboundedOutput: true };
}
async function draft() {
  const created = (await write('/api/recitations', {})).json<CommandResult>();
  expect((await write(`/api/recitations/${created.id}/draft`, { version: 1, learned: '用于离线 HTTP 集成验证的复述。', unclear: '', application: '', topic: '测试' }, 'PUT')).statusCode).toBe(200);
  return created.id!;
}
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real provider network forbidden'); }));
  execute.mockReset();
  execute.mockImplementation(async task => {
    if (task.kind !== 'extract') throw new Error('Unexpected offline test task');
    return { output: { kind: 'extract', candidates: [{ title: '离线验证', description: '仅测试宿主运行器接线', sourceIds: [task.sources[0]!.id] }] }, usage: { provider: 'offline-test', model: 'offline-test', inputTokens: 10, outputTokens: 4, cost: null } };
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: 'offline-access-secret', refresh: 'offline-refresh-secret', expires: Date.now() + 3_600_000 }));
  const access = createAiAccessController({ credentials, deviceId: randomUUID() });
  repository = await openRepository(':memory:', 'live');
  const runtime = new AiModelRuntime({ config, repository, credentials, engineFactory: () => ({ mode: 'live', execute: task => execute(task) }) });
  instance = await createApp({ config, repository, engine: runtime, modelRuntime: runtime, aiAccess: access, startWorker: false });
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.appOrigin }, payload: { password } });
  expect(login.statusCode).toBe(200); cookie = String(login.headers['set-cookie']).split(';')[0]!; csrf = login.json().csrfToken;
});
afterEach(async () => { await instance?.app.close(); await repository?.close(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

it('serves a live setup page without model/budget and rolls back submissions until a model is selected', async () => {
  expect((await get('/api/auth/status')).statusCode).toBe(200);
  const data = await settings(); expect(data).toMatchObject({ mode: 'live', selection: null, ready: false, budget: { enabled: false, dailyUsd: null, reservationUsd: null } });
  expect(data.problem).toContain('配置');
  const id = await draft(); const response = await write(`/api/recitations/${id}/submit`, { version: 2 });
  expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.json().error.message).toContain('配置');
  const snapshot = await repository.read(); expect(snapshot.runs).toEqual({}); expect(snapshot.sessions).toEqual({}); expect(snapshot.recitations[id]!.learned).toContain('离线');
  expect(execute).not.toHaveBeenCalled();
});
it('protects model selection and requires an explicit output-limit acknowledgement without exposing credentials', async () => {
  expect((await instance.app.inject({ url: '/api/ai/configuration' })).statusCode).toBe(401);
  const selection = await choice();
  expect((await instance.app.inject({ method: 'POST', url: '/api/ai/configuration', headers: { cookie, origin: config.appOrigin }, payload: selection })).statusCode).toBe(403);
  expect((await write('/api/ai/configuration', { ...selection, apiKey: 'UNEXPECTED_SECRET_FIELD' })).statusCode).toBe(400);
  expect((await write('/api/ai/configuration', { ...selection, allowUnboundedOutput: false })).statusCode).toBeGreaterThanOrEqual(400);
  expect((await repository.read()).aiModel).toBeNull();
  const key = randomUUID(); const saved = await write('/api/ai/configuration', selection, 'POST', key);
  expect(saved.statusCode).toBe(200); expect((await write('/api/ai/configuration', selection, 'POST', key)).json()).toEqual(saved.json());
  expect(saved.json()).toMatchObject({ ready: true, source: 'saved', selection: { providerId: 'openai-codex', modelId: selection.modelId }, budget: { enabled: false } });
  expect(JSON.stringify(await settings())).not.toContain('offline-access-secret'); expect(JSON.stringify(await repository.read())).not.toContain('offline-refresh-secret');
  expect(execute).not.toHaveBeenCalled();
  expect((await write('/api/ai/configuration', selection)).statusCode).toBe(409);
});
it('uses saved configuration for a new task and refuses model changes while that task is running', async () => {
  expect((await write('/api/ai/configuration', await choice())).statusCode).toBe(200);
  let release!: () => void;
  const implementation = execute.getMockImplementation()!;
  execute.mockImplementation(async task => { await new Promise<void>(resolve => { release = resolve; }); return implementation(task); });
  const id = await draft(); const submitted = await write(`/api/recitations/${id}/submit`, { version: 2 }); expect(submitted.statusCode).toBe(202);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  const current = await choice(); expect((await write('/api/ai/configuration', current)).statusCode).toBe(409);
  release(); await instance.worker.tick();
  const snapshot = await repository.read(); const run = snapshot.runs[submitted.json<CommandResult>().runId!]!;
  expect(run.status).toBe('succeeded'); expect(run.reservationUsd).toBe(0); expect(run.usage?.cost).toBeNull();
  expect((await write('/api/ai/configuration', await choice())).statusCode).toBe(200);
});
