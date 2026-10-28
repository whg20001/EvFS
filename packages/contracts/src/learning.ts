import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { CODE_LANGUAGES, codeLanguageSchema, codeExerciseSchema, type CodeExecution } from './code.ts';

// Shared learning data shapes. Boundary-specific model limits live in ai-task.ts.
export const textSchema = z.string().max(LIMITS.recitationFieldChars);
export const recitationInputSchema = z.object({ learned: textSchema, unclear: textSchema, application: textSchema, topic: z.string().max(LIMITS.topicChars) });
export type RecitationInput = z.infer<typeof recitationInputSchema>;

const id = z.string().min(1);
const version = z.number().int().positive();
export const sourceInputSchema = z.object({ id, name: z.string(), text: z.string() });
export type SourceInput = z.infer<typeof sourceInputSchema>;
export const pointInputSchema = z.object({ id, title: z.string(), description: z.string(), sourceIds: z.array(id), knowledgeVersion: version.nullable().optional() });
export type PointInput = z.infer<typeof pointInputSchema>;
/** Confirmed old knowledge offered for combination only: never assessed alone, never a source, never scheduled. */
export const relatedPointSchema = pointInputSchema.omit({ sourceIds: true }).extend({ knowledgeVersion: version });
export type RelatedPoint = z.infer<typeof relatedPointSchema>;
export const turnSchema = z.object({ id, question: z.string(), answer: z.string().nullable(), feedback: z.string().nullable(), assisted: z.boolean(), scopeVersion: version });
export type Turn = z.infer<typeof turnSchema>;

/** Bounded, non-authoritative cues from recent independent weak review evidence. */
// Stored text stays readable as originally frozen, including legacy clipping markers.
// The engine adds its model text caps; both boundaries share shape and score validation.
export const weaknessCueSchema = z.object({ question: z.string(), weakAreas: z.array(z.string()).min(1).max(3), score: z.number().nonnegative(), maxScore: z.number().positive(), dimension: z.enum(['immediate', 'delayed']) }).refine(item => item.score <= item.maxScore);
export type WeaknessCue = z.infer<typeof weaknessCueSchema>;
export const codeLanguagesSchema = z.array(codeLanguageSchema).min(1).max(CODE_LANGUAGES.length);
export const codeOptionSchema = z.object({ languages: codeLanguagesSchema });
export const generatedQuestionSchema = z.object({
  knowledgeId: z.string(), kind: z.enum(['single', 'short', 'code']), prompt: z.string().min(1).max(3000),
  options: z.array(z.string().max(500)).max(6), correctIndex: z.number().int().min(0).max(5).nullable(),
  referenceAnswer: z.string().min(1).max(4000),
  rubric: z.array(z.object({ id: z.string(), description: z.string().min(1).max(1000), maxScore: z.number().int().min(1).max(10) })).min(1).max(5),
  sourceIds: z.array(z.string()).max(10),
  /** Old knowledge combined into this question; assessment and scheduling still belong to knowledgeId only. */
  relatedKnowledgeIds: z.array(z.string()).max(LIMITS.relatedKnowledgeMaximum).optional(),
  /** Present exactly on code questions. */
  code: z.optional(codeExerciseSchema),
}).superRefine((q, ctx) => {
  if (q.kind === 'single' && (q.options.length < 2 || q.correctIndex === null || q.correctIndex >= q.options.length)) ctx.addIssue({ code: 'custom', message: '单选题选项和答案不一致' });
  if (q.kind !== 'single' && (q.options.length !== 0 || q.correctIndex !== null)) ctx.addIssue({ code: 'custom', message: '简答题与代码题不能携带单选答案' });
  if ((q.kind === 'code') !== (q.code !== undefined)) ctx.addIssue({ code: 'custom', message: '代码题必须且只能由代码题携带代码骨架与测试' });
  if (new Set(q.rubric.map(r => r.id)).size !== q.rubric.length) ctx.addIssue({ code: 'custom', message: '评分项 ID 重复' });
  if (q.relatedKnowledgeIds && (new Set(q.relatedKnowledgeIds).size !== q.relatedKnowledgeIds.length || q.relatedKnowledgeIds.includes(q.knowledgeId))) ctx.addIssue({ code: 'custom', message: '联想知识点重复或与主知识点相同' });
});
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;
export function executionFitsQuestion(question: Pick<GeneratedQuestion, 'kind' | 'code'>, execution: CodeExecution): boolean {
  return question.kind === 'code' && execution.total === question.code?.tests.length;
}

/** Host content-version provenance retained by stored grading tasks and questions. */
export const taskQuestionSchema = generatedQuestionSchema.safeExtend({ knowledgeVersion: pointInputSchema.shape.knowledgeVersion });
export type TaskQuestion = z.infer<typeof taskQuestionSchema>;
