import { z } from 'zod';
import { openBrowserRepository } from '@sanxing/database/browser';
import { emptyData } from '@sanxing/database/empty';
import { validateData } from '@sanxing/database/validation';
import { LearningService, RunWorker, DomainError, learningMutations, projectState, publicQuiz, record, searchLibrary, learningStatistics,
  reviewPlan, effectiveLearningPreferences, previewKnowledgeMerge, resolvedKnowledgeId, getSkill, saveSkill, configureSkill, deleteSkill, parseSkillFile } from '@sanxing/learning-domain';
import { tokenUsageHeatmap } from '@sanxing/ai-usage';
import { IDEMPOTENCY_KEY_PATTERN, LIMITS, documentUploadLimit, imageImportInputSchema, isImageFilename, skillFileInputSchema, aiModelSelectionSchema, aiOutputSchema, usageSchema, runRequestSchema, runTransportSchema, skillTasksSchema, summarizeSkill, isActiveRun,
  type AppData, type AiResponse, type AiModelConfiguration, type AiConnectionTestView, type LearningEngine, type LocalBootstrap, type SkillDocument } from '@sanxing/contracts';
import { LocalModels } from './local-models';
import { cloudRequest, HttpError, requestId, type RequestOptions } from './api-client';

export type LocalLearning = Awaited<ReturnType<typeof openLocalLearning>>;
export async function openLocalLearning(bootstrap: LocalBootstrap) {
  const repository = await openBrowserRepository(bootstrap.user.id, bootstrap.config.mode);
  const models = new LocalModels(bootstrap);
  let closed = false; let leading = false; let acquiring = false; let releaseLeader: (() => void) | null = null;
  let clock: ReturnType<typeof setInterval> | undefined;
  const headers = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken, 'Idempotency-Key': requestId() });
  const post = <T>(path: string, body: unknown, signal?: AbortSignal) => cloudRequest<T>(path, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
  const ensureOpen = () => { if (closed) throw new HttpError(401, 'LOCAL_STORAGE_CLOSED', '此账号的本地数据库已关闭，请重新登录。'); };
  const engine: LearningEngine = { mode: bootstrap.config.mode, async execute(task, options) {
    ensureOpen(); options.signal.throwIfAborted();
    const data = await repository.aiSettings!();
    const response = await fetch('/api/gateway/execute', { method: 'POST', headers: headers(), credentials: 'same-origin', cache: 'no-store', signal: options.signal,
      body: JSON.stringify({ task, selection: data.aiModel ?? null, preferences: data.learningPreferences, cacheScope: options.cacheScope, expectedPrompt: options.expectedPrompt }) });
    if (!response.ok || !response.body) {
      const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new HttpError(response.status, value?.error?.code ?? 'GATEWAY_FAILED', value?.error?.message ?? 'AI 网关请求未完成。');
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = ''; let bytes = 0; let result: AiResponse | null = null;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { buffer += decoder.decode(); if (buffer.trim()) throw new Error('Incomplete gateway stream'); break; }
        bytes += chunk.value.byteLength; if (bytes > 8 * 1024 * 1024) throw new Error('Gateway output limit');
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; data: unknown };
          if (event.type === 'progress' && ['request', 'response', 'text', 'thinking', 'generated', 'validated'].includes(String(event.data))) options.onProgress?.(event.data as Parameters<NonNullable<typeof options.onProgress>>[0]);
          else if (event.type === 'usage') await options.onUsage?.(usageSchema.parse(event.data));
          else if (event.type === 'request') options.onRequest?.(runRequestSchema.parse(event.data));
          else if (event.type === 'transport') options.onTransport?.(runTransportSchema.parse(event.data));
          else if (event.type === 'error') throw Object.assign(new Error('AI gateway execution failed'), { code: event.data && typeof event.data === 'object' && 'code' in event.data ? event.data.code : 'MODEL_FAILED' });
          else if (event.type === 'result') {
            const value = z.object({ output: aiOutputSchema, usage: usageSchema.nullable() }).parse(event.data);
            if (value.output.kind !== task.kind || result) throw new Error('Invalid gateway result'); result = value;
          }
        }
      }
      if (!result) throw Object.assign(new Error('Gateway stream interrupted'), { code: 'MODEL_STREAM_INTERRUPTED' });
      return result;
    } finally { await reader.cancel().catch(() => undefined); }
  } };
  const service = new LearningService(repository, bootstrap.config, () => new Date(), (task, data) => models.prepareTask(data, task), models.requests.describeLearningPrompt);
  const worker = new RunWorker(service, engine);
  async function tick() { if (leading && !closed) await worker.tick(); }
  async function acquireLeader() {
    if (closed || acquiring || leading || !navigator.locks) return;
    acquiring = true;
    try {
      await navigator.locks.request(`sanxing-worker:${bootstrap.user.id}:${bootstrap.config.mode}`, { ifAvailable: true }, async lock => {
        if (!lock || closed) return;
        leading = true;
        const released = new Promise<void>(resolve => { releaseLeader = resolve; });
        try {
          await service.recoverRuns();
          clock = setInterval(() => { void tick(); }, 700); void tick();
          await released;
        } finally { if (clock) clearInterval(clock); await worker.stop(); leading = false; releaseLeader = null; }
      });
    } finally { acquiring = false; }
  }
  void acquireLeader();
  const election = setInterval(() => { void acquireLeader(); }, 2000);
  const mutationPatterns = learningMutations.map(item => ({ ...item, parts: item.path.slice(4).split('/') }));
  function match(pattern: string[], path: string[]): Record<string, string> | null {
    if (pattern.length !== path.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i]!.startsWith(':')) { let id: string; try { id = decodeURIComponent(path[i]!); } catch { return null; } if (!id || /[/\\\u0000-\u0020]/.test(id)) return null; params[pattern[i]!.slice(1)] = id; }
      else if (pattern[i] !== path[i]) return null;
    }
    return params;
  }
  function testView(data: AppData, providerId: string, runId?: string): AiConnectionTestView | null {
    const run = Object.values(data.runs).filter(run => run.task.kind === 'connection_test' && run.task.selection.providerId === providerId && (!runId || run.id === runId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!run || run.task.kind !== 'connection_test') return null;
    return { id: run.id, providerId, modelId: run.task.selection.modelId, mode: data.mode, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      durationMs: run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null, usage: run.usage, error: run.error, ...(run.errorCode ? { errorCode: run.errorCode } : {}) };
  }
  return {
    async request(path: string, options: RequestOptions = {}): Promise<unknown> {
      ensureOpen(); options.signal?.throwIfAborted();
      const url = new URL(path, 'https://local.invalid'); const parts = url.pathname.split('/'); const method = (options.method ?? 'GET').toUpperCase();
      const query = Object.fromEntries(url.searchParams); const raw = options.body;
      const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw instanceof FormData ? raw : {};
      const key = () => z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(new Headers(options.headers).get('Idempotency-Key'));
      const read = () => repository.read();
      const noActive = (data: AppData) => { if (Object.values(data.runs).some(isActiveRun)) throw new DomainError('RUN_IN_PROGRESS', '请先完成或取消当前 AI 任务。', 409); };
      if (method === 'GET' && url.pathname === '/state') return projectState(await read(), bootstrap.config, bootstrap.csrfToken, true);
      if (method === 'GET' && url.pathname === '/runs/progress') return worker.progress();
      if (method === 'GET' && url.pathname === '/me') { const state = projectState(await read(), bootstrap.config, bootstrap.csrfToken); return { mode: state.mode, timezone: state.timezone, csrfToken: state.csrfToken, capabilities: state.capabilities }; }
      if (method === 'GET' && url.pathname === '/local-data/status') { const data = await read(); return { user: bootstrap.user, mode: data.mode, revision: data.revision, persisted: await navigator.storage?.persisted?.() ?? false,
        counts: { recitations: Object.keys(data.recitations).length, documents: Object.keys(data.documents).length, knowledge: Object.keys(data.knowledge).length, quizzes: Object.keys(data.quizzes).length, skills: data.skills?.length ?? 0 } }; }
      if (method === 'GET' && url.pathname === '/local-data/export') return read();
      if (method === 'POST' && url.pathname === '/local-data/import') {
        try { validateData(body, bootstrap.config.mode, 'local'); }
        catch { throw new DomainError('INVALID_BACKUP', '备份格式、版本或运行模式不兼容，当前数据未修改。', 400); }
        const imported = structuredClone(body); noActive(await read());
        for (const run of Object.values(imported.runs)) if (isActiveRun(run)) { run.status = 'failed'; run.error = '备份恢复后需要明确重试，未自动调用模型。'; run.errorCode = 'SERVICE_RESTARTED'; run.attemptId = null; run.finishedAt = new Date().toISOString(); }
        for (const session of [...Object.values(imported.sessions), ...Object.values(imported.reviewSessions)]) session.activeRunId = null;
        for (const quiz of Object.values(imported.quizzes)) for (const answer of Object.values(quiz.answers)) if (answer.assessment.status === 'pending') { answer.assessment.status = 'needs_verification'; answer.assessment.score = null; }
        await repository.transact(data => { noActive(data); const revision = data.revision; for (const key of Object.keys(data)) delete (data as unknown as Record<string, unknown>)[key]; Object.assign(data, imported, { revision }); }); return { ok: true };
      }
      if (method === 'DELETE' && url.pathname === '/local-data') { await repository.transact(data => { noActive(data); Object.assign(data, { ...emptyData(data.mode), revision: data.revision }); delete data.learningPreferences; delete data.skills; }); return { ok: true }; }
      if (url.pathname === '/ai/configuration') {
        if (method === 'GET') { models.catalog = await cloudRequest<AiModelConfiguration>('/gateway/catalog', { signal: options.signal }); return models.configuration(await read()); }
        if (method === 'POST') {
          const { expectedRevision, ...selection } = aiModelSelectionSchema.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(body);
          await post('/gateway/selection/check', selection, options.signal ?? undefined);
          await repository.transact(data => { if (data.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', '数据已更新，请刷新后保存。', 409); noActive(data); data.aiModel = selection; });
          return models.configuration(await read());
        }
      }
      if (method === 'GET' && url.pathname === '/ai/usage') { const data = await read(); const year = query.year === undefined ? Number(new Intl.DateTimeFormat('en', { timeZone: bootstrap.config.timezone, year: 'numeric' }).format(new Date())) : z.coerce.number().int().min(1970).max(2100).parse(query.year); return tokenUsageHeatmap({ runs: Object.values(data.runs), mode: data.mode, timezone: bootstrap.config.timezone, year, now: new Date() }); }
      if (parts[1] === 'ai' && parts[2] === 'providers' && parts[4] === 'test' && parts.length === 5) {
        const providerId = parts[3]!;
        if (method === 'GET') return { test: testView(await read(), providerId) };
        if (method === 'POST') {
          const input = z.strictObject({ confirm: z.literal(true), expectedSelection: aiModelSelectionSchema }).parse(body);
          const result = await service.command(`POST:/api${url.pathname}`, key(), input, data => { models.validate(input.expectedSelection); if (input.expectedSelection.providerId !== providerId || !(['providerId', 'modelId', 'authMethod', 'allowUnboundedOutput'] as const).every(key => input.expectedSelection[key] === data.aiModel?.[key])) throw new DomainError('AI_TEST_MODEL_CHANGED', '模型选择已变化，请刷新后确认。'); return service.connectionTest(data, input.expectedSelection); });
          void tick(); return testView(await read(), providerId, result.runId);
        }
      }
      if (url.pathname === '/ai/skills' && method === 'GET') { const data = await read(); return { mode: data.mode, items: (data.skills ?? []).map(summarizeSkill) }; }
      if (url.pathname === '/ai/skills/preview' && method === 'POST') { const input = skillFileInputSchema.parse(body); const parsed = parseSkillFile(input.filename, input.content, input.resources); const existing = (await read()).skills?.find(skill => skill.document.name === parsed.document.name); return { ...parsed, existing: existing ? { id: existing.id, version: existing.version } : null }; }
      if (url.pathname === '/ai/skills' && method === 'POST') { const input = skillFileInputSchema.extend({ replace: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict().optional() }).strict().parse(body); const { document } = parseSkillFile(input.filename, input.content, input.resources); return service.command('POST:/api/ai/skills', key(), input, data => saveSkill(data, { document, replace: input.replace }, service.now())); }
      if (parts[1] === 'ai' && parts[2] === 'skills' && parts[3] === 'cloud' && parts[5] === 'download' && parts.length === 6 && method === 'POST') {
        const name = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(parts[4]);
        const document = await post<SkillDocument>(`/gateway/skills/${name}/download`, {}, options.signal ?? undefined);
        return service.command(`POST:/api${url.pathname}`, key(), { name }, data => saveSkill(data, { document }, service.now()));
      }
      if (parts[1] === 'ai' && parts[2] === 'skills' && parts.length === 4) {
        const id = z.uuid().parse(parts[3]);
        if (method === 'GET') return getSkill(await read(), id);
        if (method === 'PUT') { const input = z.strictObject({ version: z.number().int().positive(), enabled: z.boolean(), tasks: skillTasksSchema }).parse(body); return service.command(`PUT:/api${url.pathname}`, key(), input, data => configureSkill(data, id, input, service.now())); }
        if (method === 'DELETE') { const input = z.object({ version: z.number().int().positive() }).parse(body); return service.command(`DELETE:/api${url.pathname}`, key(), input, data => deleteSkill(data, id, input)); }
      }
      if (parts[1] === 'documents' && parts[2] && method === 'GET') { const document = record((await read()).documents, decodeURIComponent(parts[2])); if (parts.length === 4 && parts[3] === 'original') return { name: document.name, base64: document.originalBase64 }; if (parts.length === 3) return { id: document.id, recitationId: document.recitationId, name: document.name, text: document.text, lineCount: document.lineCount, createdAt: document.createdAt, import: document.import }; }
      if (method === 'POST' && url.pathname === '/documents') {
        let input = body; let bytes: Uint8Array | undefined; let parsed: { text: string; import: import('@sanxing/contracts').DocumentImport } | undefined;
        if (body instanceof FormData) {
          const file = body.get('file'); if (!(file instanceof File)) throw new DomainError('FILE_REQUIRED', '请选择文件。');
          if (file.size > documentUploadLimit(file.name, bootstrap.config.maxUploadBytes)) throw new DomainError('FILE_TOO_LARGE', '文件超过大小限制。', 413);
          options.onImportProgress?.({ phase: 'reading' });
          bytes = new Uint8Array(await file.arrayBuffer()); input = { recitationId: query.recitationId, name: file.name, text: '' };
          if (isImageFilename(file.name)) parsed = imageImportInputSchema.parse(JSON.parse(z.string().parse(body.get('ocr'))));
          else if (/\.pdf$/i.test(file.name)) {
            options.onImportProgress?.({ phase: 'parsing' });
            parsed = await (await import('./local-pdf')).parseLocalPdf(bytes, (completed, total) => options.onImportProgress?.({ phase: 'parsing', completed, total }));
          }
        }
        options.onImportProgress?.({ phase: 'saving' });
        return service.command('POST:/api/documents', key(), { input, ...(bytes ? { hash: (await import('@sanxing/contracts')).hashBytes(bytes), ...(parsed?.import.format === 'image' ? { ocr: parsed } : {}) } : {}) }, data => service.addDocument(data, input, bytes, parsed));
      }
      if (method === 'POST' && url.pathname === '/library/search') { const input = z.object({ query: z.string().max(LIMITS.libraryQueryChars), kind: z.enum(['document', 'knowledge']).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(LIMITS.libraryPageSizeMaximum).optional(), includeUnderstanding: z.boolean().optional(), expandTerms: z.boolean().optional(), expectedRevision: z.number().int().nonnegative().optional() }).strict().parse(body); const { query, kind, ...settings } = input; return searchLibrary(await read(), query, kind, settings); }
      if (method === 'GET' && url.pathname === '/learning/statistics') { const days = z.enum(['7', '30', '90', '0']).parse(query.days ?? '30'); return learningStatistics(await read(), new Date(), bootstrap.config.timezone, Number(days) as 0 | 7 | 30 | 90); }
      if (method === 'GET' && url.pathname === '/reviews/plan') return reviewPlan(await read(), bootstrap.config, new Date());
      if (method === 'GET' && url.pathname === '/learning/preferences') { const data = await read(); return { revision: data.revision, source: data.learningPreferences ? 'saved' : 'environment', ...effectiveLearningPreferences(data, bootstrap.config) }; }
      if (method === 'GET' && parts[1] === 'quizzes' && parts.length === 3) return publicQuiz(record((await read()).quizzes, parts[2]!));
      if (parts[1] === 'knowledge-points' && parts[2]) {
        const data = await read(); const id = parts[2];
        if (method === 'GET' && parts[3] === 'evidence') { const { offset, limit, expectedRevision } = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(50).default(20), expectedRevision: z.coerce.number().int().nonnegative().optional() }).parse(query); const point = record(data.knowledge, id); if (expectedRevision !== undefined && expectedRevision !== data.revision) throw new DomainError('EVIDENCE_CHANGED', '记录已变化，请重新加载第一页。'); const items = Object.values(data.evidence).filter(item => point.merge ? item.knowledgeId === id : resolvedKnowledgeId(data, item.knowledgeId) === id).sort((a, b) => b.answer.submittedAt.localeCompare(a.answer.submittedAt) || a.id.localeCompare(b.id)); return { revision: data.revision, total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) }; }
        if (method === 'POST' && parts[3] === 'merge-preview') return previewKnowledgeMerge(data, id, z.object({ targetId: z.string() }).parse(body).targetId);
      }
      if (method === 'POST' && parts[1] === 'recitations' && parts[3] === 'input-preview') { const data = await read(); return models.previewTask(data, service.previewRecitationTask(data, parts[2]!, z.object({ input: z.unknown() }).parse(body).input)); }
      if (method === 'POST' && parts[1] === 'questions' && parts[3] === 'input-preview') { const data = await read(); return models.previewTask(data, service.previewAnswerTask(data, parts[2]!, body)); }
      const item = mutationPatterns.find(item => item.method === method && match(item.parts, parts));
      if (item) {
        const params = match(item.parts, parts)!;
        const result = await service.command(`${method}:/api${url.pathname}`, key(), body, data => {
          const result = item.apply(service, data, params, body);
          if (result.runId && data.runs[result.runId]?.status === 'pending') {
            if (!navigator.locks) throw new DomainError('LOCAL_WORKER_UNAVAILABLE', 'AI 任务需要支持 Web Locks 的 HTTPS 浏览器；当前输入已保留。', 503);
            if (data.mode === 'live') models.validate(data.aiModel ?? null);
          }
          return result;
        });
        for (const id of worker.activeRunIds()) if (!isActiveRun((await read()).runs[id]!)) worker.cancel(id);
        if (result.runId) void tick(); return result;
      }
      throw new HttpError(404, 'LOCAL_ROUTE_NOT_FOUND', '当前本地功能不存在，请刷新页面后重试。');
    },
    async close() { if (closed) return; closed = true; clearInterval(election); if (clock) clearInterval(clock); await worker.stop(); releaseLeader?.(); await repository.close(); },
  };
}
