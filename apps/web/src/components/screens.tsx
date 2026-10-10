'use client';

import { useRef } from 'react';
import { usePathname } from 'next/navigation';
import { RecitePage } from './recite';
import { LibraryPage } from './library';
import { SessionPage } from './session';
import { QuizPage } from './quiz';
import { ReviewPage, ReviewSessionPage } from './review';
import { HistoryPage, KnowledgeDetail, KnowledgePage } from './knowledge';
import { Empty, Go } from './ui';
import { AiAccessPage } from '../features/ai-access/page';

export function RouteScreen() {
  const pathname = usePathname();
  const retainedPath = useRef('/recite');
  if (pathname !== '/login') retainedPath.current = pathname;
  // Authentication expiry overlays login without clearing the mounted editor.
  const path = pathname === '/login' ? retainedPath.current : pathname;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts[0] === 'recite') return <RecitePage />;
  if (parts[0] === 'sessions' && parts[1] && parts[2] === 'ask') return <SessionPage key={parts[1]} id={parts[1]} />;
  if (parts[0] === 'quizzes' && parts[1]) return <QuizPage key={parts[1]} id={parts[1]} result={parts[2] === 'result'} />;
  if (parts[0] === 'review') return <ReviewPage />;
  if (parts[0] === 'review-sessions' && parts[1]) return <ReviewSessionPage key={parts[1]} id={parts[1]} />;
  if (parts[0] === 'knowledge') return parts[1] ? <KnowledgeDetail key={parts[1]} id={parts[1]} /> : <KnowledgePage />;
  if (parts[0] === 'history') return <HistoryPage />;
  if (parts[0] === 'library') return <LibraryPage />;
  if (parts[0] === 'ai-access') return <AiAccessPage />;
  return <Empty title="这条小路，暂时还没有页面" action={<Go href="/recite">回到今日复述</Go>}>试试左侧的学习导航。</Empty>;
}
