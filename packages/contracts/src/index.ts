import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { CODE_LANGUAGES, codeLanguageSchema, codeExerciseSchema, codeExecutionSchema, type CodeLanguage, type CodeExercise, type CodeExecution } from './code.ts';
export { CODE_LANGUAGES, DEFAULT_CODE_LANGUAGES, codeLanguageSchema, codeExerciseSchema, codeExecutionSchema, type CodeLanguage, type CodeExercise, type CodeExecution } from './code.ts';
export { LIMITS, IDEMPOTENCY_KEY_PATTERN } from './limits.ts';
export { documentFormat, isDocumentFilename } from './document.ts';
export { prepareTaskContext, previewRecitationContext } from './context.ts';
import type { AiModelSelection } from './ai-access.ts';
export { aiModelSelectionSchema } from './ai-access.ts';
export type { AiConnectionTestView, AiModelSelection, AiModelProvider, AiModelConfiguration, OAuthSessionStatus, OAuthSessionView, AiProviderView, AiAccessOverview, TokenUsageTotals, TokenUsageDay, TokenUsageHeatmap } from './ai-access.ts';

export type { TaskInputPreview, RetrievalSummary } from './input-preview.ts';
export type { LearningPreferences, LearningPreferencesView, LibraryHit, LibrarySearchResult } from './library.ts';
import type { LearningPreferences } from './library.ts';
export const LEARNING_PROMPT_VERSION = 'learning-v6';
export const textSchema = z.string().max(LIMITS.recitationFieldChars);
export const recitationInputSchema = z.object({ learned: textSchema, unclear: textSchema, application: textSchema, topic: z.string().max(LIMITS.topicChars) });
export type RecitationInput = z.infer<typeof recitationInputSchema>;
/** The recitation as sent to the model as a source; extraction de-duplicates against this exact text. */
export const recitationSourceText = (recitation: Pick<RecitationInput, 'learned' | 'unclear' | 'application'>) => `${recitation.learned}\n疑问：${recitation.unclear}\n应用：${recitation.application}`;
export const RECITATION_DUPLICATE = '[上下文节选：原始复述见 recitation 字段，此处不重复发送。]';
/** A run still holding its scope: waiting for or inside a model request. */
export const isActiveRun = (run: { status: string }) => run.status === 'pending' || run.status === 'running';
export type Mode = 'mock' | 'live';
export type SessionStatus = 'CONFIRMING' | 'CLARIFYING' | 'QUIZ_READY' | 'QUIZZING' | 'COMPLETED';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface SourceInput { id: string; name: string; text: string }
export interface PointInput { id: string; title: string; description: string; sourceIds: string[]; knowledgeVersion?: number | null }
/** Confirmed old knowledge offered for combination only: never assessed alone, never a source, never scheduled. */
export interface RelatedPoint { id: string; title: string; description: string; knowledgeVersion: number }
export interface Turn { id: string; question: string; answer: string | null; feedback: string | null; assisted: boolean; scopeVersion: number }
export const candidateSchema = z.object({ title: z.string().min(1).max(100), description: z.string().min(1).max(2000), sourceIds: z.array(z.string()).max(10) });
export const codeLanguagesSchema = z.array(codeLanguageSchema).min(1).max(CODE_LANGUAGES.length);
export const codeOptionSchema = z.object({ languages: codeLanguagesSchema });
export const learningPreferencesSchema = z.object({ schedulingEnabled: z.boolean(), promptCacheRetention: z.enum(['none', 'short']), associationEnabled: z.boolean().optional(), codeExercisesEnabled: z.boolean().optional(), codeLanguages: codeLanguagesSchema.optional() });
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
export const learningOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('extract'), candidates: z.array(candidateSchema).min(1).max(5) }),
  z.object({ kind: z.literal('followup'), question: z.string().min(1).max(2000), feedback: z.string().max(3000) }),
  z.object({ kind: z.literal('quiz'), questions: z.array(generatedQuestionSchema).min(1).max(5) }),
  z.object({ kind: z.literal('grade'), status: z.enum(['graded', 'needs_verification']), scores: z.array(z.object({ rubricId: z.string(), score: z.number().min(0).max(10), evidence: z.string().max(2000) })).max(5), feedback: z.string().min(1).max(4000) })
]);
// Diagnostics share transport/validation, not the learning prompt's output alternatives.
export const aiOutputSchema = z.discriminatedUnion('kind', [
  ...learningOutputSchema.options,
  z.strictObject({ kind: z.literal('connection_test'), ok: z.literal(true) }),
]);
export type AiOutput = z.infer<typeof aiOutputSchema>;
export type AiTask =
  | { kind: 'connection_test'; selection: AiModelSelection }
  | { kind: 'extract'; recitation: RecitationInput; sources: SourceInput[] }
  | { kind: 'followup'; points: PointInput[]; turns: Turn[]; sources: SourceInput[]; related?: RelatedPoint[] }
  | { kind: 'quiz'; points: PointInput[]; sources: SourceInput[]; count: number; recall?: string; related?: RelatedPoint[]; code?: { languages: CodeLanguage[] } }
  | { kind: 'grade'; question: GeneratedQuestion; answer: string; execution?: CodeExecution };
export const usageSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cost: z.number().nonnegative().nullable(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional() }).refine(usage => (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= usage.inputTokens, { message: 'Cache counters must be subsets of total input' });
/** inputTokens includes cache read/write; unknown usage is null, not a synthetic zero. */
export type Usage = z.infer<typeof usageSchema>;
export interface AiResponse { output: AiOutput; usage: Usage | null }
export interface LearningEngine {
  readonly mode: Mode;
  execute(task: AiTask, options: { signal: AbortSignal; onUsage?: (usage: Usage) => Promise<void>; cacheScope?: string }): Promise<AiResponse>;
}

export interface Recitation extends RecitationInput { id: string; learningDate: string; version: number; documentIds: string[]; createdAt: string; updatedAt: string }
export interface DocumentRecord extends SourceInput { recitationId: string; hash: string; lineCount: number; createdAt: string; originalBase64: string }
export interface Candidate extends z.infer<typeof candidateSchema> { id: string; decision: 'pending' | 'accepted' | 'rejected'; existingKnowledgeId: string | null; knowledgeId: string | null; knowledgeVersion?: number | null }
export interface LearningSession {
  id: string; recitationId: string; snapshot: RecitationInput; documentIds: string[]; scopeVersion: number; version: number;
  status: SessionStatus; candidates: Candidate[]; turns: Turn[]; quizId: string | null; activeRunId: string | null;
  /** Automatically associated old knowledge (when enabled), frozen at confirmation; never extra assessed points. */
  relatedKnowledge?: PointInput[];
  completionReason: 'assessed' | 'no_quiz' | 'user_ended' | null; createdAt: string; completedAt: string | null;
}
/** Content history begins with the first observed snapshot; missing legacy history is not invented. */
export interface KnowledgeContentVersion { version: number; title: string; description: string; sourceIds: string[]; createdAt: string }
export interface KnowledgePoint extends Omit<PointInput, 'knowledgeVersion'> { version: number; contentVersion?: number; contentHistory?: KnowledgeContentVersion[]; understanding: string; createdAt: string; updatedAt: string }
export interface Assessment { status: 'pending' | 'graded' | 'needs_verification' | 'skipped'; score: number | null; maxScore: number; feedback: string; assessedAt: string | null; version: number }
export interface Answer { text: string; selectedIndex: number | null; assisted: boolean; skipped: boolean; submittedAt: string; assessment: Assessment; execution?: CodeExecution }
export interface Question extends GeneratedQuestion { id: string; knowledgeVersion?: number | null }
export interface Quiz {
  id: string; sessionId: string | null; reviewSessionId: string | null; scopeVersion: number; version: number;
  questions: Question[]; answers: Record<string, Answer>; drafts: Record<string, string>; submittedAt: string | null; createdAt: string;
}
export interface SerializedCard {
  due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  reps: number; lapses: number; state: number; learning_steps: number; last_review?: string;
}
export interface ReviewCard { id: string; knowledgeId: string; version: number; schedule: SerializedCard; createdAt: string }
export interface ReviewSession {
  id: string; cardId: string; expectedCardVersion: number; version: number;
  status: 'RECALLING' | 'QUIZ_READY' | 'QUIZZING' | 'READY_TO_COMPLETE' | 'COMPLETED' | 'ABANDONED';
  recall: string; recallSubmittedAt: string | null; quizId: string | null; activeRunId: string | null;
  createdAt: string; completedAt: string | null;
}
export interface ReviewEvent { id: string; reviewSessionId: string; cardId: string; rating: 1 | 2 | 3 | 4; reviewedAt: string; before: SerializedCard; after: SerializedCard; algorithm: string; simulated: boolean }
export interface Evidence { id: string; knowledgeId: string; knowledgeVersion?: number | null; quizId: string; questionId: string; answer: Answer; dimension: 'immediate' | 'delayed'; simulated: boolean }
export interface AgentRun {
  id: string; status: RunStatus; task: AiTask; sessionId: string | null; reviewSessionId: string | null; quizId: string | null; questionId: string | null;
  attempt: number; attemptId: string | null; expectedVersion: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; usage: Usage | null; reservationUsd: number; promptVersion: string;
  /** False only when preparation failed before a sendable task could be frozen. */
  inputPrepared?: boolean;
}
export interface Receipt { hash: string; result: unknown; createdAt: string }
export interface AppData {
  schemaVersion: 1; ownerId: string; mode: Mode; revision: number;
  /** Optional for legacy schema-v1 snapshots; non-secret and scoped to this mode. */
  aiModel?: AiModelSelection | null;
  /** Mode-local owner preferences; absence keeps existing environment defaults. */
  learningPreferences?: LearningPreferences;
  recitations: Record<string, Recitation>; documents: Record<string, DocumentRecord>; sessions: Record<string, LearningSession>;
  knowledge: Record<string, KnowledgePoint>; quizzes: Record<string, Quiz>; cards: Record<string, ReviewCard>;
  reviewSessions: Record<string, ReviewSession>; reviewEvents: Record<string, ReviewEvent>; evidence: Record<string, Evidence>;
  runs: Record<string, AgentRun>; receipts: Record<string, Receipt>;
}
export interface PublicQuestion { id: string; knowledgeId: string; kind: GeneratedQuestion['kind']; prompt: string; code?: CodeExercise; options: string[]; draft: string; hasDraft?: boolean; answer: Answer | null; explanation: string | null }
export interface PublicQuiz { id: string; sessionId: string | null; reviewSessionId: string | null; version: number; questionCount: number; currentIndex: number; questions: PublicQuestion[]; submittedAt: string | null }
export interface PublicRun { id: string; status: RunStatus; kind: AiTask['kind']; sessionId: string | null; reviewSessionId: string | null; error: string | null; createdAt: string }
/** State lists metadata; text is fetched only from the authenticated document detail endpoint. */
export interface PublicDocument { id: string; recitationId: string; name: string; text?: string; textLength?: number; lineCount: number; createdAt: string }
export interface PublicState {
  mode: Mode; timezone: string; revision: number; csrfToken: string;
  capabilities: { maxUploadBytes: number; maxDocuments: number; maxFollowups: number; quizCount: number; schedulingEnabled: boolean };
  recitations: Recitation[]; documents: PublicDocument[]; sessions: LearningSession[]; knowledge: KnowledgePoint[];
  quizzes: PublicQuiz[]; cards: ReviewCard[]; reviewSessions: ReviewSession[]; reviewEvents: ReviewEvent[];
  evidence: Evidence[]; runs: PublicRun[];
}
export const PUBLIC_STATE_COLLECTIONS = ['recitations', 'documents', 'sessions', 'knowledge', 'quizzes', 'cards', 'reviewSessions', 'reviewEvents', 'evidence', 'runs'] as const;
export type PublicStateCollection = typeof PUBLIC_STATE_COLLECTIONS[number];
export type PublicStateChanges = { [K in PublicStateCollection]?: { upsert: PublicState[K]; remove: string[] } };
export type PublicStateUpdate =
  | { kind: 'unchanged'; revision: number; csrfToken: string }
  | { kind: 'snapshot'; state: PublicState }
  | { kind: 'delta'; fromRevision: number; revision: number; csrfToken: string; changes: PublicStateChanges };
export interface CommandResult { id?: string; sessionId?: string; quizId?: string; reviewSessionId?: string; runId?: string; version?: number }
export const answerInputSchema = z.object({ codeProtocol: z.literal(1).optional(), action: z.enum(['answer', 'skip']), text: z.string().max(LIMITS.answerChars).default(''), selectedIndex: z.number().int().min(0).max(5).nullable().default(null), assisted: z.boolean().default(false), execution: z.optional(codeExecutionSchema), version: z.number().int().positive() });
export const versionSchema = z.object({ version: z.number().int().positive() });
