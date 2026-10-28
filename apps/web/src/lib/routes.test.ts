import { expect, test } from 'vitest';
import { navigationSection, parseLearningRoute } from './routes';

test.each([
  ['/', { page: 'home' }, 'home'],
  ['/week', { page: 'week' }, 'week'],
  ['/weak', { page: 'weak' }, 'weak'],
  ['/recite/', { page: 'recite' }, 'recite'],
  ['/recite/a', { page: 'recitation', id: 'a' }, 'recite'],
  ['/drafts', { page: 'drafts' }, 'drafts'],
  ['/review', { page: 'review' }, 'review'],
  ['/knowledge', { page: 'knowledge' }, 'knowledge'],
  ['/history', { page: 'history' }, 'history'],
  ['/library', { page: 'library' }, 'library'],
  ['/ai-access', { page: 'ai-access' }, 'ai-access'],
  ['/sessions/a/ask', { page: 'session', id: 'a' }, 'recite'],
  ['/quizzes/a', { page: 'quiz', id: 'a', result: false }, 'recite'],
  ['/quizzes/a/result', { page: 'quiz', id: 'a', result: true }, 'recite'],
  ['/review-sessions/a', { page: 'review-session', id: 'a' }, 'review'],
  ['/knowledge/%61', { page: 'knowledge-detail', id: 'a' }, 'knowledge'],
])('resolves the complete route %s and its navigation section', (path, route, section) => {
  expect(parseLearningRoute(path as string)).toEqual(route);
  expect(navigationSection(path as string)).toBe(section);
});

test.each(['/recite/a/extra', '/recite/%2f', '/recite/%252f', '/recite/..', '/drafts/a', '/sessions/a/ask/extra', '/sessions/a', '/quizzes/a/wrong', '/quizzes/a/result/extra', '/review/a', '/review-sessions/a/extra', '/knowledge/a/extra', '/history/a', '/library/a', '/ai-access/a', '/knowledge/%', '/knowledge/%2f', '/knowledge/%5c', '/knowledge/%3f', '/knowledge/%23', '/knowledge/%00', '/knowledge/%252f', '/knowledge/..', '/quizzes//result', '//recite', '/recite//', '/unknown', '/login'])('rejects unrecognized or unsafe route %s', path => {
  expect(parseLearningRoute(path)).toEqual({ page: 'not-found' });
  expect(navigationSection(path)).toBeUndefined();
});
