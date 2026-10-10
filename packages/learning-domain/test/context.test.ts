import { describe, expect, it } from 'vitest';
import type { AiTask, PointInput, SourceInput } from '@sanxing/contracts';
import { LIMITS } from '@sanxing/contracts';
import { prepareTaskContext, previewRecitationContext } from '../../contracts/src/context.ts';

const point: PointInput = { id: 'knowledge-id', title: '缓存穿透', description: '不存在的 key 反复访问数据库。', sourceIds: ['current-source'], knowledgeVersion: 3 };
const question = { knowledgeId: point.id, kind: 'short' as const, prompt: '解释原理', options: [], correctIndex: null, referenceAnswer: '固定参考答案', rubric: [{ id: 'rubric-id', description: '固定评分标准', maxScore: 2 }], sourceIds: ['current-source'] };
const bytes = (task: AiTask) => new TextEncoder().encode(JSON.stringify(task)).byteLength;
const cut = '\n[上下文节选：其余内容未发送，完整原文仍已保存。]';
type Budget = NonNullable<Parameters<typeof prepareTaskContext>[1]>;

function assertBudget<T extends AiTask>(task: T, budget?: Budget) {
  const before = structuredClone(task);
  const result = prepareTaskContext(task, budget);
  expect(result.originalChars).toBe(JSON.stringify(task).length);
  expect(result.sentChars).toBe(JSON.stringify(result.task).length);
  expect(result.sentChars).toBeLessThanOrEqual(Math.min(LIMITS.modelInputChars, budget?.maxChars ?? Infinity));
  if (budget?.maxUtf8Bytes !== undefined) expect(bytes(result.task)).toBeLessThanOrEqual(budget.maxUtf8Bytes);
  expect(task).toEqual(before);
  expect(result.task).not.toBe(task);
  expect(prepareTaskContext(result.task, budget).task).toEqual(result.task);
  for (const field of result.fields) {
    expect(Object.keys(field).sort()).toEqual(['originalChars', 'path', 'sentChars', 'truncated']);
    expect(typeof field.path).toBe('string');
    expect(typeof field.originalChars).toBe('number');
    expect(typeof field.sentChars).toBe('number');
    expect(typeof field.truncated).toBe('boolean');
  }
  expect(result.truncated).toBe(result.fields.some(field => field.truncated));
  return result;
}

function recitationSource(recitation: { learned: string; unclear: string; application: string }): SourceInput {
  return { id: 'recitation:current-session', name: '本次原始复述', text: `${recitation.learned}\n疑问：${recitation.unclear}\n应用：${recitation.application}` };
}

const emptyRecitation = { learned: '', unclear: '', application: '', topic: '范围' };

describe('shared deterministic external context budgeting', () => {
  it('retains the complete 16765-character input except its duplicate recitation source', () => {
    const recitation = { learned: '学'.repeat(6_100) + 'LEARNED_TAIL', unclear: '疑'.repeat(150), application: '用'.repeat(150), topic: '范围' };
    const task = { kind: 'extract' as const, recitation, sources: [recitationSource(recitation), { id: 'doc', name: 'doc.md', text: '' }] };
    const remaining = 16_765 - JSON.stringify(task).length;
    task.sources[1]!.text = '文'.repeat(remaining - 'SOURCE_TAIL'.length) + 'SOURCE_TAIL';
    expect(JSON.stringify(task).length).toBe(16_765);
    expect(task.sources[1]!.text.length).toBeGreaterThan(3_000);
    const result = assertBudget(task);
    expect(result.task.recitation).toEqual(recitation);
    expect(result.task.sources[1]).toEqual(task.sources[1]);
    expect(result.task.sources[0]!.text).toContain('不重复发送');
    expect(result.truncated).toBe(false);
    expect(result.fields).toEqual([
      ...(['learned', 'unclear', 'application'] as const).map(key => ({ path: `recitation.${key}`, originalChars: recitation[key].length, sentChars: recitation[key].length, truncated: false })),
      { path: 'sources.doc.text', originalChars: remaining, sentChars: remaining, truncated: false },
    ]);
    expect(previewRecitationContext(recitation, task.sources)).toEqual(result);
  });

  it('keeps all three 6k-plus recitation fields and a 3k-plus source when the total fits', () => {
    const recitation = { learned: '学'.repeat(7_000), unclear: '疑'.repeat(7_000), application: '用'.repeat(7_000), topic: '范围' };
    const task = { kind: 'extract' as const, recitation, sources: [{ id: 'doc', name: 'doc.md', text: '文'.repeat(10_000) }] };
    expect(assertBudget(task)).toMatchObject({ task, truncated: false });
  });

  for (const budget of [undefined, { maxChars: 32_000, maxUtf8Bytes: 36_000 }]) {
    it.each(['中', '\\', '"', '\u0001', '😀'])(`handles eleven sources, ten 1 MiB documents and three 20k fields (${budget ? 'dual budget' : 'default budget'}), including %j`, character => {
      const text = character.repeat(LIMITS.recitationFieldChars / character.length);
      const recitation = { learned: text, unclear: text, application: text, topic: '范围' };
      const sources: SourceInput[] = Array.from({ length: LIMITS.documentsMaximum }, (_, index) => ({ id: `source-${index}`, name: `note-${index}.md`, text: 'x'.repeat(LIMITS.uploadBytesMaximum) }));
      sources.unshift(recitationSource(recitation));
      const input = { kind: 'extract' as const, recitation, sources };
      const result = assertBudget(input, budget);
      expect(result.truncated).toBe(true);
      expect(result.task.sources.map(source => source.id)).toEqual(sources.map(source => source.id));
      expect(result.task.sources[0]!.text).toContain('不重复发送');
      expect(result.task.recitation.learned).toContain('上下文节选');
      expect(result.fields).toHaveLength(13);
      for (const field of result.fields) expect(field.truncated).toBe(true);
      if (!budget) expect(previewRecitationContext(recitation, sources)).toEqual(result);
      if (character === '😀') expect(result.task.recitation.learned.replaceAll('😀', '')).not.toMatch(/[\ud800-\udfff]/u);
    });
  }

  it('deduplicates before checking the total, without treating deduplication as truncation', () => {
    const recitation = { ...emptyRecitation, learned: '学'.repeat(30_000) };
    const input = { kind: 'extract' as const, recitation, sources: [recitationSource(recitation)] };
    expect(JSON.stringify(input).length).toBeGreaterThan(LIMITS.modelInputChars);
    expect(assertBudget(input)).toMatchObject({ task: { recitation }, truncated: false });
    const nonDuplicate = { ...input, sources: [{ ...input.sources[0]!, text: 'different recitation text' }] };
    expect(assertBudget(nonDuplicate)).toMatchObject({ task: nonDuplicate, truncated: false });
  });

  it('selects deterministic beginning, middle and end windows only after the total exceeds budget', () => {
    const text = 'HEAD_CLUE' + 'a'.repeat(30_000) + 'MIDDLE_CLUE' + 'z'.repeat(30_000) + 'TAIL_CLUE';
    const input = { kind: 'extract' as const, recitation: { ...emptyRecitation, learned: text }, sources: [{ id: 'doc', name: 'doc.md', text }] };
    const result = assertBudget(input, { maxChars: 8_000, maxUtf8Bytes: 9_000 });
    for (const sent of [result.task.recitation.learned, result.task.sources[0]!.text]) {
      for (const clue of ['HEAD_CLUE', 'MIDDLE_CLUE', 'TAIL_CLUE', '上下文节选']) expect(sent).toContain(clue);
    }
    expect(prepareTaskContext(input, { maxChars: 8_000, maxUtf8Bytes: 9_000 })).toEqual(result);
  });

  it.each(['followup', 'quiz'] as const)('filters %s sources to current points before budgeting, with no false loss flag', kind => {
    const common = { points: [point], sources: [
      { id: 'current-source', name: 'current.md', text: '当前范围'.repeat(2_000) },
      { id: 'old-source', name: 'old.md', text: 'OLD_SCOPE_SENTINEL'.repeat(10_000) },
    ] };
    const input: AiTask = kind === 'quiz' ? { ...common, kind, count: 3 } : { ...common, kind, turns: [] };
    const result = assertBudget(input);
    expect(result.task.sources).toEqual([common.sources[0]]);
    expect(result.task.points).toEqual(input.points);
    expect(result.truncated).toBe(false);
    expect(result.fields.some(field => field.path.includes('old-source'))).toBe(false);
    expect(JSON.stringify(result.task)).not.toContain('OLD_SCOPE_SENTINEL');
  });

  it.each(['followup', 'quiz'] as const)('uses title-related %s windows beyond the start and lengths from the actual budget', kind => {
    const common = { points: [point], sources: [{ id: 'current-source', name: 'current.md', text: '无关前文\n'.repeat(10_000) + '\n缓存穿透：NEEDLE_TARGET_DETAIL\n' + '无关后文\n'.repeat(10_000) }] };
    const task: AiTask = kind === 'quiz' ? { ...common, kind, count: 3 } : { ...common, kind, turns: [] };
    const smaller = assertBudget(task, { maxChars: 2_000 });
    const larger = assertBudget(task, { maxChars: 10_000 });
    for (const result of [smaller, larger]) {
      expect(result.task.sources[0]!.text).toContain('NEEDLE_TARGET_DETAIL');
      expect(result.task.sources[0]!.text).toContain('上下文节选');
      expect(result.task.points).toEqual(task.points);
    }
    expect(larger.task.sources[0]!.text.length).toBeGreaterThan(3_000);
    expect(smaller.task.sources[0]!.text.length).toBeLessThan(larger.task.sources[0]!.text.length);
  });

  it('bounds followup context while preserving references and archived input turns', () => {
    const task: AiTask = { kind: 'followup', points: [point], sources: [{ id: 'current-source', name: 'current.md', text: '来源'.repeat(10_000) }], turns: Array.from({ length: LIMITS.followupsMaximum }, (_, index) => ({ id: `turn-${index}`, scopeVersion: 2, question: '问题'.repeat(1_000), answer: '\u0001'.repeat(LIMITS.answerChars), feedback: '反馈'.repeat(1_500), assisted: false })) };
    const result = assertBudget(task, { maxUtf8Bytes: 30_000 });
    expect(result.task.turns.every(turn => turn.answer!.includes('上下文节选'))).toBe(true);
    expect(result.task.points[0]!.sourceIds).toEqual(point.sourceIds);
    expect(result.task.points[0]!.knowledgeVersion).toBe(3);
    expect(result.task.turns.map(({ id, scopeVersion, assisted }) => ({ id, scopeVersion, assisted }))).toEqual(task.turns.map(({ id, scopeVersion, assisted }) => ({ id, scopeVersion, assisted })));
    expect(result.fields.find(field => field.path === 'turns.turn-0.answer')).toMatchObject({ originalChars: LIMITS.answerChars, truncated: true });
  });

  it('budgets quiz recall and point descriptions without shortening titles or IDs', () => {
    const task = { kind: 'quiz' as const, count: 3, points: [{ ...point, description: '描述'.repeat(15_000) }], sources: [], recall: '回忆'.repeat(20_000) };
    const result = assertBudget(task, { maxChars: 5_000, maxUtf8Bytes: 7_000 });
    expect(result.task.points[0]).toMatchObject({ id: point.id, title: point.title, sourceIds: point.sourceIds });
    expect(result.fields.map(field => field.path)).toEqual(['points.knowledge-id.description', 'recall']);
    expect(result.fields.every(field => field.truncated)).toBe(true);
  });

  it('enforces UTF-8 even when the character budget fits, and never permits more than the default 48k', () => {
    const task = { kind: 'extract' as const, recitation: { ...emptyRecitation, learned: '😀中'.repeat(10_000) }, sources: [] };
    expect(assertBudget(task).truncated).toBe(false);
    expect(assertBudget(task, { maxChars: 1_000_000, maxUtf8Bytes: 12_000 }).truncated).toBe(true);
    const oversized = { ...task, recitation: { ...task.recitation, learned: 'x'.repeat(60_000) } };
    expect(assertBudget(oversized, { maxChars: 1_000_000 }).truncated).toBe(true);
  });

  it.each(['"', '\\', '\u0001', '😀'])('checks exact JSON and UTF-8 budgets at zero-cap and escaping boundaries for %j', character => {
    const task = { kind: 'extract' as const, recitation: emptyRecitation, sources: [{ id: 'doc', name: 'doc.md', text: character.repeat(10_000) }] };
    const minimumTask = { ...task, sources: [{ ...task.sources[0]!, text: cut }] };
    const minChars = JSON.stringify(minimumTask).length;
    const minBytes = bytes(minimumTask);
    const result = assertBudget(task, { maxChars: minChars, maxUtf8Bytes: minBytes });
    expect(result.task).toEqual(minimumTask);
    expect(() => prepareTaskContext(task, { maxChars: minChars - 1 })).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
    expect(() => prepareTaskContext(task, { maxUtf8Bytes: minBytes - 1 })).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
    for (const extra of [1, 2, 3, 6, 17, 100]) assertBudget(task, { maxChars: minChars + extra, maxUtf8Bytes: minBytes + extra });
  });

  it('preserves normal formal answers, rubrics and IDs byte-for-byte, including exact boundaries', () => {
    const task: AiTask = { kind: 'grade', question, answer: '\\"\n'.repeat(4_000) };
    const result = assertBudget(task, { maxChars: JSON.stringify(task).length, maxUtf8Bytes: bytes(task) });
    expect(result.task).toEqual(task);
    expect(result.truncated).toBe(false);
    expect(result.fields).toEqual([]);
    for (const budget of [{ maxChars: JSON.stringify(task).length - 1 }, { maxUtf8Bytes: bytes(task) - 1 }]) {
      expect(() => prepareTaskContext(task, budget)).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
    }
  });

  it('refuses oversized fixed inputs instead of shortening formal answers, rubrics or titles', () => {
    for (const task of [
      { kind: 'grade' as const, question, answer: '\u0001'.repeat(LIMITS.answerChars) },
      { kind: 'grade' as const, question: { ...question, rubric: [{ id: 'same-id', description: '旧备份评分标准'.repeat(12_000), maxScore: 2 }] }, answer: '正式答案' },
      { kind: 'quiz' as const, count: 1, points: [{ ...point, title: '固定标题'.repeat(12_000) }], sources: [] },
    ]) {
      const before = structuredClone(task);
      expect(() => prepareTaskContext(task)).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
      expect(task).toEqual(before);
    }
  });

  it('leaves small inputs and connection selections unchanged, but rejects impossible budgets', () => {
    const task: AiTask = { kind: 'connection_test', selection: { providerId: 'offline', modelId: 'offline-model', authMethod: 'oauth', allowUnboundedOutput: false } };
    expect(assertBudget(task)).toMatchObject({ task, truncated: false });
    const extract: AiTask = { kind: 'extract', recitation: { learned: '内容', unclear: '', application: '', topic: '' }, sources: [{ id: 'doc', name: 'doc.md', text: '文档' }] };
    expect(assertBudget(extract)).toMatchObject({ task: extract, truncated: false });
    for (const budget of [{ maxChars: 0 }, { maxUtf8Bytes: 0 }, { maxChars: NaN }, { maxUtf8Bytes: NaN }]) {
      expect(() => prepareTaskContext(task, budget)).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
    }
  });
});
