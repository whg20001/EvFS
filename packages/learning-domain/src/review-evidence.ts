import type { AppData, WeaknessCue } from '@sanxing/contracts';
import { independentAssessment } from './review-policy.ts';
import { resolvedKnowledgeId } from './knowledge-merge.ts';

const MAX_AGE_MS = 30 * 86400000;
const MAX_CUES = 3;
const MAX_WEAK_AREAS = 3;
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1; // The ellipsis is part of the UTF-16 character budget.
  if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
    && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
  return `${value.slice(0, end)}…`;
}

/**
 * Recent independent partial assessments are optional question-writing hints, never answer keys.
 * The selector deliberately excludes assisted/simulated cross-mode, manual, disputed, skipped,
 * unsubmitted, future, stale-version and fully-correct evidence.
 */
export function recentWeaknessCues(data: AppData, knowledgeId: string, now: Date): WeaknessCue[] {
  const point = data.knowledge[knowledgeId];
  if (!point || point.archivedAt) return [];
  const currentId = resolvedKnowledgeId(data, knowledgeId);
  const cutoff = now.getTime() - MAX_AGE_MS;
  const candidates = Object.values(data.evidence).flatMap(evidence => {
    const answer = evidence.answer;
    const timestamp = Date.parse(answer.submittedAt);
    if (evidence.simulated !== (data.mode === 'mock') || !data.quizzes[evidence.quizId]?.submittedAt
      || !Number.isFinite(timestamp) || timestamp > now.getTime() || timestamp < cutoff
      || !independentAssessment(answer) || answer.assessment.score! >= answer.assessment.maxScore) return [];
    const origin = data.knowledge[evidence.knowledgeId];
    if (!origin || resolvedKnowledgeId(data, origin.id) !== currentId) return [];
    // Merge membership changes the destination, not the identity of a content-version counter.
    if (evidence.knowledgeVersion != null && origin.contentVersion != null && evidence.knowledgeVersion !== origin.contentVersion) return [];
    const quiz = data.quizzes[evidence.quizId]!;
    const question = quiz.questions.find(item => item.id === evidence.questionId);
    if (!question || question.knowledgeId !== origin.id) return [];
    if (question.knowledgeVersion != null && origin.contentVersion != null && question.knowledgeVersion !== origin.contentVersion) return [];
    const assessment = answer.assessment;
    const rows = (assessment.scores ?? []).filter(row => row.score < row.maxScore)
      .sort((a, b) => a.score / a.maxScore - b.score / b.maxScore || a.rubricId.localeCompare(b.rubricId))
      .slice(0, MAX_WEAK_AREAS)
      .map(row => clip(`${row.description}: ${row.evidence || '本项未完整通过'}`, 500));
    const weakAreas = rows.length ? rows : [clip(assessment.feedback || '此前回答未获满分，具体薄弱点不确定', 800)];
    return [{ evidence, question, timestamp, cue: {
      question: clip(question.prompt, 3000), weakAreas,
      score: assessment.score!, maxScore: assessment.maxScore, dimension: evidence.dimension,
    } satisfies WeaknessCue }];
  });
  return candidates.sort((a, b) => Number(b.evidence.dimension === 'delayed') - Number(a.evidence.dimension === 'delayed')
    || a.cue.score / a.cue.maxScore - b.cue.score / b.cue.maxScore
    || b.timestamp - a.timestamp || a.evidence.id.localeCompare(b.evidence.id))
    .slice(0, MAX_CUES).map(item => item.cue);
}
