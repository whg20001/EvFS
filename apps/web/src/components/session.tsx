'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, ChevronRight, MessageCircle, Plus, Send, Sparkles } from 'lucide-react';
import { LIMITS, isActiveRun, type Candidate, type LearningSession, type Turn } from '@sanxing/contracts';
import { useApp, useData, useLocalText, sessionLabels } from './store';
import { Action, Assisted, Badge, Card, Empty, Go, Heading, Runs, Sources } from './ui';
import { Documents } from './recite';
import { SchedulingNotice } from './review';
import { useConfirm } from './confirm';

export function SessionPage({ id }: { id: string }) {
  const data = useData();
  const { command } = useApp();
  const confirm = useConfirm();
  const router = useRouter();
  const [scopeOpen, setScopeOpen] = useState(false);
  const session = data.sessions.find(item => item.id === id);
  if (!session) return <Empty title="没有找到这次学习"><Go href="/history">查看学习足迹</Go></Empty>;
  const active = data.runs.some(run => run.sessionId === id && isActiveRun(run));
  const currentTurn = session.turns.findLast(turn => turn.answer === null && turn.scopeVersion === session.scopeVersion);
  const accepted = session.candidates.filter(candidate => candidate.decision === 'accepted');
  return <><Heading eyebrow="MAKE ROOM FOR UNDERSTANDING" title={session.status === 'CONFIRMING' ? '先确认，我们学了什么' : session.status === 'COMPLETED' ? '每一次回想，都算数' : '把不清楚的，慢慢说清楚'} description={session.snapshot.topic || '从你的复述出发，一次只深入一个问题。'}><Badge tone="blue">{sessionLabels[session.status]}</Badge></Heading>
    <div className="workflow"><span className="done"><Check size={14} />复述</span><ChevronRight size={13} /><span className={session.status === 'CONFIRMING' ? 'current' : 'done'}>确认范围</span><ChevronRight size={13} /><span className={session.status === 'CLARIFYING' ? 'current' : ''}>追问</span><ChevronRight size={13} /><span className={session.quizId ? 'current' : ''}>独立检验</span></div>
    <div className="stack"><SchedulingNotice /><Runs sessionId={id} />
      <details className="card snapshot"><summary>本次复述与来源 <span className="muted small">范围版本 {session.scopeVersion} · 不可变快照</span></summary><div className="stack">{[['一省 · 今天学了什么', session.snapshot.learned], ['二省 · 哪里还说不清', session.snapshot.unclear], ['三省 · 明天怎么用上', session.snapshot.application]].map(([label, text]) => <div key={label}><h3>{label}</h3><p className="prose">{text || '未填写'}</p></div>)}<Sources ids={session.documentIds} /></div></details>
      {session.status === 'CONFIRMING' && session.candidates.length > 0 && <ConfirmPoints key={`${id}-${session.scopeVersion}`} session={session} disabled={active} />}
      {session.status === 'CONFIRMING' && session.candidates.length === 0 && !active && <Card><Empty title="知识范围尚未就绪">你可以重试上方未完成的任务，或不进行测验，保留这次复述。</Empty></Card>}
      {accepted.length > 0 && session.status !== 'CONFIRMING' && <Card title="这次关注的知识点"><div className="tag-list">{accepted.map(candidate => <Badge key={candidate.id} tone="blue">{candidate.title}</Badge>)}</div><p className="muted small">范围已由你确认；确认本身不代表已经掌握。</p></Card>}
      {session.turns.map((turn, index) => <div key={turn.id} className="conversation"><div className="conversation-avatar"><Sparkles size={19} /></div><div className="conversation-body"><div className="row"><strong>{data.mode === 'mock' ? '演示学习教练' : '学习教练'}</strong><span className="small muted">追问 {index + 1} · 范围 v{turn.scopeVersion}</span></div><div className="question-bubble"><p className="prose">{turn.question}</p></div>{turn.answer !== null && <><div className="answer-bubble"><div className="row between"><strong>我的回答</strong><Badge>{turn.assisted ? '辅助作答' : '自报独立作答'}</Badge></div><p className="prose">{turn.answer}</p></div>{turn.feedback && <div className="feedback"><strong>本轮反馈{data.mode === 'mock' ? ' · 演示' : ''}</strong><p className="prose">{turn.feedback}</p></div>}</>}</div></div>)}
      {session.status === 'CLARIFYING' && currentTurn && <FollowupAnswer key={currentTurn.id} turn={currentTurn} session={session} disabled={active} />}
      {session.status === 'CLARIFYING' && <div className="action-card"><div><h3>已经准备好检验自己？</h3><p className="muted small">可跳过剩余追问，测验仅围绕已确认的知识点。最多 {data.capabilities.maxFollowups} 轮追问。</p></div><Action variant="primary" disabled={active || accepted.length === 0} onClick={() => command(`/sessions/${id}/finish-followup`, { version: session.version })}>结束追问，准备测验<ArrowRight size={16} /></Action></div>}
      {session.quizId && <div className="action-card"><div><h3>{session.status === 'COMPLETED' ? '这次检验，留下了什么？' : '测验已经准备好了'}</h3><p className="muted small">先独立回答。答题后才能查看讲解和评价。</p></div><Go primary href={`/quizzes/${session.quizId}${session.status === 'COMPLETED' ? '/result' : ''}`}>{session.status === 'COMPLETED' ? '查看测验结果' : '开始 / 继续测验'}</Go></div>}
      {session.status === 'COMPLETED' && !session.quizId && <Card><Empty title="本次复述已保存">{session.completionReason === 'no_quiz' ? '这次没有进行测验，掌握情况仍待评估。' : '你选择了主动结束，未作答部分没有被算成错误。'}</Empty><div className="row center"><Go href="/recite">回到今日复述</Go><Go href="/knowledge">看看知识库</Go></div></Card>}
      {!session.quizId && session.status !== 'COMPLETED' && <><button type="button" className="text-button" onClick={() => setScopeOpen(!scopeOpen)}><Plus size={15} />{scopeOpen ? '收起补充资料' : '补充资料与调整学习范围'}</button>{scopeOpen && <ScopeEditor key={`${session.id}-${session.scopeVersion}`} session={session} disabled={active} />}</>}
      {session.status !== 'COMPLETED' && <div className="row between end-row"><p className="muted small">随时可以停下来。离开页面不会自动结束会话。</p><Action variant="subtle" disabled={active} onClick={async () => {
        if (!await confirm(session.quizId ? { title: '结束本次学习', message: '尚未作答的题将按未完成处理，不会伪造掌握证据。', confirmLabel: '结束学习', tone: 'danger' } : { title: '不进行测验', message: '保留本次复述与追问记录？掌握情况仍为待评估。', confirmLabel: '保留并结束' })) return;
        await command(`/sessions/${id}/finish`, { version: session.version, reason: session.quizId ? 'user_ended' : 'no_quiz' });
        if (session.quizId) router.push(`/quizzes/${session.quizId}/result`);
      }}>结束本次学习</Action></div>}
    </div></>;
}

function ConfirmPoints({ session, disabled }: { session: LearningSession; disabled: boolean }) {
  const data = useData();
  const { command } = useApp();
  type Decision = { candidateId: string; decision: 'accepted' | 'rejected'; title: string; description: string; existingKnowledgeId: string | null };
  const [choices, setChoices] = useState<Decision[]>(session.candidates.map(candidate => ({ candidateId: candidate.id, decision: candidate.decision === 'accepted' ? 'accepted' : 'rejected', title: candidate.title, description: candidate.description, existingKnowledgeId: candidate.existingKnowledgeId })));
  function update(id: string, change: Partial<Decision>) { setChoices(current => current.map(choice => choice.candidateId === id ? { ...choice, ...change } : choice)); }
  const reused = choices.filter(choice => choice.decision === 'accepted' && choice.existingKnowledgeId);
  const duplicateKnowledge = new Set(reused.map(choice => choice.existingKnowledgeId)).size !== reused.length;
  return <Card title="哪些是你这次真正学过的？" caption="勾选要纳入的知识点，也可以修改名称、描述，或复用已有目标。未勾选的项目会被排除。">
    <div className="stack">{choices.map(choice => {
      const candidate = session.candidates.find(item => item.id === choice.candidateId) as Candidate;
      return <div className={`candidate ${choice.decision === 'accepted' ? 'chosen' : ''}`} key={choice.candidateId}><label className="check-label"><input type="checkbox" checked={choice.decision === 'accepted'} onChange={event => update(choice.candidateId, { decision: event.target.checked ? 'accepted' : 'rejected' })} /><strong>纳入这个知识点</strong><Badge>{choice.decision === 'accepted' ? '已选择' : '待你确认'}</Badge></label><label className="field-label">名称<input value={choice.title} maxLength={100} onChange={event => update(choice.candidateId, { title: event.target.value })} /></label><label className="field-label">学习范围<textarea rows={3} maxLength={2000} value={choice.description} onChange={event => update(choice.candidateId, { description: event.target.value })} /></label><label className="field-label">知识点归属<select value={choice.existingKnowledgeId ?? ''} onChange={event => update(choice.candidateId, { existingKnowledgeId: event.target.value || null })}><option value="">创建新的知识点</option>{data.knowledge.map(point => <option key={point.id} value={point.id}>复用：{point.title}</option>)}</select></label><p className="small muted">复用会更新旧知识点的当前名称与范围，并保存内容历史；与设置中的“旧知识联想”不同：联想只在出题时结合旧知识，不会改写或复用旧知识点。</p><Sources ids={candidate.sourceIds} /></div>;
    })}</div>{duplicateKnowledge && <p className="danger-text small">多个候选归入了同一个已有知识点。请改为新建，或只保留一项。</p>}<div className="row between section-bottom"><span className="small muted">选择了 {choices.filter(choice => choice.decision === 'accepted').length} / {choices.length} 个知识点</span><Action variant="primary" disabled={disabled || duplicateKnowledge || choices.some(choice => !choice.title.trim() || !choice.description.trim())} onClick={() => command(`/sessions/${session.id}/confirmations`, { version: session.version, decisions: choices })}><Check size={16} />确认学习范围</Action></div>
  </Card>;
}
function FollowupAnswer({ turn, session, disabled }: { turn: Turn; session: LearningSession; disabled: boolean }) {
  const { command } = useApp();
  const [text, setText] = useLocalText(`followup:${turn.id}`);
  const [assistance, setAssistance] = useLocalText(`followup-assisted:${turn.id}`);
  const assisted = assistance === 'yes';
  const setAssisted = (checked: boolean) => setAssistance(checked ? 'yes' : '');
  return <Card className="reply-card" title="试着用自己的话回答"><label className="sr-only" htmlFor={`reply-${turn.id}`}>追问回答</label><textarea id={`reply-${turn.id}`} value={text} maxLength={LIMITS.answerChars} rows={6} placeholder="想到多少就说多少，暂时不确定也可以如实记录。" onChange={event => setText(event.target.value)} /><Assisted checked={assisted} onChange={setAssisted} /><div className="row between"><span className="small muted"><MessageCircle size={14} />提交后保存，不会修改原始复述。</span><Action disabled={disabled || !text.trim()} variant="primary" onClick={async () => { await command(`/sessions/${session.id}/answers`, { version: session.version, text, assisted }); setText(''); }}><Send size={15} />提交回答</Action></div></Card>;
}
function ScopeEditor({ session, disabled }: { session: LearningSession; disabled: boolean }) {
  const data = useData();
  const { command } = useApp();
  const [selected, setSelected] = useState(session.documentIds);
  const recitation = data.recitations.find(item => item.id === session.recitationId);
  if (!recitation) return null;
  return <div className="stack"><Documents recitation={recitation} historical /><Card title="明确选择新的参考范围" caption="新增资料不会自动进入追问。更新范围后需重新确认知识点，旧问答仍保留原范围版本。"><div className="stack compact">{data.documents.filter(document => recitation.documentIds.includes(document.id)).map(document => <label className="check-label" key={document.id}><input type="checkbox" checked={selected.includes(document.id)} onChange={event => setSelected(current => event.target.checked ? [...current, document.id] : current.filter(id => id !== document.id))} />{document.name}</label>)}</div><Action disabled={disabled} onClick={() => command(`/sessions/${session.id}/scope-revisions`, { version: session.version, documentIds: selected })}>确认更新范围</Action>{disabled && <p className="small muted">请先等待或取消当前运行，再修改范围。</p>}</Card></div>;
}
