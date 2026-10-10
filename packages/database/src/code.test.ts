import { describe, expect, it } from 'vitest';
import type { AppData, GeneratedQuestion } from '@sanxing/contracts';
import { emptyData, openRepository } from './index.ts';
import { validateData } from './validation.ts';
const now = '2026-10-10T00:00:00.000Z';
const question: GeneratedQuestion & { id: string } = { id: 'q', kind: 'code', knowledgeId: 'p', prompt: '函数', options: [], correctIndex: null, referenceAnswer: 'const value = 2;', rubric: [{ id: 'r', description: '正确', maxScore: 2 }], sourceIds: ['s'], code: { language: 'javascript', starter: 'const value = 0;', tests: [{ name: '值', code: 'assertEqual(value, 2);' }] } };
const execution = { status: 'passed' as const, total: 1, passed: 1, output: 'ok', durationMs: 3, ranAt: now };
function fixture(): AppData {
  const data = emptyData('mock');
  data.learningPreferences = { schedulingEnabled: false, promptCacheRetention: 'none', codeExercisesEnabled: true, codeLanguages: ['javascript'] };
  data.quizzes.quiz = { id: 'quiz', sessionId: null, reviewSessionId: null, scopeVersion: 1, version: 2, questions: [question], drafts: {}, createdAt: now, submittedAt: null, answers: { q: { text: 'const value = 2;', selectedIndex: null, assisted: false, skipped: false, submittedAt: now, execution, assessment: { status: 'pending', score: null, maxScore: 2, feedback: '', assessedAt: null, version: 1 } } } };
  data.runs.run = { id: 'run', task: { kind: 'grade', question, answer: 'const value = 2;', execution }, status: 'pending', sessionId: null, reviewSessionId: null, quizId: 'quiz', questionId: 'q', expectedVersion: 2, createdAt: now, startedAt: null, finishedAt: null, attempt: 0, attemptId: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'learning-v6' };
  return structuredClone(data);
}
describe('代码题持久化校验', () => {
  it('PGlite 往返保留题目、偏好、答案及 grade 证据', async () => {
    const repository = await openRepository(':memory:', 'mock');
    try {
      const data = fixture(); data.ownerId = (await repository.read()).ownerId;
      await repository.replace(data);
      const stored = await repository.read();
      expect(stored.runs.run!.task).toEqual(data.runs.run!.task); expect(stored.quizzes).toEqual(data.quizzes); expect(stored.learningPreferences).toEqual(data.learningPreferences);
    } finally { await repository.close(); }
  });
  it.each(['answer', 'task', 'language', 'test', 'count'] as const)('拒绝损坏字段 %s', field => {
    const data = fixture();
    if (field === 'answer') data.quizzes.quiz!.answers.q!.execution!.passed = 4;
    if (field === 'task' && data.runs.run!.task.kind === 'grade') data.runs.run!.task.execution!.durationMs = -1;
    if (field === 'language') Reflect.set(data.learningPreferences!, 'codeLanguages', ['ruby']);
    if (field === 'test') data.quizzes.quiz!.questions[0]!.code!.tests = [];
    if (field === 'count') { data.quizzes.quiz!.answers.q!.execution!.passed = 2; data.quizzes.quiz!.answers.q!.execution!.total = 2; }
    expect(() => validateData(data, 'mock', data.ownerId)).toThrow();
  });
  it('兼容没有新字段的旧数据与旧偏好', () => {
    const data = emptyData('mock'); data.learningPreferences = { schedulingEnabled: true, promptCacheRetention: 'none' };
    expect(() => validateData(data, 'mock', data.ownerId)).not.toThrow();
  });
});
