import { expect, it } from 'vitest';
import { emptyData } from '@sanxing/database';
import type { Answer, AppData, Evidence } from '@sanxing/contracts';
import { learningStatistics } from '../src/statistics.ts';
import { newSchedule } from '../src/policy.ts';
import { reviewRating } from '../src/review-policy.ts';

const now = new Date('2026-03-08T06:30:00Z'); // DST transition day in New York
function fixture() {
  const data = emptyData('live');
  data.knowledge.k = { id: 'k', title: '缓存', description: 'TTL', sourceIds: [], version: 1, understanding: '', createdAt: now.toISOString(), updatedAt: now.toISOString() };
  return data;
}
function add(data: AppData, id: string, change: Partial<Answer> = {}, options: Partial<Evidence> = {}) {
  const answer: Answer = { text: 'TTL', selectedIndex: null, assisted: false, skipped: false, submittedAt: now.toISOString(), assessment: { status: 'graded', score: 1, maxScore: 2, feedback: 'partial', assessedAt: now.toISOString(), version: 2, source: 'model', scores: [{ rubricId: 'r1', description: '设置过期时间', score: 1, maxScore: 2, evidence: 'TTL' }] }, ...change };
  data.quizzes[id] = { id, sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 1, questions: [], answers: { [id]: answer }, drafts: {}, createdAt: now.toISOString(), submittedAt: now.toISOString() };
  data.evidence[id] = { id, knowledgeId: 'k', quizId: id, questionId: id, answer, dimension: 'immediate', simulated: false, ...options };
  return answer;
}
it('partitions evidence, excludes open quizzes and other modes, and traces every independent loss', () => {
  const data = fixture(); const answer = add(data, 'independent');
  add(data, 'delayed', { assessment: { ...answer.assessment, score: 2, scores: [] } }, { dimension: 'delayed' });
  add(data, 'assisted', { assisted: true }); add(data, 'skip', { skipped: true, assisted: true });
  add(data, 'pending', { assessment: { ...answer.assessment, status: 'pending', score: null } });
  add(data, 'dispute', { dispute: { reason: '核对', createdAt: now.toISOString(), resolvedAt: null } });
  add(data, 'manual', { assessment: { ...answer.assessment, source: 'manual' } });
  add(data, 'mock', {}, { simulated: true }); add(data, 'open'); data.quizzes.open!.submittedAt = null;
  data.evidence.duplicate = { ...data.evidence.independent!, id: 'duplicate' };
  const before = structuredClone(data); const result = learningStatistics(data, now, 'America/New_York');
  expect(result.total).toBe(7); expect(result.categories).toEqual({ independent: 2, assisted: 1, skipped: 1, pending: 1, verification: 1, manual: 1 });
  expect(result.performance.immediate).toEqual({ count: 1, fullScore: 0, score: 1, maxScore: 2 });
  expect(result.performance.delayed).toEqual({ count: 1, fullScore: 1, score: 2, maxScore: 2 });
  expect(result.losses).toEqual([{ knowledgeId: 'k', title: '缓存', description: '设置过期时间', count: 1, lostScore: 1, evidenceIds: ['independent'] }]);
  expect(result.records).toHaveLength(7); expect(data).toEqual(before);
  data.evidence.independent!.answer.assessmentHistory = [structuredClone(answer.assessment)];
  data.evidence.independent!.answer.assessment = { ...answer.assessment, version: 3, score: 2, scores: [] };
  expect(learningStatistics(data, now, 'America/New_York').losses).toEqual([]);
});
it('uses timezone calendar days across DST and keeps suspended/archived cards out of workload', () => {
  const data = fixture();
  add(data, 'boundary', { submittedAt: '2026-03-02T05:00:00Z' }); add(data, 'outside', { submittedAt: '2026-03-02T04:59:59Z' });
  add(data, 'future', { submittedAt: '2026-03-08T07:00:00Z' });
  data.knowledge.archived = { ...data.knowledge.k!, id: 'archived', archivedAt: now.toISOString() };
  for (const [id, due, paused, knowledgeId] of [['overdue', '2026-03-08T04:59:59Z', false, 'k'], ['today', '2026-03-09T03:59:59Z', false, 'k'], ['tomorrow', '2026-03-09T04:00:00Z', false, 'k'], ['paused', '2026-01-01T00:00:00Z', true, 'k'], ['archived', '2026-01-01T00:00:00Z', false, 'archived']] as const) {
    data.cards[id] = { id, knowledgeId, version: 1, createdAt: now.toISOString(), pausedAt: paused ? now.toISOString() : null, schedule: { ...newSchedule(now), due } };
  }
  const result = learningStatistics(data, now, 'America/New_York', 7);
  expect(result.fromDate).toBe('2026-03-02'); expect(result.total).toBe(1);
  expect(result.due.overdue).toBe(1); expect(result.due.days.slice(0, 2)).toEqual([{ date: '2026-03-08', count: 1 }, { date: '2026-03-09', count: 1 }]);
  expect(result.due.paused).toBe(1); expect(result.due.archived).toBe(1);
});
it('retains mapping-v1 behavior, including partial answers and no eligible answers', () => {
  const answer = add(fixture(), 'test');
  expect(reviewRating([answer], 4)).toEqual({ rating: 1, reviewedAt: now.toISOString() });
  expect(reviewRating([{ ...answer, assessment: { ...answer.assessment, score: 2 } }], 4)?.rating).toBe(4);
  expect(reviewRating([{ ...answer, assisted: true }, { ...answer, assessment: { ...answer.assessment, source: 'manual' } }], 4)).toBeNull();
});

it('keeps each report timezone independent when reports alternate across a local-day boundary', () => {
  const data = fixture(); add(data, 'same-instant');
  for (const [timezone, expected] of [['America/Los_Angeles', '2026-03-07'], ['Asia/Shanghai', '2026-03-08'], ['UTC', '2026-03-08'], ['America/Los_Angeles', '2026-03-07']] as const) {
    const result = learningStatistics(data, now, timezone, 7);
    expect(result.throughDate).toBe(expected); expect(result.total).toBe(1);
    expect(result.timezone).toBe(timezone);
  }
});
