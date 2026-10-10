'use client';

import { useRef, useState } from 'react';
import { CodeExerciseEditor, ExecutionSummary, languageLabels } from './code-exercise';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, CheckCheck, Flag, Save, SkipForward } from 'lucide-react';
import { LIMITS, isActiveRun, type CodeExecution, type PublicQuestion, type PublicQuiz } from '@sanxing/contracts';
import { useApp, useData, useDraft, useLocalText } from './store';
import { Action, Assisted, Badge, Card, Empty, EvidenceLabel, Go, Heading, Runs, SaveState } from './ui';
import { SchedulingNotice } from './review';
import { InputBudget, useInputBudget } from './input-budget';
import { useConfirm } from './confirm';

const questionLabels = { single: '单项选择', short: '简答题', code: '代码题' };
const answerLabels = { single: '单选题', short: '简答题', code: '代码题' };

export function QuizPage({ id, result = false }: { id: string; result?: boolean }) {
  const data = useData();
  const { command } = useApp();
  const confirm = useConfirm();
  const router = useRouter();
  const quiz = data.quizzes.find(item => item.id === id);
  if (!quiz) return <Empty title="这份测验还不存在"><Go href="/history">返回学习足迹</Go></Empty>;
  const answered = quiz.questions.filter(question => question.answer !== null);
  const active = data.runs.some(run => ((quiz.sessionId && run.sessionId === quiz.sessionId) || (quiz.reviewSessionId && run.reviewSessionId === quiz.reviewSessionId)) && isActiveRun(run));
  const current = quiz.questions.find(question => question.answer === null);
  const isResult = result || Boolean(quiz.submittedAt);
  const title = quiz.reviewSessionId ? '复习检验' : '今日小测';
  async function submit() {
    const remaining = quiz!.questionCount - answered.length;
    if (!await confirm(remaining > 0 ? { title: '交卷', message: `还有 ${remaining} 题未正式作答。交卷会将它们标记为跳过，草稿不作为答案提交。确定交卷？`, confirmLabel: '确认交卷', tone: 'danger' } : { title: '交卷', message: '确定提交本次测验？正式答案将保留，不能再修改。', confirmLabel: '确认交卷' })) return;
    await command(`/quizzes/${id}/submit`, { version: quiz!.version, confirmSkip: true });
    router.push(`/quizzes/${id}/result`);
  }
  return <><Heading eyebrow="RETRIEVE, NOT JUST RECOGNIZE" title={isResult ? '一次检验，一点新的理解' : title} description={isResult ? '看见证据，也保留不确定。不用一次作答，定义全部的自己。' : '合上笔记，给记忆一次独立表达的机会。'}><Badge tone="blue">{answered.length} / {quiz.questionCount} 题已作答</Badge></Heading><div className="stack">
    <Runs sessionId={quiz.sessionId ?? undefined} reviewSessionId={quiz.reviewSessionId ?? undefined} />
    {!isResult && <><div className="quiz-progress" aria-label={`已作答 ${answered.length}，共 ${quiz.questionCount} 题`}><div style={{ width: `${quiz.questionCount ? answered.length / quiz.questionCount * 100 : 0}%` }} /></div><div className="row between"><p className="small muted">按顺序作答 · 仅提供当前题与已答题 · 可以明确跳过</p><Badge>{quiz.reviewSessionId ? '延迟回忆检验' : '即时学习检验'}</Badge></div>
      {current ? <QuestionEditor key={current.id} quiz={quiz} question={current} disabled={active} /> : <Card><Empty title={active ? '正在保存评价，请稍候' : '本轮题目已作答'}>{active ? '不需要重复提交，处理完毕后自动更新。' : '可以回看作答与讲解，准备好后完成交卷。'}</Empty></Card>}
      {answered.length > 0 && <Card title="已答题与反馈" caption="这里仅显示已提交的题目。跳过不计为答错。"><div className="stack">{answered.map((question, index) => <QuestionFeedback key={question.id} question={question} index={index} />)}</div></Card>}
      <div className="submit-bar"><div><Flag size={20} /><div><strong>按自己的节奏完成</strong><p>未答题须明确确认跳过；离开不会自动交卷。</p></div></div><Action variant="primary" disabled={active} onClick={submit}><CheckCheck size={16} />{answered.length === quiz.questionCount ? '完成测验，查看结果' : '提前交卷'}</Action></div>
    </>}
    {isResult && <><SchedulingNotice /><ResultSummary quiz={quiz} /><Card title="逐题回看" caption="评价只描述本次作答，不等于长期掌握。辅助、跳过和待核对分别记录。"><div className="stack">{answered.map((question, index) => <QuestionFeedback key={question.id} question={question} index={index} open />)}{!answered.length && <Empty title="暂无作答证据">没有有效评价时，掌握情况为待评估。</Empty>}</div></Card>
      {!quiz.submittedAt && <div className="action-card"><p>测验尚未交卷，先返回作答或确认交卷。</p><Go href={`/quizzes/${id}`}>返回测验</Go><Action disabled={active} onClick={submit}>确认交卷</Action></div>}
      <div className="row wrap">{quiz.reviewSessionId ? <Go primary href={`/review-sessions/${quiz.reviewSessionId}`}>{data.capabilities.schedulingEnabled ? '返回单卡复习，完成排期' : '返回单卡复习，保存记录'}</Go> : <Go primary href="/review">查看复习计划</Go>}<Go href="/knowledge">回到知识库</Go><Go href="/recite">回到今日复述</Go></div>
    </>}
  </div></>;
}

function QuestionEditor({ quiz, question, disabled }: { quiz: PublicQuiz; question: PublicQuestion; disabled: boolean }) {
  const { command, busy, authenticated, setError } = useApp();
  const confirm = useConfirm();
  const [assistance, setAssistance] = useLocalText(`question-assisted:${question.id}`);
  const assisted = assistance === 'yes';
  const setAssisted = (checked: boolean) => setAssistance(checked ? 'yes' : '');
  const [execution, setExecution] = useState<CodeExecution | undefined>();
  const initial = question.kind === 'code' && !question.hasDraft && !question.draft ? question.code!.starter : question.draft;
  const draft = useDraft(initial, quiz.version, async (text, version) => {
    const response = await command(`/questions/${question.id}/draft`, { version, text }, 'PUT');
    return response.state.quizzes.find(item => item.id === quiz.id)?.version ?? response.result.version ?? version;
  }, !busy && !disabled && authenticated, `answer:${question.id}`);
  const budget = useInputBudget(`/questions/${question.id}/input-preview`, { text: draft.value, ...(execution ? { execution } : {}) }, [quiz.version, quiz.currentIndex, question.id], question.kind !== 'single' && !disabled);
  const currentText = useRef(draft.value); currentText.current = draft.value;
  async function answer(action: 'answer' | 'skip', selectedIndex: number | null = null) {
    if (action === 'skip' && !await confirm({ title: '跳过此题', message: '跳过当前题？之后可以查看讲解，但不能重新提交此题。跳过不计为答错。', confirmLabel: '跳过', tone: 'danger' })) return;
    if (!await draft.save()) return;
    if (draft.dirty()) { setError('还有新输入尚未保存，请稍后重试。'); return; }
    if (action === 'answer' && question.kind !== 'single') {
      const preview = await budget.refresh();
      if (!preview?.canSubmit) return;
      if (draft.dirty() || currentText.current !== draft.value) { setError('预检过程中答案发生变化，请保存后再次提交。'); return; }
    }
    await command(`/questions/${question.id}/answers`, { version: draft.version(), action, text: draft.value, selectedIndex, assisted, ...(question.kind === 'code' ? { codeProtocol: 1, ...(action === 'answer' && execution ? { execution } : {}) } : {}) });
  }
  return <Card className="question-card"><div data-unsaved={draft.status !== 'saved'}><div className="row between"><div className="row"><span className="question-number">{quiz.currentIndex + 1 < quiz.questionCount + 1 ? String(quiz.currentIndex + 1).padStart(2, '0') : '题'}</span><Badge tone="blue">{questionLabels[question.kind]}{question.kind === 'code' && ` · ${languageLabels[question.code!.language]}`}</Badge></div>{question.kind !== 'single' && <SaveState status={draft.status} reset={draft.reset} />}</div><h2 className="question-prompt prose">{question.prompt}</h2>
    {question.kind === 'single' ? <><p className="muted small">选择即正式提交，提交后不可修改。请先确认下方的辅助标记。</p><Assisted checked={assisted} onChange={setAssisted} /><div className="options">{question.options.map((option, index) => <Action key={index} className="option" disabled={disabled} onClick={() => answer('answer', index)}><span className="option-letter">{String.fromCharCode(65 + index)}</span><span>{option}</span><ArrowRight size={16} /></Action>)}</div></> : question.kind === 'code' ? <><CodeExerciseEditor exercise={question.code!} value={draft.value} disabled={disabled} onChange={value => { setExecution(undefined); draft.change(value); }} onExecution={setExecution} /><Assisted checked={assisted} onChange={setAssisted} /></> : <><label className="field-label" htmlFor={`answer-${question.id}`}>我的回答</label><textarea id={`answer-${question.id}`} value={draft.value} maxLength={LIMITS.answerChars} rows={8} placeholder="写下你的理解、推理过程与结论…" onChange={event => draft.change(event.target.value)} /><Assisted checked={assisted} onChange={setAssisted} /></>}
    {question.kind !== 'single' && <InputBudget budget={budget} />}
    <div className="row between section-bottom"><Action variant="subtle" disabled={disabled} onClick={() => answer('skip')}><SkipForward size={15} />跳过这题</Action>{question.kind !== 'single' && <div className="row"><Action disabled={disabled} onClick={draft.save}><Save size={15} />暂存答案</Action><Action variant="primary" disabled={disabled || !draft.value.trim() || !budget.canSubmit} onClick={() => answer('answer')}><Check size={16} />正式提交</Action></div>}</div></div>
  </Card>;
}
function QuestionFeedback({ question, index, open = false }: { question: PublicQuestion; index: number; open?: boolean }) {
  const data = useData();
  const answer = question.answer;
  if (!answer) return null;
  return <details className="question-feedback" open={open || undefined}><summary><span className="feedback-index">{String(index + 1).padStart(2, '0')}</span><span>{question.prompt}</span><EvidenceLabel {...answer.assessment} simulated={data.mode === 'mock'} /></summary><div className="feedback-content"><div className="row wrap"><Badge>{answer.assisted ? '辅助作答' : '自报独立作答'}</Badge><Badge>{answer.skipped ? '主动跳过' : answerLabels[question.kind]}</Badge></div><h3>我的答案</h3>{question.kind === 'code' && !answer.skipped ? <><pre className="code-block">{answer.text}</pre>{answer.execution && <ExecutionSummary execution={answer.execution} />}</> : <p className="prose">{answer.skipped ? '本题已跳过，不计为答错。' : answer.selectedIndex !== null ? `${String.fromCharCode(65 + answer.selectedIndex)}. ${question.options[answer.selectedIndex] ?? '已记录选项'}` : answer.text}</p>}{answer.assessment.feedback && <><h3>评价依据{data.mode === 'mock' ? ' · 脚本演示' : ''}</h3><p className="prose">{answer.assessment.feedback}</p></>}{question.explanation && <div className="explanation"><h3>参考讲解</h3>{question.kind === 'code' ? <pre className="code-block">{question.explanation}</pre> : <p className="prose">{question.explanation}</p>}</div>}</div></details>;
}
function ResultSummary({ quiz }: { quiz: PublicQuiz }) {
  const data = useData();
  const answers = quiz.questions.flatMap(question => question.answer ? [question.answer] : []);
  const graded = answers.filter(answer => answer.assessment.status === 'graded' && answer.assessment.score !== null);
  const skipped = answers.filter(answer => answer.skipped).length;
  const pending = answers.filter(answer => answer.assessment.status === 'pending' || answer.assessment.status === 'needs_verification').length;
  return <div className="result-summary"><span className="result-icon"><CheckCheck size={28} /></span><div><p className="eyebrow">{data.mode === 'mock' ? 'DEMONSTRATION RESULT' : 'YOUR LEARNING EVIDENCE'}</p><h2>{quiz.submittedAt ? '这一次的努力，已被记录。' : '已保留当前作答，尚未交卷。'}</h2><p className="muted">{data.mode === 'mock' ? '下列数字来自脚本演示，不能用于评价真实学习效果。' : '即时表现与长期记忆分开记录，没有证据的部分仍待评估。'}</p><div className="result-stats"><div><strong>{graded.length}</strong><span>题已评价</span></div><div><strong>{skipped}</strong><span>题已跳过</span></div><div><strong>{pending}</strong><span>题待评估 / 核对</span></div><div><strong>{answers.filter(answer => answer.assisted && !answer.skipped).length}</strong><span>次辅助作答</span></div></div></div></div>;
}
