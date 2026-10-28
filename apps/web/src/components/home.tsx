'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { currentKnowledgeId, type PublicState } from '@sanxing/contracts';
import { useData, today } from './store';
import { almanac } from '../lib/almanac';
import { recitationDrafts } from '../lib/recitation-drafts';

const paintings = [
  { file: 'quezhu.jpg', title: '梅竹双雀', alt: '宋人《梅竹双雀》团扇：梅花与竹枝间栖着三只麻雀' },
  { file: 'pipa.jpg', title: '枇杷八哥', alt: '宋人《枇杷八哥》团扇：一只八哥立在结满枇杷的枝头' },
  { file: 'lizhi.jpg', title: '紫荔山禽', alt: '宋人《紫荔山禽》团扇：小鸟倒挂在荔枝枝头' },
];

export function dueCards(data: PublicState) {
  return data.cards.filter(card => !card.retiredAt && !card.pausedAt && !data.knowledge.find(point => point.id === currentKnowledgeId(card))?.archivedAt && new Date(card.schedule.due).getTime() <= Date.now())
    .sort((a, b) => a.schedule.due.localeCompare(b.schedule.due));
}
export function submittedDays(data: PublicState) {
  return new Set(data.sessions.map(session => data.recitations.find(item => item.id === session.recitationId)?.learningDate).filter((day): day is string => Boolean(day)));
}
export function streakDays(data: PublicState) {
  const days = submittedDays(data);
  const date = new Date(`${today(data.timezone)}T12:00:00Z`);
  let count = 0;
  if (!days.has(date.toISOString().slice(0, 10))) date.setUTCDate(date.getUTCDate() - 1);
  while (days.has(date.toISOString().slice(0, 10))) { count++; date.setUTCDate(date.getUTCDate() - 1); }
  return count;
}

export function HomePage({ input }: { input: ReactNode }) {
  const data = useData();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setNow(new Date()); }, 30_000); return () => clearInterval(timer); }, []);
  const calendar = almanac(now, data.timezone);
  const painting = paintings[calendar.dayOfYear % paintings.length]!;
  const due = dueCards(data);
  const streak = streakDays(data);
  const learnedDays = submittedDays(data).size;
  const drafts = recitationDrafts(data).filter(draft => draft.learningDate < today(data.timezone));
  return <div className="daily-issue">
    <h1 className="sr-only">今日三省</h1>
    <figure className="home-artwork">
      <div className="roundel-row">
        <p className="home-vertical text-vertical vertical" aria-hidden="true">{calendar.lunar}</p>
        <div className="home-roundel"><img src={`/design/${painting.file}`} alt={painting.alt} width="1600" height="1600" fetchPriority="high" /></div>
        <p className="home-vertical text-vertical vertical" aria-hidden="true" title={calendar.time}>{calendar.compactTime}</p>
      </div>
      <figcaption className="home-art-credit text-credit">{painting.title} · 宋 · 佚名 · 团扇 · 绢本设色</figcaption>
    </figure>
    <div className="issue-introduction">
      <p className="text-lede">
        {calendar.greeting}。今天是{calendar.weekday}，农历{calendar.lunar.replace(/^.*年/, '')}。
        {!learnedDays ? <>今天是你的第一天，说说今天学了什么。</> : streak > 0 ? <>
          你已经连续复述 <Link className="intro-stat" href="/week" aria-label={`已连续复述 ${streak} 天，查看本周复盘`}><span className="number">{streak}</span></Link> 天{due.length ? '；' : '。'}
        </> : <>留一点时间，找回今天的所学。</>}
        {due.length > 0 && <>还有 <Link className="intro-stat" href="/review" aria-label={`${due.length} 个知识点等待复习，查看复习计划`}><span className="number">{due.length}</span></Link> 个知识点等着复习。</>}
      </p>
      <p className="issue-dateline">{calendar.date} · {calendar.lunar} · {calendar.time}</p>
      {drafts.length > 0 && <p className="home-drafts">还有 {drafts.length} 份复述草稿未提交。<Link href="/drafts">继续编辑<span aria-hidden="true"> ↗</span></Link></p>}
    </div>
    {input}
  </div>;
}
