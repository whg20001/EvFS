import { expect, it } from 'vitest';
import type { RunProgress } from '@sanxing/contracts';
import { stageDurations, summarizePerformance, type PerformanceSample } from './performance.ts';

const completed: RunProgress = { phase: 'saving', elapsedMs: 250, completedMs: 250, queuedMs: 10, totalTimeoutMs: 60_000,
  requestStartedMs: 20, firstResponseMs: 50, firstTextMs: 100, generationCompletedMs: 200, saveStartedMs: 210 };
const sample = (patch: Partial<PerformanceSample> = {}): PerformanceSample => ({ task: { kind: 'extract' },
  error: null, durationMs: 300, usage: null, progress: completed, request: null, ...patch });

it('separates headers, first text, generation and host work without zero-filling missing stages', () => {
  expect(stageDurations(completed)).toEqual({ queueMs: 10, preparationMs: 20, firstResponseWaitMs: 30, firstTextWaitMs: 80,
    generationMs: 100, validationMs: 10, savingMs: 40, executionMs: 250, observedElapsedMs: 250 });
  expect(Object.values(stageDurations(null)).every(value => value === null)).toBe(true);
  expect(stageDurations({ ...completed, firstTextMs: 201 }).generationMs).toBeNull();
});

it('includes failures in total latency and counts missing observations separately from zero usage', () => {
  const result = summarizePerformance([sample({ usage: { provider: 'p', model: 'm', inputTokens: 12, outputTokens: 5,
    cacheReadTokens: 0, cost: null } }), sample({ task: { kind: 'quiz' }, error: 'FIRST_RESPONSE_TIMEOUT', durationMs: 60_000,
    progress: { phase: 'waiting', queuedMs: 0, elapsedMs: 60_000, completedMs: 60_000, totalTimeoutMs: 60_000, requestStartedMs: 20 } })]);
  expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, failureRate: 0.5, timeoutCount: 1,
    errors: { FIRST_RESPONSE_TIMEOUT: 1 }, failurePhases: { waiting: 1 },
    totalDuration: { samples: 2, p50Ms: 300, p95Ms: 60_000 }, successfulDuration: { samples: 1, p95Ms: 300 },
    stages: { generationMs: { samples: 1, missing: 1, p50Ms: 100 }, firstResponseWaitMs: { samples: 1, missing: 1, p50Ms: 30 } },
    usage: { cacheReadTokens: { observedTotal: 0, knownSamples: 1, unknownSamples: 1 }, cacheWriteTokens: { observedTotal: null, knownSamples: 0, unknownSamples: 2 } } });
  expect(result.byTask.quiz?.failed).toBe(1);
  expect(Object.keys(result.byModel)).toHaveLength(2);
  expect(summarizePerformance([])).toMatchObject({ attempted: 0, failureRate: null, totalDuration: { samples: 0, p95Ms: null } });
});

it('keeps raw transport errors and observed socket reuse separate from missing legacy observations', () => {
  const result = summarizePerformance([sample(), sample({ error: 'MODEL_CONNECTION_RESET', transport: {
    policy: 'pooled', phase: 'awaiting_headers', requestCount: 1, reusedSocket: true, bytesWritten: 10, bytesRead: 0, errorCode: 'EPIPE', syscall: 'write',
  } }), sample({ transport: { policy: 'fresh', phase: 'complete', requestCount: 1, reusedSocket: false, bytesRead: 50, bytesWritten: 10 } })]);
  expect(result.transport).toEqual({ observed: 2, missing: 1, policies: { unknown: 1, pooled: 1, fresh: 1 },
    rawErrors: { EPIPE: 1 }, failurePhases: { awaiting_headers: 1 }, socketReuse: { unknown: 1, reused: 1, new: 1 } });
});
