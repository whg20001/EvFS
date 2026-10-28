import { LIMITS, RECITATION_DUPLICATE as DUPLICATE, recitationSourceText } from '@sanxing/contracts';
import { expandSearchTerms } from './search-terms.ts';
import { DomainError } from './policy.ts';
import type { AiTask, AppData, KnowledgePoint, LibraryHit, LibrarySearchResult, RetrievalSummary, SourceInput } from '@sanxing/contracts';

const STOP = new Set('a an and are as at be been but by for from in is it of on or that the this to was were with you your 的 了 是 在 和 与 及 或 我 你 他 她 它 们 这 那 有 也 就 都 而'.split(' '));
const EXCERPT = '[来源节选：';
const MATCH = `${EXCERPT}超出输入预算，按本地 BM25 词项命中选段；未展示内容已省略。]\n`;
const FALLBACK = `${EXCERPT}超出输入预算且未命中检索词，仅提供有限首尾背景；不代表相关命中或已阅读全文。]\n`;

/** Lexical retrieval only: no embeddings, stemming or synonym/semantic guarantees. */
function tokens(text: string): string[] {
  const result: string[] = [];
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    if (/^\p{Script=Han}/u.test(match[0])) {
      const chars = Array.from(match[0]);
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        if (STOP.has(char)) continue;
        result.push(char);
        const next = chars[i + 1];
        if (next && !STOP.has(next)) result.push(char + next);
      }
    } else if (!STOP.has(match[0])) result.push(match[0]);
  }
  return result;
}

interface Chunk { text: string; startLine: number; endLine: number; partialLine: boolean }

/** UTF-16 budgets, but never cut a valid surrogate pair. */
function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) return end - 1;
  return end;
}

function chunks(text: string, cap: number = LIMITS.retrievalChunkChars): Chunk[] {
  const result: Chunk[] = [];
  let pending: Chunk | undefined;
  const flush = () => { if (pending) result.push(pending); pending = undefined; };
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    const number = index + 1;
    if (line.length > cap) {
      flush();
      for (let start = 0; start < line.length;) {
        const end = safeEnd(line, Math.min(line.length, start + cap));
        result.push({ text: line.slice(start, end), startLine: number, endLine: number, partialLine: true });
        if (end === line.length) break;
        // Overlap long-line windows so boundary-spanning words remain searchable.
        start = safeEnd(line, end - Math.min(120, Math.floor(cap / 4)));
      }
    } else {
      if (pending && pending.text.length + 1 + line.length > cap) flush();
      if (pending) { pending.text += '\n' + line; pending.endLine = number; }
      else pending = { text: line, startLine: number, endLine: number, partialLine: false };
    }
  }
  flush();
  return result;
}

/** Request-local index: no retained snippets or potentially stale cross-request cache. */
function bm25Detailed(texts: string[], query: string | string[]): { score: number; matched: number }[] {
  const terms = [...new Set(typeof query === 'string' ? tokens(query) : query)];
  if (!terms.length || !texts.length) return texts.map(() => ({ score: 0, matched: 0 }));
  const wanted = new Set(terms);
  const df = new Map<string, number>();
  const entries = texts.map(text => {
    const words = tokens(text);
    const frequency = new Map<string, number>();
    for (const word of words) if (wanted.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    for (const word of frequency.keys()) df.set(word, (df.get(word) ?? 0) + 1);
    return { length: words.length, frequency };
  });
  const average = entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length || 1;
  return entries.map(entry => {
    let score = 0;
    for (const [term, frequency] of entry.frequency) {
      const count = df.get(term)!;
      const idf = Math.log(1 + (entries.length - count + 0.5) / (count + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * entry.length / average));
    }
    return { score, matched: entry.frequency.size };
  });
}
const bm25 = (texts: string[], query: string | string[]) => bm25Detailed(texts, query).map(item => item.score);

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Search all archived documents and confirmed knowledge, not just the active session. */
export function searchLibrary(data: Pick<AppData, 'revision' | 'documents' | 'knowledge'>, query: string, kind?: 'document' | 'knowledge', options: { offset?: number; limit?: number; includeUnderstanding?: boolean; expandTerms?: boolean; expectedRevision?: number } = {}): LibrarySearchResult {
  const offset = options.offset ?? 0; const limit = options.limit ?? LIMITS.libraryPageSize;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.libraryPageSizeMaximum) throw new RangeError('Invalid search page');
  if (options.expectedRevision !== undefined && options.expectedRevision !== data.revision) throw new DomainError('SEARCH_CHANGED', '资料库已更新，请重新搜索后翻页', 409);
  if (query.length > LIMITS.libraryQueryChars) throw new RangeError(`Library query exceeds ${LIMITS.libraryQueryChars} characters`);
  const normalized = query.normalize('NFKC').toLowerCase().trim();
  const expandedTerms = options.expandTerms ? expandSearchTerms(normalized) : [];
  const response: LibrarySearchResult = { hits: [], strategy: options.expandTerms ? 'local-bm25-terms-v1' : 'local-bm25-v1', query: normalized, total: 0, offset, nextOffset: null, revision: data.revision, expandedTerms };
  if (!tokens(normalized).length) return response;
  const entities: { kind: LibraryHit['kind']; id: string; title: string; text: string; contentVersion: number | null; field: 'content' | 'understanding' }[] = [];
  if (kind !== 'knowledge') for (const document of Object.values(data.documents)) {
    entities.push({ kind: 'document', id: document.id, title: document.name, text: document.text, contentVersion: null, field: 'content' });
  }
  if (kind !== 'document') for (const point of Object.values(data.knowledge).filter(point => !point.archivedAt)) {
    // Legacy scheduling/version counters are not content versions.
    entities.push({ kind: 'knowledge', id: point.id, title: point.title, text: `${point.title}\n${point.description}`, contentVersion: point.contentVersion ?? null, field: 'content' });
    if (options.includeUnderstanding && point.understanding.trim()) entities.push({ kind: 'knowledge', id: point.id, title: point.title, text: point.understanding, contentVersion: null, field: 'understanding' });
  }
  entities.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  const candidates = entities.flatMap(entity => chunks(entity.text).map(chunk => ({ entity, chunk })));
  const scores = bm25(candidates.map(({ entity, chunk }) => `${entity.title}\n${chunk.text}`), [normalized, ...expandedTerms].join(' '));
  const best = new Map<string, LibraryHit>();
  candidates.forEach(({ entity, chunk }, index) => {
    const score = scores[index]!;
    if (score <= 0) return;
    const key = `${entity.kind}:${entity.id}`;
    if ((best.get(key)?.score ?? 0) >= score) return;
    best.set(key, { kind: entity.kind, id: entity.id, title: entity.title, excerpt: chunk.text, score, startLine: chunk.startLine, endLine: chunk.endLine, contentVersion: entity.contentVersion, field: entity.field, ...(entity.kind === 'document' && data.documents[entity.id]?.import?.format === 'pdf' ? { pages: (data.documents[entity.id]!.import as import('@sanxing/contracts').PdfImport).pages.filter(page => page.startLine <= chunk.endLine && page.endLine >= chunk.startLine).map(page => page.page) } : {}) });
  });
  response.total = best.size;
  response.nextOffset = offset + limit < best.size ? offset + limit : null;
  response.hits = [...best.values()].sort((a, b) => b.score - a.score || compare(a.kind, b.kind) || compare(a.id, b.id) || a.startLine - b.startLine).slice(offset, offset + limit);
  return response;
}

/** Rank only already-authorized sources before applying the model's source-count cap. */
export function selectRelevantSources(sources: SourceInput[], query: string, limit: number): SourceInput[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid source limit');
  if (sources.length <= limit) return [...sources];
  const windows = sources.flatMap((source, index) => chunks(source.text).map(chunk => ({ index, text: `${source.name}\n${chunk.text}` })));
  const scores = bm25(windows.map(window => window.text), query);
  const best = sources.map(() => 0);
  windows.forEach((window, index) => { best[window.index] = Math.max(best[window.index]!, scores[index]!); });
  return sources.map((source, index) => ({ source, score: best[index]! }))
    .sort((a, b) => b.score - a.score || compare(a.source.id, b.source.id)).slice(0, limit).map(item => item.source);
}

/** Serialized cost of a string value inside the JSON payload (escapes included, quotes excluded). */
function cost(text: string): { chars: number; bytes: number } {
  const json = JSON.stringify(text);
  return { chars: json.length - 2, bytes: new TextEncoder().encode(json).byteLength - 2 };
}

/** Room for all source `text` values, measured as escaped JSON. Bytes are optional (mock has no window). */
export interface RetrievalBudget { maxChars: number; maxUtf8Bytes?: number }

const EMPTY = `${EXCERPT}输入预算不足，此来源正文未发送；完整原文仍已保存。]`;
const block = (chunk: Chunk) => `[原文行 ${chunk.startLine}-${chunk.endLine}${chunk.partialLine ? '，行内节选' : ''}]\n${chunk.text}\n`;

/** Stable query: never the latest turn, so every request in one scope selects the same sources. */
function retrievalQuery(task: Extract<AiTask, { kind: 'extract' | 'followup' | 'quiz' }>): string {
  if (task.kind === 'extract') return [task.recitation.topic, task.recitation.learned, task.recitation.unclear, task.recitation.application].join('\n');
  const points = task.points.map(point => `${point.title}\n${point.description}`).join('\n');
  // A review quiz is a one-off request: its recall is a fixed input, not a moving conversation turn.
  return task.kind === 'quiz' ? [points, task.recall, ...(task.weaknesses ?? []).flatMap(item => [item.question, ...item.weakAreas])].filter(Boolean).join('\n') : points;
}

/**
 * Full text first: when every source fits the budget, nothing changes. Otherwise rank all chunks
 * globally and fill greedily: each matching source first gets its best chunk, then the best
 * remaining chunks, then head/tail background for sources without a match.
 * Only call for a new queue/preview; retries reuse the frozen prepared task. Recognized excerpt
 * envelopes are kept as-is (line numbers are never re-indexed). H2 still owns the final budget.
 */
export function prepareRetrieval<T extends AiTask>(input: T, budget: RetrievalBudget): { task: T; summary: RetrievalSummary } {
  const task = structuredClone(input);
  const summary: RetrievalSummary = { mode: 'full', sourceCount: 0, originalChars: 0, selectedChars: 0, originalTurns: 0, selectedTurns: 0 };
  if (task.kind === 'grade' || task.kind === 'connection_test') return { task, summary };
  if (task.kind === 'followup' || (task.kind === 'quiz' && task.turns !== undefined)) summary.originalTurns = summary.selectedTurns = task.turns?.length ?? 0;
  const recitationText = task.kind === 'extract' ? recitationSourceText(task.recitation) : null;
  const sources = task.sources.filter(source => !(recitationText !== null && source.id.startsWith('recitation:') && (source.text === recitationText || source.text === DUPLICATE)));
  summary.sourceCount = sources.length;
  summary.originalChars = summary.selectedChars = sources.reduce((sum, source) => sum + source.text.length, 0);
  const maxChars = Math.max(0, Math.floor(budget.maxChars));
  const maxBytes = budget.maxUtf8Bytes === undefined ? Infinity : Math.max(0, Math.floor(budget.maxUtf8Bytes));
  const used = { chars: 0, bytes: 0 };
  const add = (delta: { chars: number; bytes: number }) => { used.chars += delta.chars; used.bytes += delta.bytes; };
  const fits = (delta: { chars: number; bytes: number }) => used.chars + delta.chars <= maxChars && used.bytes + delta.bytes <= maxBytes;
  for (const source of sources) add(cost(source.text));
  if (used.chars <= maxChars && used.bytes <= maxBytes) return { task, summary };
  summary.mode = 'excerpt';
  used.chars = used.bytes = 0;
  const pending = sources.filter(source => !source.text.startsWith(EXCERPT));
  for (const source of sources) if (source.text.startsWith(EXCERPT)) add(cost(source.text));
  const groups = pending.map(source => chunks(source.text));
  const flat = groups.flatMap((group, sourceIndex) => group.map((chunk, index) => ({ sourceIndex, index, chunk })));
  const scores = bm25(flat.map(item => item.chunk.text), retrievalQuery(task));
  const ranked = flat.map((item, order) => ({ ...item, score: scores[order]!, order })).sort((a, b) => b.score - a.score || a.order - b.order);
  const hit = pending.map((_, sourceIndex) => ranked.some(item => item.sourceIndex === sourceIndex && item.score > 0));
  // Every source keeps an explicit envelope: nothing is silently removed, even when no chunk fits.
  const empty = cost(EMPTY);
  const headers = { match: cost(MATCH), fallback: cost(FALLBACK) };
  pending.forEach(() => add(empty));
  const selected = pending.map(() => new Set<number>());
  // Neighbour widening retries the same chunks; serialize each block once.
  const blockCosts = groups.map(group => new Array<{ chars: number; bytes: number } | undefined>(group.length));
  const take = (item: { sourceIndex: number; index: number; chunk: Chunk }) => {
    const chosen = selected[item.sourceIndex]!;
    if (chosen.has(item.index)) return;
    const blockCost = blockCosts[item.sourceIndex]![item.index] ??= cost(block(item.chunk));
    const header = hit[item.sourceIndex] ? headers.match : headers.fallback;
    const delta = chosen.size ? blockCost : { chars: blockCost.chars + header.chars - empty.chars, bytes: blockCost.bytes + header.bytes - empty.bytes };
    if (fits(delta)) { chosen.add(item.index); add(delta); }
  };
  const matches = ranked.filter(item => item.score > 0);
  const firsts = new Set<number>();
  for (const item of matches) if (!firsts.has(item.sourceIndex)) { firsts.add(item.sourceIndex); take(item); }
  for (const item of matches) take(item);
  // Spare budget widens context around matches, nearest neighbours first, rather than staying unused.
  const anchors = pending.map((_, sourceIndex) => [...selected[sourceIndex]!]);
  const widest = Math.max(0, ...groups.map(group => group.length));
  for (let distance = 1; distance < widest; distance++) {
    groups.forEach((group, sourceIndex) => {
      for (const anchor of anchors[sourceIndex]!) for (const index of [anchor - distance, anchor + distance]) {
        if (index >= 0 && index < group.length) take({ sourceIndex, index, chunk: group[index]! });
      }
    });
  }
  // Unmatched sources only receive limited head/tail background after all matches.
  groups.forEach((group, sourceIndex) => {
    if (hit[sourceIndex] || !group.length) return;
    take({ sourceIndex, index: 0, chunk: group[0]! });
    if (group.length > 1) take({ sourceIndex, index: group.length - 1, chunk: group.at(-1)! });
  });
  pending.forEach((source, sourceIndex) => {
    const group = groups[sourceIndex]!;
    const chosen = [...selected[sourceIndex]!].sort((a, b) => a - b);
    if (!chosen.length) source.text = EMPTY;
    // All chunks chosen: the original is exact and cheaper than markers.
    else if (chosen.length === group.length) return;
    else source.text = (hit[sourceIndex] ? MATCH : FALLBACK) + chosen.map(index => block(group[index]!)).join('');
  });
  summary.selectedChars = sources.reduce((sum, source) => sum + source.text.length, 0);
  return { task, summary };
}

/**
 * Old knowledge that shares at least three multi-character terms with the query. Single Han
 * characters are too noisy, and one shared word already yields two overlapping bigrams
 * (数据库 → 数据, 据库), so fewer matches do not justify a combination. Lexical only.
 */
export function findRelatedKnowledge(data: AppData, query: string, exclude: ReadonlySet<string>, limit: number = LIMITS.relatedKnowledgeMaximum): KnowledgePoint[] {
  const terms = [...new Set(tokens(query.slice(0, LIMITS.modelInputChars)))].filter(term => Array.from(term).length >= 2);
  if (!terms.length || limit < 1) return [];
  const candidates = Object.values(data.knowledge).filter(point => !point.archivedAt && !exclude.has(point.id)).sort((a, b) => compare(a.id, b.id));
  const scores = bm25Detailed(candidates.map(point => `${point.title}\n${point.description}`), terms);
  return candidates.map((point, index) => ({ point, ...scores[index]! }))
    .filter(item => item.matched >= 3 && item.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.point.id, b.point.id)).slice(0, limit).map(item => item.point);
}
