import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyData } from '@sanxing/database';
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
  });
  const execute = vi.fn<LearningEngine['execute']>(async task => {
    if (task.kind !== 'extract') throw new Error('Unexpected task');
    return { output: { kind: 'extract', candidates: [{ title: 'Example', description: 'A confirmed candidate', sourceIds: [task.sources[0]!.id] }] }, usage: null };
  });
  const worker = new RunWorker(service, { mode: 'mock', execute });
  async function queue() {
    return repository.transact(draft => {
      const created = service.createRecitation(draft, {});
      service.saveDraft(draft, created.id!, { version: 1, learned: 'Example concept', unclear: '', application: '', topic: '' });
      return service.submitRecitation(draft, created.id!, { version: 2 });
    });
  }
  return { repository, service, execute, worker, queue };
}

afterEach(() => vi.useRealTimers());

describe('event-driven worker', () => {
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
