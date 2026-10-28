import type { ReviewCard } from './index.ts';

/** Original knowledgeId remains the identity of historical card events. */
export const currentKnowledgeId = (card: Pick<ReviewCard, 'knowledgeId' | 'currentKnowledgeId'>) => card.currentKnowledgeId ?? card.knowledgeId;
export interface KnowledgeMergePreview {
  revision: number;
  sourceId: string;
  targetId: string;
  sourceIds: string[];
  tags: string[];
  evidenceCount: number;
  sessionCount: number;
  cards: ReviewCard[];
}
export interface ReviewPlan {
  revision: number;
  order: 'due' | 'weakness';
  batchSize: number | null;
  totalDue: number;
  cards: { id: string; reason: string }[];
}
