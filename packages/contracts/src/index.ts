import { z } from 'zod';
export * from './admin.ts';
export * from './image.ts';
export { skillResourcesSchema, skillSelectionSchema, skillFileInputSchema, type SkillSelection } from './skills.ts';
import type { PromptBinding, RunErrorCode, RunProgress, RunRequest, RunTransport, ConnectionPolicy, LearningProgressEvent } from './agent-run.ts';
export { connectionPolicySchema, transportErrorCodeSchema, runTransportSchema, type RunTransport, type ConnectionPolicy, runErrorCodeSchema, promptHashSchema, runProgressSchema, runRequestSchema, updateRunProgress, taskTimeoutMs, type PromptBinding, type RunErrorCode, type RunProgress, type RunProgressMap, type RunRequest, type LearningProgressEvent } from './agent-run.ts';
import { LIMITS } from './limits.ts';
import { skillSelectionSchema } from './skills.ts';
import { codeLanguagesSchema, generatedQuestionSchema } from './learning.ts';
import type { RecitationInput, SourceInput, PointInput, Turn, GeneratedQuestion, TaskQuestion } from './learning.ts';
import type { AiTask } from './ai-task.ts';
export { textSchema, recitationInputSchema, sourceInputSchema, pointInputSchema, relatedPointSchema, turnSchema, weaknessCueSchema, codeLanguagesSchema, codeOptionSchema, generatedQuestionSchema, taskQuestionSchema, executionFitsQuestion } from './learning.ts';
export type { RecitationInput, SourceInput, PointInput, RelatedPoint, Turn, WeaknessCue, GeneratedQuestion, TaskQuestion } from './learning.ts';
export { storedAiTaskSchema, modelAiTaskSchema } from './ai-task.ts';
export type { AiTask } from './ai-task.ts';
import { codeExecutionSchema, type CodeExercise, type CodeExecution } from './code.ts';
export { CODE_LANGUAGES, DEFAULT_CODE_LANGUAGES, codeLanguageSchema, codeExerciseSchema, codeExecutionSchema, type CodeLanguage, type CodeExercise, type CodeExecution } from './code.ts';
export { LIMITS, IDEMPOTENCY_KEY_PATTERN } from './limits.ts';
export { documentFormat, documentUploadLimit, pdfImportErrorMessage, isDocumentFilename, isPdfFilename, isUploadFilename } from './document.ts';
export type { PdfImport, DocumentImport, PdfFailureDetails } from './document.ts';
export type { LearningStatistics, PerformanceCount } from './statistics.ts';
export { currentKnowledgeId } from './knowledge.ts';
export { SKILL_LIMITS, SKILL_TASKS, SKILL_TASK_LABELS, skillDocumentSchema, skillTasksSchema, learningSkillSchema, learningSkillsSchema, skillSnapshotSchema, skillSnapshotsSchema, summarizeSkill, cloudSkillEntrySchema, cloudSkillCatalogSchema } from './skills.ts';
export type { SkillTask, SkillDocument, LearningSkill, SkillSummary, SkillPreview, SkillSnapshot, CloudSkillSummary, CloudSkillCatalogView } from './skills.ts';
export type { KnowledgeMergePreview, ReviewPlan } from './knowledge.ts';
export { prepareTaskContext, previewRecitationContext } from './context.ts';
import type { AiModelSelection } from './ai-access.ts';
export { aiModelSelectionSchema } from './ai-access.ts';
export type { AiConnectionTestView, AiModelSelection, AiModelProvider, AiModelConfiguration, OAuthSessionStatus, OAuthSessionView, AiProviderView, AiAccessOverview, TokenUsageTotals, TokenUsageDay, TokenUsageHeatmap } from './ai-access.ts';

export type { TaskInputPreview, RetrievalSummary } from './input-preview.ts';
export type { LearningPreferences, LearningPreferencesView, LibraryHit, LibrarySearchResult } from './library.ts';
import type { LearningPreferences } from './library.ts';
export const LEARNING_PROMPT_VERSION = 'learning-v8';
export const taskPromptVersion = (kind: AiTask['kind']) => kind === 'connection_test' ? 'connection-v1' : LEARNING_PROMPT_VERSION;
/** The recitation as sent to the model as a source; extraction de-duplicates against this exact text. */
export const recitationSourceText = (recitation: Pick<RecitationInput, 'learned' | 'unclear' | 'application'>) => `${recitation.learned}\n疑问：${recitation.unclear}\n应用：${recitation.application}`;
export const RECITATION_DUPLICATE = '[上下文节选：原始复述见 recitation 字段，此处不重复发送。]';
/** A run still holding its scope: waiting for or inside a model request. */
export const isActiveRun = (run: { status: string }) => run.status === 'pending' || run.status === 'running';
export type Mode = 'mock' | 'live';
export type SessionStatus = 'CONFIRMING' | 'CLARIFYING' | 'QUIZ_READY' | 'QUIZZING' | 'COMPLETED';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const candidateSchema = z.object({ title: z.string().min(1).max(100), description: z.string().min(1).max(2000), sourceIds: z.array(z.string()).max(10) });
export const learningPreferencesSchema = z.object({ schedulingEnabled: z.boolean(), promptCacheRetention: z.enum(['none', 'short']), associationEnabled: z.boolean().optional(), codeExercisesEnabled: z.boolean().optional(), codeLanguages: codeLanguagesSchema.optional(), reviewOrder: z.enum(['due', 'weakness']).optional(), reviewBatchSize: z.number().int().min(1).max(100).nullable().optional() });
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
export const usageSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cost: z.number().nonnegative().nullable(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional() }).refine(usage => (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) <= usage.inputTokens, { message: 'Cache counters must be subsets of total input' });
/** inputTokens includes cache read/write; unknown usage is null, not a synthetic zero. */
export type Usage = z.infer<typeof usageSchema>;
export interface AiResponse { output: AiOutput; usage: Usage | null }
export interface LearningEngine {
  close?(): Promise<void>;
  readonly mode: Mode;
  execute(task: AiTask, options: { signal: AbortSignal; onUsage?: (usage: Usage) => Promise<void>; onProgress?: (event: LearningProgressEvent) => void; onRequest?: (request: RunRequest) => void; onTransport?: (transport: RunTransport) => void; connectionPolicy?: ConnectionPolicy; cacheScope?: string; expectedPrompt?: PromptBinding }): Promise<AiResponse>;
}

export interface Recitation extends RecitationInput { id: string; learningDate: string; version: number; documentIds: string[]; createdAt: string; updatedAt: string }
export interface DocumentRecord extends SourceInput { recitationId: string; hash: string; lineCount: number; createdAt: string; originalBase64: string; import?: import('./document.ts').DocumentImport }
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
export interface KnowledgePoint extends Omit<PointInput, 'knowledgeVersion'> { version: number; contentVersion?: number; contentHistory?: KnowledgeContentVersion[]; understanding: string; createdAt: string; updatedAt: string; archivedAt?: string | null; tags?: string[]; merge?: { targetId: string; mergedAt: string; retainedCardId: string | null } }
export interface RubricScore { rubricId: string; description: string; maxScore: number; score: number; evidence: string }
export interface Assessment { status: 'pending' | 'graded' | 'needs_verification' | 'skipped'; score: number | null; maxScore: number; feedback: string; assessedAt: string | null; version: number; scores?: RubricScore[]; source?: 'model' | 'manual' | 'automatic'; reason?: string }
export interface Answer { text: string; selectedIndex: number | null; assisted: boolean; skipped: boolean; submittedAt: string; assessment: Assessment; execution?: CodeExecution; assessmentHistory?: Assessment[]; dispute?: { reason: string; createdAt: string; resolvedAt: string | null } }
export interface Question extends TaskQuestion { id: string }
export interface Quiz {
  id: string; sessionId: string | null; reviewSessionId: string | null; scopeVersion: number; version: number;
  questions: Question[]; answers: Record<string, Answer>; drafts: Record<string, string>; submittedAt: string | null; createdAt: string;
}
export interface SerializedCard {
  due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  reps: number; lapses: number; state: number; learning_steps: number; last_review?: string;
}
export interface ReviewCard { id: string; knowledgeId: string; version: number; schedule: SerializedCard; createdAt: string; pausedAt?: string | null; currentKnowledgeId?: string; retiredAt?: string }
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
  /** SHA-256 of the exact application system prompt and user blocks; absent in legacy records. */
  promptHash?: string;
  errorCode?: RunErrorCode;
  /** Final, content-free durations; live progress is held by the worker, not written per token. */
  progress?: RunProgress;
  request?: RunRequest;
  transport?: RunTransport;
  /** False only when preparation failed before a sendable task could be frozen. */
  inputPrepared?: boolean;
  /** A post-submission correction is fenced by the original assessment version. */
  assessmentRevision?: { expectedVersion: number; reason: string };
  /** Synthetic evaluation runs never belong to learning sessions or change learning records. */
  evaluation?: { suite: string; caseId: string; batchId: string; selection: AiModelSelection; connectionPolicy?: ConnectionPolicy; output?: AiOutput };
}
export interface Receipt { hash: string; result: unknown; createdAt: string }
export interface AppData {
  schemaVersion: 1; ownerId: string; mode: Mode; revision: number;
  /** Optional for legacy schema-v1 snapshots; non-secret and scoped to this mode. */
  aiModel?: AiModelSelection | null;
  /** Mode-local owner preferences; absence keeps existing environment defaults. */
  learningPreferences?: LearningPreferences;
  /** Owner-imported instruction skills, isolated by mode; legacy data has none. */
  skills?: import('./skills.ts').LearningSkill[];
  recitations: Record<string, Recitation>; documents: Record<string, DocumentRecord>; sessions: Record<string, LearningSession>;
  knowledge: Record<string, KnowledgePoint>; quizzes: Record<string, Quiz>; cards: Record<string, ReviewCard>;
  reviewSessions: Record<string, ReviewSession>; reviewEvents: Record<string, ReviewEvent>; evidence: Record<string, Evidence>;
  runs: Record<string, AgentRun>; receipts: Record<string, Receipt>;
}
export interface PublicQuestion { id: string; knowledgeId: string; kind: GeneratedQuestion['kind']; prompt: string; code?: CodeExercise; options: string[]; draft: string; hasDraft?: boolean; answer: Answer | null; explanation: string | null; rubric?: GeneratedQuestion['rubric'] }
export interface PublicQuiz { id: string; sessionId: string | null; reviewSessionId: string | null; version: number; questionCount: number; currentIndex: number; questions: PublicQuestion[]; submittedAt: string | null; detailsOmitted?: true }
export type PublicEvidence = Evidence | { id: string; knowledgeId: string; simulated: boolean; summary: { graded: boolean } };
export interface EvidencePage { revision: number; total: number; nextOffset: number | null; items: Evidence[] }
export interface PublicRun { id: string; status: RunStatus; kind: AiTask['kind']; sessionId: string | null; reviewSessionId: string | null; error: string | null; errorCode?: RunErrorCode; progress?: RunProgress; createdAt: string; quizId?: string | null; questionId?: string | null; assessmentRevision?: boolean }
/** State lists metadata; text is fetched only from the authenticated document detail endpoint. */
export interface PublicDocument { id: string; recitationId: string; name: string; text?: string; textLength?: number; lineCount: number; createdAt: string; import?: import('./document.ts').DocumentImport }
export interface PublicState {
  mode: Mode; timezone: string; revision: number; csrfToken: string;
  capabilities: { maxUploadBytes: number; maxDocuments: number; maxFollowups: number; quizCount: number; schedulingEnabled: boolean; historyDetails?: 'on-demand' };
  recitations: Recitation[]; documents: PublicDocument[]; sessions: LearningSession[]; knowledge: KnowledgePoint[];
  quizzes: PublicQuiz[]; cards: ReviewCard[]; reviewSessions: ReviewSession[]; reviewEvents: ReviewEvent[];
  evidence: PublicEvidence[]; runs: PublicRun[];
}
export const PUBLIC_STATE_COLLECTIONS = ['recitations', 'documents', 'sessions', 'knowledge', 'quizzes', 'cards', 'reviewSessions', 'reviewEvents', 'evidence', 'runs'] as const;
export type PublicStateCollection = typeof PUBLIC_STATE_COLLECTIONS[number];
export type PublicStateChanges = { [K in PublicStateCollection]?: { upsert: PublicState[K]; remove: string[] } };
export type PublicStateUpdate =
  | { kind: 'unchanged'; revision: number; csrfToken: string }
  | { kind: 'snapshot'; state: PublicState }
  | { kind: 'delta'; fromRevision: number; revision: number; csrfToken: string; changes: PublicStateChanges };
export interface CommandResult { id?: string; sessionId?: string; quizId?: string; reviewSessionId?: string; runId?: string; version?: number }
export const answerInputSchema = z.object({ skillSelections: skillSelectionSchema.optional(), codeProtocol: z.literal(1).optional(), action: z.enum(['answer', 'skip']), text: z.string().max(LIMITS.answerChars).default(''), selectedIndex: z.number().int().min(0).max(5).nullable().default(null), assisted: z.boolean().default(false), execution: z.optional(codeExecutionSchema), version: z.number().int().positive() });
export const versionSchema = z.object({ version: z.number().int().positive() });

export { hashBytes, randomUUID, encodeBase64 } from './runtime.ts';
export type { AccountIdentity, AuthStatus, LocalLearningConfig, LocalBootstrap } from './local-first.ts';
