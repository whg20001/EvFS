import { randomUUID } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AuthEvent, AuthInteraction, AuthPrompt, CredentialStore } from '@earendil-works/pi-ai';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import type { AiProviderView, OAuthSessionView } from '@sanxing/contracts';
import { AiAccessError } from './errors.ts';
import { createExplicitProvider, LIVE_PROVIDER_IDS, providerNotice, type LiveProviderId } from './providers.ts';
import { assertOfficialEnvironment, isolatedAuthContext, officialURL, safeExpiry } from './safety.ts';
import { copyOAuth, openCredentialVault } from './vault.ts';

export interface AiAccessController {
  readonly credentials: CredentialStore;
  providers(ownerSessionId: string): Promise<AiProviderView[]>;
  start(providerId: string, ownerSessionId: string, ownerExpiresAt?: number): Promise<OAuthSessionView>;
  submit(flowId: string, promptId: string, value: string, ownerSessionId: string): Promise<OAuthSessionView>;
  cancel(flowId: string, ownerSessionId: string): Promise<OAuthSessionView>;
  disconnect(providerId: string): Promise<void>;
  cancelOwner(ownerSessionId: string): Promise<void>;
  close(): Promise<void>;
}
interface Pending {
  id: string; resolve(value: string): void; reject(error: Error): void; cleanup(): void;
}
interface Flow {
  owner: string; view: OAuthSessionView; abort: AbortController;
  deadline: number; timer?: ReturnType<typeof setTimeout>; pending?: Pending;
}
const terminal = (flow: Flow) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(flow.view.status);
const snapshot = (flow: Flow): OAuthSessionView => structuredClone(flow.view);
const bounded = (value: string | undefined) => (value ?? '').slice(0, 1000);

export function createAiAccessController(options: {
  credentials: CredentialStore; deviceId: string; providers?: readonly Provider[];
  flowTtlMs?: number; closeStorage?: () => Promise<void>;
}): AiAccessController {
  const ttl = options.flowTtlMs ?? 10 * 60_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 2_147_483_647) throw new AiAccessError('input');
  const definitions = options.providers ?? LIVE_PROVIDER_IDS.map(createExplicitProvider);
  const factories = new Map<string, () => Provider>();
  for (const p of definitions) {
    if (!LIVE_PROVIDER_IDS.includes(p.id as LiveProviderId) || factories.has(p.id) || !p.auth.oauth) throw new AiAccessError('provider');
    factories.set(p.id, options.providers ? () => ({ ...p, auth: { ...p.auth, oauth: { ...p.auth.oauth! } } }) : () => createExplicitProvider(p.id as LiveProviderId));
  }
  // At most one record per provider: terminal views never retain authorization URLs or prompts.
  const records = new Map<string, Flow>();
  let active: Flow | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = tail.then(fn); tail = result.catch(() => undefined); return result;
  }
  function requireOpen() { if (closing) throw new AiAccessError('closed', 503); }
  function requireProvider(id: string) {
    const factory = factories.get(id); if (!factory) throw new AiAccessError('provider', 404); return factory;
  }
  function getFlow(id: string, owner: string): Flow {
    const flow = [...records.values()].find(f => f.view.id === id && f.owner === owner);
    if (!flow) throw new AiAccessError('not_found', 404);
    return flow;
  }
  function clearPrompt(flow: Flow, error?: Error, value?: string) {
    const pending = flow.pending;
    flow.pending = undefined; flow.view.input = null;
    if (pending) { pending.cleanup(); if (error) pending.reject(error); else pending.resolve(value!); }
  }
  function finish(flow: Flow, status: 'succeeded' | 'cancelled' | 'expired' | 'failed', error: string | null = null) {
    if (terminal(flow)) return;
    flow.view.status = status; flow.view.error = error;
    flow.view.url = null; flow.view.instructions = null;
    clearTimeout(flow.timer); flow.timer = undefined;
    clearPrompt(flow, new AiAccessError('failed'));
    flow.abort.abort();
    if (active === flow) active = undefined;
  }
  function usable(flow: Flow): boolean {
    if (terminal(flow)) return false;
    if (Date.now() >= flow.deadline) { finish(flow, 'expired'); return false; }
    return active === flow && !flow.abort.signal.aborted && !closing;
  }
  function notify(flow: Flow, event: AuthEvent) {
    // notify is synchronous in Pi: never throw into provider cleanup code.
    void mutate(() => {
      if (!usable(flow)) return;
      try {
        if (event.type === 'auth_url') {
          flow.view.url = officialURL(event.url, flow.view.providerId);
          flow.view.instructions = '请在官方页面完成授权；如需手工输入，请按下方提示操作。';
          flow.view.status = 'waiting';
        } else if (event.type === 'device_code') {
          flow.view.url = officialURL(event.verificationUri, flow.view.providerId);
          if (typeof event.userCode !== 'string' || !/^[A-Za-z0-9 -]{1,128}$/.test(event.userCode)) throw new Error();
          flow.view.instructions = `请在官方页面输入设备码：${event.userCode}`;
          flow.view.status = 'waiting';
        } else if (event.type === 'progress' && event.message === 'Exchanging authorization code for tokens...') {
          flow.view.instructions = '正在完成授权。';
        }
        // No arbitrary info/progress text or links (which may contain upstream responses).
      } catch { finish(flow, 'failed', new AiAccessError('unsafe').message); }
    }).catch(() => undefined);
  }
  function prompt(flow: Flow, request: AuthPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      void mutate(() => {
        if (!usable(flow) || request.signal?.aborted) { reject(new AiAccessError('failed')); return; }
        if (flow.pending) { finish(flow, 'failed', new AiAccessError('failed').message); reject(new AiAccessError('failed')); return; }
        const id = randomUUID();
        const abort = () => { void mutate(() => {
          if (flow.pending?.id === id) {
            clearPrompt(flow, new AiAccessError('failed'));
            if (!terminal(flow)) flow.view.status = 'working';
          }
        }).catch(() => undefined); };
        flow.pending = { id, resolve, reject, cleanup: () => request.signal?.removeEventListener('abort', abort) };
        request.signal?.addEventListener('abort', abort, { once: true });
        flow.view.input = {
          id, type: request.type, label: bounded(request.message),
          placeholder: 'placeholder' in request ? bounded(request.placeholder) : '',
          allowEmpty: request.type === 'text',
          ...(request.type === 'select' ? { options: request.options.map(o => ({ id: o.id, label: bounded(o.label), ...(o.description ? { description: bounded(o.description) } : {}) })) } : {}),
        };
        flow.view.status = 'waiting';
      }).catch(() => { reject(new AiAccessError('failed')); });
    });
  }
  async function run(flow: Flow, factory: () => Provider) {
    try {
      // Every flow uses private temporary credentials, never the persistent vault.
      const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: isolatedAuthContext });
      models.setProvider(factory());
      const interaction: AuthInteraction = { signal: flow.abort.signal, notify: event => notify(flow, event), prompt: request => prompt(flow, request) };
      const result = await models.login(flow.view.providerId, 'oauth', interaction, { getDeviceId: () => options.deviceId });
      await mutate(async () => {
        if (!usable(flow) || records.get(flow.view.providerId) !== flow) return;
        const credential = copyOAuth(result);
        // This commit owns the same queue as cancellation/disconnection. A committed login is not rolled back by cancel.
        let committed = false;
        await options.credentials.modify(flow.view.providerId, async () => {
          // A SDK refresh may have held the vault lock while the owner's session expired.
          if (!usable(flow) || records.get(flow.view.providerId) !== flow) return undefined;
          committed = true;
          return credential;
        });
        if (committed) finish(flow, 'succeeded');
        else if (!terminal(flow)) finish(flow, 'cancelled');
      });
    } catch {
      await mutate(() => { if (!terminal(flow)) finish(flow, 'failed', new AiAccessError('failed').message); });
    }
  }
  return {
    credentials: options.credentials,
    providers: owner => mutate(async () => {
      requireOpen(); if (active) usable(active);
      const views: AiProviderView[] = [];
      for (const [id, factory] of factories) {
        let stored;
        try { stored = await options.credentials.read(id); } catch { throw new AiAccessError('storage', 500); }
        const flow = records.get(id);
        views.push({ id, name: factory().name, connected: stored?.type === 'oauth',
          expiresAt: stored?.type === 'oauth' ? safeExpiry(stored.expires) : null,
          oauthAvailable: true, session: flow?.owner === owner ? snapshot(flow) : null,
          notice: providerNotice(id as LiveProviderId) });
      }
      return views;
    }),
    start: (id, owner, ownerExpiresAt) => mutate(() => {
      requireOpen(); const factory = requireProvider(id);
      if (ownerExpiresAt !== undefined && (!Number.isFinite(ownerExpiresAt) || ownerExpiresAt <= Date.now())) {
        if (active?.owner === owner) finish(active, 'expired');
        throw new AiAccessError('owner_expired', 401);
      }
      if (active) usable(active);
      if (active) {
        if (active.owner === owner && active.view.providerId === id) {
          if (ownerExpiresAt !== undefined && ownerExpiresAt < active.deadline) {
            const flow = active;
            flow.deadline = ownerExpiresAt; flow.view.expiresAt = new Date(ownerExpiresAt).toISOString();
            clearTimeout(flow.timer);
            flow.timer = setTimeout(() => { void mutate(() => finish(flow, 'expired')).catch(() => undefined); }, Math.max(0, ownerExpiresAt - Date.now()));
            flow.timer.unref();
          }
          return snapshot(active);
        }
        throw new AiAccessError('busy', 409);
      }
      assertOfficialEnvironment();
      const deadline = Math.min(Date.now() + ttl, ownerExpiresAt ?? Infinity);
      const flow: Flow = { owner, abort: new AbortController(), deadline,
        view: { id: randomUUID(), providerId: id, status: 'starting', url: null, instructions: null, input: null, error: null, expiresAt: new Date(deadline).toISOString() } };
      records.set(id, flow); active = flow;
      flow.timer = setTimeout(() => { void mutate(() => finish(flow, 'expired')).catch(() => undefined); }, Math.max(0, deadline - Date.now()));
      flow.timer.unref();
      void run(flow, factory);
      return snapshot(flow);
    }),
    submit: (id, promptId, value, owner) => mutate(() => {
      requireOpen(); const flow = getFlow(id, owner);
      if (!usable(flow) || !flow.pending || flow.pending.id !== promptId || !flow.view.input) throw new AiAccessError('input', 409);
      const input = flow.view.input;
      if (typeof value !== 'string' || value.length > 16_384 || (!input.allowEmpty && !value.trim())
        || (input.type === 'select' && !input.options?.some(o => o.id === value))) throw new AiAccessError('input');
      if (flow.view.providerId === 'openai' && input.type === 'manual_code') {
        try {
          const url = new URL(value.trim());
          if (url.origin !== 'http://127.0.0.1:1455' || url.pathname !== '/auth/callback' || url.username || url.password
            || !url.searchParams.get('code') || !url.searchParams.get('state') || !url.searchParams.get('client_id')) throw new Error();
        } catch { throw new AiAccessError('input'); }
      }
      clearPrompt(flow, undefined, value); flow.view.status = 'working';
      return snapshot(flow);
    }),
    cancel: (id, owner) => mutate(() => { requireOpen(); const flow = getFlow(id, owner); finish(flow, 'cancelled'); return snapshot(flow); }),
    disconnect: id => mutate(async () => {
      requireOpen(); requireProvider(id);
      const flow = records.get(id); if (flow) finish(flow, 'cancelled');
      try { await options.credentials.delete(id); } catch { throw new AiAccessError('storage', 500); }
    }),
    cancelOwner: owner => mutate(() => {
      requireOpen();
      for (const [id, flow] of records) if (flow.owner === owner) { finish(flow, 'cancelled'); records.delete(id); }
    }),
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = mutate(async () => {
          for (const flow of records.values()) finish(flow, 'cancelled');
          records.clear();
          try { await options.closeStorage?.(); } catch { throw new AiAccessError('storage', 500); }
        });
      }
      return closePromise;
    },
  };
}

export async function openAiAccess(options: { directory: string; secret: string; flowTtlMs?: number }): Promise<AiAccessController> {
  const vault = await openCredentialVault(options);
  try { return createAiAccessController({ credentials: vault.credentials, deviceId: vault.deviceId, flowTtlMs: options.flowTtlMs, closeStorage: () => vault.close() }); }
  catch (error) { await vault.close(); throw error; }
}
