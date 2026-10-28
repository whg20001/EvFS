'use client';

import { FilePenLine, Paperclip } from 'lucide-react';
import { recitationDrafts } from '../lib/recitation-drafts';
import { useData } from './store';
import { Badge, Card, Empty, Go, Heading } from './ui';

export function DraftsPage() {
  const data = useData();
  const drafts = recitationDrafts(data);
  return <>
    <Heading eyebrow="PICK UP WHERE YOU LEFT OFF" title="草稿箱" description="还没说完的，留到准备好时再继续。未提交的复述会自动保留，跨天也可以接着写。"><div className="row wrap recite-heading-actions"><Go href="/recite">今日复述</Go></div></Heading>
    {drafts.length ? <div className="stack draft-list" aria-label="复述草稿">
      <p className="small muted">共 {drafts.length} 份草稿 · 提交后按原学习日期归档</p>
      {drafts.map(draft => <Card key={draft.id} className="draft-card">
        <div className="draft-card-heading"><div className="grow"><p className="eyebrow">{draft.learningDate}</p><h2>{draft.topic.trim() || '还没说完的三省'}</h2></div><Badge><FilePenLine size={14} />未提交</Badge></div>
        <p className="draft-excerpt">{([draft.learned, draft.unclear, draft.application].find(text => text.trim()) ?? '').trim().slice(0, 240) || '内容和参考资料已经保存，随时可以回来写下自己的理解。'}</p>
        <div className="draft-card-footer"><span className="small muted"><Paperclip size={14} />{draft.documentIds.length} 份参考资料</span><Go href={`/recite/${encodeURIComponent(draft.id)}`}>继续编辑</Go></div>
      </Card>)}
    </div> : <Card><Empty title="暂时没有未提交的草稿" action={<Go href="/recite">写下今天的三省</Go>}>写下的内容会自动保存。准备好后提交，继续你的学习。</Empty></Card>}
  </>;
}
