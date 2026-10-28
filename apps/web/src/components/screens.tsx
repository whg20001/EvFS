'use client';

import { useRef } from 'react';
import { usePathname } from 'next/navigation';
import { parseLearningRoute } from '../lib/routes';
import { RecitePage } from './recite';
import { DraftsPage } from './drafts';
import { LibraryPage } from './library';
import { SessionPage } from './session';
import { QuizPage } from './quiz';
import { ReviewPage, ReviewSessionPage } from './review';
import { HistoryPage, KnowledgeDetail, KnowledgePage } from './knowledge';
import { Empty, Go } from './ui';
import { AiAccessPage } from '../features/ai-access/page';
import { WeeklyPage, WeakPointsPage } from './weekly';
import { LocalDataPage } from './local-data';
import { AdminPage } from '../features/admin/page';

export function RouteScreen() {
  const pathname = usePathname();
  const retainedPath = useRef('/recite');
  if (pathname !== '/login') retainedPath.current = pathname;
  // Authentication expiry overlays login without clearing the mounted editor.
  const path = pathname === '/login' ? retainedPath.current : pathname;
  const route = parseLearningRoute(path);
  switch (route.page) {
    case 'admin': return <AdminPage />;
    case 'home': return null;
    case 'week': return <WeeklyPage />;
    case 'weak': return <WeakPointsPage />;
    case 'recite': return <RecitePage />;
    case 'recitation': return <RecitePage key={route.id} id={route.id} />;
    case 'drafts': return <DraftsPage />;
    case 'session': return <SessionPage key={route.id} id={route.id} />;
    case 'quiz': return <QuizPage key={route.id} id={route.id} result={route.result} />;
    case 'review': return <ReviewPage />;
    case 'review-session': return <ReviewSessionPage key={route.id} id={route.id} />;
    case 'knowledge': return <KnowledgePage />;
    case 'knowledge-detail': return <KnowledgeDetail key={route.id} id={route.id} />;
    case 'history': return <HistoryPage />;
    case 'library': return <LibraryPage />;
    case 'ai-access': return <AiAccessPage />;
    case 'local-data': return <LocalDataPage />;
  }
  return <Empty title="这条小路，暂时还没有页面" action={<Go href="/">回到今日三省</Go>}>从「全部模块」找到要去的地方。</Empty>;
}
