import { expect, it } from 'vitest';
import { createLearningEngine, prepareLearningRequest } from '../src/index.ts';
import { evaluationCases } from './cases.ts';

it('freezes 30 distinct synthetic cases and reference score ranges across all four task kinds', async () => {
  expect(evaluationCases).toHaveLength(30);
  expect(new Set(evaluationCases.map(item => item.id)).size).toBe(30);
  expect(new Set(evaluationCases.map(item => item.task.kind))).toEqual(new Set(['extract', 'followup', 'quiz', 'grade']));
  const engine = createLearningEngine({ mode: 'mock' });
  for (const item of evaluationCases) {
    expect(item.reference.length).toBeGreaterThan(10); expect(item.checks.length).toBeGreaterThan(1);
    const prepared = prepareLearningRequest(item.task, { maxOutputTokens: 4096 });
    expect(prepared.truncated).toBe(false);
    const response = await engine.execute(prepared.task, { signal: AbortSignal.timeout(5000) });
    expect(response.output.kind).toBe(item.task.kind);
    if (item.task.kind === 'grade') { expect(item.expectedScore).toBeDefined(); expect(item.expectedScore!.max).toBeLessThanOrEqual(item.task.question.rubric.reduce((sum, row) => sum + row.maxScore, 0)); }
  }
});
