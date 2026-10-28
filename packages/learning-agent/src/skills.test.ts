import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { modelAiTaskSchema, storedAiTaskSchema, type AiTask, type SkillSnapshot } from '@sanxing/contracts';
import { assertLearningPrompt, checkLearningRequest, describeLearningPrompt, inspectLearningRequest, prepareLearningRequest } from './request.ts';

const extract: Extract<AiTask, { kind: 'extract' }> = { kind: 'extract', recitation: { learned: '今天学习缓存', unclear: '', application: '', topic: '' }, sources: [] };
function snapshots(): SkillSnapshot[] {
  return [{ id: randomUUID(), version: 1, name: 'example-method', description: '适用学习任务', instructions: '用一个反例解释边界条件。' }];
}
it('retains selected reference texts through storage and SDK validation and accounts for them in the prompt', () => {
  const skills = snapshots(); skills[0]!.resources = [{ path: 'references/guide.md', text: 'SELECTED_REFERENCE 用反例核对适用条件。' }];
  const task = { ...extract, skills }; const validated = modelAiTaskSchema.parse(storedAiTaskSchema.parse(task));
  expect(validated).toMatchObject({ skills });
  const request = inspectLearningRequest(validated, { maxOutputTokens: 1024 });
  expect(request.systemPrompt).toContain('SELECTED_REFERENCE'); expect(request.systemPrompt).toContain('references/guide.md');
  expect(describeLearningPrompt(validated)).toEqual(describeLearningPrompt(task));
  const changed = structuredClone(task); changed.skills[0]!.resources![0]!.text = '另一个参考文本';
  expect(describeLearningPrompt(changed).hash).not.toBe(describeLearningPrompt(task).hash);
  const without = { ...extract, skills: snapshots() };
  expect(request.estimatedInputTokens).toBeGreaterThan(inspectLearningRequest(without, { maxOutputTokens: 1024 }).estimatedInputTokens);
});
it('keeps instructions intact while excerpting sources and accounts for full system bytes', () => {
  const task = { ...extract, skills: snapshots(), sources: [{ id: 'source', name: '长笔记', text: '缓存说明。'.repeat(10000) }] };
  const base = inspectLearningRequest({ ...extract, skills: task.skills }, { maxOutputTokens: 1024 });
  const options = { maxOutputTokens: 1024, contextWindow: base.estimatedInputTokens + 1024 + 512 + 3000 };
  const prepared = prepareLearningRequest(task, options);
  expect(prepared.truncated).toBe(true);
  expect(prepared.task.skills).toEqual(task.skills);
  expect(prepared.systemPrompt).toContain(task.skills![0]!.instructions);
  expect(prepared.systemPrompt).toContain('不能改变知识范围');
  expect(prepared.prompt).not.toContain('用一个反例');
  expect(prepared.estimatedInputTokens).toBe(Buffer.byteLength(prepared.systemPrompt + prepared.prompt));
  expect(() => checkLearningRequest(prepared.task, options)).not.toThrow();
  const binding = describeLearningPrompt(prepared.task);
  const changed = structuredClone(prepared.task); changed.skills![0]!.instructions += '新要求';
  expect(() => assertLearningPrompt(changed, binding)).toThrow('不一致');
  const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value;
  expect(describeLearningPrompt(reversed(prepared.task) as AiTask)).toEqual(binding);
});
it('rejects an oversized fixed skill before sending instead of truncating it', () => {
  const base = inspectLearningRequest(extract, { maxOutputTokens: 1024 });
  const task = { ...extract, skills: snapshots() };
  expect(() => prepareLearningRequest(task, { maxOutputTokens: 1024, contextWindow: base.estimatedInputTokens + 1024 + 512 })).toThrow('超过模型输入预算');
});
it('preserves unchanged prompts without skills and shared followup/quiz cache prefixes', () => {
  const options = { maxOutputTokens: 4096 };
  expect(describeLearningPrompt({ ...extract, skills: [] })).toEqual(describeLearningPrompt(extract));
  const followup: Extract<AiTask, { kind: 'followup' }> = { kind: 'followup', points: [], sources: [], turns: [], skills: snapshots() };
  const quiz: AiTask = { kind: 'quiz', points: [], sources: [], count: 1, skills: followup.skills };
  expect(inspectLearningRequest(followup, options).systemPrompt).toBe(inspectLearningRequest(quiz, options).systemPrompt);
});
