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

describe('quiz context validation', () => {
  const turn = { id: 't1', question: 'Why?', answer: 'Practice', feedback: 'Feedback', assisted: false, scopeVersion: 1 };
  const cue = { question: 'Old question', weakAreas: ['Missed TTL'], score: 1, maxScore: 2, dimension: 'delayed' as const };
  it('roundtrips new fields and keeps legacy absence and archived text unchanged', () => {
    for (const context of [{}, { turns: [], weaknesses: [] }, { turns: [turn, { ...turn, id: 't2', answer: null, feedback: null }], weaknesses: [cue] }, { weaknesses: [{ ...cue, weakAreas: ['x'.repeat(801)] }] }]) {
      const data = fixture(); Object.assign(data.runs.run1!.task, context);
      const restored = JSON.parse(JSON.stringify(data)); const before = structuredClone(restored);
      expect(() => check(restored)).not.toThrow(); expect(restored).toEqual(before);
    }
  });
  it.each([
    { turns: 'not-an-array' }, { turns: null }, { turns: [null] }, { turns: [{ ...turn, answer: 42 }] },
    { turns: [{ ...turn, feedback: [] }] }, { turns: [{ ...turn, assisted: 'false' }] },
    { turns: [{ ...turn, scopeVersion: 0 }] }, { turns: Array(6).fill(turn) },
    { weaknesses: 'not-an-array' }, { weaknesses: null }, { weaknesses: [null] },
    { weaknesses: [{ ...cue, question: 42 }] }, { weaknesses: [{ ...cue, weakAreas: 'bad' }] },
    { weaknesses: [{ ...cue, weakAreas: [] }] }, { weaknesses: [{ ...cue, weakAreas: [42] }] },
    { weaknesses: [{ ...cue, weakAreas: ['a', 'b', 'c', 'd'] }] },
    { weaknesses: [{ ...cue, score: -1 }] }, { weaknesses: [{ ...cue, score: 3 }] },
    { weaknesses: [{ ...cue, maxScore: 0 }] }, { weaknesses: [{ ...cue, dimension: 'unknown' }] },
    { weaknesses: Array(4).fill(cue) },
  ])('rejects malformed context %j without mutating it', context => {
    const data = fixture(); Object.assign(data.runs.run1!.task, context); const before = structuredClone(data);
    expect(() => check(data)).toThrow('Invalid aggregate'); expect(data).toEqual(before);
  });
});

it('keeps legacy runs readable and rejects unsafe diagnostic codes or invalid prompt hashes', () => {
  expect(() => check(fixture())).not.toThrow();
  const valid = fixture(); Object.assign(valid.runs.run1!, { promptHash: 'a'.repeat(64), errorCode: 'MODEL_HTTP_429' });
  expect(() => check(valid)).not.toThrow();
  for (const fields of [{ errorCode: 'MODEL_HTTP_429_private' }, { errorCode: 'private-provider-error' }, { promptHash: 'private-prompt' }]) {
    const invalid = fixture(); Object.assign(invalid.runs.run1!, fields);
    expect(() => check(invalid)).toThrow();
  }
});
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

it('roundtrips content-free progress and new timeout codes while retaining legacy absence', () => {
  check(fixture());
  for (const errorCode of ['FIRST_RESPONSE_TIMEOUT', 'STREAM_IDLE_TIMEOUT']) {
    const data = fixture();
    Object.assign(data.runs.run1!, { errorCode, progress: { phase: 'generating', queuedMs: 5, elapsedMs: 100, totalTimeoutMs: 120000,
      requestStartedMs: 1, firstResponseMs: 2, firstTextMs: 4, lastContentMs: 80, completedMs: 100 } });
    const restored = JSON.parse(JSON.stringify(data)); const before = structuredClone(restored);
    check(restored); expect(restored).toEqual(before);
  }
  for (const invalid of [{ phase: 'unknown' }, { elapsedMs: -1 }, { completedMs: 101 }, { firstResponseMs: Infinity },
    { firstTextMs: 1.5 }, { rawText: 'PRIVATE_CONTENT' }, { totalTimeoutMs: 0 }, { queuedMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    const data = fixture();
    Object.assign(data.runs.run1!, { progress: { phase: 'waiting', queuedMs: 0, elapsedMs: 100, totalTimeoutMs: 1000, ...invalid } });
    expect(() => check(data)).toThrow('Invalid aggregate');
  }
});

it('roundtrips safe transport diagnostics and refuses raw network data or malformed counters', () => {
  const transport = { policy: 'pooled', phase: 'awaiting_headers', requestCount: 1, reusedSocket: true,
    bytesWritten: 200, bytesRead: 0, errorCode: 'ECONNRESET', syscall: 'read' };
  const data = fixture(); Object.assign(data.runs.run1!, { transport });
  const copy = JSON.parse(JSON.stringify(data)); check(copy); expect(copy).toEqual(data);
  for (const patch of [{ errorCode: 'PRIVATE' }, { syscall: 'PRIVATE' }, { address: '127.0.0.1' }, { message: 'PRIVATE' },
    { url: 'PRIVATE' }, { headers: {} }, { bytesRead: -1 }, { bytesWritten: Infinity }, { requestCount: 1.5 },
    { reusedSocket: 'unknown' }, { policy: 'auto' }, { httpStatus: 600 }]) {
    const invalid = fixture(); Object.assign(invalid.runs.run1!, { transport: { ...transport, ...patch } });
    expect(() => check(invalid)).toThrow('Invalid aggregate');
  }
});
