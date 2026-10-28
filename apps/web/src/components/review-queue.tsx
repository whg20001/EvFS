'use client';
import { Feedback } from './feedback';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentKnowledgeId, type PublicState, type ReviewPlan } from '@sanxing/contracts';
import { useApp, useData } from './store';
import { Action } from './ui';

export function PersonalizedReviewQueue({ dueIds }: { dueIds: string[] }) {
  const data = useData(); const { api, reload } = useApp();
  const [plan, setPlan] = useState<ReviewPlan | null>(null); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const supported = data.capabilities.historyDetails === 'on-demand';
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController(); setPlan(null); setError('');
    void api<ReviewPlan>('/reviews/plan', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setPlan(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '队列加载失败'); });
    return () => controller.abort();
  }, [api, supported, data.revision, retry]);
  if (!supported) return <ReviewQueue startIds={dueIds} />;
  if (error) return <div><Feedback title="操作提示" tone="error">{error}</Feedback><Action onClick={() => setRetry(value => value + 1)}>重新加载复习队列</Action></div>;
  if (plan && plan.revision !== data.revision) return <div><p>队列依据已变化，请刷新后开始。</p><Action onClick={reload}>刷新复习计划</Action></div>;
  if (!plan) return <p role="status">正在整理复习队列…</p>;
  return <div className="stack compact"><ReviewQueue startIds={plan.cards.map(card => card.id)} /><p className="small muted">{plan.order === 'due' ? '到期时间优先' : '近期失分优先'} · 本轮 {plan.cards.length} / {plan.totalDue} 张</p><details><summary>查看本轮顺序依据</summary>{plan.cards.map(item => {
    const card = data.cards.find(card => card.id === item.id);
    return <p className="small" key={item.id}>{data.knowledge.find(point => point.id === (card ? currentKnowledgeId(card) : ''))?.title}：{item.reason}</p>;
  })}</details></div>;
}

// One explicitly started queue per tab. No automatic model calls or schedule writes.
const KEY = 'sanxing:review-queue';
interface Queue { startedAt: string; cardIds: string[]; visited: string[]; currentSessionId: string | null }
function readQueue(key = KEY): Queue | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Queue | null;
    if (!value || !Array.isArray(value.cardIds) || !Array.isArray(value.visited) || !value.cardIds.every(id => typeof id === 'string') || !value.visited.every(id => typeof id === 'string') || !Number.isFinite(Date.parse(value.startedAt)) || (value.currentSessionId !== null && typeof value.currentSessionId !== 'string')) return null;
    return value;
  } catch { return null; }
}
function nextCard(queue: Queue, data: PublicState) {
  return queue.cardIds.find(id => !queue.visited.includes(id) && data.cards.some(card => card.id === id && !card.retiredAt && !card.pausedAt && !data.knowledge.find(point => point.id === currentKnowledgeId(card))?.archivedAt)
    && !data.reviewSessions.some(review => review.cardId === id && review.status === 'COMPLETED' && review.completedAt && review.completedAt >= queue.startedAt));
}
export function ReviewQueue({ startIds, sessionId }: { startIds?: string[]; sessionId?: string }) {
  const { command, setError, user } = useApp(); const data = useData(); const router = useRouter();
  const key = user ? `${KEY}:${user.id}` : KEY;
  const [finished, setFinished] = useState(false);
  async function advance() {
    const previous = readQueue(key);
    const queue: Queue = startIds ? { startedAt: new Date().toISOString(), cardIds: [...startIds], visited: [], currentSessionId: null } : previous ?? { startedAt: '', cardIds: [], visited: [], currentSessionId: null };
    if (!startIds && (!previous || previous.currentSessionId !== sessionId)) { setFinished(true); return; }
    const next = nextCard(queue, data);
    if (!next) { sessionStorage.removeItem(key); setFinished(true); return; }
    // Verify storage before creating a session; a disabled storage policy should not silently lose the queue.
    try { sessionStorage.setItem(key, JSON.stringify(queue)); } catch { setError('浏览器无法保存连续复习队列，请使用单卡复习。'); return; }
    const { result } = await command(`/reviews/${encodeURIComponent(next)}/start`);
    const id = result.reviewSessionId;
    if (!id) return;
    try { sessionStorage.setItem(key, JSON.stringify({ ...queue, visited: [...queue.visited, next], currentSessionId: id })); }
    catch { setError('单卡复习已创建，但浏览器未能保存队列进度；可在复习计划中继续这张卡片。'); }
    router.push(`/review-sessions/${id}`);
  }
  if (startIds) return <Action variant="primary" disabled={!startIds.length} onClick={advance}>开始连续复习（{startIds.length} 张）</Action>;
  if (finished) return <p role="status">本轮队列已结束，可返回复习计划开始新一轮。</p>;
  const queue = typeof window === 'undefined' ? null : readQueue(key);
  if (!queue || queue.currentSessionId !== sessionId) return null;
  return <div className="stack compact"><p className="small muted">本轮已开始 {queue.visited.length} / {queue.cardIds.length} 张。暂停、归档或已完成的卡片会跳过；每张卡仍需主动提交回忆。</p><Action variant="primary" onClick={advance}>继续下一张复习卡</Action></div>;
}
