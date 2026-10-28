'use client';

import { Feedback } from './feedback';
import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useApp, useData, today } from './store';
import { useEffect, useState } from 'react';
import type { LearningStatistics as Statistics } from '@sanxing/contracts';
import { Card, Empty, Go, Heading } from './ui';
import { LearningStatistics } from './learning-statistics';
import { streakDays, submittedDays } from './home';

export function WeeklyPage() {
  const data = useData();
  const submitted = submittedDays(data);
  const end = new Date(`${today(data.timezone)}T12:00:00Z`);
  const days = Array.from({ length: 112 }, (_, index) => { const date = new Date(end); date.setUTCDate(date.getUTCDate() - (111 - index)); const key = date.toISOString().slice(0, 10); return { key, count: data.sessions.filter(session => data.recitations.find(item => item.id === session.recitationId)?.learningDate === key).length }; });
  const week = days.slice(-7);
  const activeDays = week.filter(day => submitted.has(day.key)).length;
  const sessions = data.sessions.filter(session => week.some(day => data.recitations.find(item => item.id === session.recitationId)?.learningDate === day.key));
  return <><Heading eyebrow="本周复盘 · 一周一回望" title={activeDays ? `这一周，你在 ${activeDays} 天里找回所学。` : '慢慢积累，也是一种前进。'} description="把目光从今天移开一点，看看每一次理解如何留下痕迹。" />
    <div className="weekly-stats"><div><span className="text-stat">{streakDays(data)}</span><span>天连续复述</span></div><div><span className="text-stat">{sessions.length}</span><span>次学习提交</span></div><div><span className="text-stat">{data.knowledge.filter(point => !point.archivedAt).length}</span><span>个已记录知识点</span></div></div>
    <Card title="让日常留下痕迹" caption="近 16 周 · 每一格，都是一天的学习提交记录"><div className="learning-heatmap-scroll"><div className="learning-heatmap" role="img" aria-label={`近 16 周共 ${days.filter(day => day.count > 0).length} 天有复述提交，格子深浅表示当天学习提交次数。`}>{days.map(day => <span key={day.key} className={`heat-level-${Math.min(day.count, 4)} ${day.key === today(data.timezone) ? 'heat-today' : ''}`} title={`${day.key} · ${day.count} 次学习提交`} />)}</div></div><div className="heatmap-legend"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`heat-level-${level}`} />)}<span>多</span></div></Card>
    <div className="weekly-observation"><span className="text-label">从记录里看见</span><h2 className="text-title-2">{activeDays >= 3 ? '一次次讲出来，理解就有了形状。' : '先留下今天，再慢慢连成一周。'}</h2><p>{activeDays >= 3 ? `本周已经有 ${activeDays} 天提交复述。回看原始作答与失分项，选一个仍说不清的知识点，作为下一次复习的起点。` : '有了更多复述记录，这里就会慢慢长出你的学习节奏。现在，从今天的一个小小回忆开始。'}</p><small>依据：已保存的学习记录 · 按记录汇总</small></div>
    <LearningStatistics />
    <div className="next-step"><div><span>下一步</span><p>给还不够清楚的地方，多一次回忆。</p></div><Go primary href="/weak">看看薄弱知识点</Go></div>
  </>;
}

export function WeakPointsPage() {
  const { api } = useApp();
  const data = useData();
  const [statistics, setStatistics] = useState<Statistics | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void api<Statistics>('/learning/statistics?days=30', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setStatistics(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法读取失分记录。'); });
    return () => controller.abort();
  }, [api, data.revision, retry]);
  const ids = new Set(statistics?.losses.map(loss => loss.knowledgeId));
  const points = data.knowledge.filter(point => !point.archivedAt && ids.has(point.id));
  return <><Heading eyebrow="复习 · 薄弱知识点" title={points.length ? `这些地方，值得再讲一遍。` : '从证据里，找到下一步。'} description="根据近 30 天独立作答中实际记录的失分项，找出需要巩固的知识。" />
    {error ? <Feedback title="操作提示" tone="error">{error} <button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></Feedback> : !statistics ? <p role="status">正在整理作答记录…</p> : points.length ? <div className="editorial-list">{points.map((point, index) => <Link href={`/knowledge/${point.id}`} key={point.id}><span className="list-index">{String(index + 1).padStart(2, '0')}</span><div><h2>{point.title}</h2><p>{statistics.losses.filter(loss => loss.knowledgeId === point.id).map(loss => loss.description).join('；')}</p></div><span className="status-dot amber">待巩固</span><ChevronRight size={16} /></Link>)}</div> : <Empty title="暂时没有可汇总的薄弱项">完成独立测验后，有依据的失分项会出现在这里。也可以从复习计划开始，检查自己还记得多少。</Empty>}
    <div className="next-step"><div><span>下一步</span><p>一次只复习一个知识点，先回忆，再核对。</p></div><Link className="button primary" href="/review">前往复习计划<ArrowRight size={16} /></Link></div>
  </>;
}
