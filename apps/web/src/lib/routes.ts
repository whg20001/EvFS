type StaticPage = 'home' | 'recite' | 'drafts' | 'review' | 'knowledge' | 'history' | 'library' | 'ai-access' | 'local-data' | 'week' | 'weak' | 'admin';
export type LearningRoute = { page: StaticPage | 'not-found' }
  | { page: 'recitation' | 'session' | 'review-session' | 'knowledge-detail'; id: string }
  | { page: 'quiz'; id: string; result: boolean };

export function parseLearningRoute(pathname: string): LearningRoute {
  if (pathname === '/') return { page: 'home' };
  const missing = { page: 'not-found' } as const;
  if (!pathname.startsWith('/')) return missing;
  const parts = pathname.slice(1).replace(/\/$/, '').split('/');
  const [section, encodedId, suffix] = parts;
  if (parts.length === 1 && ['recite', 'drafts', 'review', 'knowledge', 'history', 'library', 'ai-access', 'local-data', 'week', 'weak', 'admin'].includes(section!)) return { page: section as StaticPage };
  if (!encodedId) return missing;
  let id: string;
  try { id = decodeURIComponent(encodedId); } catch { return missing; }
  // IDs are passed to API paths; encoded separators must never create another route.
  if (!id || /[/\\?#\u0000-\u0020\u007f%]/.test(id) || id === '.' || id === '..') return missing;
  if (section === 'recite' && parts.length === 2) return { page: 'recitation', id };
  if (section === 'sessions' && parts.length === 3 && suffix === 'ask') return { page: 'session', id };
  if (section === 'quizzes' && (parts.length === 2 || (parts.length === 3 && suffix === 'result'))) return { page: 'quiz', id, result: suffix === 'result' };
  if (parts.length === 2 && section === 'review-sessions') return { page: 'review-session', id };
  if (parts.length === 2 && section === 'knowledge') return { page: 'knowledge-detail', id };
  return missing;
}

export function navigationSection(pathname: string): StaticPage | undefined {
  const route = parseLearningRoute(pathname);
  switch (route.page) {
    case 'not-found': return undefined;
    case 'recitation': case 'session': case 'quiz': return 'recite';
    case 'review-session': return 'review';
    case 'knowledge-detail': return 'knowledge';
    default: return route.page;
  }
}
