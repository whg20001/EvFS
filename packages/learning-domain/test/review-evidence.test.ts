import { describe, expect, it } from 'vitest';
import { emptyData } from '@sanxing/database';
import type { Answer, AppData, Evidence, KnowledgePoint, Quiz, Question } from '@sanxing/contracts';
import { recentWeaknessCues } from '../src/review-evidence.ts';
import { applyKnowledgeMerge, previewKnowledgeMerge } from '../src/knowledge-merge.ts';
import { validateData } from '../../database/src/validation.ts';
import { createLearningEngine, describeLearningPrompt, prepareLearningRequest } from '@sanxing/learning-agent';

const now = new Date('2026-10-22T12:00:00.000Z');
const point: KnowledgePoint = { id: 'k1', title: '缓存穿透', description: '不存在的数据反复访问数据库', sourceIds: ['s1'], version: 1, contentVersion: 2, understanding: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const question = (id: string): Question => ({ id, knowledgeId: point.id, knowledgeVersion: 2, kind: 'short', prompt: '解释缓存穿透的处理方式', options: [], correctIndex: null, referenceAnswer: 'PRIVATE', rubric: [{ id: 'r1', description: '说明空值缓存', maxScore: 5 }], sourceIds: ['s1'] });
function fixture() {
  const data = emptyData('live') as AppData;
  data.knowledge[point.id] = structuredClone(point);
  return data;
}
function add(data: AppData, id: string, options: Partial<{ score: number; maxScore: number; at: string; dimension: Evidence['dimension']; simulated: boolean; assisted: boolean; skipped: boolean; source: 'model' | 'manual' | 'automatic'; status: Answer['assessment']['status']; dispute: Answer['dispute']; submitted: boolean; knowledgeVersion: number | null }> = {}) {
  const quizId = `quiz-${id}`, questionId = `question-${id}`;
  const score = options.score ?? 2, maxScore = options.maxScore ?? 5;
  const answer: Answer = { text: '历史回答不发送', selectedIndex: null, assisted: options.assisted ?? false, skipped: options.skipped ?? false, submittedAt: options.at ?? '2026-10-20T00:00:00.000Z', assessment: { status: options.status ?? 'graded', score, maxScore, feedback: '需要解释失效策略', assessedAt: options.at ?? '2026-10-20T00:00:00.000Z', version: 1, source: options.source ?? 'model', scores: [{ rubricId: 'r1', description: '说明空值缓存', maxScore, score, evidence: '没有说明 TTL' }] }, ...(options.dispute ? { dispute: options.dispute } : {}) };
  const quiz: Quiz = { id: quizId, sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 1, questions: [question(questionId)], answers: { [questionId]: answer }, drafts: {}, submittedAt: options.submitted === false ? null : '2026-10-20T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z' };
  data.quizzes[quizId] = quiz;
  const evidence: Evidence = { id, knowledgeId: point.id, knowledgeVersion: options.knowledgeVersion === undefined ? 2 : options.knowledgeVersion, quizId, questionId, answer, dimension: options.dimension ?? 'immediate', simulated: options.simulated ?? false };
  data.evidence[id] = evidence;
}

describe('review weakness evidence', () => {
  it.each([800, 801, 1000])('keeps legacy feedback of %i characters within the executable cue limit', async length => {
    const data = fixture(); data.mode = 'mock';
    add(data, 'legacy', { simulated: true });
    const assessment = data.evidence.legacy!.answer.assessment;
    delete assessment.scores;
    assessment.feedback = 'x'.repeat(length);
    validateData(data, 'mock', 'local');
    const before = structuredClone(data);
    const cues = recentWeaknessCues(data, point.id, now);
    expect(cues[0]!.weakAreas[0]!.length).toBeLessThanOrEqual(800);
    expect(cues[0]!.weakAreas[0]).toBe(length === 800 ? assessment.feedback : `${'x'.repeat(799)}…`);
    const prepared = prepareLearningRequest({ kind: 'quiz', points: [point], sources: [{ id: 's1', name: 'notes', text: point.description }], count: 1, weaknesses: cues }, { maxOutputTokens: 4096 });
    await expect(createLearningEngine({ mode: 'mock' }).execute(prepared.task, { signal: new AbortController().signal, expectedPrompt: describeLearningPrompt(prepared.task) })).resolves.toMatchObject({ output: { kind: 'quiz' } });
    expect(data).toEqual(before);
  });

  it('includes the marker in the cap without splitting an emoji', () => {
    const data = fixture(); add(data, 'emoji');
    const assessment = data.evidence.emoji!.answer.assessment;
    delete assessment.scores;
    assessment.feedback = `${'x'.repeat(798)}😀end`;
    expect(recentWeaknessCues(data, point.id, now)[0]!.weakAreas).toEqual([`${'x'.repeat(798)}…`]);
    assessment.scores = [{ rubricId: 'r1', description: 'x', maxScore: 5, score: 1, evidence: `${'y'.repeat(495)}😀end` }];
    expect(recentWeaknessCues(data, point.id, now)[0]!.weakAreas).toEqual([`x: ${'y'.repeat(495)}…`]);
  });

  it.each([1, 2])('checks original content version %i across a merge chain with different target counters', version => {
    const data = fixture(); add(data, 'merged', { knowledgeVersion: version });
    data.knowledge[point.id]!.contentHistory = [{ version: 1, title: point.title, description: 'Old definition', sourceIds: ['s1'], createdAt: point.createdAt }];
    data.quizzes['quiz-merged']!.questions[0]!.knowledgeVersion = version;
    data.knowledge.target = { ...structuredClone(point), id: 'target', contentVersion: 1 };
    data.knowledge.final = { ...structuredClone(point), id: 'final', contentVersion: 7 };
    const expected = version === 2 ? 1 : 0;
    expect(recentWeaknessCues(data, point.id, now)).toHaveLength(expected);
    applyKnowledgeMerge(data, previewKnowledgeMerge(data, point.id, 'target'), null, now.toISOString());
    validateData(data, 'live', 'local');
    expect(recentWeaknessCues(data, 'target', now)).toHaveLength(expected);
    applyKnowledgeMerge(data, previewKnowledgeMerge(data, 'target', 'final'), null, now.toISOString());
    validateData(data, 'live', 'local');
    expect(recentWeaknessCues(data, 'final', now)).toHaveLength(expected);
  });

  it('uses the original question version when the evidence version is unknown', () => {
    const data = fixture(); add(data, 'legacy', { knowledgeVersion: null });
    expect(recentWeaknessCues(data, point.id, now)).toHaveLength(1);
    data.quizzes['quiz-legacy']!.questions[0]!.knowledgeVersion = 1;
    expect(recentWeaknessCues(data, point.id, now)).toEqual([]);
    delete data.quizzes['quiz-legacy']!.questions[0]!.knowledgeVersion;
    expect(recentWeaknessCues(data, point.id, now)).toHaveLength(1);
    expect(data.evidence.legacy!.knowledgeVersion).toBeNull();
  });

  it('rejects a question from another member of the merged family', () => {
    const data = fixture(); add(data, 'mismatch');
    data.knowledge.target = { ...structuredClone(point), id: 'target' };
    applyKnowledgeMerge(data, previewKnowledgeMerge(data, point.id, 'target'), null, now.toISOString());
    data.quizzes['quiz-mismatch']!.questions[0]!.knowledgeId = 'target';
    expect(recentWeaknessCues(data, 'target', now)).toEqual([]);
  });

  it('selects at most three recent independent misses, prioritizes delayed recall, and sends only bounded cues', () => {
    const data = fixture();
    add(data, 'immediate', { score: 2 });
    add(data, 'delayed-mild', { score: 4, dimension: 'delayed' });
    add(data, 'delayed-weak', { score: 1, dimension: 'delayed' });
    add(data, 'fourth', { score: 3 });
    add(data, 'perfect', { score: 5 });
    const cues = recentWeaknessCues(data, point.id, now);
    expect(cues).toHaveLength(3);
    expect(cues.map(cue => [cue.dimension, cue.score])).toEqual([['delayed', 1], ['delayed', 4], ['immediate', 2]]);
    expect(cues[0]!.question).toBe('解释缓存穿透的处理方式');
    expect(cues[0]!.weakAreas).toEqual(['说明空值缓存: 没有说明 TTL']);
    expect(JSON.stringify(cues)).not.toContain('历史回答不发送');
  });

  it('excludes evidence that is simulated, assisted, skipped, manual, disputed, unsubmitted, stale, or outside the window', () => {
    const data = fixture();
    add(data, 'simulated', { simulated: true });
    add(data, 'assisted', { assisted: true });
    add(data, 'skipped', { skipped: true });
    add(data, 'manual', { source: 'manual' });
    add(data, 'disputed', { dispute: { reason: '不准确', createdAt: now.toISOString(), resolvedAt: null } });
    add(data, 'unsubmitted', { submitted: false });
    add(data, 'stale', { knowledgeVersion: 1 });
    add(data, 'old', { at: '2026-09-20T00:00:00.000Z' });
    add(data, 'pending', { status: 'pending' });
    expect(recentWeaknessCues(data, point.id, now)).toEqual([]);
  });

  it('only uses evidence matching the active model mode and the requested knowledge point', () => {
    const data = fixture();
    add(data, 'live');
    add(data, 'wrong-point');
    data.evidence['wrong-point']!.knowledgeId = 'other';
    expect(recentWeaknessCues(data, point.id, now)).toHaveLength(1);
    data.mode = 'mock';
    expect(recentWeaknessCues(data, point.id, now)).toEqual([]);
  });
});
