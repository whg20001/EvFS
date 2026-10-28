import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AiTask, LearningSkill } from '@sanxing/contracts';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import { emptyData, openRepository } from '@sanxing/database';
import { bindLearningSkills, configureSkill, deleteSkill, getSkill, saveSkill } from '../src/skills.ts';
import { executeCommand } from '../src/commands.ts';

const extract: Extract<AiTask, { kind: 'extract' }> = { kind: 'extract', recitation: { learned: '今天学习缓存', unclear: '', application: '', topic: '' }, sources: [] };
function skill(name = 'example-method'): LearningSkill {
  return { id: randomUUID(), version: 1, document: { name, description: '适用学习任务', instructions: '用一个反例解释边界条件。' }, enabled: true, tasks: ['extract', 'followup', 'quiz'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}
it('requires explicit choices, checks versions and scopes, freezes content and preserves a stable order', () => {
  const a = skill('a-method'), b = skill('b-method');
  const off = { ...skill('off'), enabled: false }, grade = { ...skill('grade'), tasks: ['grade'] as const };
  const state = { skills: [b, off, { ...grade, tasks: [...grade.tasks] }, a] };
  expect(bindLearningSkills(state, extract).skills).toEqual([]);
  expect(() => bindLearningSkills(state, extract, [{ id: off.id, version: 1 }])).toThrow('停用');
  expect(() => bindLearningSkills(state, extract, [{ id: grade.id, version: 1 }])).toThrow('不适用');
  expect(() => bindLearningSkills(state, extract, [{ id: b.id, version: 2 }])).toThrow('已被修改');
  const task = bindLearningSkills(state, extract, [b, a].map(({ id, version }) => ({ id, version })));
  expect(task.skills!.map(item => item.name)).toEqual(['a-method', 'b-method']);
  const expected = describeLearningPrompt(task);
  a.document.instructions = 'changed'; a.enabled = false;
  expect(bindLearningSkills({ skills: [a] }, task)).toEqual(task);
  expect(describeLearningPrompt(task)).toEqual(expected);
  expect(bindLearningSkills({ skills: [b] }, { ...extract, skills: [] }).skills).toEqual([]);
  const connection: AiTask = { kind: 'connection_test', selection: { providerId: 'openai', modelId: 'gpt-test', authMethod: 'api_key', allowUnboundedOutput: false } };
  expect(bindLearningSkills({ skills: [b] }, connection)).toEqual(connection);
});

it('domain Skill commands enforce CAS and rollback failed activation in the shared transaction', async () => {
  const repository = await openRepository(':memory:', 'mock');
  const now = () => new Date('2026-10-24T00:00:00.000Z');
  const document = skill().document;
  try {
    const added = await executeCommand(repository, now, 'add-skill', 'first-skill-key', { document }, data => saveSkill(data, { document }, now()));
    const replay = await executeCommand(repository, now, 'add-skill', 'first-skill-key', { document }, () => { throw new Error('A replay must not execute'); });
    expect(replay).toEqual(added);
    expect(getSkill(await repository.read(), added.id!)).toMatchObject({ version: 1, enabled: false, tasks: ['followup', 'quiz'] });
    await executeCommand(repository, now, 'enable-skill', 'enable-skill-key', {}, data => configureSkill(data, added.id!, { version: 1, enabled: true, tasks: ['extract'] }, now()));
    const before = await repository.read();
    await expect(executeCommand(repository, now, 'delete-skill', 'stale-delete-key', {}, data => deleteSkill(data, added.id!, { version: 1 }))).rejects.toMatchObject({ code: 'SKILL_CHANGED', status: 409 });
    await expect(executeCommand(repository, now, 'enable-skill', 'invalid-scope-key', {}, data => configureSkill(data, added.id!, { version: 2, enabled: true, tasks: [] }, now()))).rejects.toThrow();
    expect(await repository.read()).toEqual(before);
    const updated = await executeCommand(repository, now, 'update-skill', 'update-skill-key', {}, data => saveSkill(data, { document: { ...document, instructions: '新的指令' }, replace: { id: added.id!, version: 2 } }, now()));
    expect(getSkill(await repository.read(), added.id!)).toMatchObject({ enabled: false, version: 3, tasks: ['extract'] });
    await executeCommand(repository, now, 'delete-skill', 'valid-delete-key', {}, data => deleteSkill(data, added.id!, { version: updated.version }));
    expect(() => getSkill(emptyData('mock'), added.id!)).toThrow('Skill 已删除');
  } finally { await repository.close(); }
});

it('allows a library of available skills but enforces the instruction budget on each explicit task selection', async () => {
  const repository = await openRepository(':memory:', 'mock');
  const now = () => new Date('2026-10-24T00:00:00.000Z');
  try {
    const first = await executeCommand(repository, now, 'add', 'large-first-key', {}, data => saveSkill(data, { document: { ...skill('first').document, instructions: 'x'.repeat(16000) } }, now()));
    const second = await executeCommand(repository, now, 'add', 'large-second-key', {}, data => saveSkill(data, { document: { ...skill('second').document, instructions: 'y'.repeat(9000) } }, now()));
    await executeCommand(repository, now, 'enable', 'enable-first-key', {}, data => configureSkill(data, first.id!, { version: 1, enabled: true, tasks: ['quiz'] }, now()));
    const before = await repository.read();
    await executeCommand(repository, now, 'enable', 'enable-second-key', {}, data => configureSkill(data, second.id!, { version: 1, enabled: true, tasks: ['quiz'] }, now()));
    const state = await repository.read();
    const quiz = { kind: 'quiz' as const, points: [], sources: [], count: 1 };
    expect(bindLearningSkills(state, quiz)).toMatchObject({ skills: [] });
    expect(() => bindLearningSkills(state, quiz, [first, second].map(item => ({ id: item.id!, version: 2 })))).toThrow('24000');
    expect(await repository.read()).toEqual(state);
  } finally { await repository.close(); }
});
