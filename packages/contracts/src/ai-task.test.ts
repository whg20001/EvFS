import { describe, expect, it } from 'vitest';
import { LIMITS, modelAiTaskSchema, storedAiTaskSchema, type AiTask } from './index.ts';
import { contractSkill, taskContractCases } from '../../../tests/fixtures/task-contract.ts';

function fixture<K extends AiTask['kind']>(kind: K): Extract<AiTask, { kind: K }> {
  return structuredClone(taskContractCases.find(item => item.task.kind === kind)!.task) as Extract<AiTask, { kind: K }>;
}
const both = [storedAiTaskSchema, modelAiTaskSchema];

describe('shared task contracts', () => {
  it.each(taskContractCases)('preserves the archived $id task and known SDK fields without defaults or mutation', ({ task }) => {
    const input = structuredClone(task);
    expect(storedAiTaskSchema.parse(input)).toEqual(task);
    const model = modelAiTaskSchema.parse(input);
    const expected = structuredClone(task);
    // Grading provenance belongs to the host, as before this schema consolidation.
    if (expected.kind === 'grade') delete expected.question.knowledgeVersion;
    expect(model).toEqual(expected);
    expect(input).toEqual(task);
  });

  it.each(['extract', 'followup', 'quiz', 'grade'] as const)('keeps absent, empty and populated Skill snapshots distinct for $kind', kind => {
    const base = fixture(kind); delete base.skills;
    for (const schema of both) {
      expect(Object.hasOwn(schema.parse(base), 'skills')).toBe(false);
      expect(schema.parse({ ...base, skills: [] })).toMatchObject({ skills: [] });
      expect(schema.parse({ ...base, skills: [contractSkill] })).toMatchObject({ skills: [contractSkill] });
      for (const skills of [null, {}, [null], [{ ...contractSkill, version: 0 }], [contractSkill, contractSkill]]) {
        expect(schema.safeParse({ ...base, skills }).success).toBe(false);
      }
    }
  });

  it('keeps probes strict and learning tasks compatible with existing unknown-field stripping', () => {
    for (const schema of both) {
      for (const extra of [{ skills: [] }, { skills: undefined }, { sources: [] }, { unexpected: true }]) {
        expect(schema.safeParse({ ...fixture('connection_test'), ...extra }).success).toBe(false);
      }
      const extract = fixture('extract');
      const extended = { ...extract, unknownField: 'legacy', sources: extract.sources.map(source => ({ ...source, extra: true })) };
      expect(schema.parse(extended)).toEqual(extract);
      expect(extended.unknownField).toBe('legacy');
    }
  });

  it('retains missing/null knowledge versions and requires concrete related-knowledge versions', () => {
    for (const schema of both) {
      const task = fixture('followup'); delete task.points[0]!.knowledgeVersion;
      const parsed = schema.parse(task);
      if (parsed.kind !== 'followup') throw new Error('Unexpected kind');
      expect(Object.hasOwn(parsed.points[0]!, 'knowledgeVersion')).toBe(false);
      task.points[0]!.knowledgeVersion = null;
      expect(schema.parse(task)).toMatchObject({ points: [{ knowledgeVersion: null }] });
      task.points[0]!.knowledgeVersion = 0;
      expect(schema.safeParse(task).success).toBe(false);
      task.points[0]!.knowledgeVersion = 1;
      expect(schema.safeParse({ ...task, related: [{ id: 'k2', title: '旧知识', description: '描述', knowledgeVersion: null }] }).success).toBe(false);
    }
  });

  it.each([
    ['source text', () => { const task = fixture('extract'); task.sources[0]!.text = 'x'.repeat(LIMITS.modelInputChars + 1); return task; }],
    ['source name', () => { const task = fixture('extract'); task.sources[0]!.name = 'x'.repeat(501); return task; }],
    ['source id', () => { const task = fixture('extract'); task.sources[0]!.id = 'x'.repeat(201); return task; }],
    ['source count', () => { const task = fixture('extract'); task.sources = Array.from({ length: LIMITS.modelSourcesMaximum + 1 }, (_, i) => ({ ...task.sources[0]!, id: `s${i}` })); return task; }],
    ['empty point set', () => ({ ...fixture('followup'), points: [] })],
    ['point count', () => { const task = fixture('followup'); task.points = Array.from({ length: 51 }, (_, i) => ({ ...task.points[0]!, id: `p${i}` })); return task; }],
    ['point title', () => { const task = fixture('followup'); task.points[0]!.title = ''; return task; }],
    ['point references', () => { const task = fixture('followup'); task.points[0]!.sourceIds = Array.from({ length: 15 }, (_, i) => `s${i}`); return task; }],
    ['turn count', () => { const task = fixture('followup'); task.turns = Array.from({ length: 51 }, (_, i) => ({ ...task.turns[0]!, id: `t${i}` })); return task; }],
    ['turn answer', () => { const task = fixture('followup'); task.turns[0]!.answer = 'x'.repeat(LIMITS.modelInputChars + 1); return task; }],
    ['quiz count', () => ({ ...fixture('quiz'), count: LIMITS.quizQuestionsMaximum + 1 })],
    ['recall', () => ({ ...fixture('quiz'), recall: 'x'.repeat(LIMITS.modelInputChars + 1) })],
    ['weakness question', () => { const task = fixture('quiz'); task.weaknesses![0]!.question = 'x'.repeat(3001); return task; }],
    ['weakness area', () => { const task = fixture('quiz'); task.weaknesses![0]!.weakAreas = ['x'.repeat(801)]; return task; }],
    ['formal answer', () => ({ ...fixture('grade'), answer: 'x'.repeat(LIMITS.answerChars + 1) })],
  ] satisfies [string, () => AiTask][])('retains historical %s while refusing it at the model boundary', (_name, make) => {
    const task = make(); const before = structuredClone(task);
    expect(storedAiTaskSchema.safeParse(task).success).toBe(true);
    expect(modelAiTaskSchema.safeParse(task).success).toBe(false);
    expect(task).toEqual(before);
  });

  it('keeps archive recitation limits separate from excerpt limits and accepts exact boundaries', () => {
    const task = fixture('extract');
    task.recitation.learned = 'x'.repeat(LIMITS.recitationFieldChars);
    expect(storedAiTaskSchema.safeParse(task).success).toBe(true);
    task.recitation.learned += 'x';
    expect(storedAiTaskSchema.safeParse(task).success).toBe(false);
    expect(modelAiTaskSchema.safeParse(task).success).toBe(true);
    task.recitation.learned = 'x'.repeat(LIMITS.modelInputChars);
    expect(modelAiTaskSchema.safeParse(task).success).toBe(true);
    task.recitation.learned += 'x';
    expect(modelAiTaskSchema.safeParse(task).success).toBe(false);
    task.recitation.learned = 'ok'; task.recitation.topic = 'x'.repeat(LIMITS.topicChars + 1);
    for (const schema of both) expect(schema.safeParse(task).success).toBe(false);
    const grade = fixture('grade'); grade.answer = 'x'.repeat(LIMITS.answerChars);
    expect(modelAiTaskSchema.safeParse(grade).success).toBe(true);
  });

  it.each([
    ['zero quiz count', () => ({ ...fixture('quiz'), count: 0 })],
    ['too many quiz turns', () => { const task = fixture('quiz'); task.turns = Array(6).fill(task.turns![0]); return task; }],
    ['invalid weakness score', () => { const task = fixture('quiz'); task.weaknesses![0]!.score = 3; return task; }],
    ['missing code exercise', () => { const task = fixture('grade'); delete task.question.code; return task; }],
    ['code on a short question', () => { const task = fixture('grade'); task.question.kind = 'short'; return task; }],
    ['duplicate rubric', () => { const task = fixture('grade'); task.question.rubric.push({ ...task.question.rubric[0]! }); return task; }],
    ['invalid execution evidence', () => { const task = fixture('grade'); task.execution!.passed = 0; return task; }],
    ['invalid source id', () => { const task = fixture('extract'); task.sources[0]!.id = ''; return task; }],
  ] satisfies [string, () => AiTask][])('preserves shared structural rejection: %s', (_name, make) => {
    for (const schema of both) expect(schema.safeParse(make()).success).toBe(false);
  });
});
