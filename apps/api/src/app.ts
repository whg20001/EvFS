import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { FastifyRequest } from 'fastify';
import { IDEMPOTENCY_KEY_PATTERN, LIMITS, documentUploadLimit, isPdfFilename, isImageFilename, imageImportInputSchema, type DocumentImport, type AppData, type CommandResult, type LearningEngine, type LearningPreferencesView, type PublicDocument } from '@sanxing/contracts';
import { DomainError, LearningService, RunWorker, effectiveLearningPreferences, record, searchLibrary, learningStatistics, projectState, publicQuiz, previewKnowledgeMerge, resolvedKnowledgeId, reviewPlan } from '@sanxing/learning-domain';
import type { Repository } from '@sanxing/database';
import { learningMutations } from '@sanxing/learning-domain';
import type { ApiConfig } from './config.ts';
import type { AiAccessController } from '@sanxing/ai-access';
import { registerAiRoutes } from './routes/ai.ts';
import { registerEvaluationRoutes } from './routes/evaluations.ts';
import { registerSkillRoutes } from './routes/skills.ts';
import { createCloudSkillCatalog, type CloudSkillCatalog } from './cloud-skills.ts';
import { AiModelRuntime } from './ai-runtime.ts';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import { createPdfImporter } from './pdf-import.ts';
import { StateSync } from './state-sync.ts';
import { readEntity, readFields } from './repository-reads.ts';
import { loginClientAddress } from './client-address.ts';
import { registerOcrRoutes, type OcrRecognizer } from './ocr.ts';

export async function createApp(options: { config: ApiConfig; repository: Repository; engine: LearningEngine; modelRuntime?: AiModelRuntime; aiAccess?: AiAccessController; cloudSkills?: CloudSkillCatalog; now?: () => Date; startWorker?: boolean; ocrRecognizer?: OcrRecognizer }) {
  const { config, repository, engine } = options;
  // JSON may encode each UTF-16 unit as six bytes (\\uXXXX); upload byte limits
  // are separately enforced by multipart and the document domain validator.
  const bodyLimit = Math.max(config.maxUploadBytes * 6 + 24000, LIMITS.recitationFieldChars * 3 * 6 + 2048, LIMITS.answerChars * 6 + 2048);
  const app = Fastify({ logger: false, bodyLimit, trustProxy: false, forceCloseConnections: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(multipart, { limits: { files: 1, fileSize: LIMITS.pdfUploadBytes, fieldSize: LIMITS.ocrTextChars * 4 + 16000, fields: 2, parts: 3 } });
  const pdfImporter = createPdfImporter();
  const models = options.modelRuntime ?? new AiModelRuntime({ config, repository, credentials: options.aiAccess?.credentials });
  const service = new LearningService(repository, config, options.now, (task, data) => models.prepareTask(data, task), describeLearningPrompt);
  const worker = new RunWorker(service, engine);
  const stateSync = new StateSync(() => service.state(''), repository.revision ? () => repository.revision!() : undefined);
  const compactSync = new StateSync(async () => projectState(await repository.read(), config, '', true), () => repository.revision());
  const sessions = new Map<string, { csrfToken: string; expires: number }>();
  const attempts = new Map<string, { count: number; since: number }>();
  let aiRoutes: ReturnType<typeof registerAiRoutes> | undefined;
  const invalidateSession = (id: string) => { sessions.delete(id); void aiRoutes?.closeOwner(id).catch(() => undefined); };
  const salt = createHash('sha256').update(config.sessionSecret).digest();
  const passwordHash = scryptSync(config.ownerPassword, salt, 32);
  const authenticate = (request: FastifyRequest) => {
    const raw = request.cookies.sanxing_session; if (!raw) return null;
    const signed = request.unsignCookie(raw); if (!signed.valid || !signed.value) return null;
    const identity = sessions.get(signed.value);
    if (!identity || identity.expires < Date.now()) { invalidateSession(signed.value); return null; }
    return { id: signed.value, ...identity };
  };
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.status(400).send({ error: { code: 'INVALID_INPUT', message: '输入格式或长度不符合要求，请检查后重试。' } });
    const status = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.status(status >= 400 && status < 500 ? status : 500).send({ error: { code: status === 413 ? 'FILE_TOO_LARGE' : 'REQUEST_FAILED', message: status === 413 ? '文件或请求内容超过大小限制。' : '请求未能完成，已保存的内容不会丢失。' } });
  });
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); return payload; });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path?.startsWith('/api/')) return;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (isWrite && request.headers.origin && !config.allowedOrigins.includes(request.headers.origin)) return reply.status(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: '请求来源不受信任。' } });
    if (['/api/auth/login', '/api/auth/status', '/api/health'].includes(path)) return;
    const identity = authenticate(request);
    if (!identity) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: '请先登录个人学习空间。' } });
    if (isWrite && request.headers['x-csrf-token'] !== identity.csrfToken) return reply.status(403).send({ error: { code: 'CSRF_REJECTED', message: '安全令牌已失效，请刷新或重新登录。' } });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/status', async request => ({ authenticated: Boolean(authenticate(request)), mode: config.mode }));
  app.post('/api/auth/login', async (request, reply) => {
    const body = z.object({ password: z.string().max(512) }).parse(request.body);
    const now = Date.now(); const address = loginClientAddress(request, config.sessionSecret, now); const prior = attempts.get(address);
    const attempt = prior && now - prior.since < 15 * 60_000 ? prior : { count: 0, since: now };
    if (attempt.count >= 8) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: '尝试过于频繁，请 15 分钟后再试。' } });
    attempt.count++; attempts.set(address, attempt);
    if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!);
    if (!timingSafeEqual(passwordHash, scryptSync(body.password, salt, 32))) return reply.status(401).send({ error: { code: 'INVALID_PASSWORD', message: '访问密码不正确。' } });
    attempts.delete(address);
    for (const [key, value] of sessions) if (value.expires < now) invalidateSession(key);
    if (sessions.size >= 20) invalidateSession(sessions.keys().next().value!);
    const id = randomBytes(32).toString('hex'); const csrfToken = randomBytes(32).toString('hex');
    sessions.set(id, { csrfToken, expires: now + 12 * 60 * 60_000 });
    reply.setCookie('sanxing_session', id, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.appOrigin.startsWith('https:'), signed: true, maxAge: 12 * 60 * 60 });
    return { csrfToken };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const identity = authenticate(request);
    if (identity) { sessions.delete(identity.id); await aiRoutes?.closeOwner(identity.id); }
    reply.clearCookie('sanxing_session', { path: '/' }); return { ok: true };
  });
  app.get('/api/state', async request => {
    const { since, compact } = z.object({ compact: z.literal('1').optional(), since: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe()).optional() }).parse(request.query);
    const csrfToken = authenticate(request)!.csrfToken;
    const sync = compact ? compactSync : stateSync;
    return since === undefined ? sync.get(csrfToken) : sync.get(csrfToken, since);
  });
  app.get('/api/runs/progress', async () => worker.progress());
  app.get('/api/me', async request => ({ mode: config.mode, timezone: config.timezone, csrfToken: authenticate(request)!.csrfToken,
    capabilities: { maxUploadBytes: config.maxUploadBytes, maxDocuments: config.maxDocuments, maxFollowups: config.maxFollowups, quizCount: config.quizCount, schedulingEnabled: (await (repository.learningPreferences?.() ?? repository.read().then(data => data.learningPreferences)))?.schedulingEnabled ?? config.schedulingEnabled } }));

  aiRoutes = registerAiRoutes(app, {
    access: options.aiAccess, repository, config, models, owner: request => authenticate(request)!, now: options.now ?? (() => new Date()),
    connectionTest: async (providerId, body, key) => {
      const result = await service.command(`POST:/api/ai/providers/${providerId}/test`, key, body, async data => {
        const selection = await models.assertConnectionTest(data, providerId, body.expectedSelection);
        return service.connectionTest(data, selection);
      });
      // The durable learning-command receipt also fences potentially billed test retries.
      if (result.runId) void worker.tick();
      return result.runId!;
    },
  });
  registerEvaluationRoutes(app, { service, worker, models, config });
  registerSkillRoutes(app, service, options.cloudSkills ?? createCloudSkillCatalog(config));
  registerOcrRoutes(app, { config, owner: request => authenticate(request)!.id, recognizer: options.ocrRecognizer });

  type Mutation = (data: AppData, request: FastifyRequest, body: unknown) => CommandResult;
  const id = (request: FastifyRequest, key = 'id') => z.record(z.string(), z.string()).parse(request.params)[key]!;
  const writeKey = (request: FastifyRequest) => z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
  app.get('/api/documents/:id', async request => {
    const document = await readEntity(repository, 'documents', id(request));
    // Explicit whitelist: no storage paths, hashes, or original upload bytes.
    return { id: document.id, recitationId: document.recitationId, name: document.name, text: document.text,
      lineCount: document.lineCount, createdAt: document.createdAt, ...(document.import ? { import: document.import } : {}) } satisfies PublicDocument;
  });
  app.get('/api/documents/:id/original', async (request, reply) => {
    const document = await readEntity(repository, 'documents', id(request));
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`);
    return reply.send(Buffer.from(document.originalBase64, 'base64'));
  });
  // Read-only POSTs accept unsaved editor content without putting private text in URLs.
  // Cookie/Origin/CSRF still apply; no receipt, write transaction, task, or model call.
  app.post('/api/library/search', async request => {
    const { query, kind, ...options } = z.object({ query: z.string().max(LIMITS.libraryQueryChars), kind: z.enum(['document', 'knowledge']).optional(), offset: z.number().int().nonnegative().safe().optional(), limit: z.number().int().min(1).max(LIMITS.libraryPageSizeMaximum).optional(), includeUnderstanding: z.boolean().optional(), expandTerms: z.boolean().optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict().parse(request.body);
    return searchLibrary(await readFields(repository, ['revision', 'documents', 'knowledge']), query, kind, options);
  });
  app.get('/api/learning/statistics', async request => {
    const { days } = z.object({ days: z.enum(['7', '30', '90', '0']).default('30') }).strict().parse(request.query);
    return learningStatistics(await readFields(repository, ['revision', 'mode', 'knowledge', 'evidence', 'quizzes', 'cards', 'reviewSessions', 'reviewEvents']), options.now?.() ?? new Date(), config.timezone, Number(days) as 0 | 7 | 30 | 90);
  });
  app.get('/api/reviews/plan', async () => reviewPlan(await readFields(repository, ['revision', 'mode', 'learningPreferences', 'knowledge', 'cards', 'quizzes', 'evidence']), config, options.now?.() ?? new Date()));
  app.get('/api/quizzes/:id', async request => publicQuiz(await readEntity(repository, 'quizzes', id(request))));
  app.get('/api/knowledge-points/:id/evidence', async request => {
    const query = z.object({ offset: z.coerce.number().int().nonnegative().safe().default(0), limit: z.coerce.number().int().min(1).max(50).default(20), expectedRevision: z.coerce.number().int().nonnegative().optional() }).strict().parse(request.query);
    const data = await readFields(repository, ['revision', 'knowledge', 'evidence']); const point = record(data.knowledge, id(request));
    if (query.expectedRevision !== undefined && query.expectedRevision !== data.revision) throw new DomainError('EVIDENCE_CHANGED', '记录已变化，请重新加载第一页', 409);
    const items = Object.values(data.evidence).filter(item => point.merge ? item.knowledgeId === point.id : resolvedKnowledgeId(data, item.knowledgeId) === point.id).sort((a, b) => b.answer.submittedAt.localeCompare(a.answer.submittedAt) || a.id.localeCompare(b.id));
    const end = query.offset + query.limit;
    return { revision: data.revision, total: items.length, nextOffset: end < items.length ? end : null, items: items.slice(query.offset, end) };
  });
  app.post('/api/knowledge-points/:id/merge-preview', async request => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).strict().parse(request.body);
    return previewKnowledgeMerge(await repository.read(), id(request), targetId);
  });
  app.get('/api/learning/preferences', async () => {
    const data = await readFields(repository, ['revision', 'learningPreferences']);
    return { revision: data.revision, source: data.learningPreferences ? 'saved' : 'environment',
      ...effectiveLearningPreferences(data, config) } satisfies LearningPreferencesView;
  });
  app.post('/api/recitations/:id/input-preview', async request => {
    const body = z.object({ input: z.unknown() }).parse(request.body);
    const data = await repository.read();
    const task = service.previewRecitationTask(data, id(request), body.input);
    return models.previewTask(data, task);
  });
  app.post('/api/questions/:id/input-preview', async request => {
    const data = await repository.read();
    const task = service.previewAnswerTask(data, id(request), request.body);
    return models.previewTask(data, task);
  });
  function mutation(method: 'POST' | 'PUT' | 'DELETE', url: string, handler: Mutation) {
    app.route({ method, url, handler: async (request, reply) => {
      const key = writeKey(request);
      const body = request.body ?? {};
      const cancelled: string[] = [];
      const result = await service.command(`${method}:${request.url.split('?')[0]}`, key, body, async data => {
        const next = handler(data, request, body);
        if (next.runId && data.runs[next.runId]?.status === 'pending') await models.assertCanQueue(data);
        for (const runId of worker.activeRunIds()) {
          const status = data.runs[runId]?.status;
          if (status !== 'running' && status !== 'pending') cancelled.push(runId);
        }
        return next;
      });
      // Abort only the current in-memory attempt, and only after a successful commit.
      for (const runId of cancelled) worker.cancel(runId);
      if (result.runId) { void worker.tick(); reply.code(202); }
      return result;
    } });
  }
  for (const item of learningMutations) mutation(item.method, item.path, (data, request, body) => item.apply(service, data, (request.params ?? {}) as Record<string, string>, body));
  app.post('/api/documents', async (request, reply) => {
    const key = writeKey(request);
    let input: unknown; let bytes: Buffer | undefined; let parsedDocument: { text: string; import: DocumentImport } | undefined;
    if (request.isMultipart()) {
      const file = await request.file(); if (!file) throw new DomainError('FILE_REQUIRED', '请选择笔记、PDF 或图片文件');
      bytes = await file.toBuffer();
      if (file.file.truncated) throw new DomainError('FILE_TOO_LARGE', '文件超过限制', 413);
      if (bytes.byteLength > documentUploadLimit(file.filename, config.maxUploadBytes)) throw new DomainError('FILE_TOO_LARGE', '文件超过限制', 413);
      const query = z.object({ recitationId: z.string() }).parse(request.query);
      input = { recitationId: query.recitationId, name: file.filename, text: '' };
      if (isImageFilename(file.filename)) {
        const field = file.fields.ocr;
        if (!field || Array.isArray(field) || field.type !== 'field') throw new DomainError('IMAGE_OCR_REQUIRED', '图片需要先完成 OCR 并确认文字后导入。', 400);
        let metadata: unknown;
        try { metadata = JSON.parse(z.string().parse(field.value)); }
        catch { throw new DomainError('IMAGE_OCR_REQUIRED', '图片识别信息无效，请重新识别并确认文字。', 400); }
        parsedDocument = imageImportInputSchema.parse(metadata);
      }
      if (isPdfFilename(file.filename)) {
        record((await repository.read()).recitations, query.recitationId);
        parsedDocument = await pdfImporter.parse(bytes);
      }
    } else input = request.body;
    const receiptInput = bytes ? { input, hash: createHash('sha256').update(bytes).digest('hex'), ...(parsedDocument?.import.format === 'image' ? { ocr: parsedDocument } : {}) } : input;
    const result = await service.command('POST:/api/documents', key, receiptInput, data => service.addDocument(data, input, bytes, parsedDocument));
    return reply.code(201).send(result);
  });

  if (options.startWorker !== false) await worker.start();
  app.addHook('onClose', async () => { await pdfImporter.close(); await worker.stop(); await models.close(); sessions.clear(); await options.aiAccess?.close(); });
  return { app, service, worker };
}
