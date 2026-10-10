import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Provider, type OAuthCredential, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { AiTask } from '@sanxing/contracts';
import { unsafeEnvironmentKeys } from '@sanxing/ai-access/providers';

const probe = vi.hoisted(() => ({ provider: undefined as Provider | undefined }));
vi.mock('@sanxing/ai-access/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('@sanxing/ai-access/providers')>();
  return { ...actual, createExplicitProvider: (id: Parameters<typeof actual.createExplicitProvider>[0]) => probe.provider ?? actual.createExplicitProvider(id) };
});
import { createLearningEngine, prepareLearningRequest, type EngineConfig } from './index.ts';

const task: AiTask = { kind: 'extract', recitation: { learned: '测试知识', unclear: '', application: '', topic: '' }, sources: [{ id: 's1', name: '测试来源', text: '测试知识' }] };
const output = JSON.stringify({ kind: 'extract', candidates: [{ title: '测试知识', description: '测试范围', sourceIds: ['s1'] }] });
const connectionTask: AiTask = { kind: 'connection_test', selection: { providerId: 'openai', modelId: 'faux-1', authMethod: 'oauth', allowUnboundedOutput: true } };
const connectionOutput = '{"kind":"connection_test","ok":true}';
const credential = (): OAuthCredential => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3_600_000, clientId: 'test-client' });

beforeEach(() => {
  probe.provider = undefined;
  for (const name of unsafeEnvironmentKeys()) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function fixture(text = output, expires = Date.now() + 3_600_000, limits: Pick<EngineConfig, 'maxOutputTokens' | 'timeoutMs' | 'cacheRetention'> = {}, mutateFinal?: (message: AssistantMessage) => void, contextWindow?: number) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai', async () => ({ ...credential(), expires }));
  const handle = fauxProvider({ provider: 'openai', api: 'oauth-test-faux' });
  let receivedKey: string | undefined;
  let receivedOptions: SimpleStreamOptions | undefined;
  let receivedContext: TranscriptContext | undefined;
  handle.setResponses([(context, options) => { receivedContext = context; receivedOptions = options; receivedKey = options?.apiKey; return fauxAssistantMessage(text); }]);
  const refresh = vi.fn(async (current: OAuthCredential) => ({ ...current, access: 'test-refreshed', refresh: 'test-rotated', expires: Date.now() + 3_600_000 }));
  const streamSimple: Provider['streamSimple'] = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of handle.provider.streamSimple(model, context, options)) {
        if (event.type === 'done') mutateFinal?.(event.message);
        if (event.type === 'error') mutateFinal?.(event.error);
        stream.push(event);
      }
    })();
    return stream;
  };
  probe.provider = { ...handle.provider,
    getModels: () => handle.provider.getModels().map(model => contextWindow === undefined ? model : { ...model, contextWindow }),
    streamSimple, auth: { oauth: { name: 'Test OAuth', login: async () => credential(), refresh, toAuth: async value => ({ apiKey: value.access }) } } };
  const engine = createLearningEngine({ mode: 'live', provider: 'openai', model: handle.getModel().id, authMethod: 'oauth', allowUnboundedOAuthOutput: true, ...limits }, { credentials });
  return { engine, credentials, refresh, handle, key: () => receivedKey, options: () => receivedOptions, context: () => receivedContext };
}

describe('OAuth learning requests with explicit fake Provider and real Pi resolution', () => {
  it.each(['none', 'short'] as const)('rejects an unprepared token-overbudget task before credentials, refresh, stream or usage with %s caching', async cacheRetention => {
    const f = await fixture(output, Date.now() - 1000, { cacheRetention }, undefined, 8192);
    const read = vi.spyOn(f.credentials, 'read');
    const observed = vi.fn(async () => {});
    const large = { ...task, sources: [{ ...task.sources[0]!, text: '中文😀'.repeat(1500) }] };
    await expect(f.engine.execute(large, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', usage: null });
    expect(read).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.handle.state.callCount).toBe(0);
    expect(observed).not.toHaveBeenCalled();
    const prepared = prepareLearningRequest(large, { contextWindow: 8192, maxOutputTokens: 4096 });
    await f.engine.execute(prepared.task, { signal: new AbortController().signal });
    const sent = JSON.stringify(f.context());
    for (const block of prepared.blocks) expect(sent).toContain(JSON.stringify(block).slice(1, -1));
    expect(f.handle.state.callCount).toBe(1);
  });
  it.each(['none', 'short'] as const)('rejects insufficient fixed overhead before any credential read or provider request with %s caching', async cacheRetention => {
    const f = await fixture(output, Date.now() - 1000, { cacheRetention }, undefined, 4700);
    const read = vi.spyOn(f.credentials, 'read');
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', usage: null });
    expect(read).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.handle.state.callCount).toBe(0);
    expect(observed).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN, Infinity])('fails closed on invalid explicit model window %s', async window => {
    await expect(fixture(output, undefined, {}, undefined, window)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
  it.each(['none', 'short'] as const)('passes explicit %s cache options through live OAuth resolution without network', async cacheRetention => {
    const f = await fixture(output, undefined, { cacheRetention });
    await f.engine.execute(task, { signal: new AbortController().signal, cacheScope: 'c'.repeat(64) });
    expect(f.options()).toMatchObject({ cacheRetention, maxRetries: 0, maxTokens: 4096, apiKey: 'test-access' });
    expect(f.options()!.sessionId).toBe(cacheRetention === 'short' ? 'c'.repeat(64) : undefined);
    expect(f.options()!.env?.PI_CACHE_RETENTION).toBeUndefined();
    expect(f.handle.state.callCount).toBe(1);
    expect(JSON.stringify(f.context())).not.toContain('c'.repeat(64));
  });
  it('rejects malformed cache affinity before reading or refreshing OAuth credentials', async () => {
    const f = await fixture(output, Date.now() - 1000, { cacheRetention: 'short' });
    const read = vi.spyOn(f.credentials, 'read');
    await expect(f.engine.execute(task, { signal: new AbortController().signal, cacheScope: 'x'.repeat(65) })).rejects.toMatchObject({ code: 'INVALID_TASK', usage: null });
    expect(read).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.handle.state.callCount).toBe(0);
  });
  it('uses the application store instead of a static key and rejects calls after disconnect', async () => {
    const f = await fixture(); const observed = vi.fn(async () => {});
    const result = await f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed });
    expect(f.key()).toBe('test-access'); expect(observed).toHaveBeenCalledWith(result.usage); expect(result.usage!.cost).toBeNull();
    await f.credentials.delete('openai');
    await expect(f.engine.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_NOT_AUTHORIZED' });
    expect(f.handle.state.callCount).toBe(1);
  });
  it('lets Pi rotate and persist OAuth credentials before the model request', async () => {
    const f = await fixture(output, Date.now() - 1000);
    await f.engine.execute(task, { signal: new AbortController().signal });
    expect(f.refresh).toHaveBeenCalledTimes(1); expect(f.key()).toBe('test-refreshed');
    expect(await f.credentials.read('openai')).toMatchObject({ refresh: 'test-rotated', clientId: 'test-client' });
  });
  it.each(['openai', 'openai-codex'] as const)('requires explicit acceptance of the %s OAuth output-limit restriction', provider => {
    expect(() => createLearningEngine({ mode: 'live', provider, model: 'unused', authMethod: 'oauth' }, { credentials: new InMemoryCredentialStore() })).toThrow(/上游输出/);
  });
  it('xAI OAuth keeps max_output_tokens, so it needs no unbounded-output acknowledgement', () => {
    expect(() => createLearningEngine({ mode: 'live', provider: 'xai', model: 'unused', authMethod: 'oauth' }, { credentials: new InMemoryCredentialStore() })).toThrow(/不存在指定聊天模型/);
  });
  it('runs a capped connection probe through explicit OAuth resolution and persists refresh before sending', async () => {
    const f = await fixture(connectionOutput, Date.now() - 1000, { maxOutputTokens: 4096, timeoutMs: 120_000, cacheRetention: 'short' });
    const observed = vi.fn(async () => {});
    const read = vi.spyOn(f.credentials, 'read');
    const signal = new AbortController().signal;
    const result = await f.engine.execute(connectionTask, { signal, onUsage: observed, cacheScope: 'probe-must-not-send' });
    expect(result.output).toEqual({ kind: 'connection_test', ok: true });
    expect(result.usage).toMatchObject({ provider: 'openai', model: 'faux-1', cost: null });
    expect(result.usage!.inputTokens).toBeGreaterThan(0);
    expect(result.usage!.outputTokens).toBeGreaterThan(0);
    expect(observed).toHaveBeenCalledExactlyOnceWith(result.usage);
    expect(read).toHaveBeenCalledWith('openai', { signal });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.key()).toBe('test-refreshed');
    expect(await f.credentials.read('openai')).toMatchObject({ refresh: 'test-rotated', clientId: 'test-client' });
    expect(f.handle.state.callCount).toBe(1);
    expect(f.options()).toMatchObject({ maxTokens: 256, timeoutMs: 30_000, maxRetries: 0, cacheRetention: 'none' });
    expect(f.options()!.sessionId).toBeUndefined();
    expect(f.options()!.signal).toBeInstanceOf(AbortSignal);
    const context = JSON.stringify(f.context());
    expect(context.length).toBeLessThan(600);
    for (const forbidden of ['selection', 'openai', 'faux-1', 'test-access', 'test-refreshed', '测试知识', '测试来源', 'candidates', 'rubric', '$schema']) expect(context).not.toContain(forbidden);
    await f.credentials.delete('openai');
    await expect(f.engine.execute(connectionTask, { signal })).rejects.toMatchObject({ code: 'MODEL_NOT_AUTHORIZED', usage: null });
    expect(f.handle.state.callCount).toBe(1);
  });
  it('accounts for a malformed connection response without retrying OAuth or model requests', async () => {
    const f = await fixture('{"kind":"connection_test","ok":true,"response":"anything"}', Date.now() - 1000);
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(connectionTask, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'INVALID_OUTPUT', usage: { provider: 'openai' } });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.handle.state.callCount).toBe(1);
    expect(f.options()).toMatchObject({ maxRetries: 0 });
  });
  it('does not finish a connection test until observed usage has been delivered', async () => {
    const f = await fixture(connectionOutput);
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    const result = f.engine.execute(connectionTask, { signal: new AbortController().signal, onUsage: async () => { entered(); await persisted; } });
    void result.then(() => { finished = true; });
    await ready;
    expect(finished).toBe(false);
    release();
    await expect(result).resolves.toMatchObject({ output: { kind: 'connection_test', ok: true } });
  });
  it('uses the explicit API key for a connection probe without reading an OAuth store', async () => {
    const handle = fauxProvider({ provider: 'openai', api: 'api-key-test-faux' });
    const received = vi.fn((_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
      expect(options).toMatchObject({ apiKey: 'explicit-test-key', maxTokens: 256, maxRetries: 0 });
      return fauxAssistantMessage(connectionOutput);
    });
    handle.setResponses([received]);
    probe.provider = handle.provider;
    const credentials = new InMemoryCredentialStore();
    const read = vi.spyOn(credentials, 'read');
    const engine = createLearningEngine({ mode: 'live', provider: 'openai', model: handle.getModel().id, apiKey: 'explicit-test-key' }, { credentials });
    await expect(engine.execute({ ...connectionTask, selection: { ...connectionTask.selection, authMethod: 'api_key', allowUnboundedOutput: false } }, { signal: new AbortController().signal })).resolves.toMatchObject({ output: { kind: 'connection_test', ok: true } });
    expect(read).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(1);
  });
  it('never lets an API key silently override OAuth', () => {
    expect(() => createLearningEngine({ mode: 'live', provider: 'openai', model: 'unused', authMethod: 'oauth', apiKey: 'do-not-use' }, { credentials: new InMemoryCredentialStore() })).toThrow(/不能同时/);
  });
  it('reports observed usage even when the business output is malformed', async () => {
    const f = await fixture('not JSON'); const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'INVALID_OUTPUT', usage: { provider: 'openai' } });
    expect(observed).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'zero', 'negative', 'nonfinite', 'fractional'] as const)('accepts valid output with unknown %s live usage without synthesizing or delivering zeros', async kind => {
    for (const [input, text] of [[task, output], [connectionTask, connectionOutput]] as const) {
      const f = await fixture(text, undefined, {}, message => {
        if (kind === 'missing') Reflect.deleteProperty(message, 'usage');
        else if (kind === 'zero') Object.assign(message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        else message.usage.input = kind === 'negative' ? -1 : kind === 'nonfinite' ? Number.NaN : 0.5;
      });
      const observed = vi.fn(async () => {});
      const result = await f.engine.execute(input, { signal: new AbortController().signal, onUsage: observed });
      expect(result).toEqual({ output: JSON.parse(text), usage: null });
      expect(observed).not.toHaveBeenCalled();
      expect(f.handle.state.callCount).toBe(1);
    }
  });
  it.each(['cacheRead', 'cacheWrite'] as const)('does not synthesize zero for absent or invalid %s counters', async field => {
    for (const value of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const f = await fixture(output, undefined, {}, message => { Object.assign(message.usage, { [field]: value }); });
      const observed = vi.fn(async () => {});
      await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).resolves.toMatchObject({ usage: null });
      expect(observed).not.toHaveBeenCalled();
    }
  });
  it('rejects unsafe aggregate usage without losing a valid business response', async () => {
    const f = await fixture(output, undefined, {}, message => {
      Object.assign(message.usage, { input: Number.MAX_SAFE_INTEGER, cacheRead: 1, cacheWrite: 0 });
    });
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).resolves.toMatchObject({ usage: null });
    expect(observed).not.toHaveBeenCalled();
  });
  it.each([
    { input: 0, cacheRead: 7, cacheWrite: 2, total: 9 },
    { input: 11, cacheRead: 0, cacheWrite: 0, total: 11 },
  ])('preserves measured zero cache counters and counts cached input exactly once: %j', async ({ input, cacheRead, cacheWrite, total }) => {
    const f = await fixture(output, undefined, {}, message => {
      Object.assign(message.usage, { input, output: 3, cacheRead, cacheWrite });
    });
    const observed = vi.fn(async () => {});
    const usage = { provider: 'openai', model: 'faux-1', inputTokens: total, outputTokens: 3,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, cost: null };
    const result = await f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed });
    expect(result.usage).toEqual(usage);
    expect(observed).toHaveBeenCalledExactlyOnceWith(usage);
  });
  it('retains known usage and cost on successful and invalid output', async () => {
    for (const text of [output, 'not JSON']) {
      const f = await fixture(text, undefined, {}, message => {
        Object.assign(message.usage, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 });
        message.usage.cost.total = 0.25;
      });
      const observed = vi.fn(async () => {});
      const usage = { provider: 'openai', model: 'faux-1', inputTokens: 16, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, cost: 0.25 };
      const result = f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed });
      if (text === output) await expect(result).resolves.toMatchObject({ usage });
      else await expect(result).rejects.toMatchObject({ code: 'INVALID_OUTPUT', usage });
      expect(observed).toHaveBeenCalledExactlyOnceWith(usage);
      expect(f.handle.state.callCount).toBe(1);
    }
  });
  it.each(['error', 'aborted', 'length'] as const)('retains trusted usage on terminal %s failure', async stopReason => {
    const f = await fixture(output, undefined, {}, message => { message.stopReason = stopReason; });
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({
      code: stopReason === 'aborted' ? 'CANCELLED' : 'MODEL_FAILED', usage: { provider: 'openai' },
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(f.handle.state.callCount).toBe(1);
  });
  it('does not let missing usage bypass JSON validation', async () => {
    const f = await fixture('not JSON', undefined, {}, message => { Reflect.deleteProperty(message, 'usage'); });
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'INVALID_OUTPUT', usage: null });
    expect(observed).not.toHaveBeenCalled();
  });
  it('keeps output token checks when usage is available', async () => {
    const f = await fixture(output, undefined, {}, message => { message.usage.output = 4097; });
    const observed = vi.fn(async () => {});
    await expect(f.engine.execute(task, { signal: new AbortController().signal, onUsage: observed })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', usage: { outputTokens: 4097 } });
    expect(observed).toHaveBeenCalledTimes(1);
  });
  it('keeps the output character limit even without usage', async () => {
    const f = await fixture(output, undefined, {}, message => {
      Reflect.deleteProperty(message, 'usage');
      message.content = [{ type: 'text', text: ' '.repeat(100_001) + output }];
    });
    await expect(f.engine.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', usage: null });
  });
  it.each(['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY'])('names forbidden environment channel %s without exposing its value', name => {
    const value = 'private-env-value-do-not-expose';
    vi.stubEnv(name, value);
    let error: unknown;
    try { createLearningEngine({ mode: 'live', provider: 'openai', model: 'unused', apiKey: 'explicit-test-key' }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'UNSAFE_ENVIRONMENT' });
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain(value);
    expect(process.env[name]).toBe(value);
  });
  it('rechecks forbidden environment channels before each live request', async () => {
    const f = await fixture();
    vi.stubEnv('OPENAI_API_KEY', 'later-private-value');
    await expect(f.engine.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'UNSAFE_ENVIRONMENT' });
    expect(f.handle.state.callCount).toBe(0);
  });
  it('keeps mock requests isolated from the OAuth store', async () => {
    const credentials = new InMemoryCredentialStore(); const read = vi.spyOn(credentials, 'read');
    await createLearningEngine({ mode: 'mock' }, { credentials }).execute(task, { signal: new AbortController().signal });
    expect(read).not.toHaveBeenCalled();
  });
});
