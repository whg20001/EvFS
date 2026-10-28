import type { AiTask, RunProgress, RunRequest, RunTransport, Usage } from '@sanxing/contracts';

export interface PerformanceSample {
  task: Pick<AiTask, 'kind'>;
  error: string | null;
  durationMs: number;
  usage: Usage | null;
  progress: RunProgress | null;
  request: RunRequest | null;
  transport?: RunTransport | null;
}
const interval = (end: number | undefined, start: number | undefined): number | null =>
  end === undefined || start === undefined || end < start ? null : end - start;

/** Only observed, completed intervals contribute; missing stages are never zero-filled. */
export function stageDurations(progress: RunProgress | null) {
  return {
    queueMs: progress?.queuedMs ?? null,
    preparationMs: progress?.requestStartedMs ?? null,
    firstResponseWaitMs: interval(progress?.firstResponseMs, progress?.requestStartedMs),
    firstTextWaitMs: interval(progress?.firstTextMs, progress?.requestStartedMs),
    generationMs: interval(progress?.generationCompletedMs, progress?.firstTextMs),
    validationMs: interval(progress?.saveStartedMs, progress?.generationCompletedMs),
    savingMs: interval(progress?.completedMs, progress?.saveStartedMs),
    executionMs: progress?.completedMs ?? null,
    // Failed/unfinished phases are right-censored observations, separate from completion latency.
    observedElapsedMs: progress?.elapsedMs ?? null,
  };
}
function distribution(values: (number | null | undefined)[]) {
  const sorted = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { samples: sorted.length, missing: values.length - sorted.length,
    p50Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1]! : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
    maxMs: sorted.at(-1) ?? null };
}
function counts(values: string[]) {
  const result: Record<string, number> = Object.create(null);
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function tokenTotal(rows: PerformanceSample[], field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cost') {
  const values = rows.map(row => row.usage?.[field]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return { observedTotal: values.length ? values.reduce((sum, value) => sum + value, 0) : null, knownSamples: values.length, unknownSamples: rows.length - values.length };
}
function summarize(rows: PerformanceSample[]) {
  const stages = rows.map(row => stageDurations(row.progress));
  const keys = Object.keys(stageDurations(null)) as (keyof ReturnType<typeof stageDurations>)[];
  const failed = rows.filter(row => row.error !== null);
  const succeeded = rows.filter(row => row.error === null);
  return {
    attempted: rows.length, succeeded: succeeded.length, failed: failed.length,
    failureRate: rows.length ? failed.length / rows.length : null,
    timeoutCount: failed.filter(row => row.error && ['TIMEOUT', 'FIRST_RESPONSE_TIMEOUT', 'STREAM_IDLE_TIMEOUT', 'MODEL_CONNECTION_TIMEOUT', 'APP_RUN_TIMEOUT'].includes(row.error)).length,
    errors: counts(failed.map(row => row.error!)), failurePhases: counts(failed.map(row => row.progress?.phase ?? 'unknown')),
    totalDuration: distribution(rows.map(row => row.durationMs)), successfulDuration: distribution(succeeded.map(row => row.durationMs)),
    stages: Object.fromEntries(keys.map(key => [key, distribution(stages.map(stage => stage[key]))])),
    usage: { inputTokens: tokenTotal(rows, 'inputTokens'), outputTokens: tokenTotal(rows, 'outputTokens'),
      cacheReadTokens: tokenTotal(rows, 'cacheReadTokens'), cacheWriteTokens: tokenTotal(rows, 'cacheWriteTokens'), cost: tokenTotal(rows, 'cost') },
    transport: {
      observed: rows.filter(row => row.transport != null).length,
      missing: rows.filter(row => row.transport == null).length,
      policies: counts(rows.map(row => row.transport?.policy ?? 'unknown')),
      rawErrors: counts(failed.map(row => row.transport?.errorCode ?? 'unknown')),
      failurePhases: counts(failed.map(row => row.transport?.phase ?? 'unknown')),
      socketReuse: counts(rows.map(row => row.transport?.reusedSocket === true ? 'reused' : row.transport?.reusedSocket === false ? 'new' : 'unknown')),
    },
    requestsWithMetadata: rows.filter(row => row.request !== null).length,
  };
}
export function summarizePerformance(rows: PerformanceSample[]) {
  const modelKey = (row: PerformanceSample) => JSON.stringify({
    provider: row.request?.provider ?? row.usage?.provider ?? null,
    model: row.request?.model ?? row.usage?.model ?? null,
    authMethod: row.request?.authMethod ?? null,
  });
  return { ...summarize(rows),
    byTask: Object.fromEntries([...new Set(rows.map(row => row.task.kind))].sort().map(kind => [kind, summarize(rows.filter(row => row.task.kind === kind))])),
    byModel: Object.fromEntries([...new Set(rows.map(modelKey))].sort().map(key => [key, summarize(rows.filter(row => modelKey(row) === key))])),
  };
}
