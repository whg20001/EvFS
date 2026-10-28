import { afterEach, expect, it, vi } from 'vitest';
import { openRepository } from '@sanxing/database';
import type { EvidencePage, KnowledgeMergePreview, PublicQuiz, PublicState } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { phaseFourData, phaseFourNow } from '../../../tests/fixtures/phase-four.ts';
const opened: { app: Awaited<ReturnType<typeof createApp>>; repository: Awaited<ReturnType<typeof openRepository>> }[] = [];
afterEach(async () => { for (const item of opened.splice(0)) { await item.app.app.close(); await item.repository.close(); } });
async function fixture() {
  const config = readConfig({ OWNER_PASSWORD: 'phase-four-test-password', SESSION_SECRET: 'phase-four-test-secret-'.repeat(4), AI_MODE: 'mock' });
  const repository = await openRepository(':memory:', 'mock'); await repository.replace(phaseFourData());
  const execute = vi.fn(async () => { throw new Error('No model call expected'); });
  const app = await createApp({ config, repository, engine: { mode: 'mock', execute }, startWorker: false, now: () => new Date(phaseFourNow) }); opened.push({ app, repository });
  const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  let serial = 0;
  const read = (url: string) => app.app.inject({ url, headers });
  const write = (url: string, payload: object, key = `phase-four-command-${++serial}`) => app.app.inject({ method: 'POST', url, payload, headers: { ...headers, 'idempotency-key': key } });
  return { app: app.app, repository, execute, headers, read, write };
}
it('authenticates preview/detail reads and commits the exact merge once, preserving histories and chosen schedule', async () => {
  const f = await fixture(); const before = await f.repository.read();
  expect((await f.app.inject({ url: '/api/quizzes/q0' })).statusCode).toBe(401);
  expect((await f.app.inject({ url: '/api/knowledge-points/a/evidence' })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/knowledge-points/a/merge-preview', headers: { cookie: f.headers.cookie }, payload: { targetId: 'b' } })).statusCode).toBe(403);
  const preview = (await f.write('/api/knowledge-points/a/merge-preview', { targetId: 'b' })).json<KnowledgeMergePreview>();
  expect(preview.evidenceCount).toBe(24); expect(await f.repository.read()).toEqual(before);
  const body = { targetId: 'b', expectedRevision: preview.revision, retainedCardId: 'a', confirm: true };
  expect((await f.write('/api/knowledge-points/a/merge', { ...body, expectedRevision: 0 })).statusCode).toBe(409);
  const result = await f.write('/api/knowledge-points/a/merge', body, 'merge-once-test'); expect(result.statusCode).toBe(200);
  expect((await f.write('/api/knowledge-points/a/merge', body, 'merge-once-test')).json()).toEqual(result.json());
  const after = await f.repository.read(); expect(after.evidence).toEqual(before.evidence); expect(after.quizzes).toEqual(before.quizzes); expect(after.cards.a!.schedule).toEqual(before.cards.a!.schedule); expect(after.cards.b!.retiredAt).toBe(phaseFourNow);
  expect((await f.write('/api/reviews/b/start', {})).statusCode).toBe(409);
  const start = await f.write('/api/reviews/a/start', {}); expect(start.statusCode).toBe(200);
  expect(f.execute).not.toHaveBeenCalled();
});
it('serves compact snapshots, paginated evidence, and exact private details without confusing summaries with empty history', async () => {
  const f = await fixture();
  const summary = (await f.read('/api/state?compact=1')).json<PublicState>();
  expect(summary.quizzes[0]).toMatchObject({ detailsOmitted: true, questions: [] }); expect(summary.evidence[0]).not.toHaveProperty('answer');
  const detail = (await f.read('/api/quizzes/q0')).json<PublicQuiz>(); expect(detail.questions[0]!.answer!.text).toBe('原答案 0'); expect(detail.detailsOmitted).toBeUndefined();
  const page = (await f.read('/api/knowledge-points/a/evidence?limit=5')).json<EvidencePage>(); expect(page.items).toHaveLength(5); expect(page.total).toBe(12); expect(page.nextOffset).toBe(5);
  const next = (await f.read(`/api/knowledge-points/a/evidence?limit=5&offset=5&expectedRevision=${page.revision}`)).json<EvidencePage>(); expect(next.items.some(item => page.items.some(previous => previous.id === item.id))).toBe(false);
  await f.repository.transact(data => { data.quizzes.q0!.version++; data.quizzes.q0!.answers.q0!.assessment.feedback = '核对后的评价'; });
  expect((await f.read(`/api/knowledge-points/a/evidence?offset=5&expectedRevision=${page.revision}`)).statusCode).toBe(409);
  const delta = (await f.read(`/api/state?compact=1&since=${summary.revision}`)).json(); expect(delta.kind).toBe('delta'); expect(delta.changes.quizzes.upsert[0]).toMatchObject({ id: 'q0', version: 2, detailsOmitted: true });
  expect((await f.read('/api/quizzes/q0')).json<PublicQuiz>().questions[0]!.answer!.assessment.feedback).toBe('核对后的评价');
  expect((await f.read('/api/state')).json<PublicState>().evidence[0]).toHaveProperty('answer');
});
it('persists queue preferences with CAS and applies a due-only batch without model calls or scheduling writes', async () => {
  const f = await fixture(); const before = await f.repository.read();
  const payload = { expectedRevision: before.revision, confirm: true, schedulingEnabled: true, promptCacheRetention: 'none', reviewOrder: 'weakness', reviewBatchSize: 1 };
  const saved = await f.app.inject({ method: 'PUT', url: '/api/learning/preferences', headers: { ...f.headers, 'idempotency-key': 'save-preferences-test' }, payload }); expect(saved.statusCode).toBe(200);
  expect((await f.read('/api/reviews/plan')).json()).toMatchObject({ totalDue: 3, batchSize: 1, cards: [{ id: 'a' }] });
  const after = await f.repository.read(); expect(after.cards).toEqual(before.cards); expect(after.reviewEvents).toEqual(before.reviewEvents); expect(f.execute).not.toHaveBeenCalled();
  expect((await f.read('/api/learning/preferences')).json()).toMatchObject({ reviewOrder: 'weakness', reviewBatchSize: 1 });
});
