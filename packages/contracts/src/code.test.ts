import { describe, expect, it } from 'vitest';
import { LIMITS, answerInputSchema, codeExerciseSchema, codeExecutionSchema, generatedQuestionSchema } from './index.ts';
const code = { language: 'javascript', starter: '// 目标与输入输出\nfunction f() { /* TODO */ }', tests: [{ name: '样例', code: 'assertEqual(f(), 2);' }] };
const question = { kind: 'code', knowledgeId: 'p', prompt: '实现函数', options: [], correctIndex: null, referenceAnswer: 'function f() { return 2; }', rubric: [{ id: 'r', description: '正确性', maxScore: 2 }], sourceIds: ['s'], code };
const execution = { status: 'passed', passed: 1, total: 1, output: '2', durationMs: 10, ranAt: '2026-10-10T00:00:00.000Z' };
describe('代码题契约', () => {
  it('保留代码、测试与浏览器证据，旧答案请求仍可解析', () => {
    expect(generatedQuestionSchema.parse(question).code).toEqual(code);
    expect(answerInputSchema.parse({ version: 1, action: 'answer', text: '代码', codeProtocol: 1, execution }).execution).toEqual(execution);
    expect(answerInputSchema.parse({ version: 1, action: 'answer' }).execution).toBeUndefined();
  });
  it.each([{ code: undefined }, { kind: 'short' }, { options: ['x'] }, { correctIndex: 0 }])('拒绝题型与代码或选项不一致：%j', patch => {
    expect(generatedQuestionSchema.safeParse({ ...question, ...patch }).success).toBe(false);
  });
  it.each([{ language: 'ruby' }, { starter: 'x'.repeat(LIMITS.codeStarterChars + 1) }, { tests: [] }, { tests: Array(7).fill(code.tests[0]) }, { tests: [{ name: '超长', code: 'x'.repeat(LIMITS.codeTestChars + 1) }] }])('约束语言与测试大小：%j', patch => {
    expect(codeExerciseSchema.safeParse({ ...code, ...patch }).success).toBe(false);
  });
  it.each([{ passed: 2 }, { passed: 0 }, { status: 'failed' }, { durationMs: Infinity }, { output: 'x'.repeat(LIMITS.codeOutputChars + 1) }, { ranAt: 'bad-date' }])('拒绝无效运行结果：%j', patch => {
    expect(codeExecutionSchema.safeParse({ ...execution, ...patch }).success).toBe(false);
  });
});
