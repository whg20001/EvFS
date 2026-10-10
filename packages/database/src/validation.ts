import { z } from 'zod';
import { LIMITS, aiModelSelectionSchema, candidateSchema, codeExecutionSchema, codeOptionSchema, executionFitsQuestion, generatedQuestionSchema, learningPreferencesSchema, recitationInputSchema, usageSchema } from '@sanxing/contracts';
import type { AppData, Mode } from '@sanxing/contracts';

const id = z.string().min(1);
const integer = z.number().int().nonnegative();
const version = z.number().int().positive();
const date = z.iso.datetime({ offset: true });
const nullableId = id.nullable();
const ids = z.array(id);
const source = z.object({ id, name: z.string(), text: z.string() });
const knowledgeVersion = version.nullable().optional();
const point = z.object({ id, title: z.string(), description: z.string(), sourceIds: ids, knowledgeVersion });
const contentVersion = z.object({ version, title: z.string(), description: z.string(), sourceIds: ids, createdAt: date });
const question = generatedQuestionSchema.safeExtend({ knowledgeVersion });
const related = z.array(z.object({ id, title: z.string(), description: z.string(), knowledgeVersion: version })).max(LIMITS.relatedKnowledgeMaximum).optional();
const turn = z.object({ id, question: z.string(), answer: z.string().nullable(), feedback: z.string().nullable(), assisted: z.boolean(), scopeVersion: version });
const usage = usageSchema;
const task = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connection_test'), selection: aiModelSelectionSchema }),
  z.object({ kind: z.literal('extract'), recitation: recitationInputSchema, sources: z.array(source) }),
  z.object({ kind: z.literal('followup'), points: z.array(point), turns: z.array(turn), sources: z.array(source), related }),
  z.object({ kind: z.literal('quiz'), points: z.array(point), sources: z.array(source), count: version, recall: z.string().optional(), related, code: codeOptionSchema.optional() }),
  z.object({ kind: z.literal('grade'), question, answer: z.string(), execution: z.optional(codeExecutionSchema) }),
]);
const assessment = z.object({ status: z.enum(['pending', 'graded', 'needs_verification', 'skipped']), score: z.number().nullable(), maxScore: z.number().nonnegative(), feedback: z.string(), assessedAt: date.nullable(), version });
const answer = z.object({ text: z.string(), selectedIndex: integer.nullable(), assisted: z.boolean(), skipped: z.boolean(), submittedAt: date, assessment, execution: z.optional(codeExecutionSchema) });
const schedule = z.object({ due: date, stability: z.number(), difficulty: z.number(), elapsed_days: z.number(), scheduled_days: z.number(), reps: integer, lapses: integer, state: integer, learning_steps: integer, last_review: date.optional() });
const record = <T extends z.ZodType>(value: T) => z.record(id, value);

const appDataSchema = z.strictObject({
  schemaVersion: z.literal(1), ownerId: id, mode: z.enum(['mock', 'live']), revision: integer.max(2_147_483_647),
  aiModel: aiModelSelectionSchema.nullable().optional(),
  learningPreferences: learningPreferencesSchema.strict().optional(),
  recitations: record(recitationInputSchema.extend({ id, learningDate: z.iso.date(), version, documentIds: ids, createdAt: date, updatedAt: date })),
  documents: record(source.extend({ recitationId: id, hash: z.string(), lineCount: integer, createdAt: date, originalBase64: z.string() })),
  sessions: record(z.object({
    id, recitationId: id, snapshot: recitationInputSchema, documentIds: ids, scopeVersion: version, version,
    status: z.enum(['CONFIRMING', 'CLARIFYING', 'QUIZ_READY', 'QUIZZING', 'COMPLETED']),
    candidates: z.array(candidateSchema.extend({ id, decision: z.enum(['pending', 'accepted', 'rejected']), existingKnowledgeId: nullableId, knowledgeId: nullableId, knowledgeVersion })),
    turns: z.array(turn), quizId: nullableId, activeRunId: nullableId,
    relatedKnowledge: z.array(point.extend({ knowledgeVersion: version })).max(LIMITS.relatedKnowledgeMaximum).optional(),
    completionReason: z.enum(['assessed', 'no_quiz', 'user_ended']).nullable(), createdAt: date, completedAt: date.nullable(),
  })),
  knowledge: record(point.omit({ knowledgeVersion: true }).extend({ version, contentVersion: version.optional(), contentHistory: z.array(contentVersion).optional(), understanding: z.string(), createdAt: date, updatedAt: date })),
  quizzes: record(z.object({ id, sessionId: nullableId, reviewSessionId: nullableId, scopeVersion: version, version, questions: z.array(question.safeExtend({ id })), answers: record(answer), drafts: record(z.string()), submittedAt: date.nullable(), createdAt: date })),
  cards: record(z.object({ id, knowledgeId: id, version, schedule, createdAt: date })),
  reviewSessions: record(z.object({ id, cardId: id, expectedCardVersion: version, version, status: z.enum(['RECALLING', 'QUIZ_READY', 'QUIZZING', 'READY_TO_COMPLETE', 'COMPLETED', 'ABANDONED']), recall: z.string(), recallSubmittedAt: date.nullable(), quizId: nullableId, activeRunId: nullableId, createdAt: date, completedAt: date.nullable() })),
  reviewEvents: record(z.object({ id, reviewSessionId: id, cardId: id, rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), reviewedAt: date, before: schedule, after: schedule, algorithm: z.string(), simulated: z.boolean() })),
  evidence: record(z.object({ id, knowledgeId: id, knowledgeVersion, quizId: id, questionId: id, answer, dimension: z.enum(['immediate', 'delayed']), simulated: z.boolean() })),
  runs: record(z.object({ id, status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']), task, sessionId: nullableId, reviewSessionId: nullableId, quizId: nullableId, questionId: nullableId, attempt: integer, attemptId: nullableId, expectedVersion: integer, createdAt: date, startedAt: date.nullable(), finishedAt: date.nullable(), error: z.string().nullable(), usage: usage.nullable(), reservationUsd: z.number().nonnegative(), promptVersion: z.string(), inputPrepared: z.boolean().optional() })),
  receipts: record(z.object({ hash: z.string(), result: z.unknown(), createdAt: date })),
});

const entityMaps = ['recitations', 'documents', 'sessions', 'knowledge', 'quizzes', 'cards', 'reviewSessions', 'reviewEvents', 'evidence', 'runs'] as const;

// Reject lossy JSON conversions (undefined, non-finite numbers, cycles, Date,
// accessors, etc.) rather than silently deleting/changing restored state.
// The contract's optional schedule.last_review may explicitly be undefined;
// JSON omits that property, which is equivalent to its documented absence.
function assertJson(value: unknown, optionalSchedules: Set<object>, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid aggregate: not JSON data');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid aggregate: non-JSON object');
  ancestors.add(value);
  if (array && Object.keys(value).length !== value.length) throw new Error('Invalid aggregate: sparse or extended array');
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid aggregate: non-JSON property');
    if (key === 'last_review' && descriptor.value === undefined && optionalSchedules.has(value)) continue;
    assertJson(descriptor.value, optionalSchedules, ancestors);
  }
  ancestors.delete(value);
}

export function validateData(value: unknown, mode: Mode, ownerId: string): asserts value is AppData {
  const parsed = appDataSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid aggregate: ${parsed.error.message}`);
  const data = value as AppData;
  const optionalSchedules = new Set<object>([
    ...Object.values(data.cards).map((card) => card.schedule),
    ...Object.values(data.reviewEvents).flatMap((event) => [event.before, event.after]),
  ]);
  assertJson(value, optionalSchedules);
  if (data.mode !== mode) throw new Error(`Database mode mismatch: expected ${mode}, got ${data.mode}`);
  if (data.ownerId !== ownerId) throw new Error('Database ownerId mismatch');
  for (const map of entityMaps) {
    for (const [key, entity] of Object.entries(data[map])) {
      if (entity.id !== key) throw new Error(`Invalid aggregate: ${map}.${key} id mismatch`);
    }
  }
  for (const receipt of Object.values(data.receipts)) {
    if (!Object.hasOwn(receipt, 'result')) throw new Error('Invalid aggregate: receipt.result is required');
  }
  const availableVersions = new Map<string, Set<number>>();
  for (const knowledge of Object.values(data.knowledge)) {
    const history = knowledge.contentHistory ?? [];
    const currentVersion = knowledge.contentVersion;
    if (history.length && currentVersion === undefined) throw new Error('Invalid aggregate: knowledge content history requires contentVersion');
    const versions = new Set<number>();
    let previousVersion = 0;
    for (const entry of history) {
      if (entry.version <= previousVersion) throw new Error('Invalid aggregate: knowledge content history versions must be strictly increasing');
      if (currentVersion !== undefined && entry.version > currentVersion) throw new Error('Invalid aggregate: future knowledge content history version');
      if (entry.version === currentVersion && (
        entry.title !== knowledge.title || entry.description !== knowledge.description ||
        entry.sourceIds.length !== knowledge.sourceIds.length || entry.sourceIds.some((sourceId, index) => sourceId !== knowledge.sourceIds[index])
      )) throw new Error('Invalid aggregate: current knowledge content history does not match content');
      previousVersion = entry.version;
      versions.add(entry.version);
    }
    if (currentVersion !== undefined) versions.add(currentVersion);
    availableVersions.set(knowledge.id, versions);
  }
  function checkReference(knowledgeId: string | null, referencedVersion?: number | null) {
    // Missing/null legacy versions stay unknown. Never infer them from today's
    // content version or from the unrelated optimistic-lock version counter.
    if (referencedVersion == null) return;
    if (knowledgeId === null || !availableVersions.get(knowledgeId)?.has(referencedVersion)) {
      throw new Error('Invalid aggregate: unknown knowledge content version reference');
    }
  }
  for (const session of Object.values(data.sessions)) {
    const relatedIds = new Set<string>();
    for (const related of session.relatedKnowledge ?? []) {
      checkReference(related.id, related.knowledgeVersion);
      if (relatedIds.has(related.id)) throw new Error('Invalid aggregate: duplicate related knowledge');
      relatedIds.add(related.id);
      const knowledge = data.knowledge[related.id];
      const snapshot = knowledge?.contentHistory?.find(item => item.version === related.knowledgeVersion)
        ?? (knowledge?.contentVersion === related.knowledgeVersion ? knowledge : undefined);
      if (!snapshot || snapshot.title !== related.title || snapshot.description !== related.description ||
        JSON.stringify(snapshot.sourceIds) !== JSON.stringify(related.sourceIds)) {
        throw new Error('Invalid aggregate: related knowledge snapshot does not match referenced content version');
      }
    }
    for (const candidate of session.candidates) checkReference(candidate.knowledgeId ?? candidate.existingKnowledgeId, candidate.knowledgeVersion);
  }
  for (const quiz of Object.values(data.quizzes)) {
    for (const question of quiz.questions) {
      checkReference(question.knowledgeId, question.knowledgeVersion);
      const answer = quiz.answers[question.id];
      if (answer?.execution && (answer.skipped || !executionFitsQuestion(question, answer.execution))) throw new Error('Invalid aggregate: execution does not match question');
    }
  }
  for (const evidence of Object.values(data.evidence)) checkReference(evidence.knowledgeId, evidence.knowledgeVersion);
  for (const run of Object.values(parsed.data.runs)) {
    if (run.task.kind === 'followup' || run.task.kind === 'quiz') {
      for (const point of run.task.points) checkReference(point.id, point.knowledgeVersion);
      for (const point of run.task.related ?? []) checkReference(point.id, point.knowledgeVersion);
    } else if (run.task.kind === 'grade') {
      checkReference(run.task.question.knowledgeId, run.task.question.knowledgeVersion);
      if (run.task.execution && !executionFitsQuestion(run.task.question, run.task.execution)) throw new Error('Invalid aggregate: grade execution does not match question');
    }
  }
}
