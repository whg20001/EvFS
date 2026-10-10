import { describe, expect, it } from 'vitest';
import type { AiTask, PointInput, SourceInput, Turn } from '@sanxing/contracts';
import { prepareLearningRequest, type LearningRequestOptions } from '@sanxing/learning-agent';
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
  it('sends complete sources whenever they fit', () => {
    const input: Followup = { kind: 'followup', points: points(['doc-a']), sources: sources(300).slice(0, 1), turns: [] };
    const plan = planLearningInput(input, { maxOutputTokens: 4096 });
    expect(plan.summary.mode).toBe('full');
    expect(plan.task.sources).toEqual(input.sources);
  });

  it.each(budgets)('keeps one identical stable block across follow-up turns and the session quiz (%s)', (_, options) => {
    const docs = sources(20_000); const scoped = points(docs.map(source => source.id));
    const requests = [
      { kind: 'followup', points: scoped, sources: docs, turns: [], related } satisfies Followup,
      { kind: 'followup', points: scoped, sources: docs, turns: [turn(1, 50), turn(2, 50)], related } satisfies Followup,
      { kind: 'followup', points: scoped, sources: docs, turns: [...Array.from({ length: 7 }, (_, index) => turn(index, 2_000)), turn(7, 100)], related } satisfies Followup,
      { kind: 'quiz', points: scoped, sources: docs, count: 3, related } satisfies Quiz,
    ].map(task => {
      const plan = planLearningInput(task as AiTask, options);
      expect(plan.summary.mode).toBe('excerpt');
      const prepared = prepareLearningRequest(plan.task, options);
      expect(prepared.fields.filter(field => field.truncated).map(field => field.path)).toEqual([]); // H2 never re-cuts planned sources
      return { plan, prepared };
    });
    const stable = requests.map(item => item.prepared.blocks[0]);
    expect(new Set(stable).size).toBe(1);
    expect(stable[0]).toContain('NEEDLE_a'); expect(stable[0]).toContain('"related"');
    // Long histories give up older answers first; the latest turn stays intact.
    const crowded = requests[2]!.plan.task as Followup;
    expect(crowded.turns[0]!.answer).toMatch(/^\[较早作答已省略/);
    expect(crowded.turns.at(-1)).toEqual(turn(7, 100));
    expect(requests[2]!.plan.summary.selectedTurns).toBeLessThan(8);
    expect(requests[1]!.plan.summary.selectedTurns).toBe(2);
  });

  it('re-selects sources for one request when the latest answer alone exceeds the reserve, never cutting it', () => {
    const options = { contextWindow: 32_000, maxOutputTokens: 4096 };
    const docs = sources(20_000); const scoped = points(docs.map(source => source.id));
    const latest = turn(1, 1_500); // ~7.5 KB: above the ~5.5 KB dynamic reserve of a 32K window
    const small = prepareLearningRequest(planLearningInput({ kind: 'followup', points: scoped, sources: docs, turns: [] }, options).task, options);
    const plan = planLearningInput({ kind: 'followup', points: scoped, sources: docs, turns: [turn(0, 2_000), latest] }, options);
    const prepared = prepareLearningRequest(plan.task, options);
    expect(prepared.fields.filter(field => field.truncated)).toEqual([]);
    expect((plan.task as Followup).turns.at(-1)).toEqual(latest);
    expect(prepared.blocks[0]!.length).toBeLessThan(small.blocks[0]!.length); // this request only: a prefix-cache miss
    expect(prepared.blocks[0]).toContain('NEEDLE_a');
  });

  it('plans review quizzes (with recall) against their own full budget, outside the session scope', () => {
    const docs = sources(20_000);
    const review: Quiz = { kind: 'quiz', points: points(docs.map(source => source.id)), sources: docs, count: 3, recall: 'NEEDLE_c 记忆化' };
    const session: Quiz = { kind: 'quiz', points: review.points, sources: docs, count: 3 };
    const reviewChars = planLearningInput(review, { maxOutputTokens: 4096 }).summary.selectedChars;
    const sessionChars = planLearningInput(session, { maxOutputTokens: 4096 }).summary.selectedChars;
    expect(reviewChars).toBeGreaterThan(sessionChars); // no dynamic reserve held back for turns
    expect(prepareLearningRequest(planLearningInput(review, { maxOutputTokens: 4096 }).task, { maxOutputTokens: 4096 }).truncated).toBe(false);
  });
});
