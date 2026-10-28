import { emptyData } from '@sanxing/database';
import { newSchedule } from '@sanxing/learning-domain';
import type { AppData, Answer, Question } from '@sanxing/contracts';

/** Synthetic capacity workload only. Never reads a user's database or environment. */
export function storageFixture(): AppData {
  const data = emptyData('mock');
  const stamp = '2026-01-01T00:00:00.000Z';
  const prose = '缓存通过复用计算结果减少重复工作；过期时间和容量需要同时考虑。';
  for (let i = 0; i < 365; i++) {
    const id = `recitation-${i}`;
    const snapshot = { learned: prose.repeat(20), unclear: prose, application: prose, topic: `合成学习 ${i}` };
    data.recitations[id] = { ...snapshot, id, learningDate: new Date(Date.parse(stamp) + i * 86400000).toISOString().slice(0, 10), version: 1, documentIds: [], createdAt: stamp, updatedAt: stamp };
    data.sessions[`session-${i}`] = { id: `session-${i}`, recitationId: id, snapshot, documentIds: [], scopeVersion: 1, version: 1, status: 'COMPLETED', candidates: [], turns: [], quizId: `quiz-${i}`, activeRunId: null, completionReason: 'assessed', createdAt: stamp, completedAt: stamp };
  }
  for (let i = 0; i < 500; i++) {
    const id = `document-${i}`; const text = `${prose.repeat(200)}\n合成文档 ${i}`; const recitationId = `recitation-${i % 365}`;
    data.documents[id] = { id, recitationId, name: `${id}.md`, text, originalBase64: Buffer.from(text).toString('base64'), hash: `synthetic-${i}`, lineCount: 2, createdAt: stamp };
    data.recitations[recitationId]!.documentIds.push(id);
  }
  for (let i = 0; i < 1000; i++) {
    const id = `knowledge-${i}`;
    data.knowledge[id] = { id, title: `缓存 ${i}`, description: prose.repeat(10), sourceIds: [`document-${i % 500}`], understanding: prose.repeat(5), version: 1, createdAt: stamp, updatedAt: stamp };
    data.cards[`card-${i}`] = { id: `card-${i}`, knowledgeId: id, version: 1, schedule: newSchedule(new Date(stamp)), createdAt: stamp };
  }
  for (let i = 0; i < 1095; i++) {
    const id = `quiz-${i}`; const knowledgeId = `knowledge-${i % 1000}`; const reviewId = i < 365 ? null : `review-${i}`;
    const questions: Question[] = Array.from({ length: 3 }, (_, j) => ({ id: `${id}-q${j}`, knowledgeId, kind: 'short', prompt: prose, options: [], correctIndex: null, referenceAnswer: prose.repeat(10), rubric: [{ id: 'r1', description: '说明缓存失效条件', maxScore: 2 }], sourceIds: [`document-${i % 500}`] }));
    const answers: Record<string, Answer> = Object.fromEntries(questions.map(q => [q.id, { text: prose.repeat(10), selectedIndex: null, assisted: false, skipped: false, submittedAt: stamp, assessment: { status: 'graded', score: 1, maxScore: 2, feedback: prose.repeat(5), assessedAt: stamp, version: 1 } }]));
    data.quizzes[id] = { id, sessionId: i < 365 ? `session-${i}` : null, reviewSessionId: reviewId, scopeVersion: 1, version: 1, questions, answers, drafts: {}, submittedAt: stamp, createdAt: stamp };
    if (reviewId) {
      data.reviewSessions[reviewId] = { id: reviewId, cardId: `card-${i % 1000}`, expectedCardVersion: 1, version: 1, status: 'COMPLETED', recall: prose.repeat(10), recallSubmittedAt: stamp, quizId: id, activeRunId: null, createdAt: stamp, completedAt: stamp };
      data.reviewEvents[`event-${i}`] = { id: `event-${i}`, reviewSessionId: reviewId, cardId: `card-${i % 1000}`, rating: 1, reviewedAt: stamp, before: newSchedule(new Date(stamp)), after: newSchedule(new Date(stamp)), algorithm: 'synthetic', simulated: true };
    }
    for (const q of questions) {
      data.evidence[q.id] = { id: q.id, knowledgeId, quizId: id, questionId: q.id, answer: structuredClone(answers[q.id]!), dimension: reviewId ? 'delayed' : 'immediate', simulated: true };
      const runId = `run-${q.id}`;
      data.runs[runId] = { id: runId, status: 'succeeded', task: { kind: 'grade', question: q, answer: answers[q.id]!.text }, sessionId: null, reviewSessionId: null, quizId: id, questionId: q.id, attempt: 1, attemptId: null, expectedVersion: 1, createdAt: stamp, startedAt: stamp, finishedAt: stamp, error: null, usage: null, reservationUsd: 0, promptVersion: 'synthetic' };
      data.receipts[`synthetic-${q.id}`] = { hash: 'synthetic', result: { runId }, createdAt: stamp };
    }
  }
  return JSON.parse(JSON.stringify(data)) as AppData;
}
