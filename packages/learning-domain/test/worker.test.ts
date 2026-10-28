import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyData } from '@sanxing/database';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import type { AiResponse, AppData, LearningEngine } from '@sanxing/contracts';
import { LearningService } from '../src/service.ts';
import { RunWorker } from '../src/worker.ts';

function setup() {
  let data = emptyData('mock');
  const repository = {
    read: vi.fn(async () => structuredClone(data)),
    async transact<T>(fn: (draft: AppData) => T | Promise<T>) {
      const draft = structuredClone(data);
      const result = await fn(draft);
      draft.revision++;
      data = draft;
      return result;
    },
  };
  const service = new LearningService(repository, {
    mode: 'mock', timezone: 'Asia/Shanghai', maxUploadBytes: 131072, maxDocuments: 5,
    maxFollowups: 3, quizCount: 3, schedulingEnabled: true, maxCallsPerSession: 20,
    dailyBudgetUsd: null, requestReservationUsd: 0, runTimeoutMs: 30_000,
  }, undefined, undefined, describeLearningPrompt);
  const execute = vi.fn<LearningEngine['execute']>(async task => {
    if (task.kind !== 'extract') throw new Error('Unexpected task');
    return { output: { kind: 'extract', candidates: [{ title: 'Example', description: 'A confirmed candidate', sourceIds: [task.sources[0]!.id] }] }, usage: null };
  });
  const worker = new RunWorker(service, { mode: 'mock', execute });
  async function queue(learningDate?: string) {
    return repository.transact(draft => {
      const created = service.createRecitation(draft, { learningDate });
      service.saveDraft(draft, created.id!, { version: 1, learned: 'Example concept', unclear: '', application: '', topic: '' });
      return service.submitRecitation(draft, created.id!, { version: 2 });
    });
  }
  return { repository, service, execute, worker, queue };
}

afterEach(() => vi.useRealTimers());

describe('event-driven worker', () => {
  it.each(['return', 'error'] as const)('coalesces concurrent usage callbacks and %s delivery into one save', async delivery => {
    const f = setup(); const queued = await f.queue();
    const usage = { provider: 'offline', model: 'm', inputTokens: 10, outputTokens: 2, cost: null };
    const save = vi.spyOn(f.service, 'recordUsage');
    f.execute.mockImplementationOnce(async (task, options) => {
      await Promise.all([options.onUsage!(usage), options.onUsage!(usage)]);
      if (delivery === 'error') throw Object.assign(new Error('failed'), { code: 'MODEL_HTTP_503', usage });
      if (task.kind !== 'extract') throw new Error('fixture');
      return { output: { kind: 'extract', candidates: [{ title: 'Example', description: 'Example', sourceIds: [task.sources[0]!.id] }] }, usage };
    });
    try {
      await f.worker.tick();
      expect(save).toHaveBeenCalledTimes(1);
      expect((await f.repository.read()).runs[queued.runId!]).toMatchObject({ usage, status: delivery === 'return' ? 'succeeded' : 'failed' });
    } finally { await f.worker.stop(); }
  });

  it('retries a failed usage save locally without executing the model again', async () => {
    const f = setup(); const queued = await f.queue();
    const usage = { provider: 'offline', model: 'm', inputTokens: 10, outputTokens: 2, cost: null };
    const save = vi.spyOn(f.service, 'recordUsage').mockRejectedValueOnce(new Error('storage unavailable'));
    f.execute.mockImplementationOnce(async (task, options) => {
      await options.onUsage!(usage).catch(() => undefined);
      if (task.kind !== 'extract') throw new Error('fixture');
      return { output: { kind: 'extract', candidates: [{ title: 'Example', description: 'Example', sourceIds: [task.sources[0]!.id] }] }, usage };
    });
    try {
      await f.worker.tick(); expect(save).toHaveBeenCalledTimes(2); expect(f.execute).toHaveBeenCalledTimes(1);
      expect((await f.repository.read()).runs[queued.runId!]).toMatchObject({ status: 'succeeded', usage });
    } finally { await f.worker.stop(); }
  });

  it.each(['version', 'hash', 'legacy', 'input'] as const)('rejects a changed %s binding before execution, then explicitly retries with a new binding', async change => {
    const f = setup();
    const result = await f.queue();
    await f.repository.transact(draft => {
      const run = draft.runs[result.runId!]!;
      run.reservationUsd = 0.25;
      if (change === 'version') run.promptVersion = 'learning-v5';
      if (change === 'hash') run.promptHash = '0'.repeat(64);
      if (change === 'legacy') delete run.promptHash;
      if (change === 'input' && run.task.kind === 'extract') run.task.recitation.learned += ' changed';
    });
    const before = (await f.repository.read()).runs[result.runId!]!;
    try {
      await f.worker.start(); await f.worker.tick();
      expect(f.execute).not.toHaveBeenCalled();
      const rejected = await f.repository.read();
      expect(rejected.runs[result.runId!]).toMatchObject({ status: 'failed', errorCode: 'PROMPT_CHANGED',
        attempt: 0, startedAt: null, usage: null, reservationUsd: 0, promptVersion: before.promptVersion, task: before.task });
      expect(rejected.sessions[result.sessionId!]!.activeRunId).toBeNull();
      const retry = await f.repository.transact(draft => f.service.retryRun(draft, result.runId!));
      const queued = (await f.repository.read()).runs[retry.runId!]!;
      expect(queued.task).toEqual(before.task);
      expect({ version: queued.promptVersion, hash: queued.promptHash }).toEqual(describeLearningPrompt(queued.task));
      await f.worker.tick();
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.execute.mock.calls[0]![1].expectedPrompt).toEqual(describeLearningPrompt(queued.task));
      expect((await f.repository.read()).runs[retry.runId!]!.status).toBe('succeeded');
      expect((await f.repository.read()).runs[result.runId!]).toEqual(rejected.runs[result.runId!]);
    } finally { await f.worker.stop(); }
  });

  it('rejects an obsolete pending run without blocking a valid run behind it', async () => {
    const f = setup();
    const stale = await f.queue('2026-10-20'); const valid = await f.queue('2026-10-21');
    await f.repository.transact(draft => { draft.runs[stale.runId!]!.promptVersion = 'learning-v5'; });
    try {
      await f.worker.tick();
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect((await f.repository.read()).runs[valid.runId!]!.status).toBe('succeeded');
    } finally { await f.worker.stop(); }
  });

  it.each([
    ['MODEL_HTTP_429', 'MODEL_HTTP_429', '限流'], ['MODEL_HTTP_503', 'MODEL_HTTP_503', '暂时异常'],
    ['MODEL_HTTP_401', 'MODEL_HTTP_401', '授权'], ['AI_MODEL_UNAUTHORIZED', 'MODEL_NOT_AUTHORIZED', '授权'],
    ['MODEL_DNS_ERROR', 'MODEL_DNS_ERROR', 'DNS'], ['MODEL_TLS_ERROR', 'MODEL_TLS_ERROR', '证书'],
    ['MODEL_CONNECTION_RESET', 'MODEL_CONNECTION_RESET', '网络'], ['MODEL_NETWORK_ERROR', 'MODEL_NETWORK_ERROR', '网络'],
    ['MODEL_CONNECTION_TIMEOUT', 'MODEL_CONNECTION_TIMEOUT', '传输超时'], ['MODEL_AUTH_FAILED', 'MODEL_AUTH_FAILED', '授权'],
    ['AI_CREDENTIALS_UNAVAILABLE', 'MODEL_AUTH_FAILED', '读取'],
    ['MODEL_STREAM_INTERRUPTED', 'MODEL_STREAM_INTERRUPTED', '终态'], ['MODEL_PROTOCOL_ERROR', 'MODEL_PROTOCOL_ERROR', '格式异常'],
    ['MODEL_RESPONSE_INCOMPLETE', 'MODEL_RESPONSE_INCOMPLETE', '未完成'], ['MODEL_PROVIDER_ERROR', 'MODEL_PROVIDER_ERROR', '报告失败'],
    ['MODEL_QUOTA_EXCEEDED', 'MODEL_QUOTA_EXCEEDED', '额度'], ['MODEL_RATE_LIMITED', 'MODEL_RATE_LIMITED', '限流'],
    ['INVALID_OUTPUT', 'INVALID_OUTPUT', '校验'], ['INVALID_REFERENCE', 'INVALID_OUTPUT', '校验'],
    ['TIMEOUT', 'TIMEOUT', '超时'], ['FIRST_RESPONSE_TIMEOUT', 'FIRST_RESPONSE_TIMEOUT', '首个响应'], ['STREAM_IDLE_TIMEOUT', 'STREAM_IDLE_TIMEOUT', '新的内容'], ['MODEL_INPUT_TOO_LARGE', 'MODEL_INPUT_TOO_LARGE', '输入预算'],
    ['private-secret-code', 'MODEL_FAILED', '未完成'], ['MODEL_HTTP_429_secret', 'MODEL_FAILED', '未完成'],
  ])('persists safe classification for %s and retains observed usage without retrying', async (raw, code, message) => {
    const f = setup(); const result = await f.queue();
    const usage = { provider: 'offline', model: 'offline', inputTokens: 12, outputTokens: 3, cost: null };
    f.execute.mockRejectedValue(Object.assign(new Error('private-secret-message'), { code: raw, usage, stack: 'private-secret-stack' }));
    try {
      await f.worker.tick(); await f.worker.tick();
      const run = (await f.repository.read()).runs[result.runId!]!;
      expect(run).toMatchObject({ status: 'failed', errorCode: code, error: expect.stringContaining(message), usage });
      expect(JSON.stringify(run)).not.toContain('private-secret');
      expect(f.execute).toHaveBeenCalledTimes(1);
      await f.service.finishRun(run.id, run.attemptId!, { output: { kind: 'extract', candidates: [] }, usage });
      expect((await f.repository.read()).runs[run.id]).toEqual(run);
    } finally { await f.worker.stop(); }
  });

  it.each(['timeout', 'cancel', 'stop'] as const)('distinguishes %s while retaining late usage and fencing late results', async action => {
    const f = setup(); const result = await f.queue();
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    let complete!: (response: AiResponse) => void;
    f.execute.mockImplementationOnce(async () => { began(); return new Promise(resolve => { complete = resolve; }); });
    if (action === 'timeout') f.service.config.runTimeoutMs = 5;
    try {
      const work = f.worker.tick(); await started;
      if (action === 'cancel') {
        await f.repository.transact(draft => f.service.cancelRun(draft, result.runId!));
        f.worker.cancel(result.runId!);
      }
      if (action === 'stop') await f.worker.stop();
      await work;
      const run = (await f.repository.read()).runs[result.runId!]!;
      expect(run).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'failed',
        errorCode: action === 'timeout' ? 'TIMEOUT' : action === 'cancel' ? 'CANCELLED' : 'SERVICE_RESTARTED' });
      const usage = { provider: 'offline', model: 'offline', inputTokens: 3, outputTokens: 1, cost: 0.01 };
      await f.execute.mock.calls[0]![1].onUsage!(usage);
      complete({ output: { kind: 'extract', candidates: [] }, usage });
      await Promise.resolve();
      expect((await f.repository.read()).runs[run.id]).toMatchObject({ status: run.status, errorCode: run.errorCode, usage });
      expect((await f.repository.read()).sessions[result.sessionId!]!.candidates).toEqual([]);
    } finally { await f.worker.stop(); }
  });

  it('does not read the repository while idle', async () => {
    vi.useFakeTimers();
    const { worker, repository } = setup();
    try {
      await worker.start();
      await worker.tick();
      const reads = repository.read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(repository.read).toHaveBeenCalledTimes(reads);
    } finally { await worker.stop(); }
  });

  it('wakes after a commit and accepts a valid result with unknown usage', async () => {
    const { worker, repository, execute, queue } = setup();
    try {
      await worker.start();
      await worker.tick();
      const result = await queue();
      await worker.tick();
      const data = await repository.read();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(data.runs[result.runId!]!.status).toBe('succeeded');
      expect(data.runs[result.runId!]!.usage).toBeNull();
      expect(data.sessions[result.sessionId!]!.candidates).toHaveLength(1);
    } finally { await worker.stop(); }
  });

  it('does not lose a wakeup during the previous drain final read', async () => {
    const { worker, repository, execute, queue } = setup();
    let release!: () => void;
    let observed!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { observed = resolve; });
    const originalRead = repository.read.getMockImplementation()!;
    repository.read.mockImplementationOnce(async () => {
      const oldSnapshot = await originalRead();
      observed();
      await blocked;
      return oldSnapshot;
    });
    try {
      const draining = worker.tick();
      await entered;
      const result = await queue();
      const notified = worker.tick();
      release();
      await Promise.all([draining, notified]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await repository.read()).runs[result.runId!]!.status).toBe('succeeded');
    } finally { release(); await worker.stop(); }
  });

  it('exposes only active IDs for cancellation and does not restart cancelled work', async () => {
    const { worker, repository, service, execute, queue } = setup();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    execute.mockImplementationOnce(async () => { entered(); return new Promise<AiResponse>(() => {}); });
    const result = await queue();
    try {
      const work = worker.tick();
      await started;
      expect(worker.activeRunIds()).toEqual([result.runId]);
      await repository.transact(draft => service.cancelRun(draft, result.runId!));
      worker.cancel(result.runId!);
      await work;
      await worker.tick();
      expect(worker.activeRunIds()).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await repository.read()).runs[result.runId!]!.status).toBe('cancelled');
    } finally { await worker.stop(); }
  });
});

it('keeps stage measurements in memory until completion, and fences stale telemetry', async () => {
  vi.useFakeTimers();
  const f = setup(); const queued = await f.queue();
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.execute.getMockImplementation()!;
  f.execute.mockImplementationOnce(async (task, options) => { began(); await held; return original(task, options); });
  const work = f.worker.tick(); await started;
  const notify = f.execute.mock.calls[0]![1].onProgress!;
  const revision = (await f.repository.read()).revision;
  try {
    expect(f.worker.progress()[queued.runId!]!.phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(12); notify('request');
    await vi.advanceTimersByTimeAsync(30); notify('response');
    await vi.advanceTimersByTimeAsync(40); notify('thinking');
    await vi.advanceTimersByTimeAsync(50); notify('text');
    expect(f.worker.progress()[queued.runId!]).toMatchObject({ phase: 'generating', requestStartedMs: 12, firstResponseMs: 42, firstTextMs: 132, lastContentMs: 132, elapsedMs: 132 });
    for (let i = 0; i < 1000; i++) { notify('text'); f.worker.progress(); }
    expect((await f.repository.read()).revision).toBe(revision);
    // The response is a detached snapshot; clients cannot mutate the worker's state.
    f.worker.progress()[queued.runId!]!.phase = 'waiting';
    expect(f.worker.progress()[queued.runId!]!.phase).toBe('generating');
    notify('generated'); expect(f.worker.progress()[queued.runId!]!.phase).toBe('validating');
    notify('validated'); expect(f.worker.progress()[queued.runId!]!.phase).toBe('saving');
    await vi.advanceTimersByTimeAsync(40_000); // Storage exceeds the original model deadline.
    release(); await work;
    const final = (await f.repository.read()).runs[queued.runId!]!;
    expect(final).toMatchObject({ status: 'succeeded', progress: { phase: 'saving', completedMs: 40_132, elapsedMs: 40_132, saveStartedMs: 132 } });
    expect(f.worker.progress()).toEqual({});
    notify('text'); expect(f.worker.progress()).toEqual({});
    await f.service.recordRunProgress(final.id, final.attempt + 1, { ...final.progress!, elapsedMs: 99_999 });
    expect((await f.repository.read()).runs[final.id]!.progress).toEqual(final.progress);
    expect((await f.service.state('csrf')).runs[0]!.progress).toEqual(final.progress);
  } finally { release(); await f.worker.stop(); }
});

it.each([
  { kind: 'extract', base: 60_000, quiz: 120_000, deadline: 60_000 },
  { kind: 'quiz', base: 60_000, quiz: 120_000, deadline: 120_000 },
  { kind: 'connection_test', base: 60_000, quiz: 120_000, deadline: 30_000 },
  { kind: 'connection_test', base: 50, quiz: 120_000, deadline: 50 },
] as const)('enforces the $kind worker deadline of $deadline ms even for an uncooperative engine', async ({ kind, base, quiz, deadline }) => {
  vi.useFakeTimers(); const f = setup(); const queued = await f.queue();
  f.service.config.runTimeoutMs = base; f.service.config.quizTimeoutMs = quiz;
  if (kind !== 'extract') await f.repository.transact(data => {
    const run = data.runs[queued.runId!]!;
    run.task = kind === 'quiz' ? { kind, points: [], sources: [], count: 1 }
      : { kind, selection: { providerId: 'openai', modelId: 'offline-only', authMethod: 'oauth', allowUnboundedOutput: true } };
    const prompt = describeLearningPrompt(run.task); run.promptVersion = prompt.version; run.promptHash = prompt.hash;
  });
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  f.execute.mockImplementationOnce(async () => { began(); return new Promise(() => {}); });
  try {
    const work = f.worker.tick(); await started;
    expect(f.worker.progress()[queued.runId!]!.totalTimeoutMs).toBe(deadline);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect((await f.repository.read()).runs[queued.runId!]!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1); await work;
    expect((await f.repository.read()).runs[queued.runId!]).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT', progress: { completedMs: deadline } });
    expect(f.worker.progress()).toEqual({}); expect(f.execute).toHaveBeenCalledTimes(1);
    f.execute.mock.calls[0]![1].onProgress!('text'); expect(f.worker.progress()).toEqual({});
  } finally { await f.worker.stop(); }
});

it('preserves a stream failure category while its usage is saved after the model deadline', async () => {
  vi.useFakeTimers(); const f = setup(); const queued = await f.queue();
  const usage = { provider: 'offline', model: 'offline', inputTokens: 2, outputTokens: 1, cost: null };
  f.execute.mockRejectedValue(Object.assign(new Error('private provider failure'), { code: 'STREAM_IDLE_TIMEOUT', usage }));
  const recordUsage = f.service.recordUsage.bind(f.service);
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.service, 'recordUsage').mockImplementationOnce(async (...args) => { began(); await held; return recordUsage(...args); });
  try {
    const work = f.worker.tick(); await started;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.execute.mock.calls[0]![1].signal.aborted).toBe(false);
    release(); await work;
    expect((await f.repository.read()).runs[queued.runId!]).toMatchObject({ errorCode: 'STREAM_IDLE_TIMEOUT', usage });
    expect(f.worker.progress()).toEqual({});
  } finally { release(); await f.worker.stop(); }
});

it('persists validated transport failures once and rejects late or stale-attempt diagnostics', async () => {
  const f = setup(); const queued = await f.queue();
  const transport = { policy: 'pooled' as const, phase: 'awaiting_headers' as const, requestCount: 1,
    reusedSocket: true, bytesWritten: 42, bytesRead: 0, errorCode: 'ECONNRESET' as const, syscall: 'read' as const };
  const save = vi.spyOn(f.service, 'recordRunProgress');
  let notify!: NonNullable<Parameters<LearningEngine['execute']>[1]['onTransport']>;
  f.execute.mockImplementationOnce(async (_task, options) => {
    notify = options.onTransport!; notify(transport);
    notify({ ...transport, message: 'PRIVATE' } as typeof transport);
    expect(f.worker.diagnostics(queued.runId!)?.transport).toEqual(transport);
    f.worker.diagnostics(queued.runId!)!.transport!.bytesWritten = 999;
    expect(f.worker.diagnostics(queued.runId!)?.transport?.bytesWritten).toBe(42);
    throw Object.assign(new Error('PRIVATE'), { code: 'MODEL_CONNECTION_RESET' });
  });
  try {
    await f.worker.tick(); const run = (await f.repository.read()).runs[queued.runId!]!;
    expect(run).toMatchObject({ status: 'failed', errorCode: 'MODEL_CONNECTION_RESET', transport });
    expect(save).toHaveBeenCalledTimes(1);
    notify({ ...transport, bytesWritten: 999 }); expect(f.worker.diagnostics(run.id)).toBeUndefined();
    await f.service.recordRunProgress(run.id, run.attempt + 1, run.progress, undefined, { ...transport, bytesWritten: 999 });
    expect((await f.repository.read()).runs[run.id]!.transport).toEqual(transport);
    expect(JSON.stringify(run)).not.toContain('PRIVATE');
  } finally { await f.worker.stop(); }
});
