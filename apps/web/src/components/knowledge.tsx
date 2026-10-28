'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, BookOpen, CalendarDays, Search, Save } from 'lucide-react';
import { currentKnowledgeId, LIMITS, isActiveRun, type KnowledgePoint } from '@sanxing/contracts';
import { useApp, useData, useDraft, dateLabel, sessionLabels } from './store';
import { Action, Badge, Card, Empty, Go, Heading, SaveState, Sources } from './ui';
import { useConfirm } from './confirm';
import { KnowledgeEditor } from './knowledge-editor';
import { KnowledgeMerge } from './knowledge-merge';
import { KnowledgeEvidence } from './knowledge-evidence';

export function KnowledgePage() {
  const data = useData();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  useEffect(() => { setSearch(params.get('q') ?? ''); }, [params]);
  const [visible, setVisible] = useState(24);
  const [archive, setArchive] = useState('active');
  const [tag, setTag] = useState('');
  const byId = new Map(data.knowledge.map(point => [point.id, point]));
  const currentId = (id: string) => {
    const seen = new Set<string>();
    while (byId.get(id)?.merge && !seen.has(id)) { seen.add(id); id = byId.get(id)!.merge!.targetId; }
    return id;
  };
  const evidenceOwners = new Map(data.evidence.map(item => [item.id, currentId(item.knowledgeId)]));
  const points = data.knowledge.filter(point => (archive === 'all' || Boolean(point.archivedAt) === (archive === 'archived')) && (!tag || point.tags?.includes(tag))).filter(point => `${point.title} ${point.description} ${point.understanding}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <><Heading eyebrow="A GARDEN OF YOUR OWN IDEAS" title="我的知识库" description="不只是收藏过，而是用自己的话，理解过。"><Badge tone="blue">{data.knowledge.length} 个知识点</Badge></Heading>
    <div className="row wrap"><label className="field-label">知识状态<select value={archive} onChange={event => setArchive(event.target.value)}><option value="active">使用中</option><option value="archived">已归档</option><option value="all">全部知识</option></select></label><label className="field-label">标签筛选<select value={tag} onChange={event => setTag(event.target.value)}><option value="">全部标签</option>{[...new Set(data.knowledge.flatMap(point => point.tags ?? []))].sort().map(value => <option key={value}>{value}</option>)}</select></label></div>
    <div className="knowledge-search"><Search size={20} /><input aria-label="筛选知识点" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、描述或我的理解…" /><span className="small muted">{points.length} 个结果</span></div>
    {points.length > visible && <Action onClick={() => setVisible(value => value + 24)}>显示更多知识（已显示 {visible} / {points.length}）</Action>}
    {points.length ? <div className="knowledge-grid">{points.slice(0, visible).map(point => {
      const evidence = data.evidence.filter(item => point.merge ? item.knowledgeId === point.id : evidenceOwners.get(item.id) === point.id);
      const actual = evidence.filter(item => !item.simulated && ('summary' in item ? item.summary.graded : item.answer.assessment.status === 'graded'));
      const card = data.cards.find(item => !item.retiredAt && currentKnowledgeId(item) === point.id);
      return <Link key={point.id} href={`/knowledge/${point.id}`} className="card knowledge-card"><div className="row between"><span className="icon-tile"><BookOpen size={21} /></span><ArrowUpRight size={18} /></div><h2>{point.title}</h2>{point.archivedAt && <Badge>{point.merge ? '已合并' : '已归档'}</Badge>}{point.tags?.map(tag => <Badge key={tag}>{tag}</Badge>)}<p className="muted clamp">{point.description}</p><div className="tag-list"><Badge tone={actual.length ? 'blue' : ''}>{actual.length ? `${actual.length} 条已评价证据` : '待评估'}</Badge>{evidence.some(item => item.simulated) && <Badge tone="amber">含演示记录</Badge>}</div><div className="knowledge-card-footer"><CalendarDays size={14} /><span>{card ? `${dateLabel(card.schedule.due, data.timezone, true)}复习` : '尚无复习排期'}</span><span>查看详情</span></div></Link>;
    })}</div> : <Card><Empty title={search ? '还没有匹配的知识点' : '理解的种子，从今天种下'} action={<Go href="/recite">去复述今天的所学</Go>}>{search ? '试试其他关键词，或清空搜索。' : '确认学习范围后，你的知识点会保存在这里。'}</Empty></Card>}
  </>;
}
export function KnowledgeDetail({ id }: { id: string }) {
  const data = useData();
  const { command } = useApp();
  const confirm = useConfirm();
  const point = data.knowledge.find(item => item.id === id);
  const active = data.runs.some(isActiveRun);
  if (!point) return <Empty title="没有找到这个知识点"><Go href="/knowledge">返回知识库</Go></Empty>;
  const card = data.cards.find(item => !item.retiredAt && currentKnowledgeId(item) === id);
  const events = data.reviewEvents.filter(event => data.cards.some(item => item.id === event.cardId && (item.knowledgeId === id || currentKnowledgeId(item) === id)));
  const relatedSessions = data.sessions.filter(session => session.relatedKnowledge?.length && session.candidates.some(candidate => candidate.decision === 'accepted' && candidate.knowledgeId === id));
  return <><Link className="back-link" href="/knowledge">← 我的知识库</Link><Heading eyebrow="ONE IDEA, MANY CONNECTIONS" title={point.title} description={point.description}><Badge>{point.contentVersion === undefined ? '内容版本未知（旧记录）' : `内容版本 ${point.contentVersion}`}</Badge></Heading><div className="stack">{point.merge ? <Card title="此知识已合并"><p>原记录保留为只读历史。</p><Go href={`/knowledge/${point.merge.targetId}`}>前往合并后的知识</Go><p className="prose">{point.understanding}</p></Card> : <><KnowledgeEditor key={`content:${id}`} point={point} /><Understanding key={`understanding:${id}`} point={point} /><KnowledgeMerge key={`merge:${id}`} point={point} /></>}
    {data.knowledge.some(item => item.merge?.targetId === id) && <Card title="合并来源">{data.knowledge.filter(item => item.merge?.targetId === id).map(item => <p key={item.id}><Go href={`/knowledge/${item.id}`}>{item.title} · 查看原记录</Go></p>)}</Card>}
    <Card title="内容历史" caption="仅展示实际保存的内容快照；修改个人理解不会增加内容版本。">{point.contentHistory?.length ? <div className="stack compact">{[...point.contentHistory].reverse().map(snapshot => <details key={snapshot.version}><summary>内容版本 {snapshot.version} · {snapshot.title}</summary><div className="stack compact"><p className="small muted">{dateLabel(snapshot.createdAt, data.timezone)}</p><h3>{snapshot.title}</h3><p className="prose">{snapshot.description}</p><Sources ids={snapshot.sourceIds} /></div></details>)}</div> : <p className="muted">暂无历史内容快照，旧记录的内容版本未知，不能用当前内容推定当时的依据。</p>}</Card>
    {relatedSessions.length > 0 && <Card title="学习时关联过的旧知识" caption="仅回看当时确认的比较参考，不代表掌握情况，不是当前来源，也不会自动新增考核点。"><div className="stack">{relatedSessions.map(session => {
      const candidate = session.candidates.find(item => item.decision === 'accepted' && item.knowledgeId === id)!;
      return <div className="evidence-item" key={`${session.id}:${session.scopeVersion}`}><p className="small muted">会话 {session.id} · 范围 v{session.scopeVersion} · {candidate.knowledgeVersion == null ? '本点内容版本未知' : `本点内容版本 ${candidate.knowledgeVersion}`}</p><div className="stack compact">{session.relatedKnowledge!.map(related => <div key={related.id}><div className="row wrap"><h3>{related.title}</h3><Badge>{related.knowledgeVersion == null ? '关联内容版本未知' : `关联内容版本 ${related.knowledgeVersion}`}</Badge></div><p className="prose">{related.description}</p></div>)}</div><Go href={`/sessions/${encodeURIComponent(session.id)}/ask`}>回看当时学习会话</Go></div>;
    })}</div></Card>}
    <Card title="来源与原始笔记" caption="Markdown 笔记默认排版显示，可切换带行号原文，最大化可全屏阅读；不执行 HTML 或脚本，也不加载外部图片等资源。"><Sources ids={point.sourceIds} /></Card>
    <KnowledgeEvidence key={`${id}:${data.revision}`} id={id} />
    <Card title="复习时间线"><p className="notice"><CalendarDays size={18} />{card ? `${card.pausedAt ? '已暂停 · ' : ''}下次到期：${dateLabel(card.schedule.due, data.timezone)}${data.mode === 'mock' ? '（演示）' : ''}` : '还没有复习排期。'} · 保持率暂无估计</p>{events.length > 0 ? <ol className="timeline">{events.map(event => <li key={event.id}><span className="timeline-dot" /><div><strong>{dateLabel(event.reviewedAt, data.timezone)}</strong><p>评级：{['', '重来', '困难', '良好', '轻松'][event.rating]} · {event.simulated ? '演示事件' : '已记录事件'} · {event.algorithm}</p></div></li>)}</ol> : <p className="muted">尚未发生复习事件，不展示预测曲线。</p>}{card ? <Go href="/review">查看现有复习卡</Go> : data.capabilities.schedulingEnabled ? <><p className="small muted">仅为当前知识点加入复习，不自动批量补卡，也不调用模型。之后主动开始真实复习时，出题与评分可能产生费用。</p><Action disabled={active || Boolean(point.archivedAt)} onClick={async () => {
      if (!await confirm({ title: '加入复习', message: `将“${point.title}”加入复习？仅创建当前知识的复习卡，不调用模型；后续真实复习可能产生模型费用。`, confirmLabel: '加入复习' })) return;
      await command(`/knowledge-points/${point.id}/review-card`, { version: point.version, confirm: true });
    }}>将此知识加入复习</Action>{active && <p className="small muted">请先等待或取消当前任务。</p>}</> : <Go href="/review#learning-preferences">设置复习排期</Go>}<Go href="/review">前往复习计划</Go></Card>
  </div></>;
}
function Understanding({ point }: { point: KnowledgePoint }) {
  const { command, busy, authenticated } = useApp();
  const draft = useDraft(point.understanding, point.version, async (text, version) => {
    const response = await command(`/knowledge-points/${point.id}/understanding`, { version, text }, 'PUT');
    return response.state.knowledge.find(item => item.id === point.id)?.version ?? response.result.version ?? version;
  }, !busy && authenticated, `understanding:${point.id}`);
  return <Card title="我的理解" caption="这是你的个人理解，可以持续修订，不会覆盖过去的考核依据。"><div data-unsaved={draft.status !== 'saved'}><textarea aria-label="我的理解" rows={7} maxLength={LIMITS.answerChars} value={draft.value} onChange={event => draft.change(event.target.value)} placeholder="用一个自己的例子，解释这个知识点…" /><div className="row between section-bottom"><SaveState status={draft.status} reset={draft.reset} /><Action onClick={draft.save}><Save size={15} />保存我的理解</Action></div></div></Card>;
}
export function HistoryPage() {
  const data = useData();
  const [date, setDate] = useState('');
  const [visible, setVisible] = useState(20);
  const records = [...data.recitations].filter(item => !date || item.learningDate === date).sort((a, b) => b.learningDate.localeCompare(a.learningDate));
  return <><Heading eyebrow="SMALL STEPS, REAL PROGRESS" title="学习的每一步，都留有回响" description="回到某一天的复述，看看当时的自己，如何理解这个世界。" /><div className="row between history-filter"><span className="muted">共 {data.recitations.length} 个学习日</span><label className="row small">按日期查看<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>{date && <button className="text-button" onClick={() => setDate('')}>清除筛选</button>}</div>
    {records.length > visible && <Action onClick={() => setVisible(value => value + 20)}>显示更多学习日（已显示 {visible} / {records.length}）</Action>}
    <div className="stack">{records.length ? records.slice(0, visible).map(recitation => {
      const sessions = data.sessions.filter(session => session.recitationId === recitation.id);
      return <Card key={recitation.id} className="history-card"><div className="row between"><div><p className="eyebrow">{recitation.learningDate}</p><h2>{recitation.topic || '这一天的三省'}</h2></div><Badge>{sessions.length} 次提交</Badge></div><details className="history-draft"><summary>查看当前草稿 <span className="small muted">v{recitation.version}</span></summary><div className="stack">{[['今天学了什么', recitation.learned], ['哪里还说不清', recitation.unclear], ['明天怎么用上', recitation.application]].map(([label, text]) => <div key={label}><h3>{label}</h3><p className="prose">{text || '未填写'}</p></div>)}<Sources ids={recitation.documentIds} /></div></details>{sessions.length ? <div className="stack compact">{[...sessions].reverse().map(session => <div className="list-row" key={session.id}><div className="grow"><strong>{session.snapshot.topic || '学习快照'}</strong><p className="muted small">{sessionLabels[session.status]} · 范围 v{session.scopeVersion}{session.completionReason === 'no_quiz' ? ' · 未进行测验' : session.completionReason === 'user_ended' ? ' · 主动结束' : ''}</p></div><Go href={`/sessions/${session.id}/ask`}>{session.status === 'COMPLETED' ? '查看当时快照' : '继续学习'}</Go></div>)}</div> : <p className="muted small">这一天尚未提交，仅保存了草稿。</p>}</Card>;
    }) : <Card><Empty title={date ? '这一天还没有记录' : '你的学习故事，从这里开始'} action={<Go href="/recite">写下今天的三省</Go>}>不追求填满每一天，只记录真实发生的学习。</Empty></Card>}</div>
  </>;
}
