import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { connectionPolicySchema, IDEMPOTENCY_KEY_PATTERN, aiModelSelectionSchema, taskTimeoutMs } from '@sanxing/contracts';
import { EVALUATION_VERSION, evaluationCases } from '@sanxing/learning-agent/evaluations';
import { DomainError, record, type LearningService, type RunWorker } from '@sanxing/learning-domain';
import type { AiModelRuntime } from '../ai-runtime.ts';
import type { ApiConfig } from '../config.ts';

/** Fixed synthetic inputs only; credentials remain in the running application's vault. */
export function registerEvaluationRoutes(app: FastifyInstance, options: { service: LearningService; worker: RunWorker; models: AiModelRuntime; config: ApiConfig }) {
  const { service, worker, models, config } = options;
  app.get('/api/ai/evaluations', () => ({ suite: EVALUATION_VERSION, caseIds: evaluationCases.map(item => item.id), maxOutputTokens: config.maxOutputTokens, connectionPolicy: config.connectionPolicy ?? 'pooled',
    timeoutMs: Math.max(...evaluationCases.map(item => taskTimeoutMs(item.task.kind, config))) }));
  app.post('/api/ai/evaluations', async (request, reply) => {
    const body = z.strictObject({ confirm: z.literal(true), suite: z.literal(EVALUATION_VERSION), batchId: z.uuid(), caseId: z.string(), expectedSelection: aiModelSelectionSchema, connectionPolicy: connectionPolicySchema.optional() }).parse(request.body);
    const item = evaluationCases.find(item => item.id === body.caseId);
    if (!item) throw new DomainError('EVALUATION_CASE_UNKNOWN', '样例不存在', 400);
    const key = z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
    const result = await service.command('POST:/api/ai/evaluations', key, body, async data => {
      const selection = await models.assertConnectionTest(data, body.expectedSelection.providerId, body.expectedSelection);
      return service.evaluate(data, item.task, { suite: body.suite, caseId: item.id, batchId: body.batchId, selection, ...(body.connectionPolicy ? { connectionPolicy: body.connectionPolicy } : {}) });
    });
    void worker.tick();
    return reply.code(202).send(result);
  });
  app.get('/api/ai/evaluations/:id', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    // Capture live diagnostics before a queued read; completion can commit while it waits.
    const before = worker.diagnostics(id);
    const repository = service.repository;
    const run = repository.run ? await repository.run(id) : record((await repository.read()).runs, id);
    if (!run) throw new DomainError('EVALUATION_NOT_FOUND', '样例运行不存在', 404);
    if (!run.evaluation) throw new DomainError('EVALUATION_NOT_FOUND', '样例运行不存在', 404);
    const live = worker.diagnostics(id) ?? before;
    return { id: run.id, status: run.status, task: run.task, evaluation: run.evaluation, usage: run.usage, error: run.error, errorCode: run.errorCode,
      progress: run.progress ?? live?.progress, request: run.request ?? live?.request, transport: run.transport ?? live?.transport,
      diagnosticsPending: !run.progress && Boolean(live),
      promptVersion: run.promptVersion, promptHash: run.promptHash, startedAt: run.startedAt, finishedAt: run.finishedAt };
  });
}
