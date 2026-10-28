import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRepository } from '@sanxing/database';
import type { AppData, LearningEngine, LearningPreferencesView, LibrarySearchResult, TaskInputPreview } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const now = '2026-01-03T00:00:00.000Z';
const resources: { app: Awaited<ReturnType<typeof createApp>>; repository: Awaited<ReturnType<typeof openRepository>> }[] = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline library tests must not access the network'); })); });
afterEach(async () => {
  for (const item of resources.splice(0)) { await item.app.app.close(); await item.repository.close(); }
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function fixture() {
  const config = { ...readConfig({ OWNER_PASSWORD: 'library-test-password', SESSION_SECRET: 'library-test-secret-'.repeat(4), AI_MODE: 'mock' }), schedulingEnabled: false };
  const repository = await openRepository(':memory:', config.mode);
  const execute = vi.fn<LearningEngine['execute']>(async () => { throw new Error('These commands must not automatically execute a model'); });
  const instance = await createApp({ config, repository, engine: { mode: 'mock', execute }, now: () => new Date(now), startWorker: false });
  resources.push({ app: instance, repository });
  vi.spyOn(instance.worker, 'tick').mockResolvedValue();
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  let serial = 0;
  const write = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload: object) => instance.app.inject({ method, url, headers: { ...headers, 'idempotency-key': `library-command-${++serial}` }, payload });
  const search = (query: string, kind?: 'document' | 'knowledge') => instance.app.inject({ method: 'POST', url: '/api/library/search', headers, payload: { query, ...(kind ? { kind } : {}) } });
  const created = await write('POST', '/api/recitations', { learningDate: '2026-01-01' });
  const recitationId = created.json<{ id: string }>().id;
  const upload = async (name: string, text: string) => {
    const result = await write('POST', '/api/documents', { recitationId, name, text });
    expect(result.statusCode).toBe(201); return result.json<{ id: string }>().id;
  };
  const preferences = async () => (await instance.app.inject({ url: '/api/learning/preferences', headers })).json<LearningPreferencesView>();
  const settings = async (schedulingEnabled: boolean, promptCacheRetention: 'none' | 'short' = 'none', associationEnabled?: boolean) => write('PUT', '/api/learning/preferences', { expectedRevision: (await repository.read()).revision, schedulingEnabled, promptCacheRetention, ...(associationEnabled === undefined ? {} : { associationEnabled }), confirm: true });
  const seedKnowledge = async (sourceIds: string[] = []) => repository.transact(data => {
    data.knowledge.old = { id: 'old', title: '此前学过的动态规划', description: '通过状态转移复用重叠子问题的解，避免重复计算。OLD_VERSION_ONE', sourceIds, version: 1, contentVersion: 1,
      contentHistory: [{ version: 1, title: '此前学过的动态规划', description: '通过状态转移复用重叠子问题的解，避免重复计算。OLD_VERSION_ONE', sourceIds: [...sourceIds], createdAt: now }], understanding: '', createdAt: now, updatedAt: now };
  });
  return { ...instance, repository, execute, headers, write, search, recitationId, upload, preferences, settings, seedKnowledge };
}

describe('local library and explicit learning preferences', () => {
  it('searches old documents and differently titled knowledge without any write or model request', async () => {
    const f = await fixture();
    const id = await f.upload('memo.md', '无关开头\n重叠子问题通过记忆化避免重复计算。\n无关结尾');
    await f.seedKnowledge([id]);
    const before = await f.repository.read();
    const response = await f.search('记忆化 重叠子问题');
    expect(response.statusCode).toBe(200);
    const result = response.json<LibrarySearchResult>();
    expect(result.strategy).toBe('local-bm25-v1');
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'document', id }), expect.objectContaining({ kind: 'knowledge', id: 'old', contentVersion: 1 })]));
    expect(result.hits.every(hit => hit.startLine >= 1 && hit.endLine >= hit.startLine)).toBe(true);
    expect(response.body).not.toContain('originalBase64'); expect(response.body).not.toContain('rubric');
    expect((await f.search('...')).json<LibrarySearchResult>().hits).toEqual([]);
    expect((await f.search('重叠子问题', 'knowledge')).json<LibrarySearchResult>().hits.every(hit => hit.kind === 'knowledge')).toBe(true);
    expect(await f.repository.read()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
  });

  it('protects read-only search and setting writes with identity, CSRF, Origin and input limits', async () => {
    const f = await fixture(); const url = '/api/library/search';
    expect((await f.app.inject({ method: 'POST', url, payload: { query: '私密查询' } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url, headers: { cookie: f.headers.cookie }, payload: { query: '私密查询' } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url, headers: { ...f.headers, origin: 'https://untrusted.invalid' }, payload: { query: '私密查询' } })).statusCode).toBe(403);
    expect((await f.search('x'.repeat(2001))).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url: '/api/learning/preferences', headers: f.headers, payload: { expectedRevision: 1, schedulingEnabled: true, promptCacheRetention: 'short', confirm: true } })).statusCode).toBe(400);
    const before = await f.repository.read();
    expect((await f.write('PUT', '/api/learning/preferences', { expectedRevision: before.revision, schedulingEnabled: true, promptCacheRetention: 'short' })).statusCode).toBe(400);
    expect(await f.repository.read()).toEqual(before);
  });

  it('explicitly attaches a historical document without copying it and only detaches the new reference', async () => {
    const f = await fixture(); const docId = await f.upload('old.md', '用于跨会话复用的原文');
    const created = await f.write('POST', '/api/recitations', { learningDate: '2026-01-02' }); const id = created.json().id as string;
    const attached = await f.write('POST', `/api/recitations/${id}/references`, { version: 1, documentId: docId, confirm: true });
    expect(attached.statusCode).toBe(200);
    const state = await f.repository.read();
    expect(state.recitations[id]!.documentIds).toEqual([docId]); expect(Object.keys(state.documents)).toEqual([docId]);
    expect(state.documents[docId]!.recitationId).toBe(f.recitationId);
    const preview = await f.app.inject({ method: 'POST', url: `/api/recitations/${id}/input-preview`, headers: f.headers, payload: { input: { learned: '跨会话复用', unclear: '', application: '', topic: '' } } });
    expect(preview.json<TaskInputPreview>()).toMatchObject({ documentCount: 1, canSubmit: true });
    const removed = await f.write('DELETE', `/api/recitations/${id}/documents/${docId}`, { version: state.recitations[id]!.version });
    expect(removed.statusCode).toBe(200);
    const after = await f.repository.read(); expect(after.recitations[id]!.documentIds).toEqual([]);
    expect(after.documents[docId]).toEqual(state.documents[docId]); expect(after.recitations[f.recitationId]!.documentIds).toEqual([docId]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('persists explicit settings with revision fencing and adds historical cards only on a separate command', async () => {
    const f = await fixture(); await f.seedKnowledge();
    expect(await f.preferences()).toMatchObject({ source: 'environment', schedulingEnabled: false, promptCacheRetention: 'none' });
    const revision = (await f.repository.read()).revision;
    expect((await f.settings(true, 'short')).statusCode).toBe(200);
    expect(await f.preferences()).toMatchObject({ source: 'saved', schedulingEnabled: true, promptCacheRetention: 'short' });
    const me = await f.app.inject({ url: '/api/me', headers: f.headers }); expect(me.json().capabilities.schedulingEnabled).toBe(true);
    expect(Object.values((await f.repository.read()).cards)).toEqual([]);
    expect((await f.write('PUT', '/api/learning/preferences', { expectedRevision: revision, schedulingEnabled: false, promptCacheRetention: 'none', confirm: true })).statusCode).toBe(409);
    const body = { version: 1, confirm: true };
    expect((await f.write('POST', '/api/knowledge-points/old/review-card', body)).statusCode).toBe(200);
    expect((await f.write('POST', '/api/knowledge-points/old/review-card', body)).statusCode).toBe(200);
    expect(Object.values((await f.repository.read()).cards)).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('automatically freezes associated old knowledge when enabled, without merging or extending the assessed point set', async () => {
    const f = await fixture(); const docId = await f.upload('current.md', '递归的记忆化缓存用于消除重叠子问题'); await f.seedKnowledge();
    expect((await f.settings(false, 'none', true)).statusCode).toBe(200);
    expect((await f.preferences()).associationEnabled).toBe(true);
    let data = await f.repository.read();
    await f.write('PUT', `/api/recitations/${f.recitationId}/draft`, { version: data.recitations[f.recitationId]!.version, learned: '学习了记忆化递归，用缓存避免重复计算重叠子问题', unclear: '', application: '', topic: '' });
    data = await f.repository.read();
    const submitted = await f.write('POST', `/api/recitations/${f.recitationId}/submit`, { version: data.recitations[f.recitationId]!.version });
    expect(submitted.statusCode).toBe(202);
    const extract = await f.service.claimRun(); expect(extract?.task.kind).toBe('extract');
    await f.service.finishRun(extract!.id, extract!.attemptId!, { output: { kind: 'extract', candidates: [{ title: '记忆化递归', description: '复用已计算的递归结果，避免重复计算重叠子问题', sourceIds: [docId] }] }, usage: null });
    data = await f.repository.read(); const session = data.sessions[extract!.sessionId!]!;
    // Unknown keys (the removed manual picker) are ignored: association is automatic and preference-gated.
    const confirmed = await f.write('POST', `/api/sessions/${session.id}/confirmations`, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })), relatedKnowledgeIds: ['ignored'] });
    expect(confirmed.statusCode).toBe(202);
    data = await f.repository.read(); const run = data.runs[confirmed.json().runId]!;
    if (run.task.kind !== 'followup') throw new Error('expected followup');
    expect(run.task.points).toHaveLength(1); expect(run.task.points[0]!.id).not.toBe('old');
    expect(run.task.related).toEqual([expect.objectContaining({ id: 'old', knowledgeVersion: 1, description: expect.stringContaining('OLD_VERSION_ONE') })]);
    expect(run.task.sources.some(source => source.id.startsWith('knowledge:'))).toBe(false); // related is not a citable source
    expect(data.knowledge.old!.contentVersion).toBe(1);
    expect(data.sessions[session.id]!.relatedKnowledge?.[0]?.knowledgeVersion).toBe(1);
    expect((await f.settings(false)).statusCode).toBe(409); // active tasks fence preference changes
    await f.write('POST', `/api/runs/${run.id}/cancel`, {});
    await f.repository.transact(draft => {
      const point = draft.knowledge.old!; point.title = '修改后的旧知识'; point.description = 'NEW_VERSION_TWO'; point.version++; point.contentVersion = 2;
      point.contentHistory!.push({ version: 2, title: point.title, description: point.description, sourceIds: [...point.sourceIds], createdAt: now });
    });
    const retried = await f.write('POST', `/api/runs/${run.id}/retry`, {});
    expect(retried.statusCode).toBe(202);
    expect((await f.repository.read()).runs[retried.json().runId]!.task).toEqual(run.task);
  });

  it('review retrieval reads only the selected knowledge sources, including a matching late document chunk', async () => {
    const f = await fixture();
    // Larger than the model input budget, so retrieval (not full text) must find the late chunk.
    const document = `${'plain background line.\n'.repeat(2500)}TAIL_NEEDLE 重叠子问题通过记忆化缓存复用结果。`;
    const documentId = await f.upload('origin.md', document);
    await f.upload('unrelated.md', 'UNRELATED_PRIVATE_BODY TAIL_NEEDLE'); await f.seedKnowledge([documentId]);
    await f.settings(true);
    await f.write('POST', '/api/knowledge-points/old/review-card', { version: 1, confirm: true });
    const card = Object.values((await f.repository.read()).cards)[0]!;
    const started = await f.write('POST', `/api/reviews/${card.id}/start`, {}); const reviewId = started.json().reviewSessionId as string;
    const response = await f.write('PUT', `/api/review-sessions/${reviewId}/recall`, { version: 1, text: 'TAIL_NEEDLE 重叠子问题 记忆化', action: 'submitted' });
    expect(response.statusCode).toBe(202);
    const task = (await f.repository.read()).runs[response.json().runId]!.task;
    if (task.kind !== 'quiz') throw new Error('expected quiz');
    expect(task.sources.find(source => source.id === documentId)?.text).toContain('TAIL_NEEDLE');
    expect(task.sources.find(source => source.id === documentId)!.text.length).toBeLessThan(document.length);
    expect(task.sources.find(source => source.id === documentId)!.text).toMatch(/^\[来源节选：超出输入预算，按本地 BM25/);
    expect(JSON.stringify(task)).not.toContain('UNRELATED_PRIVATE_BODY');
    expect(task.points[0]!.knowledgeVersion).toBe(1); expect(task.sources.some(source => source.id === 'knowledge:old:v1')).toBe(true);
  });
});

it('exposes authenticated read-only statistics and validates search pagination parameters', async () => {
  const f = await fixture(); const before = await f.repository.read();
  expect((await f.app.inject({ url: '/api/learning/statistics' })).statusCode).toBe(401);
  const response = await f.app.inject({ url: '/api/learning/statistics?days=7', headers: f.headers });
  expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ revision: before.revision, total: 0, simulated: true, throughDate: '2026-01-03' });
  expect((await f.app.inject({ url: '/api/learning/statistics?days=500', headers: f.headers })).statusCode).toBe(400);
  for (const options of [{ offset: -1 }, { limit: 51 }, { includeUnderstanding: 'true' }]) expect((await f.app.inject({ method: 'POST', url: '/api/library/search', headers: f.headers, payload: { query: 'needle', ...options } })).statusCode).toBe(400);
  const stale = await f.app.inject({ method: 'POST', url: '/api/library/search', headers: f.headers, payload: { query: 'needle', offset: 10, expectedRevision: before.revision + 1 } });
  expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('SEARCH_CHANGED');
  expect(await f.repository.read()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
});
