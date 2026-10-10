import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyData, type Repository } from '@sanxing/database';
import { LIMITS, type AgentRun, type AppData, type LearningEngine, type PublicState, type PublicStateUpdate } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { StateSync } from '../src/state-sync.ts';

const config = readConfig({ OWNER_PASSWORD: 'offline-state-sync-password', SESSION_SECRET: 'offline-state-sync-secret-'.repeat(3), AI_MODE: 'mock', USER_TIMEZONE: 'UTC' });
const now = '2026-01-01T00:00:00.000Z';
const engine: LearningEngine = { mode: 'mock', execute: async () => { throw new Error('No provider should be called'); } };
const instances: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const instance of instances.splice(0)) await instance.app.close(); vi.restoreAllMocks(); });

async function setup(appConfig = config) {
  let data = emptyData('mock');
  let rollback = false;
  const read = vi.fn(async () => structuredClone(data));
  const revision = vi.fn(async () => data.revision);
  const repository: Repository = {
    read, revision, learningPreferences: async () => structuredClone(data.learningPreferences),
    async transact<T>(fn: (data: AppData) => T | Promise<T>): Promise<T> {
      const next = structuredClone(data); const result = await fn(next);
      if (rollback) throw new Error('Commit failed');
      next.revision++; data = next; return result;
    },
    async replace(next) { data = structuredClone(next); }, async close() {},
  };
  const instance = await createApp({ config: appConfig, repository, engine, startWorker: false });
  instances.push(instance);
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
  const headers = { cookie, 'x-csrf-token': csrfToken, 'idempotency-key': 'offline-test-key' };
  const get = (url: string) => instance.app.inject({ url, headers });
  return { ...instance, repository, read, revision, headers, csrfToken, get, rollback: () => { rollback = true; } };
}

function publicState(revision: number): PublicState {
  return { mode: 'mock', timezone: 'UTC', revision, csrfToken: 'must-not-be-shared',
    capabilities: { maxDocuments: 5, maxUploadBytes: 1000, maxFollowups: 3, quizCount: 3, schedulingEnabled: false },
    recitations: [], documents: [], sessions: [], knowledge: [], quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [] };
}
function run(id: string, status: AgentRun['status']): AgentRun {
  return { id, status, task: { kind: 'extract', recitation: { topic: '', learned: '', unclear: '', application: '' }, sources: [] }, sessionId: null, reviewSessionId: null, quizId: null, questionId: null,
    attempt: 1, attemptId: 'attempt', expectedVersion: 1, createdAt: now, startedAt: now, finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'learning-v1' };
}

describe('bounded public-state polling', () => {
  it('uses the lightweight revision for unchanged polls and never reads state for /me', async () => {
    const fixture = await setup();
    const me = await fixture.get('/api/me');
    expect(me.json().capabilities.maxDocuments).toBe(config.maxDocuments);
    expect(fixture.read).not.toHaveBeenCalled();
    const state = (await fixture.get('/api/state')).json<PublicState>();
    expect(state.revision).toBe(0); fixture.read.mockClear();
    const update = await fixture.get('/api/state?since=0');
    expect(update.json()).toEqual({ kind: 'unchanged', revision: 0, csrfToken: fixture.csrfToken });
    expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.revision).toHaveBeenCalled();
    expect((await fixture.get('/api/state?since=-1')).statusCode).toBe(400);
    expect((await fixture.get('/api/state?since=9007199254740992')).statusCode).toBe(400);
  });

  it('refreshes capability metadata after an explicit preference change and keeps /me lightweight', async () => {
    const fixture = await setup(); const state = (await fixture.get('/api/state')).json<PublicState>();
    await fixture.repository.transact(data => { data.learningPreferences = { schedulingEnabled: !state.capabilities.schedulingEnabled, promptCacheRetention: 'none' }; });
    const result = (await fixture.get(`/api/state?since=${state.revision}`)).json<PublicStateUpdate>();
    expect(result.kind).toBe('snapshot');
    if (result.kind !== 'snapshot') throw new Error('Expected changed capabilities');
    expect(result.state.capabilities.schedulingEnabled).toBe(!state.capabilities.schedulingEnabled);
    fixture.read.mockClear();
    expect((await fixture.get('/api/me')).json().capabilities.schedulingEnabled).toBe(!state.capabilities.schedulingEnabled);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('returns a snapshot without a known baseline, after restart, and for future revisions', async () => {
    const fixture = await setup();
    expect((await fixture.get('/api/state?since=0')).json().kind).toBe('snapshot');
    expect((await fixture.get('/api/state?since=999')).json().kind).toBe('snapshot');
    expect((await fixture.get('/api/state?since=4')).json().kind).toBe('snapshot');
  });

  it('sends changed entities and tombstones without retransmitting unchanged large entities', async () => {
    const fixture = await setup();
    await fixture.repository.transact(data => {
      data.documents.doc = { id: 'doc', recitationId: 'recitation', name: 'notes.md', text: 'private full document', originalBase64: 'private-upload', hash: 'private-hash', lineCount: 1, createdAt: now };
      data.recitations.recitation = { id: 'recitation', learningDate: '2026-01-01', learned: 'large unchanged recitation'.repeat(1000), unclear: '', application: '', topic: '', version: 1, documentIds: ['doc'], createdAt: now, updatedAt: now };
      data.runs.old = run('old', 'cancelled');
    });
    const snapshot = (await fixture.get('/api/state')).json<PublicState>();
    expect(snapshot.documents[0]).not.toHaveProperty('text');
    expect(snapshot.documents[0]).not.toHaveProperty('originalBase64');
    await fixture.repository.transact(data => { delete data.runs.old; data.runs.new = run('new', 'running'); });
    const update = (await fixture.get(`/api/state?since=${snapshot.revision}`)).json<PublicStateUpdate>();
    expect(update.kind).toBe('delta');
    if (update.kind !== 'delta') throw new Error('expected delta');
    expect(Object.keys(update.changes)).toEqual(['runs']);
    expect(update.changes.runs?.remove).toEqual(['old']);
    expect(update.changes.runs?.upsert.map(run => run.id)).toEqual(['new']);
    expect(JSON.stringify(update)).not.toContain('large unchanged');
    expect(JSON.stringify(update)).not.toContain('private');
    const document = await fixture.get('/api/documents/doc');
    expect(document.json()).toEqual({ id: 'doc', recitationId: 'recitation', name: 'notes.md', text: 'private full document', lineCount: 1, createdAt: now });
    expect((await fixture.app.inject({ url: '/api/documents/doc' })).statusCode).toBe(401);
    expect((await fixture.get('/api/documents/__proto__')).statusCode).toBe(404);
  });

  it('never projects private answer keys or future questions into a delta', async () => {
    const fixture = await setup(); await fixture.get('/api/state');
    await fixture.repository.transact(data => {
      data.quizzes.quiz = { id: 'quiz', sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 1, createdAt: now, submittedAt: null, drafts: {}, answers: {},
        questions: ['visible-question', 'future-secret-question'].map(id => ({ id, knowledgeId: 'knowledge', kind: 'single', prompt: id, options: ['A', 'B'], correctIndex: 1, referenceAnswer: 'private-answer', rubric: [{ id: 'rubric', description: 'private-rubric', maxScore: 1 }], sourceIds: [] })) };
    });
    const update = (await fixture.get('/api/state?since=0')).json<PublicStateUpdate>();
    expect(update.kind).toBe('delta');
    if (update.kind !== 'delta') throw new Error('expected delta');
    expect(update.changes.quizzes?.upsert[0]?.questions).toHaveLength(1);
    for (const secret of ['correctIndex', 'referenceAnswer', 'rubric', 'private-answer', 'future-secret-question']) expect(JSON.stringify(update)).not.toContain(secret);
  });

  it('retains only sixteen fingerprint baselines and supplies each caller its own CSRF token', async () => {
    let state = publicState(0);
    const project = vi.fn(async () => structuredClone(state));
    const sync = new StateSync(project, async () => state.revision);
    await sync.get('first-session');
    for (let revision = 1; revision <= 16; revision++) { state = publicState(revision); await sync.get('first-session'); }
    expect((await sync.get('other-session', 0)).kind).toBe('snapshot');
    expect(await sync.get('other-session', 16)).toEqual({ kind: 'unchanged', revision: 16, csrfToken: 'other-session' });
    const update = await sync.get('other-session', 1);
    expect(update).toEqual({ kind: 'delta', fromRevision: 1, revision: 16, csrfToken: 'other-session', changes: {} });
    expect(JSON.stringify(update)).not.toContain('must-not-be-shared');
    expect(project).toHaveBeenCalledTimes(17);
  });

  it('falls back safely for repositories without a lightweight revision method', async () => {
    const state = publicState(7); const project = vi.fn(async () => structuredClone(state));
    const sync = new StateSync(project);
    await sync.get('token');
    expect((await sync.get('token', 7)).kind).toBe('unchanged');
    expect(project).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid upload key before attempting to parse malformed multipart and removes unused SSE', async () => {
    const fixture = await setup();
    const result = await fixture.app.inject({ method: 'POST', url: '/api/documents', headers: { ...fixture.headers, 'idempotency-key': 'bad', 'content-type': 'multipart/form-data; boundary=absent' }, payload: 'not a multipart upload' });
    expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe('INVALID_INPUT');
    expect(fixture.read).not.toHaveBeenCalled();
    expect((await fixture.get('/api/runs/nonexistent/events')).statusCode).toBe(404);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('accepts worst-case JSON escaped drafts even with tiny upload limits, without relaxing multipart limits', async () => {
    const fixture = await setup({ ...config, maxUploadBytes: 1 });
    const created = await fixture.app.inject({ method: 'POST', url: '/api/recitations', headers: fixture.headers, payload: {} });
    const id = created.json<{ id: string }>().id;
    const body = { version: 1, learned: '学'.repeat(LIMITS.recitationFieldChars), unclear: '疑'.repeat(LIMITS.recitationFieldChars), application: '用'.repeat(LIMITS.recitationFieldChars), topic: '' };
    const escaped = JSON.stringify(body).replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const saved = await fixture.app.inject({ method: 'PUT', url: `/api/recitations/${id}/draft`, headers: { ...fixture.headers, 'content-type': 'application/json' }, payload: escaped });
    expect(saved.statusCode).toBe(200);
    const uploaded = await fixture.app.inject({ method: 'POST', url: `/api/documents?recitationId=${id}`, headers: { ...fixture.headers, 'content-type': 'multipart/form-data; boundary=fixture' },
      payload: '--fixture\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nabc\r\n--fixture--\r\n' });
    expect(uploaded.statusCode).toBe(413);
  });

  it.each([false, true])('targets only active cancellations after commit (rollback=%s)', async rollback => {
    const fixture = await setup();
    await fixture.repository.transact(data => { data.runs.active = run('active', 'running'); data.runs.history = run('history', 'cancelled'); });
    vi.spyOn(fixture.worker, 'activeRunIds').mockReturnValue(['active']);
    const cancel = vi.spyOn(fixture.worker, 'cancel');
    const tick = vi.spyOn(fixture.worker, 'tick').mockResolvedValue();
    if (rollback) fixture.rollback();
    const result = await fixture.app.inject({ method: 'POST', url: '/api/runs/active/cancel', headers: fixture.headers, payload: {} });
    expect(result.statusCode).toBe(rollback ? 500 : 202);
    expect(fixture.read).not.toHaveBeenCalled();
    if (rollback) { expect(cancel).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled(); }
    else { expect(cancel).toHaveBeenCalledExactlyOnceWith('active'); expect(tick).toHaveBeenCalledOnce(); }
  });
});
