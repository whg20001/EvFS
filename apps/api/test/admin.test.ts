import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import type { createLearningEngine } from '@sanxing/learning-agent';
import type { AdminUser, PlatformAiView } from '@sanxing/contracts';
import { openAccounts } from '../src/accounts.ts';
import { createGatewayApp } from '../src/gateway-app.ts';
import { readConfig } from '../src/config.ts';
import { PLATFORM_SELECTION, PlatformAi } from '../src/platform-ai.ts';

const resources: (() => Promise<void>)[] = [];
const password = 'existing-admin-test-password';
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function fixture(options: { mode?: 'mock' | 'live'; engineFactory?: typeof createLearningEngine } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-admin-')); const accounts = await openAccounts(directory);
  await accounts.register('admin', password);
  const config = readConfig({ SESSION_SECRET: 'admin-test-only-session-secret-'.repeat(3), ADMIN_USERNAMES: 'admin', AI_MODE: options.mode ?? 'mock', AUTH_REGISTRATIONS_PER_15_MIN: '100' });
  const { app } = await createGatewayApp({ config, accounts, engineFactory: options.engineFactory, accessFactory: async () => createAiAccessController({ credentials: new InMemoryCredentialStore(), deviceId: randomUUID() }) });
  resources.push(async () => { await app.close(); await accounts.close(); await rm(directory, { recursive: true, force: true }); });
  const login = async (username: string, secret = password, register = false) => {
    const response = await app.inject({ method: 'POST', url: `/api/auth/${register ? 'register' : 'login'}`, payload: { username, password: secret } });
    expect(response.statusCode).toBe(200);
    return { user: response.json().user as { id: string; username: string; role?: string }, headers: { cookie: String(response.headers['set-cookie']).split(';')[0]!, origin: config.appOrigin, 'x-csrf-token': response.json().csrfToken as string } };
  };
  const admin = await login('admin');
  const users = async () => (await app.inject({ url: '/api/admin/users', headers: admin.headers })).json().items as AdminUser[];
  const update = async (user: AdminUser, patch: object) => app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: admin.headers, payload: { role: user.role, status: user.status, dailyLimit: user.dailyLimit, platformAccess: user.platformAccess, expectedVersion: user.version, ...patch } });
  const platform = async () => (await app.inject({ url: '/api/admin/platform-ai', headers: admin.headers })).json() as PlatformAiView;
  const settings = (view: PlatformAiView) => ({ enabled: true, label: '测试平台 AI', providerId: 'openai', modelId: view.providers.find(provider => provider.id === 'openai')!.models.find(model => model.id === 'gpt-4.1-mini')!.id,
    perUserDailyCalls: 2, globalDailyCalls: 4, maxConcurrent: 1, expectedRevision: view.revision });
  return { app, accounts, directory, config, admin, login, users, update, platform, settings };
}
it('binds only an existing administrator, keeps its password and never promotes a future matching registrant', async () => {
  const { app, accounts, admin } = await fixture();
  expect(admin.user.role).toBe('admin'); expect(await accounts.authenticate('admin', password)).toEqual(admin.user);
  expect((await app.inject({ url: '/api/auth/status', headers: admin.headers })).body).not.toMatch(/password|salt|auth_version/);
  await accounts.bootstrapAdmins(['future-admin']);
  const future = await accounts.register('future-admin', password);
  expect(future.role).toBeUndefined();
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-no-admin-')); const empty = await openAccounts(directory);
  try { await empty.bootstrapAdmins(['admin']); await empty.register('admin', password); expect((await empty.authenticate('admin', password)).role).toBeUndefined(); }
  finally { await empty.close(); await rm(directory, { recursive: true, force: true }); }
});
it('protects every admin read and write with role, cookie, origin and CSRF checks', async () => {
  const { app, admin, login } = await fixture(); const alice = await login('alice', password, true);
  for (const path of ['overview', 'users', 'activity', 'metrics', 'platform-ai']) {
    expect((await app.inject({ url: `/api/admin/${path}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/admin/${path}`, headers: alice.headers })).statusCode).toBe(403);
    const response = await app.inject({ url: `/api/admin/${path}`, headers: admin.headers }); expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers: alice.headers, payload: { username: 'evil', password } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: admin.headers.cookie }, payload: { username: 'test', password } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { ...admin.headers, origin: 'https://evil.invalid' }, payload: { username: 'test', password } })).statusCode).toBe(403);
});
it('manages users with version checks, revokes sessions and protects the current and last active administrator', async () => {
  const { app, accounts, admin, login, users, update } = await fixture(); const alice = await login('alice', password, true);
  const alice2 = await login('alice'); let row = (await users()).find(user => user.username === 'alice')!;
  expect((await update(row, { status: 'disabled' })).statusCode).toBe(200);
  for (const session of [alice, alice2]) expect((await app.inject({ url: '/api/gateway/catalog', headers: session.headers })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password } })).statusCode).toBe(403);
  expect((await update(row, { status: 'active' })).statusCode).toBe(409);
  row = (await users()).find(user => user.username === 'alice')!;
  expect((await update(row, { status: 'active', newPassword: 'replacement-private-password', dailyLimit: 3, platformAccess: false })).statusCode).toBe(200);
  await expect(accounts.authenticate('alice', password)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  await login('alice', 'replacement-private-password');
  const own = (await users()).find(user => user.id === admin.user.id)!;
  expect((await update(own, { role: 'user' })).statusCode).toBe(409);
  await expect(accounts.updateUser(alice.user.id, own.id, { role: 'user', status: 'active', platformAccess: true, dailyLimit: null, expectedVersion: own.version })).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  const body = (await app.inject({ url: '/api/admin/activity', headers: admin.headers })).body;
  expect(body).toContain('reset_password'); expect(body).not.toMatch(/replacement-private-password|existing-admin-test-password|password_hash|salt/);
});
it('accepts only fixed activity metadata and returns real aggregates, pagination and bounded server samples', async () => {
  const { app, admin, login } = await fixture(); const alice = await login('alice', password, true);
  for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'POST', url: '/api/activity/heartbeat', headers: alice.headers, payload: { module: 'recite' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/activity/heartbeat', headers: alice.headers, payload: { module: 'recite', note: 'PRIVATE_LOCAL_NOTE' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/activity/heartbeat', headers: alice.headers, payload: { module: '/knowledge/private-id' } })).statusCode).toBe(400);
  const overview = await app.inject({ url: '/api/admin/overview', headers: admin.headers });
  expect(overview.json()).toMatchObject({ users: 2, onlineUsers: 2, activeToday: 2, callsToday: 0, mode: 'mock' }); expect(overview.json().series).toHaveLength(14);
  const activity = (await app.inject({ url: '/api/admin/activity?search=alice&pageSize=1', headers: admin.headers })).json(); expect(activity.total).toBe(2); expect(activity.items).toHaveLength(1);
  const users = (await app.inject({ url: '/api/admin/users?search=alice', headers: admin.headers })).json(); expect(users.total).toBe(1); expect(users.items[0]).toMatchObject({ username: 'alice', online: true, lastModule: 'recite' });
  const metrics = (await app.inject({ url: '/api/admin/metrics', headers: admin.headers })).json(); expect(metrics.cpuCores).toBeGreaterThan(0); expect(metrics.totalMemoryBytes).toBeGreaterThan(0); expect(metrics.processRssBytes).toBeGreaterThan(0); expect(metrics.history.length).toBeLessThanOrEqual(180);
});
it('encrypts platform keys, masks every response, preserves them on ordinary saves and rejects conflicting revisions', async () => {
  const { app, accounts, admin, platform, settings } = await fixture({ mode: 'live' }); const view = await platform(); const secret = 'PRIVATE_PLATFORM_KEY_no_real_calls';
  const payload = { ...settings(view), apiKey: secret };
  const saved = await app.inject({ method: 'PUT', url: '/api/admin/platform-ai', headers: admin.headers, payload });
  expect(saved.statusCode, saved.body).toBe(200); expect(saved.json()).toMatchObject({ keyConfigured: true, keySource: 'saved', revision: 1 }); expect(saved.body).not.toContain(secret);
  const record = await accounts.platform(); expect(record?.encryptedKey).toBeTruthy(); expect(JSON.stringify(record)).not.toContain(secret);
  expect((await app.inject({ method: 'PUT', url: '/api/admin/platform-ai', headers: admin.headers, payload })).statusCode).toBe(409);
  const edited = await app.inject({ method: 'PUT', url: '/api/admin/platform-ai', headers: admin.headers, payload: { ...settings(saved.json()), label: '新的服务名称' } }); expect(edited.statusCode).toBe(200); expect(edited.json().keyConfigured).toBe(true);
  const clearing = await app.inject({ method: 'PUT', url: '/api/admin/platform-ai', headers: admin.headers, payload: { ...settings(edited.json()), enabled: false, clearKey: true } }); expect(clearing.statusCode).toBe(200); expect(clearing.json().keyConfigured).toBe(false);
});
it('resolves an explicit platform choice on the server, isolates personal credentials and enforces platform quotas', async () => {
  const engines: Parameters<typeof createLearningEngine>[0][] = [];
  const engineFactory: typeof createLearningEngine = input => { engines.push(input); return { mode: 'live', async execute() { return { output: { kind: 'extract', candidates: [{ title: '回忆', description: '合上笔记回忆。', sourceIds: ['recitation:test'] }] }, usage: { provider: 'openai', model: 'gpt-4.1-mini', inputTokens: 20, outputTokens: 10, cost: 0.01 } }; } }; };
  const { app, accounts, admin, login, platform, settings, users, update } = await fixture({ mode: 'live', engineFactory }); const alice = await login('alice', password, true);
  const secret = 'PRIVATE_PLATFORM_KEY_for_stub_engine'; const saved = await app.inject({ method: 'PUT', url: '/api/admin/platform-ai', headers: admin.headers, payload: { ...settings(await platform()), apiKey: secret } }); expect(saved.statusCode, saved.body).toBe(200); expect(engines).toHaveLength(0);
  const catalog = await app.inject({ url: '/api/gateway/catalog', headers: alice.headers }); expect(catalog.json().platform.available).toBe(true); expect(catalog.body).not.toContain(secret); expect(catalog.json().providers.find((provider: { id: string }) => provider.id === 'openai').apiKeyAvailable).toBe(false);
  const check = (selection: object) => app.inject({ method: 'POST', url: '/api/gateway/selection/check', headers: alice.headers, payload: selection });
  expect((await check(PLATFORM_SELECTION)).statusCode).toBe(200);
  expect((await check({ ...PLATFORM_SELECTION, authMethod: 'api_key' })).statusCode).toBe(400);
  expect((await check({ ...PLATFORM_SELECTION, providerId: 'openai', modelId: 'gpt-4.1-mini', authMethod: 'api_key' })).statusCode).toBe(400);
  const task = { kind: 'extract', recitation: { learned: 'PRIVATE_LOCAL_LEARNING 合上笔记回忆', unclear: '', application: '', topic: '' }, sources: [{ id: 'recitation:test', name: '本次复述', text: 'PRIVATE_LOCAL_LEARNING 合上笔记回忆' }] };
  const execute = () => app.inject({ method: 'POST', url: '/api/gateway/execute', headers: { ...alice.headers, 'idempotency-key': randomUUID() }, payload: { task, selection: PLATFORM_SELECTION } });
  for (let i = 0; i < 2; i++) { const response = await execute(); expect(response.statusCode, response.body).toBe(200); expect(response.body).toContain('"type":"result"'); }
  expect((await execute()).statusCode).toBe(429); expect(engines).toHaveLength(2); expect(engines[0]).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini', authMethod: 'api_key', apiKey: secret });
  const records = await accounts.inspect(); expect(records.calls).toHaveLength(2); expect(records.calls[0]).toMatchObject({ source: 'platform', provider: 'openai', model: 'gpt-4.1-mini', status: 'succeeded' }); expect(JSON.stringify(records)).not.toContain('PRIVATE_LOCAL_LEARNING');
  const overview = (await app.inject({ url: '/api/admin/overview', headers: admin.headers })).json(); expect(overview).toMatchObject({ callsToday: 2, platformCallsToday: 2, inputTokens: 40, outputTokens: 20, knownUsageCalls: 2 });
  const aliceRow = (await users()).find(user => user.username === 'alice')!; expect((await update(aliceRow, { platformAccess: false })).statusCode).toBe(200);
  const relogged = await login('alice'); expect((await app.inject({ method: 'POST', url: '/api/gateway/selection/check', headers: relogged.headers, payload: PLATFORM_SELECTION })).statusCode).toBe(403);
});

it('retains encrypted platform configuration and administrator identity across a store restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-platform-restart-')); let accounts = await openAccounts(directory);
  const config = readConfig({ AI_MODE: 'live', SESSION_SECRET: 'persistent-platform-key-test-secret-'.repeat(3) });
  try {
    const admin = await accounts.register('admin', password); await accounts.bootstrapAdmins(['admin']);
    let platform = new PlatformAi(accounts, config); const view = await platform.view();
    await platform.save(admin.id, { enabled: true, label: '持久平台', providerId: 'openai', modelId: view.providers.find(provider => provider.id === 'openai')!.models[0]!.id,
      perUserDailyCalls: 3, globalDailyCalls: 10, maxConcurrent: 2, expectedRevision: 0, apiKey: 'persistent-private-platform-key' });
    await accounts.close(); accounts = await openAccounts(directory); platform = new PlatformAi(accounts, config);
    expect((await accounts.authenticate('admin', password)).role).toBe('admin');
    expect(await platform.view()).toMatchObject({ revision: 1, label: '持久平台', enabled: true, keyConfigured: true });
    expect((await platform.resolve(admin.id, PLATFORM_SELECTION)).config.apiKey).toBe('persistent-private-platform-key');
    const changedSecret = new PlatformAi(accounts, { ...config, sessionSecret: 'different-test-secret-'.repeat(3) });
    await expect(changedSecret.resolve(admin.id, PLATFORM_SELECTION)).rejects.toMatchObject({ code: 'PLATFORM_KEY_UNAVAILABLE' });
  } finally { await accounts.close(); await rm(directory, { recursive: true, force: true }); }
});

it('serializes platform admission across users, enforces the global limit and rejects revoked session versions', async () => {
  const { accounts, login, users, update } = await fixture(); const alice = await login('alice', password, true); const bob = await login('bob', password, true);
  const input = { accountId: alice.user.id, requestId: 'one', hash: 'accounting-only', day: '2026-10-26', provider: 'openai', model: 'gpt-4.1-mini', maxDailyCalls: 20, dailyBudget: null, reservation: 0,
    platform: { perUserDailyCalls: 5, globalDailyCalls: 2, maxConcurrent: 1 } };
  const admitted = await Promise.allSettled([accounts.begin(input), accounts.begin({ ...input, accountId: bob.user.id })]);
  expect(admitted.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(admitted[1]).toMatchObject({ status: 'rejected', reason: { code: 'PLATFORM_BUSY' } });
  await accounts.finish(alice.user.id, 'one', 'failed', null);
  await accounts.begin({ ...input, accountId: bob.user.id }); await accounts.finish(bob.user.id, 'one', 'succeeded', null);
  await expect(accounts.begin({ ...input, requestId: 'two' })).rejects.toMatchObject({ code: 'PLATFORM_DAILY_LIMIT' });
  const row = (await users()).find(user => user.username === 'alice')!; expect((await update(row, { newPassword: 'newly-reset-private-password' })).statusCode).toBe(200);
  await expect(accounts.begin({ ...input, platform: undefined, requestId: 'revoked-before-admission', authVersion: row.version })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
});
