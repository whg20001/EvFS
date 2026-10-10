import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { createAiAccessController, type AiAccessController } from './service.ts';
import { LIVE_PROVIDER_IDS, createExplicitProvider } from './providers.ts';
import type { OAuthSessionView } from '@sanxing/contracts';

const credential: OAuthCredential = { type: 'oauth', access: 'PRIVATE-TOKEN', refresh: 'PRIVATE-REFRESH', expires: Number.MAX_SAFE_INTEGER, clientId: 'client', scopes: ['direct'], extra: { keep: true } };
const controllers: AiAccessController[] = [];
afterEach(async () => { vi.useRealTimers(); for (const c of controllers.splice(0)) await c.close(); vi.unstubAllEnvs(); });
function fake(id: string, login: OAuthAuth['login']): Provider {
  return { id, name: id, getModels: () => [], auth: { oauth: { name: id, login, refresh: async c => c, toAuth: async c => ({ apiKey: c.access }) } },
    stream: () => { throw new Error('not used'); }, streamSimple: () => { throw new Error('not used'); } };
}
function controller(providers: Provider[], flowTtlMs?: number, closeStorage?: () => Promise<void>) {
  const c = createAiAccessController({ providers, flowTtlMs, closeStorage, credentials: new InMemoryCredentialStore(), deviceId: randomUUID() });
  controllers.push(c); return c;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function view(c: AiAccessController, owner = 'owner', id = 'anthropic') { return (await c.providers(owner)).find(p => p.id === id)!.session!; }
async function until(c: AiAccessController, check: (v: OAuthSessionView) => boolean, id = 'anthropic') {
  for (let i = 0; i < 100; i++) { const v = await view(c, 'owner', id); if (check(v)) return v; await new Promise<void>(r => setImmediate(r)); }
  throw new Error('flow did not reach expected state');
}

describe('Pi Models.login bridge (offline fake providers)', () => {
  it('registers only the explicit providers', () => {
    expect(LIVE_PROVIDER_IDS.map(id => createExplicitProvider(id).id)).toEqual(['openai', 'anthropic', 'openai-codex', 'xai']);
  });
  it('forwards select IDs, auth_url and manual_code then commits complete credentials', async () => {
    let deviceId: string | undefined;
    const c = controller([fake('anthropic', async (i, options) => {
      deviceId = options?.getDeviceId?.();
      expect(await i.prompt({ type: 'select', message: 'Method', options: [{ id: 'copy_code', label: 'Copy code' }, { id: 'browser', label: 'Browser' }] })).toBe('copy_code');
      i.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=temporary', instructions: 'UPSTREAM-TEXT' });
      expect(await i.prompt({ type: 'manual_code', message: 'Code', placeholder: 'code#state' })).toBe('code#state');
      return credential;
    })]);
    await c.start('anthropic', 'owner');
    let v = await until(c, v => v.input?.type === 'select');
    expect(v.input?.options?.map(o => o.id)).toEqual(['copy_code', 'browser']);
    await expect(c.submit(v.id, v.input!.id, 'Copy code', 'owner')).rejects.toMatchObject({ code: 'input' });
    await c.submit(v.id, v.input!.id, 'copy_code', 'owner');
    v = await until(c, v => v.input?.type === 'manual_code');
    expect(v.url).toContain('https://claude.ai/');
    expect(v.instructions).not.toContain('UPSTREAM-TEXT');
    await c.submit(v.id, v.input!.id, 'code#state', 'owner');
    v = await until(c, v => v.status === 'succeeded');
    expect(await c.credentials.read('anthropic')).toEqual(credential);
    expect(deviceId).toMatch(/^[\da-f-]{36}$/);
    expect(v).toMatchObject({ url: null, instructions: null, input: null, error: null });
    const metadata = (await c.providers('owner'))[0]!;
    expect(metadata).toMatchObject({ connected: true, expiresAt: null });
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE');
    expect((await c.cancel(v.id, 'owner')).status).toBe('succeeded');
  });
  it('shows device_code without inventing an input prompt', async () => {
    const gate = deferred<OAuthCredential>();
    const c = controller([fake('openai-codex', async i => { i.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.openai.com/codex/device' }); return gate.promise; })]);
    await c.start('openai-codex', 'owner');
    const v = await until(c, v => v.status === 'waiting', 'openai-codex');
    expect(v.input).toBeNull(); expect(v.instructions).toContain('ABCD-1234');
    gate.resolve(credential); await until(c, v => v.status === 'succeeded', 'openai-codex');
  });
  it.each([['https://accounts.x.ai/device?user_code=WXYZ-9876', 'succeeded'], ['https://auth.openai.com/codex/device', 'failed']] as const)('xAI device_code accepts only xAI hosts: %s', async (verificationUri, status) => {
    const gate = deferred<OAuthCredential>();
    const c = controller([fake('xai', async i => { i.notify({ type: 'device_code', userCode: 'WXYZ-9876', verificationUri }); return gate.promise; })]);
    await c.start('xai', 'owner');
    if (status === 'succeeded') {
      const v = await until(c, v => v.status === 'waiting', 'xai');
      expect(v).toMatchObject({ url: verificationUri, input: null }); expect(v.instructions).toContain('WXYZ-9876');
      gate.resolve(credential);
    }
    await until(c, v => v.status === status, 'xai');
    expect(await c.credentials.read('xai')).toEqual(status === 'succeeded' ? credential : undefined);
  });
  it('isolates owners, enforces a single global flow, reuses only same owner/provider', async () => {
    const login: OAuthAuth['login'] = i => i.prompt({ type: 'manual_code', message: 'Code' }).then(() => credential);
    const c = controller([fake('anthropic', login), fake('openai-codex', login)]);
    const [first, again] = await Promise.all([c.start('anthropic', 'owner'), c.start('anthropic', 'owner')]);
    expect(again.id).toBe(first.id);
    expect((await c.providers('other'))[0]!.session).toBeNull();
    await expect(c.start('anthropic', 'other')).rejects.toMatchObject({ code: 'busy', status: 409 });
    await expect(c.start('openai-codex', 'owner')).rejects.toMatchObject({ code: 'busy' });
    await expect(c.cancel(first.id, 'other')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(c.submit(first.id, 'irrelevant', 'secret', 'other')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(c.cancel('nonexistent', 'other')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
  it('validates prompt IDs, lengths, options and nonempty input; consumes each prompt once', async () => {
    const gate = deferred<OAuthCredential>();
    const c = controller([fake('anthropic', async i => {
      await i.prompt({ type: 'secret', message: 'Code' }); return gate.promise;
    })]);
    await c.start('anthropic', 'owner'); const v = await until(c, v => !!v.input);
    await expect(c.submit(v.id, 'wrong', 'x', 'owner')).rejects.toMatchObject({ code: 'input' });
    await expect(c.submit(v.id, v.input!.id, ' ', 'owner')).rejects.toMatchObject({ code: 'input' });
    await expect(c.submit(v.id, v.input!.id, 'x'.repeat(16_385), 'owner')).rejects.toMatchObject({ code: 'input' });
    await c.submit(v.id, v.input!.id, 'x', 'owner');
    await expect(c.submit(v.id, v.input!.id, 'x', 'owner')).rejects.toMatchObject({ code: 'input' });
    gate.resolve(credential);
  });
  it('allows empty text, but never automatically chooses a method', async () => {
    const c = controller([fake('anthropic', async i => {
      expect(await i.prompt({ type: 'text', message: 'Optional' })).toBe(''); return credential;
    })]);
    await c.start('anthropic', 'owner'); const v = await until(c, v => !!v.input);
    expect(v.input!.allowEmpty).toBe(true);
    await c.submit(v.id, v.input!.id, '', 'owner'); await until(c, v => v.status === 'succeeded');
  });
  it('requires OpenAI full final callback URL, not just a code', async () => {
    const c = controller([fake('openai', async i => { await i.prompt({ type: 'manual_code', message: 'URL' }); return credential; })]);
    await c.start('openai', 'owner'); const v = await until(c, v => !!v.input, 'openai');
    await expect(c.submit(v.id, v.input!.id, 'code-only', 'owner')).rejects.toMatchObject({ code: 'input' });
    await c.submit(v.id, v.input!.id, 'http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=id', 'owner');
    await until(c, v => v.status === 'succeeded', 'openai');
  });
  it.each(['cancel', 'disconnect', 'cancelOwner'] as const)('%s prevents late uncooperative login from reviving credentials', async action => {
    const gate = deferred<OAuthCredential>(); let signal: AbortSignal | undefined;
    const c = controller([fake('anthropic', async i => { signal = i.signal; return gate.promise; })]);
    const v = await c.start('anthropic', 'owner');
    if (action === 'cancel') await c.cancel(v.id, 'owner');
    else if (action === 'disconnect') await c.disconnect('anthropic');
    else await c.cancelOwner('owner');
    expect(signal!.aborted).toBe(true); gate.resolve(credential);
    await new Promise<void>(r => setImmediate(r));
    expect(await c.credentials.read('anthropic')).toBeUndefined();
  });
  it('expires pending prompts and never persists late successes', async () => {
    vi.useFakeTimers(); const gate = deferred<OAuthCredential>(); let signal: AbortSignal | undefined;
    const c = controller([fake('anthropic', async i => { signal = i.signal; return gate.promise; })], 50);
    await c.start('anthropic', 'owner'); await vi.advanceTimersByTimeAsync(51);
    expect((await view(c)).status).toBe('expired'); expect(signal!.aborted).toBe(true);
    gate.resolve(credential); await vi.advanceTimersByTimeAsync(1);
    expect(await c.credentials.read('anthropic')).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds expiry by the website session and refuses already expired owners', async () => {
    vi.useFakeTimers(); const rejected = vi.fn();
    const c = controller([fake('anthropic', async i => {
      await i.prompt({ type: 'manual_code', message: 'Code' }).catch(error => { rejected(); throw error; });
      return credential;
    })], 1000);
    await expect(c.start('anthropic', 'owner', Date.now() - 1)).rejects.toMatchObject({ code: 'owner_expired', status: 401 });
    const deadline = Date.now() + 50;
    const v = await c.start('anthropic', 'owner', deadline);
    expect(v.expiresAt).toBe(new Date(deadline).toISOString());
    await c.providers('owner'); await vi.advanceTimersByTimeAsync(51);
    expect((await view(c)).status).toBe('expired'); expect(rejected).toHaveBeenCalledOnce();
    expect(await c.credentials.read('anthropic')).toBeUndefined();
  });
  it('may shorten but never extend an existing owner deadline on repeated start', async () => {
    vi.useFakeTimers();
    const c = controller([fake('anthropic', async () => new Promise<OAuthCredential>(() => {}))], 1000);
    const original = await c.start('anthropic', 'owner', Date.now() + 500);
    const shortened = await c.start('anthropic', 'owner', Date.now() + 20);
    const extended = await c.start('anthropic', 'owner', Date.now() + 800);
    expect(shortened.id).toBe(original.id); expect(extended.expiresAt).toBe(shortened.expiresAt);
    await vi.advanceTimersByTimeAsync(21); expect((await view(c)).status).toBe('expired');
  });
  it('only reports success after persistence, serializes disconnect behind committed login', async () => {
    const store = new InMemoryCredentialStore(); const entered = deferred<void>(); const release = deferred<void>();
    const c = createAiAccessController({ deviceId: randomUUID(), providers: [fake('anthropic', async () => credential)],
      credentials: { read: store.read.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
        modify: async (id, fn) => { entered.resolve(); await release.promise; return store.modify(id, fn); } } });
    controllers.push(c); await c.start('anthropic', 'owner'); await entered.promise;
    let disconnected = false;
    const disconnect = c.disconnect('anthropic').then(() => { disconnected = true; });
    await Promise.resolve(); expect(disconnected).toBe(false);
    expect(await store.read('anthropic')).toBeUndefined();
    release.resolve(); await disconnect;
    expect(await store.read('anthropic')).toBeUndefined();
    expect((await view(c)).status).toBe('succeeded');
  });
  it('rechecks owner expiry after waiting for the credential-store lock', async () => {
    vi.useFakeTimers(); const store = new InMemoryCredentialStore();
    const entered = deferred<void>(); const release = deferred<void>();
    const c = createAiAccessController({ deviceId: randomUUID(), providers: [fake('anthropic', async () => credential)],
      credentials: { read: store.read.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
        modify: async (id, fn) => { entered.resolve(); await release.promise; return store.modify(id, fn); } } });
    controllers.push(c);
    await c.start('anthropic', 'owner', Date.now() + 10); await entered.promise;
    await vi.advanceTimersByTimeAsync(11); release.resolve();
    expect((await view(c)).status).toBe('expired');
    expect(await store.read('anthropic')).toBeUndefined();
  });
  it('does not report success on failed storage commit and hides its error', async () => {
    const store = new InMemoryCredentialStore();
    const c = createAiAccessController({ deviceId: randomUUID(), providers: [fake('anthropic', async () => credential)],
      credentials: { read: store.read.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
        modify: async () => { throw new Error('PRIVATE-TOKEN filesystem path'); } } });
    controllers.push(c); await c.start('anthropic', 'owner');
    const v = await until(c, v => v.status === 'failed');
    expect(v.error).toBe('授权未完成，请重试。'); expect(await store.read('anthropic')).toBeUndefined();
  });
  it('replaces terminal records per provider and never exposes previous owner data', async () => {
    const c = controller([fake('anthropic', async () => credential)]);
    const first = await c.start('anthropic', 'owner'); await until(c, v => v.status === 'succeeded');
    await c.start('anthropic', 'other');
    expect((await c.providers('owner'))[0]!.session).toBeNull();
    await expect(c.cancel(first.id, 'owner')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('honors prompt.signal when an out-of-band callback wins', async () => {
    const callback = new AbortController(); const gate = deferred<OAuthCredential>(); const rejected = vi.fn();
    const c = controller([fake('anthropic', async i => {
      void i.prompt({ type: 'manual_code', message: 'Paste', signal: callback.signal }).catch(rejected);
      return gate.promise;
    })]);
    await c.start('anthropic', 'owner'); const v = await until(c, v => !!v.input);
    callback.abort(); await until(c, v => v.input === null);
    expect(rejected).toHaveBeenCalledOnce();
    await expect(c.submit(v.id, v.input!.id, 'stale', 'owner')).rejects.toMatchObject({ code: 'input' });
    gate.resolve(credential); await until(c, v => v.status === 'succeeded');
  });
  it('redacts provider errors and ignores arbitrary progress/info', async () => {
    const c = controller([fake('anthropic', async i => {
      i.notify({ type: 'progress', message: 'PRIVATE-TOKEN' });
      i.notify({ type: 'info', message: 'PRIVATE-REFRESH', links: [{ url: 'https://evil.example' }] });
      throw new Error('PRIVATE-TOKEN response with secret');
    })]);
    await c.start('anthropic', 'owner'); const v = await until(c, v => v.status === 'failed');
    expect(v.error).toBe('授权未完成，请重试。'); expect(JSON.stringify(v)).not.toContain('PRIVATE');
  });
  it.each(['http://auth.openai.com/oauth', 'https://evil.example/oauth', 'https://user:password@auth.openai.com/oauth', 'https://auth.openai.com:444/oauth'])('fails unsafe notify URL without throwing from notify: %s', async url => {
    let notified = false;
    const c = controller([fake('openai-codex', async i => { i.notify({ type: 'auth_url', url }); notified = true; return credential; })]);
    await c.start('openai-codex', 'owner'); const v = await until(c, v => v.status === 'failed', 'openai-codex');
    expect(notified).toBe(true); expect(v.url).toBeNull(); expect(await c.credentials.read('openai-codex')).toBeUndefined();
  });
  it('rejects ambient endpoint, proxy and callback overrides before provider login', async () => {
    const login = vi.fn(async () => credential); const c = controller([fake('anthropic', login)]);
    for (const name of ['OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'PI_OAUTH_CALLBACK_HOST', 'https_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      vi.stubEnv(name, 'unsafe'); await expect(c.start('anthropic', 'owner')).rejects.toMatchObject({ code: 'unsafe' }); vi.unstubAllEnvs();
    }
    expect(login).not.toHaveBeenCalled();
  });
  it('close aborts and rejects pending prompts, removes timers, never waits for uncooperative provider', async () => {
    vi.useFakeTimers(); const rejected = vi.fn(); let interaction: ProviderAuthInteraction | undefined; const closed = vi.fn(async () => {});
    const c = controller([fake('anthropic', async i => {
      interaction = i; void i.prompt({ type: 'manual_code', message: 'Paste' }).catch(rejected);
      return new Promise<OAuthCredential>(() => {});
    })], 1000, closed);
    await c.start('anthropic', 'owner'); await c.providers('owner');
    await c.close(); await c.close();
    expect(interaction!.signal.aborted).toBe(true); expect(rejected).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); await expect(c.start('anthropic', 'owner')).rejects.toMatchObject({ code: 'closed' });
  });
});
