import { RECITATION_DUPLICATE as DUPLICATE, recitationSourceText, type AiTask, type PointInput, type RecitationInput, type SourceInput } from './index.ts';
import { LIMITS } from './limits.ts';

const CUT = '\n[上下文节选：其余内容未发送，完整原文仍已保存。]';
const GAP = '\n[中间内容已节选]\n';
const encoder = new TextEncoder();

/** Never introduce lone surrogates when a window cuts through a Unicode character. */
function safeSlice(text: string, start: number, end: number): string {
  const high = (index: number) => text.charCodeAt(index) >= 0xd800 && text.charCodeAt(index) <= 0xdbff;
  const low = (index: number) => text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (low(start) && high(start - 1)) start++;
  if (high(end - 1) && low(end)) end--;
  return text.slice(start, Math.max(start, end));
}

/** Literal windows, not a summary or RAG. The cap counts payload; markers are budgeted separately. */
function excerpt(text: string, cap: number, centers = [0, Math.floor(text.length / 2), text.length]): string {
  if (text.length <= cap) return text;
  const ranges: [number, number][] = [];
  centers.forEach((center, index) => {
    const size = Math.floor(cap / centers.length) + (index < cap % centers.length ? 1 : 0);
    if (!size) return;
    const start = Math.max(0, Math.min(text.length - size, center - Math.floor(size / 2)));
    ranges.push([start, start + size]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const selected = merged.map(([start, end]) => safeSlice(text, start, end)).filter(Boolean).join(GAP) + CUT;
  // Keeping a short original can cost less than marking an omission (including JSON escaping).
  if (text.length <= selected.length) {
    const originalJson = JSON.stringify(text);
    const selectedJson = JSON.stringify(selected);
    if (originalJson.length <= selectedJson.length && encoder.encode(originalJson).byteLength <= encoder.encode(selectedJson).byteLength) return text;
  }
  return selected;
}

/** Deterministic title-lexical anchors, without claiming omitted text is irrelevant. */
function relatedCenters(text: string, points: PointInput[]): number[] | undefined {
  const terms = [...new Set(points.flatMap(point => {
    const title = point.title.toLowerCase();
    const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
    const pairs = [...title].flatMap((char, index, all) => /\p{Script=Han}/u.test(char) && all[index + 1] ? [char + all[index + 1]] : []);
    return [...words, ...pairs];
  }))].slice(0, 24);
  const lower = text.toLowerCase();
  const matches = terms.map(term => ({ start: lower.indexOf(term), length: term.length })).filter(match => match.start >= 0).sort((a, b) => a.start - b.start);
  const merged: [number, number][] = [];
  for (const { start, length } of matches) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], start + length);
    else merged.push([start, start + length]);
  }
  // Overlapping title words/bigrams describe one anchor, not competing shares of the cap.
  return merged.length ? merged.map(([start, end]) => Math.floor((start + end) / 2)) : undefined;
}

export interface PreparedContext<T extends AiTask> {
  task: T;
  originalChars: number;
  sentChars: number;
  /** True only when text in the current scope was excerpted, not when redundant sources were removed. */
  truncated: boolean;
  /** Length-only diagnostics: no copies of the original text. Paths use source/point/turn IDs. */
  fields: { path: string; originalChars: number; sentChars: number; truncated: boolean }[];
}

/** Copies only. IDs, titles, grading rubrics and formal answers are never shortened or rewritten. */
export function prepareTaskContext<T extends AiTask>(input: T, budget: { maxChars?: number; maxUtf8Bytes?: number } = {}): PreparedContext<T> {
  const tooLarge = () => Object.assign(new Error('固定评分标准、正式答案或任务元数据超过模型输入上限；未发送模型请求。'), { code: 'MODEL_INPUT_TOO_LARGE' });
  const maxChars = Math.min(LIMITS.modelInputChars, Math.max(0, Math.floor(budget.maxChars ?? LIMITS.modelInputChars)));
  const maxUtf8Bytes = Math.max(0, Math.floor(budget.maxUtf8Bytes ?? Infinity));
  if (Number.isNaN(maxChars) || Number.isNaN(maxUtf8Bytes)) throw tooLarge();
  const originalChars = JSON.stringify(input).length;
  const task = structuredClone(input);
  const fields: { path: string; original: string; sent: string; set: (value: string) => void; centers?: () => number[] | undefined }[] = [];
  const field = (path: string, original: string, set: (value: string) => void, centers?: () => number[] | undefined) => fields.push({ path, original, sent: original, set, centers });
  if (task.kind === 'extract') {
    const recitationText = recitationSourceText(task.recitation);
    for (const key of ['learned', 'unclear', 'application'] as const) {
      field(`recitation.${key}`, task.recitation[key], value => { task.recitation[key] = value; });
    }
    for (const source of task.sources) {
      if (source.id.startsWith('recitation:') && (source.text === recitationText || source.text === DUPLICATE)) {
        // Keep the source ID usable as evidence, without counting duplicate removal as content loss.
        source.text = DUPLICATE;
      } else field(`sources.${source.id}.text`, source.text, value => { source.text = value; });
    }
  } else if (task.kind === 'followup' || task.kind === 'quiz') {
    // Defense in depth: never send an unrelated source even if a caller supplied it.
    const referenced = new Set(task.points.flatMap(point => point.sourceIds));
    task.sources = task.sources.filter(source => referenced.has(source.id));
    for (const source of task.sources) {
      field(`sources.${source.id}.text`, source.text, value => { source.text = value; }, () => relatedCenters(source.text, task.points.filter(point => point.sourceIds.includes(source.id))));
    }
    for (const point of task.points) field(`points.${point.id}.description`, point.description, value => { point.description = value; });
    for (const point of task.related ?? []) field(`related.${point.id}.description`, point.description, value => { point.description = value; });
    if (task.kind === 'quiz' && task.recall !== undefined) field('recall', task.recall, value => { task.recall = value; });
    for (const turn of task.turns ?? []) {
      field(`turns.${turn.id}.question`, turn.question, value => { turn.question = value; });
      // Practice answers may be excerpted; grade.answer below never is.
      if (turn.answer !== null) field(`turns.${turn.id}.answer`, turn.answer, value => { turn.answer = value; });
      if (turn.feedback !== null) field(`turns.${turn.id}.feedback`, turn.feedback, value => { turn.feedback = value; });
    }
  }
  const fits = (json: string) => json.length <= maxChars && (maxUtf8Bytes === Infinity || encoder.encode(json).byteLength <= maxUtf8Bytes);
  let json = JSON.stringify(task);
  // Do not pre-excerpt: all current-scope text is retained whenever both total budgets permit it.
  if (!fits(json)) {
    const centers = fields.map(item => item.centers?.());
    const apply = (cap: number) => {
      fields.forEach((item, index) => {
        item.sent = excerpt(item.original, cap, centers[index]);
        item.set(item.sent);
      });
      return JSON.stringify(task);
    };
    if (!fits(apply(0))) throw tooLarge();
    let low = 0;
    let high = Math.min(maxChars, fields.reduce((max, item) => Math.max(max, item.original.length), 0));
    // A shared payload cap fairly redistributes space from short fields to longer fields.
    // Marker/escaping/Unicode boundaries can have small discontinuities; only tested fits are accepted.
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(apply(middle))) low = middle;
      else high = middle - 1;
    }
    json = apply(low);
    if (!fits(json)) throw tooLarge();
  }
  const diagnostics = fields.map(item => ({ path: item.path, originalChars: item.original.length, sentChars: item.sent.length, truncated: item.sent !== item.original }));
  return { task, originalChars, sentChars: json.length, truncated: diagnostics.some(item => item.truncated), fields: diagnostics };
}

/** Pass the same sources (including any recitation source) as an extract task. */
export function previewRecitationContext(input: RecitationInput, sources: SourceInput[]): PreparedContext<Extract<AiTask, { kind: 'extract' }>> {
  return prepareTaskContext({ kind: 'extract', recitation: input, sources });
}
