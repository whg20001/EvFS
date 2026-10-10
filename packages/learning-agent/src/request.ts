import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LIMITS, learningOutputSchema, prepareTaskContext, type AiTask, type GeneratedQuestion, type Usage } from '@sanxing/contracts';

/** Failures never imply zero cost. The host must retain reservations for unknown usage. */
export class LearningEngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly usage: Usage | null = null) {
    super(message);
    this.name = 'LearningEngineError';
  }
}

export interface LearningRequestOptions {
  /** Omit only for mock. Live callers must use the explicit Provider model directory. */
  contextWindow?: number;
  maxOutputTokens: number;
}
export interface PreparedLearningRequest<T extends AiTask = AiTask> {
  task: T;
  originalChars: number;
  sentChars: number;
  truncated: boolean;
  fields: { path: string; originalChars: number; sentChars: number; truncated: boolean }[];
  systemPrompt: string;
  /** Exactly what is sent: one user message whose text blocks are stable scope context, then task input. */
  blocks: string[];
  /** blocks joined for measurement and diagnostics. */
  prompt: string;
  contextWindow: number | null;
  /** UTF-8 bytes of the complete system + user prompts: a conservative planning estimate, not exact tokens. */
  estimatedInputTokens: number;
  /** Planning reserve only; does not create a Provider/OAuth output or cost guarantee. */
  outputReserveTokens: number;
  safetyMarginTokens: number;
  /** Total input allowance after output reserve and message/Provider adaptation margin. */
  remainingInputTokens: number | null;
}

export const INPUT_SAFETY_MARGIN_TOKENS = 512;
/** Connection probes never reserve more output than this, whatever the configured limit. */
export const CONNECTION_TEST_OUTPUT_TOKENS = 256;
const prompts = Object.fromEntries(['common', 'scope', 'extract', 'followup', 'quiz', 'grade', 'connection_test'].map(name => [name, readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8')]));
const contracts = Object.fromEntries(learningOutputSchema.options.map(schema => [schema.shape.kind.value, JSON.stringify(z.toJSONSchema(schema))]));
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
// Follow-ups and quizzes in one scope share a byte-identical system prompt, so a cached prefix can be reused.
const systemPrompts: Record<Exclude<AiTask['kind'], 'connection_test'>, string> = {
  extract: `${prompts.common}\n${prompts.extract}\n输出 JSON Schema：${contracts.extract}`,
  followup: `${prompts.common}\n${prompts.scope}\n${prompts.followup}\n${prompts.quiz}\n输出 JSON Schema（kind=followup）：${contracts.followup}\n输出 JSON Schema（kind=quiz）：${contracts.quiz}`,
  quiz: '',
  grade: `${prompts.common}\n${prompts.grade}\n输出 JSON Schema：${contracts.grade}`,
};
systemPrompts.quiz = systemPrompts.followup;
/** Splitting the payload into two blocks can add a few JSON delimiters beyond the merged measurement. */
const BLOCK_SLACK = 16;
const failTooLarge = (): never => { throw new LearningEngineError('MODEL_INPUT_TOO_LARGE', '系统提示、输出预留、固定评分标准、正式答案或任务内容超过模型输入预算；未发送模型请求。'); };

function validateOptions(options: LearningRequestOptions) {
  if (!options || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 16_384 ||
    (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow < 1))) {
    throw new LearningEngineError('INVALID_CONFIG', '模型上下文窗口或输出预算配置无效');
  }
}

function modelPayload<T extends AiTask>(task: T): T {
  // One projection for preparation, measurement and sending. Sorting copies never changes the
  // caller's source array or the explicitly chosen point order.
  if ('sources' in task) {
    const sources = task.sources.map(({ id, name, text }) => ({ id, name, text }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (task.kind === 'extract') return { kind: task.kind, sources, recitation: task.recitation } as T;
    const points = task.points.map(({ id, title, description, sourceIds }) => ({ id, title, description, sourceIds }));
    const related = task.related?.length ? { related: task.related.map(({ id, title, description }) => ({ id, title, description })) } : {};
    if (task.kind === 'followup') return { kind: task.kind, sources, points, ...related, turns: task.turns } as T;
    return { kind: task.kind, sources, points, ...related, count: task.count, ...(task.recall !== undefined ? { recall: task.recall } : {}), ...(task.code ? { code: task.code } : {}) } as T;
  }
  if (task.kind === 'grade') {
    const { id: _id, knowledgeVersion: _version, relatedKnowledgeIds: _related, ...question } = task.question as GeneratedQuestion & { id?: string; knowledgeVersion?: number | null };
    return { kind: task.kind, question, answer: task.answer, ...(task.execution ? { execution: task.execution } : {}) } as T;
  }
  return task;
}

/** Stable scope context first (sources, points, related), then the per-request task input. */
function payloadBlocks(payload: AiTask): string[] {
  if (payload.kind === 'extract') return [JSON.stringify({ sources: payload.sources }), JSON.stringify({ kind: payload.kind, recitation: payload.recitation })];
  if (payload.kind === 'followup' || payload.kind === 'quiz') {
    const { kind, sources, points, related, ...rest } = payload;
    return [JSON.stringify({ sources, points, ...(related ? { related } : {}) }), JSON.stringify({ kind, ...rest })];
  }
  return [JSON.stringify(payload)];
}

/** Pure offline measurement. Never excerpts or rejects an oversized task; check is the enforcing API. */
export function inspectLearningRequest<T extends AiTask>(task: T, options: LearningRequestOptions): PreparedLearningRequest<T> {
  validateOptions(options);
  const connection = task.kind === 'connection_test';
  // Content versions are host provenance, not model input. Probe selection is never serialized.
  const blocks = connection ? ['Connection test. Return {"kind":"connection_test","ok":true} only.'] : payloadBlocks(modelPayload(task));
  const prompt = blocks.join('\n');
  const systemPrompt = connection ? prompts.connection_test! : systemPrompts[task.kind];
  const contextWindow = options.contextWindow ?? null;
  const outputReserveTokens = connection ? Math.min(options.maxOutputTokens, CONNECTION_TEST_OUTPUT_TOKENS) : options.maxOutputTokens;
  const originalChars = JSON.stringify(task).length;
  return { task, originalChars, sentChars: originalChars, truncated: false, fields: [], systemPrompt, blocks, prompt, contextWindow,
    estimatedInputTokens: bytes(systemPrompt) + bytes(prompt), outputReserveTokens, safetyMarginTokens: INPUT_SAFETY_MARGIN_TOKENS,
    remainingInputTokens: contextWindow === null ? null : contextWindow - outputReserveTokens - INPUT_SAFETY_MARGIN_TOKENS };
}

/** Final enforcement, without changing task/prompt. Direct engine callers must prepare beforehand. */
export function checkLearningRequest<T extends AiTask>(task: T, options: LearningRequestOptions): PreparedLearningRequest<T> {
  const request = inspectLearningRequest(task, options);
  if (request.prompt.length > LIMITS.modelInputChars) throw new LearningEngineError('INPUT_LIMIT', '任务上下文超出字符限额');
  if (request.remainingInputTokens !== null && request.estimatedInputTokens > request.remainingInputTokens) failTooLarge();
  return request;
}

/** Whether the task fits unchanged; configuration errors still throw. */
export function fitsLearningRequest(task: AiTask, options: LearningRequestOptions): boolean {
  try { checkLearningRequest(task, options); return true; } catch (error) {
    if (error instanceof LearningEngineError && (error.code === 'INPUT_LIMIT' || error.code === 'MODEL_INPUT_TOO_LARGE')) return false;
    throw error;
  }
}

/** Pure offline preparation. The returned task must be persisted and then passed unchanged to execute. */
export function prepareLearningRequest<T extends AiTask>(task: T, options: LearningRequestOptions): PreparedLearningRequest<T> {
  const original = inspectLearningRequest(task, options);
  if (task.kind === 'connection_test') return checkLearningRequest(task, options);
  const availableBytes = original.remainingInputTokens === null ? undefined : original.remainingInputTokens - bytes(original.systemPrompt) - BLOCK_SLACK;
  if (availableBytes !== undefined && availableBytes <= 0) failTooLarge();
  // Budget the actual upstream payload, not host provenance. Restore that provenance below
  // so the persisted task keeps its version bindings without paying a phantom input budget.
  // The exact split prompt already fits: never excerpt because of the merged measurement's slack.
  const fitsAsIs = fitsLearningRequest(task, options);
  let prepared: ReturnType<typeof prepareTaskContext<T>>;
  try {
    prepared = prepareTaskContext(modelPayload(task), fitsAsIs ? {} : { maxChars: LIMITS.modelInputChars - BLOCK_SLACK,
      ...(availableBytes === undefined ? {} : { maxUtf8Bytes: availableBytes }) });
    // The merged measurement can exceed the split prompt by a few delimiters at the exact boundary.
    if (fitsAsIs && prepared.truncated) prepared = { ...prepared, task: modelPayload(task), truncated: false, sentChars: prepared.originalChars,
      fields: prepared.fields.map(field => ({ ...field, sentChars: field.originalChars, truncated: false })) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'MODEL_INPUT_TOO_LARGE') failTooLarge();
    throw error;
  }
  if ('points' in prepared.task && 'points' in task) {
    const originals = new Map(task.points.map(point => [point.id, point]));
    prepared.task.points = prepared.task.points.map(point => ({ ...originals.get(point.id), ...point }));
    if ('related' in prepared.task && prepared.task.related && 'related' in task && task.related) {
      const related = new Map(task.related.map(point => [point.id, point]));
      prepared.task.related = prepared.task.related.map(point => ({ ...related.get(point.id)!, ...point }));
    }
  }
  if (prepared.task.kind === 'grade' && task.kind === 'grade') prepared.task.question = { ...task.question, ...prepared.task.question };
  const checked = checkLearningRequest(prepared.task, options);
  return { ...checked, originalChars: original.originalChars, truncated: prepared.truncated, fields: prepared.fields };
}
