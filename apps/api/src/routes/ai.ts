import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_KEY_PATTERN, aiModelSelectionSchema, type AiAccessOverview, type AiConnectionTestView, type AiModelSelection } from '@sanxing/contracts';
import { AiAccessError, type AiAccessController } from '@sanxing/ai-access';
import { LIVE_PROVIDER_IDS } from '@sanxing/ai-access/providers';
import { tokenUsageHeatmap } from '@sanxing/ai-usage';
import { DomainError, learningDate } from '@sanxing/learning-domain';
import type { Repository } from '@sanxing/database';
import type { ApiConfig } from '../config.ts';
import type { AiModelRuntime } from '../ai-runtime.ts';

/** HTTP adapter only: OAuth lifecycle and credentials belong to ai-access. */
export function registerAiRoutes(app: FastifyInstance, options: {
  access?: AiAccessController; repository: Repository; config: ApiConfig; models: AiModelRuntime;
  owner: (request: FastifyRequest) => { id: string; expires: number }; now: () => Date;
  connectionTest: (providerId: string, body: { confirm: true; expectedSelection: AiModelSelection }, key: string) => Promise<string>;
}) {
  const { access, repository, config, models, owner, now } = options;
  const receipts = new Map<string, { hash: string; expires: number; response: Promise<unknown> }>();
  const requireAccess = () => { if (!access) throw new DomainError('AI_AUTH_NOT_CONFIGURED', 'AI 授权服务尚未初始化。', 503); return access; };
  const param = (request: FastifyRequest, key: string) => z.record(z.string(), z.string().min(1).max(200)).parse(request.params)[key]!;

  app.get('/api/ai/access', async request => {
    const response: AiAccessOverview = {
      mode: config.mode,
      providers: access ? await access.providers(owner(request).id) : [],
      notice: access ? '授权仅保存本应用的连接，不会自动切换演示/真实模式、选择模型或批准资料外发与费用。已保存凭据不等于厂商已验证当前账号可调用。' : '本测试实例未初始化 OAuth；用量查看仍可使用。',
    };
    return response;
  });
  // Model preferences have their own read cycle; OAuth polling does not read the learning aggregate.
  app.get('/api/ai/configuration', () => models.configuration());
  app.get('/api/ai/usage', async request => {
    const query = z.object({ year: z.coerce.number().int().min(1970).max(2100).optional() }).parse(request.query);
    const snapshot = await repository.read();
    return tokenUsageHeatmap({ runs: Object.values(snapshot.runs).map(run => ({ startedAt: run.startedAt, usage: run.usage })), mode: snapshot.mode, timezone: config.timezone, year: query.year ?? Number(learningDate(now(), config.timezone).slice(0, 4)), now: now() });
  });

  async function testView(providerId: string, runId?: string): Promise<AiConnectionTestView | null> {
    const data = await repository.read();
    const run = Object.values(data.runs)
      .filter(run => run.task.kind === 'connection_test' && run.task.selection.providerId === providerId && (!runId || run.id === runId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!run || run.task.kind !== 'connection_test') return null;
    return { id: run.id, providerId, modelId: run.task.selection.modelId, mode: data.mode, status: run.status,
      createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      durationMs: run.startedAt && run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null,
      usage: run.usage, error: run.error, ...(run.errorCode ? { errorCode: run.errorCode } : {}) };
  }
  app.get('/api/ai/providers/:providerId/test', async request => ({ test: await testView(z.enum(LIVE_PROVIDER_IDS).parse(param(request, 'providerId'))) }));
  app.post('/api/ai/providers/:providerId/test', async (request, reply) => {
    const providerId = z.enum(LIVE_PROVIDER_IDS).parse(param(request, 'providerId'));
    const body = z.strictObject({ confirm: z.literal(true), expectedSelection: aiModelSelectionSchema }).parse(request.body);
    const key = z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
    // Unlike OAuth receipts, test receipts must survive process restarts to avoid duplicate paid calls.
    const runId = await options.connectionTest(providerId, body, key);
    return reply.code(202).send(await testView(providerId, runId));
  });

  function mutation(path: string, action: (request: FastifyRequest, identity: { id: string; expires: number }) => Promise<unknown>) {
    app.post(path, async request => {
      const identity = owner(request);
      const requestKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
      const key = `${identity.id}:${request.url}:${requestKey}`;
      const hash = createHash('sha256').update(JSON.stringify(request.body ?? {})).digest('hex');
      for (const [id, receipt] of receipts) if (receipt.expires <= Date.now()) receipts.delete(id);
      const previous = receipts.get(key);
      if (previous) {
        if (previous.hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容。');
        return previous.response;
      }
      if (receipts.size >= 256) throw new DomainError('AI_AUTH_RATE_LIMIT', '授权操作过于频繁，请稍后重试。', 429);
      const response = Promise.resolve().then(() => action(request, identity)).catch(error => {
        receipts.delete(key);
        if (error instanceof AiAccessError) throw new DomainError(error.code, error.message, error.status);
        throw error;
      });
      // Codes are never saved in the learning DB, receipts or logs; this cache holds only a hash and public DTO.
      receipts.set(key, { hash, response, expires: Math.min(identity.expires, Date.now() + 10 * 60_000) });
      return response;
    });
  }
  mutation('/api/ai/configuration', request => models.save(request.body));
  mutation('/api/ai/oauth/:providerId/start', (request, identity) => {
    z.strictObject({}).parse(request.body ?? {});
    return requireAccess().start(param(request, 'providerId'), identity.id, identity.expires);
  });
  mutation('/api/ai/oauth/sessions/:id/input', (request, identity) => {
    const body = z.strictObject({ promptId: z.string().uuid(), value: z.string().max(16_384) }).parse(request.body);
    return requireAccess().submit(param(request, 'id'), body.promptId, body.value, identity.id);
  });
  mutation('/api/ai/oauth/sessions/:id/cancel', (request, identity) => requireAccess().cancel(param(request, 'id'), identity.id));
  mutation('/api/ai/providers/:providerId/disconnect', async request => { await requireAccess().disconnect(param(request, 'providerId')); return { ok: true }; });
  return {
    async closeOwner(id: string) {
      for (const key of receipts.keys()) if (key.startsWith(`${id}:`)) receipts.delete(key);
      await access?.cancelOwner(id);
    },
  };
}
