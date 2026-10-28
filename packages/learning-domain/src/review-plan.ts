import { currentKnowledgeId, type AppData, type Evidence, type ReviewPlan } from '@sanxing/contracts';
import { effectiveLearningPreferences, type DomainConfig } from './policy.ts';
import { resolvedKnowledgeId } from './knowledge-merge.ts';

/** Explicit queue preference, never an FSRS parameter fit or schedule mutation. */
export function reviewPlan(data: Pick<AppData, 'revision' | 'mode' | 'learningPreferences' | 'knowledge' | 'cards' | 'quizzes' | 'evidence'>, config: Pick<DomainConfig, 'schedulingEnabled'>, now: Date): ReviewPlan {
  const preferences = effectiveLearningPreferences(data, config);
  const groups = new Map<string, Evidence[]>(); const seen = new Set<string>();
  if (preferences.reviewOrder === 'weakness') for (const evidence of Object.values(data.evidence)) {
    const { answer } = evidence; const assessment = answer.assessment; const time = Date.parse(answer.submittedAt);
    const key = `${evidence.quizId}:${evidence.questionId}`;
    if (seen.has(key) || evidence.simulated !== (data.mode === 'mock') || !data.quizzes[evidence.quizId]?.submittedAt || time > now.getTime() || time < now.getTime() - 30 * 86400000 || answer.assisted || answer.skipped || (answer.dispute && !answer.dispute.resolvedAt) || assessment.source === 'manual' || assessment.status !== 'graded' || assessment.score === null || assessment.maxScore <= 0) continue;
    seen.add(key);
    const id = resolvedKnowledgeId(data, evidence.knowledgeId);
    const group = groups.get(id) ?? []; group.push(evidence); groups.set(id, group);
  }
  const ranked = Object.values(data.cards).filter(card => {
    const point = data.knowledge[currentKnowledgeId(card)];
    return point && !point.archivedAt && !point.merge && !card.pausedAt && !card.retiredAt && Date.parse(card.schedule.due) <= now.getTime();
  }).map(card => {
    const recent = (groups.get(currentKnowledgeId(card)) ?? []).sort((a, b) => Date.parse(b.answer.submittedAt) - Date.parse(a.answer.submittedAt) || a.id.localeCompare(b.id));
    const delayed = recent.filter(item => item.dimension === 'delayed').slice(0, 5);
    const samples = delayed.length >= 3 ? delayed : recent.filter(item => item.dimension === 'immediate').slice(0, 5);
    const enough = samples.length >= 3;
    const score = enough ? samples.reduce((sum, item) => sum + item.answer.assessment.score!, 0) / samples.reduce((sum, item) => sum + item.answer.assessment.maxScore, 0) : 1;
    const reason = preferences.reviewOrder === 'due' ? '按到期时间排序' : enough ? `近 30 天最近 ${samples.length} 次独立${samples[0]!.dimension === 'delayed' ? '延迟' : '即时'}作答得分率 ${Math.round(score * 100)}%${data.mode === 'mock' ? '（演示）' : ''}` : '近 30 天同类独立证据不足 3 次，按到期时间排序';
    return { id: card.id, due: card.schedule.due, loss: 1 - score, reason };
  }).sort((a, b) => b.loss - a.loss || Date.parse(a.due) - Date.parse(b.due) || a.id.localeCompare(b.id));
  return { revision: data.revision, order: preferences.reviewOrder, batchSize: preferences.reviewBatchSize, totalDue: ranked.length, cards: ranked.slice(0, preferences.reviewBatchSize ?? ranked.length).map(({ id, reason }) => ({ id, reason })) };
}
