import { currentKnowledgeId } from '@sanxing/contracts';
import type { AppData, LearningStatistics } from '@sanxing/contracts';
import { learningDateFormatter } from './policy.ts';

const dateOffset = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** Read-only projection. Dates use the owner's timezone; scores use current evidence, not superseded history. */
export function learningStatistics(data: Pick<AppData, 'revision' | 'mode' | 'knowledge' | 'evidence' | 'quizzes' | 'cards' | 'reviewSessions' | 'reviewEvents'>, now: Date, timezone: string, days: 7 | 30 | 90 | 0 = 30): LearningStatistics {
  const dateAt = learningDateFormatter(timezone);
  const today = dateAt(now);
  const fromDate = days ? dateOffset(today, 1 - days) : null;
  const inRange = (stamp: string) => {
    const date = dateAt(new Date(stamp));
    return date <= today && (!fromDate || date >= fromDate) && Date.parse(stamp) <= now.getTime();
  };
  const result: LearningStatistics = { revision: data.revision, fromDate, throughDate: today, timezone, simulated: data.mode === 'mock', total: 0,
    categories: { independent: 0, assisted: 0, skipped: 0, pending: 0, verification: 0, manual: 0 },
    performance: { immediate: { count: 0, fullScore: 0, score: 0, maxScore: 0 }, delayed: { count: 0, fullScore: 0, score: 0, maxScore: 0 } },
    records: [], losses: [], due: { overdue: 0, days: Array.from({ length: 7 }, (_, index) => ({ date: dateOffset(today, index), count: 0 })), later: 0, paused: 0, archived: 0 }, reviews: { completed: 0, scheduled: 0, abandoned: 0 } };
  const lossGroups = new Map<string, LearningStatistics['losses'][number]>();
  const seen = new Set<string>();
  for (const evidence of Object.values(data.evidence)) {
    const { answer } = evidence; const assessment = answer.assessment;
    const key = `${evidence.quizId}:${evidence.questionId}`;
    if (seen.has(key) || evidence.simulated !== result.simulated || !data.quizzes[evidence.quizId]?.submittedAt || !inRange(answer.submittedAt)) continue;
    seen.add(key);
    const category = answer.skipped || assessment.status === 'skipped' ? 'skipped'
      : (answer.dispute && !answer.dispute.resolvedAt) || assessment.status === 'needs_verification' ? 'verification'
      : assessment.status === 'pending' ? 'pending'
      : assessment.source === 'manual' ? 'manual'
      : answer.assisted ? 'assisted'
      : assessment.score === null || assessment.maxScore <= 0 ? 'verification' : 'independent';
    result.categories[category]++; result.total++;
    const title = data.knowledge[evidence.knowledgeId]?.title ?? '历史知识点';
    result.records.push({ evidenceId: evidence.id, quizId: evidence.quizId, questionId: evidence.questionId, knowledgeId: evidence.knowledgeId, title, category, dimension: evidence.dimension, submittedAt: answer.submittedAt, assessmentVersion: assessment.version, score: assessment.score, maxScore: assessment.maxScore });
    if (category !== 'independent') continue;
    const performance = result.performance[evidence.dimension];
    performance.count++; performance.score += assessment.score!; performance.maxScore += assessment.maxScore;
    if (assessment.score === assessment.maxScore) performance.fullScore++;
    for (const row of assessment.scores ?? []) {
      if (row.score >= row.maxScore) continue;
      // Rubric IDs are local to a question. Group identical wording within one knowledge point, not IDs across quizzes.
      const lossKey = JSON.stringify([evidence.knowledgeId, row.description]);
      const loss = lossGroups.get(lossKey) ?? { knowledgeId: evidence.knowledgeId, title, description: row.description, count: 0, lostScore: 0, evidenceIds: [] };
      if (!loss.evidenceIds.includes(evidence.id)) { loss.count++; loss.evidenceIds.push(evidence.id); }
      loss.lostScore += row.maxScore - row.score;
      lossGroups.set(lossKey, loss);
    }
  }
  result.records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.evidenceId.localeCompare(b.evidenceId));
  result.losses = [...lossGroups.values()].sort((a, b) => b.count - a.count || b.lostScore - a.lostScore || a.knowledgeId.localeCompare(b.knowledgeId));
  for (const card of Object.values(data.cards)) {
    if (card.retiredAt) continue;
    if (data.knowledge[currentKnowledgeId(card)]?.archivedAt) { result.due.archived++; continue; }
    if (card.pausedAt) { result.due.paused++; continue; }
    const date = dateAt(new Date(card.schedule.due));
    if (date < today) result.due.overdue++;
    else { const bucket = result.due.days.find(day => day.date === date); if (bucket) bucket.count++; else result.due.later++; }
  }
  for (const review of Object.values(data.reviewSessions)) if (review.completedAt && inRange(review.completedAt)) {
    if (review.status === 'COMPLETED') result.reviews.completed++;
    if (review.status === 'ABANDONED') result.reviews.abandoned++;
  }
  result.reviews.scheduled = Object.values(data.reviewEvents).filter(event => event.simulated === result.simulated && inRange(event.reviewedAt)).length;
  return result;
}
