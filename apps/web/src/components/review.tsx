'use client';

import { SkillPicker, useTaskSkills } from './skill-picker';
import { currentKnowledgeId } from '@sanxing/contracts';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CalendarDays, CheckCheck, Clock3, RotateCcw, Save } from 'lucide-react';
import { LIMITS, isActiveRun, type ReviewSession } from '@sanxing/contracts';
import { useApp, useData, useDraft, dateLabel, sessionLabels } from './store';
import { Action, Badge, Card, Empty, Go, Heading, Runs, SaveState } from './ui';
import { LearningStatistics } from './learning-statistics';
import { ReviewQueue, PersonalizedReviewQueue } from './review-queue';
import { LearningPreferences } from './preferences';
import { useConfirm } from './confirm';
import { useComposerTarget } from './composer-context';

export function SchedulingNotice() {
  const data = useData();
  if (data.capabilities.schedulingEnabled) return null;
  return <div className="notice" role="note"><Clock3 size={18} /><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>自动排期已关闭：不会新建复习卡或更新排期，已交卷复习仍可完成并保存证据。可在 <a href="/review#learning-preferences">复习与缓存设置</a> 中明确启用（不自动补历史卡）；REVIEW_SCHEDULING_ENABLED 仅作环境后备配置。真实模式下后续出题与评分可能产生模型费用。</span></div>;
}

export function ReviewPage() {
  const data = useData();
  const { command } = useApp();
  const confirm = useConfirm();
  const router = useRouter();
  const [filter, setFilter] = useState<'due' | 'all' | 'paused'>('due');
  const now = Date.now();
  const cards = [...data.cards].filter(card => !card.retiredAt && !data.knowledge.find(point => point.id === currentKnowledgeId(card))?.archivedAt).sort((a, b) => new Date(a.schedule.due).getTime() - new Date(b.schedule.due).getTime());
  const paused = cards.filter(card => card.pausedAt);
  const due = cards.filter(card => !card.retiredAt && !card.pausedAt && new Date(card.schedule.due).getTime() <= now);
  const displayed = filter === 'due' ? due : filter === 'paused' ? paused : cards.filter(card => !card.pausedAt);
  const ongoing = data.reviewSessions.filter(session => session.status !== 'COMPLETED' && session.status !== 'ABANDONED');
  return <><Heading eyebrow="A SECOND LOOK, A STRONGER MEMORY" title="让记忆，再深一点" description="不必从头学起。先独立回想，再和过去的自己对照。"><Badge tone="blue">{data.timezone}</Badge></Heading>
    <div className="review-hero"><div className="review-hero-icon"><CalendarDays size={35} strokeWidth={1.4} /></div><div><p className="eyebrow">TODAY’S REVIEW</p><h2>今天，有 <strong>{due.length}</strong> 个知识点等你回想。</h2><p>可按到期时间或近期失分安排本轮，数量与顺序可在设置中调整。</p></div>{due.length > 0 && <PersonalizedReviewQueue dueIds={due.map(card => card.id)} />}</div>
    <div className="stack"><SchedulingNotice /><LearningPreferences />
      {ongoing.length > 0 && <Card title="接着上次的思路"><div className="stack compact">{ongoing.map(session => {
        const card = data.cards.find(item => item.id === session.cardId);
        const point = data.knowledge.find(item => item.id === (card ? currentKnowledgeId(card) : undefined));
        return <div className="list-row" key={session.id}><span className="icon-tile"><RotateCcw size={19} /></span><div className="grow"><strong>{point?.title ?? '进行中的复习'}</strong><p className="small muted">{sessionLabels[session.status]} · {dateLabel(session.createdAt, data.timezone)}</p></div><Go href={`/review-sessions/${session.id}`}>继续复习</Go></div>;
      })}</div></Card>}
      <Card><div className="row between wrap"><h2>我的复习队列</h2><div className="segmented" aria-label="复习筛选"><button className={filter === 'due' ? 'selected' : ''} onClick={() => setFilter('due')}>已到期 {due.length}</button><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>使用中 {cards.length - paused.length}</button><button className={filter === 'paused' ? 'selected' : ''} onClick={() => setFilter('paused')}>已暂停 {paused.length}</button></div></div>
        {displayed.length ? <div className="review-list">{displayed.map(card => {
          const point = data.knowledge.find(item => item.id === currentKnowledgeId(card));
          const isDue = new Date(card.schedule.due).getTime() <= now;
          return <div key={card.id} className="review-item"><span className="review-item-symbol"><CalendarDays size={21} /></span><div className="grow"><div className="row wrap"><h3><a href={`/knowledge/${currentKnowledgeId(card)}`}>{point?.title ?? '知识点'}</a></h3><Badge tone={isDue ? 'amber' : ''}>{card.pausedAt ? '已暂停' : isDue ? '已到期' : '未到期'}</Badge></div><p className="small muted">{dateLabel(card.schedule.due, data.timezone)}到期 · 已记录 {data.reviewEvents.filter(event => event.cardId === card.id).length} 次复习</p><p className="small muted">保持率暂无估计</p></div><Action disabled={Boolean(card.pausedAt)} onClick={async () => {
            if (!isDue && !await confirm({ title: '提前复习', message: '这是提前复习，将按本次真实作答时间记录，不会修改为原到期时间。继续？', confirmLabel: '开始复习' })) return;
            const { result } = await command(`/reviews/${card.id}/start`);
            const id = result.reviewSessionId ?? result.id;
            if (id) router.push(`/review-sessions/${id}`);
          }}>{isDue ? '开始回忆' : '提前复习'}<ArrowRight size={15} /></Action><Action disabled={ongoing.some(session => session.cardId === card.id)} onClick={() => command(`/reviews/${card.id}/pause`, { version: card.version, paused: !card.pausedAt }, 'PUT')}>{card.pausedAt ? '恢复复习' : '暂停此卡'}</Action></div>;
        })}</div> : <Empty title={filter === 'paused' ? '没有暂停的卡片' : cards.length ? '当前筛选下没有复习卡片' : '你的复习计划，还在生长'} action={<Go href={cards.length ? '/knowledge' : '/recite'}>{cards.length ? '看看已有知识' : '从今日复述开始'}</Go>}>{cards.length ? '可在“使用中”查看排期，或到“已暂停”恢复卡片。暂停和恢复保留原到期时间。' : data.capabilities.schedulingEnabled ? '完成学习与检验后，符合条件的知识点会出现在这里。' : '自动排期已关闭，完成学习或测验不会自动生成复习卡。你仍可复述、作答和查看学习记录。'}</Empty>}
      </Card>
      <LearningStatistics /><Card title="真实的复习足迹" caption="展示已发生的事件，不绘制未经验证的记忆曲线。">{data.reviewEvents.length ? <ol className="timeline">{[...data.reviewEvents].sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt)).slice(0, 20).map(event => {
        const card = data.cards.find(item => item.id === event.cardId);
        return <li key={event.id}><span className="timeline-dot" /><div><div className="row wrap"><strong>{data.knowledge.find(point => point.id === (card ? currentKnowledgeId(card) : undefined))?.title ?? '知识点复习'}</strong>{event.simulated && <Badge tone="amber">演示记录</Badge>}</div><p>{dateLabel(event.reviewedAt, data.timezone)} · 评级：{['', '重来', '困难', '良好', '轻松'][event.rating]} · {event.algorithm}</p><span className="small muted">下次到期：{dateLabel(event.after.due, data.timezone)}</span></div></li>;
      })}</ol> : <p className="muted">还没有复习事件。完成一次有效复习后，真实时间线会从这里开始。</p>}</Card>
    </div></>;
}

export function ReviewSessionPage({ id }: { id: string }) {
  const data = useData();
  const { command } = useApp();
  const confirm = useConfirm();
  const [rating, setRating] = useState<1 | 2 | 3 | 4>(3);
  const session = data.reviewSessions.find(item => item.id === id);
  if (!session) return <Empty title="没有找到这次复习"><Go href="/review">返回复习计划</Go></Empty>;
  const card = data.cards.find(item => item.id === session.cardId);
  const point = data.knowledge.find(item => item.id === (card ? currentKnowledgeId(card) : undefined));
  const active = data.runs.some(run => run.reviewSessionId === id && isActiveRun(run));
  const ended = session.status === 'COMPLETED' || session.status === 'ABANDONED';
  return <><Heading eyebrow="RECALL BEFORE YOU REVEAL" title={point?.title ?? '独立回忆'} description="先不查看笔记，试着重新组织你对它的理解。"><Badge tone="blue">{sessionLabels[session.status]}</Badge></Heading><div className="stack"><SchedulingNotice />{point?.archivedAt && <p className="notice">此知识点已归档。已有复习可继续保存记录，但不会推进排期。</p>}<Runs reviewSessionId={id} />
    {session.status === 'RECALLING' ? <RecallEditor key={id} session={session} disabled={active} /> : <Card title="这次独立回忆"><p className="prose">{session.recall || '本次没有记录回忆内容。'}</p><Badge>原始回忆已保留</Badge></Card>}
    {session.quizId && <div className="action-card"><div><h3>{session.status === 'READY_TO_COMPLETE' || ended ? '回看这次检验' : '再用几道题，检验刚才的回忆'}</h3><p className="muted small">作答和排期分开保存，每次目标级复习最多更新一次排期。</p></div><Go primary href={`/quizzes/${session.quizId}${session.status === 'READY_TO_COMPLETE' || ended ? '/result' : ''}`}>{session.status === 'READY_TO_COMPLETE' || ended ? '查看测验结果' : '继续复习测验'}</Go></div>}
    {session.status === 'READY_TO_COMPLETE' && <Card title="这次回忆，感觉如何？" caption="这是你的难度自评，不是掌握度。服务端仍会核对作答证据与卡片版本，决定是否更新排期。"><div className="rating-options">{([{ value: 1, title: '重来', detail: '需要重新学习' }, { value: 2, title: '困难', detail: '回忆比较费力' }, { value: 3, title: '良好', detail: '能够独立回忆' }, { value: 4, title: '轻松', detail: '清晰且很轻松' }] as const).map(option => <label className={rating === option.value ? 'selected' : ''} key={option.value}><input type="radio" name="rating" value={option.value} checked={rating === option.value} onChange={() => setRating(option.value)} /><strong>{option.title}</strong><span>{option.detail}</span></label>)}</div><Action variant="primary" disabled={active} onClick={() => command(`/review-sessions/${id}/complete`, { version: session.version, expectedCardVersion: session.expectedCardVersion, rating })}><CheckCheck size={17} />完成本次复习</Action></Card>}
    {ended && <Card><ReviewQueue key={id} sessionId={id} /><Empty title={session.status === 'COMPLETED' ? '这次复习，已好好收下。' : '本次复习已停止'} action={<Go primary href="/review">返回复习队列</Go>}>{session.status === 'ABANDONED' ? '保留已有记录，不因放弃而推进排期。' : data.reviewEvents.some(event => event.reviewSessionId === id) ? `下次到期：${card ? dateLabel(card.schedule.due, data.timezone) : '请在队列查看'}${data.mode === 'mock' ? '（演示排期）' : ''}` : '本次未产生有效排期事件，不虚构复习结果。'}</Empty></Card>}
    {!ended && <div className="row between end-row"><Go href="/review">暂时离开，稍后继续</Go><Action variant="subtle" disabled={active} onClick={async () => { if (await confirm({ title: '放弃本次复习', message: '已有记录保留，但不会推进排期。', confirmLabel: '放弃复习', tone: 'danger' })) await command(`/review-sessions/${id}/abandon`, { version: session.version }); }}>放弃本次复习</Action></div>}
  </div></>;
}
function RecallEditor({ session, disabled }: { session: ReviewSession; disabled: boolean }) {
  const skills = useTaskSkills('quiz');
  const { command, busy, authenticated, setError } = useApp();
  const draft = useDraft(session.recall, session.version, async (text, version) => {
    const response = await command(`/review-sessions/${session.id}/recall`, { version, text, action: 'draft' }, 'PUT');
    return response.state.reviewSessions.find(item => item.id === session.id)?.version ?? response.result.version ?? version;
  }, !busy && !disabled && authenticated, `recall:${session.id}`);
  useComposerTarget(input => {
    if (disabled) throw new Error('请等待当前复习任务完成，再补充回忆。');
    const next = draft.value ? `${draft.value}\n\n${input.text}` : input.text;
    if (next.length > LIMITS.answerChars) throw new Error('回忆内容已到字符上限，请精简后继续。');
    draft.change(next);
  });
  return <Card title="不翻笔记，先说说你记得的" caption="草稿可以留空；提交前请至少写下你记得的内容或具体困惑。回忆会用于定向出题，不作为独立分数。"><div className="stack" data-unsaved={draft.status !== 'saved'}><textarea aria-label="独立回忆" maxLength={LIMITS.answerChars} rows={10} value={draft.value} placeholder="它是什么？解决什么问题？关键条件是什么？\n\n试着举一个自己的例子。" onChange={event => draft.change(event.target.value)} /><SaveState status={draft.status} reset={draft.reset} /><SkillPicker skills={skills} disabled={disabled} /><div className="row between"><Action disabled={disabled} onClick={draft.save}><Save size={16} />保存回忆草稿</Action><Action disabled={disabled || !draft.value.trim()} variant="primary" onClick={async () => {
    if (!draft.value.trim()) return;
    if (!await draft.save()) return;
    if (draft.dirty()) { setError('仍有新输入未保存，请稍后重试。'); return; }
    await command(`/review-sessions/${session.id}/recall`, { version: draft.version(), text: draft.value, action: 'submitted', skillSelections: skills.selection }, 'PUT');
  }}>提交回忆，开始检验<ArrowRight size={16} /></Action></div></div></Card>;
}
