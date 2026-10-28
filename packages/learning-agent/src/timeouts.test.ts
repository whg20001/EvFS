import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type Provider, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { runRequestSchema, type AiTask, type LearningEngine, type LearningProgressEvent } from '@sanxing/contracts';

const probe = vi.hoisted(() => ({ stream: undefined as Provider['streamSimple'] | undefined }));
vi.mock('@earendil-works/pi-ai/providers/faux', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/faux')>();
  return { ...actual, fauxProvider: (...args: Parameters<typeof actual.fauxProvider>) => {
    const handle = actual.fauxProvider(...args);
    handle.provider = { ...handle.provider, streamSimple: (...streamArgs) => probe.stream!(...streamArgs) };
    return handle;
  } };
});
import { createLearningEngine, type EngineConfig } from './index.ts';
const task: AiTask = { kind: 'extract', recitation: { topic: '', learned: 'A', unclear: '', application: '' }, sources: [{ id: 's1', name: 'Source', text: 'A' }] };
const output = { kind: 'extract', candidates: [{ title: 'A', description: 'A description', sourceIds: ['s1'] }] };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function fixture(limits: Partial<EngineConfig> = {}, callbacks: Partial<Parameters<LearningEngine['execute']>[1]> = {}) {
  const stream = createAssistantMessageEventStream();
  const message = fauxAssistantMessage('');
  let options!: SimpleStreamOptions;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const transport = vi.fn<Provider['streamSimple']>((_model, _context, opts) => { options = opts!; began(); return stream; });
  probe.stream = transport;
  const engine = createLearningEngine({ mode: 'mock', timeoutMs: 120_000, firstResponseTimeoutMs: 60_000, streamIdleTimeoutMs: 45_000, ...limits });
  const events: LearningProgressEvent[] = [];
  const controller = new AbortController();
  const result = engine.execute(task, { signal: controller.signal, onProgress: event => events.push(event), ...callbacks });
  // Attach rejection immediately: fake time can expire the task before assertions await it.
  void result.catch(() => {});
  await started;
  stream.push({ type: 'start', partial: message });
  await vi.advanceTimersByTimeAsync(0);
  return { result, events, controller, options, transport,
    async headers() { await options.onResponse?.({ status: 200, headers: {} }, { id: 'faux-1' } as Parameters<NonNullable<SimpleStreamOptions['onResponse']>>[1]); await vi.advanceTimersByTimeAsync(0); },
    async chunk(type: 'text' | 'thinking' = 'text', delta = 'private-content') {
      stream.push({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: 0, delta, partial: message });
      await vi.advanceTimersByTimeAsync(0);
    },
    async finish() {
      message.content = [{ type: 'text', text: JSON.stringify(output) }];
      stream.push({ type: 'done', reason: 'stop', message });
      await vi.advanceTimersByTimeAsync(0);
    },
    async fail() {
      message.stopReason = 'error'; message.errorMessage = 'private-provider-error';
      stream.push({ type: 'error', reason: 'error', error: message });
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('expires the first-response wait despite SDK start and empty delta events', async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(59_000); await f.chunk('text', '');
  expect(f.events).toEqual(['request']);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(f.result).rejects.toMatchObject({ code: 'FIRST_RESPONSE_TIMEOUT' });
  expect(f.options.signal?.aborted).toBe(true); expect(f.transport).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('detects a stream stalled after headers, without treating empty chunks as activity', async () => {
  const f = await fixture(); await f.headers();
  await vi.advanceTimersByTimeAsync(44_000); await f.chunk('thinking', '');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(f.result).rejects.toMatchObject({ code: 'STREAM_IDLE_TIMEOUT' });
  expect(f.events).toEqual(['request', 'response']); expect(vi.getTimerCount()).toBe(0);
});

it('keeps a meaningful stream alive beyond one minute and never exposes content in progress', async () => {
  const f = await fixture(); await f.headers();
  await vi.advanceTimersByTimeAsync(40_000); await f.chunk('thinking');
  await vi.advanceTimersByTimeAsync(40_000); await f.chunk();
  await f.finish();
  await expect(f.result).resolves.toMatchObject({ output });
  expect(f.events).toEqual(['request', 'response', 'thinking', 'text', 'generated', 'validated']);
  expect(JSON.stringify(f.events)).not.toContain('private-content'); expect(vi.getTimerCount()).toBe(0);
});

it('accepts content as the first response when the provider does not expose headers', async () => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(50_000); await f.chunk();
  await vi.advanceTimersByTimeAsync(20_000); await f.finish();
  await expect(f.result).resolves.toMatchObject({ output });
  expect(f.events.filter(event => event === 'response')).toHaveLength(1);
});

it('stops a continuous stream at the absolute task deadline', async () => {
  const f = await fixture(); await f.headers();
  for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(35_000); await f.chunk(); }
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(f.result).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(vi.getTimerCount()).toBe(0);
});

it('resets idle time for nonempty text and thinking but still stops later silence', async () => {
  const f = await fixture(); await f.chunk('thinking');
  await vi.advanceTimersByTimeAsync(30_000); await f.chunk();
  await vi.advanceTimersByTimeAsync(44_999);
  expect(f.options.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(f.result).rejects.toMatchObject({ code: 'STREAM_IDLE_TIMEOUT' });
});

it.each(['waiting', 'generating', 'saving'] as const)('cancels while %s, clears timers and ignores late events', async phase => {
  const f = await fixture({}, phase === 'saving' ? { onUsage: () => new Promise<void>(() => {}) } : {});
  if (phase !== 'waiting') await f.chunk();
  if (phase === 'saving') await f.finish();
  f.controller.abort();
  await expect(f.result).rejects.toMatchObject({ code: 'CANCELLED' });
  const before = [...f.events];
  await f.headers(); await f.chunk(); if (phase !== 'saving') await f.finish();
  expect(f.events).toEqual(before); expect(vi.getTimerCount()).toBe(0);
});

it('excludes usage persistence from model deadlines, but waits for it before returning', async () => {
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const onUsage = vi.fn(() => delivery);
  const f = await fixture({}, { onUsage }); await f.chunk(); await f.finish();
  expect(onUsage).toHaveBeenCalledTimes(1); expect(f.events.at(-1)).toBe('validated');
  let settled = false; void f.result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(150_000);
  expect(settled).toBe(false); expect(f.options.signal?.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  release(); await expect(f.result).resolves.toMatchObject({ output });
});

it('does not let a failing telemetry observer break a valid result', async () => {
  const f = await fixture({}, { onProgress: () => { throw new Error('observer failed'); }, onRequest: () => { throw new Error('request observer failed'); } });
  await f.chunk(); await f.finish();
  await expect(f.result).resolves.toMatchObject({ output }); expect(vi.getTimerCount()).toBe(0);
});

it('captures bounded request settings once even on failure, without treating provider errors as completed generation', async () => {
  const onRequest = vi.fn();
  const f = await fixture({}, { onRequest }); await f.headers(); await f.chunk('thinking'); await f.fail();
  await expect(f.result).rejects.toBeDefined();
  expect(f.events).toEqual(['request', 'response', 'thinking']);
  expect(onRequest).toHaveBeenCalledTimes(1);
  const request = runRequestSchema.parse(onRequest.mock.calls[0]![0]);
  expect(request).toMatchObject({ authMethod: 'mock', timeoutMs: 120_000, firstResponseTimeoutMs: 60_000, streamIdleTimeoutMs: 45_000 });
  expect(request.inputChars).toBeGreaterThan(0); expect(request.inputBytes).toBeGreaterThanOrEqual(request.inputChars);
  expect(JSON.stringify(request)).not.toContain('private-'); expect(vi.getTimerCount()).toBe(0);
});
