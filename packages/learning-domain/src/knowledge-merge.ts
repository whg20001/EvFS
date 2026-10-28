import { currentKnowledgeId, isActiveRun, LIMITS, type AppData, type KnowledgePoint, type KnowledgeMergePreview } from '@sanxing/contracts';
import { record, requireThat } from './policy.ts';

export function contentBaseline(point: KnowledgePoint, stamp: string) {
  point.contentVersion ??= 1;
  point.contentHistory ??= [];
  if (!point.contentHistory.some(snapshot => snapshot.version === point.contentVersion)) point.contentHistory.push({ version: point.contentVersion, title: point.title, description: point.description, sourceIds: [...point.sourceIds], createdAt: stamp });
}
export function resolvedKnowledgeId(data: Pick<AppData, 'knowledge'>, id: string): string {
  const seen = new Set<string>();
  while (data.knowledge[id]?.merge) {
    requireThat(!seen.has(id), 'INVALID_MERGE', '知识合并关系存在循环');
    seen.add(id); id = data.knowledge[id]!.merge!.targetId;
  }
  return id;
}
export function previewKnowledgeMerge(data: AppData, sourceId: string, targetId: string): KnowledgeMergePreview {
  const source = record(data.knowledge, sourceId); const target = record(data.knowledge, targetId);
  requireThat(sourceId !== targetId && !source.merge && !target.merge, 'INVALID_MERGE', '请选择两个尚未合并的不同知识点');
  requireThat(!source.archivedAt && !target.archivedAt, 'KNOWLEDGE_ARCHIVED', '请先恢复两个知识点，再预览合并');
  const involved = new Set(Object.keys(data.knowledge).filter(id => [sourceId, targetId].includes(resolvedKnowledgeId(data, id))));
  requireThat(!Object.values(data.runs).some(isActiveRun), 'RUN_IN_PROGRESS', '请先完成或取消活动任务，再合并知识');
  requireThat(!Object.values(data.sessions).some(session => session.status !== 'COMPLETED' && (session.candidates.some(c => [c.knowledgeId, c.existingKnowledgeId].some(id => id && involved.has(id))) || session.relatedKnowledge?.some(point => involved.has(point.id)))), 'SESSION_IN_PROGRESS', '请先结束关联这两个知识点的学习会话');
  const allCards = Object.values(data.cards).filter(card => involved.has(currentKnowledgeId(card)));
  const cardIds = new Set(allCards.map(card => card.id));
  requireThat(!Object.values(data.reviewSessions).some(review => cardIds.has(review.cardId) && !['COMPLETED', 'ABANDONED'].includes(review.status)), 'REVIEW_IN_PROGRESS', '请先完成或放弃关联卡片正在进行的复习');
  const tags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])];
  requireThat(tags.length <= LIMITS.knowledgeTagsMaximum, 'MERGE_TAG_LIMIT', '合并后标签过多，请先编辑标签再合并');
  return { revision: data.revision, sourceId, targetId, sourceIds: [...new Set([...target.sourceIds, ...source.sourceIds])], tags,
    evidenceCount: Object.values(data.evidence).filter(item => involved.has(item.knowledgeId)).length,
    sessionCount: Object.values(data.sessions).filter(session => session.candidates.some(c => c.knowledgeId && involved.has(c.knowledgeId))).length,
    cards: allCards.filter(card => !card.retiredAt) };
}
export function applyKnowledgeMerge(data: AppData, preview: KnowledgeMergePreview, retainedCardId: string | null, stamp: string) {
  requireThat(preview.cards.length ? preview.cards.some(card => card.id === retainedCardId) : retainedCardId === null, 'MERGE_CARD_REQUIRED', '必须明确保留其中一张现有复习卡；没有卡片时选择不创建');
  const source = record(data.knowledge, preview.sourceId); const target = record(data.knowledge, preview.targetId);
  contentBaseline(source, stamp); contentBaseline(target, stamp);
  if (JSON.stringify(target.sourceIds) !== JSON.stringify(preview.sourceIds)) {
    target.sourceIds = preview.sourceIds; target.contentVersion!++; contentBaseline(target, stamp);
  }
  target.tags = preview.tags; target.version++; target.updatedAt = stamp;
  source.merge = { targetId: target.id, mergedAt: stamp, retainedCardId }; source.archivedAt = stamp; source.version++; source.updatedAt = stamp;
  for (const card of preview.cards) {
    if (card.id === retainedCardId) card.currentKnowledgeId = target.id;
    else card.retiredAt = stamp;
    card.version++;
  }
  return { id: target.id, version: target.version };
}
