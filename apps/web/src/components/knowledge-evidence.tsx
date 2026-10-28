'use client';
import { Feedback } from './feedback';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Evidence, EvidencePage } from '@sanxing/contracts';
import { useApp, useData, dateLabel } from './store';
import { Action, Badge, Card, Empty, EvidenceLabel, Sources } from './ui';
import { AssessmentDetails } from './assessment';
import { errorMessage } from '../lib/api-client';

export function KnowledgeEvidence({ id }: { id: string }) {
  const data = useData(); const { api } = useApp();
  const [page, setPage] = useState<EvidencePage | null>(null); const [offset, setOffset] = useState(0);
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const compact = data.capabilities.historyDetails === 'on-demand';
  useEffect(() => {
    if (!compact) return;
    const controller = new AbortController(); setError(''); setPage(null);
    void api<EvidencePage>(`/knowledge-points/${id}/evidence?offset=${offset}&expectedRevision=${data.revision}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '证据加载失败')); });
    return () => controller.abort();
  }, [api, id, offset, compact, data.revision, retry]);
  const evidence = compact ? page?.items ?? [] : data.evidence.filter((item): item is Evidence => item.knowledgeId === id && !('summary' in item));
  return <Card title="作答证据" caption="即时考核与延迟回忆分别呈现；合并知识的历史仍标明原知识点和内容版本。模拟记录不构成真实学习评价。">
    {error ? <><Feedback title="操作提示" tone="error">{error}</Feedback><Action onClick={() => { setOffset(0); setRetry(value => value + 1); }}>重新加载证据</Action></> : compact && !page ? <p role="status">正在加载作答证据…</p> : evidence.length ? <div className="stack">{evidence.map(item => {
      const point = data.knowledge.find(point => point.id === item.knowledgeId); const snapshot = point?.contentHistory?.find(entry => entry.version === item.knowledgeVersion);
      return <div className="evidence-item" key={item.id}><div className="row between wrap"><div className="tag-list"><Badge>{item.dimension === 'delayed' ? '延迟回忆' : '即时考核'}</Badge><Badge>{item.answer.assisted ? '辅助作答' : '自报独立作答'}</Badge></div><EvidenceLabel {...item.answer.assessment} simulated={item.simulated} /></div>
        {point && <Link href={`/knowledge/${point.id}`}>原知识：{point.title}</Link>}<p className="small muted">证据依据：{item.knowledgeVersion == null ? '内容版本未知（旧记录），不以当前内容代替当时依据。' : `内容版本 ${item.knowledgeVersion}`}</p>
        {snapshot && <details><summary>查看本条证据的内容快照</summary><h3>{snapshot.title}</h3><p className="prose">{snapshot.description}</p><Sources ids={snapshot.sourceIds} /></details>}
        {item.knowledgeVersion != null && !snapshot && <p className="small muted">该版本快照不可用，不以当前内容代替当时依据。</p>}
        <p className="prose">{item.answer.text || (item.answer.skipped ? '已跳过' : '单选作答已记录')}</p><p className="muted prose">{item.answer.assessment.feedback || '评价尚未完成。'}</p>{item.answer.dispute && !item.answer.dispute.resolvedAt && <Badge tone="amber">评价有争议，待核对</Badge>}<AssessmentDetails assessment={item.answer.assessment} /><div className="row between"><span className="small muted">{dateLabel(item.answer.submittedAt, data.timezone)}</span><Link className="text-button" href={`/quizzes/${item.quizId}/result#question-${item.questionId}`}>查看原题与结果</Link></div></div>;
    })}</div> : <Empty title="掌握情况，待评估">还没有这个知识点的有效作答证据。</Empty>}
    {page && page.total > 20 && <div className="row wrap"><span>共 {page.total} 条 · 第 {Math.floor(offset / 20) + 1} 页</span><Action disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页证据</Action><Action disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>下一页证据</Action></div>}
  </Card>;
}
