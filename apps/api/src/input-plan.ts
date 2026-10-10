import { LIMITS, type AiTask, type RetrievalSummary } from '@sanxing/contracts';
import { fitsLearningRequest as fits, inspectLearningRequest, type LearningRequestOptions } from '@sanxing/learning-agent';
import { prepareRetrieval } from '@sanxing/learning-domain';

/** Covers block delimiters and the shared-cut guard in the final H2 preparation. */
const SLACK = 32;
type Followup = Extract<AiTask, { kind: 'followup' }>;
const OMITTED = '[较早作答已省略，以保持本范围资料不变；完整记录仍已保存。]';

/** Room left for source texts beside a task whose sources are blank. Source costs add up exactly. */
function room(skeleton: AiTask, options: LearningRequestOptions): { chars: number; bytes?: number } {
  const measured = inspectLearningRequest(skeleton, options);
  return { chars: LIMITS.modelInputChars - measured.prompt.length - SLACK,
    ...(measured.remainingInputTokens === null ? {} : { bytes: measured.remainingInputTokens - measured.estimatedInputTokens - SLACK }) };
}
const budget = (space: { chars: number; bytes?: number }, reserve = { chars: 0, bytes: 0 }) =>
  ({ maxChars: space.chars - reserve.chars, ...(space.bytes === undefined ? {} : { maxUtf8Bytes: space.bytes - reserve.bytes }) });

/**
 * Pure offline planning before H2: send full text whenever it fits; otherwise retrieve against
 * the space actually left for sources. Follow-ups and the session quiz measure one canonical
 * scope skeleton with a fixed dynamic reserve, so every request in a scope gets identical sources
 * (a stable, cacheable prefix) regardless of how many turns exist. Retries reuse the frozen task.
 */
export function planLearningInput<T extends AiTask>(input: T, options: LearningRequestOptions): { task: T; summary: RetrievalSummary } {
  if (input.kind === 'grade' || input.kind === 'connection_test') return prepareRetrieval(input, { maxChars: Infinity });
  const scope = input.kind === 'followup' || (input.kind === 'quiz' && input.recall === undefined);
  const sources = input.sources.map(source => ({ ...source, text: '' }));
  const skeleton: AiTask = scope
    ? { kind: 'followup', points: input.points as Followup['points'], sources, turns: [], ...('related' in input && input.related?.length ? { related: input.related } : {}) }
    : { ...input, sources } as AiTask;
  const space = room(skeleton, options);
  // Deterministic for a given scope/model: never depends on the current turns.
  const reserve = scope ? {
    chars: Math.min(LIMITS.modelDynamicReserveChars, Math.floor(Math.max(0, space.chars) / 4)),
    bytes: space.bytes === undefined ? 0 : Math.min(LIMITS.modelDynamicReserveChars * 3, Math.floor(Math.max(0, space.bytes) / 4)),
  } : undefined;
  let retrieval = prepareRetrieval(input, budget(space, reserve));
  if (retrieval.task.kind === 'followup') {
    const task: Followup = retrieval.task;
    // Over the reserve: drop older answers/feedback first (latest turn intact) instead of re-cutting sources.
    for (let index = 0; index < task.turns.length - 1 && !fits(task, options); index++) {
      const turn = task.turns[index]!;
      if (turn.answer !== null && turn.answer.length > OMITTED.length) turn.answer = OMITTED;
      if (turn.feedback !== null && turn.feedback.length > OMITTED.length) turn.feedback = OMITTED;
    }
    // The latest turn alone exceeds the reserve (small windows, very long answers): re-select
    // sources for this request only, against the exact room left beside these turns. One
    // prefix-cache miss is better than H2 cutting every source evenly or excerpting the newest answer.
    if (!fits(task, options)) retrieval = prepareRetrieval({ ...input, turns: task.turns }, budget(room({ ...task, sources }, options)));
    const turns = (retrieval.task as Followup).turns;
    retrieval.summary.selectedTurns = turns.filter(turn => turn.answer !== OMITTED && turn.feedback !== OMITTED).length;
  }
  return retrieval;
}
