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
