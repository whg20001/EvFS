import { describe, expect, it } from 'vitest';
import type { AiTask, PointInput, SourceInput, Turn } from '@sanxing/contracts';
import { createLearningEngine, describeLearningPrompt, prepareLearningRequest, type LearningRequestOptions } from '@sanxing/learning-agent';
import { planLearningInput } from '../src/input-plan.ts';

type Followup = Extract<AiTask, { kind: 'followup' }>;
type Quiz = Extract<AiTask, { kind: 'quiz' }>;

const filler = (seed: string, length: number) => Array.from({ length: Math.ceil(length / 12) }, (_, index) => `${seed}背景${index}行。\n`).join('').slice(0, length);
const sources = (length: number): SourceInput[] => ['a', 'b', 'c'].map(id => ({ id: `doc-${id}`, name: `${id}.md`, text: `${filler(id, length)}\nNEEDLE_${id} 记忆化递归复用重叠子问题。\n${filler(id, length)}` }));
const points = (ids: string[]): PointInput[] => [{ id: 'p1', title: '记忆化递归', description: '复用重叠子问题的计算结果', sourceIds: ids, knowledgeVersion: 1 }];
const turn = (index: number, size: number): Turn => ({ id: `t${index}`, question: `第 ${index} 问`, answer: `答${index}`.repeat(size), feedback: `评${index}`.repeat(size / 4), assisted: false, scopeVersion: 1 });
const related = [{ id: 'old', title: '动态规划', description: '状态转移复用子问题', knowledgeVersion: 2 }];

const budgets: [string, LearningRequestOptions][] = [['mock chars only', { maxOutputTokens: 4096 }], ['live 32K window', { contextWindow: 32_000, maxOutputTokens: 4096 }]];

describe('learning input plan', () => {
  it.each(budgets)('protects the latest answered turn when a pending question follows it (%s)', (_, options) => {
    const docs = sources(20_000);
    const latest = turn(1, 800);
    const pending: Turn = { ...turn(2, 0), answer: null, feedback: null };
    const input: Quiz = { kind: 'quiz', count: 3, points: points(docs.map(source => source.id)), sources: docs, turns: [turn(0, 2_000), latest, pending] };
    const before = structuredClone(input);
    const plan = planLearningInput(input, options);
    const prepared = prepareLearningRequest(plan.task, options);
    expect(prepared.task.turns![0]!.answer).toMatch(/^\[较早作答已省略/);
    expect(prepared.task.turns!.slice(1)).toEqual([latest, pending]);
    expect(plan.summary.selectedTurns).toBe(2);
    expect(prepared.fields.filter(field => field.truncated)).toEqual([]);
    expect(input).toEqual(before);
  });

  it('excerpts a legal long practice answer for both followups and quizzes under a small model window', async () => {
    const options = { contextWindow: 32_000, maxOutputTokens: 4096 };
    const latest: Turn = { ...turn(0, 0), answer: '缓存'.repeat(6_000), feedback: '反馈'.repeat(1_500) };
    for (const kind of ['followup', 'quiz'] as const) {
      const input: Followup | Quiz = { kind, count: 1, points: points(['doc-a']), sources: sources(100).slice(0, 1), turns: [latest] };
      const before = structuredClone(input);
      const prepared = prepareLearningRequest(planLearningInput(input, options).task, options);
      expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(prepared.remainingInputTokens!);
      expect(prepared.fields.find(field => field.path === 'turns.t0.answer')?.truncated).toBe(true);
      expect(prepared.task.turns![0]!.answer).toContain('上下文节选');
      expect(prepared.task.turns![0]).toMatchObject({ id: latest.id, assisted: false, scopeVersion: 1 });
      expect(input).toEqual(before);
      await expect(createLearningEngine().execute(prepared.task, { signal: new AbortController().signal, expectedPrompt: describeLearningPrompt(prepared.task) })).resolves.toMatchObject({ output: { kind } });
    }
  });

  it('sends complete sources whenever they fit', () => {
    const input: Followup = { kind: 'followup', points: points(['doc-a']), sources: sources(300).slice(0, 1), turns: [] };
    const plan = planLearningInput(input, { maxOutputTokens: 4096 });
    expect(plan.summary.mode).toBe('full');
    expect(plan.task.sources).toEqual(input.sources);
  });

  it.each(budgets)('fits current sources before trimming the current request history (%s)', (_, options) => {
    const docs = sources(20_000); const scoped = points(docs.map(source => source.id));
    const requests = [
      { kind: 'followup', points: scoped, sources: docs, turns: [], related } satisfies Followup,
      { kind: 'followup', points: scoped, sources: docs, turns: [turn(1, 50), turn(2, 50)], related } satisfies Followup,
      { kind: 'followup', points: scoped, sources: docs, turns: [...Array.from({ length: 7 }, (_, index) => turn(index, 2_000)), turn(7, 100)], related } satisfies Followup,
      { kind: 'quiz', points: scoped, sources: docs, count: 3, turns: [turn(0, 100)], related } satisfies Quiz,
    ].map(task => {
      const plan = planLearningInput(task as AiTask, options);
      expect(plan.summary.mode).toBe('excerpt');
      const prepared = prepareLearningRequest(plan.task, options);
      expect(prepared.fields.filter(field => field.truncated).map(field => field.path)).toEqual([]); // H2 never re-cuts planned sources
      return { plan, prepared };
    });
    const stable = requests[0]!.prepared.blocks[0];
    expect(stable).toContain('NEEDLE_a'); expect(stable).toContain('"related"');
    // Long histories give up older answers first; the latest turn stays intact. Session quizzes
    // carry the same evidence in their dynamic block.
    const crowded = requests[2]!.plan.task as Followup;
    expect(crowded.turns[0]!.answer).toMatch(/^\[较早作答已省略/);
    expect(crowded.turns.at(-1)).toEqual(turn(7, 100));
    expect(requests[2]!.plan.summary.selectedTurns).toBeLessThan(8);
    expect((requests[1]!.plan.task as Followup).turns.at(-1)).toEqual(turn(2, 50));
    expect((requests[3]!.plan.task as Quiz).turns).toEqual([turn(0, 100)]);
    expect(requests[3]!.plan.summary.originalTurns).toBe(1);
    expect(requests[3]!.plan.summary.selectedTurns).toBe(1);
  });

  it('sends all sources when the actual request fits, even if a fixed future-turn reserve would not', () => {
    const options = { maxOutputTokens: 4096 };
    const doc: SourceInput[] = [{ id: 'doc-a', name: 'a.md', text: 'a'.repeat(20_000) }]; const scoped = points(['doc-a']);
    const input: Followup = { kind: 'followup', points: scoped, sources: doc, turns: [] };
    const plan = planLearningInput(input, options);
    expect(prepareLearningRequest(plan.task, options).truncated).toBe(false);
    expect(plan.task.sources).toEqual(doc);
  });

  it('re-selects sources only when the actual latest turn still exceeds the request budget', () => {
    const options = { contextWindow: 32_000, maxOutputTokens: 4096 };
    const docs = sources(20_000); const scoped = points(docs.map(source => source.id));
    const latest = turn(1, 1_500);
    const small = prepareLearningRequest(planLearningInput({ kind: 'followup', points: scoped, sources: docs, turns: [] }, options).task, options);
    const plan = planLearningInput({ kind: 'followup', points: scoped, sources: docs, turns: [turn(0, 2_000), latest] }, options);
    const prepared = prepareLearningRequest(plan.task, options);
    expect(prepared.fields.filter(field => field.truncated)).toEqual([]);
    expect((plan.task as Followup).turns.at(-1)).toEqual(latest);
    expect(prepared.blocks[0]!.length).toBeLessThan(small.blocks[0]!.length);
    expect(prepared.blocks[0]).toContain('NEEDLE_a');
  });

  it('plans review quizzes (with recall) against their own full budget, outside the session scope', () => {
    const docs = sources(20_000);
    const review: Quiz = { kind: 'quiz', points: points(docs.map(source => source.id)), sources: docs, count: 3, recall: 'NEEDLE_c 记忆化' };
    const session: Quiz = { kind: 'quiz', points: review.points, sources: docs, count: 3 };
    const reviewChars = planLearningInput(review, { maxOutputTokens: 4096 }).summary.selectedChars;
    const sessionChars = planLearningInput(session, { maxOutputTokens: 4096 }).summary.selectedChars;
    expect(reviewChars).toBeGreaterThan(0); // review recall remains its own dynamic input
    expect(prepareLearningRequest(planLearningInput(review, { maxOutputTokens: 4096 }).task, { maxOutputTokens: 4096 }).truncated).toBe(false);
  });
});
