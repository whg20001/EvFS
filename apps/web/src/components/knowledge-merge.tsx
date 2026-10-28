'use client';
import { Feedback } from './feedback';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { currentKnowledgeId, type KnowledgePoint, type KnowledgeMergePreview } from '@sanxing/contracts';
import { useApp, useData, dateLabel } from './store';
import { Action, Card, Sources } from './ui';
import { useConfirm } from './confirm';
import type { ApiClient } from '../lib/api-client';

export function KnowledgeMerge({ point }: { point: KnowledgePoint }) {
  const data = useData(); const { api, command, setError } = useApp(); const confirm = useConfirm(); const router = useRouter();
  const [targetId, setTargetId] = useState(''); const [cachedPreview, setPreview] = useState<{ value: KnowledgeMergePreview; api: ApiClient } | null>(null);
  const preview = cachedPreview?.api === api ? cachedPreview.value : null;
  const [retained, setRetained] = useState('');
  if (point.merge || point.archivedAt) return null;
  const target = data.knowledge.find(item => item.id === targetId);
  const unsaved = () => {
    if (document.querySelector('[data-unsaved="true"]')) { setError('请先保存或重置未保存的编辑，再合并知识。'); return true; }
    return false;
  };
  return <Card title="合并重复知识" caption="原知识点保留为只读历史，之后的学习使用目标知识点。合并后不能在页面撤销。"><details><summary>选择目标并预览影响</summary><div className="stack compact">
    <label className="field-label">合并到<select aria-label="合并到" value={targetId} onChange={event => { setTargetId(event.target.value); setPreview(null); setRetained(''); }}><option value="">请选择保留内容的知识点</option>{data.knowledge.filter(item => item.id !== point.id && !item.archivedAt && !item.merge).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <Action disabled={!targetId} onClick={async () => {
      if (unsaved()) return;
      const next = await api<KnowledgeMergePreview>(`/knowledge-points/${point.id}/merge-preview`, { method: 'POST', body: { targetId } });
      setPreview({ value: next, api }); setRetained(next.cards.length === 1 ? next.cards[0]!.id : '');
    }}>预览知识合并</Action>
    {preview && <div className="stack compact"><p>“{point.title}”将合并到“{target?.title}”。保留目标的名称、描述和个人理解，合并来源与标签；原内容仍可通过历史链接阅读。</p><details><summary>合并后保留的知识内容</summary><h3>{target?.title}</h3><p className="prose">{target?.description}</p><p className="prose">个人理解：{target?.understanding || '暂无'}</p></details><p>{preview.sourceIds.length} 个来源 · {preview.evidenceCount} 条作答证据 · {preview.sessionCount} 次学习会话。原题、评分和复习事件继续保留原 ID 与内容版本。</p><Sources ids={preview.sourceIds} /><p>合并后的标签：{preview.tags.join('、') || '无'}</p>
      {preview.cards.length ? <><label className="field-label">保留哪张复习卡<select aria-label="保留哪张复习卡" value={retained} onChange={event => setRetained(event.target.value)}><option value="">请明确选择一张</option>{preview.cards.map(card => <option key={card.id} value={card.id}>{data.knowledge.find(item => item.id === currentKnowledgeId(card))?.title} · {dateLabel(card.schedule.due, data.timezone)}到期 · {card.schedule.reps} 次复习{card.pausedAt ? ' · 已暂停' : ''}</option>)}</select></label><p className="small muted">保留所选卡的到期时间、暂停状态及全部排期参数，其他卡永久停用并保留历史。不会平均参数或重算过去排期。</p></> : <p>没有现有复习卡，合并不会自动创建。</p>}
      {preview.revision !== data.revision && <Feedback title="操作提示" tone="error">记录已变化，请重新预览合并。</Feedback>}
      <Action disabled={preview.revision !== data.revision || Boolean(preview.cards.length && !retained)} onClick={async () => {
        if (unsaved() || !await confirm({ title: '确认合并知识', message: `将“${point.title}”合并到“${target?.title}”？原记录转为只读，页面不能撤销。已展示的来源、标签及复习卡选择将一起保存。`, confirmLabel: '确认合并', tone: 'danger' })) return;
        const { result } = await command(`/knowledge-points/${point.id}/merge`, { targetId: preview.targetId, expectedRevision: preview.revision, retainedCardId: retained || null, confirm: true });
        router.push(`/knowledge/${result.id}`);
      }}>按预览合并知识</Action>
    </div>}
  </div></details></Card>;
}
