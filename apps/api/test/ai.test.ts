import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore, type Provider } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createAiAccessController } from '@sanxing/ai-access';
import { createLearningEngine } from '@sanxing/learning-agent';
import { openRepository } from '@sanxing/database';
import type { AgentRun, AiAccessOverview, AiModelConfiguration, OAuthSessionView, TokenUsageHeatmap } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const password = 'ai-http-test-password';
const callbackURL = 'http://127.0.0.1:1455/auth/callback?code=test-code&state=test-state&client_id=test-client';
const config = readConfig({ OWNER_PASSWORD: password, SESSION_SECRET: 'ai-http-test-secret-'.repeat(4), AI_MODE: 'mock', USER_TIMEZONE: 'UTC' });
let repository: Awaited<ReturnType<typeof openRepository>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let credentials: InMemoryCredentialStore;
type Owner = { cookie: string; csrf: string };
let owner: Owner;
async function login(): Promise<Owner> {
  const response = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.appOrigin }, payload: { password } });
  expect(response.statusCode).toBe(200);
  return { cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json<{ csrfToken: string }>().csrfToken };
}
const get = (url: string, identity = owner) => instance.app.inject({ url, headers: { cookie: identity.cookie } });
const post = (url: string, body: unknown = {}, identity = owner, key = randomUUID()) => instance.app.inject({ method: 'POST', url, headers: { cookie: identity.cookie, origin: config.appOrigin, 'x-csrf-token': identity.csrf, 'idempotency-key': key }, payload: body as object });
async function overview(identity = owner) { return (await get('/api/ai/access', identity)).json<AiAccessOverview>(); }
async function prompt(type: string) {
  let session: OAuthSessionView | null = null;
  await vi.waitFor(async () => { session = (await overview()).providers[0]!.session; expect(session?.input?.type).toBe(type); });
  return session! as OAuthSessionView;
}
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real OAuth/model network calls are forbidden in this test'); }));
  credentials = new InMemoryCredentialStore();
  const fake: Provider = { ...fauxProvider({ provider: 'openai', api: 'ai-auth-http-test' }).provider, auth: { oauth: {
    name: 'Test OAuth', refresh: async current => current, toAuth: async current => ({ apiKey: current.access }),
    async login(interaction) {
      await interaction.prompt({ type: 'select', message: '选择测试方式', options: [{ id: 'copy_code', label: '测试验证码' }] });
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/test-authorize?state=test-state' });
      const code = await interaction.prompt({ type: 'manual_code', message: '输入测试验证码' });
      if (code !== callbackURL) throw new Error('test-secret-access must never appear in a public error');
      return { type: 'oauth', access: 'test-secret-access', refresh: 'test-secret-refresh', expires: Date.now() + 3_600_000, clientId: 'test-secret-client' };
    },
  } } };
  const aiAccess = createAiAccessController({ credentials, deviceId: randomUUID(), providers: [fake] });
  repository = await openRepository(':memory:', 'mock');
  instance = await createApp({ config, repository, engine: createLearningEngine({ mode: 'mock' }), aiAccess, startWorker: false });
  await instance.app.ready(); owner = await login();
});
afterEach(async () => { await instance?.app.close(); await repository?.close(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

it('keeps live OAuth selection explicit and never lets a static key override it', () => {
  const env = { OWNER_PASSWORD: password, SESSION_SECRET: 'config-test-secret-'.repeat(4), AI_MODE: 'live', MODEL_PROVIDER: 'anthropic', MODEL_ID: 'explicit-model', MODEL_AUTH_METHOD: 'oauth', AI_BUDGET_PER_USER_DAY: '1', AI_REQUEST_RESERVATION_USD: '0.1' };
  expect(readConfig(env)).toMatchObject({ mode: 'live', modelAuthMethod: 'oauth', provider: 'anthropic', allowUnboundedOAuthOutput: false });
  expect(() => readConfig({ ...env, MODEL_API_KEY: 'must-not-override' })).toThrow(/Remove MODEL_API_KEY/);
  expect(() => readConfig({ ...env, MODEL_AUTH_METHOD: 'ambient' })).toThrow(/MODEL_AUTH_METHOD/);
  expect(() => readConfig({ ...env, MODEL_PROVIDER: 'not-registered' })).toThrow(/Unsupported/);
});

it('protects AI metadata, usage and OAuth actions with the existing owner session and CSRF', async () => {
  for (const url of ['/api/ai/access', '/api/ai/configuration', '/api/ai/usage']) expect((await instance.app.inject({ url })).statusCode).toBe(401);
  const denied = await instance.app.inject({ method: 'POST', url: '/api/ai/oauth/openai/start', headers: { cookie: owner.cookie, 'idempotency-key': randomUUID() }, payload: {} });
  expect(denied.statusCode).toBe(403);
  expect((await post('/api/ai/oauth/not-registered/start')).statusCode).toBeGreaterThanOrEqual(400);
  const response = await overview(); expect(response.mode).toBe('mock');
  expect((await get('/api/ai/configuration')).json<AiModelConfiguration>()).toMatchObject({ mode: 'mock', selection: null, budget: { enabled: false } });
});

it('bridges real Pi login prompts while never exposing credentials or another owner session flow', async () => {
  const key = randomUUID(); const first = await post('/api/ai/oauth/openai/start', {}, owner, key); expect(first.statusCode).toBe(200);
  expect((await post('/api/ai/oauth/openai/start', {}, owner, key)).json()).toEqual(first.json());
  const selection = await prompt('select'); const other = await login();
  expect((await overview(other)).providers[0]!.session).toBeNull();
  expect((await post(`/api/ai/oauth/sessions/${selection.id}/cancel`, {}, other)).statusCode).toBe(404);
  const wrong = await post(`/api/ai/oauth/sessions/${selection.id}/input`, { promptId: randomUUID(), value: 'copy_code' });
  expect([400, 409]).toContain(wrong.statusCode);
  expect((await post(`/api/ai/oauth/sessions/${selection.id}/input`, { promptId: selection.input!.id, value: 'copy_code' })).statusCode).toBe(200);
  const code = await prompt('manual_code'); expect(code.url).toMatch(/^https:\/\/auth\.openai\.com\//);
  expect((await post(`/api/ai/oauth/sessions/${code.id}/input`, { promptId: code.input!.id, value: callbackURL })).statusCode).toBe(200);
  await vi.waitFor(async () => expect((await overview()).providers[0]!.connected).toBe(true));
  expect(await credentials.read('openai')).toMatchObject({ access: 'test-secret-access', clientId: 'test-secret-client' });
  expect(JSON.stringify(await overview())).not.toContain('test-secret-');
  expect(JSON.stringify(await repository.read())).not.toContain('test-secret-');
  await post('/api/ai/providers/openai/disconnect'); expect(await credentials.read('openai')).toBeUndefined();
});

it('cancels pending provider authorization when the website owner logs out', async () => {
  await post('/api/ai/oauth/openai/start'); await prompt('select');
  expect((await post('/api/auth/logout')).statusCode).toBe(200);
  expect((await get('/api/ai/access')).statusCode).toBe(401);
  expect(await credentials.read('openai')).toBeUndefined();
  const newOwner = await login(); expect((await overview(newOwner)).providers[0]!.session).toBeNull();
});

it('returns aggregated usage only, including observed failed runs and explicit unknowns', async () => {
  const row = (id: string, usage: AgentRun['usage'], startedAt: string | null): AgentRun => ({ id, status: 'failed', task: { kind: 'extract', recitation: { learned: 'PRIVATE_LEARNING_SOURCE', unclear: '', application: '', topic: '' }, sources: [] }, sessionId: null, reviewSessionId: null, quizId: null, questionId: null, attempt: startedAt ? 1 : 0, attemptId: null, expectedVersion: 0, createdAt: '2026-01-02T00:00:00Z', startedAt, finishedAt: '2026-01-02T01:00:00Z', error: 'failed', usage, reservationUsd: 0, promptVersion: 'test' });
  await repository.transact(data => {
    data.runs.known = row('known', { provider: 'faux', model: 'test', inputTokens: 30, outputTokens: 10, cost: 0 }, '2026-01-02T00:00:00Z');
    data.runs.unknown = row('unknown', null, '2026-01-02T00:00:00Z');
    data.runs.blocked = row('blocked', null, null);
  });
  const response = await get('/api/ai/usage?year=2026'); expect(response.statusCode).toBe(200);
  const data = response.json<TokenUsageHeatmap>(); expect(data.mode).toBe('mock'); expect(data.days).toHaveLength(365);
  expect(data.totals).toMatchObject({ totalTokens: 40, attempts: 2, unknownUsageAttempts: 1 });
  expect(response.body).not.toContain('PRIVATE_LEARNING_SOURCE'); expect(response.body).not.toContain('test-secret-');
  expect((await get('/api/ai/usage?year=not-a-year')).statusCode).toBe(400);
});
