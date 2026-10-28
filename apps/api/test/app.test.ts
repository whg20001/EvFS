import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyData, openRepository } from '@sanxing/database';
import { createLearningEngine } from '@sanxing/learning-agent';
import type { CommandResult, PublicState } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const password = 'test-only-long-password';
const config = readConfig({ OWNER_PASSWORD: password, SESSION_SECRET: 'test-only-secret-'.repeat(4), AI_MODE: 'mock', USER_TIMEZONE: 'UTC', APP_ALLOWED_ORIGINS: 'http://localhost:3010,http://192.0.2.10:3010' });
let repository: Awaited<ReturnType<typeof openRepository>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let cookie = ''; let csrf = ''; let counter = 0;
async function login() {
  const response = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.appOrigin }, payload: { password } });
  expect(response.statusCode).toBe(200);
  cookie = String(response.headers['set-cookie']).split(';')[0]!; csrf = response.json<{ csrfToken: string }>().csrfToken;
}
async function state() { const result = await instance.app.inject({ url: '/api/state', headers: { cookie } }); expect(result.statusCode).toBe(200); return result.json<PublicState>(); }
async function write(method: 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown, key?: string) {
  return instance.app.inject({ method, url, headers: { cookie, origin: config.appOrigin, 'x-csrf-token': csrf, 'idempotency-key': key ?? `test-api-key-${++counter}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
async function createRecitation() {
  const created = await write('POST', '/api/recitations', {}); expect(created.statusCode).toBe(200);
  const id = created.json<CommandResult>().id!;
  const saved = await write('PUT', `/api/recitations/${id}/draft`, { version: 1, learned: '缓存穿透：不存在的数据重复请求数据库，可以使用空值缓存，但需要合理设置过期时间。', unclear: '怎样设置 TTL？', application: '保护商品查询接口。', topic: 'Redis' });
  expect(saved.statusCode).toBe(200); return id;
}
async function createQuiz() {
  const recitationId = await createRecitation();
  const submitted = await write('POST', `/api/recitations/${recitationId}/submit`, { version: 2 }); expect(submitted.statusCode).toBe(202);
  const sessionId = submitted.json<CommandResult>().sessionId!; await instance.worker.tick();
  let snapshot = await state(); let session = snapshot.sessions.find(s => s.id === sessionId)!;
  expect(session.candidates.length).toBeGreaterThan(0);
  const confirmed = await write('POST', `/api/sessions/${sessionId}/confirmations`, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }); expect(confirmed.statusCode).toBe(202); await instance.worker.tick();
  snapshot = await state(); session = snapshot.sessions.find(s => s.id === sessionId)!;
  const generated = await write('POST', `/api/sessions/${sessionId}/finish-followup`, { version: session.version }); expect(generated.statusCode).toBe(202); await instance.worker.tick();
  snapshot = await state(); return { recitationId, sessionId, quizId: snapshot.sessions.find(s => s.id === sessionId)!.quizId! };
}

beforeAll(async () => {
  repository = await openRepository(':memory:', 'mock');
  instance = await createApp({ config, repository, engine: createLearningEngine({ mode: 'mock' }), startWorker: false });
  await instance.app.ready();
});
beforeEach(async () => { await instance.worker.tick(); await repository.replace(emptyData('mock')); await login(); });
afterAll(async () => { await instance?.app.close(); await repository?.close(); });

describe('self-hosted HTTP integration with real Pi faux Provider', () => {
  it('requires authentication, CSRF, and a permitted origin', async () => {
    expect((await instance.app.inject({ url: '/api/state' })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'POST', url: '/api/recitations', headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await instance.app.inject({ method: 'POST', url: '/api/recitations', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://untrusted.example' }, payload: {} })).statusCode).toBe(403);
    expect((await write('POST', '/api/reviews/__proto__/start', {})).statusCode).toBe(404);
  });
  it('allows only explicitly configured alternate origins without relaxing CSRF', async () => {
    for (const origin of ['http://localhost:3010', 'http://192.0.2.10:3010']) {
      expect((await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })).statusCode).toBe(200);
      expect((await instance.app.inject({ method: 'POST', url: '/api/recitations', headers: { origin, cookie }, payload: {} })).statusCode).toBe(403);
    }
    for (const origin of ['http://localhost:3011', 'http://192.0.2.11:3010', 'http://localhost.evil.example:3010']) {
      const result = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } });
      expect(result.statusCode).toBe(403); expect(result.json().error.code).toBe('ORIGIN_FORBIDDEN');
    }
  });
  it('rejects invalid or wildcard origins instead of permitting arbitrary websites', () => {
    for (const origin of ['*', 'http://*.example.com', 'http://localhost:3010/path', 'ftp://localhost:3010']) {
      expect(() => readConfig({ OWNER_PASSWORD: password, SESSION_SECRET: 'test-only-secret-'.repeat(4), AI_MODE: 'mock', APP_ALLOWED_ORIGINS: origin })).toThrow();
    }
  });
  it('accepts persisted text notes and enforces extension, text and version rules', async () => {
    const id = await createRecitation();
    const note = await write('POST', '/api/documents', { recitationId: id, name: 'cache.md', text: '# 缓存\n一条笔记。' }); expect(note.statusCode).toBe(201);
    const snapshot = await state(); expect(snapshot.documents[0]?.lineCount).toBe(2);
    expect(snapshot.documents[0]).not.toHaveProperty('originalBase64');
    expect((await write('POST', '/api/documents', { recitationId: id, name: '../x.md', text: 'x' })).statusCode).toBe(400);
    expect((await write('POST', '/api/documents', { recitationId: id, name: 'x.pdf', text: 'x' })).statusCode).toBe(400);
    expect((await write('PUT', `/api/recitations/${id}/draft`, { version: 1, learned: '过期写入', unclear: '', application: '', topic: '' })).statusCode).toBe(409);
  });
  it('makes write retries idempotent and rejects the same key for another payload', async () => {
    const first = await write('POST', '/api/recitations', {}, 'fixed-api-command');
    const second = await write('POST', '/api/recitations', {}, 'fixed-api-command'); expect(first.json()).toEqual(second.json());
    expect((await write('POST', '/api/recitations', { learningDate: '2026-01-01' }, 'fixed-api-command')).statusCode).toBe(409);
    expect((await state()).recitations).toHaveLength(1);
  });
  it('runs the full learning and review path without paid requests or answer leakage', async () => {
    const { quizId, sessionId } = await createQuiz(); let snapshot = await state(); let quiz = snapshot.quizzes.find(q => q.id === quizId)!;
    expect(quiz).toBeDefined(); expect(quiz.questions).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('"correctIndex"'); expect(JSON.stringify(snapshot)).not.toContain('"referenceAnswer"'); expect(JSON.stringify(snapshot)).not.toContain('"rubric"');
    while (quiz.currentIndex < quiz.questionCount) {
      const question = quiz.questions[quiz.currentIndex]!;
      const privateQuestion = (await repository.read()).quizzes[quizId]!.questions.find(q => q.id === question.id)!;
      const result = await write('POST', `/api/questions/${question.id}/answers`, { version: quiz.version, action: 'answer', selectedIndex: question.kind === 'single' ? privateQuestion.correctIndex : null, text: question.kind === 'short' ? '没有相应数据时反复查询数据库，需要空值缓存。' : '', assisted: false });
      expect([200, 202]).toContain(result.statusCode); await instance.worker.tick();
      quiz = (await state()).quizzes.find(q => q.id === quizId)!;
    }
    expect((await write('POST', `/api/quizzes/${quizId}/submit`, { version: quiz.version, confirmSkip: true })).statusCode).toBe(200);
    snapshot = await state(); expect(snapshot.sessions.find(s => s.id === sessionId)!.status).toBe('COMPLETED'); expect(snapshot.cards.length).toBeGreaterThan(0);
    expect(snapshot.mode).toBe('mock'); expect(snapshot.evidence.every(e => e.simulated)).toBe(true);
    const card = snapshot.cards[0]!;
    const started = await write('POST', `/api/reviews/${card.id}/start`, {}); const reviewId = started.json<CommandResult>().reviewSessionId!;
    const again = await write('POST', `/api/reviews/${card.id}/start`, {}); expect(again.json<CommandResult>().reviewSessionId).toBe(reviewId);
    let review = (await state()).reviewSessions.find(r => r.id === reviewId)!;
    expect((await write('PUT', `/api/review-sessions/${reviewId}/recall`, { version: review.version, action: 'submitted', text: '不存在的数据没有被缓存。' })).statusCode).toBe(202); await instance.worker.tick();
    review = (await state()).reviewSessions.find(r => r.id === reviewId)!;
    let reviewQuiz = (await state()).quizzes.find(q => q.id === review.quizId)!;
    const firstQuestion = reviewQuiz.questions[0]!;
    const answer = (await repository.read()).quizzes[reviewQuiz.id]!.questions[0]!;
    if (firstQuestion.kind === 'single') {
      expect((await write('POST', `/api/questions/${firstQuestion.id}/answers`, { version: reviewQuiz.version, action: 'answer', selectedIndex: answer.correctIndex, text: '', assisted: false })).statusCode).toBe(200);
    }
    reviewQuiz = (await state()).quizzes.find(q => q.id === review.quizId)!;
    expect((await write('POST', `/api/quizzes/${reviewQuiz.id}/submit`, { version: reviewQuiz.version, confirmSkip: true })).statusCode).toBe(200);
    review = (await state()).reviewSessions.find(r => r.id === reviewId)!;
    const completion = { version: review.version, expectedCardVersion: review.expectedCardVersion, rating: 3 };
    expect((await write('POST', `/api/review-sessions/${reviewId}/complete`, completion, 'one-review-completion')).statusCode).toBe(200);
    expect((await write('POST', `/api/review-sessions/${reviewId}/complete`, completion, 'one-review-completion')).statusCode).toBe(200);
    expect((await state()).reviewEvents.length).toBeLessThanOrEqual(1);
  });
  it('invalidates the session on logout', async () => {
    expect((await write('POST', '/api/auth/logout', {})).statusCode).toBe(200);
    expect((await instance.app.inject({ url: '/api/state', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('assessment corrections and knowledge lifecycle', () => {
  async function submittedShort() {
    const { quizId } = await createQuiz();
    let quiz = (await repository.read()).quizzes[quizId]!;
    for (const question of quiz.questions) {
      const response = await write('POST', `/api/questions/${question.id}/answers`, { version: quiz.version, action: question.kind === 'short' ? 'answer' : 'skip', text: question.kind === 'short' ? '缓存空值，并设置适当 TTL。' : '', selectedIndex: null, assisted: false });
      expect(response.statusCode).toBeLessThan(300); await instance.worker.tick(); quiz = (await repository.read()).quizzes[quizId]!;
    }
    expect((await write('POST', `/api/quizzes/${quizId}/submit`, { version: quiz.version, confirmSkip: true })).statusCode).toBe(200);
    quiz = (await repository.read()).quizzes[quizId]!;
    return { quiz, question: quiz.questions.find(question => question.kind === 'short')! };
  }
  it('persists fixed-answer detail and hides rubrics before submission', async () => {
    const { quizId } = await createQuiz(); let quiz = (await repository.read()).quizzes[quizId]!;
    const question = quiz.questions[0]!;
    expect((await state()).quizzes.find(item => item.id === quizId)!.questions[0]).not.toHaveProperty('rubric');
    await write('POST', `/api/questions/${question.id}/answers`, { version: quiz.version, action: 'answer', selectedIndex: question.correctIndex, assisted: false });
    quiz = (await repository.read()).quizzes[quizId]!;
    expect(quiz.answers[question.id]!.assessment.scores?.map(item => item.score)).toEqual(question.rubric.map(item => item.maxScore));
  });
  it('keeps immutable answers, versioned manual corrections, disputes and schedules through persistence', async () => {
    const { quiz, question } = await submittedShort(); const original = structuredClone(quiz.answers[question.id]!);
    const schedules = (await repository.read()).cards;
    let response = await write('POST', `/api/questions/${question.id}/disputes`, { version: quiz.version, assessmentVersion: original.assessment.version, reason: '需要按原评分标准核对' });
    expect(response.statusCode).toBe(200);
    let current = (await repository.read()).quizzes[quiz.id]!;
    const body = { version: current.version, assessmentVersion: original.assessment.version, method: 'manual', reason: '逐项核对原文', feedback: '人工确认关键点完整', scores: question.rubric.map(row => ({ rubricId: row.id, score: row.maxScore, evidence: '答案提到了空值及 TTL' })) };
    response = await write('POST', `/api/questions/${question.id}/assessment-revisions`, body, 'manual-revision-idempotent'); expect(response.statusCode).toBe(200);
    expect((await write('POST', `/api/questions/${question.id}/assessment-revisions`, body, 'manual-revision-idempotent')).statusCode).toBe(200);
    const data = await repository.read(); current = data.quizzes[quiz.id]!;
    const answer = current.answers[question.id]!;
    expect(answer.text).toBe(original.text); expect(answer.submittedAt).toBe(original.submittedAt);
    expect(answer.assessmentHistory).toEqual([original.assessment]); expect(answer.assessment.source).toBe('manual');
    expect(answer.assessment.scores?.length).toBe(question.rubric.length); expect(answer.dispute?.resolvedAt).not.toBeNull();
    expect(data.cards).toEqual(schedules); expect(data.reviewEvents).toEqual({});
    expect(data.evidence[`${quiz.id}:${question.id}`]!.answer).toEqual(answer);
    // The same validation used by backup restore must retain all new fields.
    await repository.replace(JSON.parse(JSON.stringify(data))); expect((await repository.read()).quizzes[quiz.id]!.answers[question.id]).toEqual(answer);
    expect((await write('POST', `/api/questions/${question.id}/assessment-revisions`, body)).statusCode).toBe(409);
  });
  it('re-evaluates submitted answers without reopening sessions or losing the prior assessment', async () => {
    const { quiz, question } = await submittedShort(); const answer = quiz.answers[question.id]!;
    const response = await write('POST', `/api/questions/${question.id}/assessment-revisions`, { version: quiz.version, assessmentVersion: answer.assessment.version, method: 'model', reason: '再次核对' }, 'model-revision-idempotent');
    expect(response.statusCode).toBe(202); await instance.worker.tick();
    const data = await repository.read(); const current = data.quizzes[quiz.id]!.answers[question.id]!;
    expect(current.assessmentHistory).toEqual([answer.assessment]); expect(current.assessment.source).toBe('model');
    expect(current.assessment.status).toBe('needs_verification'); expect(data.sessions[quiz.sessionId!]!.status).toBe('COMPLETED');
    const runId = response.json<CommandResult>().runId!;
    expect(data.runs[runId]!.status).toBe('succeeded');
    expect((await write('POST', `/api/runs/${runId}/retry`, {})).statusCode).toBe(409);
  });
  it('rejects malformed manual scores and excludes archived knowledge from search and new reviews', async () => {
    const { quiz, question } = await submittedShort(); const answer = quiz.answers[question.id]!;
    expect((await write('POST', `/api/questions/${question.id}/assessment-revisions`, { version: quiz.version, assessmentVersion: answer.assessment.version, method: 'manual', reason: '核对', feedback: '不合法', scores: question.rubric.map(row => ({ rubricId: row.id, score: row.maxScore + 1, evidence: '超分' })) })).statusCode).toBe(409);
    let data = await repository.read(); let point = data.knowledge[question.knowledgeId]!;
    const oldContent = structuredClone(point.contentHistory); const oldQuestion = structuredClone(question);
    expect((await write('PUT', `/api/knowledge-points/${point.id}/content`, { version: point.version, title: '独特归档主题', description: '人工修订的描述', tags: ['缓存', '缓存'] })).statusCode).toBe(200);
    data = await repository.read(); point = data.knowledge[point.id]!;
    expect(point.contentHistory?.slice(0, -1)).toEqual(oldContent); expect(point.tags).toEqual(['缓存']);
    expect(data.quizzes[quiz.id]!.questions.find(item => item.id === question.id)).toEqual(oldQuestion);
    expect((await write('PUT', `/api/knowledge-points/${point.id}/archive`, { version: point.version, archived: true })).statusCode).toBe(200);
    const search = await write('POST', '/api/library/search', { query: '独特归档主题', kind: 'knowledge' }); expect(search.json().hits).toEqual([]);
    const card = Object.values(data.cards).find(card => card.knowledgeId === point.id)!;
    expect((await write('POST', `/api/reviews/${card.id}/start`, {})).statusCode).toBe(409);
    point = (await repository.read()).knowledge[point.id]!;
    expect((await write('PUT', `/api/knowledge-points/${point.id}/archive`, { version: point.version, archived: false })).statusCode).toBe(200);
    expect((await write('POST', `/api/library/search`, { query: '独特归档主题', kind: 'knowledge' })).json().hits).toHaveLength(1);
    expect((await write('POST', `/api/reviews/${card.id}/start`, {})).statusCode).toBe(200);
  });
});
