import { z } from 'zod';
import { imageImportSchema, learningSkillsSchema, storedAiTaskSchema as task, sourceInputSchema as source, pointInputSchema as point, turnSchema as turn, taskQuestionSchema as question } from '@sanxing/contracts';
import { connectionPolicySchema, runTransportSchema, runErrorCodeSchema, runProgressSchema, runRequestSchema, promptHashSchema, LIMITS, aiOutputSchema, aiModelSelectionSchema, candidateSchema, codeExecutionSchema, executionFitsQuestion, learningPreferencesSchema, recitationInputSchema, usageSchema } from '@sanxing/contracts';
import type { AppData, Mode } from '@sanxing/contracts';

const id = z.string().min(1);
const integer = z.number().int().nonnegative();
const version = z.number().int().positive();
const date = z.iso.datetime({ offset: true });
const nullableId = id.nullable();
const ids = z.array(id);
const knowledgeVersion = point.shape.knowledgeVersion;
const contentVersion = z.object({ version, title: z.string(), description: z.string(), sourceIds: ids, createdAt: date });
const usage = usageSchema;
const assessment = z.object({ status: z.enum(['pending', 'graded', 'needs_verification', 'skipped']), score: z.number().nullable(), maxScore: z.number().nonnegative(), feedback: z.string(), assessedAt: date.nullable(), version, scores: z.array(z.object({ rubricId: id, description: z.string(), maxScore: z.number().positive(), score: z.number().nonnegative(), evidence: z.string().min(1) })).optional(), source: z.enum(['model', 'manual', 'automatic']).optional(), reason: z.string().optional() });
const answer = z.object({ text: z.string(), selectedIndex: integer.nullable(), assisted: z.boolean(), skipped: z.boolean(), submittedAt: date, assessment, execution: z.optional(codeExecutionSchema), assessmentHistory: z.array(assessment).optional(), dispute: z.object({ reason: z.string().min(1), createdAt: date, resolvedAt: date.nullable() }).optional() });
const schedule = z.object({ due: date, stability: z.number(), difficulty: z.number(), elapsed_days: z.number(), scheduled_days: z.number(), reps: integer, lapses: integer, state: integer, learning_steps: integer, last_review: date.optional() });
const record = <T extends z.ZodType>(value: T) => z.record(id, value);

const appDataSchema = z.strictObject({
  schemaVersion: z.literal(1), ownerId: id, mode: z.enum(['mock', 'live']), revision: integer.max(2_147_483_647),
  aiModel: aiModelSelectionSchema.nullable().optional(),
  learningPreferences: learningPreferencesSchema.strict().optional(),
  skills: learningSkillsSchema.optional(),
  recitations: record(recitationInputSchema.extend({ id, learningDate: z.iso.date(), version, documentIds: ids, createdAt: date, updatedAt: date })),
  documents: record(source.extend({ recitationId: id, hash: z.string(), lineCount: integer, createdAt: date, originalBase64: z.string(), import: z.union([imageImportSchema, z.object({ format: z.literal('pdf'), parser: z.string().min(1), pages: z.array(z.object({ page: version, startLine: version, endLine: version, hasText: z.boolean() })).min(1).max(LIMITS.pdfPages) })]).optional() })),
  sessions: record(z.object({
    id, recitationId: id, snapshot: recitationInputSchema, documentIds: ids, scopeVersion: version, version,
    status: z.enum(['CONFIRMING', 'CLARIFYING', 'QUIZ_READY', 'QUIZZING', 'COMPLETED']),
    candidates: z.array(candidateSchema.extend({ id, decision: z.enum(['pending', 'accepted', 'rejected']), existingKnowledgeId: nullableId, knowledgeId: nullableId, knowledgeVersion })),
    turns: z.array(turn), quizId: nullableId, activeRunId: nullableId,
    relatedKnowledge: z.array(point.extend({ knowledgeVersion: version })).max(LIMITS.relatedKnowledgeMaximum).optional(),
    completionReason: z.enum(['assessed', 'no_quiz', 'user_ended']).nullable(), createdAt: date, completedAt: date.nullable(),
  })),
  knowledge: record(point.omit({ knowledgeVersion: true }).extend({ version, contentVersion: version.optional(), contentHistory: z.array(contentVersion).optional(), understanding: z.string(), merge: z.object({ targetId: id, mergedAt: date, retainedCardId: nullableId }).strict().optional(), archivedAt: date.nullable().optional(), tags: z.array(z.string().min(1).max(LIMITS.knowledgeTagChars)).max(LIMITS.knowledgeTagsMaximum).optional(), createdAt: date, updatedAt: date })),
  quizzes: record(z.object({ id, sessionId: nullableId, reviewSessionId: nullableId, scopeVersion: version, version, questions: z.array(question.safeExtend({ id })), answers: record(answer), drafts: record(z.string()), submittedAt: date.nullable(), createdAt: date })),
  cards: record(z.object({ id, knowledgeId: id, version, schedule, createdAt: date, pausedAt: date.nullable().optional(), currentKnowledgeId: id.optional(), retiredAt: date.optional() })),
  reviewSessions: record(z.object({ id, cardId: id, expectedCardVersion: version, version, status: z.enum(['RECALLING', 'QUIZ_READY', 'QUIZZING', 'READY_TO_COMPLETE', 'COMPLETED', 'ABANDONED']), recall: z.string(), recallSubmittedAt: date.nullable(), quizId: nullableId, activeRunId: nullableId, createdAt: date, completedAt: date.nullable() })),
  reviewEvents: record(z.object({ id, reviewSessionId: id, cardId: id, rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), reviewedAt: date, before: schedule, after: schedule, algorithm: z.string(), simulated: z.boolean() })),
  evidence: record(z.object({ id, knowledgeId: id, knowledgeVersion, quizId: id, questionId: id, answer, dimension: z.enum(['immediate', 'delayed']), simulated: z.boolean() })),
  runs: record(z.object({ id, status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']), task, sessionId: nullableId, reviewSessionId: nullableId, quizId: nullableId, questionId: nullableId, attempt: integer, attemptId: nullableId, expectedVersion: integer, createdAt: date, startedAt: date.nullable(), finishedAt: date.nullable(), error: z.string().nullable(), usage: usage.nullable(), reservationUsd: z.number().nonnegative(), promptVersion: z.string(), promptHash: promptHashSchema.optional(), errorCode: runErrorCodeSchema.optional(), progress: runProgressSchema.optional(), request: runRequestSchema.optional(), transport: runTransportSchema.optional(), inputPrepared: z.boolean().optional(), evaluation: z.object({ suite: id, caseId: id, batchId: z.uuid(), selection: aiModelSelectionSchema, connectionPolicy: connectionPolicySchema.optional(), output: aiOutputSchema.optional() }).optional(), assessmentRevision: z.object({ expectedVersion: version, reason: z.string().min(1).max(LIMITS.assessmentReasonChars) }).optional() })),
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
  for (const document of Object.values(data.documents)) if (document.import?.format === 'pdf') {
    let line = 1;
    for (const [index, page] of document.import.pages.entries()) {
      if (page.page !== index + 1 || page.startLine !== line || page.endLine < page.startLine || page.endLine > document.lineCount) throw new Error('Invalid aggregate: PDF page mapping');
      line = page.endLine + 1;
    }
    if (line !== document.lineCount + 1 || document.text.split('\n').length !== document.lineCount) throw new Error('Invalid aggregate: PDF line count');
  }
  for (const point of Object.values(data.knowledge)) if (point.merge) {
    if (!point.archivedAt || (point.merge.retainedCardId && !Object.hasOwn(data.cards, point.merge.retainedCardId))) throw new Error('Invalid aggregate: merged knowledge metadata');
    const seen = new Set([point.id]); let targetId = point.merge.targetId;
    for (;;) {
      const target = Object.hasOwn(data.knowledge, targetId) ? data.knowledge[targetId] : undefined;
      if (!target || seen.has(targetId)) throw new Error('Invalid aggregate: missing or cyclic merge target');
      seen.add(targetId);
      if (!target.merge) break;
      targetId = target.merge.targetId;
    }
    if (point.merge.retainedCardId) {
      let knowledgeId = data.cards[point.merge.retainedCardId]!.knowledgeId;
      const visited = new Set<string>();
      while (data.knowledge[knowledgeId]?.merge && !visited.has(knowledgeId)) {
        visited.add(knowledgeId); knowledgeId = data.knowledge[knowledgeId]!.merge!.targetId;
      }
      if (knowledgeId !== targetId) throw new Error('Invalid aggregate: retained card outside merged knowledge family');
    }
  }
  for (const card of Object.values(data.cards)) if (card.currentKnowledgeId) {
    if (!Object.hasOwn(data.knowledge, card.knowledgeId) || !Object.hasOwn(data.knowledge, card.currentKnowledgeId)) throw new Error('Invalid aggregate: unknown card knowledge');
    const seen = new Set<string>(); let id = card.knowledgeId;
    while (data.knowledge[id]?.merge && !seen.has(id)) { seen.add(id); id = data.knowledge[id]!.merge!.targetId; }
    if (!card.retiredAt && id !== card.currentKnowledgeId) throw new Error('Invalid aggregate: card merge target mismatch');
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
      if (answer) {
        const history = answer.assessmentHistory ?? [];
        let previous = 0;
        for (const entry of [...history, answer.assessment]) {
          if (entry.version <= previous) throw new Error('Invalid aggregate: assessment versions must increase');
          previous = entry.version;
          if (entry.scores !== undefined) {
            const scores = entry.scores;
            if (entry.status !== 'graded' ? scores.length > 0 : scores.length !== question.rubric.length || new Set(scores.map(item => item.rubricId)).size !== scores.length || scores.reduce((sum, item) => sum + item.score, 0) !== entry.score) throw new Error('Invalid aggregate: assessment score total mismatch');
            for (const item of scores) {
              const row = question.rubric.find(row => row.id === item.rubricId);
              if (!row || row.description !== item.description || row.maxScore !== item.maxScore || item.score > row.maxScore) throw new Error('Invalid aggregate: assessment rubric mismatch');
            }
          }
        }
      }
    }
  }
  for (const evidence of Object.values(data.evidence)) checkReference(evidence.knowledgeId, evidence.knowledgeVersion);
  for (const run of Object.values(parsed.data.runs)) {
    if (run.evaluation) {
      if (run.sessionId || run.reviewSessionId || run.quizId || run.questionId || run.assessmentRevision || (run.evaluation.output && run.evaluation.output.kind !== run.task.kind)) throw new Error('Invalid aggregate: evaluation has business ownership or mismatched output');
      continue; // Synthetic knowledge IDs are intentionally outside the personal library.
    }
    if (run.assessmentRevision && (run.task.kind !== 'grade' || !run.quizId || !run.questionId || run.sessionId || run.reviewSessionId)) throw new Error('Invalid aggregate: invalid assessment revision ownership');
    if (run.task.kind === 'followup' || run.task.kind === 'quiz') {
      for (const point of run.task.points) checkReference(point.id, point.knowledgeVersion);
      for (const point of run.task.related ?? []) checkReference(point.id, point.knowledgeVersion);
    } else if (run.task.kind === 'grade') {
      checkReference(run.task.question.knowledgeId, run.task.question.knowledgeVersion);
      if (run.task.execution && !executionFitsQuestion(run.task.question, run.task.execution)) throw new Error('Invalid aggregate: grade execution does not match question');
    }
  }
}
