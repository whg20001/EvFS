import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore, type Provider, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { AiTask } from '@sanxing/contracts';
import { unsafeEnvironmentKeys } from '@sanxing/ai-access/providers';

const probe = vi.hoisted(() => ({ provider: undefined as Provider | undefined }));
vi.mock('@sanxing/ai-access/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('@sanxing/ai-access/providers')>();
  return { ...actual, createExplicitProvider: (id: Parameters<typeof actual.createExplicitProvider>[0]) => probe.provider ?? actual.createExplicitProvider(id) };
});
import { createLearningEngine } from './index.ts';

const task: AiTask = { kind: 'followup', sources: [{ id: 's', name: '片段', text: '[行 1] 已提供内容' }],
  points: [{ id: 'p', title: '当前范围', description: '仅当前范围', sourceIds: ['s'] }], turns: [] };
const cases = [
  { provider: 'openai', authMethod: 'api_key', model: 'gpt-4o-mini', explicit: false },
  { provider: 'openai', authMethod: 'api_key', model: 'gpt-5.6-luna', explicit: true },
  { provider: 'openai', authMethod: 'oauth', model: 'gpt-4o-mini', explicit: false },
  { provider: 'openai', authMethod: 'oauth', model: 'gpt-5.6-luna', explicit: true },
  { provider: 'openai-codex', authMethod: 'oauth', model: undefined, explicit: false },
  { provider: 'anthropic', authMethod: 'api_key', model: undefined, explicit: false },
  { provider: 'anthropic', authMethod: 'oauth', model: undefined, explicit: false },
  { provider: 'xai', authMethod: 'api_key', model: undefined, explicit: false },
  { provider: 'xai', authMethod: 'oauth', model: undefined, explicit: false },
] as const;

beforeEach(() => {
  probe.provider = undefined;
  for (const name of unsafeEnvironmentKeys()) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('installed provider wire payload construction, stopped before HTTP', () => {
  it.each(cases)('$provider $authMethod ($model) honors opt-in, opt-out and probe isolation', async testCase => {
    const actual = await vi.importActual<typeof import('@sanxing/ai-access/providers')>('@sanxing/ai-access/providers');
    const provider = actual.createExplicitProvider(testCase.provider);
    const model = testCase.model ? provider.getModels().find(model => model.id === testCase.model) : provider.getModels().find(model => model.input.includes('text'));
    expect(model).toBeDefined();
    // Fabricated in-memory credentials only. No login, refresh, credential file or real account.
    const token = testCase.provider === 'openai-codex'
      ? `offline.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })).toString('base64url')}.offline`
      : testCase.provider === 'anthropic' ? 'sk-ant-oat-offline-test' : 'offline-oauth-test';
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(testCase.provider, async () => ({ type: 'oauth', access: token, refresh: 'offline', expires: Date.now() + 3_600_000 }));
    let options: SimpleStreamOptions | undefined;
    let hook: SimpleStreamOptions['onPayload'];
    const onPayload = vi.fn(async (payload: unknown, model: unknown) => {
      // The spy captures the payload after the engine's own hook. Stop BEFORE transport; never send tokens.
      const next = await hook?.(payload, model as never);
      throw Object.assign(new Error('Offline payload captured'), { wire: next ?? payload });
    });
    probe.provider = { ...provider,
      auth: { ...provider.auth, oauth: { name: 'Offline fixture', login: async () => { throw new Error('Login forbidden'); },
        refresh: async () => { throw new Error('Refresh forbidden'); }, toAuth: async credential => ({ apiKey: credential.access }) } },
      streamSimple: (model, context, received) => {
        options = received; hook = received?.onPayload;
        return provider.streamSimple(model, context, { ...received, onPayload });
      },
    };
    for (const cacheRetention of ['none', 'short'] as const) {
      for (const isProbe of [false, true]) {
        onPayload.mockClear();
        const engine = createLearningEngine({ mode: 'live', provider: testCase.provider, model: model!.id,
          authMethod: testCase.authMethod, allowUnboundedOAuthOutput: true, cacheRetention,
          ...(testCase.authMethod === 'api_key' ? { apiKey: 'sk-offline-test' } : {}),
        }, { credentials });
        const input: AiTask = isProbe ? { kind: 'connection_test', selection: {
          providerId: testCase.provider, modelId: model!.id, authMethod: testCase.authMethod, allowUnboundedOutput: true,
        } } : task;
        const enabled = cacheRetention === 'short' && !isProbe;
        await expect(engine.execute(input, { signal: new AbortController().signal, cacheScope: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'MODEL_FAILED', usage: null });
        expect(onPayload).toHaveBeenCalledTimes(1);
        const thrown = await onPayload.mock.results[0]!.value.catch((error: { wire: unknown }) => error.wire);
        const wire = JSON.parse(JSON.stringify(thrown)) as Record<string, unknown>;
        expect(options).toMatchObject({ cacheRetention: enabled ? 'short' : 'none', maxRetries: 0 });
        expect(options!.sessionId).toBe(enabled ? 'c'.repeat(64) : undefined);
        expect(options!.env?.PI_CACHE_RETENTION).toBeUndefined();
        expect(wire).toBeDefined();
        if (testCase.provider === 'anthropic') {
          const payload = wire as { system: { text: string; cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[] };
          expect(payload.system).toHaveLength(testCase.authMethod === 'oauth' ? 2 : 1);
          // Only the stable scope block is marked: no write premium on the one-off task block or system prompt.
          const [stable, ...rest] = payload.messages.flatMap(message => message.content);
          expect(stable!.cache_control).toEqual(enabled ? { type: 'ephemeral' } : undefined);
          for (const block of [...payload.system, ...rest]) expect(block.cache_control).toBeUndefined();
          expect(wire).not.toHaveProperty('prompt_cache_key');
        } else {
          expect(wire!.prompt_cache_key).toBe(enabled ? 'c'.repeat(64) : undefined);
          expect(wire).not.toHaveProperty('prompt_cache_retention');
          expect(wire!.prompt_cache_options).toEqual(testCase.provider === 'openai' && testCase.authMethod === 'api_key' && testCase.explicit && !enabled ? { mode: 'explicit' } : undefined);
          // xAI OAuth keeps the output cap; OpenAI/Codex OAuth omit it.
          if (testCase.provider === 'xai') expect(wire!.max_output_tokens).toBe(isProbe ? 256 : 4096);
          else if (testCase.authMethod === 'oauth') expect(wire).not.toHaveProperty('max_output_tokens');
        }
        // A shared key is not a response cache: every execution reached the real payload builder.
        expect(fetch).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    { label: 'extract', task: { kind: 'extract', recitation: { topic: '', learned: '复述', unclear: '', application: '' }, sources: task.sources } },
    { label: 'review quiz', task: { kind: 'quiz', points: (task as Extract<AiTask, { kind: 'followup' }>).points, sources: task.sources, count: 1, recall: '回忆' } },
    { label: 'grade', task: { kind: 'grade', answer: '答', question: { knowledgeId: 'p', kind: 'short', prompt: '题', options: [], correctIndex: null, referenceAnswer: '参考', rubric: [{ id: 'r', description: '标准', maxScore: 1 }], sourceIds: ['s'] } } },
  ] as { label: string; task: AiTask }[])('anthropic short caching sends no cache marks for one-off $label requests', async ({ task: input }) => {
    const actual = await vi.importActual<typeof import('@sanxing/ai-access/providers')>('@sanxing/ai-access/providers');
    const provider = actual.createExplicitProvider('anthropic');
    let wire: { system: { cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[] } | undefined;
    probe.provider = { ...provider, streamSimple: (model, context, received) => provider.streamSimple(model, context, { ...received, onPayload: async (payload, payloadModel) => {
      wire = (await received?.onPayload?.(payload, payloadModel) ?? payload) as typeof wire;
      throw new Error('Offline payload captured');
    } }) };
    const engine = createLearningEngine({ mode: 'live', provider: 'anthropic', model: provider.getModels().find(model => model.input.includes('text'))!.id, apiKey: 'sk-offline-test', cacheRetention: 'short' });
    await expect(engine.execute(input, { signal: new AbortController().signal, cacheScope: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    const blocks = [...wire!.system, ...wire!.messages.flatMap(message => message.content)];
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.cache_control).toBeUndefined();
  });
});
