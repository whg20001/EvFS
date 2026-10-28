'use client';
import { Feedback } from './feedback';
import { useEffect, useState } from 'react';
import type { LearningStatistics as Statistics } from '@sanxing/contracts';
import { useApp, useData, dateLabel } from './store';
import { Action, Card, Go } from './ui';
import { errorMessage } from '../lib/api-client';

const labels = { independent: '独立且已评价', assisted: '辅助且已评价', skipped: '跳过', pending: '评价中', verification: '待核对 / 有争议', manual: '人工自评' };
export function LearningStatistics() {
  const { api } = useApp(); const data = useData();
  const [visibleRecords, setVisibleRecords] = useState(50); const [visibleLosses, setVisibleLosses] = useState(20);
  const [days, setDays] = useState('30'); const [result, setResult] = useState<Statistics | null>(null);
  const [category, setCategory] = useState('all'); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setResult(null);
    void api<Statistics>(`/learning/statistics?days=${days}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause, '统计加载失败')); });
    return () => controller.abort();
  }, [api, data.revision, days, retry]);
  return <Card title="复习与作答统计" caption="仅统计已交卷的作答，采用当前评价；历史修订不重复计数。统计不代表掌握率。">
    <label className="field-label">统计时段<select value={days} onChange={event => setDays(event.target.value)}><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="0">全部记录</option></select></label>
    {error ? <Feedback title="操作提示" tone="error">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>重新加载统计</button></Feedback> : !result ? <p role="status">正在计算统计…</p> : <div className="stack compact">
      <p className="small muted">{result.fromDate ?? '最早记录'} 至 {result.throughDate} · {result.timezone} · {result.simulated ? '演示统计，不构成真实学习评价' : '真实作答记录'}</p>
      <div className="tag-list">{Object.entries(labels).map(([key, label]) => <span key={key} className="badge">{label}：{result.categories[key as keyof typeof labels]}</span>)}</div>
      <p className="small muted">分类互斥：跳过优先，其次待核对、评价中、人工自评、辅助作答，最后为独立已评价。人工自评和未解决争议不计入独立表现。</p>
      {(['immediate', 'delayed'] as const).map(kind => { const count = result.performance[kind]; return <p key={kind}><strong>{kind === 'immediate' ? '即时考核' : '延迟回忆'}</strong>：{count.count ? `${count.count} 次独立作答，满分 ${count.fullScore} 次，累计得分 ${count.score} / ${count.maxScore}` : '尚无独立已评价作答'}</p>; })}
      <p>完成复习 {result.reviews.completed} 次 · 产生排期事件 {result.reviews.scheduled} 次 · 放弃 {result.reviews.abandoned} 次</p>
      <details><summary>常见失分项（{result.losses.length} 项）</summary><p className="small muted">只汇总独立作答中已保存的分项依据；相同知识点、相同评分描述合并。旧记录缺少分项时不推测原因。</p>{result.losses.length ? result.losses.slice(0, visibleLosses).map((loss, index) => <div key={index} className="evidence-item"><strong>{loss.title}</strong><p>{loss.description} · {loss.count} 次 · 累计失分 {loss.lostScore}</p><div className="row wrap">{loss.evidenceIds.slice(0, 20).map(id => { const record = result.records.find(item => item.evidenceId === id)!; return <Go key={id} href={`/quizzes/${record.quizId}/result#question-${record.questionId}`}>查看作答依据</Go>; })}</div>{loss.evidenceIds.length > 20 && <p className="small muted">先显示 20 条依据，其余可在原始作答列表查看。</p>}</div>) : <p className="muted">暂无可统计的失分项。</p>}{result.losses.length > visibleLosses && <Action onClick={() => setVisibleLosses(value => value + 20)}>显示更多失分项</Action>}</details>
      <details><summary>核对统计中的原始作答（{result.total} 条）</summary><label className="field-label">作答分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部作答</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{result.records.filter(record => category === 'all' || record.category === category).slice(0, visibleRecords).map(record => <div key={record.evidenceId} className="list-row"><div className="grow"><strong>{record.title}</strong><p className="small muted">{labels[record.category]} · {record.dimension === 'delayed' ? '延迟回忆' : '即时考核'} · {dateLabel(record.submittedAt, data.timezone)} · 评价 v{record.assessmentVersion}</p></div><Go href={`/quizzes/${record.quizId}/result#question-${record.questionId}`}>查看作答</Go></div>)}{result.records.filter(record => category === 'all' || record.category === category).length > visibleRecords && <Action onClick={() => setVisibleRecords(value => value + 50)}>显示更多统计作答</Action>}</details>
      <details><summary>未来 7 天复习负担</summary><p className="small muted">使用当前到期时间，按 {result.timezone} 的自然日分组，今天包含尚未到点的卡片；暂停与已归档卡片单列。实际到期数以复习队列为准。</p><ul><li>今天之前已到期：{result.due.overdue}</li>{result.due.days.map(day => <li key={day.date}>{day.date}：{day.count}</li>)}<li>更晚：{result.due.later}</li><li>已暂停：{result.due.paused} · 知识已归档：{result.due.archived}</li></ul></details>
    </div>}
  </Card>;
}
