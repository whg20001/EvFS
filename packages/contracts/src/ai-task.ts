import { z } from 'zod';
import { aiModelSelectionSchema } from './ai-access.ts';
import { codeExecutionSchema } from './code.ts';
import { LIMITS } from './limits.ts';
import { codeOptionSchema, generatedQuestionSchema, pointInputSchema, recitationInputSchema, relatedPointSchema,
  sourceInputSchema, taskQuestionSchema, turnSchema, weaknessCueSchema } from './learning.ts';
import { skillSnapshotsSchema } from './skills.ts';

// One definition of task fields and optionality. Storage retains historical text;
// the model boundary below derives its stricter limits without re-listing fields.
const learningContext = { skills: skillSnapshotsSchema.optional() };
const connectionTask = z.strictObject({ kind: z.literal('connection_test'), selection: aiModelSelectionSchema });
const related = z.array(relatedPointSchema).max(LIMITS.relatedKnowledgeMaximum).optional();
const extractTask = z.object({ kind: z.literal('extract'), recitation: recitationInputSchema, sources: z.array(sourceInputSchema), ...learningContext });
const followupTask = z.object({ kind: z.literal('followup'), points: z.array(pointInputSchema), turns: z.array(turnSchema), sources: z.array(sourceInputSchema), related, ...learningContext });
const quizTask = z.object({ kind: z.literal('quiz'), points: z.array(pointInputSchema), sources: z.array(sourceInputSchema),
  count: z.number().int().positive(), recall: z.string().optional(), turns: z.array(turnSchema).max(LIMITS.followupsMaximum).optional(),
  weaknesses: z.array(weaknessCueSchema).max(3).optional(), related, code: codeOptionSchema.optional(), ...learningContext });
const gradeTask = z.object({ kind: z.literal('grade'), question: taskQuestionSchema, answer: z.string(), execution: z.optional(codeExecutionSchema), ...learningContext });

/** Backward-compatible archive validation. Never defaults missing snapshots or clips text. */
export const storedAiTaskSchema = z.discriminatedUnion('kind', [connectionTask, extractTask, followupTask, quizTask, gradeTask]);
export type AiTask = z.infer<typeof storedAiTaskSchema>;

const modelId = sourceInputSchema.shape.id.max(200);
const modelText = z.string().max(LIMITS.modelInputChars);
const modelSource = sourceInputSchema.extend({ id: modelId, name: sourceInputSchema.shape.name.max(500), text: modelText });
const modelSources = z.array(modelSource).max(LIMITS.modelSourcesMaximum);
const modelPoint = pointInputSchema.extend({ id: modelId, title: pointInputSchema.shape.title.min(1).max(200),
  description: modelText.min(1), sourceIds: z.array(modelId).max(LIMITS.modelSourcesMaximum) });
const modelPoints = z.array(modelPoint).min(1).max(50);
const modelRelated = relatedPointSchema.extend({ id: modelId, title: modelPoint.shape.title, description: modelPoint.shape.description });
const modelRelatedPoints = z.array(modelRelated).max(LIMITS.relatedKnowledgeMaximum).optional();
const modelTurn = turnSchema.extend({ id: modelId, question: modelText, answer: modelText.nullable(), feedback: modelText.nullable() });
const modelTurns = z.array(modelTurn).max(50);
const modelWeakness = weaknessCueSchema.safeExtend({ question: modelText.max(3000), weakAreas: z.array(modelText.max(800)).min(1).max(3) });

/** Final SDK-entry validation. Excerpt markers may exceed archive field lengths;
 * complete-request budgets are enforced separately by the learning-agent package.
 * Unknown learning-task fields keep the previous stripping behavior, while probes
 * reject all extras. Grading's question ID/content version remain host-only data.
 */
export const modelAiTaskSchema = z.discriminatedUnion('kind', [
  connectionTask,
  extractTask.extend({ recitation: recitationInputSchema.extend({ learned: modelText, unclear: modelText, application: modelText }), sources: modelSources }),
  followupTask.extend({ points: modelPoints, turns: modelTurns, sources: modelSources, related: modelRelatedPoints }),
  quizTask.extend({ points: modelPoints, sources: modelSources, count: quizTask.shape.count.max(LIMITS.quizQuestionsMaximum),
    recall: modelText.optional(), turns: modelTurns.max(LIMITS.followupsMaximum).optional(), weaknesses: z.array(modelWeakness).max(3).optional(), related: modelRelatedPoints }),
  gradeTask.extend({ question: generatedQuestionSchema, answer: gradeTask.shape.answer.max(LIMITS.answerChars) }),
]);
