import { describe, expect, it } from 'vitest';
import { LIMITS } from '@sanxing/contracts';
import type { AiTask, AppData, DocumentRecord, KnowledgePoint, SourceInput } from '@sanxing/contracts';
import { findRelatedKnowledge, prepareRetrieval, searchLibrary, selectRelevantSources } from '../src/retrieval.ts';

function data(): AppData {
  return { schemaVersion: 1, ownerId: 'offline-test', mode: 'mock', revision: 0, recitations: {}, documents: {}, sessions: {}, knowledge: {}, quizzes: {}, cards: {}, reviewSessions: {}, reviewEvents: {}, evidence: {}, runs: {}, receipts: {} };
}
function document(id: string, text: string, name = 'archived.md'): DocumentRecord {
  return { id, name, text, recitationId: 'old-session', hash: 'unused', lineCount: text.split('\n').length, createdAt: '2025-01-01', originalBase64: '' };
}
function knowledge(id: string, title: string, description: string): KnowledgePoint {
  return { id, title, description, sourceIds: ['old-doc'], version: 19, understanding: '', createdAt: '2025-01-01', updatedAt: '2025-01-01' };
}
it('ranks within authorized review sources before limiting count, rather than discarding newer matching originals', () => {
  const sources = Array.from({ length: 20 }, (_, index) => ({ id: `document-${index}`, name: 'notes.md', text: index === 19 ? 'TAIL_NEEDLE unique matching source' : 'irrelevant archive' }));
  const before = structuredClone(sources);
  const selected = selectRelevantSources(sources, 'TAIL_NEEDLE', 10);
  expect(selected).toHaveLength(10); expect(selected[0]!.id).toBe('document-19');
  expect(selected.every(source => sources.includes(source))).toBe(true);
  expect(selectRelevantSources(sources, 'TAIL_NEEDLE', 10)).toEqual(selected); expect(sources).toEqual(before);
  expect(selectRelevantSources(sources, 'TAIL_NEEDLE', 0)).toEqual([]);
});

const recitation = { topic: '', learned: '', unclear: '', application: '' };
const point = { id: 'point', title: '缓存穿透', description: '不存在的数据反复查询', sourceIds: ['allowed'] };
const source = (text: string, id = 'allowed'): SourceInput => ({ id, name: 'note.md', text });
const quiz = (text: string) => ({ kind: 'quiz' as const, points: [point], count: 3, sources: [source(text)] });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function expectUnicode(text: string) {
  expect(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(/[\uD800-\uDFFF]/);
}

describe('local library BM25', () => {
  it('finds archived Chinese document tails and returns exact original line ranges', () => {
    const input = data();
    const lines = [...Array.from({ length: 800 }, () => '地理资料，与本问题无关。'), '缓存穿透：不存在的数据反复查询。TAIL_NEEDLE'];
    input.documents.old = document('original-document-id', lines.join('\r\n'));
    const before = structuredClone(input);
    const result = searchLibrary(freeze(input), '缓存穿透');
    expect(result.strategy).toBe('local-bm25-v1');
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit).toMatchObject({ kind: 'document', id: 'original-document-id', endLine: 801, contentVersion: null });
    expect(hit.excerpt).toContain('TAIL_NEEDLE');
    expect(hit.excerpt).toBe(lines.slice(hit.startLine - 1, hit.endLine).join('\n'));
    expect(hit.excerpt.length).toBeLessThanOrEqual(900);
    expect(input).toEqual(before);
    expect(searchLibrary(input, '缓存穿透')).toEqual(result);
  });

  it('normalizes English, fullwidth characters and punctuation, and searches names', () => {
    const input = data();
    input.documents.a = document('a', 'An introduction to PostgreSQL transactions.');
    input.documents.b = document('b', 'unrelated body', 'UniqueTitle.md');
    expect(searchLibrary(input, 'ＰＯＳＴＧＲＥＳＱＬ!!!').hits.map(hit => hit.id)).toEqual(['a']);
    expect(searchLibrary(input, 'uniquetitle').hits.map(hit => hit.id)).toEqual(['b']);
    expect(searchLibrary(input, 'transaction').hits).toEqual([]); // No advertised stemming/semantic coverage.
  });

  it('finds confirmed knowledge via descriptions despite different titles and keeps real versions', () => {
    const input = data();
    input.knowledge.a = knowledge('original-knowledge-id', '请求防护', '缓存穿透会让不存在的数据反复查询数据库');
    input.knowledge.b = { ...knowledge('versioned', '防护补充', '缓存穿透与空值缓存'), contentVersion: 3 };
    input.documents.a = document('document-match', '缓存穿透');
    const result = searchLibrary(input, '缓存穿透', 'knowledge');
    expect(result.hits).toHaveLength(2);
    expect(result.hits.find(hit => hit.id === 'original-knowledge-id')).toMatchObject({ kind: 'knowledge', contentVersion: null });
    expect(result.hits.find(hit => hit.id === 'versioned')).toMatchObject({ contentVersion: 3 });
    expect(searchLibrary(input, '缓存穿透', 'document').hits.map(hit => hit.id)).toEqual(['document-match']);
  });

  it.each(['', '   ', '!!!，。', 'the AND of 的 了 是'])('does not enumerate the library for empty/stopword query %j', query => {
    const input = data();
    input.documents.a = document('a', 'the AND 的 了 是 缓存');
    expect(searchLibrary(input, query).hits).toEqual([]);
  });

  it('explicitly rejects queries over the UTF-16 limit', () => {
    expect(() => searchLibrary(data(), 'x'.repeat(LIMITS.libraryQueryChars + 1))).toThrow(RangeError);
    expect(searchLibrary(data(), 'x'.repeat(LIMITS.libraryQueryChars)).hits).toEqual([]);
  });

  it('returns only scored entities, one best snippet each, at most ten, with stable ties', () => {
    const input = data();
    for (let i = 14; i >= 0; i--) { const id = `id-${String(i).padStart(2, '0')}`; input.documents[id] = document(id, 'needle\n'.repeat(600)); }
    input.documents.no = document('no', 'irrelevant');
    const first = searchLibrary(input, 'needle');
    expect(first.hits.map(hit => hit.id)).toEqual(Array.from({ length: 10 }, (_, i) => `id-${String(i).padStart(2, '0')}`));
    expect(first.hits.every(hit => hit.score > 0 && Number.isFinite(hit.score) && hit.excerpt.length <= 900)).toBe(true);
    input.documents = Object.fromEntries(Object.entries(input.documents).reverse());
    expect(searchLibrary(input, 'needle')).toEqual(first);
  });

  it('chunks a single long line without losing Unicode or boundary-spanning words', () => {
    const input = data();
    input.documents.a = document('a', 'prefix\n' + '😀'.repeat(2_000) + 'boundaryneedle 最末命中');
    const hit = searchLibrary(input, 'BOUNDARYNEEDLE').hits[0]!;
    expect(hit).toMatchObject({ startLine: 2, endLine: 2 });
    expect(hit.excerpt).toContain('boundaryneedle');
    expect(hit.excerpt.length).toBeLessThanOrEqual(900);
    expectUnicode(hit.excerpt);
    input.documents.a = document('a', ' '.repeat(894) + 'boundaryneedle' + ' '.repeat(1_000));
    expect(searchLibrary(input, 'boundaryneedle').hits[0]!.excerpt).toContain('boundaryneedle');
  });

  it('recomputes from actual content, never retaining stale snippets', () => {
    const input = data();
    input.documents.a = document('a', 'oldneedle');
    expect(searchLibrary(input, 'oldneedle').hits).toHaveLength(1);
    input.documents.a.text = 'newneedle';
    expect(searchLibrary(input, 'oldneedle').hits).toEqual([]);
    expect(searchLibrary(input, 'newneedle').hits).toHaveLength(1);
  });
});

const FULL = { maxChars: Infinity };
const summaryOf = (mode: 'full' | 'excerpt', originalChars: number, selectedChars: number, sourceCount = 1, turns = 0) => ({ mode, sourceCount, originalChars, selectedChars, originalTurns: turns, selectedTurns: turns });
const sections = (count: number, needle: (index: number) => boolean) => Array.from({ length: count }, (_, index) =>
  `## 第 ${index} 节\n${needle(index) ? `lockneedle 第 ${index} 节细节 ` : ''}${'无关背景说明。'.repeat(110)}`).join('\n');

describe('authorized task retrieval', () => {
  it('sends every source unchanged whenever the full text fits the budget', () => {
    const text = sections(12, () => false);
    const input = quiz(text);
    const before = structuredClone(input);
    const result = prepareRetrieval(freeze(input), { maxChars: JSON.stringify(text).length });
    expect(result.task).toEqual(input);
    expect(result.summary).toEqual(summaryOf('full', text.length, text.length));
    expect(input).toEqual(before);
    expect(prepareRetrieval(input, { maxChars: JSON.stringify(text).length - 3 }).summary.mode).toBe('excerpt');
  });

  it('extracts a relevant tail from every recitation query field within the budget', () => {
    for (const field of ['topic', 'learned', 'unclear', 'application'] as const) {
      const text = '无关背景\n'.repeat(2_000) + 'quartzneedle: TAIL_DETAIL';
      const input = { kind: 'extract' as const, recitation: { ...recitation, [field]: 'quartzneedle' }, sources: [source(text)] };
      const result = prepareRetrieval(freeze(input), { maxChars: 3_000 });
      expect(result.task.sources[0]!.text).toContain('TAIL_DETAIL');
      expect(result.task.sources[0]!.text).toContain('BM25 词项命中');
      expect(result.task.sources[0]!.text).toContain('原文行');
      expect(result.task.recitation).toEqual(input.recitation);
      expect(result.summary).toEqual(summaryOf('excerpt', text.length, result.task.sources[0]!.text.length));
      expect(JSON.stringify(result.task.sources[0]!.text).length - 2).toBeLessThanOrEqual(3_000);
      expect(prepareRetrieval(input, { maxChars: 3_000 })).toEqual(result);
    }
  });

  it('fills the actual budget with every matching section instead of a fixed two-chunk cap', () => {
    const text = sections(24, index => [1, 2, 12, 13, 22].includes(index));
    const input = { ...quiz(text), points: [{ ...point, description: 'lockneedle' }] };
    const result = prepareRetrieval(freeze(input), { maxChars: 6_000 });
    const sent = result.task.sources[0]!.text;
    for (const index of [1, 2, 12, 13, 22]) expect(sent).toContain(`lockneedle 第 ${index} 节细节`);
    expect(sent).not.toContain('## 第 5 节');
    // Reading order is kept regardless of score order.
    expect(sent.indexOf('第 1 节细节')).toBeLessThan(sent.indexOf('第 22 节细节'));
    const larger = prepareRetrieval(input, { maxChars: 12_000 }).summary.selectedChars;
    expect(larger).toBeGreaterThan(result.summary.selectedChars);
    expect(larger).toBeLessThanOrEqual(12_000);
  });

  it('gives every matching source its best chunk before second chunks of a dominant source', () => {
    const strong = source(sections(12, () => true), 'strong');
    const weak = source(`${'无关背景说明。'.repeat(300)}\n缓存穿透 lockneedle 一次提及\n${'无关背景说明。'.repeat(300)}`, 'weak');
    const input = { ...quiz(''), points: [{ ...point, description: 'lockneedle', sourceIds: ['strong', 'weak'] }], sources: [strong, weak] };
    const result = prepareRetrieval(freeze(input), { maxChars: 3_000 });
    expect(result.task.sources[1]!.text).toContain('lockneedle 一次提及');
    expect(result.task.sources[0]!.text).toContain('lockneedle');
  });

  it('ignores follow-up turns in the query, so every request in a scope selects identical sources', () => {
    const text = sections(24, index => index % 7 === 0) + '\nanswerneedle 只在回答里出现';
    const turn = (index: number, answer: string) => ({ id: `turn-${index}`, question: 'questionneedle', answer, feedback: null, assisted: false, scopeVersion: 3 });
    const base = { kind: 'followup' as const, points: [{ ...point, description: 'lockneedle' }], sources: [source(text)] };
    const first = prepareRetrieval(freeze({ ...base, turns: [] }), { maxChars: 4_000 });
    const later = prepareRetrieval(freeze({ ...base, turns: [turn(0, 'answerneedle'), turn(1, 'answerneedle again')] }), { maxChars: 4_000 });
    expect(later.task.sources).toEqual(first.task.sources);
    expect(later.task.turns).toHaveLength(2);
    expect(later.summary).toMatchObject({ originalTurns: 2, selectedTurns: 2 });
    const sessionQuiz = prepareRetrieval({ ...quiz(text), points: base.points }, { maxChars: 4_000 });
    expect(sessionQuiz.task.sources).toEqual(first.task.sources);
    // A one-off review quiz may use its fixed recall.
    const review = prepareRetrieval({ ...quiz(text), points: base.points, recall: 'answerneedle' }, { maxChars: 4_000 });
    expect(review.task.sources[0]!.text).toContain('answerneedle 只在回答里出现');
  });

  it('leaves the exact duplicate recitation source for H2, excluding it from both character counts', () => {
    const rec = { ...recitation, learned: '原始复述'.repeat(3_000) };
    const duplicate = source(`${rec.learned}\n疑问：${rec.unclear}\n应用：${rec.application}`, 'recitation:current');
    const input = { kind: 'extract' as const, recitation: rec, sources: [duplicate, source('文档'), source('不同的历史原始复述\n'.repeat(1_000), 'recitation:old')] };
    const result = prepareRetrieval(freeze(input), { maxChars: 2_000 });
    expect(result.task.recitation).toEqual(rec);
    expect(result.task.sources[0]).toEqual(duplicate);
    expect(result.summary.sourceCount).toBe(2);
    expect(result.summary.originalChars).toBe(input.sources[1]!.text.length + input.sources[2]!.text.length);
    expect(result.summary.selectedChars).toBe(result.task.sources[1]!.text.length + result.task.sources[2]!.text.length);
    expect(result.summary.selectedChars).toBeLessThanOrEqual(2_000);
  });

  it('explicitly labels unmatched head/tail fallback without claiming a match', () => {
    const input = quiz('HEAD_BACKGROUND\n' + 'unrelated text\n'.repeat(2_000) + 'TAIL_BACKGROUND');
    const text = prepareRetrieval(input, { maxChars: 2_500 }).task.sources[0]!.text;
    expect(text).toContain('未命中检索词，仅提供有限首尾背景');
    expect(text).not.toContain('BM25 词项命中');
    expect(text).toContain('HEAD_BACKGROUND');
    expect(text).toContain('TAIL_BACKGROUND');
  });

  it('respects a UTF-8 byte budget and never splits surrogate pairs, preserving IDs and names', () => {
    const input = { ...quiz(''), sources: Array.from({ length: 14 }, (_, i) => source('😀'.repeat(5_000) + '缓存穿透 needle', `allowed-${i}`)) };
    const result = prepareRetrieval(freeze(input), { maxChars: 40_000, maxUtf8Bytes: 30_000 });
    expect(result.task.sources.map(({ id, name }) => ({ id, name }))).toEqual(input.sources.map(({ id, name }) => ({ id, name })));
    expect(result.task.points).toEqual(input.points);
    const bytes = result.task.sources.reduce((sum, item) => sum + new TextEncoder().encode(JSON.stringify(item.text)).byteLength - 2, 0);
    expect(bytes).toBeLessThanOrEqual(30_000);
    for (const item of result.task.sources) {
      expect(item.text).toContain('缓存穿透 needle');
      expectUnicode(item.text);
    }
    expect(prepareRetrieval(freeze(result.task), { maxChars: 40_000, maxUtf8Bytes: 30_000 }).task).toEqual(result.task);
  });

  it('keeps an explicit envelope for every source even when nothing fits', () => {
    const input = { ...quiz(''), sources: Array.from({ length: 100 }, (_, i) => source('background'.repeat(500), `id-${i}`)) };
    const result = prepareRetrieval(input, { maxChars: 1_000 });
    expect(result.task.sources.map(item => item.id)).toEqual(input.sources.map(item => item.id));
    expect(result.task.sources.every(item => item.text.startsWith('[来源节选：'))).toBe(true);
    expect(result.task.sources.some(item => item.text.includes('正文未发送'))).toBe(true);
  });

  it('leaves grade answers and rubrics and connection diagnostics unchanged', () => {
    const grade: AiTask = { kind: 'grade', answer: 'raw answer'.repeat(2_000), question: { knowledgeId: 'fixed', kind: 'short', prompt: 'prompt', options: [], correctIndex: null, referenceAnswer: 'formal answer', rubric: [{ id: 'fixed-rubric', description: 'fixed criteria', maxScore: 5 }], sourceIds: ['authorized'] } };
    expect(prepareRetrieval(freeze(grade), { maxChars: 0 })).toEqual({ task: grade, summary: summaryOf('full', 0, 0, 0) });
    const connection: AiTask = { kind: 'connection_test', selection: { providerId: 'offline', modelId: 'offline', authMethod: 'api_key', allowUnboundedOutput: false } };
    expect(prepareRetrieval(freeze(connection), FULL)).toEqual({ task: connection, summary: summaryOf('full', 0, 0, 0) });
  });
});

describe('old knowledge association', () => {
  const library = () => {
    const input = data();
    input.knowledge.current = knowledge('current', 'Redis 缓存穿透', '查询不存在的数据时请求打到数据库');
    input.knowledge.near = knowledge('near', '缓存击穿', '热点数据过期瞬间大量请求打到数据库');
    input.knowledge.weak = knowledge('weak', '数据库索引', 'B+ 树');
    input.knowledge.char = knowledge('char', '存', '单字重合不足以联想');
    return input;
  };
  it('requires at least three shared multi-character terms and excludes the current scope', () => {
    const related = findRelatedKnowledge(library(), 'Redis 缓存穿透：查询不存在的数据时请求打到数据库', new Set(['current']));
    expect(related.map(point => point.id)).toEqual(['near']);
  });
  it('is deterministic, bounded, and returns nothing for an empty or single-character query', () => {
    const input = library();
    for (let i = 0; i < 6; i++) input.knowledge[`copy-${i}`] = knowledge(`copy-${i}`, `缓存击穿 ${i}`, '热点数据过期瞬间大量请求打到数据库');
    const query = '缓存击穿：热点数据过期';
    expect(findRelatedKnowledge(input, query, new Set())).toHaveLength(LIMITS.relatedKnowledgeMaximum);
    expect(findRelatedKnowledge(input, query, new Set())).toEqual(findRelatedKnowledge(input, query, new Set()));
    expect(findRelatedKnowledge(input, '', new Set())).toEqual([]);
    expect(findRelatedKnowledge(input, '存', new Set())).toEqual([]);
  });
});
