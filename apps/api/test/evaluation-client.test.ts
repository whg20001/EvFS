import { afterEach, expect, it, vi } from 'vitest';
import { connectEvaluationApp } from '../../../scripts/evaluation-app.ts';
import { selectEvaluationCases } from '../../../scripts/evaluation-selection.ts';

afterEach(() => vi.unstubAllGlobals());

it('selects explicit fixed cases and rejects duplicate, unknown or conflicting selection before connecting', () => {
  expect(selectEvaluationCases({ cases: 'cache-grade-correct,mean-grade-correct' }).map(item => item.id)).toEqual(['cache-grade-correct', 'mean-grade-correct']);
  expect(selectEvaluationCases({ offset: '3', limit: '1' }).map(item => item.id)).toEqual(['cache-grade-correct']);
  expect(selectEvaluationCases({})).toHaveLength(30);
  for (const input of [{ cases: '' }, { cases: 'unknown' }, { cases: 'cache-extract,cache-extract' }, { cases: 'cache-extract', offset: '0' }, { cases: 'cache-extract', limit: '1' }, { offset: '29', limit: '2' }]) expect(() => selectEvaluationCases(input)).toThrow();
});

it.each(['succeeded', 'failed'] as const)('waits for terminal diagnostics on %s and never resubmits a model request', async status => {
  const selection = { providerId: 'openai-codex', modelId: 'test-model', authMethod: 'oauth', allowUnboundedOutput: true };
  const request = { provider: 'openai-codex', model: 'test-model', authMethod: 'oauth', cacheRetention: 'none', inputChars: 10, inputBytes: 20,
    estimatedInputTokens: 5, contextWindow: 1000, maxOutputTokens: 100, timeoutMs: 1000, firstResponseTimeoutMs: 500, streamIdleTimeoutMs: 500 };
  const progress = { phase: status === 'failed' ? 'waiting' : 'saving', elapsedMs: 500, completedMs: 500, queuedMs: 0, totalTimeoutMs: 1000, requestStartedMs: 10 };
  const transport = { policy: 'fresh', phase: status === 'failed' ? 'awaiting_headers' : 'complete', requestCount: 1,
    reusedSocket: false, bytesWritten: 50, bytesRead: status === 'failed' ? 0 : 50, ...(status === 'failed' ? { errorCode: 'ECONNRESET', syscall: 'read' } : { httpStatus: 200 }) };
  let polls = 0;
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    let body: unknown = {};
    if (path === '/api/auth/login') body = { csrfToken: 'test-csrf' };
    else if (path === '/api/ai/configuration') body = { mode: 'live', ready: true, selection };
    else if (path === '/api/ai/evaluations' && options.method === 'GET') body = { suite: 'test-suite', caseIds: ['case'], timeoutMs: 1000, maxOutputTokens: 100 };
    else if (path === '/api/ai/evaluations') body = { runId: 'test-run' };
    else if (path === '/api/ai/evaluations/test-run') {
      polls++;
      body = { status, usage: null, diagnosticsPending: polls === 1, ...(polls > 1 ? { progress, request, transport } : {}),
        promptHash: 'a'.repeat(64), errorCode: status === 'failed' ? 'FIRST_RESPONSE_TIMEOUT' : undefined,
        evaluation: { output: { kind: 'extract', candidates: [{ title: 'a', description: 'a', sourceIds: [] }] } } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(path === '/api/auth/login' ? { 'set-cookie': 'session=test; HttpOnly' } : {}) } });
  });
  vi.stubGlobal('fetch', fetch);
  const app = await connectEvaluationApp('http://127.0.0.1:3010', 'test-password', selection.providerId, selection.modelId, 'fresh');
  const diagnostics = vi.fn();
  try {
    const result = app.execute('case', 'batch', 'key', async () => {}, () => {}, diagnostics);
    if (status === 'failed') await expect(result).rejects.toMatchObject({ code: 'FIRST_RESPONSE_TIMEOUT', usage: null });
    else await expect(result).resolves.toMatchObject({ output: { kind: 'extract' } });
    expect(polls).toBe(2);
    expect(diagnostics.mock.calls.at(-1)![0]).toEqual({ progress, request, transport, boundPromptHash: 'a'.repeat(64) });
    const posts = fetch.mock.calls.filter(([url, options]) => url.endsWith('/ai/evaluations') && options.method === 'POST');
    expect(posts).toHaveLength(1); expect(JSON.parse(posts[0]![1].body as string).connectionPolicy).toBe('fresh');
  } finally { await app.close(); }
});
