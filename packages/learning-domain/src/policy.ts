import { DEFAULT_CODE_LANGUAGES } from '@sanxing/contracts';
import { createHash } from 'node:crypto';
import { createEmptyCard, fsrs } from 'ts-fsrs';
import type { Card, Grade, State } from 'ts-fsrs';
import type { AppData, LearningPreferences, Mode, PublicQuiz, PublicState, Quiz, SerializedCard } from '@sanxing/contracts';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'DomainError'; }
}
export function requireThat(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export function record<T>(map: Record<string, T>, id: string): T {
  requireThat(Object.hasOwn(map, id), 'NOT_FOUND', '记录不存在或不可访问', 404);
  return map[id]!;
}
export function expectVersion(entity: { version: number }, version: number) {
  requireThat(entity.version === version, 'VERSION_CONFLICT', '内容已发生变化，请刷新后重试');
}
export function learningDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, canonical(val)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function normalizeTitle(title: string) { return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
export function serializeCard(card: Card): SerializedCard { return { ...card, due: card.due.toISOString(), ...(card.last_review ? { last_review: card.last_review.toISOString() } : { last_review: undefined }) }; }
export function newSchedule(now: Date): SerializedCard { return serializeCard(createEmptyCard(new Date(now.getTime() + 86_400_000))); }
export function nextSchedule(card: SerializedCard, now: Date, rating: 1 | 2 | 3 | 4): SerializedCard {
  const hydrated: Card = { ...card, state: card.state as State, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined };
  const scheduler = fsrs({ enable_fuzz: false, enable_short_term: false, request_retention: 0.9 });
  return serializeCard(scheduler.next(hydrated, now, rating as Grade).card);
}
export function currentQuestionIndex(quiz: Quiz): number {
  const index = quiz.questions.findIndex(q => !quiz.answers[q.id] || quiz.answers[q.id]?.assessment.status === 'pending');
  return index < 0 ? quiz.questions.length : index;
}
export function publicQuiz(quiz: Quiz): PublicQuiz {
  const currentIndex = currentQuestionIndex(quiz);
  return { id: quiz.id, sessionId: quiz.sessionId, reviewSessionId: quiz.reviewSessionId, version: quiz.version, questionCount: quiz.questions.length, currentIndex, submittedAt: quiz.submittedAt,
    questions: quiz.questions.filter((q, index) => quiz.answers[q.id] || index === currentIndex).map(q => ({ id: q.id, knowledgeId: q.knowledgeId, kind: q.kind, prompt: q.prompt, options: q.options, ...(q.code ? { code: q.code } : {}), draft: quiz.drafts[q.id] ?? '', hasDraft: Object.hasOwn(quiz.drafts, q.id), answer: quiz.answers[q.id] ?? null, explanation: quiz.answers[q.id] ? q.referenceAnswer : null })) };
}
export interface DomainConfig {
  mode: Mode; timezone: string; maxUploadBytes: number; maxDocuments: number; maxFollowups: number; quizCount: number;
  schedulingEnabled: boolean; maxCallsPerSession: number; dailyBudgetUsd: number | null; requestReservationUsd: number; runTimeoutMs: number;
}
export function effectiveLearningPreferences(data: AppData, config: Pick<DomainConfig, 'schedulingEnabled'>): Required<LearningPreferences> {
  const saved = data.learningPreferences;
  return { schedulingEnabled: saved?.schedulingEnabled ?? config.schedulingEnabled, promptCacheRetention: saved?.promptCacheRetention ?? 'none', associationEnabled: saved?.associationEnabled ?? false,
    codeExercisesEnabled: saved?.codeExercisesEnabled ?? false, codeLanguages: saved?.codeLanguages ?? [...DEFAULT_CODE_LANGUAGES] };
}
export function projectState(data: AppData, config: DomainConfig, csrfToken: string): PublicState {
  return { mode: data.mode, timezone: config.timezone, revision: data.revision, csrfToken,
    capabilities: { maxUploadBytes: config.maxUploadBytes, maxDocuments: config.maxDocuments, maxFollowups: config.maxFollowups, quizCount: config.quizCount, schedulingEnabled: effectiveLearningPreferences(data, config).schedulingEnabled },
    recitations: Object.values(data.recitations), documents: Object.values(data.documents).map(d => ({ id: d.id, recitationId: d.recitationId, name: d.name, textLength: d.text.length, lineCount: d.lineCount, createdAt: d.createdAt })),
    sessions: Object.values(data.sessions), knowledge: Object.values(data.knowledge), quizzes: Object.values(data.quizzes).map(publicQuiz), cards: Object.values(data.cards), reviewSessions: Object.values(data.reviewSessions), reviewEvents: Object.values(data.reviewEvents), evidence: Object.values(data.evidence),
    runs: Object.values(data.runs).map(r => ({ id: r.id, status: r.status, kind: r.task.kind, sessionId: r.sessionId, reviewSessionId: r.reviewSessionId, error: r.error, createdAt: r.createdAt })) };
}
