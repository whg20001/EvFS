import type { AppData, Answer, Question } from '@sanxing/contracts';
import { describe, expect, it } from 'vitest';
import { emptyData } from './index.js';
import { validateData } from './validation.js';

const now = '2026-01-01T00:00:00.000Z';
function fixture(): AppData {
  const data = emptyData('mock');
  data.knowledge.k1 = { id: 'k1', title: 'Current', description: 'Current description', sourceIds: [], version: 5, understanding: '', createdAt: now, updatedAt: now,
    contentVersion: 2, contentHistory: [{ version: 1, title: 'Old', description: 'Old description', sourceIds: [], createdAt: now }] };
  const question: Question = { id: 'q1', knowledgeId: 'k1', knowledgeVersion: 1, kind: 'short', prompt: 'Why?', options: [], correctIndex: null, referenceAnswer: 'Because', rubric: [{ id: 'r1', description: 'Reason', maxScore: 1 }], sourceIds: [] };
  const answer: Answer = { text: 'Because', selectedIndex: null, assisted: false, skipped: false, submittedAt: now,
    assessment: { status: 'graded', score: 1, maxScore: 1, feedback: 'Yes', assessedAt: now, version: 1 } };
  data.quizzes.quiz1 = { id: 'quiz1', sessionId: 's1', reviewSessionId: null, scopeVersion: 1, version: 1, questions: [question], answers: { q1: answer }, drafts: {}, submittedAt: now, createdAt: now };
  data.evidence.e1 = { id: 'e1', knowledgeId: 'k1', knowledgeVersion: 1, quizId: 'quiz1', questionId: 'q1', answer, dimension: 'immediate', simulated: true };
  data.sessions.s1 = { id: 's1', recitationId: 'r1', snapshot: { learned: '', unclear: '', application: '', topic: '' }, documentIds: [], scopeVersion: 1, version: 1, status: 'COMPLETED',
    candidates: [{ id: 'c1', title: 'Current', description: 'Current description', sourceIds: [], decision: 'accepted', existingKnowledgeId: null, knowledgeId: 'k1', knowledgeVersion: 2 }], turns: [], quizId: 'quiz1', activeRunId: null, completionReason: 'assessed', createdAt: now, completedAt: now };
  data.runs.run1 = { id: 'run1', status: 'succeeded', task: { kind: 'quiz', points: [{ id: 'k1', title: 'Old', description: 'Old description', sourceIds: [], knowledgeVersion: 1 }], sources: [], count: 1, recall: 'User recalled this' },
    sessionId: 's1', reviewSessionId: null, quizId: 'quiz1', questionId: null, attempt: 1, attemptId: 'attempt1', expectedVersion: 1, createdAt: now, startedAt: now, finishedAt: now, error: null, usage: null, reservationUsd: 0, promptVersion: 'v1' };
  return data;
}
const check = (data: unknown) => validateData(data, 'mock', 'local');
function historyFixture(): AppData {
  const data = emptyData('mock');
  data.knowledge.k1 = { ...fixture().knowledge.k1!, sourceIds: ['s1', 's2'], contentVersion: 7, contentHistory: [
    { version: 3, title: 'Old', description: 'Old description', sourceIds: [], createdAt: now },
    { version: 7, title: 'Current', description: 'Current description', sourceIds: ['s1', 's2'], createdAt: now },
  ] };
  return data;
}

describe('compatible content version validation', () => {
  it('roundtrips explicit preferences and frozen related knowledge while accepting legacy absence', () => {
    const data = fixture();
    data.learningPreferences = { schedulingEnabled: true, promptCacheRetention: 'short' };
    data.sessions.s1!.relatedKnowledge = [{ id: 'k1', title: 'Old', description: 'Old description', sourceIds: [], knowledgeVersion: 1 }];
    const restored = JSON.parse(JSON.stringify(data)); const before = structuredClone(restored);
    check(restored); expect(restored).toEqual(before);
    delete data.learningPreferences; delete data.sessions.s1!.relatedKnowledge;
    check(data);
  });

  it('rejects malformed preferences and fabricated or duplicate related knowledge snapshots', () => {
    for (const mutate of [
      (data: AppData) => Object.assign(data, { learningPreferences: { schedulingEnabled: 'yes', promptCacheRetention: 'short' } }),
      (data: AppData) => Object.assign(data, { learningPreferences: { schedulingEnabled: true, promptCacheRetention: 'long' } }),
      (data: AppData) => { data.sessions.s1!.relatedKnowledge![0]!.description = 'fabricated'; },
      (data: AppData) => { data.sessions.s1!.relatedKnowledge![0]!.knowledgeVersion = 999; },
      (data: AppData) => { data.sessions.s1!.relatedKnowledge![0]!.knowledgeVersion = null; },
      (data: AppData) => { data.sessions.s1!.relatedKnowledge![0]!.sourceIds = ['not-in-version']; },
      (data: AppData) => { data.sessions.s1!.relatedKnowledge!.push({ ...data.sessions.s1!.relatedKnowledge![0]! }); },
    ]) {
      const data = fixture();
      data.sessions.s1!.relatedKnowledge = [{ id: 'k1', title: 'Old', description: 'Old description', sourceIds: [], knowledgeVersion: 1 }];
      mutate(data); const before = structuredClone(data);
      expect(() => check(data)).toThrow('Invalid aggregate'); expect(data).toEqual(before);
    }
  });

  it('accepts historical/current references and quiz recall without rewriting the snapshot', () => {
    const data = fixture(); const before = structuredClone(data);
    check(data); expect(data).toEqual(before);
    expect(data.evidence.e1!.knowledgeVersion).toBe(1);
  });

  it('keeps missing/null legacy versions unknown, even when history is absent', () => {
    const data = fixture();
    delete data.knowledge.k1!.contentVersion; delete data.knowledge.k1!.contentHistory;
    delete data.evidence.e1!.knowledgeVersion;
    data.quizzes.quiz1!.questions[0]!.knowledgeVersion = null;
    delete data.sessions.s1!.candidates[0]!.knowledgeVersion;
    const task = data.runs.run1!.task;
    if (task.kind !== 'quiz') throw new Error('fixture');
    delete task.points[0]!.knowledgeVersion; delete task.recall;
    const before = structuredClone(data); check(data); expect(data).toEqual(before);
    expect(data.evidence.e1).not.toHaveProperty('knowledgeVersion');
  });

  it('rejects duplicate history numbers and nonexistent explicit version references', () => {
    for (const mutate of [
      (data: AppData) => data.knowledge.k1!.contentHistory!.push(data.knowledge.k1!.contentHistory![0]!),
      (data: AppData) => { data.evidence.e1!.knowledgeVersion = 3; },
      (data: AppData) => { data.quizzes.quiz1!.questions[0]!.knowledgeVersion = 3; },
      (data: AppData) => { data.sessions.s1!.candidates[0]!.knowledgeVersion = 3; },
      (data: AppData) => { const task = data.runs.run1!.task; if (task.kind === 'quiz') task.points[0]!.knowledgeVersion = 3; },
      (data: AppData) => { delete data.knowledge.k1; },
    ]) { const data = fixture(); mutate(data); expect(() => check(data)).toThrow('Invalid aggregate'); }
  });

  it('accepts increasing non-contiguous history starting above one and a matching current snapshot', () => {
    const data = historyFixture(); const before = structuredClone(data);
    check(data); expect(data).toEqual(before);
    // Current history is optional, and timestamps are not part of content identity.
    data.knowledge.k1!.contentHistory![1]!.createdAt = '2026-02-01T00:00:00.000Z';
    check(data);
    data.knowledge.k1!.contentHistory!.pop(); check(data);
  });

  it.each([
    { name: 'legacy without either field', current: false, history: false },
    { name: 'legacy with empty history', current: false, history: true },
    { name: 'current version without history', current: true, history: false },
    { name: 'current version with empty history', current: true, history: true },
  ])('accepts $name without inventing a baseline', ({ current, history }) => {
    const data = historyFixture();
    if (!current) delete data.knowledge.k1!.contentVersion;
    if (history) data.knowledge.k1!.contentHistory = [];
    else delete data.knowledge.k1!.contentHistory;
    const before = structuredClone(data); check(data); expect(data).toEqual(before);
  });

  it.each<{ name: string; mutate: (data: AppData) => void; error: string }>([
    { name: 'descending history', mutate: data => { data.knowledge.k1!.contentHistory!.reverse(); }, error: 'strictly increasing' },
    { name: 'duplicate history', mutate: data => { data.knowledge.k1!.contentHistory!.push({ ...data.knowledge.k1!.contentHistory![1]! }); }, error: 'strictly increasing' },
    { name: 'future history', mutate: data => { data.knowledge.k1!.contentVersion = 1; }, error: 'future knowledge' },
    { name: 'nonempty history without current version', mutate: data => { delete data.knowledge.k1!.contentVersion; }, error: 'requires contentVersion' },
    { name: 'different current title', mutate: data => { data.knowledge.k1!.contentHistory![1]!.title = 'Other'; }, error: 'does not match content' },
    { name: 'different current description', mutate: data => { data.knowledge.k1!.contentHistory![1]!.description = 'Other'; }, error: 'does not match content' },
    { name: 'different current source', mutate: data => { data.knowledge.k1!.contentHistory![1]!.sourceIds[0] = 'other'; }, error: 'does not match content' },
    { name: 'extra current source', mutate: data => { data.knowledge.k1!.contentHistory![1]!.sourceIds.push('other'); }, error: 'does not match content' },
    { name: 'missing current source', mutate: data => { data.knowledge.k1!.contentHistory![1]!.sourceIds.pop(); }, error: 'does not match content' },
    { name: 'reordered current sources', mutate: data => { data.knowledge.k1!.contentHistory![1]!.sourceIds.reverse(); }, error: 'does not match content' },
  ])('rejects $name without repairing or reordering input', ({ mutate, error }) => {
    const data = historyFixture(); mutate(data); const before = structuredClone(data);
    expect(() => check(data)).toThrow(error); expect(data).toEqual(before);
  });

  it('checks every new optional field rather than accepting unchecked extra JSON', () => {
    for (const mutate of [
      (data: AppData) => Object.assign(data.knowledge.k1!, { contentVersion: 0 }),
      (data: AppData) => Object.assign(data.knowledge.k1!, { contentHistory: 'bad' }),
      (data: AppData) => Object.assign(data.knowledge.k1!.contentHistory![0]!, { version: 1.5 }),
      (data: AppData) => Object.assign(data.knowledge.k1!.contentHistory![0]!, { sourceIds: [42] }),
      (data: AppData) => Object.assign(data.knowledge.k1!.contentHistory![0]!, { createdAt: 'bad' }),
      (data: AppData) => Object.assign(data.evidence.e1!, { knowledgeVersion: '1' }),
      (data: AppData) => Object.assign(data.quizzes.quiz1!.questions[0]!, { knowledgeVersion: -1 }),
      (data: AppData) => Object.assign(data.sessions.s1!.candidates[0]!, { knowledgeVersion: 0 }),
      (data: AppData) => { const task = data.runs.run1!.task; if (task.kind === 'quiz') Object.assign(task.points[0]!, { knowledgeVersion: '1' }); },
      (data: AppData) => Object.assign(data.runs.run1!.task, { recall: 42 }),
    ]) { const data = fixture(); mutate(data); expect(() => check(data)).toThrow('Invalid aggregate'); }
  });
});
