import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyData, type Repository } from '@sanxing/database';
import { LIMITS, type AppData, type AiTask, type LearningEngine, type RecitationInput, type TaskInputPreview } from '@sanxing/contracts';
import { createLearningEngine } from '@sanxing/learning-agent';
import { createApp } from '../src/app.ts';
import { readConfig, type ApiConfig } from '../src/config.ts';

const now = '2026-01-01T00:00:00.000Z';
const defaults = readConfig({ OWNER_PASSWORD: 'budget-test-password', SESSION_SECRET: 'budget-test-secret-'.repeat(4), AI_MODE: 'mock' });
const instances: Awaited<ReturnType<typeof createApp>>[] = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in input preflight tests'); })); });
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.app.close();
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(patch: Partial<ApiConfig> = {}) {
  const config = { ...defaults, ...patch };
  let data = emptyData(config.mode);
  const repository: Repository = {
    read: async () => structuredClone(data), revision: async () => data.revision,
    async transact<T>(fn: (draft: AppData) => T | Promise<T>) {
      const draft = structuredClone(data); const result = await fn(draft);
      draft.revision++; data = draft; return structuredClone(result);
    },
    async replace(next) { data = structuredClone(next); }, async close() {},
  };
  const execute = vi.fn<LearningEngine['execute']>(async () => { throw new Error('Preflight must never call a model'); });
  const instance = await createApp({ config, repository, engine: { mode: config.mode, execute }, startWorker: false });
  instances.push(instance); vi.spyOn(instance.worker, 'tick').mockResolvedValue();
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  let serial = 0;
  const post = (url: string, payload: object) => instance.app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': `input-budget-test-${++serial}` }, payload });
  const put = (url: string, payload: object) => instance.app.inject({ method: 'PUT', url, headers: { ...headers, 'idempotency-key': `input-budget-test-${++serial}` }, payload });
  const created = await post('/api/recitations', { learningDate: '2026-01-01' });
  const id = created.json<{ id: string }>().id;
  const preview = (input: RecitationInput) => post(`/api/recitations/${id}/input-preview`, { input });
  return { ...instance, repository, execute, headers, post, put, id, preview };
}
// Extract is sent as two JSON blocks ({sources}\n{kind, recitation}): +2 braces +1 newline −1 comma.
const blockChars = (task: AiTask) => JSON.stringify(task).length + 2;
const input = (learned = '合法复述'): RecitationInput => ({ learned, unclear: '', application: '', topic: '' });
const smallModel: Partial<ApiConfig> = { mode: 'live', provider: 'openai', model: 'gpt-4', apiKey: 'synthetic-no-network-key', modelAuthMethod: 'api_key', maxOutputTokens: 4096 };

describe('read-only complete input preflight', () => {
  it('includes stored documents without returning their text or mutating any state', async () => {
    const f = await fixture();
    const beforeUpload = (await f.preview(input())).json<TaskInputPreview>();
    const text = 'PRIVATE_DOCUMENT_BODY_SENTINEL'.repeat(100);
    const uploaded = await f.post('/api/documents', { recitationId: f.id, name: 'notes.md', text });
    expect(uploaded.statusCode).toBe(201);
    const before = await f.repository.read();
    const result = await f.preview(input());
    expect(result.statusCode).toBe(200);
    const view = result.json<TaskInputPreview>();
    expect(view).toMatchObject({ canSubmit: true, documentCount: 1, truncated: false, contextWindow: null });
    expect(view.sentChars!).toBeGreaterThan(beforeUpload.sentChars!);
    expect(view.fields).toContainEqual(expect.objectContaining({ label: 'notes.md', truncated: false }));
    // Full text whenever it fits: no retrieval excerpt for a small document.
    expect(view.retrieval).toMatchObject({ mode: 'full', sourceCount: 1, originalChars: text.length, selectedChars: text.length });
    expect(view.fields.find(field => field.label === 'notes.md')!.sentChars).toBe(view.retrieval!.selectedChars);
    expect(result.body).not.toContain('PRIVATE_DOCUMENT_BODY_SENTINEL');
    expect(result.body).not.toContain('systemPrompt'); expect(result.body).not.toContain('apiKey');
    expect(await f.repository.read()).toEqual(before);
    expect(f.execute).not.toHaveBeenCalled();
    const version = before.recitations[f.id]!.version;
    await f.app.inject({ method: 'DELETE', url: `/api/recitations/${f.id}/documents/${uploaded.json().id}`, headers: { ...f.headers, 'idempotency-key': 'budget-remove-document' }, payload: { version } });
    expect((await f.preview(input())).json<TaskInputPreview>().documentCount).toBe(0);
  });

  it('requires identity, CSRF and allowed Origin; private inputs never enter a query string', async () => {
    const f = await fixture(); const url = `/api/recitations/${f.id}/input-preview`;
    expect((await f.app.inject({ method: 'POST', url, payload: { input: input() } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url, headers: { cookie: f.headers.cookie }, payload: { input: input() } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url, headers: { ...f.headers, origin: 'https://untrusted.invalid' }, payload: { input: input() } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: { input: input() } })).statusCode).toBe(200); // no idempotency key required
  });

  it('retains full recitation under budget, identifies document retrieval, and previews the exact persisted task', async () => {
    const f = await fixture(); const body = input('a'.repeat(6500) + 'TAIL_RECITATION');
    const document = 'b'.repeat(3500) + 'TAIL_DOCUMENT';
    await f.post('/api/documents', { recitationId: f.id, name: 'tail.md', text: document });
    const draft = (await f.repository.read()).recitations[f.id]!;
    await f.put(`/api/recitations/${f.id}/draft`, { ...body, version: draft.version });
    const preview = (await f.preview(body)).json<TaskInputPreview>();
    expect(preview.truncated).toBe(false);
    const submitted = await f.post(`/api/recitations/${f.id}/submit`, { version: (await f.repository.read()).recitations[f.id]!.version });
    expect(submitted.statusCode).toBe(202);
    const run = (await f.repository.read()).runs[submitted.json().runId]!;
    expect(run.promptVersion).toBe('learning-v6');
    expect(run.task.kind).toBe('extract');
    if (run.task.kind !== 'extract') throw new Error('expected extract');
    expect(run.task.recitation.learned).toBe(body.learned);
    const retrieved = run.task.sources.find(source => source.name === 'tail.md')!.text;
    expect(retrieved).toBe(document); // Fits the budget: the complete document is sent, not an excerpt.
    expect(preview.retrieval).toMatchObject({ mode: 'full', originalChars: document.length, selectedChars: document.length });
    expect((await f.repository.read()).documents[run.task.sources.find(source => source.name === 'tail.md')!.id]!.text).toBe(document);
    expect(blockChars(run.task)).toBe(preview.sentChars);
    const response = await createLearningEngine({ mode: 'mock' }).execute(run.task, { signal: new AbortController().signal });
    expect(response.output.kind).toBe('extract');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('accepts ten large archived documents and three maximum fields, while fitting the queued task', async () => {
    const f = await fixture({ maxDocuments: 10, maxUploadBytes: LIMITS.uploadBytesMaximum });
    for (let i = 0; i < 10; i++) {
      const uploaded = await f.post('/api/documents', { recitationId: f.id, name: `large-${i}.md`, text: `${i}:` + '文'.repeat(100_000) });
      expect(uploaded.statusCode).toBe(201);
    }
    const body = { ...input('\\'.repeat(LIMITS.recitationFieldChars)), unclear: '疑'.repeat(LIMITS.recitationFieldChars), application: '用'.repeat(LIMITS.recitationFieldChars) };
    const saved = await f.put(`/api/recitations/${f.id}/draft`, { ...body, version: (await f.repository.read()).recitations[f.id]!.version });
    expect(saved.statusCode).toBe(200);
    const view = (await f.preview(body)).json<TaskInputPreview>();
    expect(view).toMatchObject({ canSubmit: true, truncated: true, documentCount: 10 });
    const submitted = await f.post(`/api/recitations/${f.id}/submit`, { version: saved.json().version });
    expect(submitted.statusCode).toBe(202);
    const state = await f.repository.read(); const run = state.runs[submitted.json().runId]!;
    expect(run.status).toBe('pending');
    expect(blockChars(run.task)).toBe(view.sentChars);
    expect(view.sentChars!).toBeLessThanOrEqual(LIMITS.modelInputChars);
    expect(state.recitations[f.id]!.learned).toBe(body.learned);
    expect(Object.values(state.documents).every(document => document.text.length === 100_002)).toBe(true);
    await expect(createLearningEngine({ mode: 'mock' }).execute(run.task, { signal: new AbortController().signal })).resolves.toMatchObject({ output: { kind: 'extract' } });
  });

  it('plans against the selected small model including full prompts, output and safety reserves', async () => {
    const f = await fixture(smallModel); const body = input('中文预算🙂'.repeat(2000));
    const view = (await f.preview(body)).json<TaskInputPreview>();
    expect(view).toMatchObject({ canSubmit: true, contextWindow: 8192, outputReserveTokens: 4096, safetyMarginTokens: 512, truncated: true, model: { providerId: 'openai', modelId: 'gpt-4' } });
    expect(view.estimatedInputTokens! + view.outputReserveTokens + view.safetyMarginTokens).toBeLessThanOrEqual(8192);
    expect(view.remainingInputTokens).toBe(8192 - view.estimatedInputTokens! - 4096 - 512);
    expect(f.execute).not.toHaveBeenCalled();
    const saved = await f.put(`/api/recitations/${f.id}/draft`, { ...body, version: 1 });
    const submitted = await f.post(`/api/recitations/${f.id}/submit`, { version: saved.json().version });
    expect(submitted.statusCode).toBe(202);
    const task = (await f.repository.read()).runs[submitted.json().runId]!.task;
    expect(blockChars(task)).toBe(view.sentChars);
  });

  it('reports absent selection and impossible fixed budgets instead of pretending a usable balance', async () => {
    const missing = await fixture({ mode: 'live' });
    expect((await missing.preview(input())).json<TaskInputPreview>()).toMatchObject({ canSubmit: false, sentChars: null, reason: expect.stringContaining('选择') });
    const full = await fixture({ ...smallModel, maxOutputTokens: 8192 });
    expect((await full.preview(input())).json<TaskInputPreview>()).toMatchObject({ canSubmit: false, contextWindow: 8192, sentChars: null, reason: expect.stringContaining('预算') });
  });

  it('previews grading without exposing private material, and rejects over-budget formal answers atomically', async () => {
    const f = await fixture(smallModel);
    await f.repository.transact(data => {
      data.quizzes.quiz = { id: 'quiz', sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 1, createdAt: now, submittedAt: null, answers: {}, drafts: {},
        questions: [{ id: 'question', knowledgeId: 'point', kind: 'short', prompt: '解释你的理解', options: [], correctIndex: null, referenceAnswer: 'PRIVATE_REFERENCE_SENTINEL', rubric: [{ id: 'rubric', description: 'PRIVATE_RUBRIC_SENTINEL', maxScore: 2 }], sourceIds: ['source'] },
          { id: 'future', knowledgeId: 'point', kind: 'short', prompt: 'PRIVATE_FUTURE', options: [], correctIndex: null, referenceAnswer: 'PRIVATE_FUTURE_ANSWER', rubric: [{ id: 'future-rubric', description: 'PRIVATE_FUTURE_RUBRIC', maxScore: 1 }], sourceIds: ['source'] }] };
    });
    const answer = '字'.repeat(9000);
    const saved = await f.put('/api/questions/question/draft', { version: 1, text: answer });
    expect(saved.statusCode).toBe(200);
    const before = await f.repository.read();
    const preview = await f.post('/api/questions/question/input-preview', { text: answer });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<TaskInputPreview>()).toMatchObject({ canSubmit: false, sentChars: null, fields: [], reason: expect.stringContaining('不会截断') });
    expect(preview.body).not.toContain('PRIVATE_');
    expect((await f.post('/api/questions/future/input-preview', { text: 'guess' })).statusCode).toBe(409);
    const submit = await f.post('/api/questions/question/answers', { version: saved.json().version, action: 'answer', text: answer });
    expect(submit.statusCode).toBe(413); expect(submit.json().error.code).toBe('MODEL_INPUT_TOO_LARGE');
    expect(await f.repository.read()).toEqual(before);
    const small = await f.post('/api/questions/question/input-preview', { text: '简短正式答案' });
    expect(small.json<TaskInputPreview>().canSubmit).toBe(true);
    expect(small.body).not.toContain('PRIVATE_');
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe('代码题提交 API', () => {
  const execution = { status: 'passed' as const, passed: 1, total: 1, output: '浏览器证据', durationMs: 7, ranAt: now };
  async function codeFixture() {
    const f = await fixture();
    await f.repository.transact(data => {
      data.quizzes.code = { id: 'code', sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 1, createdAt: now, submittedAt: null, drafts: {}, answers: {}, questions: [{ id: 'q-code', kind: 'code', knowledgeId: 'k', prompt: '实现函数', options: [], correctIndex: null, sourceIds: ['s'], referenceAnswer: 'PRIVATE_CODE_REFERENCE', rubric: [{ id: 'r', description: 'PRIVATE_CODE_RUBRIC', maxScore: 2 }], code: { language: 'javascript', starter: 'const value = 0;', tests: [{ name: '值', code: 'assertEqual(value, 2);' }] } }] };
    });
    return f;
  }
  it('预检只返回预算，提交后 grade 和 Answer 保留 execution 并等待评价', async () => {
    const f = await codeFixture();
    const preview = await f.post('/api/questions/q-code/input-preview', { text: 'const value = 2;', execution });
    expect(preview.statusCode).toBe(200); expect(preview.json().canSubmit).toBe(true);
    expect(preview.body).not.toContain('PRIVATE_CODE');
    const response = await f.post('/api/questions/q-code/answers', { version: 1, action: 'answer', codeProtocol: 1, text: 'const value = 2;', execution });
    expect(response.statusCode, response.body).toBe(202);
    const data = await f.repository.read();
    expect(data.runs[response.json().runId]!.task).toMatchObject({ kind: 'grade', answer: 'const value = 2;', execution });
    expect(data.quizzes.code!.answers['q-code']).toMatchObject({ execution, assessment: { status: 'pending', score: null } });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('数量不符、越权题型、旧客户端均被拒绝，预检不绕过规则', async () => {
    const f = await codeFixture();
    expect((await f.post('/api/questions/q-code/answers', { version: 1, action: 'answer', text: '代码' })).json().error.code).toBe('CLIENT_UPDATE_REQUIRED');
    const bad = { ...execution, passed: 2, total: 2 };
    expect((await f.post('/api/questions/q-code/input-preview', { text: '代码', execution: bad })).statusCode).toBe(400);
    expect((await f.post('/api/questions/q-code/answers', { version: 1, action: 'answer', codeProtocol: 1, text: '代码', execution: bad })).statusCode).toBe(400);
    await f.repository.transact(data => { const q = data.quizzes.code!.questions[0]!; q.kind = 'short'; delete q.code; });
    expect((await f.post('/api/questions/q-code/input-preview', { text: '文字', execution })).statusCode).toBe(400);
    expect((await f.post('/api/questions/q-code/answers', { version: 1, action: 'answer', text: '文字', execution })).statusCode).toBe(400);
    expect((await f.repository.read()).quizzes.code!.answers).toEqual({});
  });
  it('新偏好保存及旧请求更新兼容，未选择语言被拒绝', async () => {
    const f = await fixture();
    const save = async (patch: object) => f.put('/api/learning/preferences', { expectedRevision: (await f.repository.read()).revision, schedulingEnabled: false, promptCacheRetention: 'none', confirm: true, ...patch });
    expect((await save({ codeExercisesEnabled: true, codeLanguages: ['typescript', 'javascript', 'typescript'] })).statusCode).toBe(200);
    expect((await save({})).statusCode).toBe(200);
    const prefs = await f.app.inject({ url: '/api/learning/preferences', headers: f.headers });
    expect(prefs.json()).toMatchObject({ codeExercisesEnabled: true, codeLanguages: ['javascript', 'typescript'] });
    expect((await save({ codeLanguages: [] })).statusCode).toBe(400);
  });
});
