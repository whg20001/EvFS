import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import { openAccounts } from '../src/accounts.ts';
import { createGatewayApp } from '../src/gateway-app.ts';
import { readConfig } from '../src/config.ts';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-gateway-'));
  const accounts = await openAccounts(directory);
  const stores = new Map<string, InMemoryCredentialStore>();
  const config = readConfig({ SESSION_SECRET: 'gateway-test-session-secret-'.repeat(3), AI_MODE: 'mock' });
  const gateway = await createGatewayApp({ config, accounts, accessFactory: async user => {
    const store = new InMemoryCredentialStore(); stores.set(user.id, store);
    return createAiAccessController({ credentials: store, deviceId: randomUUID() });
  } });
  resources.push(async () => { await gateway.app.close(); await accounts.close(); await rm(directory, { recursive: true, force: true }); });
  async function register(username: string) {
    const response = await gateway.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'private-test-password' }, headers: { origin: config.appOrigin } });
    expect(response.statusCode).toBe(200);
    return { user: response.json().user as { id: string; username: string }, headers: { cookie: String(response.headers['set-cookie']).split(';')[0]!, origin: config.appOrigin, 'x-csrf-token': response.json().csrfToken as string } };
  }
  return { ...gateway, accounts, config, register, stores, directory };
}
it('provides stable multi-user identities without exposing password material or a server learning API', async () => {
  const { app, accounts, register } = await fixture();
  const alice = await register('Alice'); const bob = await register('bob');
  expect(alice.user.id).not.toBe(bob.user.id); expect(alice.user.username).toBe('alice');
  const status = await app.inject({ url: '/api/auth/status', headers: alice.headers });
  expect(status.json()).toMatchObject({ authenticated: true, storage: 'browser', user: alice.user });
  expect(status.body).not.toMatch(/password|salt|hash/);
  expect((await app.inject({ url: '/api/state', headers: alice.headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/recitations', headers: alice.headers, payload: { learned: 'PRIVATE_LOCAL_NOTE' } })).statusCode).toBe(404);
  expect(await accounts.inspect()).toEqual({ accounts: [alice.user, bob.user], calls: [] });
  const duplicate = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ALICE', password: 'another-test-password' } });
  expect(duplicate.statusCode).toBe(409);
  const failed = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'incorrect-test-password' } });
  expect(failed.statusCode).toBe(401);
});
it('scopes OAuth credentials to accounts and protects gateway operations with login, origin and CSRF', async () => {
  const { app, register, stores, config } = await fixture();
  const alice = await register('alice'); const bob = await register('bob');
  expect((await app.inject({ url: '/api/gateway/bootstrap' })).statusCode).toBe(401);
  for (const user of [alice, bob]) {
    const response = await app.inject({ url: '/api/gateway/bootstrap', headers: user.headers });
    expect(response.statusCode).toBe(200); expect(response.json().user).toEqual(user.user);
    expect(response.body).not.toContain(config.sessionSecret);
  }
  await stores.get(alice.user.id)!.modify('anthropic', async () => ({ type: 'oauth', access: 'private-alice-token', refresh: 'private-alice-refresh', expires: Date.now() + 3_600_000 }));
  const a = await app.inject({ url: '/api/ai/access', headers: alice.headers });
  const b = await app.inject({ url: '/api/ai/access', headers: bob.headers });
  expect(a.json().providers.find((item: { id: string }) => item.id === 'anthropic').connected).toBe(true);
  expect(b.json().providers.find((item: { id: string }) => item.id === 'anthropic').connected).toBe(false);
  expect(a.body).not.toContain('private-alice');
  expect((await app.inject({ method: 'POST', url: '/api/gateway/execute', headers: { cookie: alice.headers.cookie }, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/gateway/execute', headers: { ...alice.headers, origin: 'https://evil.invalid' }, payload: {} })).statusCode).toBe(403);
});
it('streams an explicit task once and retains only accounting metadata, including after account-store restart', async () => {
  const { app, accounts, register, directory } = await fixture(); const alice = await register('alice');
  const task = { kind: 'extract' as const, recitation: { learned: 'PRIVATE_GATEWAY_TASK 独立回忆', unclear: '', application: '', topic: '' }, sources: [{ id: 'recitation:test', name: '本次复述', text: 'PRIVATE_GATEWAY_TASK 独立回忆' }] };
  const key = randomUUID(); const headers = { ...alice.headers, 'idempotency-key': key };
  const payload = { task, selection: null, expectedPrompt: describeLearningPrompt(task) };
  const response = await app.inject({ method: 'POST', url: '/api/gateway/execute', headers, payload });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  const events = response.body.trim().split('\n').map(line => JSON.parse(line) as { type: string; data: unknown });
  expect(events.find(event => event.type === 'result')?.data).toMatchObject({ output: { kind: 'extract' } });
  const duplicate = await app.inject({ method: 'POST', url: '/api/gateway/execute', headers, payload });
  expect(duplicate.statusCode).toBe(409);
  const records = await accounts.inspect(); expect(records.calls).toHaveLength(1);
  expect(records.calls[0]).toMatchObject({ account_id: alice.user.id, status: 'succeeded' });
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE_GATEWAY_TASK|独立回忆|private-test-password|candidates/);
  // A second store on the directory is rejected rather than silently forking identity/accounting.
  await expect(openAccounts(directory)).rejects.toThrow();
});
it('persists salted account hashes and rejects repeated request IDs after restarting the cloud account store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-accounts-'));
  let accounts = await openAccounts(directory);
  try {
    const alice = await accounts.register('alice', 'persisted-test-password');
    await accounts.begin({ accountId: alice.id, requestId: 'durable-request', hash: 'opaque-hmac', day: '2026-10-26', provider: 'faux', model: 'mock', maxDailyCalls: 2, dailyBudget: null, reservation: 0 });
    await accounts.close(); accounts = await openAccounts(directory); await accounts.recover();
    expect(await accounts.authenticate('alice', 'persisted-test-password')).toEqual(alice);
    expect((await accounts.inspect()).calls[0]).toMatchObject({ status: 'failed' });
    await expect(accounts.begin({ accountId: alice.id, requestId: 'durable-request', hash: 'opaque-hmac', day: '2026-10-27', provider: 'faux', model: 'mock', maxDailyCalls: 2, dailyBudget: null, reservation: 0 })).rejects.toMatchObject({ code: 'GATEWAY_ALREADY_STARTED' });
  } finally { await accounts.close(); await rm(directory, { recursive: true, force: true }); }
});
it('enforces concurrency, daily calls and unknown-cost reservations on the cloud account ledger', async () => {
  const { accounts, register } = await fixture(); const alice = await register('alice'); const bob = await register('bob');
  const input = { accountId: alice.user.id, requestId: 'request-one', hash: 'opaque-hmac', day: '2026-10-26', provider: 'faux', model: 'mock', maxDailyCalls: 10, dailyBudget: 1, reservation: 0.6 };
  await accounts.begin(input);
  await expect(accounts.begin({ ...input, requestId: 'request-two', day: '2026-10-27' })).rejects.toMatchObject({ code: 'GATEWAY_BUSY' });
  await accounts.begin({ ...input, accountId: bob.user.id });
  await accounts.finish(alice.user.id, input.requestId, 'failed', null);
  await expect(accounts.begin({ ...input, requestId: 'request-two' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await expect(accounts.begin({ ...input, requestId: 'request-two', dailyBudget: null, maxDailyCalls: 1 })).rejects.toMatchObject({ code: 'REQUEST_LIMIT' });
  expect((await accounts.inspect()).calls).toHaveLength(2);
});
