import { expect, it } from 'vitest';
import { currentKnowledgeId } from '@sanxing/contracts';
import { LearningService, previewKnowledgeMerge, projectState, reviewPlan } from '../src/index.ts';
import { validateData } from '../../database/src/validation.ts';
import { phaseFourData, phaseFourConfig, phaseFourNow } from '../../../tests/fixtures/phase-four.ts';
const service = new LearningService({ read: async () => phaseFourData(), transact: async fn => fn(phaseFourData()) }, phaseFourConfig, () => new Date(phaseFourNow));
function merge(data = phaseFourData(), retainedCardId: string | null = 'a') {
  return service.mergeKnowledge(data, 'a', { targetId: 'b', expectedRevision: data.revision, retainedCardId, confirm: true });
}
it('previews without mutation and merges sources while preserving every historical identity, version and schedule', () => {
  const data = phaseFourData(); data.cards.a!.pausedAt = phaseFourNow; const before = structuredClone(data);
  expect(previewKnowledgeMerge(data, 'a', 'b')).toMatchObject({ sourceIds: ['source-b', 'source-a'], evidenceCount: 24, sessionCount: 24 });
  expect(data).toEqual(before); merge(data);
  expect(data.knowledge.b).toMatchObject({ title: '知识 b', description: '内容 b', understanding: '理解 b', contentVersion: 2, tags: ['b', 'a'] });
  expect(data.knowledge.a!.contentHistory).toEqual(before.knowledge.a!.contentHistory);
  expect(data.knowledge.a!.merge).toMatchObject({ targetId: 'b', retainedCardId: 'a' });
  expect(data.cards.a!.knowledgeId).toBe('a'); expect(currentKnowledgeId(data.cards.a!)).toBe('b'); expect(data.cards.a!.pausedAt).toBe(phaseFourNow);
  for (const id of ['a', 'b']) expect(data.cards[id]!.schedule).toEqual(before.cards[id]!.schedule);
  for (const key of ['quizzes', 'evidence', 'sessions', 'reviewEvents', 'reviewSessions'] as const) expect(data[key]).toEqual(before[key]);
  expect(() => service.pauseReviewCard(data, 'b', { version: 2, paused: false })).toThrow('不能恢复');
  expect(() => service.startReview(data, 'b')).toThrow('停用');
  expect(() => service.archiveKnowledge(data, 'a', { version: 2, archived: false })).toThrow('已合并');
  validateData(data, 'mock', 'local');
  const invalid = structuredClone(data); invalid.knowledge.a!.merge!.retainedCardId = 'c';
  expect(() => validateData(invalid, 'mock', 'local')).toThrow('outside merged knowledge family');
});
it('requires an existing card choice and the exact preview revision', () => {
  for (const retained of [null, 'c']) expect(() => merge(phaseFourData(), retained)).toThrow('必须明确');
  const data = phaseFourData(); expect(() => service.mergeKnowledge(data, 'a', { targetId: 'b', expectedRevision: 99, retainedCardId: 'a', confirm: true })).toThrow('变化');
  delete data.cards.a; delete data.cards.b; merge(data, null); expect(Object.keys(data.cards)).toEqual(['c']);
});
it('rejects active work and keeps merge chains acyclic and reviewable', () => {
  const data = phaseFourData(); data.sessions.q0!.status = 'QUIZZING'; expect(() => merge(data)).toThrow('结束关联');
  data.sessions.q0!.status = 'COMPLETED'; service.startReview(data, 'a'); expect(() => merge(data)).toThrow('正在进行');
  data.reviewSessions = {}; merge(data);
  expect(() => service.mergeKnowledge(data, 'b', { targetId: 'a', expectedRevision: 0, retainedCardId: 'a', confirm: true })).toThrow('尚未合并');
  service.mergeKnowledge(data, 'b', { targetId: 'c', expectedRevision: 0, retainedCardId: 'a', confirm: true });
  validateData(data, 'mock', 'local'); expect(currentKnowledgeId(data.cards.a!)).toBe('c');
  data.knowledge.c!.merge = { targetId: 'a', mergedAt: phaseFourNow, retainedCardId: 'a' }; data.knowledge.c!.archivedAt = phaseFourNow;
  expect(() => validateData(data, 'mock', 'local')).toThrow('cyclic');
});
it('orders only due cards by recent eligible evidence and preserves scheduling and old-client preferences', () => {
  const data = phaseFourData(); const before = structuredClone(data);
  expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)).cards[0]!.id).toBe('b');
  service.saveLearningPreferences(data, { schedulingEnabled: true, promptCacheRetention: 'none', reviewOrder: 'weakness', reviewBatchSize: 1, expectedRevision: 0, confirm: true });
  expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow))).toMatchObject({ totalDue: 3, cards: [{ id: 'a' }] });
  service.saveLearningPreferences(data, { schedulingEnabled: true, promptCacheRetention: 'none', expectedRevision: 0, confirm: true });
  expect(data.learningPreferences).toMatchObject({ reviewOrder: 'weakness', reviewBatchSize: 1 }); expect(data.cards).toEqual(before.cards);
  for (const item of Object.values(data.evidence).filter(item => item.knowledgeId === 'a')) item.answer.assisted = true;
  expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)).cards[0]!.id).toBe('b');
  data.cards.b!.pausedAt = phaseFourNow; data.cards.c!.schedule.due = '2027-01-01T00:00:00.000Z';
  expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)).cards.map(card => card.id)).toEqual(['a']);
  data.learningPreferences!.reviewOrder = 'due'; data.cards.b!.pausedAt = null;
  data.cards.a!.schedule.due = '2026-02-21T15:00:00.000Z'; data.cards.b!.schedule.due = '2026-02-22T00:00:00+10:00';
  expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)).cards[0]!.id).toBe('b');
});
it('excludes manual, disputed, skipped, pending, other-mode, unsubmitted and out-of-window evidence from prioritization', () => {
  for (const exclusion of ['manual', 'dispute', 'skipped', 'pending', 'mode', 'unsubmitted', 'old', 'future']) {
    const data = phaseFourData(); data.learningPreferences = { schedulingEnabled: true, promptCacheRetention: 'none', reviewOrder: 'weakness' };
    for (const item of Object.values(data.evidence).filter(item => item.knowledgeId === 'a')) {
      if (exclusion === 'manual') item.answer.assessment.source = 'manual';
      if (exclusion === 'dispute') item.answer.dispute = { reason: '待核对', createdAt: phaseFourNow, resolvedAt: null };
      if (exclusion === 'skipped') item.answer.skipped = true;
      if (exclusion === 'pending') item.answer.assessment.status = 'pending';
      if (exclusion === 'mode') item.simulated = false;
      if (exclusion === 'unsubmitted') data.quizzes[item.quizId]!.submittedAt = null;
      if (exclusion === 'old') item.answer.submittedAt = '2025-01-01T00:00:00.000Z';
      if (exclusion === 'future') item.answer.submittedAt = '2027-01-01T00:00:00.000Z';
    }
    const before = structuredClone(data);
    expect(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)).cards[0]!.id, exclusion).toBe('b');
    expect(data).toEqual(before);
  }
});
it('compacts only completed history and never exposes future questions in active quiz detail', () => {
  const data = phaseFourData(); const full = projectState(data, phaseFourConfig, ''); const compact = projectState(data, phaseFourConfig, '', true);
  expect(compact.quizzes[0]).toMatchObject({ questions: [], detailsOmitted: true, questionCount: 1 });
  expect(compact.evidence[0]).not.toHaveProperty('answer'); expect(full.evidence[0]).toHaveProperty('answer');
  const quiz = data.quizzes.q0!; quiz.submittedAt = null; quiz.answers = {}; quiz.questions.push({ ...quiz.questions[0]!, id: 'future', prompt: 'FUTURE_SENTINEL' });
  const active = projectState(data, phaseFourConfig, '', true).quizzes[0]!;
  expect(active.detailsOmitted).toBeUndefined(); expect(JSON.stringify(active)).not.toContain('PRIVATE_REFERENCE'); expect(JSON.stringify(active)).not.toContain('FUTURE_SENTINEL');
});
