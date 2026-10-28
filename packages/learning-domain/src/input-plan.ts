import { LIMITS, type AiTask, type RetrievalSummary, type Turn } from '@sanxing/contracts';
type LearningRequestOptions = { maxOutputTokens: number; contextWindow?: number };
type Inspector = { fitsLearningRequest: (task: AiTask, options: LearningRequestOptions) => boolean; inspectLearningRequest: (task: AiTask, options: LearningRequestOptions) => { prompt: string; remainingInputTokens: number | null; estimatedInputTokens: number } };
import { prepareRetrieval } from './retrieval.ts';

/** Covers block delimiters and the shared-cut guard in the final H2 preparation. */
const SLACK = 32;
const OMITTED = '[较早作答已省略，以保持本范围资料不变；完整记录仍已保存。]';

/** Room left for source texts beside a task whose sources are blank. Source costs add up exactly. */
function room(skeleton: AiTask, options: LearningRequestOptions, inspectLearningRequest: Inspector['inspectLearningRequest']): { chars: number; bytes?: number } {
  const measured = inspectLearningRequest(skeleton, options);
  return { chars: LIMITS.modelInputChars - measured.prompt.length - SLACK,
    ...(measured.remainingInputTokens === null ? {} : { bytes: measured.remainingInputTokens - measured.estimatedInputTokens - SLACK }) };
}
const budget = (space: { chars: number; bytes?: number }, reserve = { chars: 0, bytes: 0 }) =>
  ({ maxChars: space.chars - reserve.chars, ...(space.bytes === undefined ? {} : { maxUtf8Bytes: space.bytes - reserve.bytes }) });

/**
 * Pure offline planning before H2: do not reserve space for hypothetical future turns. Sources
 * are selected against the actual scope and then older turn answers/feedback are reduced only if
 * this request needs the room. Retries reuse the frozen task.
 */
export function planLearningInput<T extends AiTask>(input: T, options: LearningRequestOptions, requests: Inspector): { task: T; summary: RetrievalSummary } {
  const { fitsLearningRequest: fits, inspectLearningRequest } = requests;
  if (input.kind === 'grade' || input.kind === 'connection_test') return prepareRetrieval(input, { maxChars: Infinity });
  const scopedTurns = input.kind === 'followup' || (input.kind === 'quiz' && input.turns !== undefined);
  const sources = input.sources.map(source => ({ ...source, text: '' }));
  const skeleton: AiTask = scopedTurns && input.kind === 'followup'
    ? { ...input, sources, turns: [] }
    : scopedTurns && input.kind === 'quiz'
      ? { ...input, sources, turns: [] }
    : { ...input, sources } as AiTask;
  const space = room(skeleton, options, inspectLearningRequest);
  let retrieval = prepareRetrieval(input, budget(space));
  const turns: Turn[] | undefined = retrieval.task.kind === 'followup' ? retrieval.task.turns
    : retrieval.task.kind === 'quiz' ? retrieval.task.turns : undefined;
  if (turns) {
    const task = retrieval.task;
    // The newest question may be unanswered. Protect the latest actual answer and its feedback too.
    const latestAnswered = turns.findLastIndex(turn => turn.answer !== null);
    for (let index = 0; index < turns.length - 1 && !fits(task, options); index++) {
      if (index === latestAnswered) continue;
      const turn = turns[index]!;
      if (turn.answer !== null && turn.answer.length > OMITTED.length) turn.answer = OMITTED;
      if (turn.feedback !== null && turn.feedback.length > OMITTED.length) turn.feedback = OMITTED;
    }
    // If actual current history still does not fit, retrieve against its exact remaining room.
    if (!fits(task, options)) retrieval = prepareRetrieval({ ...input, turns } as T, budget(room({ ...task, sources } as AiTask, options, inspectLearningRequest)));
    retrieval.summary.selectedTurns = turns.filter(turn => turn.answer !== OMITTED && turn.feedback !== OMITTED).length;
  }
  return retrieval;
}
