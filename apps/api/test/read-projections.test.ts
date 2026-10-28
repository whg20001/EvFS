import { afterEach, expect, it } from 'vitest';
import { openRepository, type Repository } from '@sanxing/database';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { phaseFourData, phaseFourNow } from '../../../tests/fixtures/phase-four.ts';

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function fixture() {
  const repository = await openRepository(':memory:', 'mock'); resources.push(() => repository.close());
  const data = phaseFourData();
  data.documents.doc = { id: 'doc', recitationId: 'q0', name: 'private.md', text: 'document text', originalBase64: Buffer.from('document text').toString('base64'), hash: 'PRIVATE_HASH', lineCount: 1, createdAt: phaseFourNow };
  data.recitations.q0!.documentIds = ['doc'];
  data.skills = [{ id: '00000000-0000-4000-8000-000000000001', version: 1, enabled: false, tasks: ['quiz'],
    document: { name: 'example-method', description: 'Teaching method', instructions: 'PRIVATE_SKILL_INSTRUCTIONS' }, createdAt: phaseFourNow, updatedAt: phaseFourNow }];
  await repository.replace(data);
  const config = readConfig({ AI_MODE: 'mock', OWNER_PASSWORD: 'read-tests-only', SESSION_SECRET: 'read-tests-only-'.repeat(4) });
  async function app(optimized: boolean) {
    let fullReads = 0;
    const reader: Repository = { ...repository, ...(optimized ? {} : { readFields: undefined, readEntity: undefined }), read: async () => { fullReads++; return repository.read(); } };
    const instance = await createApp({ config, repository: reader, engine: { mode: 'mock', async execute() { throw new Error('No model calls'); } }, startWorker: false, now: () => new Date(phaseFourNow) });
    resources.push(() => instance.app.close());
    const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
    return { instance, headers, reads: () => fullReads,
      read: (url: string) => instance.app.inject({ url, headers }),
      search: (payload: object) => instance.app.inject({ method: 'POST', url: '/api/library/search', headers, payload }) };
  }
  return { repository, data, optimized: await app(true), legacy: await app(false) };
}

it('keeps query responses byte-identical with legacy adapters while eliminating full aggregate reads', async () => {
  const f = await fixture(); const before = await f.repository.read();
  const urls = ['/api/documents/doc', '/api/documents/doc/original', '/api/quizzes/q0', '/api/learning/preferences',
    '/api/ai/skills', `/api/ai/skills/${f.data.skills![0]!.id}`, '/api/knowledge-points/a/evidence?limit=5', '/api/learning/statistics?days=0', '/api/reviews/plan'];
  const optimizedStart = f.optimized.reads(); const legacyStart = f.legacy.reads();
  for (const url of urls) {
    const actual = await f.optimized.read(url); const expected = await f.legacy.read(url);
    expect(actual.statusCode, url).toBe(200); expect(actual.body, url).toBe(expected.body);
    expect(actual.headers['content-type']).toBe(expected.headers['content-type']);
  }
  const search = { query: '内容', limit: 2, includeUnderstanding: true, expandTerms: true };
  expect((await f.optimized.search(search)).body).toBe((await f.legacy.search(search)).body);
  expect(f.optimized.reads() - optimizedStart).toBe(0); expect(f.legacy.reads() - legacyStart).toBe(urls.length + 1);
  expect(await f.repository.read()).toEqual(before);
});

it('preserves authentication, missing-record errors and private-answer/document/Skill filtering', async () => {
  const f = await fixture();
  for (const url of ['/api/quizzes/q0', '/api/documents/doc', '/api/ai/skills', '/api/learning/preferences']) {
    expect((await f.optimized.instance.app.inject({ url })).statusCode).toBe(401);
  }
  for (const endpoint of ['quizzes', 'documents']) for (const id of ['missing', '__proto__', 'constructor']) {
    const response = await f.optimized.read(`/api/${endpoint}/${id}`);
    expect(response.statusCode).toBe(404); expect(response.json().error.code).toBe('NOT_FOUND');
  }
  const document = await f.optimized.read('/api/documents/doc');
  expect(document.body).not.toContain('PRIVATE_HASH'); expect(document.json()).not.toHaveProperty('originalBase64');
  expect((await f.optimized.read('/api/ai/skills')).body).not.toContain('PRIVATE_SKILL_INSTRUCTIONS');
  await f.repository.transact(data => {
    const quiz = data.quizzes.q0!; quiz.submittedAt = null; quiz.answers = {};
    quiz.questions.push({ ...structuredClone(quiz.questions[0]!), id: 'future', prompt: 'PRIVATE_FUTURE_QUESTION' });
  });
  const quiz = await f.optimized.read('/api/quizzes/q0');
  expect(quiz.json().questions).toHaveLength(1);
  for (const hidden of ['PRIVATE_REFERENCE', 'PRIVATE_FUTURE_QUESTION', 'rubric']) expect(quiz.body).not.toContain(hidden);
});

it('observes committed edits and keeps search/evidence pagination revision checks after narrowing reads', async () => {
  const f = await fixture(); const before = await f.repository.revision();
  await f.repository.transact(data => {
    data.quizzes.q0!.version++; data.quizzes.q0!.answers.q0!.assessment.feedback = 'new feedback';
    data.learningPreferences = { schedulingEnabled: false, promptCacheRetention: 'short' };
    data.skills![0]!.enabled = true;
  });
  expect((await f.optimized.read('/api/quizzes/q0')).json().questions[0].answer.assessment.feedback).toBe('new feedback');
  expect((await f.optimized.read('/api/learning/preferences')).json()).toMatchObject({ revision: before + 1, promptCacheRetention: 'short' });
  expect((await f.optimized.read('/api/ai/skills')).json().items[0].enabled).toBe(true);
  const evidence = await f.optimized.read(`/api/knowledge-points/a/evidence?offset=5&expectedRevision=${before}`);
  expect(evidence.statusCode).toBe(409); expect(evidence.json().error.code).toBe('EVIDENCE_CHANGED');
  const search = await f.optimized.search({ query: '内容', expectedRevision: before });
  expect(search.statusCode).toBe(409); expect(search.json().error.code).toBe('SEARCH_CHANGED');
});
