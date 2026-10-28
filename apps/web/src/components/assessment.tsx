'use client';

import { SkillPicker, useTaskSkills } from './skill-picker';

import { useState } from 'react';
import { LIMITS, isActiveRun, type Assessment, type PublicQuestion, type PublicQuiz } from '@sanxing/contracts';
import { useApp, useData, useLocalText } from './store';
import { Action, Badge, EvidenceLabel } from './ui';
import { useBeforeUnload, useConfirm } from './confirm';

export function AssessmentDetails({ assessment }: { assessment: Assessment }) {
  return <div className="stack compact"><p className="small muted">评价版本 {assessment.version} · {assessment.source === 'manual' ? '人工核对（自评）' : assessment.source === 'model' ? '模型评价' : assessment.source === 'automatic' ? '固定答案判定' : '历史评价'}</p>
    {assessment.reason && <p>修订原因：{assessment.reason}</p>}
    {assessment.status === 'graded' && (assessment.scores?.length ? assessment.scores.map(item => <div className="evidence-item" key={item.rubricId}><strong>{item.description} · {item.score} / {item.maxScore}</strong><p className="prose">{item.evidence}</p></div>) : <p className="small muted">历史记录未保存分项依据。</p>)}
  </div>;
}

export function AssessmentReview({ question, quiz }: { question: PublicQuestion; quiz: PublicQuiz }) {
  const skills = useTaskSkills('grade');
  const { command } = useApp();
  const data = useData();
  const confirm = useConfirm();
  const answer = question.answer!;
  const [reason, setReason] = useLocalText(`assessment-reason:${question.id}:${answer.assessment.version}`);
  const [feedback, setFeedback] = useLocalText(`assessment-feedback:${question.id}:${answer.assessment.version}`);
  const [rows, setRows] = useState((question.rubric ?? []).map(row => ({ rubricId: row.id, score: '', evidence: '' })));
  const active = data.runs.some(run => run.quizId === quiz.id && isActiveRun(run));
  const dirty = Boolean(reason || feedback || rows.some(row => row.score || row.evidence));
  useBeforeUnload(() => dirty);
  const body = { version: quiz.version, assessmentVersion: answer.assessment.version, reason };
  const clear = () => { setReason(''); setFeedback(''); setRows(current => current.map(row => ({ ...row, score: '', evidence: '' }))); };
  async function revise(method: 'manual' | 'model') {
    if (!await confirm({ title: method === 'model' ? '请求模型复评' : '保存人工核对', message: method === 'model' ? '将原题、原评分标准及正式答案交给当前模型重新评价。真实模式可能产生费用；旧评价和已发生的复习排期保留。' : '人工核对会标为自评并保留旧评价，不用于自动推进复习排期。', confirmLabel: '确认' })) return;
    await command(`/questions/${question.id}/assessment-revisions`, { ...body, method, ...(method === 'model' ? { skillSelections: skills.selection } : {}), ...(method === 'manual' ? { feedback, scores: rows.map(row => ({ ...row, score: Number(row.score) })) } : {}) }); clear();
  }
  return <div className="stack compact">
    {answer.dispute && <p role="status" className="notice">{answer.dispute.resolvedAt ? '已核对' : '评价有争议，待核对'}：{answer.dispute.reason}</p>}
    {!!answer.assessmentHistory?.length && <details><summary>评价修订历史（{answer.assessmentHistory.length}）</summary>{[...answer.assessmentHistory].reverse().map(item => <div className="evidence-item" key={item.version}><EvidenceLabel {...item} /><p className="prose">{item.feedback}</p><AssessmentDetails assessment={item} /></div>)}</details>}
    <details><summary>核对这条评价</summary><fieldset disabled={active} data-unsaved={dirty} style={{ border: 0, padding: 0, minWidth: 0 }} className="stack compact">
      <label className="field-label">核对原因<textarea value={reason} maxLength={LIMITS.assessmentReasonChars} onChange={event => setReason(event.target.value)} /></label>
      {question.kind !== 'single' && <SkillPicker skills={skills} disabled={active} />}<div className="row wrap"><Action disabled={!reason.trim() || Boolean(answer.dispute && !answer.dispute.resolvedAt)} onClick={async () => { await command(`/questions/${question.id}/disputes`, body); clear(); }}>标记有争议</Action>{question.kind !== 'single' && <Action disabled={!reason.trim()} onClick={() => revise('model')}>请求模型复评</Action>}</div>
      <details><summary>人工核对分项</summary><div className="stack compact">{(question.rubric ?? []).map((criterion, index) => <div key={criterion.id} className="evidence-item"><p>{criterion.description}（满分 {criterion.maxScore}）</p><label className="field-label">第 {index + 1} 项得分<input type="number" min={0} max={criterion.maxScore} step="any" value={rows[index]?.score ?? ''} onChange={event => setRows(current => current.map((row, i) => i === index ? { ...row, score: event.target.value } : row))} /></label><label className="field-label">第 {index + 1} 项依据<textarea maxLength={2000} value={rows[index]?.evidence ?? ''} onChange={event => setRows(current => current.map((row, i) => i === index ? { ...row, evidence: event.target.value } : row))} /></label></div>)}
        <label className="field-label">核对结论<textarea value={feedback} maxLength={4000} onChange={event => setFeedback(event.target.value)} /></label><Action disabled={!reason.trim() || !feedback.trim() || !rows.length || rows.some((row, index) => row.score === '' || !Number.isFinite(Number(row.score)) || Number(row.score) < 0 || Number(row.score) > question.rubric![index]!.maxScore || !row.evidence.trim())} onClick={() => revise('manual')}>保存人工核对</Action>
      </div></details>
    </fieldset>{active && <p role="status">正在复评，完成后自动更新。取消或失败时保留当前评价。</p>}</details>
  </div>;
}
