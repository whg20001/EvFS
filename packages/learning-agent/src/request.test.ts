import { describe, expect, it, vi, afterEach } from 'vitest';
import { LIMITS, type AiTask, type GeneratedQuestion } from '@sanxing/contracts';
import { createExplicitProvider } from '@sanxing/ai-access/providers';
import { checkLearningRequest, inspectLearningRequest, prepareLearningRequest } from './index.ts';

const extract: Extract<AiTask, { kind: 'extract' }> = {
  kind: 'extract', recitation: { learned: '中文与😀复述', unclear: '', application: '', topic: '测试' },
  sources: [{ id: 's1', name: '来源', text: '汉字😀'.repeat(1000) }],
};
const question: GeneratedQuestion = { knowledgeId: 'k1', kind: 'short', prompt: '问题', options: [], correctIndex: null,
  referenceAnswer: '正式参考答案', rubric: [{ id: 'r1', description: '正式评分标准', maxScore: 2 }], sourceIds: ['s1'] };
const probe: Extract<AiTask, { kind: 'connection_test' }> = { kind: 'connection_test', selection: {
  providerId: 'private-provider', modelId: 'private-model', authMethod: 'oauth', allowUnboundedOutput: true,
} };
const options = { contextWindow: 8192, maxOutputTokens: 4096 };
afterEach(() => { vi.unstubAllGlobals(); });

describe('offline complete-request budget preparation and final rejection', () => {
  it('sends a stable scope block before dynamic turns without reordering the confirmed point scope', () => {
    const task: Extract<AiTask, { kind: 'followup' }> = { kind: 'followup',
      turns: [{ id: 't1', question: '问题', answer: '首次回答', feedback: null, assisted: false, scopeVersion: 1 }],
      sources: [{ id: 'z', text: '后来源', name: '乙' }, { name: '甲', text: '前来源', id: 'a' }],
      points: [{ id: 'p2', title: '二', description: '描述二', sourceIds: ['z'], knowledgeVersion: 2 },
        { id: 'p1', title: '一', description: '描述一', sourceIds: ['a'], knowledgeVersion: 1 }],
      related: [{ id: 'old', title: '旧知识', description: '旧描述', knowledgeVersion: 3 }],
    };
    const before = structuredClone(task);
    const budget = { contextWindow: 128_000, maxOutputTokens: 4096 };
    const prepared = prepareLearningRequest(task, budget);
    const next = checkLearningRequest({ ...task, sources: [...task.sources].reverse(),
      points: task.points.map(point => ({ ...point, knowledgeVersion: 9 })),
      turns: [{ ...task.turns[0]!, answer: '下一次回答' }],
    }, budget);
    expect(prepared.blocks).toHaveLength(2);
    expect(prepared.blocks[0]).toBe(next.blocks[0]);
    expect(prepared.blocks[1]).not.toBe(next.blocks[1]);
    expect(prepared.prompt).toBe(prepared.blocks.join('\n'));
    expect(prepared.systemPrompt).toBe(next.systemPrompt);
    const stable = JSON.parse(prepared.blocks[0]!);
    expect(Object.keys(stable)).toEqual(['sources', 'points', 'related']);
    expect(stable.sources.map((source: { id: string }) => source.id)).toEqual(['a', 'z']);
    expect(stable.points.map((point: { id: string }) => point.id)).toEqual(['p2', 'p1']);
    expect(stable.related).toEqual([{ id: 'old', title: '旧知识', description: '旧描述' }]);
    expect(JSON.parse(prepared.blocks[1]!)).toEqual({ kind: 'followup', turns: task.turns });
    expect(JSON.parse(next.blocks[1]!).turns[0].answer).toBe('下一次回答');
    expect(prepared.prompt).not.toContain('knowledgeVersion');
    expect(task).toEqual(before);
    expect(prepared.task.related).toEqual(task.related);
    expect(inspectLearningRequest(task, budget).prompt).toBe(prepared.prompt);
    expect(checkLearningRequest(prepared.task, budget).prompt).toBe(prepared.prompt);
  });

  it('shares one system prompt and stable block between follow-ups and the session quiz', () => {
    const budget = { contextWindow: 128_000, maxOutputTokens: 4096 };
    const scope = { sources: extract.sources, points: [{ id: 'p', title: '标题', description: '描述', sourceIds: ['s1'], knowledgeVersion: 1 }] };
    const followup = inspectLearningRequest({ kind: 'followup', turns: [], ...scope }, budget);
    const quiz = inspectLearningRequest({ kind: 'quiz', count: 3, ...scope }, budget);
    expect(quiz.systemPrompt).toBe(followup.systemPrompt);
    expect(quiz.blocks[0]).toBe(followup.blocks[0]);
    expect(JSON.parse(quiz.blocks[1]!)).toEqual({ kind: 'quiz', count: 3 });
    expect(followup.systemPrompt).toContain('kind=followup');
    expect(followup.systemPrompt).toContain('kind=quiz');
    expect(inspectLearningRequest(extract, budget).systemPrompt).not.toBe(followup.systemPrompt);
  });

  it('places source context before recitation and recall', () => {
    const budget = { contextWindow: 128_000, maxOutputTokens: 4096 };
    const first = inspectLearningRequest(extract, budget);
    const next = inspectLearningRequest({ ...extract, recitation: { ...extract.recitation, learned: '变化' } }, budget);
    expect(Object.keys(JSON.parse(first.blocks[0]!))).toEqual(['sources']);
    expect(Object.keys(JSON.parse(first.blocks[1]!))).toEqual(['kind', 'recitation']);
    expect(first.blocks[0]).toBe(next.blocks[0]);
    const quiz: AiTask = { kind: 'quiz', count: 1, recall: '首次回忆', sources: extract.sources,
      points: [{ id: 'p', title: '标题', description: '描述', sourceIds: ['s1'], knowledgeVersion: 1 }] };
    const prepared = prepareLearningRequest(quiz, budget);
    const changed = checkLearningRequest({ ...quiz, recall: '更新回忆', count: 2 }, budget);
    expect(Object.keys(JSON.parse(prepared.blocks[1]!))).toEqual(['kind', 'count', 'recall']);
    expect(prepared.blocks[0]).toBe(changed.blocks[0]);
    expect(prepared.prompt).toBe(checkLearningRequest(prepared.task, budget).prompt);
  });

  it('uses the explicit local gpt-4 directory window without network or credentials', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
    const model = createExplicitProvider('openai').getModels().find(model => model.id === 'gpt-4');
    expect(model?.contextWindow).toBe(8192);
    const prepared = prepareLearningRequest(extract, { ...options, contextWindow: model!.contextWindow });
    expect(prepared.truncated).toBe(true);
    expect(prepared.estimatedInputTokens + prepared.outputReserveTokens + prepared.safetyMarginTokens).toBeLessThanOrEqual(8192);
    expect(prepared.contextWindow).toBe(8192);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts complete schema/system/user UTF-8 bytes, not characters divided by four', () => {
    const result = inspectLearningRequest(extract, options);
    expect(result.estimatedInputTokens).toBe(Buffer.byteLength(result.systemPrompt) + Buffer.byteLength(result.prompt));
    expect(result.estimatedInputTokens).toBeGreaterThan(result.systemPrompt.length + result.prompt.length);
    expect(result.safetyMarginTokens).toBe(512);
    expect(result.outputReserveTokens).toBe(4096);
    expect(result.remainingInputTokens).toBe(8192 - 4096 - 512);
    const schema = JSON.parse(result.systemPrompt.split('输出 JSON Schema：')[1]!);
    expect(schema.properties.kind.const).toBe('extract');
    expect(schema.anyOf).toBeUndefined();
    expect(result.systemPrompt).not.toContain('"quiz"');
    expect(result.task).toBe(extract);
    expect(result.truncated).toBe(false);
  });

  it('retains all in-scope text when it fits, even beyond old 3000/6000 per-field caps', () => {
    const task = { ...extract, recitation: { ...extract.recitation, learned: '学'.repeat(6500) } };
    const before = structuredClone(task);
    const prepared = prepareLearningRequest(task, { contextWindow: 128_000, maxOutputTokens: 4096 });
    expect(prepared.task).toEqual(before);
    expect(task).toEqual(before);
    expect(prepared.originalChars).toBe(prepared.sentChars);
    expect(prepared.truncated).toBe(false);
    expect(prepared.fields.length).toBeGreaterThan(0);
    expect(prepared.fields.every(field => !field.truncated && field.originalChars === field.sentChars)).toBe(true);
  });

  it('excerpts only in preparation and sends the exact same prompts on final check', () => {
    const before = structuredClone(extract);
    expect(() => checkLearningRequest(extract, options)).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE', usage: null }));
    const prepared = prepareLearningRequest(extract, options);
    expect(prepared.truncated).toBe(true);
    expect(prepared.task.sources[0]!.text).toContain('上下文节选');
    expect(prepared.fields.some(field => field.truncated)).toBe(true);
    expect(extract).toEqual(before);
    const checked = checkLearningRequest(prepared.task, options);
    expect(checked.task).toBe(prepared.task);
    expect(checked.prompt).toBe(prepared.prompt);
    expect(checked.systemPrompt).toBe(prepared.systemPrompt);
    expect(checked.estimatedInputTokens).toBe(prepared.estimatedInputTokens);
    const json = JSON.stringify(prepared.task);
    expect(json).not.toMatch(/\\u[dD][89aAbB][0-9a-fA-F]{2}|\\u[dD][c-fC-F][0-9a-fA-F]{2}/);
  });

  it('accounts for schema overhead and the actual output reserve at the exact boundary', () => {
    const task = { ...extract, sources: [{ ...extract.sources[0]!, text: '中文😀' }] };
    const measured = inspectLearningRequest(task, options);
    const contextWindow = measured.estimatedInputTokens + 512 + 4096;
    expect(checkLearningRequest(task, { ...options, contextWindow }).truncated).toBe(false);
    expect(() => checkLearningRequest(task, { ...options, contextWindow: contextWindow - 1 })).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
    expect(() => checkLearningRequest(task, { ...options, contextWindow, maxOutputTokens: 4097 })).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE' }));
  });

  it('never excerpts formal answers or rubrics and uses a safe fixed failure', () => {
    const task: AiTask = { kind: 'grade', question, answer: 'private正式答案'.repeat(800) };
    const before = structuredClone(task);
    let error: unknown;
    try { prepareLearningRequest(task, options); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', usage: null });
    expect((error as Error).message).not.toContain('private');
    expect(task).toEqual(before);
    const full = prepareLearningRequest(task, { ...options, contextWindow: 128_000 });
    expect(full.task).toEqual(task);
    expect(full.truncated).toBe(false);
  });

  it('fails when fixed system overhead alone exceeds the available input', () => {
    const task = { ...extract, sources: [] };
    const measured = inspectLearningRequest(task, options);
    expect(() => prepareLearningRequest(task, { ...options, contextWindow: 4096 + 512 + Buffer.byteLength(measured.systemPrompt) })).toThrowError(expect.objectContaining({ code: 'MODEL_INPUT_TOO_LARGE', usage: null }));
  });

  it('preserves mock character limits while permitting explicit offline preparation', () => {
    const task = { ...extract, sources: [{ ...extract.sources[0]!, text: 'x'.repeat(LIMITS.modelInputChars) }] };
    expect(() => checkLearningRequest(task, { maxOutputTokens: 4096 })).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
    const prepared = prepareLearningRequest(task, { maxOutputTokens: 4096 });
    expect(prepared.contextWindow).toBeNull();
    expect(prepared.remainingInputTokens).toBeNull();
    expect(prepared.truncated).toBe(true);
    expect(prepared.prompt.length).toBeLessThanOrEqual(LIMITS.modelInputChars);
  });

  it('omits knowledge versions from both measurement and upstream payload', () => {
    const task: AiTask = { kind: 'quiz', count: 1, points: [{ id: 'p', title: '标题', description: '描述', sourceIds: ['s1'], knowledgeVersion: 999 }], sources: [] };
    const prepared = prepareLearningRequest(task, { ...options, contextWindow: 16_384 });
    expect(prepared.task).toEqual(task);
    expect(prepared.prompt).not.toContain('knowledgeVersion');
    expect(prepared.systemPrompt.split('输出 JSON Schema（').slice(1).join('')).not.toContain('knowledgeVersion');
    expect(prepared.estimatedInputTokens).toBe(Buffer.byteLength(prepared.prompt) + Buffer.byteLength(prepared.systemPrompt));
  });

  it('preserves grading provenance in the stored task without counting or sending it upstream', () => {
    const hostQuestion = { ...question, id: 'host-question-id', knowledgeVersion: 19 };
    const task: AiTask = { kind: 'grade', question: hostQuestion, answer: '完整正式答案' };
    const prepared = prepareLearningRequest(task, options);
    const withoutHost = checkLearningRequest({ ...task, question }, options);
    expect(prepared.task.question).toEqual(hostQuestion);
    expect(prepared.prompt).toBe(withoutHost.prompt);
    expect(prepared.estimatedInputTokens).toBe(withoutHost.estimatedInputTokens);
    expect(prepared.prompt).not.toContain('host-question-id');
    expect(prepared.prompt).not.toContain('knowledgeVersion');
  });

  it('does not excerpt a boundary-sized payload merely because host versions add stored characters', () => {
    const base: Extract<AiTask, { kind: 'quiz' }> = { kind: 'quiz', count: 1, points: [{ id: 'p', title: '标题', description: '描述', sourceIds: ['s1'], knowledgeVersion: 999 }], sources: [{ id: 's1', name: '资料', text: '' }] };
    const baseline = inspectLearningRequest(base, { maxOutputTokens: 4096 });
    const task = { ...base, sources: [{ ...base.sources[0]!, text: 'x'.repeat(LIMITS.modelInputChars - baseline.prompt.length) }] };
    expect(JSON.stringify(task).length).toBeGreaterThan(LIMITS.modelInputChars);
    const prepared = prepareLearningRequest(task, { maxOutputTokens: 4096 });
    expect(prepared.prompt.length).toBe(LIMITS.modelInputChars);
    expect(prepared.task).toEqual(task);
    expect(prepared.truncated).toBe(false);
    expect(prepared.originalChars).toBe(JSON.stringify(task).length);
    expect(prepared.sentChars).toBe(prepared.originalChars);
  });

  it('never serializes selection in connection prompts and reserves the effective capped output', () => {
    const prepared = prepareLearningRequest(probe, options);
    const other = prepareLearningRequest({ ...probe, selection: { ...probe.selection, modelId: 'different'.repeat(2000) } }, options);
    expect(prepared.prompt).toBe(other.prompt);
    expect(prepared.systemPrompt).toBe(other.systemPrompt);
    expect(prepared.estimatedInputTokens).toBe(other.estimatedInputTokens);
    for (const text of ['selection', 'private', 'candidates', '$schema']) expect(prepared.prompt + prepared.systemPrompt).not.toContain(text);
    expect(prepared.outputReserveTokens).toBe(256);
    expect(prepareLearningRequest(probe, { ...options, maxOutputTokens: 32 }).outputReserveTokens).toBe(32);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '8192'])('fails closed on invalid contextWindow %s', contextWindow => {
    expect(() => prepareLearningRequest(extract, { ...options, contextWindow: contextWindow as number })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
  it.each([0, -1, 1.5, NaN, Infinity, 16_385, undefined])('fails closed on invalid output reserve %s', maxOutputTokens => {
    expect(() => prepareLearningRequest(extract, { ...options, maxOutputTokens: maxOutputTokens as number })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

it('代码偏好仅放动态块，评分保留代码与不可信 execution，提示明确评判规则', () => {
  const task: Extract<AiTask, { kind: 'quiz' }> = { kind: 'quiz', points: [{ id: 'k1', title: '函数', description: '编程', sourceIds: ['s1'] }], sources: extract.sources, count: 1 };
  const budget = { contextWindow: 128_000, maxOutputTokens: 4096 };
  const plain = inspectLearningRequest(task, budget);
  const code = inspectLearningRequest({ ...task, code: { languages: ['typescript'] } }, budget);
  expect(code.blocks[0]).toBe(plain.blocks[0]); expect(JSON.parse(code.blocks[1]!).code).toEqual({ languages: ['typescript'] });
  for (const keyword of ['TODO', 'numpy', 'scipy', 'sklearn', 'kind=code']) expect(code.systemPrompt).toContain(keyword);
  const execution = { status: 'passed' as const, total: 1, passed: 1, output: 'untrusted-browser', durationMs: 2, ranAt: '2026-10-10T00:00:00.000Z' };
  const grade = inspectLearningRequest({ kind: 'grade', question: { ...question, kind: 'code', code: { language: 'typescript', starter: 'const n: number = 0;', tests: [{ name: '值', code: 'assertEqual(n, 1);' }] } }, answer: 'const n: number = 1;', execution }, budget);
  expect(JSON.parse(grade.prompt).execution).toEqual(execution);
  for (const keyword of ['不可信', 'rubric', '未运行']) expect(grade.systemPrompt).toContain(keyword);
});
