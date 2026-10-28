import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN, activityModuleSchema, aiModelSelectionSchema, storedAiTaskSchema, learningPreferencesSchema, usageSchema, type AppData, type AiModelSelection, type LearningPreferences, type Usage, type LocalBootstrap } from '@sanxing/contracts';
import { openAiAccess, AiAccessError, type AiAccessController } from '@sanxing/ai-access';
import { DomainError, learningDate } from '@sanxing/learning-domain';
import { emptyData } from '@sanxing/database/empty';
import { learningPrompts } from '@sanxing/learning-agent/request';
import { LearningTransport, type createLearningEngine } from '@sanxing/learning-agent';
import type { Accounts, Account } from './accounts.ts';
import type { ApiConfig } from './config.ts';
import { AiModelRuntime } from './ai-runtime.ts';
import { createCloudSkillCatalog } from './cloud-skills.ts';
import { loginClientAddress } from './client-address.ts';
import { PlatformAi } from './platform-ai.ts';
import { serverMetrics } from './server-metrics.ts';
import { adminRoutes } from './admin-routes.ts';
import { registerOcrRoutes, type OcrRecognizer } from './ocr.ts';
import { LIMITS } from '@sanxing/contracts';

type Identity = { id: string; user: Account; version: number; csrfToken: string; expires: number };
const username = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/).transform(value => value.toLowerCase());
const credentials = z.strictObject({ username, password: z.string().min(12).max(128) });

/** Identity + an on-demand AI gateway. No learning repository or learning HTTP routes exist here. */
export async function createGatewayApp(options: { config: ApiConfig; accounts: Accounts;
  accessFactory?: (user: Account) => Promise<AiAccessController>; engineFactory?: typeof createLearningEngine; ocrRecognizer?: OcrRecognizer }) {
  const { config, accounts } = options;
  await accounts.recover();
  await accounts.bootstrapAdmins(config.adminUsernames);
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false, forceCloseConnections: true });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(multipart, { limits: { files: 1, fileSize: LIMITS.imageUploadBytes, fields: 0, parts: 1 } });
  const sessions = new Map<string, Identity>();
  const vaults = new Map<string, Promise<AiAccessController>>();
  const active = new Map<string, { sessionId: string; controller: AbortController }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const receipts = new Map<string, { hash: string; response: Promise<unknown>; expires: number }>();
  const cloud = createCloudSkillCatalog(config);
  const transport = new LearningTransport();
  const platform = new PlatformAi(accounts, config);
  const metrics = serverMetrics();
  const sign = (value: string) => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  async function closeIdentity(identity: Identity) {
    sessions.delete(identity.id);
    for (const item of active.values()) if (item.sessionId === identity.id) item.controller.abort('CANCELLED');
    for (const key of receipts.keys()) if (key.startsWith(`${identity.id}:`)) receipts.delete(key);
    const access = vaults.get(identity.user.id); if (access) await (await access).cancelOwner(identity.id);
  }
  function identity(request: FastifyRequest): Identity | null {
    const signed = request.cookies.sanxing_session ? request.unsignCookie(request.cookies.sanxing_session) : null;
    const value = signed?.valid && signed.value ? sessions.get(signed.value) : undefined;
    if (!value) return null;
    if (value.expires <= Date.now()) { void closeIdentity(value); return null; }
    return value;
  }
  const owner = (request: FastifyRequest) => { const value = identity(request); if (!value) throw new DomainError('UNAUTHENTICATED', '请先登录学习空间。', 401); return value; };
  async function freshIdentity(request: FastifyRequest) {
    const value = identity(request); if (!value) return null;
    const account = await accounts.sessionAccount(value.user.id);
    if (!account || account.status !== 'active' || account.version !== value.version) { await closeIdentity(value); return null; }
    value.user = account.user; return value;
  }
  async function revoke(id: string) { for (const value of sessions.values()) if (value.user.id === id) await closeIdentity(value); }
  async function access(user: Account) {
    let value = vaults.get(user.id);
    if (!value) {
      if (vaults.size >= 256) throw new DomainError('GATEWAY_BUSY', '服务繁忙，请稍后重试。', 503);
      value = (options.accessFactory ? options.accessFactory(user) : openAiAccess({ directory: join(config.aiAuthDir, 'accounts', user.id), secret: sign(`sanxing:account-vault:${user.id}`) }));
      vaults.set(user.id, value); value.catch(() => { vaults.delete(user.id); });
    }
    return value;
  }
  async function runtime(user: Account, selection: AiModelSelection | null = null, preferences?: LearningPreferences, executionConfig?: ApiConfig) {
    // The ephemeral object has settings only. It never receives task text or enters a database.
    const settings: AppData = { ...emptyData(config.mode), ownerId: user.id, aiModel: selection, ...(preferences ? { learningPreferences: preferences } : {}) };
    return new AiModelRuntime({ config: executionConfig ?? { ...config, model: undefined, apiKey: undefined }, credentials: (await access(user)).credentials, engineFactory: options.engineFactory, transport,
      repository: { read: async () => structuredClone(settings), aiSettings: async () => structuredClone(settings), transact: async () => { throw new Error('Cloud model preferences belong on the device'); } } });
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError || error instanceof AiAccessError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '输入格式或长度不符合要求，请检查后重试。' } });
    return reply.code(500).send({ error: { code: 'REQUEST_FAILED', message: '请求未完成，请稍后重试。' } });
  });
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); return payload; });
  app.addHook('preHandler', async request => {
    if (!request.url.startsWith('/api/')) return;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (write && request.headers.origin && !config.allowedOrigins.includes(request.headers.origin)) throw new DomainError('ORIGIN_FORBIDDEN', '请求来源不受信任。', 403);
    if (['/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/health'].includes(request.url.split('?')[0]!)) return;
    const user = await freshIdentity(request); if (!user) throw new DomainError('UNAUTHENTICATED', '登录状态已失效，请重新登录。', 401);
    if (write && request.headers['x-csrf-token'] !== user.csrfToken) throw new DomainError('CSRF_REJECTED', '登录令牌已失效，请重新登录。', 403);
  });
  app.get('/api/health', async () => ({ ok: true, storage: 'browser' }));
  app.get('/api/auth/status', async request => {
    const value = await freshIdentity(request);
    return { authenticated: !!value, storage: 'browser', mode: config.mode, registrationEnabled: config.allowRegistration,
      user: value?.user ?? null, ...(value ? { csrfToken: value.csrfToken, expiresAt: value.expires } : {}) };
  });
  function authenticate(path: '/api/auth/login' | '/api/auth/register', register: boolean) {
    app.post(path, async (request, reply) => {
      if (register && !config.allowRegistration) throw new DomainError('REGISTRATION_DISABLED', '当前服务未开放注册。', 403);
      const address = loginClientAddress(request, config.sessionSecret, Date.now());
      const now = Date.now();
      for (const [key, item] of attempts) if (item.expires <= now) attempts.delete(key);
      const key = `${register}:${address}`; const attempt = attempts.get(key) ?? { count: 0, expires: now + 15 * 60_000 };
      if (++attempt.count > (register ? config.registrationLimit : 10)) throw new DomainError('RATE_LIMITED', '操作过于频繁，请稍后重试。', 429);
      attempts.set(key, attempt); if (attempts.size > 10000) attempts.delete(attempts.keys().next().value!);
      const input = credentials.parse(request.body);
      const proof = register ? { user: await accounts.register(input.username, input.password), version: 0 } : await accounts.verifyCredentials(input.username, input.password);
      const user = proof.user;
      const old = identity(request); if (old) await closeIdentity(old);
      for (const value of sessions.values()) if (value.expires <= now) await closeIdentity(value);
      if (sessions.size >= 5000) throw new DomainError('SERVICE_BUSY', '服务繁忙，请稍后重试。', 503);
      const current = await accounts.sessionAccount(user.id);
      if (!current || current.status !== 'active' || current.version !== proof.version) throw new DomainError('UNAUTHENTICATED', '账号信息已更新，请重新登录。', 401);
      const value: Identity = { id: randomBytes(32).toString('hex'), user: current.user, version: current.version, csrfToken: randomBytes(32).toString('hex'), expires: now + 12 * 60 * 60_000 };
      sessions.set(value.id, value); if (!register) attempts.delete(key);
      await accounts.activity(user.id, register ? 'register' : 'login');
      reply.setCookie('sanxing_session', value.id, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.appOrigin.startsWith('https:'), signed: true, maxAge: 12 * 60 * 60 });
      return { user: value.user, storage: 'browser', mode: config.mode, csrfToken: value.csrfToken, expiresAt: value.expires };
    });
  }
  authenticate('/api/auth/login', false); authenticate('/api/auth/register', true);
  app.post('/api/auth/logout', async (request, reply) => { const value = owner(request); await accounts.activity(value.user.id, 'logout'); await closeIdentity(value); reply.clearCookie('sanxing_session', { path: '/' }); return { ok: true }; });
  app.post('/api/activity/heartbeat', async request => { const { module } = z.strictObject({ module: activityModuleSchema }).parse(request.body); await accounts.activity(owner(request).user.id, 'page_view', module); return { ok: true }; });
  adminRoutes(app, { accounts, config, platform, owner, revoke, metrics, counts: () => ({ active: active.size, sessions: [...sessions.values()].filter(item => item.expires > Date.now()).length }) });
  registerOcrRoutes(app, { config, owner: request => owner(request).user.id, recognizer: options.ocrRecognizer });
  app.get('/api/gateway/bootstrap', async request => {
    const value = owner(request); const models = await runtime(value.user);
    try {
      const { mode, timezone, maxUploadBytes, maxDocuments, maxFollowups, quizCount, schedulingEnabled, maxCallsPerSession, dailyBudgetUsd, requestReservationUsd, runTimeoutMs, quizTimeoutMs, firstResponseTimeoutMs, streamIdleTimeoutMs } = config;
      return { user: value.user, csrfToken: value.csrfToken, expiresAt: value.expires, config: { mode, timezone, maxUploadBytes, maxDocuments, maxFollowups, quizCount, schedulingEnabled, maxCallsPerSession, dailyBudgetUsd, requestReservationUsd, runTimeoutMs, quizTimeoutMs, firstResponseTimeoutMs, streamIdleTimeoutMs },
        configuration: await platform.catalog(value.user.id, await models.configuration()), maxOutputTokens: config.maxOutputTokens, prompts: learningPrompts } satisfies LocalBootstrap;
    } finally { await models.close(); }
  });
  app.get('/api/gateway/catalog', async request => { const user = owner(request).user; const models = await runtime(user); try { return await platform.catalog(user.id, await models.configuration()); } finally { await models.close(); } });
  app.post('/api/gateway/selection/check', async request => {
    const selection = aiModelSelectionSchema.parse(request.body);
    if (selection.authMethod === 'platform' || selection.providerId === 'platform') { await platform.resolve(owner(request).user.id, selection); return { ok: true }; }
    const models = await runtime(owner(request).user, selection);
    try { await models.assertSelection(selection); return { ok: true }; } finally { await models.close(); }
  });
  app.get('/api/ai/access', async request => { const value = owner(request); return { mode: config.mode, providers: await (await access(value.user)).providers(value.id), notice: '授权按账号独立保存；学习数据保留在当前设备。' }; });
  function oauth(path: string, action: (request: FastifyRequest, value: Identity, provider: AiAccessController) => Promise<unknown>) {
    app.post(path, async request => {
      const value = owner(request); const key = `${value.id}:${request.url}:${z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key'])}`;
      const hash = sign(JSON.stringify(request.body ?? {}));
      for (const [key, item] of receipts) if (item.expires <= Date.now()) receipts.delete(key);
      const previous = receipts.get(key);
      if (previous) { if (previous.hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同操作。', 409); return previous.response; }
      if (receipts.size >= 2048) throw new DomainError('RATE_LIMITED', '授权操作过于频繁，请稍后重试。', 429);
      const response = Promise.resolve().then(async () => action(request, value, await access(value.user))).catch(error => { receipts.delete(key); throw error; });
      receipts.set(key, { hash, response, expires: Math.min(value.expires, Date.now() + 10 * 60_000) }); return response;
    });
  }
  const parameter = (request: FastifyRequest, key: string) => z.record(z.string(), z.string().min(1).max(200)).parse(request.params)[key]!;
  oauth('/api/ai/oauth/:providerId/start', (request, value, provider) => { z.strictObject({}).parse(request.body ?? {}); return provider.start(parameter(request, 'providerId'), value.id, value.expires); });
  oauth('/api/ai/oauth/sessions/:id/input', (request, value, provider) => { const body = z.strictObject({ promptId: z.uuid(), value: z.string().max(16384) }).parse(request.body); return provider.submit(parameter(request, 'id'), body.promptId, body.value, value.id); });
  oauth('/api/ai/oauth/sessions/:id/cancel', (request, value, provider) => provider.cancel(parameter(request, 'id'), value.id));
  oauth('/api/ai/providers/:providerId/disconnect', async (request, _value, provider) => { z.strictObject({}).parse(request.body ?? {}); await provider.disconnect(parameter(request, 'providerId')); return { ok: true }; });
  app.get('/api/ai/skills/cloud', () => cloud.list());
  app.post('/api/gateway/skills/:name/download', request => { z.strictObject({}).parse(request.body ?? {}); return cloud.download(z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(parameter(request, 'name'))); });
  app.post('/api/gateway/execute', async (request, reply) => {
    const value = owner(request);
    const requestId = z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
    const body = z.strictObject({ task: storedAiTaskSchema, selection: aiModelSelectionSchema.nullable(),
      preferences: learningPreferencesSchema.optional(), cacheScope: z.string().max(200).optional(),
      expectedPrompt: z.strictObject({ version: z.string().min(1).max(100), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional() }).parse(request.body);
    const managed = body.selection && (body.selection.authMethod === 'platform' || body.selection.providerId === 'platform') ? await platform.resolve(value.user.id, body.selection) : null;
    if (managed && body.task.kind === 'connection_test') throw new DomainError('AI_MODEL_INVALID', '平台 AI 不使用个人 OAuth 连通测试。', 400);
    const selection = managed?.selection ?? body.selection;
    const models = await runtime(value.user, selection, body.preferences, managed?.config);
    let admitted = false; let usage: Usage | null = null; let succeeded = false;
    const controller = new AbortController(); const activeKey = `${value.user.id}:${requestId}`;
    try {
      await models.assertCanQueue({ ...emptyData(config.mode), aiModel: selection });
      await accounts.begin({ accountId: value.user.id, authVersion: value.version, requestId, hash: sign(JSON.stringify(body)), day: learningDate(new Date(), config.timezone),
        provider: selection?.providerId ?? 'faux', model: selection?.modelId ?? 'mock', maxDailyCalls: config.gatewayDailyCalls,
        dailyBudget: config.mode === 'live' ? config.dailyBudgetUsd : null, reservation: config.mode === 'live' ? config.requestReservationUsd : 0, ...(managed ? { platform: managed.limits } : {}) });
      admitted = true; active.set(activeKey, { sessionId: value.id, controller });
      reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
      const send = (type: string, data: unknown) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(JSON.stringify({ type, data }) + '\n'); };
      const abort = () => { if (!reply.raw.writableFinished) controller.abort('CANCELLED'); };
      reply.raw.once('close', abort); request.raw.once('aborted', abort);
      const timer = setTimeout(() => controller.abort('TIMEOUT'), Math.max(1, Math.min(value.expires - Date.now(), body.task.kind === 'quiz' ? config.quizTimeoutMs ?? config.runTimeoutMs : config.runTimeoutMs)));
      const heartbeat = setInterval(() => send('heartbeat', null), 10000);
      try {
        const response = await models.execute(body.task, { signal: controller.signal, expectedPrompt: body.expectedPrompt,
          cacheScope: body.cacheScope, onProgress: event => send('progress', event), onRequest: event => send('request', event), onTransport: event => send('transport', event),
          onUsage: async reported => { usage = reported; await accounts.recordUsage(value.user.id, requestId, reported); send('usage', reported); } });
        usage = response.usage; succeeded = true; send('result', response);
      } catch (error) {
        const reported = usageSchema.safeParse(error && typeof error === 'object' && 'usage' in error ? error.usage : null);
        if (reported.success && usage === null) { usage = reported.data; await accounts.recordUsage(value.user.id, requestId, usage); send('usage', usage); }
        const code = controller.signal.aborted ? controller.signal.reason : error && typeof error === 'object' && 'code' in error ? error.code : 'MODEL_FAILED';
        send('error', { code: typeof code === 'string' ? code : 'MODEL_FAILED' });
      } finally { clearTimeout(timer); clearInterval(heartbeat); reply.raw.off('close', abort); request.raw.off('aborted', abort); }
    } finally {
      if (admitted) active.delete(activeKey);
      try { if (admitted) await accounts.finish(value.user.id, requestId, succeeded ? 'succeeded' : 'failed', usage); }
      finally { await models.close(); if (admitted && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end(); }
    }
  });
  app.addHook('onClose', async () => {
    metrics.close();
    for (const value of active.values()) value.controller.abort('SERVICE_RESTARTED');
    sessions.clear(); receipts.clear();
    await Promise.allSettled([...vaults.values()].map(async item => (await item).close()));
    await transport.close();
  });
  return { app };
}
