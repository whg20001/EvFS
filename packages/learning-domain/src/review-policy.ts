import type { Answer } from '@sanxing/contracts';
export const REVIEW_ALGORITHM = 'ts-fsrs@5.4.2/default-retention-0.9/no-fuzz/no-short-term/mapping-v1';
export function independentAssessment(answer: Answer): boolean {
  return answer.assessment.status === 'graded' && answer.assessment.score !== null && answer.assessment.maxScore > 0
    && answer.assessment.source !== 'manual' && (!answer.dispute || Boolean(answer.dispute.resolvedAt)) && !answer.assisted && !answer.skipped;
}
/** Existing mapping-v1: any partial independent answer is Again; no eligible answers means no event. */
export function reviewRating(answers: Answer[], requested: 1 | 2 | 3 | 4): { rating: 1 | 2 | 3 | 4; reviewedAt: string } | null {
  const independent = answers.filter(independentAssessment);
  if (!independent.length) return null;
  return { rating: independent.some(answer => answer.assessment.score! < answer.assessment.maxScore) ? 1 : requested,
    reviewedAt: independent.map(answer => answer.submittedAt).sort().at(-1)! };
}
