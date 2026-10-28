import { emptyData } from '@sanxing/database';
import { newSchedule, type DomainConfig } from '@sanxing/learning-domain';
export const phaseFourNow = '2026-03-01T12:00:00.000Z';
export const phaseFourConfig: DomainConfig = { mode: 'mock', timezone: 'UTC', maxUploadBytes: 131072, maxDocuments: 5, maxFollowups: 2, quizCount: 3, schedulingEnabled: true, maxCallsPerSession: 20, dailyBudgetUsd: null, requestReservationUsd: 0, runTimeoutMs: 1000 };
export function phaseFourData() {
  const data = emptyData('mock'); const stamp = phaseFourNow;
  for (const id of ['a', 'b', 'c']) {
    data.knowledge[id] = { id, title: `知识 ${id}`, description: `内容 ${id}`, sourceIds: [`source-${id}`], version: 1, contentVersion: 1, contentHistory: [{ version: 1, title: `知识 ${id}`, description: `内容 ${id}`, sourceIds: [`source-${id}`], createdAt: stamp }], understanding: `理解 ${id}`, createdAt: stamp, updatedAt: stamp, tags: [id] };
    data.cards[id] = { id, knowledgeId: id, version: 1, schedule: { ...newSchedule(new Date(stamp)), due: `2026-02-${id === 'a' ? '21' : '20'}T00:00:00.000Z`, stability: id === 'a' ? 5 : 9 }, createdAt: stamp };
  }
  for (let i = 0; i < 24; i++) {
    const id = `q${i}`; const knowledgeId = i < 12 ? 'a' : 'b';
    const snapshot = { learned: '合成复述', unclear: '', application: '', topic: '' };
    data.recitations[id] = { id, ...snapshot, version: 1, learningDate: '2026-03-01', documentIds: [], createdAt: stamp, updatedAt: stamp };
    data.sessions[id] = { id, recitationId: id, snapshot, documentIds: [], scopeVersion: 1, version: 1, status: 'COMPLETED', candidates: [{ id, title: `知识 ${knowledgeId}`, description: `内容 ${knowledgeId}`, sourceIds: [], decision: 'accepted', knowledgeId, existingKnowledgeId: null, knowledgeVersion: 1 }], turns: [], quizId: id, activeRunId: null, completionReason: 'assessed', createdAt: stamp, completedAt: stamp };
    const question = { id, knowledgeId, knowledgeVersion: 1, kind: 'short' as const, prompt: '解释这个知识', options: [], correctIndex: null, referenceAnswer: 'PRIVATE_REFERENCE', rubric: [{ id: 'r', description: '说明条件', maxScore: 2 }], sourceIds: [] };
    const answer = { text: `原答案 ${i}`, selectedIndex: null, assisted: false, skipped: false, submittedAt: stamp, assessment: { status: 'graded' as const, score: i < 12 ? 0 : 2, maxScore: 2, feedback: '原评价', assessedAt: stamp, version: 1 } };
    data.quizzes[id] = { id, sessionId: id, reviewSessionId: null, scopeVersion: 1, version: 1, questions: [question], answers: { [id]: answer }, drafts: {}, submittedAt: stamp, createdAt: stamp };
    data.evidence[id] = { id, knowledgeId, knowledgeVersion: 1, quizId: id, questionId: id, answer: structuredClone(answer), dimension: 'immediate', simulated: true };
  }
  return JSON.parse(JSON.stringify(data)) as typeof data;
}
